import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-profiles-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db, certificationLevel, rebuildSearch } = await import('@kiwi/database');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

const now = new Date().toISOString();
const cookieOf = response => response.headers['set-cookie']?.split(';')[0];
const as = cookie => options => app.inject({ ...(typeof options === 'string' ? { url: options } : options), headers: cookie ? { cookie } : {} });
const anonymous = as(null);

// A folder marked NSFW, a home video in it, a kids video outside it, and catalog titles with certifications.
db.prepare('INSERT INTO library_roots(id,name,absolute_path,created_at) VALUES (?,?,?,?)').run('adult-root', 'Adult', '/media/adult', now);
const addVideo = (id, title, path, root) => {
  db.prepare('INSERT INTO assets(id,kind,title,file_path,duration_ms,added_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, 'video', title, path, 600000, now, now);
  if (root) db.prepare('INSERT INTO files(id,asset_id,role,library_root_id,relative_path,created_at) VALUES (?,?,?,?,?,?)').run(`file-${id}`, id, 'original', root, path.split('/').at(-1), now);
};
addVideo('adult-video', 'Zebrafinch private', '/media/adult/one.mp4', 'adult-root');
addVideo('adult-nested', 'Zebrafinch nested', '/media/adult/deeper/two.mp4', null);
addVideo('kids-video', 'Zebrafinch cartoon', '/media/kids/cartoon.mp4', null);
const addTitle = (id, type, title, certification) => {
  db.prepare('INSERT INTO titles(id,type,title,certification,in_library,library_added_at,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)').run(id, type, title, certification, now, now, now);
  db.prepare('INSERT INTO assets(id,kind,title,title_id,duration_ms,added_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(`${id}-movie`, 'video', title, id, 6000000, now, now);
};
addTitle('title-r', 'movie', 'Grown-up movie', 'R');
addTitle('title-pg', 'movie', 'Family movie', 'PG');
addTitle('title-unrated', 'movie', 'Mystery movie', null);
rebuildSearch();

let ownerCookie, kidCookie, kidId;

test('certifications map onto the rating ladder', () => {
  assert.equal(certificationLevel('TV-Y'), 1);
  assert.equal(certificationLevel('pg'), 2);
  assert.equal(certificationLevel('TV-14'), 3);
  assert.equal(certificationLevel('NC-17'), 4);
  assert.equal(certificationLevel('NR'), null);
  assert.equal(certificationLevel(''), null);
});

test('a single profile without a PIN is used automatically', async () => {
  const session = await anonymous('/api/v1/session');
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().profile.id, 'user-local');
  assert.equal(session.json().profile.isAdmin, true);
  assert.equal((await anonymous('/api/v1/assets?limit=200')).statusCode, 200);
});

test('a second profile needs a PIN on the admin first', async () => {
  const blocked = await anonymous({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'Kid' } });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'admin_pin_required');
  assert.equal((await anonymous({ method: 'PUT', url: '/api/v1/profiles/user-local/pin', payload: { pin: '12a4' } })).statusCode, 400);
  const pinned = await anonymous({ method: 'PUT', url: '/api/v1/profiles/user-local/pin', payload: { pin: '1234' } });
  assert.equal(pinned.statusCode, 200);
  ownerCookie = cookieOf(pinned);
  assert.ok(ownerCookie, 'setting your own PIN keeps you signed in');
  // With a PIN, the owner is no longer chosen automatically.
  assert.equal((await anonymous('/api/v1/session')).statusCode, 401);
  const created = await as(ownerCookie)({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'Kid', maxRating: 'older_kids' } });
  assert.equal(created.statusCode, 201);
  kidId = created.json().profile.id;
  assert.equal(created.json().profile.maxRating, 'older_kids');
  assert.equal(created.json().profile.allowUnrated, false);
  // Admins can't drop their PIN while others exist.
  assert.equal((await as(ownerCookie)({ method: 'PUT', url: '/api/v1/profiles/user-local/pin', payload: { pin: null } })).statusCode, 409);
});

