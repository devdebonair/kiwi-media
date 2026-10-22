import { createProviderClient, ProviderError } from "./http.js";
import { getProvider } from "./settings.js";
import { parseRelease, titleScore } from "./release.js";

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv|mpg|mpeg)$/i;
const base = name => String(name || "").split("/").pop();
export const isVideoFile = file => VIDEO.test(file.short_name || file.name || "");
const SAMPLE = /(?<![a-z0-9])(sample|trailer|featurette|extras?)(?![a-z0-9])/i;

// Chooses the file inside a torrent that holds the requested movie or episode.
export function pickFile(files, target, { fileName } = {}) {
  const videos = (files || []).filter(isVideoFile);
  if (!videos.length) return null;
  const real = videos.filter(file => !SAMPLE.test(base(file.name))).length ? videos.filter(file => !SAMPLE.test(base(file.name))) : videos;
  const largest = list => [...list].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (target.type === "movie") {
    if (real.length === 1) return real[0];
    // Collections hold several films: take the one whose name and year match, never just the biggest.
    const names = target.names || [];
    if (!names.length) return largest(real);
    const scored = real.map(file => { const parsed = parseRelease(base(file.name)); return { file, score: titleScore(parsed.title, names), yearOk: !target.year || !parsed.year || Math.abs(parsed.year - target.year) <= 1 }; })
      .filter(item => item.score >= 0.8 && item.yearOk);
    return scored.length ? largest(scored.map(item => item.file)) : real.every(file => !parseRelease(base(file.name)).title) ? largest(real) : null;
  }
  if (fileName) {
    const wanted = base(fileName).toLowerCase();
    const exact = real.find(file => base(file.name).toLowerCase() === wanted || (file.short_name || "").toLowerCase() === wanted);
    if (exact) return exact;
  }
  const pairs = [{ season: target.season, episode: target.episode }, ...(target.aliases || [])];
  const matches = real.filter(file => {
    const parsed = parseRelease(base(file.name));
    if (parsed.episodes.length) return pairs.some(pair => parsed.season === pair.season && parsed.episodes.includes(pair.episode)) || (target.isAnime && target.absolute != null && parsed.episodes.includes(target.absolute) && parsed.season === 1);
    if (target.isAnime && target.absolute != null && parsed.absolute != null) return parsed.absolute === target.absolute;
    return false;
  });
  if (matches.length) return largest(matches);
  return real.length === 1 ? real[0] : null;
}

const unwrap = (body, what) => {
  if (!body || typeof body !== "object") throw new ProviderError(`TorBox returned an unexpected response for ${what}`, { provider: "torbox" });
  if (body.success === false) {
    const detail = String(body.detail || body.error || "").slice(0, 200);
    const status = /NO_AUTH|BAD_TOKEN|AUTH/i.test(`${body.error}`) ? 401 : /LIMIT/i.test(`${body.error}`) ? 429 : /PLAN_RESTRICTED_FEATURE/i.test(`${body.error}`) ? 403 : 502;
    throw new ProviderError(detail || `TorBox could not ${what}`, { status, provider: "torbox" });
  }
  return body.data;
};

