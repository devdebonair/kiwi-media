import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-liked-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
const like = (id, count) => app.inject({ method: 'PUT', url: `/api/v1/assets/${id}/likes`, payload: { count } });

test('liked videos sort by like count, filter by level and topic, and skip unliked or non-video items', async () => {
  assert.deepEqual((await app.inject('/api/v1/liked')).json(), []);
  const videos = db.prepare("SELECT id FROM assets WHERE kind='video' ORDER BY added_at DESC, id DESC LIMIT 4").all().map(row => row.id);
  assert.equal(videos.length, 4);
  const other = db.prepare("SELECT id FROM assets WHERE kind!='video' LIMIT 1").get();
  await like(videos[0], 2);
  await like(videos[1], 5);
  await like(videos[2], 2);
  await like(videos[3], 0);
  if (other) await like(other.id, 5);
  db.prepare('INSERT INTO users VALUES (?,?,?)').run('other-user', 'Other', '2025-01-01');
  db.prepare('INSERT INTO asset_likes VALUES (?,?,?)').run('other-user', videos[3], 5);

  const rows = (await app.inject('/api/v1/liked')).json();
  assert.deepEqual(rows.map(row => row.id), [videos[1], videos[0], videos[2]]);
  assert.deepEqual(rows.map(row => row.my_likes), [5, 2, 2]);
  assert.ok(Array.isArray(rows[0].topics));
  assert.deepEqual((await app.inject('/api/v1/liked?limit=1&offset=1')).json().map(row => row.id), [videos[0]]);
  assert.deepEqual((await app.inject('/api/v1/liked?likes=2')).json().map(row => row.id), [videos[0], videos[2]]);
  assert.deepEqual((await app.inject('/api/v1/liked?likes=4')).json(), []);

  const filters = (await app.inject('/api/v1/liked/filters')).json();
  assert.deepEqual(filters.levels, [{ likes: 5, item_count: 1 }, { likes: 2, item_count: 2 }]);
  assert.ok(filters.topics.every(topic => topic.item_count < rows.length));
  for (const topic of filters.topics) {
    const matching = (await app.inject(`/api/v1/liked?topic=${encodeURIComponent(topic.slug)}`)).json();
    assert.equal(matching.length, topic.item_count);
    assert.ok(matching.every(row => row.topics.some(item => item.id === topic.id)));
  }
});

test('liked videos reject invalid filters and pagination', async () => {
  for (const query of ['likes=0', 'likes=6', 'likes=2.5', 'likes=', 'limit=0', 'limit=201', 'offset=-1']) {
    assert.equal((await app.inject(`/api/v1/liked?${query}`)).statusCode, 400, query);
  }
});
