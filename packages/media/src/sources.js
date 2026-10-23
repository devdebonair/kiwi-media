import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { db } from "@kiwi/database";
import { dedupeCandidates, parseCandidate } from "./indexers.js";
import { rankCandidates, scoreCandidate } from "./ranking.js";
import { getPlayback, getProvider, getRules } from "./settings.js";
import { chooseTracks, playbackPlan, probe as probeFile } from "./tracks.js";

const now = () => new Date().toISOString();
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const LINK_TTL = 40 * 60_000;
// Stored releases older than this are still tried first, but a fresh search follows if none of them opens.
const CANDIDATE_TTL = 6 * 3600_000;
const FAILED_TTL = 24 * 3600_000;
// How often the background check looks again for an episode it found nothing for.
const RECHECK_UNAVAILABLE = 24 * 3600_000;
// Once one indexer has answered with releases, the others get this long to catch up (Nyaa can take seconds).
const INDEXER_GRACE = 1_500;
const MAX_STORED = 12;
const MAX_ATTEMPTS = 3;

export class SourceError extends Error {
  constructor(message, { status = 502, code = "unavailable" } = {}) { super(message); this.name = "SourceError"; this.statusCode = status; this.code = code; }
}

export function targetFor(asset, title) {
  if (title.type === "movie") return { type: "movie", names: [title.title, title.original_title, ...parse(title.aliases_json, [])].filter(Boolean), year: title.year };
  const numbering = parse(asset.metadata_json, {}).numbering;
  return { type: "episode", season: asset.season_number, episode: asset.episode_number, absolute: asset.absolute_number, isAnime: Boolean(title.is_anime), aliases: numbering ? [numbering] : [] };
}

export function rankingContext(title, target) {
  const names = [title.title, title.original_title, ...parse(title.aliases_json, [])].filter(Boolean);
  return {
    rules: getRules(), playback: getPlayback(), target,
    title: { names, year: title.year, runtimeMin: title.runtime_min, originalLanguage: title.original_language || "eng", isAnime: Boolean(title.is_anime) },
  };
}

export const describeSource = row => {
  const stored = parse(row.parsed_json, {});
  const parsed = stored.parsed || {};
  return {
    id: row.id, status: row.status, selected: row.status === "selected", releaseName: row.release_name, fileName: row.file_name, size: row.file_size,
    resolution: parsed.resolution || null, source: parsed.source || null, codec: parsed.codec || null, group: parsed.group || null, hdr: parsed.hdr || (parsed.dolbyVision ? "dv" : null),
    dualAudio: Boolean(parsed.dualAudio || parsed.multi), seeders: row.seeders, cached: Boolean(row.cached), indexer: row.indexer, score: row.score,
    reasons: stored.reasons || [], failReason: row.fail_reason,
  };
};

// Answers when every search has settled, or shortly after the first one returns releases.
async function settleWithGrace(promises, graceMs) {
  const results = promises.map(() => ({ status: "rejected", pending: true, reason: new Error("Still searching") }));
  let release;
  const early = new Promise(resolve => { release = resolve; });
  let timer = null;
  const all = Promise.all(promises.map((promise, index) => promise.then(value => {
    results[index] = { status: "fulfilled", value };
    if (value?.length && !timer) timer = setTimeout(release, graceMs);
  }, reason => { results[index] = { status: "rejected", reason }; })));
  await Promise.race([all, early]);
  clearTimeout(timer);
  return results;
}

