import { db } from "@kiwi/database";
import { ConfigError, describeFields, maskConfig, mergeConfig } from "@kiwi/downloads";

const now = () => new Date().toISOString();

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value_json FROM media_settings WHERE key=?").get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}
export function setSetting(key, value) {
  db.prepare("INSERT INTO media_settings (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
    .run(key, JSON.stringify(value), now());
  return value;
}

// ---------------------------------------------------------------------------------------------------
// Providers: the catalog, the debrid service, the indexers that find releases, and subtitle search.

export const providerDefinitions = {
  tmdb: {
    id: "tmdb", name: "TMDB", kind: "catalog", always: false,
    description: "Movie, TV, and anime metadata, posters, and where each title streams.",
    fields: [
      { key: "token", label: "Read access token or API key", type: "secret", required: true, help: "Create a free key at themoviedb.org/settings/api. Either the long read access token or the short API key works." },
      { key: "region", label: "Region for streaming services", type: "text", default: "US", help: "Two-letter country code, used to tag titles with the services that carry them." },
      { key: "language", label: "Metadata language", type: "text", default: "en-US" },
    ],
  },
  torbox: {
    id: "torbox", name: "TorBox", kind: "debrid",
    description: "Turns cached torrents into instant streams and downloads.",
    fields: [{ key: "apiKey", label: "API key", type: "secret", required: true, help: "Found under Settings → Account at torbox.app." }],
  },
  torrentio: {
    id: "torrentio", name: "Torrentio", kind: "indexer", defaultEnabled: true,
    description: "Finds releases for movies and shows by IMDb ID.",
    fields: [{ key: "baseUrl", label: "Address", type: "url", default: "https://torrentio.strem.fun", help: "Change this to use a self-hosted or alternate instance." }],
  },
  nyaa: {
    id: "nyaa", name: "Nyaa", kind: "indexer", defaultEnabled: true,
    description: "Finds anime releases by title and episode number. Only used for anime.",
    fields: [{ key: "baseUrl", label: "Address", type: "url", default: "https://nyaa.si" }],
  },
  opensubtitles: {
    id: "opensubtitles", name: "OpenSubtitles", kind: "subtitles",
    description: "Finds subtitles when a release has none in your language.",
    fields: [
      { key: "apiKey", label: "API key", type: "secret", required: true, help: "Create a consumer at opensubtitles.com/consumers." },
      { key: "username", label: "Username", type: "text", required: true },
      { key: "password", label: "Password", type: "secret", required: true },
    ],
  },
};

const providerKey = id => `provider:${id}`;
export function getProvider(id) {
  const definition = providerDefinitions[id];
  if (!definition) throw new ConfigError("Unknown provider.", 404);
  const stored = getSetting(providerKey(id), {});
  const config = mergeConfig(definition.fields.map(field => ({ ...field, required: false })), {}, stored.config || {});
  const configured = definition.fields.filter(field => field.required).every(field => config[field.key]);
  const enabled = stored.enabled === undefined ? Boolean(definition.defaultEnabled) || configured : Boolean(stored.enabled);
  return { id, definition, config, configured, enabled: enabled && (configured || !definition.fields.some(field => field.required)) };
}

export function publicProvider(id) {
  const provider = getProvider(id);
  const { values, secrets } = maskConfig(provider.definition.fields, provider.config);
  const { id: _id, name, kind, description, fields } = provider.definition;
  return { id, name, kind, description, fields: describeFields(fields), config: values, secrets, configured: provider.configured, enabled: provider.enabled };
}

export function saveProvider(id, body = {}) {
  const provider = getProvider(id);
  const config = mergeConfig(provider.definition.fields, provider.config, body.config || {}, Array.isArray(body.clearSecrets) ? body.clearSecrets : []);
  const stored = getSetting(providerKey(id), {});
  const enabled = body.enabled === undefined ? stored.enabled : Boolean(body.enabled);
  setSetting(providerKey(id), { config, enabled });
  return publicProvider(id);
}

// ---------------------------------------------------------------------------------------------------
// Source ranking rules. Defaults favor quality that plays smoothly in a browser, instantly available
// files, and English speakers (English audio first, then Japanese, then Chinese).

export const LANGUAGES = [
  ["eng", "English"], ["jpn", "Japanese"], ["zho", "Chinese"], ["kor", "Korean"], ["spa", "Spanish"], ["fra", "French"],
  ["deu", "German"], ["ita", "Italian"], ["por", "Portuguese"], ["rus", "Russian"], ["ara", "Arabic"], ["hin", "Hindi"],
];
const languageCodes = new Set(LANGUAGES.map(([code]) => code));

export const defaultRules = {
  preferredResolution: 1080,
  minResolution: 480,
  maxResolution: 2160,
  directPlay: true,
  allowHdr: false,
  maxGbPerHour: 12,
  requireCached: true,
  excludeTerms: ["cam", "hdcam", "telesync", "telecine", "screener", "workprint", "3d"],
  preferGroups: [],
  avoidGroups: [],
  avoidHardcodedSubs: true,
  anime: {
    preferDualAudio: true,
    preferGroups: ["SubsPlease", "Erai-raws", "EMBER", "ToonsHub", "Judas", "Anime Time", "Tsundere-Raws"],
    allowBatches: true,
  },
};

export const defaultPlayback = {
  audioLanguages: ["eng", "jpn", "zho"],
  subtitleLanguages: ["eng", "jpn", "zho"],
  // auto: show subtitles when the chosen audio is not your first language; always; or off.
  subtitleMode: "auto",
};

export const defaultDownloads = { rootId: null, moviesFolder: "Movies", showsFolder: "TV Shows", animeFolder: "Anime" };

const clampInt = (value, label, min, max) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new ConfigError(`${label} must be a whole number from ${min} to ${max}.`);
  return number;
};
const flag = (value, label) => { if (typeof value !== "boolean") throw new ConfigError(`${label} must be on or off.`); return value; };
const list = (value, label, { max = 30, length = 60, codes = false } = {}) => {
  if (!Array.isArray(value) || value.length > max) throw new ConfigError(`${label} must be a list of up to ${max} entries.`);
  const clean = [...new Set(value.map(item => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > length) throw new ConfigError(`${label} has an invalid entry.`);
    return item.trim();
  }))];
  if (codes && clean.some(code => !languageCodes.has(code))) throw new ConfigError(`${label} has an unknown language.`);
  return clean;
};
const RESOLUTIONS = [480, 720, 1080, 2160];

