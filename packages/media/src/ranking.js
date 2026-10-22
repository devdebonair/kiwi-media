import { parseRelease, titleScore } from "./release.js";

// Ranks release candidates for one movie or episode so playback can start without asking.
// Each candidate is either rejected (with a reason) or scored; every point comes with a label so the
// player can explain why a source was chosen.

const TIERS = [480, 720, 1080, 2160];
const tier = resolution => {
  if (resolution == null) return TIERS.indexOf(720);
  let best = 0;
  TIERS.forEach((value, index) => { if (resolution >= value - 40) best = index; });
  return best;
};
const BROWSER_AUDIO = new Set(["aac", "opus", "mp3", "flac"]);
const BAD_CONTAINERS = /\.(avi|wmv|flv|mpg|mpeg|divx|iso)$/i;

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRegex = term => new RegExp(`(?<![a-z0-9])${escape(term.trim()).replace(/\s+/g, "[ ._-]?")}(?![a-z0-9])`, "i");

// Does the release cover the requested episode (or movie)? Packs return `needsFile` because the
// right file inside them has to be picked afterwards.
export function matchTarget(parsed, target, { names = [], idBased = false, year = null, rules, fileName } = {}) {
  if (!idBased && names.length && parsed.title && titleScore(parsed.title, names) < 0.6) return { ok: false, reason: "different title" };
  if (target.type === "movie") {
    if (parsed.season != null || parsed.episodes.length || parsed.seasonPack) return { ok: false, reason: "episode release for a movie" };
    if (year && parsed.year && Math.abs(parsed.year - year) > 1 && !parsed.collection) return { ok: false, reason: "different year" };
    // Multi-movie collections are only usable when the indexer already named the right file.
    if (parsed.collection) {
      const file = fileName ? parseRelease(fileName) : null;
      if (!file || titleScore(file.title, names) < 0.8 || (year && file.year && Math.abs(file.year - year) > 1)) return { ok: false, reason: "collection of several movies" };
    }
    return { ok: true, kind: "movie", needsFile: Boolean(parsed.collection) };
  }
  const { absolute } = target;
  // The catalog's numbering plus any alternate split (e.g. TVDB-style seasons for anime).
  const pairs = [{ season: target.season, episode: target.episode }, ...(target.aliases || [])];
  if (parsed.episodes.length) {
    if (pairs.some(pair => parsed.season === pair.season && parsed.episodes.includes(pair.episode))) return { ok: true, kind: "episode", needsFile: parsed.episodes.length > 1 };
    // Anime releases sometimes label a later cour as S01E13+ while the catalog restarts at E01.
    if (target.isAnime && absolute != null && parsed.season === 1 && parsed.episodes.includes(absolute)) return { ok: true, kind: "episode", needsFile: false };
    return { ok: false, reason: "different episode" };
  }
  if (target.isAnime && absolute != null) {
    if (parsed.absolute === absolute) return { ok: true, kind: "episode", needsFile: false };
    if (parsed.batch && absolute >= parsed.batch[0] && absolute <= parsed.batch[1]) return rules?.anime?.allowBatches === false ? { ok: false, reason: "batch release" } : { ok: true, kind: "batch", needsFile: true };
    if (parsed.absolute != null) return { ok: false, reason: "different episode" };
  }
  // A pack must be for the alternate season when there is one: TMDB's season 1 may span two seasons elsewhere.
  const packPairs = target.aliases?.length ? target.aliases : pairs;
  if (parsed.seasonPack && packPairs.some(pair => parsed.seasons.includes(pair.season))) return { ok: true, kind: "season-pack", needsFile: true };
  if (parsed.complete && parsed.season == null && !parsed.seasons.length && !parsed.batch) return { ok: true, kind: "series-pack", needsFile: true };
  if (parsed.complete && parsed.batch && target.isAnime) return rules?.anime?.allowBatches === false ? { ok: false, reason: "batch release" } : { ok: true, kind: "batch", needsFile: true };
  return { ok: false, reason: "no episode information" };
}

