import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import mime from "mime-types";
import { db, generatedDir, reindexTitleSearch } from "@kiwi/database";
import { join } from "node:path";
import { ConfigError, destinationFor, downloadBlocker } from "@kiwi/downloads";
import {
  LANGUAGES, MEDIA_DOWNLOADER_ID, MEDIA_SCHEME, SourceError, assetSummary, cacheSummary, clearHttpCache, continueWatching, defaultRules, describeLocalTracks, describePrepared,
  getDownloadSettings, getMedia, getPlayback, getProvider, getRules, getTitle, imageUrl, libraryTitles, nextUp, openTitle, providerDefinitions,
  publicProvider, publicSeasons, publicTitle, resetRules, saveDownloadSettings, savePlayback, saveProvider, saveRules, setAnime, setLibrary, startRemux, createHlsSessions, ensureSeason, ensureAllSeasons,
} from "@kiwi/media";

const userId = "user-local";
const now = () => new Date().toISOString();
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

const handle = fn => async (req, reply) => {
  try { return await fn(req, reply); }
  catch (error) {
    if (error instanceof SourceError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    if (error.statusCode && error.name !== "FastifyError") return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  }
};

// Resolves with the promise's value, or `fallback` after `ms`; the timer never outlives the promise.
const within = (promise, ms, fallback) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(fallback), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

const KINDS = ["movies", "shows", "anime"];
const SORTS = { popular: "popularity.desc", rated: "vote_average.desc", new: null };

export function registerMedia(app, { resolveTopic }) {
  const media = () => getMedia();

  // --------------------------------------------------------------------------------------------
  // Catalog browsing (live from the provider, cached)

  const lookup = db.prepare("SELECT id, in_library FROM titles WHERE type=? AND tmdb_id=?");
  const card = summary => {
    const local = lookup.get(summary.type, summary.tmdbId);
    return {
      ref: local?.id || `tmdb:${summary.type}:${summary.tmdbId}`, titleId: local?.id || null, type: summary.type, tmdbId: summary.tmdbId, title: summary.title, year: summary.year,
      rating: summary.rating, overview: summary.overview, poster: imageUrl(summary.posterPath, "w342"), backdrop: imageUrl(summary.backdropPath, "w780"),
      isAnime: summary.isAnime, inLibrary: Boolean(local?.in_library),
    };
  };
  const cards = results => results.map(card);
  const only = (kind, results) => kind === "anime" ? results.filter(item => item.isAnime) : results.filter(item => !item.isAnime);

  const tmdbReady = () => {
    if (!getProvider("tmdb").configured) throw new ConfigError("Add your TMDB key in Settings → Streaming to browse movies, shows, and anime.", 400);
  };

  app.get("/api/v1/catalog/home", handle(async req => {
    const kind = req.query.kind;
    if (!KINDS.includes(kind)) throw new ConfigError("kind must be movies, shows, or anime.");
    tmdbReady();
    const { tmdb } = media();
    const rails = {
      movies: [["trending", "Trending this week", () => tmdb.trending("movie")], ["popular", "Popular", () => tmdb.popular("movie")], ["rated", "Top rated", () => tmdb.topRated("movie")], ["playing", "In theaters", () => tmdb.nowPlaying()]],
      shows: [["trending", "Trending this week", () => tmdb.trending("show")], ["popular", "Popular", () => tmdb.popular("show")], ["rated", "Top rated", () => tmdb.topRated("show")], ["airing", "On the air", () => tmdb.airingToday()]],
      anime: [["trending", "Popular anime series", () => tmdb.discover("show", { anime: true })], ["rated", "Top rated series", () => tmdb.discover("show", { anime: true, sort: "vote_average.desc" })],
        ["movies", "Anime movies", () => tmdb.discover("movie", { anime: true })], ["recent", "New this year", () => tmdb.discover("show", { anime: true, sort: "first_air_date.desc", minVotes: 20, year: new Date().getFullYear() })]],
    }[kind];
    const settled = await Promise.allSettled(rails.map(([, , load]) => load()));
    if (settled.every(result => result.status === "rejected")) throw settled[0].reason;
    return {
      rails: rails.map(([id, title], index) => settled[index].status === "fulfilled"
        ? { id, title, items: cards(kind === "anime" ? settled[index].value.results : only(kind, settled[index].value.results)).slice(0, 20) } : null).filter(rail => rail?.items.length),
    };
  }));

  app.get("/api/v1/catalog/genres", handle(async req => {
    const kind = req.query.kind;
    if (!KINDS.includes(kind)) throw new ConfigError("kind must be movies, shows, or anime.");
    tmdbReady();
    const type = kind === "movies" || req.query.type === "movie" ? "movie" : "show";
    return (await media().tmdb.genres(type)).filter(genre => !(kind === "anime" && genre.id === 16));
  }));

  app.get("/api/v1/catalog/browse", handle(async req => {
    const { kind, genre, sort = "popular", page = 1 } = req.query;
    if (!KINDS.includes(kind) || !SORTS.hasOwnProperty(sort)) throw new ConfigError("Invalid browse request.");
    tmdbReady();
    const type = kind === "movies" || (kind === "anime" && req.query.type === "movie") ? "movie" : "show";
    const sortKey = SORTS[sort] ?? (type === "movie" ? "primary_release_date.desc" : "first_air_date.desc");
    const result = await media().tmdb.discover(type, { genre: genre ? Number(genre) : undefined, anime: kind === "anime", sort: sortKey, page: Number(page) || 1, minVotes: sort === "new" ? 10 : undefined });
    return { page: result.page, totalPages: result.totalPages, items: cards(kind === "anime" ? result.results : only(kind, result.results)) };
  }));

  app.get("/api/v1/catalog/search", handle(async req => {
    const q = String(req.query.q || "").trim();
    if (!q) return { items: [] };
    tmdbReady();
    const type = req.query.type === "movie" ? "movie" : req.query.type === "show" ? "show" : undefined;
    const result = await media().tmdb.search(q, { type, page: Number(req.query.page) || 1 });
    const items = cards(result.results);
    const kind = req.query.kind;
    return { page: result.page, totalPages: result.totalPages, items: kind === "anime" ? items.filter(item => item.isAnime) : kind === "movies" || kind === "shows" ? items.filter(item => !item.isAnime && item.type === (kind === "movies" ? "movie" : "show")) : items };
  }));

  // --------------------------------------------------------------------------------------------
  // Titles

  const resolveRef = async ref => {
    const match = /^tmdb:(movie|show):(\d+)$/.exec(ref);
    if (match) { tmdbReady(); return openTitle(match[1], Number(match[2]), media().tmdb); }
    const title = getTitle(ref);
    if (!title) return null;
    if (title.tmdb_id && getProvider("tmdb").configured) { try { return await openTitle(title.type, title.tmdb_id, media().tmdb); } catch { return title; } }
    return title;
  };

  const episodeRows = (titleId, season) => {
    const rows = db.prepare(`SELECT a.*, cs.progress_ms, cs.completed, cs.last_viewed_at FROM assets a LEFT JOIN consumption_state cs ON cs.asset_id=a.id AND cs.user_id=?
      WHERE a.title_id=? AND a.season_number=? ORDER BY a.episode_number`).all(userId, titleId, season);
    const own = new Map();
    for (const row of db.prepare(`SELECT an.asset_id, t.id, t.slug, t.name, t.avatar_url FROM annotations an JOIN annotation_topics at ON at.annotation_id=an.id JOIN topics t ON t.id=at.topic_id
      JOIN assets a ON a.id=an.asset_id WHERE a.title_id=? AND a.season_number=? AND an.motivation!='clipping' ORDER BY t.name`).all(titleId, season)) {
      if (!own.has(row.asset_id)) own.set(row.asset_id, []);
      own.get(row.asset_id).push({ id: row.id, slug: row.slug, name: row.name, avatar_url: row.avatar_url });
    }
    return rows.map(row => ({
      ...assetSummary(row, row), downloaded: Boolean(row.file_path), topics: own.get(row.id) || [],
      like_count: db.prepare("SELECT coalesce(sum(count),0) count FROM asset_likes WHERE asset_id=?").get(row.id).count,
    }));
  };

  const presentTitle = title => {
    const next = nextUp(title.id);
    const downloaded = db.prepare("SELECT count(*) count FROM assets WHERE title_id=? AND file_path IS NOT NULL").get(title.id).count;
    const total = db.prepare("SELECT count(*) count FROM assets WHERE title_id=? AND (season_number IS NULL OR season_number>=1) AND availability!='unaired'").get(title.id).count;
    return {
      ...publicTitle(title), seasons: title.type === "show" ? publicSeasons(title.id) : [],
      nextUp: next ? { ...assetSummary(next.asset, next.progress), resume: next.resume, watched: next.watched, continuing: Boolean(next.continuing), downloaded: Boolean(next.asset.file_path) } : null,
      downloadedCount: downloaded, episodeCount: total,
    };
  };

  app.get("/api/v1/titles/:ref", handle(async (req, reply) => {
    const title = await resolveRef(decodeURIComponent(req.params.ref));
    if (!title) return reply.code(404).send({ error: "Title not found" });
    // A series needs its first season's episodes to know what to play next.
    if (title.type === "show" && getProvider("tmdb").configured && !db.prepare("SELECT 1 FROM assets WHERE title_id=? AND season_number>=1").get(title.id)) {
      const first = db.prepare("SELECT number FROM title_seasons WHERE title_id=? AND number>=1 ORDER BY number LIMIT 1").get(title.id);
      if (first) await ensureSeason(title.id, first.number, media().tmdb).catch(() => {});
    }
    return presentTitle(title);
  }));

  app.get("/api/v1/titles/:id/episodes", handle(async (req, reply) => {
    const title = getTitle(req.params.id);
    if (!title || title.type !== "show") return reply.code(404).send({ error: "Show not found" });
    const season = Number(req.query.season ?? 1);
    if (!Number.isInteger(season) || season < 0) return reply.code(400).send({ error: "Invalid season" });
    if (getProvider("tmdb").configured) { try { await ensureSeason(title.id, season, media().tmdb); } catch (error) { if (!episodeRows(title.id, season).length) throw error; } }
    return { season, episodes: episodeRows(title.id, season) };
  }));

  app.put("/api/v1/titles/:id/library", handle(async (req, reply) => {
    if (typeof req.body?.inLibrary !== "boolean") return reply.code(400).send({ error: "inLibrary must be true or false" });
    if (!getTitle(req.params.id)) return reply.code(404).send({ error: "Title not found" });
    const title = await setLibrary(req.params.id, req.body.inLibrary, { tmdb: getProvider("tmdb").configured ? media().tmdb : null, images: media().images });
    return presentTitle(title);
  }));

  app.put("/api/v1/titles/:id/anime", handle(async (req, reply) => {
    if (typeof req.body?.isAnime !== "boolean") return reply.code(400).send({ error: "isAnime must be true or false" });
    const title = setAnime(req.params.id, req.body.isAnime);
    if (!title) return reply.code(404).send({ error: "Title not found" });
    return presentTitle(title);
  }));

  app.post("/api/v1/titles/:id/refresh", handle(async (req, reply) => {
    const title = getTitle(req.params.id);
    if (!title) return reply.code(404).send({ error: "Title not found" });
    tmdbReady();
    const fresh = await openTitle(title.type, title.tmdb_id, media().tmdb, { refresh: true });
    if (fresh.type === "show") await ensureAllSeasons(fresh.id, media().tmdb, { force: true });
    return presentTitle(getTitle(fresh.id));
  }));

  // Tags on a whole movie or series also apply to all of its episodes.
  app.post("/api/v1/titles/:id/topics", handle(async (req, reply) => {
    const title = getTitle(req.params.id);
    if (!title) return reply.code(404).send({ error: "Title not found" });
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const { topic, code, error } = resolveTopic(req.body, timestamp, true);
      if (!topic) { db.exec("ROLLBACK"); return reply.code(code).send({ error }); }
      db.prepare("INSERT OR IGNORE INTO title_topics (title_id,topic_id,created_at) VALUES (?,?,?)").run(title.id, topic.id, timestamp);
      reindexTitleSearch(title.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { topics: publicTitle(getTitle(title.id)).topics };
  }));
  app.delete("/api/v1/titles/:id/topics/:topicId", handle(async (req, reply) => {
    if (!getTitle(req.params.id)) return reply.code(404).send({ error: "Title not found" });
    db.prepare("DELETE FROM title_topics WHERE title_id=? AND topic_id=?").run(req.params.id, req.params.topicId);
    reindexTitleSearch(req.params.id);
    return { topics: publicTitle(getTitle(req.params.id)).topics };
  }));

  const libraryCard = row => {
    const next = nextUp(row.id);
    const counts = row.type === "show" ? db.prepare(`SELECT count(*) total, sum(CASE WHEN cs.completed=1 OR (cs.progress_ms>=a.duration_ms*0.92) THEN 1 ELSE 0 END) watched FROM assets a
      LEFT JOIN consumption_state cs ON cs.asset_id=a.id AND cs.user_id=? WHERE a.title_id=? AND a.season_number>=1 AND a.availability!='unaired'`).get(userId, row.id) : null;
    return { ...publicTitle(row, { withTopics: false }), ref: row.id, watchedCount: counts?.watched || 0, episodeCount: counts?.total || 0, progressMs: next?.asset && next.resume ? next.progress?.progress_ms || 0 : 0, durationMs: next?.asset?.duration_ms || null, watched: Boolean(next?.watched && row.type === "movie") };
  };

  app.get("/api/v1/titles", handle(async req => {
    const { type, anime, sort, q, limit = 60, offset = 0 } = req.query;
    const rows = libraryTitles({ type: type === "movie" || type === "show" ? type : undefined, anime: anime === undefined ? undefined : anime === "1" || anime === "true", sort, q: q ? String(q) : undefined, limit: Math.min(Number(limit) || 60, 200), offset: Number(offset) || 0 });
    return rows.map(libraryCard);
  }));

  app.get("/api/v1/continue", handle(async req => {
    const { kind, limit = 20 } = req.query;
    const filter = kind === "anime" ? { anime: true } : kind === "movies" ? { type: "movie", anime: false } : kind === "shows" ? { type: "show", anime: false } : {};
    return continueWatching({ limit: Math.min(Number(limit) || 20, 50), ...filter });
  }));

  // --------------------------------------------------------------------------------------------
  // Playback: pick a source, report tracks, stream bytes

  const capsOf = body => Array.isArray(body?.caps) ? body.caps.filter(cap => typeof cap === "string").slice(0, 8) : [];

  app.post("/api/v1/assets/:id/stream", handle(async (req, reply) => {
    const id = req.params.id;
    if (!db.prepare("SELECT 1 FROM assets WHERE id=?").get(id)) return reply.code(404).send({ error: "Not found" });
    const { sources } = media();
    const work = sources.prepare(id, { sourceId: req.body?.sourceId, caps: capsOf(req.body), rediscover: Boolean(req.body?.rediscover) });
    work.catch(() => {});
    const waited = await within(work.then(result => ({ result }), error => ({ error })), 20_000, { pending: true });
    if (waited.pending) return reply.code(202).send({ status: "preparing", stage: sources.stage(id) });
    if (waited.error?.code === "downloading") return reply.code(202).send({ status: "preparing", stage: waited.error.message });
    if (waited.error) throw waited.error;
    const described = describePrepared(id, waited.result);
    if (described.needsExternalSubtitles) lookOnline(id, described);
    return described;
  }));

  // When the file has no subtitles in your language, fetch them in the background; the player picks them up when ready.
  function lookOnline(assetId, described) {
    if (!getProvider("opensubtitles").configured) return;
    const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
    const title = asset.title_id ? getTitle(asset.title_id) : null;
    const audio = described.audio.find(track => track.position === described.chosen.audioPosition)?.language;
    const language = getPlayback().subtitleLanguages.find(code => code !== audio);
    if (!language) return;
    const query = title ? { imdbId: title.imdb_id, season: title.type === "show" ? asset.season_number : undefined, episode: asset.episode_number, query: title.title, year: title.year } : { query: asset.title };
    media().subtitles.findExternal(assetId, null, language, query).then(row => row && media().subtitles.ensure(row.id)).catch(() => {});
  }

  app.get("/api/v1/assets/:id/sources", handle(async (req, reply) => {
    if (!db.prepare("SELECT 1 FROM assets WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Not found" });
    return { sources: media().sources.sources(req.params.id) };
  }));

  app.get("/api/v1/assets/:id/tracks", handle(async (req, reply) => {
    const result = await describeLocalTracks(req.params.id, { caps: String(req.query.caps || "").split(",").filter(Boolean) });
    if (!result) return reply.code(404).send({ error: "This video has no local file to read." });
    return result;
  }));

  const sourceInput = async assetId => {
    const asset = db.prepare("SELECT file_path FROM assets WHERE id=?").get(assetId);
    if (asset?.file_path && existsSync(asset.file_path)) return asset.file_path;
    return (await media().sources.streamUrl(assetId)).url;
  };

  const hls = createHlsSessions({ directory: join(generatedDir, "hls") });
  app.addHook("onClose", async () => hls.closeAll());
  app.get("/api/v1/hls/:session/:file", async (req, reply) => {
    const path = hls.file(req.params.session, req.params.file);
    if (!path) return reply.code(404).send({ error: "Stream not found" });
    const playlist = req.params.file.endsWith(".m3u8");
    reply.header("Content-Type", playlist ? "application/vnd.apple.mpegurl" : "video/mp4").header("Cache-Control", playlist ? "no-store" : "private, max-age=3600");
    return reply.send(createReadStream(path));
  });

  // Repackaged playback: chosen audio track and/or re-encoded video, starting at `start` seconds.
  async function remux(req, reply, assetId) {
    const start = Math.max(0, Number(req.query.start) || 0);
    const audio = Math.max(0, Math.min(Number(req.query.audio) || 0, 31));
    const video = req.query.video === "transcode" ? "transcode" : "copy";
    const input = await sourceInput(assetId);
    if (req.query.hls === "1") {
      const session = await hls.start({ input, start, audioPosition: audio, video, videoCodec: req.query.codec === "hevc" ? "hevc" : undefined });
      return reply.header("Cache-Control", "no-store").redirect(`/api/v1/hls/${session.id}/index.m3u8`, 302);
    }
    const job = startRemux({ input, start, audioPosition: audio, video, videoCodec: req.query.codec === "hevc" ? "hevc" : undefined });
    reply.raw.on("close", () => job.stop());
    reply.header("Content-Type", "video/mp4").header("Cache-Control", "no-store").header("X-Accel-Buffering", "no");
    return reply.send(job.stream);
  }

  // Streams a TorBox file to the browser with range support, refreshing the link when it has expired.
  async function proxy(req, reply, assetId) {
    const controller = new AbortController();
    reply.raw.on("close", () => controller.abort());
    const open = async force => {
      const { url, row } = await media().sources.streamUrl(assetId, { force });
      const headers = {};
      if (req.headers.range) headers.range = req.headers.range;
      const upstream = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
      return { upstream, row };
    };
    let { upstream, row } = await open(false);
    if ([401, 403, 404, 410].includes(upstream.status)) { await upstream.body?.cancel().catch(() => {}); ({ upstream, row } = await open(true)); }
    if (upstream.status >= 400 && upstream.status !== 416) { await upstream.body?.cancel().catch(() => {}); return reply.code(502).send({ error: "The stream is unavailable right now." }); }
    const type = row.file_name ? mime.lookup(row.file_name) : false;
    reply.code(upstream.status).header("Accept-Ranges", "bytes").header("Content-Type", type || upstream.headers.get("content-type") || "video/mp4").header("Cache-Control", "no-store");
    for (const name of ["content-length", "content-range"]) if (upstream.headers.get(name)) reply.header(name, upstream.headers.get(name));
    return reply.send(Readable.fromWeb(upstream.body));
  }

  // --------------------------------------------------------------------------------------------
  // Subtitles

  app.get("/api/v1/subtitles/:file", handle(async (req, reply) => {
    const id = req.params.file.replace(/\.vtt$/, "");
    const work = media().subtitles.ensure(id);
    if (!work) return reply.code(404).send({ error: "Subtitle not found" });
    const waited = await within(work, 120_000, null);
    if (!waited) return reply.code(202).header("Retry-After", "5").send({ status: "working" });
    if (waited.status === "unsupported") return reply.code(415).send({ error: "This subtitle format is image-based and cannot be shown." });
    if (waited.status !== "ready" || !waited.file_path || !existsSync(waited.file_path)) return reply.code(404).send({ error: waited.error || "Subtitle is unavailable" });
    reply.header("Content-Type", "text/vtt; charset=utf-8").header("Cache-Control", "public, max-age=86400");
    return reply.send(createReadStream(waited.file_path));
  }));

  // Looks a language up online (used when the file has none in your language).
  app.post("/api/v1/assets/:id/subtitles/search", handle(async (req, reply) => {
    const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(req.params.id);
    if (!asset) return reply.code(404).send({ error: "Not found" });
    const language = String(req.body?.language || getPlayback().subtitleLanguages[0]);
    if (!LANGUAGES.some(([code]) => code === language)) return reply.code(400).send({ error: "Unknown language" });
    if (!getProvider("opensubtitles").configured) return reply.code(400).send({ error: "Add your OpenSubtitles login in Settings → Streaming to search online." });
    const title = asset.title_id ? getTitle(asset.title_id) : null;
    const row = await media().subtitles.findExternal(asset.id, null, language, title
      ? { imdbId: title.imdb_id, season: title.type === "show" ? asset.season_number : undefined, episode: asset.episode_number, query: title.title, year: title.year }
      : { query: asset.title });
    if (!row) return reply.code(404).send({ error: "No subtitles were found for that language." });
    return { track: media().subtitles.rowTrack(row) };
  }));

  app.get("/api/v1/assets/:id/subtitles", handle(async req => {
    const selected = db.prepare("SELECT id FROM playback_sources WHERE asset_id=? AND status='selected'").get(req.params.id);
    const asset = db.prepare("SELECT file_path FROM assets WHERE id=?").get(req.params.id);
    return { subtitles: media().subtitles.tracks(req.params.id, asset?.file_path ? "local" : selected?.id) };
  }));

  // --------------------------------------------------------------------------------------------
  // Images

  app.get("/api/v1/images/tmdb/:size/:file", async (req, reply) => {
    const found = await media().images.get(req.params.size, `/${req.params.file}`).catch(() => null);
    if (!found) return reply.code(404).send();
    const { mtimeMs, size } = statSync(found.path);
    const etag = `"${size}-${Math.round(mtimeMs)}"`;
    reply.header("Cache-Control", "public, max-age=31536000, immutable").header("ETag", etag).header("Content-Type", found.contentType || "image/jpeg");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.send(createReadStream(found.path));
  });

  // --------------------------------------------------------------------------------------------
  // Settings

  const settingsPayload = () => ({
    providers: Object.keys(providerDefinitions).map(publicProvider), rules: getRules(), defaultRules, playback: getPlayback(), downloads: getDownloadSettings(),
    languages: LANGUAGES.map(([code, name]) => ({ code, name })),
    roots: db.prepare("SELECT id,name,absolute_path,read_only FROM library_roots ORDER BY name").all(),
  });
  app.get("/api/v1/media/settings", handle(async () => settingsPayload()));

  app.put("/api/v1/media/providers/:id", handle(async req => saveProvider(req.params.id, req.body || {})));

  app.post("/api/v1/media/providers/:id/test", handle(async (req, reply) => {
    const id = req.params.id;
    if (!providerDefinitions[id]) return reply.code(404).send({ error: "Unknown provider" });
    const provider = getProvider(id);
    if (!provider.configured && provider.definition.fields.some(field => field.required)) return reply.code(400).send({ error: "Save the required settings first." });
    const { tmdb, torbox, opensubs } = media();
    try {
      if (id === "tmdb") { tmdb.client.resetBreaker(); await tmdb.verify(); return { ok: true, message: "Connected to TMDB." }; }
      if (id === "torbox") { torbox.client.resetBreaker(); const account = await torbox.account(); return { ok: true, message: `Connected to TorBox${account.plan !== undefined ? ` (plan ${account.plan})` : ""}.` }; }
      if (id === "torrentio") { const base = (provider.config.baseUrl || "https://torrentio.strem.fun").replace(/\/+$/, ""); const response = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(15_000) }); return response.ok ? { ok: true, message: "Torrentio is reachable." } : reply.code(502).send({ error: `Torrentio responded ${response.status}.` }); }
      if (id === "nyaa") { const base = (provider.config.baseUrl || "https://nyaa.si").replace(/\/+$/, ""); const response = await fetch(`${base}/?page=rss&q=test`, { signal: AbortSignal.timeout(15_000) }); return response.ok ? { ok: true, message: "Nyaa is reachable." } : reply.code(502).send({ error: `Nyaa responded ${response.status}.` }); }
      if (id === "opensubtitles") { await opensubs.search({ imdbId: "tt0133093", language: "eng" }); return { ok: true, message: "OpenSubtitles accepted the key." }; }
    } catch (error) { return reply.code(error.statusCode === 401 ? 401 : 502).send({ error: error.message }); }
    return { ok: true };
  }));

  app.put("/api/v1/media/rules", handle(async req => saveRules(req.body || {})));
  app.post("/api/v1/media/rules/reset", handle(async () => resetRules()));
  app.put("/api/v1/media/playback", handle(async req => savePlayback(req.body || {})));
  app.put("/api/v1/media/downloads", handle(async req => saveDownloadSettings(req.body || {})));
  app.get("/api/v1/media/cache", handle(async () => {
    const clients = { tmdb: media().tmdb.client, torbox: media().torbox.client };
    const summary = cacheSummary();
    return { ...summary, providers: summary.providers.map(item => ({ ...item, stats: clients[item.provider]?.stats })) };
  }));
  app.delete("/api/v1/media/cache", handle(async () => { clearHttpCache(); return cacheSummary(); }));

  // --------------------------------------------------------------------------------------------
  // Downloads of movies and episodes into the chosen library folder

  function ensureDownloader() {
    if (!db.prepare("SELECT 1 FROM downloaders WHERE id=?").get(MEDIA_DOWNLOADER_ID)) {
      db.prepare("INSERT INTO downloaders (id,name,plugin,config_json,enabled,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(MEDIA_DOWNLOADER_ID, "Kiwi catalog", "kiwi-media", "{}", 1, 0, now(), now());
    }
  }

  function queueDownloads(assetIds) {
    const settings = getDownloadSettings();
    if (!settings.rootId) throw new ConfigError("Choose a download folder in Settings → Streaming first.");
    const unique = [...new Set(assetIds)];
    const queued = [], skipped = [];
    const plans = [];
    for (const id of unique) {
      const asset = db.prepare("SELECT a.*, t.type title_type, t.title show_title, t.is_anime FROM assets a JOIN titles t ON t.id=a.title_id WHERE a.id=?").get(id);
      if (!asset) { skipped.push({ id, reason: "not found" }); continue; }
      if (asset.file_path && existsSync(asset.file_path)) { skipped.push({ id, reason: "already saved" }); continue; }
      if (asset.availability === "unaired") { skipped.push({ id, reason: "not aired yet" }); continue; }
      if (db.prepare("SELECT 1 FROM downloads WHERE target_asset_id=? AND status IN ('queued','running','canceling')").get(id)) { skipped.push({ id, reason: "already queued" }); continue; }
      const folder = asset.is_anime ? settings.animeFolder : asset.title_type === "movie" ? settings.moviesFolder : settings.showsFolder;
      plans.push({ asset, folder });
    }
    if (!plans.length) return { queued, skipped };
    ensureDownloader();
    const first = destinationFor(settings.rootId, plans[0].folder);
    const blocked = downloadBlocker(first.root);
    if (blocked) throw new ConfigError(blocked);
    const start = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare(`INSERT INTO downloads (id,source,title,downloader_id,plugin,library_root_id,subfolder,vpn_mode,vpn_reason,status,message,topic_ids_json,target_asset_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      plans.forEach(({ asset, folder }, index) => {
        const id = randomUUID(), at = new Date(start + index).toISOString();
        const { subfolder } = destinationFor(settings.rootId, folder);
        const label = asset.title_type === "movie" ? asset.show_title : `${asset.show_title} S${String(asset.season_number).padStart(2, "0")}E${String(asset.episode_number).padStart(2, "0")}`;
        insert.run(id, `${MEDIA_SCHEME}${asset.id}`, label, MEDIA_DOWNLOADER_ID, "kiwi-media", settings.rootId, subfolder, "none", "Direct from TorBox", "queued", "Waiting to start", "[]", asset.id, at, at);
        queued.push({ id, assetId: asset.id });
      });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { queued, skipped };
  }

  app.post("/api/v1/assets/:id/download", handle(async (req, reply) => {
    if (!db.prepare("SELECT 1 FROM assets WHERE id=? AND title_id IS NOT NULL").get(req.params.id)) return reply.code(404).send({ error: "Only movies and episodes can be saved." });
    return reply.code(202).send(queueDownloads([req.params.id]));
  }));

  // Saves a whole season, the whole series, or a chosen set of episodes.
  app.post("/api/v1/titles/:id/download", handle(async (req, reply) => {
    const title = getTitle(req.params.id);
    if (!title) return reply.code(404).send({ error: "Title not found" });
    let ids;
    if (title.type === "movie") ids = db.prepare("SELECT id FROM assets WHERE title_id=?").all(title.id).map(row => row.id);
    else {
      if (getProvider("tmdb").configured) {
        if (Number.isInteger(req.body?.season)) await ensureSeason(title.id, req.body.season, media().tmdb);
        else await ensureAllSeasons(title.id, media().tmdb);
      }
      if (Array.isArray(req.body?.assetIds)) ids = req.body.assetIds.filter(id => typeof id === "string" && db.prepare("SELECT 1 FROM assets WHERE id=? AND title_id=?").get(id, title.id));
      else if (Number.isInteger(req.body?.season)) ids = db.prepare("SELECT id FROM assets WHERE title_id=? AND season_number=? ORDER BY episode_number").all(title.id, req.body.season).map(row => row.id);
      else ids = db.prepare("SELECT id FROM assets WHERE title_id=? AND season_number>=1 ORDER BY season_number, episode_number").all(title.id).map(row => row.id);
    }
    return reply.code(202).send(queueDownloads(ids));
  }));

  return { remux, proxy };
}
