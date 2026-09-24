// Provider adapters only identify tag entities. They never inspect or associate media.
const names = { wikidata: 'Wikidata', stashdb: 'StashDB', tpdb: 'ThePornDB' };
export const providerNames = names;
export class ProviderError extends Error {
  constructor(message, statusCode = 502) { super(message); this.statusCode = statusCode; }
}
export function safeURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
const performerFields = 'id name aliases disambiguation deleted career_start_year career_end_year urls { url } images { url }';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function entityId(provider, input) {
  if (typeof input !== 'string' || input.length > 500) throw new ProviderError('Enter a valid provider ID or profile URL.', 400);
  let id = input.trim();
  if (/^https?:/i.test(id)) {
    let url;
    try { url = new URL(id); } catch { throw new ProviderError('Enter a valid provider profile URL.', 400); }
    const host = provider === 'wikidata' ? 'www.wikidata.org' : provider === 'stashdb' ? 'stashdb.org' : 'theporndb.net';
    const path = provider === 'wikidata' ? /^\/wiki\/(Q[1-9]\d*)\/?$/i : /^\/performers\/([^/]+)\/?$/;
    if (url.hostname.replace(/^www\./, '') !== host.replace(/^www\./, '') || url.username || url.password || url.port || !path.test(url.pathname)) throw new ProviderError('Use a profile URL from the selected provider.', 400);
    id = url.pathname.match(path)[1];
  }
  if (!(provider === 'wikidata' ? /^Q[1-9]\d*$/i : uuid).test(id)) throw new ProviderError('Invalid provider entity ID.', 400);
  return provider === 'wikidata' ? id.toUpperCase() : id.toLowerCase();
}

