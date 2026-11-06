import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-catalog-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
const media = await import('@kiwi/media');
const { GUIDE_EPOCH } = await import('../src/guide.js');

// A fake file host that honors ranges, standing in for TorBox's CDN.
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
const host = createServer((req, res) => {
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!range) { res.writeHead(200, { 'content-length': bytes.length, 'content-type': 'video/x-matroska' }); return res.end(bytes); }
  const start = Number(range[1]), end = range[2] ? Number(range[2]) : bytes.length - 1;
  res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 });
  res.end(bytes.subarray(start, end + 1));
});
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
const fileUrl = `http://127.0.0.1:${host.address().port}/video.mkv`;
after(async () => { await app.close(); host.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const episode = (season, number, extra = {}) => ({ episode_number: number, season_number: season, name: `Episode ${season}.${number}`, overview: 'Plot', air_date: '2020-01-01', runtime: 30, still_path: `/still${season}${number}abcdef.jpg`, ...extra });
const requests = [];

const tmdbFetch = async (target) => {
  const url = new URL(target);
  requests.push(url.pathname);
  const path = url.pathname.replace('/3', '');
  if (path === '/trending/movie/week' || path === '/movie/popular') return json({ page: 1, total_pages: 1, results: [{ id: 300, title: 'Test Movie', release_date: '1999-03-31', genre_ids: [28], poster_path: '/poster300abc.jpg', backdrop_path: '/back300abcd.jpg', vote_average: 8.1, original_language: 'en' }] });
  if (path === '/discover/tv') return json({ page: 1, total_pages: 1, results: [{ id: 200, name: 'Anime Show', first_air_date: '2023-09-29', genre_ids: [16], original_language: 'ja', origin_country: ['JP'], poster_path: '/poster200abc.jpg' }] });
  if (path === '/search/multi') return json({ page: 1, total_pages: 1, results: [{ id: 100, media_type: 'tv', name: 'Test Show', first_air_date: '2020-01-01', genre_ids: [35], original_language: 'en' }, { id: 7, media_type: 'person', name: 'Someone' }] });
  if (path === '/tv/100') return json({
    id: 100, name: 'Test Show', first_air_date: '2020-01-01', original_language: 'en', genres: [{ id: 35, name: 'Comedy' }], overview: 'A show.', status: 'Ended',
    episode_run_time: [30], poster_path: '/poster100abc.jpg', backdrop_path: '/back100abcd.jpg', external_ids: { imdb_id: 'tt1000001' },
    networks: [{ name: 'Netflix', logo_path: '/netflixlogo1.png' }, { name: 'Local TV Station', logo_path: '/localtvlogo1.png' }],
    seasons: [{ season_number: 1, episode_count: 3, name: 'Season 1' }, { season_number: 2, episode_count: 2, name: 'Season 2' }], credits: { cast: [{ name: 'Actor One', character: 'Hero', profile_path: '/actor1profile.jpg' }] },
    'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Hulu', logo_path: '/hululogo123.png' }] } } },
  });
  if (path === '/tv/100/season/1') return json({ season_number: 1, episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
  if (path === '/tv/100/season/2') return json({ season_number: 2, episodes: [episode(2, 1), episode(2, 2, { air_date: '2999-01-01' })] });
  if (path === '/tv/200') return json({
    id: 200, name: 'Anime Show', first_air_date: '2023-09-29', original_language: 'ja', origin_country: ['JP'], genres: [{ id: 16, name: 'Animation' }], overview: 'Anime.', status: 'Returning Series',
    episode_run_time: [24], poster_path: '/poster200abc.jpg', external_ids: { imdb_id: 'tt2000002' }, networks: [],
    seasons: [{ season_number: 1, episode_count: 5, name: 'Season 1' }],
  });
  if (path === '/tv/200/season/1') return json({ season_number: 1, episodes: [1, 2, 3, 4, 5].map(number => episode(1, number, { runtime: 24 })) });
  if (path === '/tv/200/episode_groups') return json({ results: [{ id: 'grp1', name: 'Seasons', type: 6, episode_count: 5, group_count: 2 }] });
  if (path === '/tv/episode_group/grp1') return json({ groups: [
    { name: 'Season 1', order: 1, episodes: [1, 2, 3].map((number, order) => ({ season_number: 1, episode_number: number, order })) },
    { name: 'Season 2', order: 2, episodes: [4, 5].map((number, order) => ({ season_number: 1, episode_number: number, order })) },
  ] });
  if (path === '/movie/300') return json({
    id: 300, title: 'Test Movie', release_date: '1999-03-31', runtime: 100, original_language: 'en', genres: [{ id: 28, name: 'Action' }], overview: 'A movie.', poster_path: '/poster300abc.jpg',
    imdb_id: 'tt3000003', external_ids: { imdb_id: 'tt3000003' }, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] },
  });
  if (path === '/configuration') return json({});
  return new Response('{}', { status: 404 });
};

