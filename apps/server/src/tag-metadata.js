import { randomUUID } from 'node:crypto';
import { db, reindexTopicSearch, reindexAssetSearch } from '@kiwi/database';
import { createTagProviders, entityId, ProviderError, safeURL } from './tag-providers.js';

const fields = ['name', 'summary', 'avatar_url', 'topic_type', 'aliases'];
const timestamp = () => new Date().toISOString();
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const aliases = id => db.prepare('SELECT alias FROM topic_aliases WHERE topic_id=? ORDER BY normalized_alias').all(id).map(row => row.alias);
const normalized = value => value.normalize('NFKC').trim().toLowerCase();
const cleanAliases = values => [...new Map(values.map(value => [normalized(value), value.trim()])).values()].sort((a, b) => normalized(a).localeCompare(normalized(b)));
const equal = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
const empty = value => value == null || value === '' || (Array.isArray(value) && !value.length);
function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function topic(id) {
  const row = db.prepare('SELECT * FROM topics WHERE id=?').get(id);
  if (!row) throw new ProviderError('Tag not found.', 404);
  return row;
}
function state(row) {
  const metadata = parse(row.metadata_json);
  const enrichment = metadata.tagEnrichment ||= { managed: {}, overrides: [], preferred: null };
  enrichment.managed ||= {}; enrichment.overrides ||= [];
  enrichment.importFields ||= {}; enrichment.attribution ||= {};
  return { metadata, enrichment };
}
function links(id) {
  return db.prepare('SELECT * FROM topic_provider_links WHERE topic_id=? ORDER BY provider').all(id).map(row => ({ provider: row.provider, externalId: row.external_id, entityType: row.entity_type, url: row.source_url, fetchedAt: row.fetched_at, entity: parse(row.snapshot_json) }));
}
export function tagMetadata(id) {
  const row = topic(id), { enrichment } = state(row);
  return { topic: { ...row, aliases: aliases(id) }, links: links(id), preferred: enrichment.preferred, managed: enrichment.managed, overrides: enrichment.overrides, importFields: enrichment.importFields };
}
function write(row, metadata, values = {}) {
  const next = { ...row, ...values };
  if (values.aliases) {
    db.prepare('DELETE FROM topic_aliases WHERE topic_id=?').run(row.id);
    const insert = db.prepare('INSERT INTO topic_aliases(id,topic_id,alias,normalized_alias) VALUES(?,?,?,?)');
    for (const alias of cleanAliases(values.aliases)) insert.run(randomUUID(), row.id, alias, normalized(alias));
  }
  db.prepare('UPDATE topics SET name=?,summary=?,avatar_url=?,topic_type=?,updated_at=?,metadata_json=? WHERE id=?').run(next.name, next.summary, next.avatar_url, next.topic_type, timestamp(), JSON.stringify(metadata), row.id);
  reindexTopicSearch(row.id);
  if (next.name !== row.name) for (const asset of db.prepare('SELECT DISTINCT asset_id FROM effective_asset_topics WHERE topic_id=?').all(row.id)) reindexAssetSearch(asset.asset_id);
}
function applyEntity(row, metadata, entity, selected, automatic = false) {
  const enrichment = metadata.tagEnrichment, values = {}, current = { ...row, aliases: aliases(row.id) };
  for (const field of selected) {
    let value = entity[field];
    if (field === 'aliases' && Array.isArray(value)) value = cleanAliases(value);
    if (empty(value)) continue; // Missing upstream data must not erase saved values.
    if (automatic) {
      if (enrichment.overrides.includes(field)) continue;
      const managed = enrichment.managed[field];
      if (!empty(current[field]) && (!managed || !equal(current[field], managed.value))) continue;
    }
    values[field] = value;
    enrichment.managed[field] = { provider: entity.provider, value };
    enrichment.attribution[field] = entity.attribution || [];
    enrichment.overrides = enrichment.overrides.filter(x => x !== field);
    // The older batch importer must also preserve edits made through this editor.
    if (metadata.profile?.managed) delete metadata.profile.managed[field];
  }
  write(row, metadata, values);
}
function saveLink(id, entity) {
  db.prepare(`INSERT INTO topic_provider_links(topic_id,provider,external_id,entity_type,source_url,snapshot_json,fetched_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(topic_id,provider) DO UPDATE SET external_id=excluded.external_id,entity_type=excluded.entity_type,source_url=excluded.source_url,snapshot_json=excluded.snapshot_json,fetched_at=excluded.fetched_at`).run(id, entity.provider, entity.id, entity.entityType, entity.url, JSON.stringify(entity), entity.fetchedAt);
}
// Import previous batch identities once. The marker prevents an unlinked identity
// from reappearing after restart. No remote requests or media changes are made.
export function importLegacyTagLinks() {
  transaction(() => {
    for (const row of db.prepare("SELECT * FROM topics WHERE json_valid(metadata_json) AND json_type(metadata_json,'$.profile.sources')='array'").all()) {
      const { metadata, enrichment } = state(row);
      if (enrichment.legacyImported) continue;
      for (const source of metadata.profile.sources) {
        if (!['stashdb', 'tpdb', 'wikidata'].includes(source.provider)) continue;
        let id; try { id = entityId(source.provider, source.id); } catch { continue; }
        if (links(row.id).some(link => link.provider === source.provider)) continue;
        const url = safeURL(source.url) || (source.provider === 'wikidata' ? `https://www.wikidata.org/wiki/${id}` : `https://${source.provider === 'stashdb' ? 'stashdb.org' : 'theporndb.net'}/performers/${id}`);
        const entity = { provider: source.provider, id, entityType: source.provider === 'wikidata' ? 'item' : 'person', name: source.name || row.name, url, fetchedAt: source.retrievedAt || null, aliases: aliases(row.id), summary: row.summary || '', avatar_url: row.avatar_url || '', topic_type: row.topic_type || 'person', attribution: [] };
        saveLink(row.id, entity);
        enrichment.importFields[source.provider] = ['summary', 'avatar_url', 'topic_type', 'aliases'];
        enrichment.preferred ||= source.provider;
      }
      for (const [field, value] of Object.entries(metadata.profile.managed || {})) if (fields.includes(field) && enrichment.preferred) enrichment.managed[field] = { provider: enrichment.preferred, value };
      enrichment.legacyImported = true;
      write(row, metadata);
    }
  });
}

