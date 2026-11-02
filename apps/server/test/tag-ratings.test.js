import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-tag-ratings-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db, rebuildSearch } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

const now = new Date().toISOString();
const cookieOf = response => response.headers['set-cookie']?.split(';')[0];
const as = cookie => (method, url, payload) => app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
const video = (id, title, rating = null) => db.prepare('INSERT INTO assets(id,kind,title,file_path,duration_ms,content_rating,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, 'video', title, `/media/${id}.mp4`, 600000, rating, now, now);
const topic = (id, name, rating = null) => db.prepare('INSERT INTO topics(id,slug,name,topic_type,content_rating,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, id, name, 'topic', rating, now, now);
const tag = (assetId, topicId) => {
  const annotation = `ann-${assetId}-${topicId}`;
  db.prepare("INSERT INTO annotations(id,asset_id,motivation,created_at,updated_at) VALUES (?,?,'tagging',?,?)").run(annotation, assetId, now, now);
  db.prepare("INSERT INTO annotation_topics(annotation_id,topic_id,role) VALUES (?,?,'subject')").run(annotation, topicId);
};

// An unrated folder holds a family video and a video tagged with an adult performer (rated NSFW).
video('family-video', 'Zebrafinch picnic', 1);
video('performer-video', 'Zebrafinch scene');
topic('performer', 'Velvet Performer', 5);
topic('family', 'Family');
topic('explicit-word', 'Zebrafinch Explicit');
tag('family-video', 'family');
tag('performer-video', 'performer');
tag('performer-video', 'explicit-word');
db.prepare("INSERT INTO titles(id,type,title,certification,created_at,updated_at) VALUES ('title-pg','movie','Kids Movie','G',?,?)").run(now, now);
db.prepare("INSERT INTO assets(id,kind,title,title_id,duration_ms,added_at,updated_at) VALUES ('title-pg-movie','video','Kids Movie','title-pg',6e6,?,?)").run(now, now);
// A clip on the family video carries an explicit tag of its own.
db.prepare("INSERT INTO annotations(id,asset_id,motivation,note_markdown,created_at,updated_at) VALUES ('clip-bad','family-video','clipping','Oops',?,?)").run(now, now);
db.prepare("INSERT INTO annotation_selectors(id,annotation_id,selector_type,start_ms,end_ms) VALUES ('sel-bad','clip-bad','time-range',0,5000)").run();
db.prepare("INSERT INTO annotation_topics(annotation_id,topic_id,role) VALUES ('clip-bad','performer','subject')").run();
db.prepare("INSERT INTO feeds(id,owner_id,slug,name,query_json,created_at,updated_at) VALUES ('feed-performer','user-local','performer-feed','Velvet Performer','{\"topicIds\":[\"performer\"]}',?,?)").run(now, now);
db.prepare("INSERT INTO guide_channels(id,number,name,rules_json,created_at,updated_at) VALUES ('ch-performer',7,'Velvet channel',?,?,?)").run(JSON.stringify({ topicIds: ['performer'] }), now, now);
rebuildSearch();

let owner, kid;
test('setup: an admin with a PIN and a kids profile', async () => {
  await as(null)('PUT', '/api/v1/profiles/user-local/pin', { pin: '2468' });
  owner = as(cookieOf(await as(null)('POST', '/api/v1/profiles/user-local/select', { pin: '2468' })));
  const kidId = (await owner('POST', '/api/v1/profiles', { name: 'Kid', maxRating: 'kids', allowUnrated: true })).json().profile.id;
  kid = as(cookieOf(await as(null)('POST', `/api/v1/profiles/${kidId}/select`)));
});

test('a rated tag is a minimum for everything carrying it, even in an unrated folder', async () => {
  assert.equal((await owner('GET', '/api/v1/assets/performer-video')).json().effective_rating, 'nsfw');
  assert.equal((await kid('GET', '/api/v1/assets/performer-video')).statusCode, 404);
  const ids = (await kid('GET', '/api/v1/assets?limit=200')).json().map(asset => asset.id);
  assert.ok(ids.includes('family-video') && !ids.includes('performer-video'));
  // On a movie, too.
  await owner('POST', '/api/v1/titles/title-pg/topics', { topicId: 'performer' });
  assert.equal((await kid('GET', '/api/v1/titles/title-pg')).statusCode, 404);
  await owner('DELETE', '/api/v1/titles/title-pg/topics/performer');
  assert.equal((await kid('GET', '/api/v1/titles/title-pg')).statusCode, 200);
});

test('hidden tags are hidden everywhere a tag shows up', async () => {
  const kidTopics = (await kid('GET', '/api/v1/topics')).json().map(topic => topic.id);
  assert.ok(kidTopics.includes('family') && !kidTopics.includes('performer') && !kidTopics.includes('explicit-word'));
  for (const url of ['/api/v1/topics/performer', '/api/v1/topics/explicit-word', '/api/v1/topics/performer/metadata', '/api/v1/feeds/performer-feed', '/api/v1/clips/clip-bad'])
    assert.ok([403, 404].includes((await kid('GET', url)).statusCode), url);
  assert.equal((await kid('POST', '/api/v1/topics/performer/follow')).statusCode, 404);
  assert.equal((await owner('GET', '/api/v1/topics/performer')).statusCode, 200);
  // An unrated tag used only on hidden content is hidden; it shows up once it tags something the profile can see.
  assert.equal((await kid('GET', '/api/v1/topics/explicit-word')).statusCode, 404);

  const search = (await kid('GET', '/api/v1/search?q=zebrafinch')).json();
  assert.deepEqual(search.map(hit => hit.id), ['family-video']);
  assert.equal((await kid('GET', '/api/v1/search?q=velvet')).json().length, 0);
  assert.ok(!(await kid('GET', '/api/v1/feeds')).json().some(feed => feed.id === 'feed-performer'));
  const channels = (await kid('GET', '/api/v1/guide/channels')).json();
  assert.ok(!JSON.stringify(channels).includes('Velvet'));
  assert.ok(JSON.stringify((await owner('GET', '/api/v1/guide/channels')).json()).includes('Velvet channel'));
  // The guide's own lists and its tune request: a hidden channel doesn't exist for the profile.
  const guide = (await kid('GET', '/api/v1/guide?limit=100')).json();
  assert.ok(!guide.channels.some(channel => /Velvet/.test(channel.name)));
  assert.ok(!guide.channels.some(channel => channel.programs.some(program => program.id === 'performer-video')));
  assert.equal((await kid('GET', '/api/v1/guide?channel=custom:ch-performer')).json().total, 0);
  assert.equal((await kid('POST', '/api/v1/guide/tune', { channel: 'custom:ch-performer' })).statusCode, 404);
  assert.equal((await owner('POST', '/api/v1/guide/tune', { channel: 'custom:ch-performer' })).statusCode, 204);
});

test("a clip with a tag above the profile's limit is hidden, on a video it can watch", async () => {
  const family = (await kid('GET', '/api/v1/assets/family-video')).json();
  assert.deepEqual(family.moments, []);
  assert.deepEqual(family.topics.map(topic => topic.id), ['family']);
  assert.deepEqual((await kid('GET', '/api/v1/assets/family-video/clips')).json(), []);
  assert.deepEqual((await kid('GET', '/api/v1/assets/family-video/annotations')).json().filter(row => row.motivation === 'clipping'), []);
  assert.ok(!(await kid('GET', '/api/v1/clips')).json().some(clip => clip.id === 'clip-bad'), JSON.stringify((await kid('GET', '/api/v1/clips')).json().map(c => [c.id, c.asset.title])));
  assert.equal((await owner('GET', '/api/v1/assets/family-video/clips')).json().length, 1);
});

test("a profile can't apply a tag it can't see, by id or by name", async () => {
  assert.equal((await kid('POST', '/api/v1/assets/family-video/topics', { topicId: 'performer' })).statusCode, 404);
  assert.equal((await kid('POST', '/api/v1/assets/family-video/topics', { name: 'velvet performer' })).statusCode, 400);
  assert.equal((await kid('GET', '/api/v1/assets/family-video')).statusCode, 200, 'still visible');
  // Ordinary tagging still works.
  assert.equal((await kid('POST', '/api/v1/assets/family-video/topics', { name: 'Picnics' })).statusCode, 200);
});

test('rating tags and their metadata are admin-only', async () => {
  assert.equal((await kid('PUT', '/api/v1/topics/family/rating', { rating: 'nsfw' })).statusCode, 403);
  assert.equal((await kid('GET', '/api/v1/metadata/providers')).statusCode, 403);
  const rated = await owner('PUT', '/api/v1/topics/explicit-word/rating', { rating: 'nsfw' });
  assert.equal(rated.json().content_rating, 'nsfw');
  assert.equal((await owner('GET', '/api/v1/topics/explicit-word')).json().content_rating, 'nsfw');
  // Rating the family tag NSFW would hide every family video: the minimum applies to all of them.
  await owner('PUT', '/api/v1/topics/family/rating', { rating: 'nsfw' });
  assert.equal((await kid('GET', '/api/v1/assets/family-video')).statusCode, 404);
  await owner('PUT', '/api/v1/topics/family/rating', { rating: null });
  assert.equal((await kid('GET', '/api/v1/assets/family-video')).statusCode, 200);
});