const torboxState = { cached: new Set(), created: [] };
const torboxFetch = async (target, init = {}) => {
  const url = new URL(target);
  const path = url.pathname.replace('/v1/api', '');
  if (path === '/torrents/checkcached') {
    const { hashes } = JSON.parse(init.body);
    return json({ success: true, data: Object.fromEntries(hashes.filter(hash => torboxState.cached.has(hash)).map(hash => [hash, { name: 'x', size: 1, hash }])) });
  }
  if (path === '/torrents/createtorrent') {
    torboxState.created.push(String(init.body));
    return json({ success: true, data: { torrent_id: 77 } });
  }
  if (path === '/torrents/mylist') return json({ success: true, data: { id: 77, name: 'pack', files: [
    { id: 0, name: 'Pack/Test.Show.S01E01.1080p.mkv', short_name: 'Test.Show.S01E01.1080p.mkv', size: 100 }, { id: 1, name: 'Pack/Test.Show.S01E02.1080p.mkv', short_name: 'Test.Show.S01E02.1080p.mkv', size: 100 },
    { id: 2, name: 'Pack/Test.Show.S01E03.1080p.mkv', short_name: 'Test.Show.S01E03.1080p.mkv', size: 100 }, { id: 3, name: 'Pack/Sample.mkv', short_name: 'Sample.mkv', size: 5 },
  ] } });
  if (path === '/torrents/requestdl') return json({ success: true, data: `${fileUrl}?file=${url.searchParams.get('file_id')}` });
  if (path === '/user/me') return json({ success: true, data: { plan: 1 } });
  return new Response('{}', { status: 404 });
};

const probeInfo = { durationMs: 1_800_000, container: 'matroska', video: { codec: 'h264', width: 1920, height: 1080, bitDepth: 8, pixFmt: 'yuv420p' },
  audio: [{ index: 1, position: 0, codec: 'aac', channels: 2, language: 'jpn', default: true, commentary: false }, { index: 2, position: 1, codec: 'aac', channels: 2, language: 'eng', default: false, commentary: false }],
  subtitles: [{ index: 3, position: 0, codec: 'ass', language: 'eng', title: null, forced: false, sdh: false, default: false, text: true }, { index: 4, position: 1, codec: 'hdmv_pgs_subtitle', language: 'jpn', forced: false, sdh: false, default: false, text: false }] };

let searches = [];
const indexer = { id: 'torrentio', async search(query) {
  searches.push(query);
  return [
    { infoHash: 'a'.repeat(40), releaseName: 'Test.Show.S01.1080p.WEB-DL.x264-GRP', fileName: 'Test.Show.S01E02.1080p.mkv', size: 4e9, seeders: 50, indexer: 'torrentio', idBased: true },
    { infoHash: 'b'.repeat(40), releaseName: 'Test.Show.S01E02.720p.HDTV.x264-OTHER', fileName: null, size: 3e8, seeders: 5, indexer: 'torrentio', idBased: true },
    { infoHash: 'c'.repeat(40), releaseName: 'Test.Show.S01E02.HDCAM.x264', fileName: null, size: 1e9, seeders: 90, indexer: 'torrentio', idBased: true },
  ];
} };

const tmdb = media.createTmdb({ fetchImpl: tmdbFetch, config: () => ({ token: 't'.repeat(60), region: 'US' }) });
const torbox = media.createTorbox({ fetchImpl: torboxFetch, config: () => ({ apiKey: 'key' }) });
const sources = media.createSourceService({ torbox, indexers: [indexer], probeImpl: async () => probeInfo });
const subtitles = media.createSubtitleService({ resolveInput: async () => fileUrl, external: null });
media.setMedia({ tmdb, torbox, images: media.createImageStore({ fetchImpl: async () => new Response('x', { status: 404 }) }), sources, subtitles, opensubs: { available: () => false } });
media.saveProvider('tmdb', { config: { token: 't'.repeat(60) } });
media.saveProvider('torbox', { config: { apiKey: 'key' } });

const get = async url => (await app.inject(url));
const post = async (url, payload) => app.inject({ method: 'POST', url, payload });
const put = async (url, payload) => app.inject({ method: 'PUT', url, payload });

test('catalog rails return cards with a stable ref and keep anime out of the movies and shows pages', async () => {
  const movies = (await get('/api/v1/catalog/home?kind=movies')).json();
  assert.equal(movies.rails[0].items[0].title, 'Test Movie');
  assert.equal(movies.rails[0].items[0].ref, 'tmdb:movie:300');
  assert.equal(movies.rails[0].items[0].poster, '/api/v1/images/tmdb/w342/poster300abc.jpg');
  const anime = (await get('/api/v1/catalog/home?kind=anime')).json();
  assert.equal(anime.rails[0].items[0].isAnime, true);
  const search = (await get('/api/v1/catalog/search?q=test')).json();
  assert.deepEqual(search.items.map(item => item.title), ['Test Show'], 'people are not results');
});

