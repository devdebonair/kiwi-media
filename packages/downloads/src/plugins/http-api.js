import { cookieHeader } from "../cookies.js";
import { DownloadError } from "../http.js";
import { parseHeaders } from "./direct.js";

// Reads values with paths like `data.files[].url`, `results[0].link`, or `download`.
// `[]` expands arrays, so one path can return several values.
export function pick(value, path) {
  if (!path) return [value];
  const tokens = [];
  for (const part of path.split(".")) {
    const [, name, rest] = part.match(/^([^\[]*)(.*)$/);
    if (name) tokens.push(name);
    for (const [, index] of rest.matchAll(/\[(\d*|\*)\]/g)) tokens.push(index === "" || index === "*" ? "*" : Number(index));
  }
  let values = [value];
  for (const token of tokens) {
    values = values.flatMap(item => {
      if (item == null) return [];
      if (token === "*") return Array.isArray(item) ? item : [];
      return Object.hasOwn(Object(item), token) ? [item[token]] : [];
    });
  }
  return values.filter(item => item !== undefined && item !== null && item !== "");
}

const fill = (template, values, encode) => template.replace(/\{(\w+)\}/g, (match, key) => key in values ? encode(String(values[key])) : match);
const jsonString = value => JSON.stringify(value).slice(1, -1);

export default {
  id: "http-api",
  name: "Custom HTTP API",
  description: "Uses your own proxy or resolver service: call its endpoints to search and to turn a link or ID into downloadable files.",
  cookies: true,
  fields: [
    { key: "resolveUrl", label: "Resolve endpoint", type: "text", required: true, placeholder: "https://resolver.example/api/resolve?url={source}", help: "Called for each download. {source} is replaced with the URL-encoded link, ID, or search result." },
    { key: "resolveMethod", label: "Resolve method", type: "select", default: "GET", options: [{ value: "GET", label: "GET" }, { value: "POST", label: "POST (JSON body)" }] },
    { key: "resolveBody", label: "POST body", type: "textarea", placeholder: "{\"url\": \"{source}\"}", help: "JSON body for POST. {source} is JSON-escaped." },
    { key: "fileUrlPath", label: "File URL path in response", type: "text", required: true, default: "url", help: "Where the response lists download URLs, e.g. download or data.files[].url." },
    { key: "fileNamePath", label: "File name path in response", type: "text", placeholder: "data.files[].name", help: "Optional; matches the URL path position by position." },
    { key: "titlePath", label: "Title path in response", type: "text", placeholder: "title" },
    { key: "searchUrl", label: "Search endpoint", type: "text", placeholder: "https://resolver.example/api/search?q={query}", help: "Optional. Enables the Search tab. {query} is URL-encoded." },
    { key: "searchResultsPath", label: "Search results path", type: "text", default: "results", help: "The array of results, e.g. results or data.items[]." },
    { key: "searchTitlePath", label: "Result title field", type: "text", default: "title" },
    { key: "searchSourcePath", label: "Result source field", type: "text", default: "url", help: "The value passed to the resolve endpoint as {source}." },
    { key: "searchDescriptionPath", label: "Result description field", type: "text", placeholder: "description" },
    { key: "searchSizePath", label: "Result size field (bytes)", type: "text", placeholder: "size" },
    { key: "headers", label: "Request headers", type: "secret-textarea", placeholder: "Authorization: Bearer …", help: "One “Name: value” header per line, sent to the API." },
    { key: "sendHeadersToFiles", label: "Also send headers when downloading files", type: "boolean", default: false },
  ],
  validate(config) {
    for (const key of ["resolveUrl", "searchUrl"]) if (config[key] && !/^https?:\/\//i.test(config[key])) throw new Error("Endpoints must start with http:// or https://.");
    if (config.resolveMethod === "POST" && config.resolveBody) {
      try { JSON.parse(fill(config.resolveBody, { source: "x" }, jsonString)); } catch { throw new Error("POST body must be valid JSON."); }
    }
  },
  accepts: source => Boolean(source.trim()),
  searchable: config => Boolean(config.searchUrl),
  async search({ query, config, http }) {
    if (!config.searchUrl) throw new DownloadError("This downloader has no search endpoint.");
    const body = await http.json(fill(config.searchUrl, { query }, encodeURIComponent), { headers: parseHeaders(config.headers) });
    const rows = pick(body, config.searchResultsPath || "results").flatMap(item => Array.isArray(item) ? item : [item]);
    return rows.slice(0, 50).map(row => ({
      title: String(pick(row, config.searchTitlePath || "title")[0] ?? "Untitled"),
      source: String(pick(row, config.searchSourcePath || "url")[0] ?? ""),
      description: config.searchDescriptionPath ? String(pick(row, config.searchDescriptionPath)[0] ?? "") : undefined,
      size: config.searchSizePath ? Number(pick(row, config.searchSizePath)[0]) || undefined : undefined,
    })).filter(row => row.source);
  },
  async download(ctx) {
    const { config } = ctx, headers = parseHeaders(config.headers);
    ctx.progress({ message: "Resolving with the API" });
    const url = fill(config.resolveUrl, { source: ctx.source }, encodeURIComponent);
    const body = config.resolveMethod === "POST"
      ? await ctx.http.json(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: config.resolveBody ? fill(config.resolveBody, { source: ctx.source }, jsonString) : JSON.stringify({ source: ctx.source }) })
      : await ctx.http.json(url, { headers });
    const urls = pick(body, config.fileUrlPath || "url").map(String);
    if (!urls.length || urls.some(value => !/^https?:\/\//i.test(value))) throw new DownloadError(`The API response had no file URLs at “${config.fileUrlPath || "url"}”`);
    const names = config.fileNamePath ? pick(body, config.fileNamePath).map(String) : [];
    const title = config.titlePath ? pick(body, config.titlePath)[0] : undefined;
    if (title) ctx.progress({ title: String(title) });
    for (const [index, fileUrl] of urls.entries()) {
      const fileHeaders = config.sendHeadersToFiles ? { ...headers } : {};
      const cookie = cookieHeader(ctx.cookies, fileUrl);
      if (cookie) fileHeaders.cookie = cookie;
      ctx.progress({ message: urls.length > 1 ? `Downloading file ${index + 1} of ${urls.length}` : "Downloading" });
      await ctx.http.download(fileUrl, { dir: ctx.workDir, filename: names[index], headers: fileHeaders, onProgress: update => ctx.progress({ ...update, fraction: update.totalBytes ? (index + update.bytes / update.totalBytes) / urls.length : null }) });
    }
    return { title: title ? String(title) : undefined };
  },
};
