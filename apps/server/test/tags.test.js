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
