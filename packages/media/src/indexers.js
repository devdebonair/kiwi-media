import { createProviderClient } from "./http.js";
import { getProvider } from "./settings.js";
import { FLAG_LANGUAGES, normalizeTitle, parseRelease } from "./release.js";

// Indexers only find releases (names, infohashes, sizes, seeders). Whether a release is usable is decided
// later by checking TorBox and ranking against your rules.

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
export function parseSize(text) {
  const match = String(text || "").match(/([\d.,]+)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)\b/i);
  return match ? Math.round(Number(match[1].replace(",", ".")) * UNITS[match[2].toLowerCase()]) : null;
}

// Merges what the torrent name says with what the chosen file says: a season pack whose file is
// "S01E02.mkv" is that episode, and a plain release name may only reveal its quality in the file name.
export function parseCandidate(releaseName, fileName) {
  const parsed = parseRelease(releaseName);
  if (!fileName || fileName === releaseName) return parsed;
  const file = parseRelease(fileName);
  if (file.episodes.length) Object.assign(parsed, { season: file.season, seasons: [file.season], episodes: file.episodes, seasonPack: false, batch: null });
  else if (file.absolute != null) Object.assign(parsed, { absolute: file.absolute, seasonPack: false, batch: null });
  for (const key of ["resolution", "source", "codec", "bitDepth", "hdr", "group"]) if (parsed[key] == null && file[key] != null) parsed[key] = file[key];
  if (file.dolbyVision) parsed.dolbyVision = true;
  if (file.hardSubs) parsed.hardSubs = true;
  parsed.audio = [...new Set([...parsed.audio, ...file.audio])];
  parsed.languages = [...new Set([...parsed.languages, ...file.languages])];
  return parsed;
}

const hashOf = value => /^[a-f0-9]{40}$/i.test(value || "") ? value.toLowerCase() : null;

export function parseTorrentioStream(stream, indexer = "torrentio") {
  const infoHash = hashOf(stream.infoHash);
  if (!infoHash) return null;
  const lines = String(stream.title || "").split("\n").map(line => line.trim()).filter(Boolean);
  const statsIndex = lines.findIndex(line => line.includes("👤") || line.includes("💾"));
  const stats = statsIndex >= 0 ? lines[statsIndex] : "";
  const releaseName = lines[0] || stream.behaviorHints?.filename || "";
  const fileName = stream.behaviorHints?.filename || (statsIndex > 1 ? lines[1] : null);
  // The line after the stats lists flags: they name the dub's languages, or the subtitle languages after "Multi Subs".
  const tail = lines.slice(statsIndex + 1).join(" ");
  const flags = [];
  for (const [flag, code] of Object.entries(FLAG_LANGUAGES)) if (tail.includes(flag) && !flags.includes(code)) flags.push(code);
  const subtitled = /subs?\b/i.test(tail);
  const languages = subtitled ? [] : flags, subLanguages = subtitled ? flags : [];
  return {
    infoHash, fileIdx: Number.isInteger(stream.fileIdx) ? stream.fileIdx : null, releaseName, fileName,
    seeders: Number((stats.match(/👤\s*(\d+)/) || [])[1]) || 0, size: parseSize((stats.match(/💾\s*([\d.,]+\s*\w+)/) || [])[1]),
    source: (stats.match(/⚙️\s*([^\n]+)/) || [])[1]?.trim() || indexer, languages, subLanguages, multiSubs: subtitled, dubbed: /dubbed/i.test(tail), multiAudio: /multi\s*audio|dual\s*audio/i.test(tail),
    indexer, idBased: true,
  };
}

