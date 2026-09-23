import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'kiwi-folder-tags-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db, migrate, rebuildSearch } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
const timestamp = new Date().toISOString();
const root = 'tagged-root';
db.prepare('INSERT INTO library_roots(id,name,absolute_path,created_at) VALUES (?,?,?,?)').run(root, 'Folder', '/media/test_%', timestamp);
const addAsset = (id, path, rootId = root) => {
  db.prepare('INSERT INTO assets(id,kind,title,file_path,added_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, 'video', `Film ${id}`, path, timestamp, timestamp);
  if (rootId) db.prepare('INSERT INTO files(id,asset_id,role,library_root_id,relative_path,created_at) VALUES (?,?,?,?,?,?)').run(`file-${id}`, id, 'original', rootId, path.split('/').at(-1), timestamp);
};
addAsset('folder-first', '/media/test_%/first.mp4');
addAsset('folder-nested', '/media/test_%/nested/second.mp4');
addAsset('folder-outside', '/media/test_%extra/outside.mp4', null);
addAsset('folder-wildcard', '/media/test-ab/outside.mp4', null);
const endpoint = `/api/v1/library/roots/${root}/topics`;
const add = payload => app.inject({ method: 'POST', url: endpoint, payload });
const get = async url => { const response = await app.inject(url); assert.equal(response.statusCode, 200); return response.json(); };

test('folder tags are query-time inheritance across content, filters, counts, feeds and search', async () => {
  const annotations = db.prepare('SELECT count(*) n FROM annotations').get().n;
  const response = await add({ name: 'Foldermagic' });
  assert.equal(response.statusCode, 200);
  const topic = response.json().topics[0];
  await add({ name: ' FOLDERMAGIC ' });
  await add({ topicId: topic.id });
  assert.equal(db.prepare('SELECT count(*) n FROM folder_topics').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM annotations').get().n, annotations);
  assert.equal(db.prepare('SELECT count(*) n FROM annotation_topics WHERE topic_id=?').get(topic.id).n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM search_index WHERE entity_type='asset' AND tags LIKE '%Foldermagic%'").get().n, 0);
  migrate();
  assert.equal((await get('/api/v1/library/roots')).find(r => r.id === root).topics[0].id, topic.id);
  for (const id of ['folder-first', 'folder-nested']) assert.ok((await get(`/api/v1/assets/${id}`)).topics.some(t => t.id === topic.id));
  for (const id of ['folder-outside', 'folder-wildcard']) assert.ok(!(await get(`/api/v1/assets/${id}`)).topics.some(t => t.id === topic.id));
  assert.equal((await get(`/api/v1/assets?topic=${topic.slug}`)).length, 2);
  assert.equal((await get(`/api/v1/assets?topic=${topic.id}&limit=1&offset=1`)).length, 1);
  assert.equal((await get('/api/v1/topics')).find(t => t.id === topic.id).item_count, 2);
  assert.equal((await get(`/api/v1/topics/${topic.slug}`)).item_count, 2);
  assert.equal((await get('/api/v1/search?q=Foldermagic&kind=videos')).length, 2);
  rebuildSearch();
  assert.equal((await get('/api/v1/search?q=Film%20Foldermagic&kind=videos')).length, 2);
  // New assets inherit even before rebuilding the search index.
  addAsset('folder-later', '/media/test_%/later.mp4');
  assert.equal((await get(`/api/v1/assets?topic=${topic.id}`)).length, 3);
  assert.equal((await get('/api/v1/search?q=Foldermagic&kind=videos')).length, 3);
  const feed = (await app.inject({ method: 'POST', url: '/api/v1/feeds', payload: { name: 'Folder feed', query: { topicIds: [topic.id] } } })).json();
  assert.equal((await get(`/api/v1/feeds/${feed.slug}`)).assets.length, 3);
  // Direct tags and duplicate file records must not inflate counts or labels.
  await app.inject({ method: 'POST', url: '/api/v1/assets/folder-first/topics', payload: { topicId: topic.id } });
  await app.inject({ method: 'POST', url: '/api/v1/assets/folder-first/topics', payload: { name: 'Related folder tag' } });
  db.prepare('INSERT INTO files(id,asset_id,role,library_root_id,created_at) VALUES (?,?,?,?,?)').run('duplicate', 'folder-first', 'original', root, timestamp);
  assert.equal((await get('/api/v1/assets/folder-first')).topics.filter(t => t.id === topic.id).length, 1);
  const detail = await get(`/api/v1/topics/${topic.slug}`);
  assert.equal(detail.item_count, 3);
  assert.ok(detail.related.some(t => t.name === 'Related folder tag' && t.item_count === 1));
  await app.inject({ method: 'PATCH', url: `/api/v1/library/roots/${root}`, payload: { enabled: false } });
  assert.equal((await get(`/api/v1/assets?topic=${topic.id}`)).length, 3);
  assert.equal((await app.inject({ method: 'DELETE', url: `${endpoint}/${topic.id}` })).statusCode, 200);
  assert.deepEqual((await get(`/api/v1/assets?topic=${topic.id}`)).map(a => a.id), ['folder-first']);
  assert.deepEqual((await get('/api/v1/search?q=Foldermagic&kind=videos')).map(a => a.id), ['folder-first']);
});

test('overlapping connected folders inherit by literal directory boundary', async () => {
  db.prepare('INSERT INTO library_roots(id,name,absolute_path,created_at) VALUES (?,?,?,?)').run('nested-root', 'Nested', '/media/test_%/nested', timestamp);
  const response = await app.inject({ method: 'POST', url: '/api/v1/library/roots/nested-root/topics', payload: { name: 'Nestedmagic' } });
  const topic = response.json().topics[0];
  assert.deepEqual((await get(`/api/v1/assets?topic=${topic.id}`)).map(a => a.id), ['folder-nested']);
});

test('invalid folder tagging requests do not create tags or links', async () => {
  const before = db.prepare('SELECT count(*) n FROM topics').get().n;
  for (const payload of [{}, { name: ' ' }, { name: 42 }, { name: 'a'.repeat(101) }, { topicId: 42 }, { topicId: '' }]) assert.equal((await add(payload)).statusCode, 400);
  assert.equal((await add({ topicId: 'missing' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/library/roots/missing/topics', payload: { name: 'Unused' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/library/roots/missing/topics/missing' })).statusCode, 404);
  assert.equal(db.prepare('SELECT count(*) n FROM topics').get().n, before);
});
