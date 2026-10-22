import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dataDir } from "@kiwi/database";
import { cacheDatabase, createProviderClient } from "./http.js";

// Artwork is fetched from the provider once and served from disk afterwards, so browsing never leaks
// to a third party, works offline, and does not repeat requests. Library artwork is pinned; artwork
// seen only while browsing is evicted oldest-first once the cache outgrows its limit.

export const SIZES = new Set(["w45", "w92", "w154", "w185", "w300", "w342", "w500", "w632", "w780", "w1280", "h632", "original"]);
const FILE = /^\/[A-Za-z0-9_-]{5,80}\.(jpg|jpeg|png|webp)$/i;
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
export const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const MISSING_SECONDS = 24 * 3600;

export const imageUrl = (path, size = "w342") => path && FILE.test(path) ? `/api/v1/images/tmdb/${size}${path}` : null;

export function createImageStore({ directory = join(dataDir, "images"), maxBytes = DEFAULT_MAX_BYTES, fetchImpl, base = "https://image.tmdb.org/t/p", now = Date.now } = {}) {
  const client = createProviderClient({ name: "tmdb-images", ratePerSecond: 40, burst: 40, concurrency: 8, fetchImpl, timeoutMs: 20_000, retries: 1 });
  const inflight = new Map();
  let writes = 0;

  const valid = (size, file) => SIZES.has(size) && FILE.test(file);
  const keyOf = (size, file) => `tmdb/${size}${file}`;
  const pathOf = key => join(directory, key);

  function evict() {
    const database = cacheDatabase();
    let total = database.prepare("SELECT coalesce(sum(bytes),0) bytes FROM image_cache WHERE pinned=0").get().bytes;
    if (total <= maxBytes) return 0;
    let removed = 0;
    for (const row of database.prepare("SELECT key, bytes FROM image_cache WHERE pinned=0 AND bytes>0 ORDER BY last_access").all()) {
      if (total <= maxBytes * 0.9) break;
      rm(pathOf(row.key), { force: true }).catch(() => {});
      database.prepare("DELETE FROM image_cache WHERE key=?").run(row.key);
      total -= row.bytes; removed++;
    }
    return removed;
  }

  async function download(size, file, key) {
    const target = pathOf(key);
    mkdirSync(dirname(target), { recursive: true });
    const response = await client.fetch(`${base}/${size}${file}`, { headers: { accept: "image/*" } });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Image request failed (${response.status})`); }
    const partial = `${target}.partial`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, target);
    return { bytes: statSync(target).size, contentType: response.headers.get("content-type") || TYPES[file.split(".").pop().toLowerCase()] };
  }

  // Returns { path, contentType, bytes } for a cached or freshly fetched image, or null when the provider has none.
  async function get(size, file, { pin = false } = {}) {
    if (!valid(size, file)) return null;
    const key = keyOf(size, file), database = cacheDatabase(), time = Math.floor(now() / 1000);
    const row = database.prepare("SELECT * FROM image_cache WHERE key=?").get(key);
    if (row && row.bytes > 0 && existsSync(pathOf(key))) {
      database.prepare("UPDATE image_cache SET last_access=?, pinned=max(pinned, ?) WHERE key=?").run(time, pin ? 1 : 0, key);
      return { path: pathOf(key), contentType: row.content_type, bytes: row.bytes };
    }
    if (row?.missing_until && row.missing_until > time) return null;
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        const saved = await download(size, file, key);
        if (!saved) {
          database.prepare("INSERT INTO image_cache (key,bytes,content_type,last_access,pinned,missing_until) VALUES (?,0,NULL,?,0,?) ON CONFLICT(key) DO UPDATE SET missing_until=excluded.missing_until").run(key, time, time + MISSING_SECONDS);
          return null;
        }
        database.prepare("INSERT INTO image_cache (key,bytes,content_type,last_access,pinned,missing_until) VALUES (?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,content_type=excluded.content_type,last_access=excluded.last_access,pinned=max(image_cache.pinned,excluded.pinned),missing_until=NULL")
          .run(key, saved.bytes, saved.contentType, time, pin ? 1 : 0);
        if (++writes % 25 === 0) evict();
        return { path: pathOf(key), contentType: saved.contentType, bytes: saved.bytes };
      })().finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }

  const setPinned = (keys, pinned) => {
    const update = cacheDatabase().prepare("UPDATE image_cache SET pinned=? WHERE key=?");
    for (const key of keys) update.run(pinned ? 1 : 0, key);
  };

  return {
    get, evict, setPinned, keyOf, valid,
    // Fetches artwork ahead of time for library items; failures are ignored (it will load on demand).
    async prefetch(items, { pin = true } = {}) {
      let fetched = 0;
      const queue = items.filter(item => item?.file && valid(item.size, item.file));
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          try { if (await get(item.size, item.file, { pin })) fetched++; } catch { /* loads later on demand */ }
        }
      }));
      return fetched;
    },
    pin: items => setPinned(items.filter(item => item?.file && valid(item.size, item.file)).map(item => keyOf(item.size, item.file)), true),
    unpin: items => setPinned(items.filter(item => item?.file && valid(item.size, item.file)).map(item => keyOf(item.size, item.file)), false),
  };
}
