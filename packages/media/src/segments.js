import { createProviderClient } from "./http.js";
import { getProvider } from "./settings.js";

// Parts of an episode or movie a viewer may want to skip: the intro (opening titles), a recap of earlier
// episodes, the end credits, and a preview of the next episode. Times are in milliseconds of the file.
//
// The file's own chapters come first: they are exact for this release. Many anime and Blu-ray releases name
// them ("OP", "Opening", "ED", "Credits", "次回予告"). Files without named chapters ask TheIntroDB, a community
// database keyed by TMDB id that is matched to the file's length.

// Each name must end there or continue with something other than a letter ("OP1", "Opening - Song", not "Opera").
const PATTERNS = [
  ["recap", /^(recap|previously( on)?|前回(のあらすじ)?|あらすじ)(?![a-z])/i],
  ["preview", /^(preview|next( episode| time)?( preview)?|予告|次回予告)(?![a-z])/i],
  ["intro", /^(op\d*|opening( (credits|theme|song|titles))?|intro|title sequence|main titles?|オープニング)(?![a-z])/i],
  ["credits", /^(ed\d*|ending( (credits|theme|song))?|end ?credits|credits|outro|エンディング)(?![a-z])/i],
];
const typeOf = name => PATTERNS.find(([, pattern]) => pattern.test(String(name || "").trim()))?.[0] || null;

// Named chapters as skippable segments. Numbered or unnamed chapters say nothing about what they hold.
export function chapterSegments(chapters = [], durationMs = null) {
  const segments = [];
  for (const chapter of chapters) {
    const type = typeOf(chapter.title);
    if (!type) continue;
    const endMs = chapter.endMs ?? durationMs;
    if (endMs == null || endMs <= chapter.startMs) continue;
    segments.push({ type, startMs: chapter.startMs, endMs, source: "chapters" });
  }
  return segments;
}

// Cleans up a set of segments against the file's length: no empty or out-of-range parts, credits without an
// end run to the end of the file, and at most one of each type (the earliest intro or recap, the first credits).
export function tidySegments(segments, durationMs) {
  const limit = durationMs || Infinity;
  const clean = segments
    .map(segment => ({ ...segment, startMs: Math.max(0, Math.round(segment.startMs || 0)), endMs: Math.round(Math.min(segment.endMs ?? limit, limit)) }))
    .filter(segment => Number.isFinite(segment.endMs) && segment.endMs - segment.startMs >= 3_000 && segment.startMs < limit);
  const byType = new Map();
  for (const segment of clean.sort((a, b) => a.startMs - b.startMs)) if (!byType.has(segment.type)) byType.set(segment.type, segment);
  return [...byType.values()].sort((a, b) => a.startMs - b.startMs);
}

export function createIntroDb({ fetchImpl, config = () => getProvider("theintrodb").config } = {}) {
  // Without a key: 25 requests per 10 seconds and 5,000 a day. Answers rarely change, so they are kept a week.
  const client = createProviderClient({
    name: "theintrodb", baseUrl: "https://api.theintrodb.org/v4", ratePerSecond: 2, burst: 5, concurrency: 2, timeoutMs: 10_000, retries: 1, fetchImpl,
    headers: () => ({ "user-agent": "kiwi-media/1.0", ...(config().apiKey ? { authorization: `Bearer ${config().apiKey}` } : {}) }),
  });
  const missing = new Map();
  return {
    id: "theintrodb", client,
    // `durationMs` lets the service pick timings for the cut of the episode actually being played.
    async lookup({ tmdbId, type, season, episode, durationMs }) {
      if (!tmdbId || (type !== "movie" && (season == null || episode == null))) return [];
      const params = { tmdb_id: tmdbId, ...(type === "movie" ? {} : { season, episode }), ...(durationMs ? { duration_ms: Math.round(durationMs / 1000) * 1000 } : {}) };
      const key = JSON.stringify(params);
      if (missing.get(key) > Date.now()) return [];
      let body;
      try { body = await client.json("/media", { params, ttl: 7 * 86_400, swr: 30 * 86_400 }); }
      catch (error) {
        if (error.statusCode === 404) { missing.set(key, Date.now() + 86_400_000); return []; }
        throw error;
      }
      const segments = [];
      for (const type of ["intro", "recap", "credits", "preview"]) {
        for (const item of body?.[type] || []) {
          if (item?.start_ms == null && item?.end_ms == null) continue;
          segments.push({ type, startMs: item.start_ms ?? 0, endMs: item.end_ms ?? null, source: "theintrodb" });
        }
      }
      return segments;
    },
  };
}

// The segments for one movie or episode: chapters when they name an intro or credits, else TheIntroDB.
export async function findSegments({ title, asset, info, introDb, log = () => {} }) {
  const durationMs = info?.durationMs || asset?.duration_ms || null;
  const fromChapters = tidySegments(chapterSegments(info?.chapters || [], durationMs), durationMs);
  if (fromChapters.some(segment => segment.type === "intro" || segment.type === "credits")) return fromChapters;
  if (!title?.tmdb_id || !introDb || !getProvider("theintrodb").enabled) return fromChapters;
  try {
    const found = await introDb.lookup({ tmdbId: title.tmdb_id, type: title.type, season: asset.season_number, episode: asset.episode_number, durationMs });
    return tidySegments([...fromChapters, ...found], durationMs);
  } catch (error) {
    log(`TheIntroDB lookup failed: ${error.message}`);
    return fromChapters;
  }
}
