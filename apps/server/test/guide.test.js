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
  const count = async (ids, match) => (await app.inject({ method: 'POST', url: '/api/v1/guide/preview', payload: { rules: { topicIds: ids, match } } })).json().item_count;
  assert.equal(await count([comedy.id, drama.id], 'all'), 2);
  assert.equal(await count([comedy.id, drama.id], 'any'), 4);

  const created = await app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload: { name: ' Both ', rules: { topicIds: [comedy.id, drama.id, comedy.id], match: 'all' } } });
  assert.equal(created.statusCode, 201);
  const channel = created.json();
  assert.equal(channel.number, 1);
  assert.equal(channel.name, 'Both');
  assert.equal(channel.sources.topics.length, 2);
  assert.equal(channel.scope, 'household', "an admin's channel is for everyone unless they choose otherwise");
  let rows = await guide(`start=${GUIDE_EPOCH}&filter=custom`);
  assert.equal(rows.total, 1);
  assert.equal(rows.channels[0].item_count, 2);
  assert.ok(rows.channels[0].programs.every(p => ['g2', 'g3'].includes(p.id)));
  assert.equal((await guide(`start=${GUIDE_EPOCH}`)).channels[0].key, `custom:${channel.id}`, 'custom channels list first');

  const second = (await app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload: { name: 'Either', rules: { topicIds: [sparse.id], match: 'any' } } })).json();
  assert.equal(second.number, 2);
  const edited = await app.inject({ method: 'PUT', url: `/api/v1/guide/channels/${channel.id}`, payload: { name: 'Either way', rules: { topicIds: [comedy.id, drama.id], match: 'any' } } });
  assert.equal(edited.json().rules.match, 'any');
  rows = await guide(`start=${GUIDE_EPOCH}&filter=custom`);
  assert.equal(rows.channels[0].item_count, 4);
  assert.equal(rows.channels[1].item_count, 1, 'custom channels show even when sparse');

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/guide/channels/${channel.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/guide/channels/${channel.id}` })).statusCode, 404);
  const reused = (await app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload: { name: 'Again', rules: { topicIds: [drama.id] } } })).json();
  assert.equal(reused.number, 1, 'freed numbers are reused');
  assert.deepEqual((await app.inject('/api/v1/guide/channels')).json().map(c => c.number), [1, 2]);
});

test('guide requests and channel edits are validated', async () => {
  for (const query of ['hours=0', 'hours=13', 'start=abc', 'limit=0', 'limit=101', 'offset=-1', 'filter=nope']) {
    assert.equal((await app.inject(`/api/v1/guide?${query}`)).statusCode, 400, query);
  }
  const post = payload => app.inject({ method: 'POST', url: '/api/v1/guide/channels', payload });
  const rules = { topicIds: [comedy.id] };
  assert.equal((await post({ name: '', rules })).statusCode, 400);
  assert.equal((await post({ name: 'x'.repeat(61), rules })).statusCode, 400);
  assert.equal((await post({ name: 'No rules' })).statusCode, 400);
  assert.equal((await post({ name: 'No sources', rules: { topicIds: [], types: ['home'] } })).statusCode, 400);
  assert.equal((await post({ name: 'Bad mode', rules: { ...rules, match: 'some' } })).statusCode, 400);
  assert.equal((await post({ name: 'Bad type', rules: { ...rules, types: ['cartoons'] } })).statusCode, 400);
  assert.equal((await post({ name: 'Bad rating', rules: { ...rules, maxRating: 'pg' } })).statusCode, 400);
  assert.equal((await post({ name: 'Bad years', rules: { ...rules, yearFrom: 2000, yearTo: 1990 } })).statusCode, 400);
  assert.equal((await post({ name: 'Bad order', rules, order: 'random' })).statusCode, 400);
  assert.equal((await post({ name: 'Bad block', rules, episodeBlock: 3 })).statusCode, 400);
  assert.equal((await post({ name: 'Bad scope', rules, scope: 'friends' })).statusCode, 400);
  assert.equal((await post({ name: 'Ghost', rules: { topicIds: ['missing-topic'] } })).statusCode, 404);
  assert.equal((await post({ name: 'Ghost show', rules: { titleIds: ['missing-title'] } })).statusCode, 404);
  assert.equal((await post({ name: 'Ghost list', rules: { listIds: ['missing-list'] } })).statusCode, 404);
  assert.equal((await post({ name: 'Ghost folder', rules: { rootIds: ['missing-root'] } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/guide/channels/missing', payload: { name: 'x', rules } })).statusCode, 404);
});

// Four two-hour videos on their own channel, so a test's few seconds never cross a program boundary.
for (const id of ['s1', 's2', 's3', 's4']) video(id, 120);
const steady = await tag('s1', 'Guide Steady');
for (const id of ['s2', 's3', 's4']) await tag(id, 'Guide Steady');
const steadyKey = `topic:${steady.id}`;
const steadyNow = async () => {
  const now = Date.now();
  return { now, programs: (await guide(`start=${now}&hours=12&channel=${encodeURIComponent(steadyKey)}`)).channels[0].programs };
};
const anchorOf = profile => { const row = db.prepare("SELECT asset_id, start_ms FROM guide_anchors WHERE profile_id=? AND channel_key=?").get(profile, steadyKey); return row && { ...row }; };

test('what is on now stays on when lengths change or videos leave; only what comes after moves', async () => {
  const before = await steadyNow();
  const on = before.programs[0];
  assert.ok(on.start <= before.now && before.now < on.end);
  assert.deepEqual(anchorOf('user-local'), { asset_id: on.id, start_ms: on.start }, 'the program on now is where the channel stands');

  // Every video's length changes, as when their files are probed: before this, any change re-timed the whole loop.
  db.prepare("UPDATE assets SET duration_ms=? WHERE id IN ('s1','s2','s3','s4') AND id!=?").run(185 * minute, on.id);
  db.prepare("UPDATE assets SET duration_ms=? WHERE id=?").run(150 * minute, on.id);
  const after = await steadyNow();
  assert.equal(after.programs[0].id, on.id, 'the same program is still on');
  assert.equal(after.programs[0].start, on.start, 'from the same start');
  assert.equal(after.programs[0].end, on.start + 150 * minute, 'its slot ends when its file does');
  assert.equal(after.programs[1].id, before.programs[1].id, 'the same program follows it');
  assert.equal(after.programs[1].start, on.start + 150 * minute, 'just later');

  // Asking about another time doesn't move where the channel stands.
  await guide(`start=${GUIDE_EPOCH}&hours=1&channel=${encodeURIComponent(steadyKey)}`);
  assert.deepEqual(anchorOf('user-local'), { asset_id: on.id, start_ms: on.start });

  // The program on now can't play any more: the one after it in the lineup takes over its slot.
  db.prepare("UPDATE assets SET file_path=NULL WHERE id=?").run(on.id);
  const gone = await steadyNow();
  assert.equal(gone.programs[0].id, before.programs[1].id);
  assert.equal(gone.programs[0].start, on.start);
  db.prepare("UPDATE assets SET file_path=? WHERE id=?").run(`/media/${on.id}.mp4`, on.id);
});

// Runs last: a second profile means requests would need to choose one.
test('each profile keeps its own place in a channel, and the warmer works as the profile that tuned in', async () => {
  const { profileContext } = await import('@kiwi/database');
  const { createGuideWarmer } = await import('../src/guide-warm.js');
  db.prepare("INSERT INTO users (id, display_name, created_at) VALUES ('guide-kid', 'Kid', ?)").run(new Date().toISOString());
  const kid = { id: 'guide-kid', role: 'member', maxRating: 1, allowUnrated: true };
  const mature = anchorOf('user-local').asset_id;
  db.prepare("UPDATE assets SET content_rating=4 WHERE id=?").run(mature);
  const warmer = createGuideWarmer({ prepare: async () => {} });
  profileContext.run(kid, () => warmer.tune(steadyKey));
  await warmer.run();
  const kidAnchor = anchorOf('guide-kid');
  assert.ok(kidAnchor, "the warmer ran as the kid and placed the kid's channel");
  assert.notEqual(kidAnchor.asset_id, mature, 'with only what the kid may watch');
  assert.equal(anchorOf('user-local').asset_id, mature, "and left the owner's channel where it was");
  db.prepare("UPDATE assets SET content_rating=NULL WHERE id=?").run(mature);
});
