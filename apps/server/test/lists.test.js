import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-lists-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db, migrate } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

const now = new Date().toISOString();
const cookieOf = response => response.headers['set-cookie']?.split(';')[0];
const as = cookie => (method, url, payload) => app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
const addTitle = (id, type, title, extra = {}) => {
  db.prepare('INSERT INTO titles(id,type,title,year,rating,is_anime,certification,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, type, title, extra.year ?? 2020, extra.rating ?? 7, extra.anime ? 1 : 0, extra.certification ?? 'PG', now, now);
  if (type === 'movie') db.prepare('INSERT INTO assets(id,kind,title,title_id,duration_ms,added_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(`${id}-movie`, 'video', title, id, 6e6, now, now);
};
addTitle('movie-a', 'movie', 'Alpha Movie', { year: 2001, rating: 8 });
addTitle('show-b', 'show', 'Beta Show', { year: 2010, rating: 6 });
addTitle('anime-c', 'show', 'Gamma Anime', { anime: true, rating: 9 });
addTitle('movie-r', 'movie', 'Rated R', { certification: 'R' });
db.prepare("INSERT INTO assets(id,kind,title,title_id,season_number,episode_number,duration_ms,added_at,updated_at) VALUES ('show-b-s01e01','video','Pilot','show-b',1,1,1000,?,?)").run(now, now);
db.prepare("INSERT INTO assets(id,kind,title,file_path,duration_ms,content_rating,added_at,updated_at) VALUES ('home-1','video','Birthday','/media/home/1.mp4',1000,1,?,?)").run(now, now);

const owner = as(null);
const watchlist = 'watchlist-user-local';
let kid, kidId;

test('every profile has a Watch List, and the quick buttons use it', async () => {
  const { lists } = (await owner('GET', '/api/v1/lists')).json();
  assert.deepEqual(lists.map(list => [list.id, list.name, list.system]), [[watchlist, 'Watch List', 'watchlist']]);
  assert.equal((await owner('PUT', '/api/v1/titles/movie-a/library', { inLibrary: true })).json().inLibrary, true);
  assert.equal((await owner('POST', '/api/v1/assets/home-1/save')).json().saved, true);
  // Saving an episode lists its series.
  assert.equal((await owner('POST', '/api/v1/assets/show-b-s01e01/save')).json().saved, true);
  const items = (await owner('GET', `/api/v1/lists/${watchlist}/items`)).json();
  assert.equal(items.total, 3);
  assert.deepEqual(items.items.map(item => item.kind === 'title' ? item.title.id : item.asset.id).sort(), ['home-1', 'movie-a', 'show-b']);
  assert.equal((await owner('GET', '/api/v1/assets/home-1')).json().saved, true);
  assert.equal(db.prepare("SELECT in_library FROM titles WHERE id='show-b'").get().in_library, 1);
});

test('custom lists: create, rename, add, filter, sort, remove, delete', async () => {
  assert.equal((await owner('POST', '/api/v1/lists', { name: '  ' })).statusCode, 400);
  const created = await owner('POST', '/api/v1/lists', { name: 'Weekend' });
  assert.equal(created.statusCode, 201);
  const id = created.json().list.id;
  assert.equal((await owner('POST', '/api/v1/lists', { name: 'weekend' })).statusCode, 409);
  assert.equal((await owner('PATCH', `/api/v1/lists/${id}`, { name: 'Weekend picks' })).json().list.name, 'Weekend picks');
  assert.equal((await owner('PATCH', `/api/v1/lists/${watchlist}`, { name: 'Nope' })).statusCode, 409);
  assert.equal((await owner('DELETE', `/api/v1/lists/${watchlist}`)).statusCode, 409);

  const added = await owner('POST', `/api/v1/lists/${id}/items`, { items: [{ titleId: 'movie-a' }, { titleId: 'anime-c' }, { assetId: 'home-1' }, { titleId: 'show-b' }] });
  assert.equal(added.json().added, 4);
  assert.equal((await owner('POST', `/api/v1/lists/${id}/items`, { titleId: 'movie-a' })).json().added, 0, 'adding twice is a no-op');
  assert.equal(added.json().list.counts.anime, 1);
  const ids = async query => (await owner('GET', `/api/v1/lists/${id}/items?${query}`)).json().items.map(item => item.title?.id || item.asset?.id);
  assert.deepEqual(await ids('kind=movies'), ['movie-a']);
  assert.deepEqual(await ids('kind=anime'), ['anime-c']);
  assert.deepEqual(await ids('kind=videos'), ['home-1']);
  assert.deepEqual(await ids('sort=title'), ['movie-a', 'show-b', 'home-1', 'anime-c']);
  assert.deepEqual((await ids('sort=rating')).slice(0, 2), ['anime-c', 'movie-a']);
  assert.equal((await owner('GET', `/api/v1/lists/${id}/items?sort=nope`)).statusCode, 400);

  const probe = (await owner('GET', '/api/v1/lists?titleId=anime-c')).json().lists;
  assert.deepEqual(probe.map(list => list.contains), [false, true]);

  const removed = await owner('POST', `/api/v1/lists/${id}/items/remove`, { items: [{ titleId: 'anime-c' }, { assetId: 'home-1' }] });
  assert.equal(removed.json().removed, 2);
  assert.equal(db.prepare("SELECT in_library FROM titles WHERE id='anime-c'").get().in_library, 0, 'off every list, it leaves the household library');
  assert.deepEqual(await ids(''), ['show-b', 'movie-a']);
  assert.equal((await owner('DELETE', `/api/v1/lists/${id}`)).statusCode, 200);
  assert.equal(db.prepare("SELECT count(*) n FROM list_items WHERE list_id=?").get(id).n, 0);
  assert.equal(db.prepare("SELECT in_library FROM titles WHERE id='movie-a'").get().in_library, 1, 'still on the Watch List');
});

test('removing with the quick toggle takes a title off all of your lists', async () => {
  const id = (await owner('POST', '/api/v1/lists', { name: 'Favorites' })).json().list.id;
  await owner('POST', `/api/v1/lists/${id}/items`, { titleId: 'movie-a' });
  assert.equal((await owner('PUT', '/api/v1/titles/movie-a/library', { inLibrary: false })).json().inLibrary, false);
  assert.equal(db.prepare("SELECT count(*) n FROM list_items WHERE title_id='movie-a'").get().n, 0);
  assert.equal((await owner('PUT', '/api/v1/titles/movie-a/library', { inLibrary: true })).statusCode, 200);
  assert.equal(db.prepare("SELECT list_id FROM list_items WHERE title_id='movie-a'").get().list_id, watchlist);
});

test('lists are private to a profile and respect its rating', async () => {
  assert.equal((await owner('PUT', '/api/v1/profiles/user-local/pin', { pin: '1357' })).statusCode, 200);
  const ownerCookie = cookieOf(await owner('POST', '/api/v1/profiles/user-local/select', { pin: '1357' }));
  const signedOwner = as(ownerCookie);
  kidId = (await signedOwner('POST', '/api/v1/profiles', { name: 'Kid', maxRating: 'older_kids' })).json().profile.id;
  kid = as(cookieOf(await owner('POST', `/api/v1/profiles/${kidId}/select`)));
  const { lists } = (await kid('GET', '/api/v1/lists')).json();
  assert.deepEqual(lists.map(list => list.id), [`watchlist-${kidId}`], 'new profiles get their own Watch List');
  assert.equal(lists[0].itemCount, 0);
  assert.equal((await kid('GET', `/api/v1/lists/${watchlist}/items`)).statusCode, 404, "someone else's list");
  assert.equal((await kid('POST', `/api/v1/lists/${watchlist}/items`, { titleId: 'movie-a' })).statusCode, 404);
  assert.equal((await kid('POST', `/api/v1/lists/watchlist-${kidId}/items`, { titleId: 'movie-r' })).statusCode, 404, 'hidden titles cannot be listed');
  // Something listed, then hidden by a rating change, drops out of the list's contents.
  await signedOwner('POST', `/api/v1/lists/${watchlist}/items`, { titleId: 'movie-r' });
  assert.ok((await signedOwner('GET', `/api/v1/lists/${watchlist}/items`)).json().items.some(item => item.title?.id === 'movie-r'));
  await kid('POST', `/api/v1/lists/watchlist-${kidId}/items`, { titleId: 'movie-a' });
  await signedOwner('PUT', '/api/v1/titles/movie-a/rating', { rating: 'mature' });
  assert.equal((await kid('GET', `/api/v1/lists/watchlist-${kidId}/items`)).json().total, 0);
  await signedOwner('PUT', '/api/v1/titles/movie-a/rating', { rating: null });
  assert.equal((await kid('GET', `/api/v1/lists/watchlist-${kidId}/items`)).json().total, 1);
});

test('the old My list and saved videos move into the Watch List', () => {
  db.exec(`CREATE TABLE title_lists (user_id TEXT, title_id TEXT, added_at TEXT);
    CREATE TABLE saved_assets (user_id TEXT, asset_id TEXT, saved_at TEXT);
    INSERT INTO title_lists VALUES ('user-local','anime-c','2025-01-01');
    INSERT INTO saved_assets VALUES ('user-local','home-1','2025-01-02'), ('${kidId}','show-b-s01e01','2025-01-03');
    DELETE FROM app_state WHERE key='lists-v1';`);
  migrate();
  const has = (list, column, id) => Boolean(db.prepare(`SELECT 1 FROM list_items WHERE list_id=? AND ${column}=?`).get(list, id));
  assert.ok(has(watchlist, 'title_id', 'anime-c'));
  assert.ok(has(watchlist, 'asset_id', 'home-1'));
  assert.ok(has(`watchlist-${kidId}`, 'title_id', 'show-b'), 'a saved episode becomes its series');
  assert.equal(db.prepare("SELECT in_library FROM titles WHERE id='anime-c'").get().in_library, 1);
  for (const table of ['title_lists', 'saved_assets']) assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name=?").get(table).n, 0);
});
