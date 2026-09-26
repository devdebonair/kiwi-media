import { ConfigError } from "./fields.js";

// Netscape cookies.txt: domain, include-subdomains, path, secure, expiry, name, value (tab separated).
// "#HttpOnly_" prefixes mark HTTP-only cookies and are otherwise ordinary lines.
export function parseCookies(text) {
  const cookies = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw;
    if (line.startsWith("#HttpOnly_")) line = line.slice(10);
    else if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, secure, expires, name, ...value] = parts;
    cookies.push({ domain: domain.toLowerCase(), path: path || "/", secure: secure.toUpperCase() === "TRUE", expires: Number(expires) || 0, name, value: value.join("\t") });
  }
  return cookies;
}

export function validateCookiesFile(text) {
  if (typeof text !== "string" || !text.trim()) throw new ConfigError("Choose a cookies.txt file.");
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ConfigError("cookies.txt must be smaller than 2 MB.");
  if (!parseCookies(text).length) throw new ConfigError("This is not a Netscape-format cookies.txt file. Export cookies with a “cookies.txt” browser extension or yt-dlp --cookies-from-browser.");
  const normalized = text.replace(/\r\n/g, "\n");
  return /^# (Netscape )?HTTP Cookie File/.test(normalized) ? normalized : `# Netscape HTTP Cookie File\n${normalized}`;
}

// Builds a Cookie header for plugins that fetch files directly.
export function cookieHeader(text, target) {
  if (!text) return undefined;
  let url;
  try { url = new URL(target); } catch { return undefined; }
  const host = url.hostname.toLowerCase(), now = Date.now() / 1000;
  const matches = parseCookies(text).filter(cookie => {
    const domain = cookie.domain.replace(/^\./, "");
    if (!(host === domain || host.endsWith(`.${domain}`))) return false;
    if (cookie.secure && url.protocol !== "https:") return false;
    if (cookie.expires && cookie.expires < now) return false;
    return url.pathname.startsWith(cookie.path);
  });
  return matches.length ? matches.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") : undefined;
}