export function scoreCandidate(candidate, context) {
  const { rules, playback, title = {}, target } = context;
  const parsed = candidate.parsed || parseRelease(candidate.releaseName || candidate.fileName);
  const reasons = [];
  const reject = reason => ({ accepted: false, rejected: reason, score: -Infinity, reasons });
  const add = (label, points) => { if (points) reasons.push({ label, points: Math.round(points * 10) / 10 }); };

  const match = matchTarget(parsed, target, { names: title.names, idBased: candidate.idBased, year: title.year, rules, fileName: candidate.fileName });
  if (!match.ok) return reject(match.reason);

  const raw = `${candidate.releaseName || ""} ${candidate.fileName || ""}`;
  for (const term of rules.excludeTerms || []) if (term.trim() && termRegex(term).test(raw)) return reject(`excluded term “${term}”`);
  if (["cam", "telesync", "screener"].includes(parsed.source)) return reject("low-quality source");
  if (parsed.group && (rules.avoidGroups || []).some(group => group.toLowerCase() === parsed.group.toLowerCase())) return reject(`avoided group ${parsed.group}`);

  // Quality
  const resolution = parsed.resolution;
  if (resolution != null && (resolution < rules.minResolution - 40 || resolution > rules.maxResolution + 40)) return reject(`${resolution}p is outside your quality range`);
  const distance = Math.abs(tier(resolution) - tier(rules.preferredResolution));
  add(resolution ? `${resolution}p` : "unknown resolution", 60 - 22 * distance - (resolution == null ? 10 : 0));
  const sourcePoints = { remux: 20, bluray: 18, "web-dl": 16, webrip: 12, hdtv: 8, dvd: 4 }[parsed.source] ?? 6;
  add(parsed.source || "unknown source", sourcePoints);

  // Language: audio is judged by where it sits in the user's list. A release that names no language
  // carries the show's original audio.
  const detected = [...new Set([...(parsed.languages || []), ...(candidate.languages || [])])];
  const original = title.originalLanguage || "eng";
  const audioPrefs = playback.audioLanguages;
  const rank = code => { const index = audioPrefs.indexOf(code); return index === -1 ? -1 : index; };
  const multi = parsed.multi || parsed.dualAudio || candidate.multiAudio || detected.length >= 2;
  const dubbed = parsed.dubbed || candidate.dubbed;
  const heardLanguages = detected.length ? detected : multi ? [] : dubbed ? ["eng"] : [original];
  if (!multi && heardLanguages.length && heardLanguages.every(code => rank(code) === -1)) return reject(`audio is ${heardLanguages.join("/")} only`);
  if (multi) {
    const bonus = heardLanguages.includes(audioPrefs[0]) || parsed.dubbed || (title.isAnime && rules.anime?.preferDualAudio) ? 60 : 45;
    add(parsed.dualAudio ? "dual audio" : "multiple audio tracks", bonus);
  } else {
    const best = Math.min(...heardLanguages.map(code => rank(code) === -1 ? 99 : rank(code)));
    const points = [50, 28, 12][best] ?? 5;
    add(heardLanguages[0] === "eng" ? "English audio" : `${heardLanguages[0]} audio`, points);
    if (title.isAnime && dubbed && rules.anime?.preferDualAudio) add("English dub", 10);
  }
  if (heardLanguages.length && !heardLanguages.includes(audioPrefs[0]) && !multi) {
    // Foreign audio is only comfortable with subtitles you can read.
    const readable = parsed.multiSubs || candidate.multiSubs || (parsed.subLanguages || []).some(code => playback.subtitleLanguages.includes(code)) || (candidate.subLanguages || []).some(code => playback.subtitleLanguages.includes(code));
    add(readable ? "subtitles in your language" : "subtitles not confirmed", readable ? 14 : -4);
  }
  if (parsed.hardSubs) {
    if (rules.avoidHardcodedSubs) add("burned-in subtitles", -80);
  }

  // Playback friendliness
  if (rules.directPlay) {
    add(`${parsed.codec || "unknown"} video`, { h264: 15, hevc: -8, av1: -12, vp9: -4 }[parsed.codec] ?? 0);
    if (parsed.codec === "h264" && parsed.bitDepth === 10) add("10-bit H.264", -25);
    if (parsed.dolbyVision) add("Dolby Vision", -25);
    const audio = parsed.audio || [];
    if (audio.length && !audio.some(codec => BROWSER_AUDIO.has(codec))) add("audio needs converting", -6);
    const file = candidate.fileName || candidate.releaseName || "";
    if (BAD_CONTAINERS.test(file)) add("old container", -15);
    else if (/\.mp4$/i.test(file)) add("MP4", 3);
  }
  if (!rules.allowHdr && (parsed.hdr || parsed.dolbyVision)) add("HDR on SDR screens", -45);
  if (parsed.proper || parsed.repack) add("fixed release", 3);

  // Size against runtime keeps playback smooth on ordinary connections.
  if (candidate.size && title.runtimeMin && match.kind !== "season-pack" && match.kind !== "series-pack" && match.kind !== "batch") {
    const gbPerHour = candidate.size / 1e9 / (title.runtimeMin / 60);
    const ratio = gbPerHour / rules.maxGbPerHour;
    if (ratio > 3) return reject(`${gbPerHour.toFixed(0)} GB/hour is too large`);
    if (ratio > 1) add(`${gbPerHour.toFixed(1)} GB/hour`, -Math.min(90, 30 * (ratio - 1)));
    if (gbPerHour < 0.25 && (resolution || 720) >= 1080) add("very low bitrate", -15);
  }

  // Delivery speed
  if (candidate.cached === true) add("instant on TorBox", 1000);
  else {
    if (rules.requireCached) return reject("not cached on TorBox");
    add("needs to download first", -200);
    add(`${candidate.seeders ?? 0} seeders`, Math.min(20, Math.log2((candidate.seeders ?? 0) + 1) * 3));
  }

  // Preferences
  const group = (parsed.group || "").toLowerCase();
  const preferred = [...(rules.preferGroups || []), ...(title.isAnime ? rules.anime?.preferGroups || [] : [])].map(item => item.toLowerCase());
  if (group && preferred.includes(group)) add(`group ${parsed.group}`, 15);
  if (match.kind === "season-pack" || match.kind === "series-pack" || match.kind === "batch") add("pack", -5);

  const score = reasons.reduce((sum, item) => sum + item.points, 0);
  return { accepted: true, score, reasons, match, parsed };
}

// Best first. Ties go to the more seeded release, then the stable infohash, so the choice is repeatable.
export function rankCandidates(candidates, context) {
  const accepted = [], rejected = [];
  for (const candidate of candidates) {
    const result = scoreCandidate(candidate, context);
    (result.accepted ? accepted : rejected).push({ ...candidate, ...result });
  }
  accepted.sort((a, b) => b.score - a.score || (b.seeders ?? 0) - (a.seeders ?? 0) || (a.infoHash < b.infoHash ? -1 : 1));
  return { accepted, rejected };
}
