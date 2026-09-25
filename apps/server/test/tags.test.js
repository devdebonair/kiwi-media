import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'kiwi-tags-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
const id = db.prepare('SELECT id FROM assets LIMIT 1').get().id;
const add = (payload, assetId = id) => app.inject({ method: 'POST', url: `/api/v1/assets/${assetId}/topics`, payload });

test('create and attach tags, reuse normalized names, persist and index them', async () => {
  const response = await add({ name: '  Fresh tag  ' });
  assert.equal(response.statusCode, 200);
  const topic = response.json().topics.find(t => t.name === 'Fresh tag');
  assert.ok(topic);
  await add({ name: 'FRESH TAG' });
  await add({ topicId: topic.id });
  assert.equal(db.prepare('SELECT count(*) n FROM annotation_topics WHERE topic_id=?').get(topic.id).n, 1);
  assert.ok((await app.inject(`/api/v1/assets/${id}`)).json().topics.some(t => t.id === topic.id));
  assert.ok((await app.inject('/api/v1/search?q=Fresh')).json().some(row => row.id === id));
  const other = db.prepare('SELECT id FROM assets WHERE id != ? LIMIT 1').get(id).id;
  assert.ok((await add({ topicId: topic.id }, other)).json().topics.some(t => t.id === topic.id));
  assert.equal(db.prepare('SELECT count(*) n FROM topics WHERE name=?').get('Fresh tag').n, 1);
});

test('invalid requests do not create tags or annotations', async () => {
  const before = db.prepare('SELECT count(*) n FROM topics').get().n;
  for (const payload of [{}, {name:' '}, {name:42}, {name:'a'.repeat(101)}, {topicId:42}, {topicId:''}]) assert.equal((await add(payload)).statusCode, 400);
  assert.equal((await add({ topicId: 'missing' })).statusCode, 404);
  assert.equal((await add({ name: 'Unused' }, 'missing')).statusCode, 404);
  assert.equal(db.prepare('SELECT count(*) n FROM topics').get().n, before);
});

test('tag saves update only the affected search entries and preserve existing tags', async () => {
  // Give an unrelated entry a distinct rowid so a full rebuild cannot pass by
  // recreating the same rows in their original order.
  db.prepare("UPDATE search_index SET rowid=(SELECT max(rowid)+100 FROM search_index) WHERE entity_type='asset' AND entity_id=(SELECT id FROM assets WHERE id != ? LIMIT 1)").run(id);
  const unaffected = () => db.prepare("SELECT rowid,* FROM search_index WHERE NOT (entity_type='asset' AND entity_id=?) ORDER BY rowid").all(id);
  const before = unaffected();
  const response = await add({ name: 'Incremental unique tag' });
  assert.equal(response.statusCode, 200);
  const topic = response.json().topics.find(t => t.name === 'Incremental unique tag');
  assert.ok(topic);
  assert.deepEqual(unaffected().filter(row => row.entity_id !== topic.id), before);
  const indexedAsset = db.prepare("SELECT * FROM search_index WHERE entity_type='asset' AND entity_id=?").all(id);
  assert.equal(indexedAsset.length, 1);
  assert.match(indexedAsset[0].tags, /Incremental unique tag/);
  assert.match(indexedAsset[0].tags, /Fresh tag/);
  const hits = (await app.inject('/api/v1/search?q=Incremental')).json();
  assert.ok(hits.some(row => row.id === id && row.entityType === 'asset'));
  assert.ok(hits.some(row => row.id === topic.id && row.entityType === 'topic'));

  const existing = db.prepare('SELECT id FROM topics WHERE id != ? AND id NOT IN (SELECT at.topic_id FROM annotation_topics at JOIN annotations a ON a.id=at.annotation_id WHERE a.asset_id=?) LIMIT 1').get(topic.id, id);
  const beforeExisting = unaffected();
  assert.equal((await add({ topicId: existing.id })).statusCode, 200);
  assert.deepEqual(unaffected(), beforeExisting);
  const saved = db.prepare('SELECT rowid,* FROM search_index ORDER BY rowid').all();
  assert.equal((await add({ topicId: existing.id })).statusCode, 200);
  assert.deepEqual(db.prepare('SELECT rowid,* FROM search_index ORDER BY rowid').all(), saved);
});

test('topic tags apply to every item under the topic once', async () => {
  const bulk = (payload, topicId = 'topic-jazz') => app.inject({ method: 'POST', url: `/api/v1/topics/${topicId}/topics`, payload });
  const members = () => db.prepare("SELECT DISTINCT asset_id FROM effective_asset_topics WHERE topic_id='topic-jazz' ORDER BY asset_id").all().map(row => row.asset_id);
  const response = await bulk({ name: 'Bulk jazz tag' });
  assert.equal(response.statusCode, 200);
  const { topic, tagged, total } = response.json();
  assert.equal(topic.name, 'Bulk jazz tag');
  assert.equal(tagged, members().length);
  assert.equal(total, members().length);
  assert.deepEqual(db.prepare('SELECT DISTINCT asset_id FROM effective_asset_topics WHERE topic_id=? ORDER BY asset_id').all(topic.id).map(row => row.asset_id), members());
  assert.ok((await app.inject('/api/v1/search?q=Bulk')).json().some(row => row.id === members()[0] && row.entityType === 'asset'));

  const again = (await bulk({ topicId: topic.id })).json();
  assert.equal(again.tagged, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM annotation_topics WHERE topic_id=?').get(topic.id).n, members().length);
});

test('invalid topic tag requests change nothing', async () => {
  const bulk = (payload, topicId = 'topic-jazz') => app.inject({ method: 'POST', url: `/api/v1/topics/${topicId}/topics`, payload });
  const before = db.prepare('SELECT (SELECT count(*) FROM topics) topics, (SELECT count(*) FROM annotations) annotations').get();
  assert.equal((await bulk({ topicId: 'topic-jazz' })).statusCode, 400);
  assert.equal((await bulk({ name: '' })).statusCode, 400);
  assert.equal((await bulk({ topicId: 'missing' })).statusCode, 404);
  assert.equal((await bulk({ name: 'Orphan tag' }, 'missing')).statusCode, 404);
  assert.deepEqual(db.prepare('SELECT (SELECT count(*) FROM topics) topics, (SELECT count(*) FROM annotations) annotations').get(), before);
});