export function createTorbox({ fetchImpl, config = () => getProvider("torbox").config } = {}) {
  const key = () => {
    const apiKey = config().apiKey;
    if (!apiKey) throw new ProviderError("Add your TorBox API key in Settings → Streaming.", { status: 400, provider: "torbox" });
    return apiKey;
  };
  const client = createProviderClient({
    name: "torbox", baseUrl: "https://api.torbox.app/v1/api", ratePerSecond: 4, burst: 8, concurrency: 3, timeoutMs: 30_000, fetchImpl,
    headers: () => ({ authorization: `Bearer ${key()}` }),
  });

  async function checkCached(hashes) {
    const unique = [...new Set(hashes.map(hash => hash.toLowerCase()))];
    const found = new Map();
    for (let index = 0; index < unique.length; index += 50) {
      const chunk = unique.slice(index, index + 50);
      const body = await client.json("/torrents/checkcached", {
        method: "POST", params: { format: "object", list_files: true }, body: JSON.stringify({ hashes: chunk }), headers: { "content-type": "application/json" },
        key: `torbox:cached:${chunk.join(",")}`, ttl: 0,
      });
      const data = unwrap(body, "check availability");
      const entries = Array.isArray(data) ? data.map(item => [item.hash, item]) : Object.entries(data || {});
      for (const [hash, info] of entries) if (info) found.set(String(info.hash || hash).toLowerCase(), { name: info.name, size: info.size, files: info.files || null });
    }
    return found;
  }

  const list = async id => unwrap(await client.json("/torrents/mylist", { params: { id, bypass_cache: true }, ttl: 0 }), "read the torrent");

  async function add(hash, { name, onlyIfCached = true } = {}) {
    const magnet = `magnet:?xt=urn:btih:${hash}${name ? `&dn=${encodeURIComponent(name)}` : ""}`;
    const form = new URLSearchParams({ magnet, seed: "1", allow_zip: "false", add_only_if_cached: String(onlyIfCached), ...(name ? { name } : {}) });
    const response = await client.fetch("/torrents/createtorrent", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new ProviderError("TorBox returned an unexpected response", { provider: "torbox" }); }
    if (!response.ok && body.success !== false) throw new ProviderError(`TorBox responded ${response.status}`, { provider: "torbox" });
    const data = unwrap(body, "add the torrent");
    return { torrentId: data?.torrent_id ?? data?.queued_id ?? null, queued: Boolean(data?.queued_id && !data?.torrent_id), name: data?.name };
  }

  async function requestDownload(torrentId, fileId) {
    const body = await client.json("/torrents/requestdl", { params: { token: key(), torrent_id: torrentId, file_id: fileId }, ttl: 0, priority: "high", key: undefined });
    const url = unwrap(body, "create a download link");
    if (typeof url !== "string" || !/^https?:/i.test(url)) throw new ProviderError("TorBox did not return a download link", { provider: "torbox" });
    return url;
  }

  // Finds or creates the torrent, then returns its id and the file that holds the requested content.
  async function open(hash, target, { torrentId, fileName, onlyIfCached = true, name } = {}) {
    let torrent = null;
    if (torrentId) { try { torrent = await list(torrentId); } catch (error) { if (error.statusCode === 401 || error.statusCode === 429) throw error; } }
    if (!torrent?.files?.length) {
      const added = await add(hash, { name, onlyIfCached });
      if (added.queued || !added.torrentId) throw new ProviderError("That release is not cached on TorBox yet.", { status: 409, provider: "torbox" });
      torrent = await list(added.torrentId);
    }
    // Not instantly available: TorBox is still fetching it. The caller keeps the source and checks back.
    const ready = ["cached", "completed", "uploading", "seeding"].includes(torrent?.download_state);
    const busy = ["downloading", "stalled", "metaDL", "checking", "queued", "paused"].includes(torrent?.download_state) || torrent?.download_finished === false;
    if (!torrent?.files?.length || (busy && !ready)) {
      const percent = Math.round((Number(torrent?.progress) || 0) * 100);
      throw new ProviderError(`TorBox is downloading this release${percent ? ` (${percent}%)` : ""}…`, { status: 202, provider: "torbox", code: "downloading", progress: percent });
    }
    const file = pickFile(torrent.files, target, { fileName });
    if (!file) throw new ProviderError("Could not find that episode inside the torrent.", { status: 404, provider: "torbox" });
    return { torrentId: torrent.id, file, files: torrent.files, name: torrent.name };
  }

  return { client, checkCached, list, add, requestDownload, open, async verify() { unwrap(await client.json("/user/me", { ttl: 0 }), "read the account"); return true; }, async account() { const me = unwrap(await client.json("/user/me", { ttl: 60 }), "read the account"); return { email: me?.email, plan: me?.plan, premiumExpiresAt: me?.premium_expires_at }; } };
}