test('opening a show creates the title, tags its genres and services, and loads episodes on demand', async () => {
  const title = (await get('/api/v1/titles/tmdb:show:100')).json();
  assert.equal(title.title, 'Test Show');
  assert.equal(title.inLibrary, false);
  assert.deepEqual(title.genres, ['Comedy']);
  assert.deepEqual(title.services.map(service => service.name).sort(), ['Hulu', 'Netflix'], 'broadcasters are not services');
  assert.deepEqual(title.topics.map(topic => `${topic.name}:${topic.topic_type}`).sort(), ['Comedy:genre', 'Hulu:service', 'Netflix:service']);
  assert.equal(title.cast[0].name, 'Actor One');
  const season = (await get(`/api/v1/titles/${title.id}/episodes?season=1`)).json();
  assert.deepEqual(season.episodes.map(item => item.episode), [1, 2, 3]);
  assert.equal(season.episodes[0].durationMs, 30 * 60_000);
  const second = (await get(`/api/v1/titles/${title.id}/episodes?season=2`)).json();
  assert.equal(second.episodes[1].availability, 'unaired');
});

test('catalog items stay out of home lists, shorts, and the topic item counts', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const home = (await get('/api/v1/assets?limit=200')).json();
  assert.ok(home.length > 0 && home.every(asset => !asset.title_id));
  assert.equal((await get('/api/v1/shorts')).json().some(asset => asset.title_id), false);
  const topics = (await get('/api/v1/topics')).json();
  const comedy = topics.find(topic => topic.name === 'Comedy');
  assert.equal(comedy.item_count, 0);
  assert.equal(comedy.title_count, 1);
  const page = (await get(`/api/v1/topics/${comedy.slug}`)).json();
  assert.deepEqual(page.titles.map(item => item.ref), [title.id]);
  assert.equal(page.item_count, 0);
});

test('titles are searchable and episodes never appear as separate results', async () => {
  const results = (await get('/api/v1/search?q=test%20show')).json();
  const titles = results.filter(item => item.entityType === 'title');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].title, 'Test Show');
  assert.equal(results.some(item => item.entityType === 'asset' && item.title_id), false);
  const comedy = (await get('/api/v1/search?q=comedy')).json();
  assert.ok(comedy.some(item => item.entityType === 'title' && item.title === 'Test Show'), 'found through its genre tag');
});

test('tagging a series tags every episode, and an episode can carry its own tag', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const added = await post(`/api/v1/titles/${title.id}/topics`, { name: 'Sitcom Night' });
  assert.equal(added.statusCode, 200);
  const tagged = topicsOf(`${title.id}-s01e02`);
  assert.ok(tagged.includes('Sitcom Night'));
  assert.ok(topicsOf(`${title.id}-s02e01`).includes('Sitcom Night'));
  const own = await post(`/api/v1/assets/${title.id}-s01e03/topics`, { name: 'Favorite Episode' });
  assert.equal(own.statusCode, 200);
  assert.ok(topicsOf(`${title.id}-s01e03`).includes('Favorite Episode'));
  assert.equal(topicsOf(`${title.id}-s01e01`).includes('Favorite Episode'), false);
  const episodes = (await get(`/api/v1/titles/${title.id}/episodes?season=1`)).json().episodes;
  assert.deepEqual(episodes.find(item => item.episode === 3).topics.map(topic => topic.name), ['Favorite Episode'], 'episodes list only their own tags');
});
const topicsOf = id => {
  const row = db.prepare("SELECT t.name FROM topics t JOIN effective_asset_topics et ON et.topic_id=t.id WHERE et.asset_id=?").all(id);
  return row.map(item => item.name);
};

test('anime stays one series and every episode keeps its alternate season numbering', async () => {
  const title = (await get('/api/v1/titles/tmdb:show:200')).json();
  assert.equal(title.isAnime, true);
  assert.deepEqual(title.topics.map(topic => topic.name).sort(), ['Animation', 'Anime']);
  assert.equal(title.seasons.length, 1, 'not split into separate series');
  await get(`/api/v1/titles/${title.id}/episodes?season=1`);
  const alias = id => JSON.parse(db.prepare("SELECT metadata_json FROM assets WHERE id=?").get(id).metadata_json).numbering;
  assert.equal(alias(`${title.id}-s01e04`).season, 2);
  assert.equal(alias(`${title.id}-s01e04`).episode, 1);
  assert.equal(alias(`${title.id}-s01e02`), undefined, 'only differing numbers are stored');
  assert.equal(db.prepare("SELECT absolute_number FROM assets WHERE id=?").get(`${title.id}-s01e05`).absolute_number, 5);
});

