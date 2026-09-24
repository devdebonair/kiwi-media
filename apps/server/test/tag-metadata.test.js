import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'kiwi-tag-metadata-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db, rebuildSearch } = await import('@kiwi/database');
const { importLegacyTagLinks } = await import('../src/tag-metadata.js');
const { ProviderError } = await import('../src/tag-providers.js');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
let revision = 1, fail = false;
const gets = [];
const providerId = '12345678-1234-1234-1234-123456789abc';
app.tagProviders = {
  list: () => [{ id: 'wikidata', name: 'Wikidata', enabled: true }],
  search: async () => ({ results: [{ id: 'Q2263', name: 'Tom Hanks' }] }),
  get: async (provider, id) => {
    gets.push({ provider, id });
    if (fail) throw new ProviderError('Provider unavailable');
    return { provider, id, entityType: provider === 'wikidata' ? 'item' : 'person', name: `Tom Hanks ${revision}`, summary: `${provider} summary ${revision}`, aliases: [`Thomas Hanks ${revision}`], avatar_url: `https://example.com/${revision}.jpg`, topic_type: 'person', url: `https://example.com/${id}`, attribution: [{ label: 'Source attribution', url: 'https://example.com/attribution' }], fetchedAt: `2026-09-23T00:00:0${revision}Z` };
  },
};
const assetId = db.prepare('SELECT id FROM assets LIMIT 1').get().id;
const created = (await app.inject({ method: 'POST', url: `/api/v1/assets/${assetId}/topics`, payload: { name: 'Tom Hanks' } })).json().topics.find(t => t.name === 'Tom Hanks');
const base = `/api/v1/topics/${created.id}`;
const call = (method, suffix, payload) => app.inject({ method, url: base + suffix, payload });
const read = async () => (await call('GET', '/metadata')).json();
async function link(provider = 'wikidata', id = 'Q2263', fields = ['summary', 'avatar_url', 'topic_type', 'aliases'], preferred = true) {
  const preview = (await call('GET', `/metadata/preview?provider=${provider}&entityId=${id}`)).json();
  return call('PUT', `/metadata/links/${provider}`, { token: preview.token, fields, preferred });
}

test('preview is read-only; linking imports selected fields and preserves media associations', async () => {
  const before = db.prepare('SELECT * FROM annotation_topics').all();
  const preview = (await call('GET', '/metadata/preview?provider=wikidata&entityId=Q2263')).json();
  assert.equal((await read()).links.length, 0);
  assert.equal((await read()).topic.name, 'Tom Hanks');
  assert.equal((await call('PUT', '/metadata/links/wikidata', { token: preview.token, fields: ['summary', 'aliases', 'avatar_url'], preferred: true })).statusCode, 200);
  const value = await read();
  assert.equal(value.links[0].externalId, 'Q2263');
  assert.equal(value.topic.name, 'Tom Hanks');
  assert.equal(value.topic.summary, 'wikidata summary 1');
  assert.deepEqual(value.topic.aliases, ['Thomas Hanks 1']);
  assert.deepEqual(db.prepare('SELECT * FROM annotation_topics').all(), before);
  assert.equal((await call('PUT', '/metadata/links/wikidata', { token: preview.token, fields: [], preferred: true })).statusCode, 409);
  assert.ok((await app.inject('/api/v1/search?q=Thomas')).json().some(row => row.id === created.id));
  rebuildSearch();
  assert.ok((await app.inject('/api/v1/search?q=Thomas')).json().some(row => row.id === created.id));
});

test('refresh uses the saved ID and protects manual edits, including empty aliases', async () => {
  assert.equal((await call('PATCH', '', { name: 'My Tom tag', summary: 'My description', aliases: [] })).statusCode, 200);
  revision = 2;
  const result = await call('POST', '/metadata/links/wikidata/refresh');
  assert.equal(result.statusCode, 200);
  const value = result.json();
  assert.deepEqual(gets.at(-1), { provider: 'wikidata', id: 'Q2263' });
  assert.equal(value.topic.summary, 'My description');
  assert.equal(value.topic.name, 'My Tom tag');
  assert.deepEqual(value.topic.aliases, []);
  assert.equal(value.topic.avatar_url, 'https://example.com/2.jpg');
  assert.ok((await app.inject('/api/v1/search?q=My%20Tom')).json().some(row => row.id === assetId));
});

