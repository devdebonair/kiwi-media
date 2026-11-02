import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-channel-rules-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
const { GUIDE_EPOCH } = await import('../src/guide.js');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

const now = new Date().toISOString();
const minute = 60_000;
const cookieOf = response => response.headers['set-cookie']?.split(';')[0];
const as = cookie => (method, url, payload) => app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
const home = (id, path, { rating = null, captured = null } = {}) => db.prepare('INSERT INTO assets(id,kind,title,file_path,duration_ms,content_rating,captured_at,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(id, 'video', `Home ${id}`, path, 10 * minute, rating, captured, now, now);

// Home videos in two folders.
db.prepare("INSERT INTO library_roots(id,name,absolute_path,created_at) VALUES ('root-kids','Kids','/media/kids',?),('root-other','Other','/media/other',?)").run(now, now);
home('k1', '/media/kids/k1.mp4', { captured: '1995-06-01' });
home('k2', '/media/kids/k2.mp4', { captured: '2005-06-01' });
home('k3', '/media/kids/sub/k3.mp4', { rating: 1, captured: '2015-06-01' });
home('o1', '/media/other/o1.mp4');
home('o2', '/media/other/o2.mp4', { rating: 5 });
// A show and a movie from the catalog that nobody has listed.
const title = (id, type, name, year, certification) => db.prepare("INSERT INTO titles(id,type,title,year,certification,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, type, name, year, certification, now, now);
title('show-a', 'show', 'Alpha Show', 1990, 'TV-G');
title('movie-b', 'movie', 'Beta Movie', 2001, 'PG');
const episode = (season, number, aired) => db.prepare("INSERT INTO assets(id,kind,title,title_id,season_number,episode_number,air_date,duration_ms,availability,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run(`show-a-s${season}e${number}`, 'video', `Episode ${season}.${number}`, 'show-a', season, number, aired, 20 * minute, 'unknown', now, now);
for (const [season, number, aired] of [[1, 1, '1990-01-01'], [1, 2, '1990-01-08'], [1, 3, '1990-01-15'], [2, 1, '1991-01-01'], [2, 2, '1991-01-08']]) episode(season, number, aired);
db.prepare("INSERT INTO assets(id,kind,title,title_id,air_date,duration_ms,availability,added_at,updated_at) VALUES ('movie-b-movie','video','Beta Movie','movie-b','2001-05-01',90*60000,'unknown',?,?)").run(now, now);

const inLibrary = id => db.prepare('SELECT in_library FROM titles WHERE id=?').get(id).in_library;
const airing = async (call, channel, hours = 12) => {
  const rows = (await call('GET', `/api/v1/guide?start=${GUIDE_EPOCH}&hours=${hours}&channel=${encodeURIComponent(channel.key)}`)).json();
  return rows.channels[0]?.programs.map(program => program.id) || [];
};
const aired = async (call, channel) => new Set(await airing(call, channel));

let owner, member, memberId;
test('setup: an admin with a PIN and a teen member', async () => {
  await as(null)('PUT', '/api/v1/profiles/user-local/pin', { pin: '1357' });
  owner = as(cookieOf(await as(null)('POST', '/api/v1/profiles/user-local/select', { pin: '1357' })));
  memberId = (await owner('POST', '/api/v1/profiles', { name: 'Teen', maxRating: 'teens', allowUnrated: true })).json().profile.id;
  member = as(cookieOf(await as(null)('POST', `/api/v1/profiles/${memberId}/select`)));
});

test('a show or movie picked for a channel airs without being on anyone\'s list, and leaves the library with it', async () => {
  assert.equal(inLibrary('show-a'), 0);
  const preview = (await owner('POST', '/api/v1/guide/preview', { rules: { titleIds: ['show-a', 'movie-b'] } })).json();
  assert.equal(preview.item_count, 6, 'the preview counts picked titles before they are saved');
  assert.ok(preview.upcoming.length > 0 && preview.upcoming.every(program => program.title && program.start < program.end));

  const channel = (await owner('POST', '/api/v1/guide/channels', { name: 'Alpha and Beta', rules: { titleIds: ['show-a', 'movie-b'] } })).json();
  assert.deepEqual(channel.sources.titles.map(item => item.title), ['Alpha Show', 'Beta Movie']);
  assert.equal(channel.item_count, 6);
  assert.equal(inLibrary('show-a'), 1);
  assert.equal(inLibrary('movie-b'), 1);
  assert.deepEqual((await owner('GET', '/api/v1/titles?type=show')).json(), [], "it isn't put on a list");

  // Editing it to drop the movie takes the movie out of the library; deleting it takes the show out too.
  await owner('PUT', `/api/v1/guide/channels/${channel.id}`, { name: 'Alpha', rules: { titleIds: ['show-a'] } });
  assert.equal(inLibrary('movie-b'), 0);
  assert.equal(inLibrary('show-a'), 1);
  assert.equal((await owner('DELETE', `/api/v1/guide/channels/${channel.id}`)).statusCode, 204);
  assert.equal(inLibrary('show-a'), 0);
});

test('lists and folders are sources; filters narrow what they add', async () => {
  const { list } = (await owner('POST', '/api/v1/lists', { name: 'Saturday' })).json();
  await owner('POST', `/api/v1/lists/${list.id}/items`, { items: [{ titleId: 'movie-b' }, { assetId: 'o1' }] });
  const fromList = (await owner('POST', '/api/v1/guide/channels', { name: 'Saturday', rules: { listIds: [list.id] } })).json();
  assert.deepEqual(fromList.sources.lists.map(item => item.name), ['Saturday']);
  assert.deepEqual(await aired(owner, fromList), new Set(['movie-b-movie', 'o1']));

  // A folder includes its subfolders.
  const kids = (await owner('POST', '/api/v1/guide/channels', { name: 'Kids folder', rules: { rootIds: ['root-kids'] } })).json();
  assert.deepEqual(await aired(owner, kids), new Set(['k1', 'k2', 'k3']));

  const count = async rules => (await owner('POST', '/api/v1/guide/preview', { rules })).json().item_count;
  const everything = { rootIds: ['root-kids', 'root-other'], titleIds: ['show-a', 'movie-b'] };
  assert.equal(await count(everything), 11);
  assert.equal(await count({ ...everything, types: ['home'] }), 5);
  assert.equal(await count({ ...everything, types: ['movies', 'shows'] }), 6);
  // The channel's own rating limit: up to Kids, with or without unrated videos.
  assert.equal(await count({ ...everything, maxRating: 'kids', allowUnrated: false }), 6, 'k3 plus the TV-G show');
  assert.equal(await count({ ...everything, maxRating: 'teens' }), 10, 'everything but the NSFW video');
  // Years: the episode's air date, the movie's release, the home video's recording date. Unknown years are left out.
  assert.equal(await count({ ...everything, yearFrom: 1990, yearTo: 1999 }), 6, 'five episodes and k1');
  assert.equal(await count({ ...everything, yearFrom: 2000 }), 3, 'k2, k3, and the movie');
  // Tags to leave out.
  await owner('POST', '/api/v1/assets/k2/topics', { name: 'Skip me' });
  const skip = (await owner('GET', '/api/v1/topics')).json().find(topic => topic.name === 'Skip me');
  assert.equal(await count({ rootIds: ['root-kids'], excludeTopicIds: [skip.id] }), 2);
  // Sources add up: a tag or a folder.
  assert.equal(await count({ topicIds: [skip.id], titleIds: ['movie-b'] }), 2);

  // Only your own lists can be added; a list already on a household channel stays when another admin edits it.
  assert.equal((await member('POST', '/api/v1/guide/channels', { name: 'Not mine', rules: { listIds: [list.id] } })).statusCode, 404);
  // Folders are an admin's to pick.
  assert.equal((await member('POST', '/api/v1/guide/channels', { name: 'Folder', rules: { rootIds: ['root-kids'] } })).statusCode, 403);
  for (const channel of [fromList, kids]) await owner('DELETE', `/api/v1/guide/channels/${channel.id}`);
});

test('lineups can be shuffled, in order, or newest first, with episodes in blocks or whole seasons', async () => {
  const make = async (order, episodeBlock) => (await owner('POST', '/api/v1/guide/channels', { name: `${order} ${episodeBlock}`, rules: { titleIds: ['show-a'] }, order, episodeBlock })).json();
  const ids = async channel => (await airing(owner, channel, 2)).slice(0, 5).map(id => id.replace('show-a-', ''));
  const inOrder = await make('in_order', 1);
  assert.equal(inOrder.order, 'in_order');
  assert.deepEqual(await ids(inOrder), ['s1e1', 's1e2', 's1e3', 's2e1', 's2e2']);
  const newest = await make('newest', 1);
  assert.deepEqual(await ids(newest), ['s2e2', 's2e1', 's1e3', 's1e2', 's1e1']);
  const seasons = await make('newest', 0);
  assert.deepEqual(await ids(seasons), ['s2e1', 's2e2', 's1e1', 's1e2', 's1e3'], 'a whole season airs together, in episode order');
  // Shuffled blocks still keep each block's episodes in order (blocks run on across a season's end).
  // (Three hours is almost two loops of the 100-minute lineup, so every block appears whole at least once.)
  const shuffled = (await airing(owner, await make('shuffle', 2), 3)).map(id => id.replace('show-a-', ''));
  for (const block of [['s1e1', 's1e2'], ['s1e3', 's2e1']]) assert.equal(shuffled[shuffled.indexOf(block[0]) + 1], block[1]);
  for (const channel of (await owner('GET', '/api/v1/guide/channels')).json()) await owner('DELETE', `/api/v1/guide/channels/${channel.id}`);
});

test('channels belong to the household or to one profile', async () => {
  const household = (await owner('POST', '/api/v1/guide/channels', { name: 'Family', rules: { rootIds: ['root-kids'] } })).json();
  const ownPersonal = (await owner('POST', '/api/v1/guide/channels', { name: 'Mine only', scope: 'personal', rules: { titleIds: ['movie-b'] } })).json();
  assert.equal(ownPersonal.scope, 'personal');
  assert.equal(household.editable, true);

  // A member's channels are always personal; they can't make, change, or delete household channels.
  assert.equal((await member('POST', '/api/v1/guide/channels', { name: 'Everyone', scope: 'household', rules: { titleIds: ['show-a'] } })).statusCode, 403);
  const theirs = await member('POST', '/api/v1/guide/channels', { name: 'Teen picks', rules: { titleIds: ['show-a'] } });
  assert.equal(theirs.statusCode, 201);
  const teen = theirs.json();
  assert.equal(teen.scope, 'personal');
  assert.notEqual(teen.number, household.number);
  assert.equal((await member('PUT', `/api/v1/guide/channels/${household.id}`, { name: 'Mine now', rules: { rootIds: ['root-kids'] } })).statusCode, 403);
  assert.equal((await member('DELETE', `/api/v1/guide/channels/${household.id}`)).statusCode, 403);

  const names = async call => (await call('GET', '/api/v1/guide/channels')).json().map(channel => channel.name).sort();
  assert.deepEqual(await names(owner), ['Family', 'Mine only']);
  assert.deepEqual(await names(member), ['Family', 'Teen picks']);
  const memberView = (await member('GET', '/api/v1/guide/channels')).json().find(channel => channel.id === household.id);
  assert.equal(memberView.editable, false);
  // Someone else's personal channel doesn't exist for you, even for an admin.
  for (const [call, id] of [[owner, teen.id], [member, ownPersonal.id]]) {
    assert.equal((await call('PUT', `/api/v1/guide/channels/${id}`, { name: 'x', rules: { titleIds: ['show-a'] } })).statusCode, 404);
    assert.equal((await call('POST', '/api/v1/guide/tune', { channel: `custom:${id}` })).statusCode, 404);
  }
  // The member's channel keeps its show in the household library; deleting the profile deletes the channel.
  assert.equal(inLibrary('show-a'), 1);
  assert.equal((await owner('DELETE', `/api/v1/profiles/${memberId}`)).statusCode, 200);
  assert.equal(db.prepare('SELECT count(*) count FROM guide_channels WHERE owner_id=?').get(memberId).count, 0);
  assert.equal(inLibrary('show-a'), 0);
  assert.deepEqual(await names(owner), ['Family', 'Mine only']);
});

test("a household channel with nothing a restricted profile may watch doesn't exist for it", async () => {
  const kidId = (await owner('POST', '/api/v1/profiles', { name: 'Kid', maxRating: 'kids', allowUnrated: false })).json().profile.id;
  const kid = as(cookieOf(await as(null)('POST', `/api/v1/profiles/${kidId}/select`)));
  const adult = (await owner('POST', '/api/v1/guide/channels', { name: 'Late night', rules: { rootIds: ['root-other'] } })).json();
  const visible = async () => (await kid('GET', '/api/v1/guide/channels')).json().map(channel => channel.name);
  assert.ok(!(await visible()).includes('Late night'));
  assert.ok((await visible()).includes('Family'), 'k3 is rated Kids');
  assert.deepEqual(await aired(kid, (await kid('GET', '/api/v1/guide/channels')).json().find(channel => channel.name === 'Family')), new Set(['k3']));
  assert.equal((await kid('POST', '/api/v1/guide/tune', { channel: adult.key })).statusCode, 404);
  // Its own channels show even while empty, so it can fix them.
  // It can't build a channel from a title it can't see.
  assert.equal((await kid('POST', '/api/v1/guide/channels', { name: 'PG', rules: { titleIds: ['movie-b'] } })).statusCode, 404);
  const own = await kid('POST', '/api/v1/guide/channels', { name: 'Empty for now', rules: { listIds: [`watchlist-${kidId}`] } });
  assert.equal(own.statusCode, 201);
  assert.equal(own.json().item_count, 0);
  assert.ok((await visible()).includes('Empty for now'));
});
