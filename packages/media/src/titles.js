import { randomUUID } from "node:crypto";
import { db, ensureTopic, reindexTitleSearch } from "@kiwi/database";
import { imageUrl } from "./images.js";
import { iso3 } from "./tmdb.js";

const now = () => new Date().toISOString();
const pad = value => String(value).padStart(2, "0");
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const userId = "user-local";

export const movieAssetId = titleId => `${titleId}-movie`;
export const episodeAssetId = (titleId, season, episode) => `${titleId}-s${pad(season)}e${pad(episode)}`;
// Episodes at 92% or beyond count as watched, since credits are usually skipped.
export const WATCHED_FRACTION = 0.92;

function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export const getTitle = id => db.prepare("SELECT * FROM titles WHERE id=?").get(id);
export const findTitle = (type, tmdbId) => db.prepare("SELECT * FROM titles WHERE type=? AND tmdb_id=?").get(type, tmdbId);

// Artwork lists used when a title joins the library, so its posters and stills are ready offline.
export function titleArtwork(title, { stills = true } = {}) {
  const items = [];
  if (title.poster_path) items.push({ size: "w342", file: title.poster_path }, { size: "w500", file: title.poster_path });
  if (title.backdrop_path) items.push({ size: "w780", file: title.backdrop_path }, { size: "w1280", file: title.backdrop_path });
  if (title.logo_path) items.push({ size: "w500", file: title.logo_path });
  if (stills) for (const row of db.prepare("SELECT still_path FROM assets WHERE title_id=? AND still_path IS NOT NULL").all(title.id)) items.push({ size: "w300", file: row.still_path });
  return items;
}

function defaultRuntime(details) {
  if (details.runtimeMin) return details.runtimeMin;
  return details.type === "movie" ? 100 : details.isAnime ? 24 : 42;
}

