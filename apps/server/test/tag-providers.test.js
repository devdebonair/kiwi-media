import test from 'node:test';
import assert from 'node:assert/strict';
import { createTagProviders, entityId } from '../src/tag-providers.js';
const response = data => new Response(JSON.stringify(data));
const personId = '12345678-1234-1234-1234-123456789abc';

test('provider listing exposes capabilities but never secrets', () => {
  const providers = createTagProviders({ env: { TPDB_API_KEY: 'secret' } });
  assert.deepEqual(providers.list().map(p => [p.id, p.enabled]), [['wikidata', true], ['stashdb', false], ['tpdb', true]]);
  assert.ok(!JSON.stringify(providers.list()).includes('secret'));
});

test('IDs and URLs are parsed without fetching arbitrary addresses', async () => {
  assert.equal(entityId('wikidata', 'https://www.wikidata.org/wiki/Q2263'), 'Q2263');
  assert.equal(entityId('stashdb', `https://stashdb.org/performers/${personId}`), personId);
  let calls = 0;
  const providers = createTagProviders({ env: {}, fetchImpl: async () => { calls++; throw Error('should not fetch'); } });
  for (const query of ['http://[', 'http://127.0.0.1/secret', 'https://wikidata.org.evil.test/wiki/Q2263', 'https://user:secret@www.wikidata.org/wiki/Q2263']) await assert.rejects(providers.search('wikidata', query), { statusCode: 400 });
  await assert.rejects(providers.get('wikidata', 'not-an-id'), { statusCode: 400 });
  await assert.rejects(providers.search('__proto__', 'Tom'), { statusCode: 400 });
  await assert.rejects(providers.search('stashdb', 'Tom'), { statusCode: 400 });
  assert.equal(calls, 0);
});

const entity = { id: 'Q2263', labels: { en: { value: 'Tom Hanks' } }, descriptions: { en: { value: 'American actor' } }, aliases: { en: [{ value: 'Thomas Hanks' }] }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q5' } } } }], P18: [{ mainsnak: { datavalue: { value: 'Tom Hanks.jpg' } } }] }, sitelinks: { enwiki: { title: 'Tom Hanks' } } };

test('Wikidata identity retrieves a verified Wikipedia summary and image attribution', async () => {
  const requests = [];
  const providers = createTagProviders({ fetchImpl: async url => {
    requests.push(new URL(url));
    return String(url).includes('en.wikipedia.org') ? response({ query: { pages: { 1: { extract: 'Tom is an actor.\nMore text.', fullurl: 'https://en.wikipedia.org/wiki/Tom_Hanks', pageprops: { wikibase_item: 'Q2263' } } } } }) : response({ entities: { Q2263: entity } });
  } });
  const result = await providers.get('wikidata', 'Q2263');
  assert.equal(result.topic_type, 'person');
  assert.equal(result.summary, 'Tom is an actor.');
  assert.deepEqual(result.aliases, ['Thomas Hanks']);
  assert.match(result.avatar_url, /Special:FilePath/);
  assert.ok(result.attribution.some(x => x.label.includes('license')));
  assert.ok(result.attribution.some(x => x.label.includes('CC BY-SA')));
  assert.equal(requests[1].searchParams.get('titles'), 'Tom Hanks');
});

test('Wikipedia mismatches are not imported; failures leave usable Wikidata details', async () => {
  let mode = 'mismatch';
  const providers = createTagProviders({ fetchImpl: async url => {
    if (!String(url).includes('en.wikipedia.org')) return response({ entities: { Q2263: entity } });
    if (mode === 'error') return new Response('', { status: 503 });
    return response({ query: { pages: { 1: { extract: 'Someone else', fullurl: 'https://en.wikipedia.org/wiki/Other', pageprops: { wikibase_item: 'Q123' } } } } });
  } });
  assert.equal((await providers.get('wikidata', 'Q2263')).summary, 'American actor');
  mode = 'error';
  const result = await providers.get('wikidata', 'Q2263');
  assert.equal(result.summary, 'American actor');
  assert.equal(result.warnings.length, 1);
});

test('StashDB and TPDB search performers and fetch by stable ID, excluding deleted results', async () => {
  for (const provider of ['stashdb', 'tpdb']) {
    const requests = [];
    const person = { id: personId, name: 'Example', aliases: ['Alias'], images: [{ url: 'https://images.example/avatar.jpg' }], urls: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/profile' }] };
    const adapter = createTagProviders({ env: { STASH_BOX_ENDPOINT: 'https://stashdb.org/graphql', STASH_BOX_API_KEY: 'secret', TPDB_API_KEY: 'secret' }, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      assert.equal(options.headers.ApiKey, 'secret'); assert.equal(options.redirect, 'error');
      return response({ data: body.variables.id ? { findPerformer: person } : { queryPerformers: { count: 21, performers: [person, { ...person, deleted: true }] } } });
    } });
    const result = await adapter.search(provider, 'Alias');
    assert.equal(result.results.length, 1); assert.equal(result.hasMore, true);
    assert.equal(result.results[0].links.length, 1);
    assert.equal((await adapter.get(provider, personId)).id, personId);
    assert.equal(requests[1].variables.id, personId);
  }
});

test('provider failures are safe and actionable', async () => {
  for (const status of [401, 429, 500]) {
    const adapter = createTagProviders({ fetchImpl: async () => new Response('secret', { status }) });
    await assert.rejects(adapter.search('wikidata', 'Tom'), error => error.statusCode === 502 && !error.message.includes('secret'));
  }
});
