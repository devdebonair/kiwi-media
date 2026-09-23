import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importLibraryRoots } from '../../../packages/database/src/import-library-roots.js';
const directory = mkdtempSync(join(tmpdir(), 'kiwi-roots-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db, migrate } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

test('legacy import preserves root identity and file references, and is repeatable', () => {
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE library_roots(id TEXT PRIMARY KEY,name TEXT,absolute_path TEXT UNIQUE,read_only INTEGER,created_at TEXT);
    CREATE TABLE files(id TEXT PRIMARY KEY,library_root_id TEXT REFERENCES library_roots(id));
    INSERT INTO library_roots VALUES ('original','Custom name','/old',1,'original timestamp');
    INSERT INTO files VALUES ('file','original');`);
  assert.equal(importLibraryRoots(legacy, '/old:/new:/new/'), 1);
  assert.equal(importLibraryRoots(legacy, '/old:/new'), 0);
  assert.equal(legacy.prepare('SELECT name FROM library_roots WHERE id=?').get('original').name, 'Custom name');
  assert.equal(legacy.prepare('SELECT library_root_id FROM files').get().library_root_id, 'original');
  assert.equal(legacy.prepare('PRAGMA foreign_key_check').all().length, 0);
  legacy.close();
});

test('database folders drive scans, persist across migrations, and preserve media when paused', async () => {
  const assets = db.prepare('SELECT * FROM assets ORDER BY id').all();
  const result = await app.inject({ method: 'POST', url: '/api/v1/library/roots', payload: { path: directory } });
  assert.equal(result.statusCode, 201);
  const root = result.json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/library/roots', payload: { path: directory + '/' } })).statusCode, 409);
  for (const path of ['relative', '/does-not-exist-kiwi', 12, null]) assert.equal((await app.inject({ method: 'POST', url: '/api/v1/library/roots', payload: { path } })).statusCode, 400);
  process.env.KIWI_MEDIA_DIRS = '/ignored-environment-folder';
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/v1/library/scan' })).json().roots, [directory]);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/library/roots/${root.id}`, payload: { enabled: false } })).statusCode, 200);
  migrate();
  importLibraryRoots(db, directory);
  assert.equal((await app.inject('/api/v1/library/roots')).json()[0].enabled, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/library/scan' })).statusCode, 400);
  assert.deepEqual(db.prepare('SELECT * FROM assets ORDER BY id').all(), assets);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/library/roots/${root.id}`, payload: { enabled: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/library/scan' })).statusCode, 202);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/library/roots/missing', payload: { enabled: true } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/library/roots/${root.id}`, payload: { enabled: 'false' } })).statusCode, 400);
});