test('the picker lists profiles without their limits, and requests need a profile', async () => {
  const listed = (await anonymous('/api/v1/profiles')).json();
  assert.equal(listed.profiles.length, 2);
  assert.equal(listed.current, null);
  assert.ok(listed.profiles.every(profile => profile.maxRating === undefined));
  assert.equal(listed.profiles.find(profile => profile.id === 'user-local').locked, true);
  const denied = await anonymous('/api/v1/assets');
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json().code, 'profile_required');
  assert.equal((await anonymous('/api/v1/ratings')).statusCode, 200);
});

test('locked profiles need the right PIN, and stop accepting guesses after five', async () => {
  assert.equal((await anonymous({ method: 'POST', url: '/api/v1/profiles/user-local/select' })).statusCode, 403);
  assert.equal((await anonymous({ method: 'POST', url: '/api/v1/profiles/user-local/select', payload: { pin: '0000' } })).statusCode, 403);
  const chosen = await anonymous({ method: 'POST', url: '/api/v1/profiles/user-local/select', payload: { pin: '1234' } });
  assert.equal(chosen.statusCode, 200);
  ownerCookie = cookieOf(chosen);
  const kid = await anonymous({ method: 'POST', url: `/api/v1/profiles/${kidId}/select` });
  assert.equal(kid.statusCode, 200);
  kidCookie = cookieOf(kid);
  assert.equal((await as(kidCookie)('/api/v1/session')).json().profile.id, kidId);
  // A forged cookie is ignored.
  assert.equal((await as(`kiwi_profile=${encodeURIComponent(`user-local.0.${'x'.repeat(43)}`)}`)('/api/v1/session')).statusCode, 401);
  for (let i = 0; i < 5; i++) await anonymous({ method: 'POST', url: '/api/v1/profiles/user-local/select', payload: { pin: '9999' } });
  assert.equal((await anonymous({ method: 'POST', url: '/api/v1/profiles/user-local/select', payload: { pin: '1234' } })).statusCode, 429);
});

