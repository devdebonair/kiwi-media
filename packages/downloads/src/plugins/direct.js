import { cookieHeader } from "../cookies.js";

export default {
  id: "direct",
  name: "Direct link",
  description: "Saves a file straight from its URL.",
  cookies: true,
  fields: [
    { key: "headers", label: "Extra request headers", type: "secret-textarea", placeholder: "Referer: https://example.com/\nAuthorization: Bearer …", help: "One “Name: value” header per line." },
  ],
  accepts: source => /^https?:\/\//i.test(source),
  async download(ctx) {
    const headers = parseHeaders(ctx.config.headers);
    const cookie = cookieHeader(ctx.cookies, ctx.source);
    if (cookie) headers.cookie = cookie;
    ctx.progress({ message: "Downloading" });
    await ctx.http.download(ctx.source, { dir: ctx.workDir, headers, onProgress: ctx.progress });
  },
};

export function parseHeaders(text) {
  const headers = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (match) headers[match[1].toLowerCase()] = match[2];
  }
  return headers;
}
