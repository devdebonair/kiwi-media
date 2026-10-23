import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { dataDir } from "@kiwi/database";

// Every time ffmpeg, ffprobe, or a browser opens a streamed file it reads the file's start (anime releases
// often carry 20+ MB of subtitle fonts before the first frame) and its end (the seek index). Those parts are
// kept on disk in 1 MB blocks, so only the first open of a source pays for them; the middle of the file is
// passed straight through. Readers get a local address that behaves like the remote file, range requests
// included, and expired TorBox links are refreshed behind it.

const MiB = 1024 ** 2;
export const SOURCE_CACHE_MAX_BYTES = 3 * 1024 ** 3;
const SAFE = /^[A-Za-z0-9_-]{1,80}$/;

export function createSourceCache({
  directory = join(dataDir, "cache", "streams"), resolve, block = MiB, headBytes = 64 * MiB, tailBytes = 16 * MiB,
  maxBytes = SOURCE_CACHE_MAX_BYTES, fetchImpl = fetch, log = () => {},
} = {}) {
  const token = randomBytes(12).toString("hex");
  const metas = new Map();
  let server = null, listening = null, writes = 0;

  const dirOf = key => join(directory, key);
  const blockPath = (key, index) => join(dirOf(key), String(index));

  // Opens the remote file at a byte range, getting a fresh link once if the current one is refused.
  async function upstream(key, from, to, signal) {
    for (const force of [false, true]) {
      const url = await resolve(key, { force });
      const response = await fetchImpl(url, { headers: { range: `bytes=${from}-${to ?? ""}` }, signal, redirect: "follow" });
      if (!force && [401, 403, 404, 410].includes(response.status)) { await response.body?.cancel().catch(() => {}); continue; }
      if (response.status !== 206 && !(response.status === 200 && from === 0)) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`The source responded ${response.status}`), { status: response.status === 416 ? 416 : 502 });
      }
      return response;
    }
  }

  async function meta(key, signal) {
    if (metas.has(key)) return metas.get(key);
    const file = join(dirOf(key), "meta.json");
    if (existsSync(file)) {
      try { const stored = JSON.parse(readFileSync(file, "utf8")); if (stored.size > 0) { metas.set(key, stored); return stored; } } catch { /* Read it again below. */ }
    }
    const response = await upstream(key, 0, 0, signal);
    await response.body?.cancel().catch(() => {});
    const size = Number(response.headers.get("content-range")?.split("/")[1] || response.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size <= 0) throw Object.assign(new Error("The source did not report its size"), { status: 502 });
    const value = { size, type: response.headers.get("content-type") || "application/octet-stream" };
    mkdirSync(dirOf(key), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
    metas.set(key, value);
    return value;
  }

  const blocksIn = size => Math.ceil(size / block);
  const kept = (size, index) => index * block < headBytes || (index + 1) * block > size - tailBytes;
  const cached = (key, index) => existsSync(blockPath(key, index));

  function save(key, index, data) {
    const target = blockPath(key, index), partial = `${target}.${randomBytes(4).toString("hex")}.partial`;
    writeFileSync(partial, data);
    renameSync(partial, target);
    if (++writes % 64 === 0) evict();
  }

  // Oldest-used sources go first once the cache is over its limit.
  function evict() {
    if (!existsSync(directory)) return;
    const entries = readdirSync(directory).map(name => {
      const dir = join(directory, name);
      let bytes = 0;
      for (const file of readdirSync(dir)) bytes += statSync(join(dir, file)).size;
      const touched = existsSync(join(dir, "meta.json")) ? statSync(join(dir, "meta.json")).mtimeMs : 0;
      return { name, bytes, touched };
    }).sort((a, b) => a.touched - b.touched);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      if (total <= maxBytes * 0.9) break;
      rmSync(join(directory, entry.name), { recursive: true, force: true });
      metas.delete(entry.name);
      total -= entry.bytes;
    }
  }

  // Writes bytes to the reader, waiting when it is not keeping up. Resolves false once the reader has gone.
  async function send(res, chunk) {
    if (res.destroyed) return false;
    if (!res.write(chunk)) {
      await new Promise(resolve => {
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.on("drain", done); res.on("close", done);
      });
    }
    return !res.destroyed;
  }

  // Sends bytes [from, to] of the source, from disk where kept and from the remote file otherwise.
  async function serve(key, size, from, to, res, signal) {
    let at = from;
    while (at <= to) {
      const index = Math.floor(at / block);
      if (cached(key, index)) {
        const data = readFileSync(blockPath(key, index));
        const slice = data.subarray(at - index * block, Math.min(data.length, to - index * block + 1));
        if (!slice.length) throw new Error("A cached block is shorter than expected");
        if (!(await send(res, slice))) return;
        at += slice.length;
        continue;
      }
      // A run of blocks that are all missing and all kept (or all passed through), up to the end of the request.
      const keep = kept(size, index);
      let last = index;
      while (last + 1 < blocksIn(size) && (last + 1) * block <= to && kept(size, last + 1) === keep && !cached(key, last + 1)) last++;
      const start = keep ? index * block : at;
      const end = keep ? Math.min(size - 1, (last + 1) * block - 1) : Math.min(to, (last + 1) * block - 1);
      const response = await upstream(key, start, end, signal);
      let position = start, pending = [], pendingBytes = 0, current = index;
      for await (const chunk of Readable.fromWeb(response.body)) {
        let piece = chunk;
        while (piece.length && position <= end) {
          if (keep) {
            const room = Math.min(piece.length, (current + 1) * block - position, end - position + 1);
            pending.push(piece.subarray(0, room)); pendingBytes += room;
            const blockEnd = Math.min(size, (current + 1) * block);
            if (position + room === blockEnd) { save(key, current, Buffer.concat(pending, pendingBytes)); pending = []; pendingBytes = 0; current++; }
            const wanted = piece.subarray(Math.max(0, at - position), Math.min(room, to - position + 1));
            if (position + room > at && wanted.length && !(await send(res, wanted))) return;
            if (position + room > at) at = Math.min(to + 1, position + room);
            position += room; piece = piece.subarray(room);
          } else {
            const room = Math.min(piece.length, end - position + 1);
            if (!(await send(res, piece.subarray(0, room)))) return;
            position += room; at = position; piece = piece.subarray(room);
          }
        }
        if (position > end) break;
      }
      if (position <= end) throw new Error("The source ended early");
    }
  }

  async function handle(req, res) {
    const match = /^\/([a-f0-9]+)\/([^/?]+)$/.exec(req.url || "");
    const key = match && match[1] === token ? decodeURIComponent(match[2]) : null;
    if (!key || !SAFE.test(key) || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404).end(); return; }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const { size, type } = await meta(key, controller.signal);
      const touch = join(dirOf(key), "meta.json"), time = new Date();
      try { utimesSync(touch, time, time); } catch { /* Only used for eviction order. */ }
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      let from = 0, to = size - 1;
      if (range && range[1]) { from = Number(range[1]); if (range[2]) to = Math.min(size - 1, Number(range[2])); }
      else if (range && range[2]) from = Math.max(0, size - Number(range[2]));
      if (from >= size || from > to) { res.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return; }
      res.writeHead(range ? 206 : 200, {
        "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(to - from + 1),
        ...(range ? { "Content-Range": `bytes ${from}-${to}/${size}` } : {}),
      });
      if (req.method === "HEAD") { res.end(); return; }
      await serve(key, size, from, to, res, controller.signal);
      res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      log(`stream cache for ${key}: ${error.message}`);
      if (!res.headersSent) res.writeHead(error.status || 502, { "Content-Type": "text/plain" }).end(error.message);
      else res.destroy(error);
    }
  }

  function listen() {
    listening ||= new Promise((done, fail) => {
      server = createServer((req, res) => { handle(req, res); });
      server.keepAliveTimeout = 5_000;
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done(server.address().port));
      server.unref();
    });
    return listening;
  }

  return {
    // A local address for the source that readers can open like the remote file.
    async address(key) {
      if (!SAFE.test(key)) throw new Error("Invalid source key");
      mkdirSync(directory, { recursive: true });
      const port = await listen();
      return `http://127.0.0.1:${port}/${token}/${encodeURIComponent(key)}`;
    },
    forget(key) { if (SAFE.test(key)) { metas.delete(key); rmSync(dirOf(key), { recursive: true, force: true }); } },
    evict,
    close() { server?.close(); server = null; listening = null; },
  };
}
