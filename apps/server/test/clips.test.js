import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-clips-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

db.prepare("INSERT INTO assets (id,kind,title,file_path,duration_ms,added_at,updated_at) VALUES ('match','video','Cup final','/media/match.mp4',600000,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const patch = (url, payload) => app.inject({ method: 'PATCH', url, payload });
const get = async url => (await app.inject(url)).json();
const wholeVideoTags = id => db.prepare("SELECT t.name FROM effective_asset_topics et JOIN topics t ON t.id=et.topic_id WHERE et.asset_id=?").all(id).map(row => row.name);

test('a clip tags a time range, creating tags by name, and comes back with its tags', async () => {
  const response = await post('/api/v1/assets/match/clips', { startMs: 61_000, endMs: 75_500, title: 'Opening goal', topics: [{ name: 'Goals' }, { name: 'Header' }] });
  assert.equal(response.statusCode, 201, response.body);
  const clip = response.json();
  assert.equal(clip.startMs, 61_000);
  assert.equal(clip.endMs, 75_500);
  assert.equal(clip.title, 'Opening goal');
  assert.deepEqual(clip.topics.map(topic => topic.name), ['Goals', 'Header']);
  assert.deepEqual((await get('/api/v1/assets/match/clips')).map(item => item.id), [clip.id]);
});

test('clip tags stay on the clip: the video is not tagged and does not appear in the tag grid', async () => {
  assert.deepEqual(wholeVideoTags('match'), []);
  const goals = db.prepare("SELECT slug FROM topics WHERE name='Goals'").get();
  const page = await get(`/api/v1/topics/${goals.slug}`);
  assert.equal(page.assets.length, 0);
  assert.equal(page.item_count, 0);
  assert.equal(page.clips.length, 1);
  assert.equal(page.clips[0].asset.title, 'Cup final');
  // Tagging the whole video with the same tag still works and is independent of the clip.
  const whole = await post('/api/v1/assets/match/topics', { name: 'Goals' });
  assert.equal(whole.statusCode, 200);
  assert.deepEqual(wholeVideoTags('match'), ['Goals']);
});

test('the clips feed lists clips by tag, including tags implied by topic rules', async () => {
  const header = db.prepare("SELECT id FROM topics WHERE name='Header'").get();
  await post(`/api/v1/topics/${header.id}/topics`, { name: 'Football' });
  const football = await get('/api/v1/clips?topic=' + db.prepare("SELECT slug FROM topics WHERE name='Football'").get().slug);
  assert.equal(football.length, 1);
  assert.equal(football[0].asset.id, 'match');
  assert.equal((await get('/api/v1/clips?topic=nothing-here')).length, 0);
});

test('a clip can be retimed, renamed, and retagged, and the range is validated', async () => {
  const [clip] = await get('/api/v1/assets/match/clips');
  const updated = await patch(`/api/v1/clips/${clip.id}`, { startMs: 60_000, endMs: 80_000, title: 'Goal + celebration', topics: [{ topicId: clip.topics[0].id }, { name: 'Celebration' }] });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual([updated.json().startMs, updated.json().endMs, updated.json().title], [60_000, 80_000, 'Goal + celebration']);
  assert.deepEqual(updated.json().topics.map(topic => topic.name), ['Celebration', 'Goals']);
  for (const bad of [{ startMs: 5000, endMs: 5100 }, { startMs: -1, endMs: 2000 }, { startMs: 1000, endMs: 900_000 }, { startMs: 1.5, endMs: 3000 }]) {
    assert.equal((await patch(`/api/v1/clips/${clip.id}`, bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await post('/api/v1/assets/match/clips', { startMs: 0, endMs: 2000, topics: Array.from({ length: 21 }, (_, index) => ({ name: `t${index}` })) })).statusCode, 400);
  assert.equal((await post('/api/v1/assets/missing/clips', { startMs: 0, endMs: 2000 })).statusCode, 404);
});

test('deleting a clip removes it but keeps its tags for everything else', async () => {
  const [clip] = await get('/api/v1/assets/match/clips');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/clips/${clip.id}` })).statusCode, 204);
  assert.deepEqual(await get('/api/v1/assets/match/clips'), []);
  assert.ok(db.prepare("SELECT 1 FROM topics WHERE name='Celebration'").get());
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/clips/${clip.id}` })).statusCode, 404);
});

test('older time-range annotations are treated as clips, and the watch page keeps its moment list', async () => {
  const seeded = db.prepare("SELECT motivation FROM annotations a JOIN annotation_selectors s ON s.annotation_id=a.id WHERE a.asset_id='asset-city'").get();
  assert.equal(seeded.motivation, 'clipping');
  const asset = await get('/api/v1/assets/asset-city');
  assert.equal(asset.moments.length, 1);
  assert.equal(asset.moments[0].start_ms, 45000);
});

test('clips are found by search through their name, their tags, rule-implied tags, and their video', async () => {
  const made = (await post('/api/v1/assets/match/clips', { startMs: 120_000, endMs: 135_000, title: 'Bicycle kick', topics: [{ name: 'Acrobatics' }] })).json();
  const search = async (q, kind = 'all') => (await get(`/api/v1/search?q=${encodeURIComponent(q)}&kind=${kind}`)).filter(item => item.entityType === 'clip').map(item => item.id);
  assert.deepEqual(await search('bicycle'), [made.id], 'by name, with prefix matching');
  assert.deepEqual(await search('acrobat'), [made.id], 'by its tag');
  assert.ok((await search('cup final')).includes(made.id), 'by the video it comes from');
  const acrobatics = db.prepare("SELECT id FROM topics WHERE name='Acrobatics'").get();
  await post(`/api/v1/topics/${acrobatics.id}/topics`, { name: 'Highlights' });
  assert.deepEqual(await search('highlights'), [made.id], 'by a tag implied by a topic rule');
  const [result] = (await get('/api/v1/search?q=bicycle&kind=clips'));
  assert.equal(result.entityType, 'clip');
  assert.equal(result.asset.title, 'Cup final');
  assert.equal(result.startMs, 120_000);
  assert.ok((await get('/api/v1/search?q=bicycle&kind=videos')).every(item => item.entityType !== 'clip'), 'other tabs leave clips out');
});

test('search follows clip edits and deletions', async () => {
  const [clip] = (await get('/api/v1/assets/match/clips')).filter(item => item.title === 'Bicycle kick');
  const search = async q => (await get(`/api/v1/search?q=${encodeURIComponent(q)}&kind=clips`)).map(item => item.id);
  await patch(`/api/v1/clips/${clip.id}`, { title: 'Overhead volley', topics: [{ name: 'Volleys' }] });
  assert.deepEqual(await search('bicycle'), []);
  assert.deepEqual(await search('overhead'), [clip.id]);
  assert.deepEqual(await search('volleys'), [clip.id]);
  await app.inject({ method: 'DELETE', url: `/api/v1/clips/${clip.id}` });
  assert.deepEqual(await search('overhead'), []);
});