test('admin-only routes refuse members; tagging stays open', async () => {
  const kid = as(kidCookie);
  assert.equal((await as(ownerCookie)({ method: 'PUT', url: '/api/v1/assets/kids-video/rating', payload: { rating: 'kids' } })).statusCode, 200);
  for (const [method, url] of [['GET', '/api/v1/media/settings'], ['GET', '/api/v1/downloads'], ['GET', '/api/v1/library/roots'], ['POST', '/api/v1/library/scan'],
    ['PUT', '/api/v1/library/roots/adult-root/rating'], ['POST', '/api/v1/profiles'], ['GET', '/api/v1/jobs'], ['PUT', '/api/v1/titles/title-pg/rating']]) {
    const response = await kid({ method, url, payload: {} });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
  assert.equal((await kid({ method: 'POST', url: '/api/v1/assets/kids-video/topics', payload: { name: 'Cartoons' } })).statusCode, 200);
  // A member can lock their own profile, but not someone else's.
  assert.equal((await kid({ method: 'PUT', url: '/api/v1/profiles/user-local/pin', payload: { pin: '5555' } })).statusCode, 403);
});

test('an NSFW folder and certifications limit what a member sees everywhere', async () => {
  const owner = as(ownerCookie), kid = as(kidCookie);
  assert.equal((await owner({ method: 'PUT', url: '/api/v1/library/roots/adult-root/rating', payload: { rating: 'nsfw' } })).statusCode, 200);
  assert.equal((await owner({ method: 'PUT', url: '/api/v1/assets/kids-video/rating', payload: { rating: 'kids' } })).statusCode, 200);
  assert.equal((await owner({ method: 'PUT', url: '/api/v1/assets/kids-video/rating', payload: { rating: 'adults' } })).statusCode, 400);

  const ownerIds = (await owner('/api/v1/assets?limit=200')).json().map(asset => asset.id);
  for (const id of ['adult-video', 'adult-nested', 'kids-video']) assert.ok(ownerIds.includes(id), id);
  const ownerAdult = (await owner('/api/v1/assets/adult-nested')).json();
  assert.equal(ownerAdult.effective_rating, 'nsfw', 'the folder floor covers files found by path too');

  assert.deepEqual((await kid('/api/v1/assets?limit=200')).json().map(asset => asset.id), ['kids-video'], 'unrated seed media is hidden too');
  for (const url of ['/api/v1/assets/adult-video', '/api/v1/assets/adult-video/file', '/api/v1/assets/adult-video/clips', '/api/v1/titles/title-r', '/api/v1/titles/title-unrated'])
    assert.equal((await kid(url)).statusCode, 404, url);
  assert.equal((await kid('/api/v1/assets/kids-video')).statusCode, 200);
  assert.equal((await kid('/api/v1/titles/title-pg')).statusCode, 200);
  const list = (run, id, inLibrary = true) => run({ method: 'PUT', url: `/api/v1/titles/${id}/library`, payload: { inLibrary } });
  for (const id of ['title-r', 'title-pg', 'title-unrated']) assert.equal((await list(owner, id)).statusCode, 200);
  assert.equal((await list(kid, 'title-pg')).statusCode, 200);
  assert.equal((await list(kid, 'title-r')).statusCode, 404, 'a hidden title cannot be listed');
  assert.deepEqual((await kid('/api/v1/titles?type=movie')).json().map(title => title.id), ['title-pg']);
  assert.equal((await owner('/api/v1/titles?type=movie')).json().length, 3);

  const kidSearch = (await kid('/api/v1/search?q=zebrafinch')).json().map(hit => hit.id);
  assert.deepEqual(kidSearch, ['kids-video']);
  assert.equal((await owner('/api/v1/search?q=zebrafinch')).json().length, 3);
  assert.deepEqual((await kid('/api/v1/search?q=movie')).json().filter(hit => hit.entityType === 'title').map(hit => hit.id), ['title-pg']);

  // Watching something hidden, then losing access, hides it from history too.
  await kid({ method: 'PUT', url: '/api/v1/assets/kids-video/progress', payload: { progressMs: 1000 } });
  assert.deepEqual((await kid('/api/v1/history')).json().map(row => row.id), ['kids-video']);
  await owner({ method: 'PUT', url: '/api/v1/assets/kids-video/rating', payload: { rating: 'mature' } });
  assert.deepEqual((await kid('/api/v1/history')).json(), []);
  assert.equal((await kid({ method: 'PUT', url: '/api/v1/assets/kids-video/progress', payload: { progressMs: 2000 } })).statusCode, 404);
  // Progress belongs to the profile.
  assert.equal((await owner('/api/v1/assets/kids-video')).json().progress_ms, 0);
});

test('allowing unrated content and raising the limit widen what a member sees', async () => {
  const owner = as(ownerCookie), kid = as(kidCookie);
  const updated = await owner({ method: 'PATCH', url: `/api/v1/profiles/${kidId}`, payload: { allowUnrated: true, maxRating: 'mature' } });
  assert.equal(updated.statusCode, 200);
  const ids = (await kid('/api/v1/assets?limit=200')).json().map(asset => asset.id);
  assert.ok(ids.includes('kids-video') && !ids.includes('adult-video') && ids.length > 1);
  for (const id of ['title-r', 'title-unrated']) assert.equal((await kid({ method: 'PUT', url: `/api/v1/titles/${id}/library`, payload: { inLibrary: true } })).statusCode, 200);
  assert.equal((await kid('/api/v1/titles?type=movie')).json().length, 3);
  // Changing a member's limits doesn't sign them out.
  assert.equal((await kid('/api/v1/session')).statusCode, 200);
});

test('each profile has its own My list; the household library is everything on anyone\'s list', async () => {
  const owner = as(ownerCookie), kid = as(kidCookie);
  const household = id => db.prepare('SELECT in_library FROM titles WHERE id=?').get(id).in_library;
  const mine = async run => (await run('/api/v1/titles?type=movie')).json().map(title => title.id).sort();
  assert.equal((await owner({ method: 'PUT', url: '/api/v1/titles/title-pg/library', payload: { inLibrary: false } })).statusCode, 200);
  assert.deepEqual(await mine(owner), ['title-r', 'title-unrated']);
  assert.ok((await mine(kid)).includes('title-pg'), 'removing it from one list leaves the other');
  assert.equal((await owner('/api/v1/titles/title-pg')).json().inLibrary, false);
  assert.equal((await kid('/api/v1/titles/title-pg')).json().inLibrary, true);
  assert.equal(household('title-pg'), 1);
  await kid({ method: 'PUT', url: '/api/v1/titles/title-pg/library', payload: { inLibrary: false } });
  assert.equal(household('title-pg'), 0, 'off every list, it leaves the household library');
  await kid({ method: 'PUT', url: '/api/v1/titles/title-pg/library', payload: { inLibrary: true } });
  assert.equal(household('title-pg'), 1);
});

test('track choices are stored per profile', async () => {
  const owner = as(ownerCookie), kid = as(kidCookie);
  assert.deepEqual((await kid('/api/v1/preferences/tracks')).json(), { value: null });
  assert.equal((await kid({ method: 'PUT', url: '/api/v1/preferences/tracks', payload: { value: { 'title:a': { audio: 'jpn' } } } })).statusCode, 200);
  assert.deepEqual((await kid('/api/v1/preferences/tracks')).json().value, { 'title:a': { audio: 'jpn' } });
  assert.equal((await owner('/api/v1/preferences/tracks')).json().value, null);
  assert.equal((await kid({ method: 'PUT', url: '/api/v1/preferences/tracks', payload: { value: [1] } })).statusCode, 400);
  assert.equal((await kid({ method: 'PUT', url: '/api/v1/preferences/other', payload: { value: {} } })).statusCode, 404);
});

test('the guide only airs what the profile may watch', async () => {
  const owner = as(ownerCookie), kid = as(kidCookie);
  const programs = async run => {
    const guide = (await run('/api/v1/guide?hours=12&limit=100')).json();
    return new Set((guide.channels || []).flatMap(channel => (channel.programs || []).map(program => program.id ?? program.assetId)));
  };
  const ownerPrograms = await programs(owner), kidPrograms = await programs(kid);
  assert.ok(!kidPrograms.has('adult-video') && !kidPrograms.has('adult-nested'));
  assert.ok(ownerPrograms.size >= kidPrograms.size);
});

test('switching profiles: signing out clears the cookie, even when the browser sends an empty JSON body', async () => {
  const kid = await anonymous({ method: 'POST', url: `/api/v1/profiles/${kidId}/select`, headers: { 'content-type': 'application/json' }, payload: '' });
  assert.equal(kid.statusCode, 200);
  const signedOut = await app.inject({ method: 'POST', url: '/api/v1/session/sign-out', headers: { cookie: cookieOf(kid), 'content-type': 'application/json' } });
  assert.equal(signedOut.statusCode, 200);
  assert.match(signedOut.headers['set-cookie'], /kiwi_profile=;.*Max-Age=0/);
  // Body-less actions from buttons (save, follow, delete) work too; malformed JSON is still refused.
  const save = await app.inject({ method: 'POST', url: '/api/v1/assets/kids-video/save', headers: { cookie: ownerCookie, 'content-type': 'application/json' } });
  assert.equal(save.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/assets/kids-video/save', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, payload: '{nope' })).statusCode, 400);
});

test('changing a PIN signs out other devices, and the owner profile stays', async () => {
  const owner = as(ownerCookie);
  const other = await anonymous({ method: 'POST', url: `/api/v1/profiles/${kidId}/select` });
  const otherCookie = cookieOf(other);
  assert.equal((await owner({ method: 'PUT', url: `/api/v1/profiles/${kidId}/pin`, payload: { pin: '4321' } })).statusCode, 200);
  assert.equal((await as(otherCookie)('/api/v1/session')).statusCode, 401);
  assert.equal((await owner({ method: 'DELETE', url: '/api/v1/profiles/user-local' })).statusCode, 409);
  assert.equal((await owner({ method: 'PATCH', url: '/api/v1/profiles/user-local', payload: { role: 'member' } })).statusCode, 409);
  assert.equal((await owner({ method: 'DELETE', url: `/api/v1/profiles/${kidId}` })).statusCode, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM consumption_state WHERE user_id=?').get(kidId).n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM lists WHERE user_id=?').get(kidId).n, 0);
  // title-pg was only on the deleted profile's list.
  assert.equal(db.prepare('SELECT in_library FROM titles WHERE id=?').get('title-pg').in_library, 0);
});