export function getRules() {
  const stored = getSetting("rules", {});
  return { ...defaultRules, ...stored, anime: { ...defaultRules.anime, ...(stored.anime || {}) } };
}

export function saveRules(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ConfigError("Rules must be an object.");
  const current = getRules();
  const next = { ...current };
  const resolution = (key, label) => {
    if (input[key] === undefined) return;
    const value = Number(input[key]);
    if (!RESOLUTIONS.includes(value)) throw new ConfigError(`${label} must be 480, 720, 1080, or 2160.`);
    next[key] = value;
  };
  resolution("preferredResolution", "Preferred quality"); resolution("minResolution", "Lowest quality"); resolution("maxResolution", "Highest quality");
  if (next.minResolution > next.maxResolution) throw new ConfigError("Lowest quality cannot be above the highest.");
  if (next.preferredResolution < next.minResolution || next.preferredResolution > next.maxResolution) throw new ConfigError("Preferred quality must sit between the lowest and highest.");
  if (input.directPlay !== undefined) next.directPlay = flag(input.directPlay, "Prefer direct play");
  if (input.allowHdr !== undefined) next.allowHdr = flag(input.allowHdr, "Allow HDR");
  if (input.requireCached !== undefined) next.requireCached = flag(input.requireCached, "Only instant sources");
  if (input.avoidHardcodedSubs !== undefined) next.avoidHardcodedSubs = flag(input.avoidHardcodedSubs, "Avoid burned-in subtitles");
  if (input.maxGbPerHour !== undefined) next.maxGbPerHour = clampInt(input.maxGbPerHour, "Size limit", 1, 100);
  for (const key of ["excludeTerms", "preferGroups", "avoidGroups"]) if (input[key] !== undefined) next[key] = list(input[key], key);
  if (input.anime !== undefined) {
    const anime = input.anime || {};
    next.anime = { ...current.anime };
    if (anime.preferDualAudio !== undefined) next.anime.preferDualAudio = flag(anime.preferDualAudio, "Prefer dual audio");
    if (anime.allowBatches !== undefined) next.anime.allowBatches = flag(anime.allowBatches, "Allow batches");
    if (anime.preferGroups !== undefined) next.anime.preferGroups = list(anime.preferGroups, "Anime groups");
  }
  setSetting("rules", next);
  return next;
}

export function resetRules() { db.prepare("DELETE FROM media_settings WHERE key='rules'").run(); return getRules(); }

export function getPlayback() { return { ...defaultPlayback, ...getSetting("playback", {}) }; }
export function savePlayback(input = {}) {
  const next = { ...getPlayback() };
  if (input.audioLanguages !== undefined) next.audioLanguages = list(input.audioLanguages, "Audio languages", { max: 6, codes: true });
  if (input.subtitleLanguages !== undefined) next.subtitleLanguages = list(input.subtitleLanguages, "Subtitle languages", { max: 6, codes: true });
  if (input.subtitleMode !== undefined) {
    if (!["auto", "always", "off"].includes(input.subtitleMode)) throw new ConfigError("Subtitles must be auto, always, or off.");
    next.subtitleMode = input.subtitleMode;
  }
  if (!next.audioLanguages.length || !next.subtitleLanguages.length) throw new ConfigError("Choose at least one audio and one subtitle language.");
  setSetting("playback", next);
  return next;
}

export function getDownloadSettings() { return { ...defaultDownloads, ...getSetting("downloads", {}) }; }
const folderName = (value, label) => {
  if (typeof value !== "string") throw new ConfigError(`${label} must be text.`);
  const clean = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean.length > 100 || clean.split("/").some(part => part === ".." || part === ".")) throw new ConfigError(`${label} must be a folder name inside the library folder.`);
  return clean;
};
export function saveDownloadSettings(input = {}) {
  const next = { ...getDownloadSettings() };
  if (input.rootId !== undefined) {
    if (input.rootId === null || input.rootId === "") next.rootId = null;
    else {
      const root = db.prepare("SELECT id, read_only FROM library_roots WHERE id=?").get(input.rootId);
      if (!root) throw new ConfigError("That library folder no longer exists.", 404);
      if (root.read_only) throw new ConfigError("That folder is read-only. Allow downloads for it in Media libraries first.");
      next.rootId = root.id;
    }
  }
  for (const [key, label] of [["moviesFolder", "Movies folder"], ["showsFolder", "TV shows folder"], ["animeFolder", "Anime folder"]]) {
    if (input[key] !== undefined) next[key] = folderName(input[key], label);
  }
  setSetting("downloads", next);
  return next;
}