// `inputFor(sourceId, url)` gives readers (ffprobe, ffmpeg) the address to open for a source; by default the
// remote link itself, in the app the local stream cache in front of it.
export function createSourceService({ torbox, indexers = [], probeImpl = probeFile, inputFor = (sourceId, url) => url, indexerGraceMs = INDEXER_GRACE, log = () => {} } = {}) {
  const links = new Map();
  const linking = new Map();
  const stages = new Map();
  const running = new Map();
  const getAsset = id => db.prepare("SELECT * FROM assets WHERE id=?").get(id);
  const getTitleRow = id => db.prepare("SELECT * FROM titles WHERE id=?").get(id);
  const setStage = (assetId, text) => { stages.set(assetId, text); };

  async function runIndexers(asset, title, target) {
    const names = [title.title, title.original_title, ...parse(title.aliases_json, [])].filter(Boolean);
    const query = { type: title.type, imdbId: title.imdb_id, season: asset.season_number, episode: asset.episode_number, absolute: asset.absolute_number, aliases: target.aliases || [], names, year: title.year };
    const enabled = indexers.filter(indexer => getProvider(indexer.id).enabled && (indexer.id !== "nyaa" || title.is_anime));
    const settled = await settleWithGrace(enabled.map(indexer => indexer.search(query)), indexerGraceMs);
    const candidates = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") candidates.push(...result.value);
      else if (!result.pending) log(`${enabled[index].id} search failed: ${result.reason?.message}`);
    });
    if (!candidates.length && settled.length && settled.every(result => result.status === "rejected")) throw new SourceError("Could not reach the release indexers. Try again in a moment.", { status: 502 });
    return dedupeCandidates(candidates).map(candidate => ({ ...candidate, parsed: parseCandidate(candidate.releaseName, candidate.fileName) }));
  }

  // Finds releases, drops the unusable ones, confirms the rest on TorBox, and stores the best few.
  async function discover(asset, title) {
    const target = targetFor(asset, title);
    const context = rankingContext(title, target);
    setStage(asset.id, "Searching for releases…");
    const found = await runIndexers(asset, title, target);
    const failed = new Set(db.prepare("SELECT info_hash FROM playback_sources WHERE asset_id=? AND status='failed' AND updated_at>?").all(asset.id, new Date(Date.now() - FAILED_TTL).toISOString()).map(row => row.info_hash));
    // First pass ignores availability so only plausible releases are sent to TorBox.
    const preliminary = rankCandidates(found.filter(candidate => !failed.has(candidate.infoHash)), { ...context, rules: { ...context.rules, requireCached: false } }).accepted.slice(0, 40);
    setStage(asset.id, `Checking ${preliminary.length} releases on TorBox…`);
    const cached = preliminary.length ? await torbox.checkCached(preliminary.map(candidate => candidate.infoHash)) : new Map();
    const checked = preliminary.map(candidate => ({ ...candidate, cached: cached.has(candidate.infoHash) }));
    let { accepted } = rankCandidates(checked, context);
    if (!accepted.length && context.rules.requireCached === false) accepted = [];
    return { accepted: accepted.slice(0, MAX_STORED), considered: found.length, cachedCount: checked.filter(item => item.cached).length };
  }

  function store(asset, accepted) {
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM playback_sources WHERE asset_id=? AND status IN ('candidate','selected')").run(asset.id);
      const insert = db.prepare(`INSERT INTO playback_sources (id,asset_id,kind,info_hash,release_name,file_name,file_size,parsed_json,score,cached,seeders,indexer,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const candidate of accepted) insert.run(randomUUID(), asset.id, "torbox", candidate.infoHash, candidate.releaseName ?? null, candidate.fileName ?? null, candidate.size ?? null,
        JSON.stringify({ parsed: candidate.parsed, reasons: candidate.reasons, match: candidate.match }), candidate.score, Number(Boolean(candidate.cached)), candidate.seeders ?? 0, candidate.indexer ?? null, "candidate", timestamp, timestamp);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  const candidatesFor = assetId => db.prepare("SELECT * FROM playback_sources WHERE asset_id=? AND status IN ('candidate','selected') ORDER BY (status='selected') DESC, score DESC, seeders DESC").all(assetId);
  const isFresh = rows => rows.some(row => Date.now() - Date.parse(row.created_at) < CANDIDATE_TTL);

  async function resolveRow(asset, title, row, { allowUncached }) {
    const target = targetFor(asset, title);
    setStage(asset.id, "Preparing your stream…");
    const opened = await torbox.open(row.info_hash, target, { torrentId: row.torbox_id, fileName: row.file_name, onlyIfCached: !allowUncached, name: row.release_name });
    const torrent = opened;
    const url = await torbox.requestDownload(torrent.torrentId, torrent.file.id);
    links.set(row.id, { url, expiresAt: Date.now() + LINK_TTL });
    return { url, torrentId: torrent.torrentId, file: torrent.file };
  }

  // A working link for a stored source, reusing the current one until shortly before it expires.
  function linkFor(sourceId, { force = false } = {}) {
    const cached = links.get(sourceId);
    if (!force && cached && cached.expiresAt > Date.now() + 60_000) return Promise.resolve(cached.url);
    if (!linking.has(sourceId)) {
      linking.set(sourceId, (async () => {
        const row = db.prepare("SELECT * FROM playback_sources WHERE id=?").get(sourceId);
        if (!row) throw new SourceError("That source is no longer available.", { status: 404, code: "not-found" });
        const asset = getAsset(row.asset_id), title = getTitleRow(asset.title_id);
        const resolved = await resolveRow(asset, title, row, { allowUncached: false });
        db.prepare("UPDATE playback_sources SET torbox_id=?,torbox_file_id=?,updated_at=? WHERE id=?").run(resolved.torrentId, resolved.file.id, now(), row.id);
        return resolved.url;
      })().finally(() => linking.delete(sourceId)));
    }
    return linking.get(sourceId);
  }

  function fail(row, reason) {
    db.prepare("UPDATE playback_sources SET status='failed',fail_reason=?,updated_at=? WHERE id=?").run(String(reason).slice(0, 300), now(), row.id);
    links.delete(row.id);
  }

  function notePlayable(asset, info) {
    const stored = parse(asset.metadata_json, {});
    let duration = asset.duration_ms;
    if (info.durationMs && Math.abs(info.durationMs - asset.duration_ms) / asset.duration_ms > 0.02) { duration = info.durationMs; stored.probedDuration = info.durationMs; }
    db.prepare("UPDATE assets SET availability='ready',duration_ms=?,width=?,height=?,metadata_json=?,updated_at=? WHERE id=?")
      .run(duration, info.video?.width ?? null, info.video?.height ?? null, JSON.stringify(stored), now(), asset.id);
  }

  async function prepareInner(assetId, { sourceId, caps = [], rediscover = false } = {}) {
    const asset = getAsset(assetId);
    if (!asset) throw new SourceError("Not found", { status: 404, code: "not-found" });
    const title = asset.title_id ? getTitleRow(asset.title_id) : null;
    const playback = getPlayback();
    const rules = getRules();

    // A downloaded copy always wins: no network, no waiting.
    if (asset.file_path && existsSync(asset.file_path)) {
      setStage(assetId, "Reading the file…");
      const info = await probeImpl(asset.file_path).catch(() => null);
      const chosen = info ? chooseTracks(info, playback) : { audio: null, subtitle: null };
      return { status: "ready", origin: "local", info, chosen, plan: info ? playbackPlan(info, chosen, { caps }) : { mode: "direct" } };
    }
    if (!title) throw new SourceError("This item has no streaming source.", { status: 404, code: "no-source" });
    if (!getProvider("torbox").configured) throw new SourceError("Add your TorBox API key in Settings → Streaming to play movies and shows.", { status: 400, code: "not-configured" });

    const search = async () => {
      const result = await discover(asset, title);
      if (!result.accepted.length) {
        db.prepare("UPDATE assets SET availability='unavailable',updated_at=? WHERE id=?").run(now(), assetId);
        throw new SourceError(result.considered
          ? `Found ${result.considered} releases but none is available instantly in your quality range. Loosen the rules in Settings or try again later.`
          : "No releases were found for this title yet.", { status: 404, code: "no-source" });
      }
      store(asset, result.accepted);
      return candidatesFor(assetId);
    };
    // Stored releases are tried first even when old; a fresh search only happens if none of them opens.
    let rows = sourceId ? candidatesFor(assetId).filter(row => row.id === sourceId) : rediscover ? [] : candidatesFor(assetId);
    if (sourceId && rows.length) db.prepare("UPDATE playback_sources SET status='candidate' WHERE asset_id=? AND status='selected'").run(assetId);
    let searched = !rows.length;
    if (!rows.length) rows = await search();

    for (;;) {
      try { return await openBest(asset, title, rows, { playback, rules, caps }); } catch (error) {
        if (searched || sourceId || isFresh(rows) || error.code === "downloading" || error.code === "rate-limited" || error.code === "not-configured") throw error;
        log(`stored sources for ${assetId} failed, searching again`);
        searched = true;
        rows = await search();
      }
    }
  }

  // Opens the best of the given sources that works. A source played before reuses what was learned about
  // its tracks, so tuning back in needs no new probe.
  async function openBest(asset, title, rows, { playback, rules, caps }) {
    const assetId = asset.id;
    let lastError = null;
    for (const row of rows.slice(0, MAX_ATTEMPTS)) {
      try {
        const known = row.status === "selected" && row.torbox_id && row.torbox_file_id ? parse(row.probe_json, null) : null;
        const resolved = known
          ? { url: await linkFor(row.id), torrentId: row.torbox_id, file: { id: row.torbox_file_id, name: row.file_name, size: row.file_size } }
          : await resolveRow(asset, title, row, { allowUncached: !rules.requireCached });
        setStage(assetId, "Reading audio and subtitles…");
        const info = known || await probeImpl(await inputFor(row.id, resolved.url));
        const chosen = chooseTracks(info, playback, { originalLanguage: title.original_language });
        // The file itself is the final word: no audio you can follow means it is the wrong release.
        if (chosen.foreignOnly) throw new SourceError(`audio is only ${[...new Set(info.audio.map(track => track.language || "unknown"))].join("/")}`, { status: 422, code: "wrong-language" });
        db.prepare("UPDATE playback_sources SET status='candidate' WHERE asset_id=? AND status='selected'").run(assetId);
        db.prepare("UPDATE playback_sources SET status='selected',torbox_id=?,torbox_file_id=?,file_name=?,file_size=coalesce(?,file_size),probe_json=?,verified_at=?,updated_at=?,fail_reason=NULL WHERE id=?")
          .run(resolved.torrentId, resolved.file.id, resolved.file.short_name || resolved.file.name, resolved.file.size ?? null, JSON.stringify(info), now(), now(), row.id);
        notePlayable(getAsset(assetId), info);
        return { status: "ready", origin: "torbox", sourceId: row.id, fileName: resolved.file.short_name || resolved.file.name, url: resolved.url, info, chosen, plan: playbackPlan(info, chosen, { caps }) };
      } catch (error) {
        // A release that is still downloading on TorBox is not a failure: report progress and check back.
        if (error.code === "downloading") { setStage(assetId, error.message); throw new SourceError(error.message, { status: 202, code: "downloading" }); }
        lastError = error;
        log(`source ${row.release_name} failed: ${error.message}`);
        if (error.statusCode === 401 || error.statusCode === 429 || error.statusCode === 400) throw new SourceError(error.message, { status: error.statusCode === 401 ? 400 : error.statusCode, code: error.statusCode === 429 ? "rate-limited" : "not-configured" });
        fail(row, error.message);
      }
    }
    db.prepare("UPDATE assets SET availability='unavailable',updated_at=? WHERE id=?").run(now(), assetId);
    throw new SourceError(`None of the best releases could be opened (${lastError?.message || "unknown error"}). Try another source or check back later.`, { status: 502, code: "failed" });
  }

  // Background check that something instantly playable exists, without opening it: keeps episodes with no
  // source out of the TV guide before they air, and lets them back in once a release appears.
  async function check(assetId) {
    const asset = getAsset(assetId);
    const title = asset?.title_id ? getTitleRow(asset.title_id) : null;
    if (!title || asset.availability === "unaired" || (asset.file_path && existsSync(asset.file_path))) return "skipped";
    if (running.has(assetId)) return "busy";
    if (candidatesFor(assetId).length && asset.availability !== "unavailable") return "known";
    if (asset.availability === "unavailable" && Date.now() - Date.parse(asset.updated_at) < RECHECK_UNAVAILABLE) return "unavailable";
    const result = await discover(asset, title);
    stages.delete(assetId);
    if (!result.accepted.length) {
      db.prepare("UPDATE assets SET availability='unavailable',updated_at=? WHERE id=?").run(now(), assetId);
      return "unavailable";
    }
    store(asset, result.accepted);
    db.prepare("UPDATE assets SET availability='available',updated_at=? WHERE id=? AND availability IN ('unknown','unavailable')").run(now(), assetId);
    return "available";
  }

  // One preparation per asset at a time; later callers share it. A finished result (or failure) is
  // remembered briefly so a player polling for progress gets the same answer instead of starting over.
  const recent = new Map();
  function prepare(assetId, options = {}) {
    const last = recent.get(assetId);
    if (last && last.expires > Date.now() && !options.sourceId && !options.rediscover) {
      if (last.error) return Promise.reject(last.error);
      if (last.result.origin === "local" || links.get(last.result.sourceId)?.expiresAt > Date.now() + 5 * 60_000) return Promise.resolve(last.result);
    }
    if (!running.has(assetId)) {
      stages.set(assetId, "Starting…");
      running.set(assetId, prepareInner(assetId, options)
        .then(result => { recent.set(assetId, { result, expires: Date.now() + 90_000 }); return result; },
          error => { recent.set(assetId, { error, expires: Date.now() + 8_000 }); throw error; })
        .finally(() => { running.delete(assetId); setTimeout(() => stages.delete(assetId), 30_000).unref?.(); }));
    }
    return running.get(assetId);
  }

  // The current playable address for a streamed asset, re-resolving when a link has expired.
  async function streamUrl(assetId, { force = false } = {}) {
    const row = db.prepare("SELECT * FROM playback_sources WHERE asset_id=? AND status='selected'").get(assetId);
    if (!row) throw new SourceError("Choose a source first.", { status: 409, code: "not-prepared" });
    return { url: await linkFor(row.id, { force }), row };
  }

  // The address readers should open for a streamed asset (the local stream cache in the app).
  async function input(assetId) {
    const { url, row } = await streamUrl(assetId);
    return { url: await inputFor(row.id, url), row };
  }

  return {
    prepare, check, streamUrl, input, linkFor, stage: assetId => stages.get(assetId) || null, isRunning: assetId => running.has(assetId),
    sources: assetId => candidatesFor(assetId).map(describeSource),
    async select(assetId, sourceId, options) { return prepare(assetId, { ...options, sourceId }); },
    // Forget what was found so the next play searches again (e.g. after a bad release).
    reset(assetId) { recent.delete(assetId); db.prepare("DELETE FROM playback_sources WHERE asset_id=? AND status IN ('candidate','selected')").run(assetId); },
    scoreCandidate, links,
  };
}
