import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch } from "undici";

export class DownloadError extends Error {
  constructor(message, details) { super(message); this.name = "DownloadError"; this.details = details; }
}

const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// socks5h is the curl/yt-dlp spelling for remote DNS; undici always resolves through SOCKS5.
export function dispatcherFor(proxyUrl, connect) {
  if (!proxyUrl) return new Agent(connect ? { connect } : {});
  const url = new URL(proxyUrl);
  if (/^socks5?h?:$/.test(url.protocol)) {
    const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    url.username = ""; url.password = "";
    return new Socks5ProxyAgent(`socks5://${url.host}`, { ...(username ? { username, password } : {}), ...(connect ? { requestTls: connect } : {}) });
  }
  if (["http:", "https:"].includes(url.protocol)) return new ProxyAgent({ uri: url.href, ...(connect ? { requestTls: connect } : {}) });
  throw new DownloadError(`Unsupported proxy protocol ${url.protocol}`);
}

export function safeFilename(name, fallback = "download") {
  const cleaned = String(name || "").normalize("NFC").replace(/[\/\\\0-\x1f\x7f]/g, " ").replace(/[<>:"|?*]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  let result = cleaned || fallback;
  while (Buffer.byteLength(result) > 200) result = result.slice(0, -1);
  return result;
}

export function filenameFromResponse(response, url) {
  const disposition = response.headers.get("content-disposition") || "";
  const star = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) try { return safeFilename(decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""))); } catch {}
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plain) return safeFilename(plain[1]);
  try { return safeFilename(decodeURIComponent(basename(new URL(response.url || url).pathname))); } catch { return "download"; }
}

// An HTTP client bound to one route (direct or proxied). Plugins must use it instead of the global
// fetch so every request of a VPN-routed job leaves through the tunnel.
export function createHttp({ proxyUrl = null, signal, tls } = {}) {
  const dispatcher = dispatcherFor(proxyUrl, tls);
  const signals = init => AbortSignal.any([signal, init?.signal, init?.timeout ? AbortSignal.timeout(init.timeout) : null].filter(Boolean));
  async function fetch(url, init = {}) {
    const { timeout, ...rest } = init;
    return undiciFetch(url, { ...rest, dispatcher, signal: signals({ signal: init.signal, timeout }), headers: { "user-agent": userAgent, ...init.headers } });
  }
  async function request(url, init = {}) {
    let response;
    try { response = await fetch(url, { timeout: 30_000, ...init }); }
    catch (error) {
      if (signal?.aborted) throw error;
      throw new DownloadError(`Could not reach ${hostOf(url)}: ${error.cause?.message || error.message}`);
    }
    const text = await response.text();
    if (!response.ok) throw new DownloadError(`${hostOf(url)} responded ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`, { status: response.status, body: text });
    return { response, text };
  }
  async function json(url, init) {
    const { text } = await request(url, init);
    try { return JSON.parse(text); } catch { throw new DownloadError(`${hostOf(url)} returned invalid JSON`); }
  }
  // Streams a file into `dir`, reporting progress. Returns the saved path.
  async function download(url, { dir, filename, headers, onProgress = () => {} } = {}) {
    let response;
    try { response = await fetch(url, { headers }); }
    catch (error) {
      if (signal?.aborted) throw error;
      throw new DownloadError(`Could not reach ${hostOf(url)}: ${error.cause?.message || error.message}`);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new DownloadError(`${hostOf(url)} responded ${response.status} for the file download`);
    }
    await mkdir(dir, { recursive: true });
    const path = join(dir, safeFilename(filename || filenameFromResponse(response, url)));
    const total = Number(response.headers.get("content-length")) || null;
    let done = 0, last = 0, lastBytes = 0, lastTime = Date.now(), speed = null;
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      done += chunk.length;
      const now = Date.now();
      if (now - last > 500) {
        speed = (done - lastBytes) / ((now - lastTime) / 1000);
        lastBytes = done; lastTime = now; last = now;
        onProgress({ bytes: done, totalBytes: total, speed, eta: total && speed ? Math.round((total - done) / speed) : null });
      }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(path), { signal });
    onProgress({ bytes: done, totalBytes: total ?? done, speed, eta: 0 });
    return path;
  }
  return { fetch, request, json, download, proxyUrl, close: () => dispatcher.close().catch(() => {}) };
}

export function hostOf(url) {
  try { return new URL(url).host || String(url); } catch { return String(url).slice(0, 60); }
}