test('adding to the library keeps a title in My list and makes its episodes schedulable', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const added = await put(`/api/v1/titles/${title.id}/library`, { inLibrary: true });
  assert.equal(added.json().inLibrary, true);
  const listed = (await get('/api/v1/titles?type=show')).json();
  assert.deepEqual(listed.map(item => item.title), ['Test Show']);
  assert.deepEqual((await get('/api/v1/titles?type=movie')).json(), []);
  const rows = (await get(`/api/v1/guide?start=${GUIDE_EPOCH}&hours=4&limit=100&filter=media`)).json();
  assert.ok(rows.channels.every(channel => channel.type === 'media'));
});

test('playing an episode searches, confirms the cache on TorBox, picks the best release, and reads its tracks', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const assetId = `${title.id}-s01e02`;
  torboxState.cached.add('a'.repeat(40));
  torboxState.cached.add('b'.repeat(40));
  torboxState.cached.add('c'.repeat(40));
  searches = [];
  const response = await post(`/api/v1/assets/${assetId}/stream`, { caps: [] });
  assert.equal(response.statusCode, 200, response.body);
  const stream = response.json();
  assert.equal(stream.status, 'ready');
  assert.equal(stream.source.resolution, 1080, 'the 1080p release beats 720p; the cam is never considered');
  assert.equal(stream.source.cached, true);
  assert.equal(searches[0].imdbId, 'tt1000001');
  assert.equal(searches[0].season, 1);
  assert.equal(searches[0].episode, 2);
  assert.equal(stream.chosen.audioPosition, 1, 'English audio is chosen over the file\'s Japanese default');
  assert.equal(stream.playback.mode, 'remux', 'a non-default audio track means the file is repackaged for the browser');
  assert.equal(stream.playback.audioPosition, 1);
  assert.equal(stream.audio.length, 2);
  assert.ok(stream.subtitles.some(track => track.language === 'eng'));
  assert.ok(stream.subtitles.some(track => track.status === 'unsupported'), 'image subtitles are listed but not playable');
  const picked = db.prepare("SELECT torbox_file_id, status FROM playback_sources WHERE asset_id=? AND status='selected'").get(assetId);
  assert.equal(picked.torbox_file_id, 1, 'the file for episode 2 is chosen inside the pack, not the sample');
  assert.match(torboxState.created.at(-1), /add_only_if_cached=true/);
  const sourcesList = (await get(`/api/v1/assets/${assetId}/sources`)).json().sources;
  assert.ok(sourcesList.length >= 2 && sourcesList[0].selected);
  assert.ok(sourcesList[0].reasons.some(reason => reason.label === 'instant on TorBox'));
  const again = await post(`/api/v1/assets/${assetId}/stream`, { caps: [] });
  assert.equal(searches.length, 1, 'the choice is remembered instead of searching again');
  assert.equal(again.json().status, 'ready');
});

