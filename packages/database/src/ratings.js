import { AsyncLocalStorage } from "node:async_hooks";

// One content rating ladder for everything. NSFW is its top rung, not a separate flag.
// Stored as integers (1–5); NULL means unrated.
export const RATINGS = [
  { key: "kids", level: 1, label: "Kids", description: "G, TV-Y, TV-G" },
  { key: "older_kids", level: 2, label: "Older kids", description: "PG, TV-Y7, TV-PG" },
  { key: "teens", level: 3, label: "Teens", description: "PG-13, TV-14" },
  { key: "mature", level: 4, label: "Mature", description: "R, NC-17, TV-MA" },
  { key: "nsfw", level: 5, label: "NSFW", description: "Explicit content" },
];
export const MAX_LEVEL = 5;
export const ratingKey = level => RATINGS.find(rating => rating.level === level)?.key ?? null;
// Accepts a key ("teens") or null (unrated). Returns undefined for anything else.
export const ratingLevel = key => key === null ? null : RATINGS.find(rating => rating.key === key)?.level;

// US certifications from TMDB. Anything else (NR, other countries) is unrated.
const CERTIFICATIONS = {
  1: ["G", "TV-Y", "TV-G"],
  2: ["PG", "TV-Y7", "TV-Y7-FV", "TV-PG"],
  3: ["PG-13", "TV-14"],
  4: ["R", "NC-17", "TV-MA"],
};
export const certificationLevel = certification => {
  const value = String(certification || "").trim().toUpperCase();
  for (const [level, list] of Object.entries(CERTIFICATIONS)) if (list.includes(value)) return Number(level);
  return null;
};
export const certificationSql = column => `(CASE ${Object.entries(CERTIFICATIONS)
  .map(([level, list]) => `WHEN upper(trim(${column})) IN (${list.map(value => `'${value}'`).join(",")}) THEN ${level}`).join(" ")} ELSE NULL END)`;

// The profile a request runs as. Code outside a request (worker, scripts, tests) runs as the
// original local profile with no restrictions.
export const profileContext = new AsyncLocalStorage();
const BACKGROUND = Object.freeze({ id: "user-local", role: "admin", maxRating: MAX_LEVEL, allowUnrated: true, background: true });
export const currentProfile = () => profileContext.getStore() || BACKGROUND;
export const currentUserId = () => currentProfile().id;
export const isUnrestricted = (profile = currentProfile()) => profile.maxRating >= MAX_LEVEL && profile.allowUnrated;

// Whether a rating level (or null for unrated) is allowed for the profile.
export const levelAllowed = (level, profile = currentProfile()) => level == null ? Boolean(profile.allowUnrated) : level <= profile.maxRating;

// SQL condition comparing a level expression with the profile's limit. Values are integers from the
// profile row, so they are inlined; unrestricted profiles get a constant true so nothing extra runs.
const limitSql = (expression, profile) => {
  if (isUnrestricted(profile)) return "1=1";
  const max = Math.trunc(Number(profile.maxRating)) || 0;
  return `coalesce(${expression}, ${profile.allowUnrated ? 0 : 99}) <= ${max}`;
};
export const assetVisibleSql = (alias = "a", profile = currentProfile()) =>
  isUnrestricted(profile) ? "1=1" : limitSql(`(SELECT r.level FROM asset_ratings r WHERE r.asset_id=${alias}.id)`, profile);
export const titleVisibleSql = (alias = "t", profile = currentProfile()) =>
  isUnrestricted(profile) ? "1=1" : limitSql(`(SELECT r.level FROM title_ratings r WHERE r.title_id=${alias}.id)`, profile);
// A clip is hidden when one of its own tags is rated above the profile's limit (clip tags describe only that range,
// so they don't rate the whole video).
export const clipVisibleSql = (alias = "a", profile = currentProfile()) =>
  isUnrestricted(profile) ? "1=1" : `NOT EXISTS(SELECT 1 FROM clip_topics cv JOIN topics cr ON cr.id=cv.topic_id WHERE cv.clip_id=${alias}.id AND cr.content_rating > ${Math.trunc(Number(profile.maxRating)) || 0})`;
// A rated tag is shown when its rating is allowed. An unrated tag is shown only where it has something the profile
// can see: a video, a movie or show, or a clip. So a tag used only on hidden content stays hidden.
export const topicVisibleSql = (alias = "t", profile = currentProfile()) => {
  if (isUnrestricted(profile)) return "1=1";
  const max = Math.trunc(Number(profile.maxRating)) || 0;
  return `(CASE WHEN ${alias}.content_rating IS NOT NULL THEN ${alias}.content_rating <= ${max} ELSE (
    EXISTS(SELECT 1 FROM effective_asset_topics ve JOIN assets va ON va.id=ve.asset_id WHERE ve.topic_id=${alias}.id AND ${assetVisibleSql("va", profile)})
    OR EXISTS(SELECT 1 FROM title_topics vt JOIN titles vx ON vx.id=vt.title_id WHERE vt.topic_id=${alias}.id AND ${titleVisibleSql("vx", profile)})
    OR EXISTS(SELECT 1 FROM clip_topics vc JOIN annotations vn ON vn.id=vc.clip_id JOIN assets vca ON vca.id=vn.asset_id
      WHERE vc.topic_id=${alias}.id AND ${assetVisibleSql("vca", profile)} AND ${clipVisibleSql("vn", profile)})
  ) END)`;
};
