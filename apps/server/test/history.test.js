import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-history-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

test('history orders by last watch, paginates, and moves rewatches to the top', async () => {
  assert.deepEqual((await app.inject('/api/v1/history')).json(), []);
  const assets = db.prepare('SELECT id FROM assets ORDER BY added_at DESC, id DESC LIMIT 3').all();
  const insert = db.prepare('INSERT INTO consumption_state (user_id,asset_id,last_viewed_at) VALUES (?,?,?)');
  insert.run('user-local', assets[0].id, '2025-01-01T12:00:00.000Z');
  insert.run('user-local', assets[1].id, '2025-01-02T12:00:00.000Z');
  db.prepare('INSERT INTO users VALUES (?,?,?)').run('other-user', 'Other', '2025-01-01');
  insert.run('other-user', assets[2].id, '2025-01-03T12:00:00.000Z');
  let rows = (await app.inject('/api/v1/history')).json();
  assert.deepEqual(rows.map(row => row.id), [assets[1].id, assets[0].id]);
  assert.equal(rows[0].last_viewed_at, '2025-01-02T12:00:00.000Z');
  assert.ok(Array.isArray(rows[0].topics));
  assert.deepEqual((await app.inject('/api/v1/history?limit=1&offset=1')).json().map(row => row.id), [assets[0].id]);
  const result = await app.inject({ method: 'PUT', url: `/api/v1/assets/${assets[0].id}/progress`, payload: { progressMs: 1500, completed: true } });
  assert.equal(result.statusCode, 200);
  rows = (await app.inject('/api/v1/history')).json();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, assets[0].id);
  assert.equal(rows[0].progress_ms, 1500);
  assert.equal(rows[0].completed, 1);
});

test('history and progress reject invalid inputs', async () => {
  for (const query of ['limit=0', 'limit=201', 'offset=-1', 'offset=1.5', 'limit=nope']) {
    assert.equal((await app.inject(`/api/v1/history?${query}`)).statusCode, 400);
  }
  const { id } = db.prepare('SELECT id FROM assets LIMIT 1').get();
  for (const progressMs of [-1, 1.5, 'nope']) {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/assets/${id}/progress`, payload: { progressMs } })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/assets/missing/progress', payload: { progressMs: 10 } })).statusCode, 404);
});

test('asset details return persisted progress for the current user only', async () => {
  const assets = db.prepare('SELECT id FROM assets ORDER BY id LIMIT 2').all();
  const id = assets[0].id;
  await app.inject({ method: 'PUT', url: `/api/v1/assets/${id}/progress`, payload: { progressMs: 42000, completed: false } });
  let asset = (await app.inject(`/api/v1/assets/${id}`)).json();
  assert.equal(asset.progress_ms, 42000);
  assert.equal(asset.completed, 0);
  await app.inject({ method: 'PUT', url: `/api/v1/assets/${id}/progress`, payload: { progressMs: 90000, completed: true } });
  asset = (await app.inject(`/api/v1/assets/${id}`)).json();
  assert.equal(asset.completed, 1);
  db.prepare('DELETE FROM consumption_state WHERE user_id=? AND asset_id=?').run('user-local', assets[1].id);
  db.prepare('INSERT OR REPLACE INTO consumption_state (user_id,asset_id,progress_ms,completed) VALUES (?,?,?,?)').run('other-user', assets[1].id, 12000, 1);
  asset = (await app.inject(`/api/v1/assets/${assets[1].id}`)).json();
  assert.equal(asset.progress_ms, 0);
  assert.equal(asset.completed, 0);
});