test('multiple providers, preferred source, explicit replacement, and unlink retain local values', async () => {
  assert.equal((await link('stashdb', providerId, [], false)).statusCode, 200);
  let value = await read();
  assert.equal(value.links.length, 2); assert.equal(value.preferred, 'wikidata');
  await call('POST', '/metadata/links/stashdb/prefer');
  assert.equal((await read()).topic.summary, 'My description');
  assert.equal((await link('stashdb', providerId, ['summary'], true)).statusCode, 200);
  value = await read();
  assert.equal(value.topic.summary, 'stashdb summary 2');
  assert.ok(!value.overrides.includes('summary'));
  revision = 3;
  await call('POST', '/metadata/links/wikidata/refresh');
  assert.equal((await read()).topic.summary, 'stashdb summary 2');
  assert.equal((await call('DELETE', '/metadata/links/stashdb')).statusCode, 200);
  value = await read();
  assert.equal(value.links.length, 1); assert.equal(value.topic.summary, 'stashdb summary 2');
  assert.equal(value.managed.summary, undefined);
  assert.ok(JSON.parse(value.topic.metadata_json).tagEnrichment.attribution.summary.length);
  await call('POST', '/metadata/links/wikidata/refresh');
  assert.equal((await read()).topic.summary, 'stashdb summary 2');
});

test('failed provider calls and invalid edits leave stored metadata untouched', async () => {
  const before = await read();
  fail = true;
  assert.equal((await call('POST', '/metadata/links/wikidata/refresh')).statusCode, 502);
  fail = false;
  assert.deepEqual(await read(), before);
  for (const payload of [{}, {name: ''}, {avatar_url: 'javascript:alert(1)'}, {aliases: ['']}, {unknown: true}]) assert.equal((await call('PATCH', '', payload)).statusCode, 400);
  assert.deepEqual(await read(), before);
  assert.equal((await call('PUT', '/metadata/links/wikidata', { token: 'invented', fields: ['summary'], preferred: true })).statusCode, 409);
  assert.equal((await app.inject('/api/v1/topics/missing/metadata')).statusCode, 404);
});

test('legacy imports are idempotent and unlink survives reimport', async () => {
  const id = 'legacy-test';
  db.prepare('INSERT INTO topics(id,slug,name,summary,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?)').run(id, id, 'Legacy', 'Legacy summary', 'now', 'now', JSON.stringify({ profile: { sources: [{ provider: 'stashdb', id: providerId, url: 'https://stashdb.org/performers/' + providerId }], managed: { summary: 'Legacy summary' } } }));
  importLegacyTagLinks(); importLegacyTagLinks();
  assert.equal(db.prepare('SELECT count(*) n FROM topic_provider_links WHERE topic_id=?').get(id).n, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/topics/${id}/metadata/links/stashdb` })).statusCode, 200);
  importLegacyTagLinks();
  assert.equal(db.prepare('SELECT count(*) n FROM topic_provider_links WHERE topic_id=?').get(id).n, 0);
});

test('replacing a match removes old field ownership, and unchecked fields stay untouched', async () => {
  const response = await link('wikidata', 'Q123', ['avatar_url'], true);
  assert.equal(response.statusCode, 200);
  let value = response.json();
  assert.equal(value.links[0].externalId, 'Q123');
  assert.equal(value.topic.summary, 'stashdb summary 2');
  assert.deepEqual(value.importFields.wikidata, ['avatar_url']);
  revision = 4;
  value = (await call('POST', '/metadata/links/wikidata/refresh', {})).json();
  assert.deepEqual(gets.at(-1), { provider: 'wikidata', id: 'Q123' });
  assert.equal(value.topic.avatar_url, 'https://example.com/4.jpg');
  assert.equal(value.topic.summary, 'stashdb summary 2');
});

test('a refresh in flight cannot restore an unlinked identity', async () => {
  const originalGet = app.tagProviders.get;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  app.tagProviders.get = async (...args) => {
    started(); await new Promise(resolve => { release = resolve; });
    return originalGet(...args);
  };
  try {
    const refresh = call('POST', '/metadata/links/wikidata/refresh', {});
    // app.inject starts when its thenable is consumed.
    const pending = Promise.resolve(refresh);
    await ready;
    assert.equal((await call('DELETE', '/metadata/links/wikidata', {})).statusCode, 200);
    release();
    assert.equal((await pending).statusCode, 404);
    assert.equal((await read()).links.length, 0);
  } finally { app.tagProviders.get = originalGet; }
});