test('the file route proxies the source with range support', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const whole = await get(`/api/v1/assets/${title.id}-s01e02/file`);
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.rawPayload.length, bytes.length);
  const part = await app.inject({ method: 'GET', url: `/api/v1/assets/${title.id}-s01e02/file`, headers: { range: 'bytes=10-19' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 10-19/${bytes.length}`);
  assert.deepEqual([...part.rawPayload], [...bytes.subarray(10, 20)]);
});

test('tuning back in reuses the tracks read the first time instead of probing the file again', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const assetId = `${title.id}-s01e02`;
  let probes = 0;
  const counting = () => media.createSourceService({ torbox, indexers: [indexer], probeImpl: async () => { probes++; return probeInfo; } });
  const saved = media.getMedia();
  try {
    // A new service has no memory of earlier links or results, like the server after a restart.
    media.setMedia({ ...saved, sources: counting() });
    assert.equal((await post(`/api/v1/assets/${assetId}/stream`, { caps: [] })).statusCode, 200);
    media.setMedia({ ...saved, sources: counting() });
    const again = await post(`/api/v1/assets/${assetId}/stream`, { caps: [] });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().audio.length, 2);
    assert.equal(probes, 0, 'the stored tracks of the chosen source are used');
  } finally { media.setMedia(saved); }
});

test('a slow indexer does not hold up a release another one has already found', async () => {
  const anime = db.prepare("SELECT id FROM titles WHERE tmdb_id=200").get();
  const assetId = `${anime.id}-s01e01`;
  torboxState.cached.add('e'.repeat(40));
  const fast = { id: 'torrentio', async search() { return [{ infoHash: 'e'.repeat(40), releaseName: 'Anime.Show.S01E01.1080p.WEB-DL.x264-GRP', fileName: 'Test.Show.S01E01.1080p.mkv', size: 1.5e9, seeders: 30, indexer: 'torrentio', idBased: true }]; } };
  let slowTimer;
  const slow = { id: 'nyaa', search: () => new Promise(resolve => { slowTimer = setTimeout(() => resolve([]), 5_000); }) };
  const sources = media.createSourceService({ torbox, indexers: [fast, slow], probeImpl: async () => probeInfo, indexerGraceMs: 50 });
  const started = Date.now();
  const result = await sources.prepare(assetId);
  clearTimeout(slowTimer);
  assert.equal(result.status, 'ready');
  assert.ok(Date.now() - started < 2_000, `prepared in ${Date.now() - started} ms`);
});

test('with nothing cached the player gets a clear message instead of a hang', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  torboxState.cached.clear();
  const response = await post(`/api/v1/assets/${title.id}-s01e01/stream`, { caps: [] });
  assert.equal(response.statusCode, 404);
  assert.match(response.json().error, /none is available instantly/);
  assert.equal(db.prepare("SELECT availability FROM assets WHERE id=?").get(`${title.id}-s01e01`).availability, 'unavailable');
});

test('the guide airs library episodes in order, back to back, under the show name', async () => {
  db.prepare("UPDATE assets SET availability='unknown' WHERE title_id IS NOT NULL AND availability='unavailable'").run();
  const rows = (await get(`/api/v1/guide?start=${GUIDE_EPOCH}&hours=12&limit=100&filter=genres`)).json();
  const comedy = rows.channels.find(channel => channel.name === 'Comedy');
  assert.ok(comedy, 'a genre channel exists for the library show');
  assert.equal(comedy.type, 'genre');
  const programs = comedy.programs;
  assert.equal(programs[0].title, 'Test Show');
  assert.match(programs[0].subtitle, /^S\dE\d · /);
  // Episodes air in blocks of two, in order; the unaired 2.2 never does.
  const labels = programs.map(program => `${program.season}.${program.episode}`);
  assert.equal(labels[labels.indexOf('1.1') + 1], '1.2');
  assert.equal(labels[labels.indexOf('1.3') + 1], '2.1');
  assert.equal(labels.includes('2.2'), false);
  for (let index = 1; index < programs.length; index++) assert.equal(programs[index].start, programs[index - 1].end);
});

test('the background check keeps an episode with nothing playable off the guide until a release appears', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const assetId = `${title.id}-s01e03`;
  db.prepare("DELETE FROM playback_sources WHERE asset_id=?").run(assetId);
  db.prepare("UPDATE assets SET availability='unknown' WHERE id=?").run(assetId);
  const third = { id: 'torrentio', async search() { return [{ infoHash: 'f'.repeat(40), releaseName: 'Test.Show.S01E03.1080p.WEB-DL.x264-GRP', size: 1.5e9, seeders: 30, indexer: 'torrentio', idBased: true }]; } };
  const sources = media.createSourceService({ torbox, indexers: [third], probeImpl: async () => probeInfo });
  const aired = async () => (await get(`/api/v1/guide?start=${GUIDE_EPOCH}&hours=12&limit=100&filter=genres`)).json()
    .channels.find(channel => channel.name === 'Comedy').programs.some(program => program.id === assetId);
  assert.equal(await aired(), true);
  torboxState.cached.clear();
  assert.equal(await sources.check(assetId), 'unavailable');
  assert.equal(await aired(), false, 'nothing instantly playable: it does not air');
  assert.equal(await sources.check(assetId), 'unavailable', 'checked again only after a day');
  torboxState.cached.add('f'.repeat(40));
  db.prepare("UPDATE assets SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(assetId);
  assert.equal(await sources.check(assetId), 'available');
  assert.equal(await aired(), true);
  assert.equal(await sources.check(assetId), 'known', 'found releases are not searched for again');
});

test('the channel being watched has its current and next programs readied ahead of time', async () => {
  const { createGuideWarmer } = await import('../src/guide-warm.js');
  const rows = (await get(`/api/v1/guide?start=${GUIDE_EPOCH + 3_600_000}&hours=1&limit=100&filter=genres`)).json();
  const comedy = rows.channels.find(channel => channel.name === 'Comedy');
  const at = comedy.programs[0].end - 5 * 60_000;
  const readied = [];
  const warmer = createGuideWarmer({ prepare: async id => { readied.push(id); }, now: () => at });
  assert.deepEqual(await warmer.run(), [], 'nothing is warmed until a channel is tuned');
  warmer.tune(comedy.key);
  await warmer.run();
  assert.deepEqual(readied.slice(0, 2), [comedy.programs[0].id, comedy.programs[1].id], 'what is on now, then what starts within minutes');
  assert.equal((await post('/api/v1/guide/tune', { channel: comedy.key })).statusCode, 204);
  assert.equal((await post('/api/v1/guide/tune', {})).statusCode, 400);
});

test('downloads need a destination, then queue one job per episode that attaches to the same item', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const missing = await post(`/api/v1/titles/${title.id}/download`, { season: 1 });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /download folder/);
  const folder = mkdtempSync(join(tmpdir(), 'kiwi-dl-'));
  const root = (await app.inject({ method: 'POST', url: '/api/v1/library/roots', payload: { path: folder } })).json();
  await app.inject({ method: 'PATCH', url: `/api/v1/library/roots/${root.id}`, payload: { readOnly: false } });
  assert.equal((await put('/api/v1/media/downloads', { rootId: root.id, showsFolder: 'TV Shows' })).statusCode, 200);
  const queued = await post(`/api/v1/titles/${title.id}/download`, { season: 1 });
  assert.equal(queued.statusCode, 202, queued.body);
  assert.equal(queued.json().queued.length, 3);
  const rows = db.prepare("SELECT source, subfolder, target_asset_id, plugin, title FROM downloads ORDER BY source").all();
  assert.deepEqual(rows.map(row => row.target_asset_id), [`${title.id}-s01e01`, `${title.id}-s01e02`, `${title.id}-s01e03`]);
  assert.ok(rows.every(row => row.plugin === 'kiwi-media' && row.subfolder === 'TV Shows' && row.source.startsWith('kiwi-media://asset/')));
  assert.equal(rows[0].title, 'Test Show S01E01');
  const again = await post(`/api/v1/titles/${title.id}/download`, { season: 1 });
  assert.equal(again.json().queued.length, 0, 'already queued items are not queued twice');
  rmSync(folder, { recursive: true, force: true });
});

test('settings validate rules, languages, and secrets stay masked', async () => {
  const settings = (await get('/api/v1/media/settings')).json();
  assert.deepEqual(settings.playback.audioLanguages, ['eng', 'jpn', 'zho']);
  assert.equal(settings.rules.preferredResolution, 1080);
  assert.equal(settings.providers.find(provider => provider.id === 'tmdb').secrets.token, true);
  assert.equal(JSON.stringify(settings).includes('t'.repeat(60)), false, 'secrets never leave the server');
  assert.equal((await put('/api/v1/media/rules', { preferredResolution: 999 })).statusCode, 400);
  assert.equal((await put('/api/v1/media/rules', { preferredResolution: 720, minResolution: 720, maxResolution: 1080 })).json().preferredResolution, 720);
  assert.equal((await put('/api/v1/media/playback', { audioLanguages: ['klingon'] })).statusCode, 400);
  assert.deepEqual((await put('/api/v1/media/playback', { audioLanguages: ['jpn', 'eng'] })).json().audioLanguages, ['jpn', 'eng']);
  await post('/api/v1/media/rules/reset', {});
  await put('/api/v1/media/playback', { audioLanguages: ['eng', 'jpn', 'zho'] });
});

test('continue watching lists one entry per title with its resume point', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  await put(`/api/v1/assets/${title.id}-s01e02/progress`, { progressMs: 600_000, completed: false });
  const rows = (await get('/api/v1/continue?kind=shows')).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asset.id, `${title.id}-s01e02`);
  assert.equal(rows[0].resume, true);
  await put(`/api/v1/assets/${title.id}-s01e02/progress`, { progressMs: 1_790_000, completed: true });
  const next = (await get('/api/v1/continue?kind=shows')).json();
  assert.equal(next[0].asset.id, `${title.id}-s01e03`, 'a finished episode moves on to the next');
  const history = (await get('/api/v1/history?scope=home')).json();
  assert.ok(history.every(item => !item.title_id));
  assert.ok((await get('/api/v1/history?scope=catalog')).json().every(item => item.title_id));
});

test('the featured banner leads with what you are watching, then trending titles with their artwork', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const home = (await get('/api/v1/catalog/featured?kind=home')).json();
  assert.equal(home.items[0].titleId, title.id, 'the series in progress comes first');
  assert.equal(home.items[0].play.id, `${title.id}-s01e03`);
  assert.equal(home.items[0].backdrop, '/api/v1/images/tmdb/w1280/back100abcd.jpg');
  assert.ok(home.items.every(item => item.backdrop), 'only titles with wide artwork are featured');
  const movies = (await get('/api/v1/catalog/featured?kind=movies')).json();
  assert.equal(movies.items[0].title, 'Test Movie');
  assert.deepEqual(movies.items[0].genres, ['Action']);
  assert.equal(movies.items[0].certification, 'R');
  assert.equal(movies.items[0].play, null);
  assert.equal((await get('/api/v1/catalog/featured?kind=nope')).statusCode, 400);
  // The watch page shows the series behind the player and a card for it under the video.
  const asset = (await get(`/api/v1/assets/${title.id}-s01e03`)).json();
  assert.equal(asset.catalog.backdrop, '/api/v1/images/tmdb/w1280/back100abcd.jpg');
  assert.equal(asset.catalog.seasonCount, 2);
  assert.deepEqual(asset.catalog.genres, ['Comedy']);
});

test('a release TorBox is still downloading reports progress instead of failing, and plays once ready', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const assetId = `${title.id}-s02e01`;
  await put('/api/v1/media/rules', { requireCached: false });
  torboxState.cached.clear();
  let progress = 0.4;
  const original = tmdb;
  void original;
  const slowTorbox = media.createTorbox({ config: () => ({ apiKey: 'key' }), fetchImpl: async (target, init = {}) => {
    const url = new URL(target);
    if (url.pathname.endsWith('/torrents/mylist')) return json({ success: true, data: { id: 77, name: 'pack', download_finished: progress >= 1, progress, download_state: progress >= 1 ? 'cached' : 'downloading', files: progress >= 1 ? [{ id: 0, name: 'Test.Show.S02E01.1080p.mkv', short_name: 'Test.Show.S02E01.1080p.mkv', size: 100 }] : [] } });
    return torboxFetch(target, init);
  } });
  const slowSources = media.createSourceService({ torbox: slowTorbox, indexers: [{ id: 'torrentio', async search() { return [{ infoHash: 'd'.repeat(40), releaseName: 'Test.Show.S02E01.1080p.WEB-DL.x264-GRP', size: 2e9, seeders: 40, indexer: 'torrentio', idBased: true }]; } }], probeImpl: async () => probeInfo });
  media.setMedia({ ...media.getMedia(), sources: slowSources, torbox: slowTorbox });
  const waiting = await post(`/api/v1/assets/${assetId}/stream`, { caps: [] });
  assert.equal(waiting.statusCode, 202);
  assert.match(waiting.json().stage, /downloading this release \(40%\)/);
  assert.equal(db.prepare("SELECT status FROM playback_sources WHERE asset_id=?").get(assetId).status, 'candidate', 'the source is kept, not marked failed');
  progress = 1;
  slowSources.reset(assetId);
  await new Promise(resolve => setTimeout(resolve, 20));
  const ready = await post(`/api/v1/assets/${assetId}/stream`, { caps: [] });
  assert.equal(ready.statusCode, 200, ready.body);
  await post('/api/v1/media/rules/reset', {});
  media.setMedia({ ...media.getMedia(), sources, torbox });
});

test('the catalog downloader is internal: it never shows up as a choice in Settings or the Upload dialog', async () => {
  const list = (await get('/api/v1/downloaders')).json();
  assert.ok(list.length >= 1);
  assert.equal(list.some(item => item.plugin === 'kiwi-media'), false);
  const plugins = (await get('/api/v1/downloads/plugins')).json();
  assert.equal(plugins.plugins.some(plugin => plugin.id === 'kiwi-media'), false);
});

test('a source readied ahead of time is planned for the browser that plays it', async () => {
  const title = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const assetId = `${title.id}-s01e02`;
  const source = db.prepare("SELECT id FROM playback_sources WHERE asset_id=? AND status='selected'").get(assetId);
  const info = { ...probeInfo, video: { ...probeInfo.video, codec: 'hevc' }, audio: [{ ...probeInfo.audio[1], position: 0, default: true }] };
  // What a warm-up left behind, planned for a browser with no HEVC decoder.
  const warmed = { status: 'ready', origin: 'torbox', sourceId: source.id, info, chosen: { audio: info.audio[0], subtitle: null }, plan: { mode: 'remux', video: 'transcode' } };
  const saved = media.getMedia();
  try {
    media.setMedia({ ...saved, sources: { ...saved.sources, prepare: async () => warmed } });
    assert.deepEqual((await post(`/api/v1/assets/${assetId}/stream`, { caps: ['hevc'] })).json().playback, { mode: 'direct' });
    assert.equal((await post(`/api/v1/assets/${assetId}/stream`, { caps: [] })).json().playback.video, 'transcode');
  } finally { media.setMedia(saved); }
});

test('opening a title page readies what Play points to, without adding torrents for titles you are only browsing', async () => {
  const show = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const saved = media.getMedia();
  const calls = [];
  try {
    media.setMedia({ ...saved, sources: { ...saved.sources, prepare: async id => { calls.push(['open', id]); }, check: async id => { calls.push(['find', id]); } } });
    // A show you've been watching: its next episode is opened in full.
    const watching = await post(`/api/v1/assets/${show.id}-s01e03/warm`);
    assert.equal(watching.statusCode, 202);
    assert.equal(watching.json().status, 'opening');
    // Something never played: only its releases are looked up.
    db.prepare("INSERT INTO assets (id,kind,title,title_id,season_number,episode_number,added_at,updated_at) VALUES ('warm-unseen','video','Unseen',?,1,9,'2000-01-01','2000-01-01')").run(show.id);
    db.prepare("DELETE FROM consumption_state WHERE asset_id IN (SELECT id FROM assets WHERE title_id=?)").run(show.id);
    assert.equal((await post('/api/v1/assets/warm-unseen/warm')).json().status, 'finding');
    assert.deepEqual(calls, [['open', `${show.id}-s01e03`], ['find', 'warm-unseen']]);
    // Home videos and missing items are left alone.
    assert.equal((await post('/api/v1/assets/nope/warm')).statusCode, 404);
  } finally { media.setMedia(saved); db.prepare("DELETE FROM assets WHERE id='warm-unseen'").run(); }
});

test("a release group that played well is nudged up for the rest of the series, but doesn't override quality", async () => {
  const show = db.prepare("SELECT id FROM titles WHERE tmdb_id=100").get();
  const ep = number => `${show.id}-s01e0${number}`;
  const hash = (group, number) => `${group}${String(number).repeat(39)}`.slice(0, 40);
  // Two instant releases of every episode: AAA's Blu-ray scores 2 points above BBB's web release.
  const twoGroups = { id: 'torrentio', async search(query) {
    return [
      { infoHash: hash('a', query.episode), releaseName: `Test.Show.S01E0${query.episode}.1080p.BluRay.x264-AAA`, size: 1.5e9, seeders: 40, indexer: 'torrentio', idBased: true },
      { infoHash: hash('b', query.episode), releaseName: `Test.Show.S01E0${query.episode}.1080p.WEB-DL.x264-BBB`, size: 1.5e9, seeders: 40, indexer: 'torrentio', idBased: true },
    ];
  } };
  for (const number of [1, 2, 3]) torboxState.cached.add(hash('a', number)).add(hash('b', number));
  db.prepare("DELETE FROM playback_sources WHERE asset_id IN (?,?,?)").run(ep(1), ep(2), ep(3));
  db.prepare("UPDATE assets SET availability='unknown' WHERE id IN (?,?,?)").run(ep(1), ep(2), ep(3));
  // Earlier tests watched episodes too; start this one from nothing.
  db.prepare("DELETE FROM release_successes").run();
  const saved = media.getMedia();
  const sources = media.createSourceService({ torbox, indexers: [twoGroups], probeImpl: async () => probeInfo });
  media.setMedia({ ...saved, sources });
  const groups = id => sources.sources(id).map(source => source.group);
  try {
    // Episode 3 is found ahead of time, before anything has played.
    assert.equal(await sources.check(ep(3)), 'available');
    assert.deepEqual(groups(ep(3)), ['AAA', 'BBB']);

    // Episode 1 plays from BBB (chosen by hand), but only halfway: not a signal yet.
    const first = await sources.prepare(ep(1));
    assert.match(first.fileName, /S01E01/);
    const bbb = sources.sources(ep(1)).find(source => source.group === 'BBB');
    await sources.select(ep(1), bbb.id);
    const duration = db.prepare("SELECT duration_ms FROM assets WHERE id=?").get(ep(1)).duration_ms;
    assert.equal((await put(`/api/v1/assets/${ep(1)}/progress`, { progressMs: Math.round(duration * 0.5) })).statusCode, 200);
    assert.deepEqual(groups(ep(3)), ['AAA', 'BBB'], 'half an episode proves nothing');
    // Watched most of the way: BBB is remembered for this show.
    await put(`/api/v1/assets/${ep(1)}/progress`, { progressMs: Math.round(duration * 0.8) });
    assert.deepEqual(db.prepare("SELECT scope, release_group FROM release_successes").all().map(row => ({ ...row })), [{ scope: `title:${show.id}`, release_group: 'BBB' }]);

    // Releases found before the signal are reordered, with the reason shown.
    const stored = sources.sources(ep(3));
    assert.deepEqual(stored.map(source => source.group), ['BBB', 'AAA']);
    assert.ok(stored[0].reasons.some(reason => reason.label === 'BBB played well before' && reason.points === 15));
    assert.ok(stored[0].score > stored[1].score);
    // And a fresh search ranks it first too; that is what plays.
    const next = await sources.prepare(ep(2));
    assert.equal(sources.sources(ep(2)).find(source => source.selected).group, 'BBB', next.fileName);

    // It's a nudge: a lower resolution from the proven group still loses to a higher one.
    const { scoreCandidate } = await import('@kiwi/media');
    const context = media.rankingContext(db.prepare("SELECT * FROM titles WHERE id=?").get(show.id), { type: 'episode', season: 1, episode: 2, aliases: [] });
    const score = name => scoreCandidate({ releaseName: name, cached: true, size: 1e9, idBased: true }, context).score;
    assert.ok(score('Test.Show.S01E02.1080p.WEB-DL.x264-AAA') - score('Test.Show.S01E02.720p.WEB-DL.x264-BBB') > 15, 'one resolution step outweighs one good play');
    assert.ok(media.provenPoints(1) === 15 && media.provenPoints(4) === 21 && media.provenPoints(100) === 25);

    // Movies are their own scope: a show's signal doesn't reach them.
    assert.equal(db.prepare("SELECT count(*) n FROM release_successes WHERE scope='movies'").get().n, 0);
  } finally { media.setMedia(saved); }
});
