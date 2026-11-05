import { db, assetVisibleSql, MAX_LEVEL, RATINGS, ratingLevel } from "@kiwi/database";
import { titleAllowed, topicAllowed } from "./profiles.js";

// What a channel you make airs. Sources add videos: tags (all or any of them), shows and movies, lists, and source
// folders. Filters then narrow that down: media types, a rating limit of the channel's own, tags to leave out, and
// a year range. The profile watching still only sees what it may watch; the channel's rating limit is on top.
//
// Stored as JSON in guide_channels.rules_json.

export const MAX_SOURCES = 50;
export const TYPES = ["movies", "shows", "anime", "home"];
export const ORDERS = ["shuffle", "in_order", "newest"];
// Episodes of a show that air back to back; 0 is a whole season.
export const EPISODE_BLOCKS = [1, 2, 4, 0];
const YEAR_MIN = 1870, YEAR_MAX = 2100;
const SOURCE_KEYS = ["topicIds", "titleIds", "listIds", "rootIds"];

const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === "string" && id))] : [];
const year = value => Number.isInteger(value) && value >= YEAR_MIN && value <= YEAR_MAX ? value : null;

// Reads stored rules. Lenient: anything malformed falls back to "no rule".
export function readRules(json) {
  let raw;
  try { raw = typeof json === "string" ? JSON.parse(json) : json; } catch { raw = null; }
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    topicIds: ids(raw.topicIds), match: raw.match === "any" ? "any" : "all",
    titleIds: ids(raw.titleIds), listIds: ids(raw.listIds), rootIds: ids(raw.rootIds), excludeTopicIds: ids(raw.excludeTopicIds),
    types: ids(raw.types).filter(type => TYPES.includes(type)),
    maxRating: RATINGS.some(rating => rating.key === raw.maxRating) ? raw.maxRating : null,
    allowUnrated: raw.allowUnrated !== false,
    yearFrom: year(raw.yearFrom), yearTo: year(raw.yearTo),
  };
}

const placeholders = list => list.map(() => "?").join(",");
const missing = (table, list, extra = "", ...extraParams) => list.length
  ? list.length - db.prepare(`SELECT count(*) count FROM ${table} WHERE id IN (${placeholders(list)}) ${extra}`).get(...list, ...extraParams).count : 0;

// Validates rules sent by the editor, as the profile making the change. `previous` is the channel's current rules:
// lists and folders already on a channel stay allowed, so another admin can edit a household channel.
export function validateRules(body, { admin, userId, previous = readRules({}) }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "rules must be an object" };
  for (const key of [...SOURCE_KEYS, "excludeTopicIds", "types"]) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return { error: `${key} must be a list` };
    if ((body[key]?.length || 0) > MAX_SOURCES) return { error: `Pick up to ${MAX_SOURCES} in each section` };
  }
  if (body.match !== undefined && !["all", "any"].includes(body.match)) return { error: "match must be \"all\" or \"any\"" };
  if ((body.types || []).some(type => !TYPES.includes(type))) return { error: `types can be ${TYPES.join(", ")}` };
  if (body.maxRating != null && ratingLevel(body.maxRating) == null) return { error: `maxRating must be one of ${RATINGS.map(rating => rating.key).join(", ")}, or null` };
  if (body.allowUnrated !== undefined && typeof body.allowUnrated !== "boolean") return { error: "allowUnrated must be true or false" };
  for (const key of ["yearFrom", "yearTo"]) if (body[key] != null && year(body[key]) === null) return { error: `${key} must be a year from ${YEAR_MIN} to ${YEAR_MAX}` };
  const rules = readRules(body);
  if (rules.yearFrom && rules.yearTo && rules.yearFrom > rules.yearTo) return { error: "The start year must come before the end year" };
  if (!SOURCE_KEYS.some(key => rules[key].length)) return { error: "Pick at least one tag, show or movie, list, or folder" };

  // Everything named must exist, and the editor must be able to see it (a tag or title hidden from the profile
  // can't be used to build a channel, the same as tagging).
  const tags = [...rules.topicIds, ...rules.excludeTopicIds];
  if (missing("topics", tags) || !tags.every(id => topicAllowed(id))) return { code: 404, error: "One or more tags no longer exist" };
  if (missing("titles", rules.titleIds) || !rules.titleIds.every(id => titleAllowed(id))) return { code: 404, error: "One or more shows or movies no longer exist" };
  const newLists = rules.listIds.filter(id => !previous.listIds.includes(id));
  if (missing("lists", rules.listIds) || missing("lists", newLists, "AND user_id=?", userId)) return { code: 404, error: "One or more lists no longer exist" };
  const newRoots = rules.rootIds.filter(id => !previous.rootIds.includes(id));
  if (newRoots.length && !admin) return { code: 403, error: "Only an admin can pick source folders" };
  if (missing("library_roots", rules.rootIds)) return { code: 404, error: "One or more folders no longer exist" };
  return { rules };
}