export function createTorrentio({ fetchImpl, config = () => getProvider("torrentio").config } = {}) {
  const baseUrl = () => (config().baseUrl || "https://torrentio.strem.fun").replace(/\/+$/, "");
  const client = createProviderClient({ name: "torrentio", ratePerSecond: 2, burst: 4, concurrency: 2, timeoutMs: 25_000, retries: 1, fetchImpl });
  return {
    id: "torrentio", client,
    async search({ type, imdbId, season, episode, aliases = [] }) {
      if (!imdbId) return [];
      const pairs = type === "movie" ? [null] : [{ season, episode }, ...aliases].filter((pair, index, all) => all.findIndex(other => other.season === pair.season && other.episode === pair.episode) === index);
      const results = await Promise.allSettled(pairs.map(async pair => {
        const path = pair === null ? `/stream/movie/${imdbId}.json` : `/stream/series/${imdbId}:${pair.season}:${pair.episode}.json`;
        const data = await client.json(`${baseUrl()}${path}`, { ttl: 30 * 60, swr: 6 * 3600, priority: "high" });
        return (data.streams || []).map(stream => parseTorrentioStream(stream)).filter(Boolean);
      }));
      if (results.every(result => result.status === "rejected")) throw results[0].reason;
      return results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    },
  };
}

// Nyaa publishes an RSS search feed with infohashes, so anime can be found by name and episode number
// without any id mapping.
const decode = value => String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
export function parseNyaaFeed(xml) {
  const items = [];
  for (const [, block] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = name => decode((block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]).trim();
    const infoHash = hashOf(tag("nyaa:infoHash"));
    if (!infoHash) continue;
    items.push({ infoHash, fileIdx: null, releaseName: tag("title"), fileName: null, seeders: Number(tag("nyaa:seeders")) || 0, size: parseSize(tag("nyaa:size")), source: "Nyaa", languages: [], indexer: "nyaa", idBased: false });
  }
  return items;
}

export function createNyaa({ fetchImpl, config = () => getProvider("nyaa").config } = {}) {
  const baseUrl = () => (config().baseUrl || "https://nyaa.si").replace(/\/+$/, "");
  const client = createProviderClient({ name: "nyaa", ratePerSecond: 1, burst: 3, concurrency: 2, timeoutMs: 25_000, retries: 1, fetchImpl });
  async function query(text) {
    const target = new URL(`${baseUrl()}/`);
    for (const [key, value] of Object.entries({ page: "rss", q: text, c: "1_2", f: "0", s: "seeders", o: "desc" })) target.searchParams.set(key, value);
    const response = await client.fetch(target.href, { headers: { accept: "application/rss+xml, text/xml, */*" } });
    const text2 = await response.text();
    if (!response.ok) return [];
    return parseNyaaFeed(text2);
  }
  return {
    id: "nyaa", client,
    // `names` are the show's known titles; episodes are searched by absolute number like fansubs label them.
    async search({ names, season, episode, absolute, aliases = [] }) {
      const unique = [...new Map(names.filter(Boolean).map(name => [normalizeTitle(name), name])).values()].slice(0, 3);
      const two = value => String(value).padStart(2, "0");
      const number = two(absolute ?? episode);
      // Fansubs number episodes straight through, or restart each season ("S2 - 05"), so ask for both.
      const queries = unique.flatMap((name, index) => [
        `${name} ${number}`, `${name} S${two(season)}E${two(episode)}`,
        ...aliases.flatMap(alias => [`${name} S${two(alias.season)}E${two(alias.episode)}`, ...(index === 0 ? [`${name} S${alias.season} ${two(alias.episode)}`] : [])]),
        `${name} batch`,
      ]).slice(0, 9);
      const results = await Promise.all(queries.map(text => query(text).catch(() => [])));
      return results.flat();
    },
  };
}

// Combines indexers, drops duplicates (same infohash and file), keeps the best-seeded copy.
export function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.infoHash}:${candidate.fileIdx ?? ""}:${candidate.fileName || ""}`;
    const existing = byKey.get(key);
    if (!existing || (candidate.seeders || 0) > (existing.seeders || 0)) byKey.set(key, { ...existing, ...candidate, languages: [...new Set([...(existing?.languages || []), ...(candidate.languages || [])])] });
  }
  return [...byKey.values()];
}