export function registerTagMetadata(app, { providers = createTagProviders() } = {}) {
  app.decorate('tagProviders', providers);
  importLegacyTagLinks();
  const previews = new Map();
  const wrap = handler => async (req, reply) => {
    try { return await handler(req, reply); } catch (error) {
      if (error instanceof ProviderError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  };
  const params = req => { topic(req.params.id); return req.params.id; };
  const linkFor = req => {
    const id = params(req), link = links(id).find(x => x.provider === req.params.provider);
    if (!link) throw new ProviderError('Provider link not found.', 404);
    return link;
  };
  app.get('/api/v1/metadata/providers', async () => app.tagProviders.list());
  app.get('/api/v1/metadata/providers/:provider/search', wrap(req => app.tagProviders.search(req.params.provider, req.query.q)));
  app.get('/api/v1/topics/:id/metadata', wrap(req => tagMetadata(params(req))));
  app.get('/api/v1/topics/:id/metadata/preview', wrap(async req => {
    const id = params(req), entity = await app.tagProviders.get(req.query.provider, req.query.entityId);
    for (const [key, entry] of previews) if (entry.expires < Date.now()) previews.delete(key);
    while (previews.size >= 200) previews.delete(previews.keys().next().value);
    const token = randomUUID();
    previews.set(token, { id, entity, expires: Date.now() + 10 * 60 * 1000 });
    return { entity, token };
  }));
  app.patch('/api/v1/topics/:id', wrap(req => transaction(() => {
    const row = topic(req.params.id), body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !fields.includes(key))) throw new ProviderError('Supply valid tag fields.', 400);
    const values = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'aliases') {
        if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw new ProviderError('Use up to 100 aliases, each 1–200 characters.', 400);
        values.aliases = cleanAliases(value); continue;
      }
      if (typeof value !== 'string' || value.length > ({ name: 100, summary: 5000, avatar_url: 2000, topic_type: 50 })[key] || (key === 'name' && !value.trim())) throw new ProviderError(`Invalid ${key}.`, 400);
      if (key === 'avatar_url' && value && !safeURL(value) && !/^\/(?:assets|generated)\/[^\s?#]*$/.test(value)) throw new ProviderError('Use an HTTP(S) image URL or a local library image.', 400);
      values[key] = value.trim();
    }
    const { metadata, enrichment } = state(row);
    for (const key of Object.keys(values)) {
      enrichment.overrides = [...new Set([...enrichment.overrides, key])];
      delete enrichment.managed[key];
      delete enrichment.attribution[key];
      if (metadata.profile?.managed) delete metadata.profile.managed[key];
    }
    write(row, metadata, values);
    return tagMetadata(row.id);
  })));
  app.put('/api/v1/topics/:id/metadata/links/:provider', wrap(req => transaction(() => {
    const row = topic(req.params.id), body = req.body || {}, preview = previews.get(body.token);
    if (!preview || preview.expires < Date.now() || preview.id !== row.id || preview.entity.provider !== req.params.provider) throw new ProviderError('Preview expired. Select the match again.', 409);
    if (!Array.isArray(body.fields) || body.fields.some(field => !fields.includes(field)) || typeof body.preferred !== 'boolean') throw new ProviderError('Choose valid import fields and a preferred source.', 400);
    const { metadata, enrichment } = state(row), entity = preview.entity;
    // A new identity must not retain field ownership from the previous identity.
    const old = links(row.id).find(link => link.provider === entity.provider);
    if (old && old.externalId !== entity.id) {
      for (const [field, owner] of Object.entries(enrichment.managed)) if (owner.provider === entity.provider) delete enrichment.managed[field];
      if (metadata.profile) {
        metadata.profile.sources = (metadata.profile.sources || []).filter(source => source.provider !== entity.provider);
        metadata.profile.links = (metadata.profile.links || []).filter(source => source.source !== entity.provider);
      }
    }
    saveLink(row.id, entity);
    enrichment.importFields[entity.provider] = [...new Set(body.fields)];
    for (const [field, owner] of Object.entries(enrichment.managed)) if (owner.provider === entity.provider && !body.fields.includes(field)) delete enrichment.managed[field];
    if (body.preferred || !enrichment.preferred) enrichment.preferred = entity.provider;
    applyEntity(row, metadata, entity, body.fields);
    previews.delete(body.token);
    return tagMetadata(row.id);
  })));
  app.post('/api/v1/topics/:id/metadata/links/:provider/refresh', wrap(async req => {
    const before = linkFor(req);
    const entity = await app.tagProviders.get(before.provider, before.externalId);
    return transaction(() => {
      const current = linkFor(req);
      if (current.externalId !== before.externalId || current.fetchedAt !== before.fetchedAt) throw new ProviderError('The link changed while refreshing. Please try again.', 409);
      const row = topic(req.params.id), { metadata, enrichment } = state(row);
      // On a partial Wikipedia failure keep the last complete summary for refresh.
      if (entity.warnings?.length && current.entity.summary) {
        entity.summary = current.entity.summary;
        entity.attribution = [...new Map([...(current.entity.attribution || []), ...(entity.attribution || [])].map(source => [source.url, source])).values()];
        entity.links = [...new Map([...(current.entity.links || []), ...(entity.links || [])].map(source => [source.url, source])).values()];
      }
      saveLink(row.id, entity);
      const selected = (enrichment.importFields[entity.provider] || []).filter(field => enrichment.managed[field]?.provider === entity.provider || enrichment.preferred === entity.provider);
      applyEntity(row, metadata, entity, selected, true);
      return tagMetadata(row.id);
    });
  }));
  app.post('/api/v1/topics/:id/metadata/links/:provider/prefer', wrap(req => transaction(() => {
    const link = linkFor(req), row = topic(req.params.id), { metadata, enrichment } = state(row);
    enrichment.preferred = link.provider;
    applyEntity(row, metadata, link.entity, (enrichment.importFields[link.provider] || []).filter(field => field !== 'name'), true);
    return tagMetadata(row.id);
  })));
  app.delete('/api/v1/topics/:id/metadata/links/:provider', wrap(req => transaction(() => {
    const link = linkFor(req), row = topic(req.params.id), { metadata, enrichment } = state(row);
    db.prepare('DELETE FROM topic_provider_links WHERE topic_id=? AND provider=?').run(row.id, link.provider);
    delete enrichment.importFields[link.provider];
    for (const [field, owner] of Object.entries(enrichment.managed)) if (owner.provider === link.provider) delete enrichment.managed[field];
    if (enrichment.preferred === link.provider) enrichment.preferred = links(row.id)[0]?.provider || null;
    // Keep imported values; unlink only stops updates and removes source links.
    if (metadata.profile) {
      metadata.profile.sources = (metadata.profile.sources || []).filter(source => source.provider !== link.provider);
      metadata.profile.links = (metadata.profile.links || []).filter(source => source.source !== link.provider);
    }
    write(row, metadata);
    return tagMetadata(row.id);
  })));
}