// The media class of a video, matching the guide's Movies / TV Shows / Anime / Home Videos channels.
const CLASS_SQL = "(CASE WHEN a.title_id IS NULL THEN 'home' WHEN t.is_anime=1 THEN 'anime' WHEN t.type='movie' THEN 'movies' ELSE 'shows' END)";
// The year an episode aired, a movie came out, or a home video was recorded or published, when known.
const YEAR_SQL = "CAST(coalesce(substr(nullif(a.air_date,''),1,4), t.year, substr(a.captured_at,1,4), substr(a.published_at,1,4)) AS INTEGER)";

// A WHERE condition over `assets a LEFT JOIN titles t` for the videos the rules pick. Whether a video is playable
// and allowed for the profile is checked separately.
export function rulesSql(rules) {
  const sources = [], filters = [], params = [];
  const tagged = list => `SELECT e.asset_id FROM effective_asset_topics e WHERE e.topic_id IN (${placeholders(list)})`;
  if (rules.topicIds.length) {
    sources.push(rules.match === "any" || rules.topicIds.length === 1 ? `a.id IN (${tagged(rules.topicIds)})`
      : `a.id IN (${tagged(rules.topicIds)} GROUP BY e.asset_id HAVING count(DISTINCT e.topic_id)=${rules.topicIds.length})`);
    params.push(...rules.topicIds);
  }
  if (rules.titleIds.length) { sources.push(`a.title_id IN (${placeholders(rules.titleIds)})`); params.push(...rules.titleIds); }
  if (rules.listIds.length) {
    const lists = placeholders(rules.listIds);
    sources.push(`(a.id IN (SELECT li.asset_id FROM list_items li WHERE li.list_id IN (${lists}) AND li.asset_id IS NOT NULL)
      OR a.title_id IN (SELECT li.title_id FROM list_items li WHERE li.list_id IN (${lists}) AND li.title_id IS NOT NULL))`);
    params.push(...rules.listIds, ...rules.listIds);
  }
  if (rules.rootIds.length) {
    sources.push(`EXISTS(SELECT 1 FROM library_roots r WHERE r.id IN (${placeholders(rules.rootIds)}) AND (
      EXISTS(SELECT 1 FROM files f WHERE f.asset_id=a.id AND f.library_root_id=r.id)
      OR substr(a.file_path,1,length(rtrim(r.absolute_path,'/'))+1)=rtrim(r.absolute_path,'/') || '/'))`);
    params.push(...rules.rootIds);
  }
  if (rules.excludeTopicIds.length) { filters.push(`a.id NOT IN (${tagged(rules.excludeTopicIds)})`); params.push(...rules.excludeTopicIds); }
  if (rules.types.length) { filters.push(`${CLASS_SQL} IN (${placeholders(rules.types)})`); params.push(...rules.types); }
  // The channel's own limit works like a profile's.
  if (rules.maxRating || !rules.allowUnrated) filters.push(assetVisibleSql("a", { maxRating: ratingLevel(rules.maxRating) ?? MAX_LEVEL, allowUnrated: rules.allowUnrated }));
  if (rules.yearFrom) { filters.push(`${YEAR_SQL}>=?`); params.push(rules.yearFrom); }
  if (rules.yearTo) { filters.push(`${YEAR_SQL}<=?`); params.push(rules.yearTo); }
  return { where: [`(${sources.join(" OR ") || "0"})`, ...filters].join(" AND "), params };
}

// The ids of the videos the rules pick, among `allowed` (the playable videos the profile may watch).
export function ruleAssets(rules, allowed) {
  const { where, params } = rulesSql(rules);
  const picked = new Set();
  for (const row of db.prepare(`SELECT a.id FROM assets a LEFT JOIN titles t ON t.id=a.title_id WHERE a.kind='video' AND ${where}`).all(...params)) {
    if (allowed.has(row.id)) picked.add(row.id);
  }
  return picked;
}
