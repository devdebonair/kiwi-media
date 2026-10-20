import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-guide-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
const { GUIDE_EPOCH, MIN_CHANNEL_VIDEOS } = await import('../src/guide.js');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

const minute = 60_000;
const insertVideo = db.prepare("INSERT INTO assets (id,kind,title,file_path,duration_ms,added_at,updated_at) VALUES (?,?,?,?,?,?,?)");
const video = (id, minutes, kind = 'video', file = `/media/${id}.mp4`) => insertVideo.run(id, kind, `Title ${id}`, file, minutes * minute, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
const tag = async (assetId, name) => (await app.inject({ method: 'POST', url: `/api/v1/assets/${assetId}/topics`, payload: { name } })).json().topics.find(t => t.name === name);
const guide = async query => (await app.inject(`/api/v1/guide?${query}`)).json();

video('g1', 10); video('g2', 20); video('g3', 30); video('g4', 15);
video('g-audio', 10, 'audio'); video('g-missing', 10, 'video', null);
const comedy = await tag('g1', 'Guide Comedy');
for (const id of ['g2', 'g3', 'g-audio', 'g-missing']) await tag(id, 'Guide Comedy');
const drama = await tag('g2', 'Guide Drama');
for (const id of ['g3', 'g4']) await tag(id, 'Guide Drama');
const sparse = await tag('g4', 'Guide Sparse');
const channelFor = (rows, topic) => rows.channels.find(channel => channel.key === `topic:${topic.id}`);

test('every tag with enough playable videos gets a looping channel that fills the window back to back', async () => {
  const rows = await guide(`start=${GUIDE_EPOCH}&hours=6&limit=100&q=guide`);
  const channel = channelFor(rows, comedy);
  assert.ok(channel, 'tag channel exists');
  assert.equal(channel.item_count, 3, 'audio and missing files are not scheduled');
  assert.equal(channelFor(rows, sparse), undefined, `fewer than ${MIN_CHANNEL_VIDEOS} videos gets no channel`);
  assert.ok(channel.number >= 100);
  const { programs } = channel;
  assert.equal(programs[0].start, GUIDE_EPOCH, 'the lineup starts at the epoch');
  for (let i = 1; i < programs.length; i++) assert.equal(programs[i].start, programs[i - 1].end);
  assert.ok(programs.at(-1).end >= rows.end);
  assert.ok(programs.every(program => program.end - program.start === program.duration_ms && program.title.startsWith('Title ')));
  // A 60-minute cycle repeats in the same order.
  assert.deepEqual(programs.slice(3, 6).map(p => p.id), programs.slice(0, 3).map(p => p.id));
});

test('a single channel can be fetched by key', async () => {
  const rows = await guide(`start=${GUIDE_EPOCH}&hours=1&channel=${encodeURIComponent(`topic:${drama.id}`)}`);
  assert.equal(rows.total, 1);
  assert.equal(rows.channels[0].key, `topic:${drama.id}`);
  assert.equal((await guide(`channel=topic:missing`)).total, 0);
});

test('a window starting mid-program includes the program already airing, and is stable across requests', async () => {
  const start = GUIDE_EPOCH + 1000 * 60 * minute + 7 * minute;
  const first = channelFor(await guide(`start=${start}&hours=1&limit=100&q=guide`), drama).programs;
  const again = channelFor(await guide(`start=${start}&hours=1&limit=100&q=guide`), drama).programs;
  assert.deepEqual(first, again);
  assert.ok(first[0].start <= start && first[0].end > start);
  const earlier = channelFor(await guide(`start=${start - 3 * 60 * minute}&hours=6&limit=100&q=guide`), drama).programs;
  assert.ok(earlier.some(p => p.id === first[0].id && p.start === first[0].start), 'windows agree on what airs when');
});

test('custom channels combine tags with all or any, take low numbers, and can be edited and deleted', async () => {
  const count = async (ids, match) => (await app.inject(`/api/v1/guide/count?topics=${ids.join(',')}&match=${match}`)).json().item_count;
  assert.equal(await count([comedy.id, drama.id], 'all'), 2);
  assert.equal(await count([comedy.id, drama.id], 'any'), 4);

  const created = await app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload: { name: ' Both ', topicIds: [comedy.id, drama.id, comedy.id], match: 'all' } });
  assert.equal(created.statusCode, 201);
  const channel = created.json();
  assert.equal(channel.number, 1);
  assert.equal(channel.name, 'Both');
  assert.equal(channel.topics.length, 2);
  let rows = await guide(`start=${GUIDE_EPOCH}&filter=custom`);
  assert.equal(rows.total, 1);
  assert.equal(rows.channels[0].item_count, 2);
  assert.ok(rows.channels[0].programs.every(p => ['g2', 'g3'].includes(p.id)));
  assert.equal((await guide(`start=${GUIDE_EPOCH}`)).channels[0].key, `custom:${channel.id}`, 'custom channels list first');

  const second = (await app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload: { name: 'Either', topicIds: [sparse.id], match: 'any' } })).json();
  assert.equal(second.number, 2);
  const edited = await app.inject({ method: 'PUT', url: `/api/v1/guide/channels/${channel.id}`, payload: { name: 'Either way', topicIds: [comedy.id, drama.id], match: 'any' } });
  assert.equal(edited.json().match, 'any');
  rows = await guide(`start=${GUIDE_EPOCH}&filter=custom`);
  assert.equal(rows.channels[0].item_count, 4);
  assert.equal(rows.channels[1].item_count, 1, 'custom channels show even when sparse');

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/guide/channels/${channel.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/guide/channels/${channel.id}` })).statusCode, 404);
  const reused = (await app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload: { name: 'Again', topicIds: [drama.id], match: 'all' } })).json();
  assert.equal(reused.number, 1, 'freed numbers are reused');
  assert.deepEqual((await app.inject('/api/v1/guide/channels')).json().map(c => c.number), [1, 2]);
});

test('guide requests and channel edits are validated', async () => {
  for (const query of ['hours=0', 'hours=13', 'start=abc', 'limit=0', 'limit=101', 'offset=-1', 'filter=nope']) {
    assert.equal((await app.inject(`/api/v1/guide?${query}`)).statusCode, 400, query);
  }
  const post = payload => app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload });
  assert.equal((await post({ name: '', topicIds: [comedy.id], match: 'all' })).statusCode, 400);
  assert.equal((await post({ name: 'x'.repeat(61), topicIds: [comedy.id], match: 'all' })).statusCode, 400);
  assert.equal((await post({ name: 'No tags', topicIds: [], match: 'all' })).statusCode, 400);
  assert.equal((await post({ name: 'Bad mode', topicIds: [comedy.id], match: 'some' })).statusCode, 400);
  assert.equal((await post({ name: 'Ghost', topicIds: ['missing-topic'], match: 'all' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/guide/channels/missing', payload: { name: 'x', topicIds: [comedy.id], match: 'all' } })).statusCode, 404);
});