// Genres, services, and the Anime label become ordinary tags. Tags you added yourself are never touched.
function applyAutoTopics(titleId, details) {
  const wanted = new Map();
  for (const genre of details.genres) wanted.set(`genre:${genre.toLowerCase()}`, { name: genre, type: "genre" });
  for (const service of details.services) wanted.set(`service:${service.name.toLowerCase()}`, { name: service.name, type: "service", avatarUrl: imageUrl(service.logoPath, "w92") });
  if (details.isAnime) wanted.set("genre:anime", { name: "Anime", type: "genre" });
  const row = getTitle(titleId);
  const metadata = parse(row.metadata_json, {});
  const previous = new Set(metadata.autoTopics || []);
  const current = new Set();
  const timestamp = now();
  for (const spec of wanted.values()) {
    const topic = ensureTopic(spec);
    if (!topic) continue;
    current.add(topic.id);
    db.prepare("INSERT OR IGNORE INTO title_topics (title_id,topic_id,created_at) VALUES (?,?,?)").run(titleId, topic.id, timestamp);
  }
  for (const topicId of previous) if (!current.has(topicId)) db.prepare("DELETE FROM title_topics WHERE title_id=? AND topic_id=?").run(titleId, topicId);
  metadata.autoTopics = [...current];
  db.prepare("UPDATE titles SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), titleId);
}

// Inserts or refreshes a title from provider details. Library membership and your own tags are preserved.
export function upsertTitle(details) {
  const timestamp = now();
  return transaction(() => {
    let row = findTitle(details.type, details.tmdbId);
    const metadata = parse(row?.metadata_json, {});
    const isAnime = metadata.animeOverride !== undefined ? Number(metadata.animeOverride) : Number(details.isAnime);
    const values = [
      isAnime, details.title, details.originalTitle, details.year, details.overview, details.tagline, details.status, defaultRuntime({ ...details, isAnime }),
      details.rating, details.voteCount, details.certification, details.posterPath, details.backdropPath, details.logoPath, details.firstAirDate, details.lastAirDate,
      iso3(details.originalLanguage) || details.originalLanguage, JSON.stringify(details.originCountries), JSON.stringify(details.genres),
      JSON.stringify(details.services.map(service => ({ name: service.name, logo: service.logoPath }))), JSON.stringify(details.aliases),
      details.tmdbId, details.imdbId, details.tvdbId,
    ];
    if (row) {
      db.prepare(`UPDATE titles SET is_anime=?,title=?,original_title=?,year=?,overview=?,tagline=?,status=?,runtime_min=?,rating=?,vote_count=?,certification=?,
        poster_path=?,backdrop_path=?,logo_path=?,first_air_date=?,last_air_date=?,original_language=?,origin_countries_json=?,genres_json=?,services_json=?,aliases_json=?,
        tmdb_id=?,imdb_id=?,tvdb_id=?,synced_at=?,updated_at=? WHERE id=?`).run(...values, timestamp, timestamp, row.id);
    } else {
      const id = randomUUID();
      db.prepare(`INSERT INTO titles (is_anime,title,original_title,year,overview,tagline,status,runtime_min,rating,vote_count,certification,poster_path,backdrop_path,logo_path,
        first_air_date,last_air_date,original_language,origin_countries_json,genres_json,services_json,aliases_json,tmdb_id,imdb_id,tvdb_id,id,type,synced_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values, id, details.type, timestamp, timestamp, timestamp);
      row = getTitle(id);
    }
    db.prepare("DELETE FROM title_seasons WHERE title_id=?").run(row.id);
    const insertSeason = db.prepare("INSERT INTO title_seasons (title_id,number,name,overview,poster_path,air_date,episode_count) VALUES (?,?,?,?,?,?,?)");
    for (const season of details.seasons) insertSeason.run(row.id, season.number, season.name, season.overview, season.posterPath, season.airDate, season.episodeCount);
    // Cast is display-only, so it lives in the title's metadata rather than its own table.
    const stored = parse(getTitle(row.id).metadata_json, {});
    stored.cast = details.cast.map(person => ({ name: person.name, character: person.character, profile: person.profilePath }));
    db.prepare("UPDATE titles SET metadata_json=? WHERE id=?").run(JSON.stringify(stored), row.id);
    if (details.type === "movie") ensureMovieAsset(getTitle(row.id));
    applyAutoTopics(row.id, details);
    reindexTitleSearch(row.id);
    return getTitle(row.id);
  });
}

export function ensureMovieAsset(title) {
  const id = movieAssetId(title.id), timestamp = now();
  const duration = (title.runtime_min || 100) * 60_000;
  const thumbnail = imageUrl(title.backdrop_path, "w780") || imageUrl(title.poster_path, "w500");
  if (db.prepare("SELECT 1 FROM assets WHERE id=?").get(id)) {
    db.prepare("UPDATE assets SET title=?,description=?,thumbnail_url=?,duration_ms=?,still_path=?,air_date=?,updated_at=? WHERE id=?")
      .run(title.title, title.overview, thumbnail, duration, title.backdrop_path, title.first_air_date, timestamp, id);
  } else {
    db.prepare("INSERT INTO assets (id,kind,title,description,thumbnail_url,duration_ms,added_at,updated_at,visibility,title_id,still_path,air_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "video", title.title, title.overview, thumbnail, duration, timestamp, timestamp, "private", title.id, title.backdrop_path, title.first_air_date);
  }
  return id;
}

// Where a season's first episode falls in absolute numbering: the episodes of every earlier regular season.
export function absoluteOffset(titleId, season) {
  return db.prepare("SELECT coalesce(sum(episode_count),0) total FROM title_seasons WHERE title_id=? AND number>=1 AND number<?").get(titleId, season).total;
}

export function upsertSeasonEpisodes(titleId, season, numbering = {}) {
  const title = getTitle(titleId);
  const timestamp = now(), today = timestamp.slice(0, 10);
  const offset = season.number >= 1 ? absoluteOffset(titleId, season.number) : null;
  const find = db.prepare("SELECT availability, metadata_json FROM assets WHERE id=?");
  const insert = db.prepare(`INSERT INTO assets (id,kind,title,description,thumbnail_url,duration_ms,added_at,updated_at,visibility,title_id,season_number,episode_number,absolute_number,air_date,still_path,availability)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare("UPDATE assets SET title=?,description=?,thumbnail_url=?,duration_ms=?,season_number=?,episode_number=?,absolute_number=?,air_date=?,still_path=?,availability=?,updated_at=? WHERE id=?");
  transaction(() => {
    for (const episode of season.episodes) {
      const id = episodeAssetId(titleId, season.number, episode.number);
      const alias = numbering[`${season.number}:${episode.number}`] || null;
      const thumbnail = imageUrl(episode.stillPath, "w300") || imageUrl(title.backdrop_path, "w780") || imageUrl(title.poster_path, "w342");
      const aired = !episode.airDate || episode.airDate <= today;
      const existing = find.get(id);
      const stored = existing ? parse(existing.metadata_json, {}) : {};
      const probed = stored.probedDuration;
      const runtime = (episode.runtimeMin || title.runtime_min || 42) * 60_000;
      const absolute = offset === null ? null : offset + episode.number;
      const availability = !aired ? "unaired" : existing && existing.availability !== "unaired" ? existing.availability : "unknown";
      const args = [episode.name, episode.overview, thumbnail, probed || runtime, season.number, episode.number, absolute, episode.airDate, episode.stillPath, availability];
      if (existing) {
        update.run(...args, timestamp, id);
        if (alias || stored.numbering) db.prepare("UPDATE assets SET metadata_json=? WHERE id=?").run(JSON.stringify({ ...stored, numbering: alias || undefined }), id);
      } else insert.run(id, "video", ...args.slice(0, 3), args[3], timestamp, timestamp, "private", titleId, season.number, episode.number, absolute, episode.airDate, episode.stillPath, availability);
      if (!existing && alias) db.prepare("UPDATE assets SET metadata_json=? WHERE id=?").run(JSON.stringify({ numbering: alias }), id);
    }
    const metadata = parse(getTitle(titleId).metadata_json, {});
    metadata.seasonsSynced = { ...(metadata.seasonsSynced || {}), [season.number]: timestamp };
    db.prepare("UPDATE titles SET metadata_json=?,episodes_synced_at=? WHERE id=?").run(JSON.stringify(metadata), timestamp, titleId);
  });
}

export const seasonSyncedAt = (title, number) => parse(title.metadata_json, {}).seasonsSynced?.[number] || null;

// Makes sure a season's episodes exist and are fresh; refreshes every 12 hours at most.
export async function ensureSeason(titleId, number, tmdb, { force = false } = {}) {
  const title = getTitle(titleId);
  if (!title || title.type !== "show") return false;
  const at = seasonSyncedAt(title, number);
  if (!force && at && Date.now() - Date.parse(at) < 12 * 3600_000) return false;
  const numbering = title.is_anime ? await ensureNumbering(title, tmdb) : {};
  upsertSeasonEpisodes(titleId, await tmdb.season(title.tmdb_id, number), numbering);
  return true;
}

// Alternate (TVDB-style) season and episode numbers for anime, fetched once per title.
async function ensureNumbering(title, tmdb) {
  const metadata = parse(title.metadata_json, {});
  if (metadata.numbering && Date.now() - Date.parse(metadata.numbering.at) < 7 * 86_400_000) return metadata.numbering.map;
  let result = { group: null, map: {} };
  try { result = await tmdb.numbering(title.tmdb_id); } catch { return metadata.numbering?.map || {}; }
  const fresh = parse(getTitle(title.id).metadata_json, {});
  fresh.numbering = { group: result.group, map: result.map, at: now() };
  db.prepare("UPDATE titles SET metadata_json=? WHERE id=?").run(JSON.stringify(fresh), title.id);
  return result.map;
}

export async function ensureAllSeasons(titleId, tmdb, options) {
  const numbers = db.prepare("SELECT number FROM title_seasons WHERE title_id=? ORDER BY number").all(titleId).map(row => row.number);
  const queue = [...numbers];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let number = queue.shift(); number !== undefined; number = queue.shift()) await ensureSeason(titleId, number, tmdb, options);
  }));
}

// Fetches (or reuses) a title by provider id. Titles stay out of the library until you add them.
export async function openTitle(type, tmdbId, tmdb, { refresh = false } = {}) {
  const existing = findTitle(type, tmdbId);
  const stale = !existing?.synced_at || Date.now() - Date.parse(existing.synced_at) > 12 * 3600_000;
  if (existing && !refresh && !stale) return existing;
  try { return upsertTitle(await tmdb.details(type, tmdbId)); }
  catch (error) { if (existing) return existing; throw error; }
}

export async function setLibrary(titleId, inLibrary, { tmdb, images } = {}) {
  const title = getTitle(titleId);
  if (!title) return null;
  if (inLibrary) {
    if (title.type === "show" && tmdb) await ensureAllSeasons(titleId, tmdb);
    db.prepare("UPDATE titles SET in_library=1,library_added_at=coalesce(library_added_at,?),updated_at=? WHERE id=?").run(now(), now(), titleId);
    images?.prefetch(titleArtwork(getTitle(titleId)), { pin: true }).catch(() => {});
  } else {
    db.prepare("UPDATE titles SET in_library=0,library_added_at=NULL,updated_at=? WHERE id=?").run(now(), titleId);
    images?.unpin(titleArtwork(title));
  }
  return getTitle(titleId);
}

export function setAnime(titleId, isAnime) {
  const title = getTitle(titleId);
  if (!title) return null;
  const metadata = parse(title.metadata_json, {});
  metadata.animeOverride = Boolean(isAnime);
  db.prepare("UPDATE titles SET is_anime=?,metadata_json=?,updated_at=? WHERE id=?").run(Number(isAnime), JSON.stringify(metadata), now(), titleId);
  const details = { genres: parse(title.genres_json, []), services: parse(title.services_json, []).map(service => ({ name: service.name, logoPath: service.logo })), isAnime: Boolean(isAnime) };
  applyAutoTopics(titleId, details);
  reindexTitleSearch(titleId);
  return getTitle(titleId);
}

// ---------------------------------------------------------------------------------------------------
// Presentation

const isWatched = (row, durationMs) => Boolean(row?.completed) || Boolean(row?.progress_ms && durationMs && row.progress_ms >= durationMs * WATCHED_FRACTION);

export function publicTitle(row, { withTopics = true } = {}) {
  const topics = withTopics ? db.prepare(`SELECT t.id,t.slug,t.name,t.avatar_url,t.topic_type FROM topics t JOIN title_topics tt ON tt.topic_id=t.id WHERE tt.title_id=? ORDER BY t.name`).all(row.id) : undefined;
  return {
    id: row.id, type: row.type, isAnime: Boolean(row.is_anime), title: row.title, originalTitle: row.original_title, year: row.year, overview: row.overview,
    tagline: row.tagline, status: row.status, runtimeMin: row.runtime_min, rating: row.rating, certification: row.certification,
    genres: parse(row.genres_json, []), services: parse(row.services_json, []).map(service => ({ name: service.name, logo: imageUrl(service.logo, "w92") })),
    poster: imageUrl(row.poster_path, "w342"), posterLarge: imageUrl(row.poster_path, "w500"), backdrop: imageUrl(row.backdrop_path, "w1280"), backdropSmall: imageUrl(row.backdrop_path, "w780"),
    logo: imageUrl(row.logo_path, "w500"), cast: parse(row.metadata_json, {}).cast?.map(person => ({ ...person, profile: imageUrl(person.profile, "w185") })) || [], inLibrary: Boolean(row.in_library), tmdbId: row.tmdb_id, imdbId: row.imdb_id, originalLanguage: row.original_language,
    firstAirDate: row.first_air_date, lastAirDate: row.last_air_date, ...(topics ? { topics } : {}),
  };
}

export const publicSeasons = titleId => db.prepare("SELECT number,name,overview,poster_path,air_date,episode_count FROM title_seasons WHERE title_id=? ORDER BY (number=0), number").all(titleId)
  .map(season => ({ number: season.number, name: season.name, overview: season.overview, poster: imageUrl(season.poster_path, "w185"), airDate: season.air_date, episodeCount: season.episode_count }));

const progressFor = id => db.prepare("SELECT progress_ms, completed, last_viewed_at FROM consumption_state WHERE user_id=? AND asset_id=?").get(userId, id);

// The next thing to play for a title: the unfinished episode you were in, else the first unwatched aired episode.
export function nextUp(titleId) {
  const title = getTitle(titleId);
  if (!title) return null;
  if (title.type === "movie") {
    const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(movieAssetId(titleId));
    const progress = progressFor(asset.id);
    return { asset, progress, resume: Boolean(progress?.progress_ms) && !isWatched(progress, asset.duration_ms), watched: isWatched(progress, asset.duration_ms) };
  }
  const episodes = db.prepare(`SELECT a.*, cs.progress_ms, cs.completed, cs.last_viewed_at FROM assets a
    LEFT JOIN consumption_state cs ON cs.asset_id=a.id AND cs.user_id=?
    WHERE a.title_id=? AND a.season_number>=1 AND a.availability!='unaired' ORDER BY a.season_number, a.episode_number`).all(userId, titleId);
  if (!episodes.length) return null;
  const recent = episodes.filter(episode => episode.last_viewed_at).sort((a, b) => b.last_viewed_at.localeCompare(a.last_viewed_at))[0];
  if (recent && !isWatched(recent, recent.duration_ms) && recent.progress_ms > 0) return { asset: recent, progress: recent, resume: true, watched: false };
  const after = recent ? episodes[episodes.indexOf(recent) + 1] : null;
  const firstUnwatched = after || episodes.find(episode => !isWatched(episode, episode.duration_ms));
  if (!firstUnwatched) return { asset: episodes[0], progress: null, resume: false, watched: true };
  return { asset: firstUnwatched, progress: null, resume: false, watched: false, continuing: Boolean(recent) };
}

export function nextEpisodeAfter(assetId) {
  const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
  if (!asset?.title_id || asset.season_number == null || asset.season_number < 1) return null;
  return db.prepare(`SELECT * FROM assets WHERE title_id=? AND season_number>=1 AND availability!='unaired' AND (season_number>? OR (season_number=? AND episode_number>?))
    ORDER BY season_number, episode_number LIMIT 1`).get(asset.title_id, asset.season_number, asset.season_number, asset.episode_number) || null;
}

export function previousEpisodeBefore(assetId) {
  const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
  if (!asset?.title_id || asset.season_number == null || asset.season_number < 1) return null;
  return db.prepare(`SELECT * FROM assets WHERE title_id=? AND season_number>=1 AND (season_number<? OR (season_number=? AND episode_number<?))
    ORDER BY season_number DESC, episode_number DESC LIMIT 1`).get(asset.title_id, asset.season_number, asset.season_number, asset.episode_number) || null;
}

// "Continue watching": one entry per title, most recently watched first.
export function continueWatching({ limit = 20, anime, type } = {}) {
  const rows = db.prepare(`SELECT a.title_id, cs.last_viewed_at FROM consumption_state cs JOIN assets a ON a.id=cs.asset_id
    WHERE cs.user_id=? AND a.title_id IS NOT NULL AND cs.last_viewed_at IS NOT NULL ORDER BY cs.last_viewed_at DESC LIMIT 400`).all(userId);
  const seen = new Set(), entries = [];
  for (const row of rows) {
    if (seen.has(row.title_id)) continue;
    seen.add(row.title_id);
    const title = getTitle(row.title_id);
    if (!title || (type && title.type !== type) || (anime !== undefined && Boolean(title.is_anime) !== anime)) continue;
    const next = nextUp(title.id);
    if (!next || next.watched) continue;
    entries.push({ title: publicTitle(title, { withTopics: false }), asset: assetSummary(next.asset, next.progress), resume: next.resume, lastViewedAt: row.last_viewed_at });
    if (entries.length >= limit) break;
  }
  return entries;
}

export function assetSummary(row, progress) {
  const p = progress || progressFor(row.id);
  return {
    id: row.id, title: row.title, description: row.description, season: row.season_number, episode: row.episode_number, absolute: row.absolute_number, airDate: row.air_date,
    durationMs: row.duration_ms, thumbnail: row.thumbnail_url, availability: row.availability, titleId: row.title_id,
    progressMs: p?.progress_ms || 0, watched: isWatched(p, row.duration_ms), lastViewedAt: p?.last_viewed_at || null,
  };
}

export function libraryTitles({ type, anime, sort = "added", limit = 60, offset = 0, q } = {}) {
  const filters = ["in_library=1"], params = [];
  if (type) { filters.push("type=?"); params.push(type); }
  if (anime !== undefined) { filters.push("is_anime=?"); params.push(Number(anime)); }
  if (q) { filters.push("lower(title) LIKE ?"); params.push(`%${q.toLowerCase()}%`); }
  const order = { added: "library_added_at DESC", title: "title COLLATE NOCASE", year: "year DESC, title", rating: "rating DESC" }[sort] || "library_added_at DESC";
  return db.prepare(`SELECT * FROM titles WHERE ${filters.join(" AND ")} ORDER BY ${order}, id LIMIT ? OFFSET ?`).all(...params, limit, offset);
}

// Removes catalog entries that were only browsed: not in the library, never watched, tagged, or liked.
export function pruneStubs({ olderThanDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT t.id FROM titles t WHERE t.in_library=0 AND t.updated_at<? AND NOT EXISTS (
      SELECT 1 FROM assets a LEFT JOIN consumption_state cs ON cs.asset_id=a.id LEFT JOIN asset_likes l ON l.asset_id=a.id LEFT JOIN annotations an ON an.asset_id=a.id
      LEFT JOIN saved_assets sa ON sa.asset_id=a.id
      WHERE a.title_id=t.id AND (cs.asset_id IS NOT NULL OR l.asset_id IS NOT NULL OR an.id IS NOT NULL OR sa.asset_id IS NOT NULL OR a.file_path IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM title_topics tt WHERE tt.title_id=t.id AND tt.topic_id NOT IN (SELECT value FROM json_each(coalesce(json_extract(t.metadata_json,'$.autoTopics'),'[]'))))`).all(cutoff);
  for (const row of rows) {
    db.prepare("DELETE FROM search_index WHERE entity_type='title' AND entity_id=?").run(row.id);
    db.prepare("DELETE FROM titles WHERE id=?").run(row.id);
  }
  return rows.length;
}
