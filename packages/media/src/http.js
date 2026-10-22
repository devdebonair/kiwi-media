import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@kiwi/database";

// A separate database so the cache can be wiped at any time without touching the library or its backups.
let cacheDb;
export function cacheDatabase() {
  if (cacheDb) return cacheDb;
  mkdirSync(dataDir, { recursive: true });
  cacheDb = new DatabaseSync(join(dataDir, "cache.db"));
  cacheDb.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS http_cache (
      key TEXT PRIMARY KEY, provider TEXT NOT NULL, body TEXT NOT NULL, etag TEXT,
      fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, stale_until INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS http_cache_provider_idx ON http_cache(provider, fetched_at);
    CREATE TABLE IF NOT EXISTS image_cache (
      key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, content_type TEXT, last_access INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, missing_until INTEGER
    );
    CREATE INDEX IF NOT EXISTS image_cache_access_idx ON image_cache(pinned, last_access);
  `);
  return cacheDb;
}
export function closeCacheDatabase() { cacheDb?.close(); cacheDb = undefined; }

export class ProviderError extends Error {
  constructor(message, { status = 502, retryAfter = null, provider = null, code = null, progress = null } = {}) {
    super(message); this.name = "ProviderError"; this.statusCode = status; this.retryAfter = retryAfter; this.provider = provider; this.code = code; this.progress = progress;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

// One client per upstream service. Every call goes through a token bucket and a concurrency cap,
// identical in-flight requests are shared, responses are cached (serving stale data while they refresh
// or when the service is failing), and 429/5xx responses back off honoring Retry-After.
export function createProviderClient({
  name, baseUrl = "", headers = () => ({}), query = () => ({}),
  ratePerSecond = 5, burst = 10, concurrency = 4, timeoutMs = 20_000, retries = 2,
  fetchImpl = (...args) => fetch(...args), now = Date.now, wait = sleep,
} = {}) {
  let tokens = burst, refilled = now();
  let running = 0;
  const queue = [];
  const inflight = new Map();
  let failures = 0, openUntil = 0;
  const stats = { requests: 0, hits: 0, stale: 0, misses: 0, rateLimited: 0, errors: 0 };

  const refill = () => {
    const time = now();
    tokens = Math.min(burst, tokens + (time - refilled) / 1000 * ratePerSecond);
    refilled = time;
  };
  // Interactive requests jump ahead of background refreshes.
  function acquire(priority) {
    return new Promise(resolve => {
      const entry = { resolve, priority };
      const index = priority === "high" ? queue.findIndex(item => item.priority !== "high") : -1;
      if (index === -1) queue.push(entry); else queue.splice(index, 0, entry);
      pump();
    });
  }
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && running < concurrency) {
        refill();
        if (tokens < 1) { await wait(Math.ceil((1 - tokens) / ratePerSecond * 1000)); continue; }
        tokens -= 1; running++;
        queue.shift().resolve();
      }
    } finally { pumping = false; }
  }
  const release = () => { running--; pump(); };

  function url(path, params) {
    const target = new URL(/^https?:/i.test(path) ? path : `${baseUrl}${path}`);
    for (const [key, value] of Object.entries({ ...query(), ...params })) if (value !== undefined && value !== null && value !== "") target.searchParams.set(key, String(value));
    return target;
  }

  async function send(target, { method = "GET", body, extraHeaders, priority = "normal", signal }) {
    if (now() < openUntil) throw new ProviderError(`${name} is temporarily unavailable`, { status: 503, provider: name });
    // Evaluated up front so a missing key reports itself instead of looking like a network failure.
    const baseHeaders = headers();
    let attempt = 0;
    for (;;) {
      await acquire(priority);
      let response;
      try {
        stats.requests++;
        response = await fetchImpl(target, {
          method, body, redirect: "follow",
          headers: { accept: "application/json", "user-agent": "Kiwi/1.0 (self-hosted media library)", ...baseHeaders, ...extraHeaders },
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        });
      } catch (error) {
        release();
        if (signal?.aborted) throw error;
        stats.errors++;
        if (++attempt <= retries) { await wait(300 * 2 ** attempt, signal); continue; }
        if (++failures >= 5) openUntil = now() + 30_000;
        throw new ProviderError(`${name} could not be reached`, { provider: name });
      }
      release();
      if (response.status === 429 || response.status >= 500) {
        stats.rateLimited += response.status === 429 ? 1 : 0;
        const header = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(header) && header > 0 ? Math.min(header, 30) * 1000 : 500 * 2 ** attempt;
        await response.body?.cancel().catch(() => {});
        if (++attempt <= retries) { await wait(delay, signal); continue; }
        if (++failures >= 5) openUntil = now() + 30_000;
        throw new ProviderError(response.status === 429 ? `${name} rate limit reached` : `${name} is having problems`, { status: response.status === 429 ? 429 : 502, retryAfter: header || null, provider: name });
      }
      failures = 0;
      return response;
    }
  }

  async function read(response) {
    const text = await response.text();
    if (!response.ok) throw new ProviderError(`${name} responded ${response.status}`, { status: response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 401 : 502, provider: name });
    return text;
  }

  // Fetches JSON. `ttl` is how long a cached copy is fresh; `swr` how much longer it may be served
  // (refreshing in the background); `staleIfError` how long it may stand in when the service fails.
  async function json(path, { params, ttl = 0, swr = 0, staleIfError = 7 * 86_400, method = "GET", body, headers: extraHeaders, key, priority, signal, cacheErrors = false } = {}) {
    const target = url(path, params);
    const cacheKey = key || `${name}:${method}:${target.href}${body ? `:${typeof body === "string" ? body : JSON.stringify(body)}` : ""}`.replace(/(api_key=)[^&]+/, "$1*");
    const caching = ttl > 0 && (method === "GET" || key);
    const time = now();
    let cached;
    if (caching) {
      cached = cacheDatabase().prepare("SELECT body, fetched_at, expires_at, stale_until FROM http_cache WHERE key=?").get(cacheKey);
      if (cached && cached.expires_at > time) { stats.hits++; return JSON.parse(cached.body); }
    }
    const refresh = () => {
      const existing = inflight.get(cacheKey);
      if (existing) return existing;
      const promise = (async () => {
        const response = await send(target, { method, body, extraHeaders, priority, signal });
        const text = await read(response);
        let value;
        try { value = JSON.parse(text); } catch { throw new ProviderError(`${name} returned an invalid response`, { provider: name }); }
        if (caching) {
          const at = now();
          cacheDatabase().prepare(`INSERT INTO http_cache (key,provider,body,etag,fetched_at,expires_at,stale_until) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET body=excluded.body,etag=excluded.etag,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,stale_until=excluded.stale_until`)
            .run(cacheKey, name, text, response.headers.get("etag"), at, at + ttl * 1000, at + (ttl + Math.max(swr, staleIfError)) * 1000);
        }
        return value;
      })().finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, promise);
      return promise;
    };
    if (cached && cached.expires_at + swr * 1000 > time) {
      stats.stale++;
      refresh().catch(() => {});
      return JSON.parse(cached.body);
    }
    stats.misses++;
    try { return await refresh(); }
    catch (error) {
      if (cached && cached.stale_until > time && error.statusCode !== 404 && error.statusCode !== 401) { stats.stale++; return JSON.parse(cached.body); }
      throw error;
    }
  }

  return { name, json, stats, fetch: (path, options = {}) => send(url(path, options.params), { ...options, extraHeaders: options.headers }), resetBreaker() { failures = 0; openUntil = 0; } };
}

export function clearHttpCache(provider) {
  const database = cacheDatabase();
  if (provider) database.prepare("DELETE FROM http_cache WHERE provider=?").run(provider);
  else database.exec("DELETE FROM http_cache");
}

export function cacheSummary() {
  const database = cacheDatabase();
  const rows = database.prepare("SELECT provider, count(*) entries, sum(length(body)) bytes FROM http_cache GROUP BY provider").all();
  const images = database.prepare("SELECT count(*) entries, coalesce(sum(bytes),0) bytes, coalesce(sum(pinned),0) pinned FROM image_cache").get();
  return { providers: rows.map(row => ({ provider: row.provider, entries: row.entries, bytes: row.bytes })), images };
}