export function createTagProviders({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  const definitions = {
    stashdb: { endpoint: env.STASH_BOX_ENDPOINT, key: env.STASH_BOX_API_KEY },
    tpdb: { endpoint: env.TPDB_ENDPOINT || 'https://theporndb.net/graphql', key: env.TPDB_API_KEY },
  };
  const enabled = provider => provider === 'wikidata' || Boolean(definitions[provider]?.key?.trim() && safeURL(definitions[provider]?.endpoint));
  function check(provider) {
    if (!Object.hasOwn(names, provider)) throw new ProviderError('Unknown metadata provider.', 400);
    if (!enabled(provider)) throw new ProviderError(`${names[provider]} is not configured on the server.`, 400);
  }
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'KiwiTagEnrichment/1.0 (personal media catalog)', ...options.headers } });
    } catch { throw new ProviderError('Metadata provider could not be reached. Please try again.'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(response.status === 429 ? 'Provider rate limit reached. Please try again later.' : [401, 403].includes(response.status) ? 'Provider denied access. Check the server API credentials.' : 'Metadata provider request failed.');
    }
    let data;
    try { data = await response.json(); } catch { throw new ProviderError('Metadata provider returned an invalid response.'); }
    if (!data || data.error || data.errors?.length) throw new ProviderError('Metadata provider returned an error.');
    return data;
  }
  const wiki = (host, params) => request(`https://${host}/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`);
  async function graph(provider, query, variables) {
    const settings = definitions[provider];
    const result = await request(settings.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ApiKey: settings.key }, body: JSON.stringify({ query, variables }) });
    if (!result.data) throw new ProviderError('Metadata provider returned an incomplete response.');
    return result.data;
  }
  function performer(provider, row) {
    if (!row || row.deleted) throw new ProviderError('This provider identity is unavailable or was deleted.', 404);
    if (!uuid.test(row.id) || typeof row.name !== 'string') throw new ProviderError('Metadata provider returned an invalid identity.');
    const url = `https://${provider === 'stashdb' ? 'stashdb.org' : 'theporndb.net'}/performers/${row.id}`;
    return { provider, id: row.id, entityType: 'person', name: row.name, description: row.disambiguation || '', summary: row.disambiguation || '',
      aliases: (row.aliases || []).filter(x => typeof x === 'string'), avatar_url: (row.images || []).map(x => safeURL(x.url)).find(Boolean) || '', topic_type: 'person', url,
      links: (row.urls || []).map(x => safeURL(x.url)).filter(Boolean).map(url => ({ url, label: new URL(url).hostname.replace(/^www\./, '') })),
      facts: { careerStart: row.career_start_year, careerEnd: row.career_end_year }, attribution: [{ label: names[provider], url }], fetchedAt: new Date().toISOString() };
  }
  async function get(provider, input) {
    check(provider);
    const id = entityId(provider, input);
    if (provider !== 'wikidata') return performer(provider, (await graph(provider, `query($id:ID!){findPerformer(id:$id){${performerFields}}}`, { id })).findPerformer);
    const data = await wiki('www.wikidata.org', { action: 'wbgetentities', ids: id, props: 'labels|descriptions|aliases|claims|sitelinks', languages: 'en', sitefilter: 'enwiki', redirects: 'yes' });
    const item = data.entities?.[id] || Object.values(data.entities || {})[0];
    if (!item || 'missing' in item) throw new ProviderError('This Wikidata identity is unavailable.', 404);
    if (!/^Q[1-9]\d*$/.test(item.id) || !item.labels?.en?.value) throw new ProviderError('No English label is available for this identity.', 404);
    const values = property => (item.claims?.[property] || []).filter(c => c.rank !== 'deprecated').map(c => c.mainsnak?.datavalue?.value).filter(v => v != null);
    const file = values('P18').find(v => typeof v === 'string');
    const url = `https://www.wikidata.org/wiki/${item.id}`;
    const result = { provider, id: item.id, entityType: 'item', name: item.labels.en.value, description: item.descriptions?.en?.value || '', summary: item.descriptions?.en?.value || '',
      aliases: (item.aliases?.en || []).map(x => x.value), topic_type: values('P31').some(v => v.id === 'Q5') ? 'person' : 'topic',
      avatar_url: file ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=480` : '', url,
      facts: { birthDate: values('P569')[0]?.time, deathDate: values('P570')[0]?.time },
      links: values('P856').map(value => ({ label: 'Official website', url: safeURL(value) })).filter(x => x.url),
      attribution: [{ label: 'Wikidata (CC0)', url }], fetchedAt: new Date().toISOString(), warnings: [] };
    if (file) result.attribution.push({ label: 'Image source and license', url: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}` });
    const title = item.sitelinks?.enwiki?.title;
    if (title) {
      try {
        const article = await wiki('en.wikipedia.org', { action: 'query', titles: title, redirects: '1', prop: 'extracts|pageprops|info', exintro: '1', explaintext: '1', inprop: 'url' });
        const page = Object.values(article.query?.pages || {}).find(p => p.pageprops?.wikibase_item === item.id && !('disambiguation' in p.pageprops) && !('missing' in p));
        if (page?.extract && safeURL(page.fullurl)) {
          result.summary = page.extract.split(/\n+/)[0].slice(0, 2000);
          result.links.push({ label: 'Wikipedia', url: page.fullurl });
          result.attribution.push({ label: 'Wikipedia summary (CC BY-SA; see article history)', url: page.fullurl });
        }
      } catch { result.warnings.push('Wikipedia is unavailable; Wikidata details are still available.'); }
    }
    return result;
  }
  async function search(provider, query) {
    check(provider);
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new ProviderError('Enter a search term of 1–300 characters.', 400);
    query = query.trim();
    if (/^https?:/i.test(query) || (provider === 'wikidata' ? /^Q\d+$/i : uuid).test(query)) return { results: [await get(provider, query)], hasMore: false };
    if (provider !== 'wikidata') {
      const result = (await graph(provider, `query($input:PerformerQueryInput!){queryPerformers(input:$input){count performers{${performerFields}}}}`, { input: { names: query, page: 1, per_page: 20, direction: 'ASC', sort: 'NAME' } })).queryPerformers;
      if (!Array.isArray(result?.performers)) throw new ProviderError('Metadata provider returned an invalid search response.');
      return { results: result.performers.filter(p => !p.deleted).map(p => performer(provider, p)), hasMore: result.count > 20 };
    }
    const result = await wiki('www.wikidata.org', { action: 'wbsearchentities', search: query, language: 'en', uselang: 'en', type: 'item', limit: '20' });
    if (!Array.isArray(result.search)) throw new ProviderError('Wikidata returned an invalid search response.');
    return { results: result.search.map(row => ({ provider, id: row.id, entityType: 'item', name: row.label, description: row.description || '', url: `https://www.wikidata.org/wiki/${row.id}` })), hasMore: result['search-continue'] != null };
  }
  return { list: () => Object.entries(names).map(([id, name]) => ({ id, name, enabled: enabled(id), description: id === 'wikidata' ? 'People, places, organizations, and concepts' : 'Adult performers' })), search, get };
}
