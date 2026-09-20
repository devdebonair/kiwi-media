import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'kiwi-engagement-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db, migrate } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
const id = db.prepare('SELECT id FROM assets LIMIT 1').get().id;
const send = (method, url, payload) => app.inject({ method, url, payload });

test('views deduplicate session retries and ignore progress updates and legacy inflated counts', async () => {
  db.prepare('INSERT INTO consumption_state (user_id,asset_id,view_count) VALUES (?,?,?)').run('user-local', id, 999);
  for (let i = 0; i < 4; i++) {
    const result = await send('POST', `/api/v1/assets/${id}/views`, {sessionId:'session-1234567890'});
    assert.equal(result.json().view_count, 1);
    await send('PUT', `/api/v1/assets/${id}/progress`, {progressMs:i*20000});
  }
  assert.equal((await app.inject(`/api/v1/assets/${id}`)).json().view_count, 1);
  assert.equal((await send('POST', `/api/v1/assets/${id}/views`, {sessionId:'session-9876543210'})).json().view_count, 2);
  assert.equal((await app.inject('/api/v1/history')).json().find(a=>a.id===id).view_count, 2);
  migrate();
  assert.equal((await app.inject(`/api/v1/assets/${id}`)).json().view_count, 2);
  assert.equal((await send('POST', `/api/v1/assets/${id}/views`, {sessionId:''})).statusCode, 400);
  assert.equal((await send('POST', '/api/v1/assets/missing/views', {sessionId:'session-1234567890'})).statusCode, 404);
});

test('likes support five increments, idempotent retries, clearing, and enforce the cap', async () => {
  for (let count = 1; count <= 5; count++) {
    for (let retry = 0; retry < 2; retry++) {
      const result = await send('PUT', `/api/v1/assets/${id}/likes`, {count});
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().my_likes, count);
      assert.equal(result.json().like_count, count);
    }
  }
  for (const count of [6,-1,1.5,'3',null]) assert.equal((await send('PUT', `/api/v1/assets/${id}/likes`, {count})).statusCode,400);
  assert.equal((await app.inject(`/api/v1/assets/${id}`)).json().my_likes,5);
  assert.equal((await send('PUT', `/api/v1/assets/${id}/likes`, {count:0})).json().my_likes,0);
  assert.equal((await send('PUT', '/api/v1/assets/missing/likes', {count:1})).statusCode,404);
});

test('shorts exclude boundary durations, unknown durations, non-videos and missing files, paginate and use persistent settings', async () => {
  db.prepare('UPDATE assets SET duration_ms=NULL').run();
  const insert = db.prepare('INSERT INTO assets (id,kind,title,file_path,duration_ms,added_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  for (const [name, kind, file, duration] of [['short-a','video','a.mp4',89999],['short-b','video','b.mp4',1000],['boundary','video','c.mp4',90000],['unknown','video','d.mp4',null],['zero','video','z.mp4',0],['audio','audio','a.mp3',1000],['missing','video',null,1000]]) insert.run(name,kind,name,file,duration,'2026-01-01','2026-01-01');
  assert.equal((await app.inject('/api/v1/settings')).json().shortsMaxSeconds,90);
  assert.deepEqual((await app.inject('/api/v1/shorts')).json().map(a=>a.id),['short-b','short-a']);
  assert.deepEqual((await app.inject('/api/v1/shorts?limit=1&offset=1')).json().map(a=>a.id),['short-a']);
  assert.equal((await send('PUT','/api/v1/settings',{shortsMaxSeconds:91})).statusCode,200);
  migrate();
  assert.equal((await app.inject('/api/v1/settings')).json().shortsMaxSeconds,91);
  assert.ok((await app.inject('/api/v1/shorts')).json().some(a=>a.id==='boundary'));
  for (const shortsMaxSeconds of [0,-1,3601,1.5,'90']) assert.equal((await send('PUT','/api/v1/settings',{shortsMaxSeconds})).statusCode,400);
  assert.equal((await app.inject('/api/v1/shorts?offset=-1')).statusCode,400);
});
