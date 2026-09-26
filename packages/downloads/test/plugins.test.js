import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHttp, tempDataDir } from "./helpers.js";

const dataDir = tempDataDir();
const { realDebrid, torBox } = await import("../src/plugins/debrid.js");
const httpApi = (await import("../src/plugins/http-api.js")).default;
const { createHttp } = await import("../src/index.js");

// Records API calls and answers them from a route table; file downloads are recorded, not fetched.
function fakeContext(source, config, routes) {
  const calls = [], saved = [];
  const answer = (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body, headers: init.headers });
    const key = Object.keys(routes).find(prefix => `${init.method || "GET"} ${url}`.startsWith(prefix));
    if (!key) throw new Error(`Unexpected ${init.method || "GET"} ${url}`);
    return typeof routes[key] === "function" ? routes[key](url, init) : routes[key];
  };
  const http = { json: async (url, init) => answer(url, init), request: async (url, init) => ({ text: JSON.stringify(answer(url, init)) }), download: async (url, options) => { saved.push({ url, filename: options.filename }); } };
  return { calls, saved, ctx: { source, config, http, workDir: "/tmp/w", progress() {}, log() {}, signal: new AbortController().signal } };
}

test("Real-Debrid unrestricts hoster links", async () => {
  const { ctx, saved, calls } = fakeContext("https://hoster.example/file/1", { apiToken: "rd" }, {
    "POST https://api.real-debrid.com/rest/1.0/unrestrict/link": { download: "https://cdn.rd/f.mkv", filename: "f.mkv" },
  });
  await realDebrid.download(ctx);
  assert.deepEqual(saved, [{ url: "https://cdn.rd/f.mkv", filename: "f.mkv" }]);
  assert.equal(calls[0].headers.authorization, "Bearer rd");
  assert.equal(calls[0].body.get("link"), "https://hoster.example/file/1");
});

test("Real-Debrid caches magnets, selects media files, downloads each link, then cleans up", async () => {
  let polls = 0;
  const { ctx, saved, calls } = fakeContext("magnet:?xt=urn:btih:abc", { apiToken: "rd" }, {
    "POST https://api.real-debrid.com/rest/1.0/torrents/addMagnet": { id: "T1" },
    "GET https://api.real-debrid.com/rest/1.0/torrents/info/T1": () => ++polls === 1
      ? { status: "waiting_files_selection", files: [{ id: 1, path: "/Movie.mkv" }, { id: 2, path: "/info.nfo" }, { id: 3, path: "/Extra.mp4" }] }
      : { status: "downloaded", filename: "Movie", links: ["https://rd/l1", "https://rd/l2"] },
    "POST https://api.real-debrid.com/rest/1.0/torrents/selectFiles/T1": {},
    "POST https://api.real-debrid.com/rest/1.0/unrestrict/link": (url, init) => ({ download: `${init.body.get("link")}/dl`, filename: "x.mkv" }),
    "DELETE https://api.real-debrid.com/rest/1.0/torrents/delete/T1": {},
  });
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => originalTimeout(fn, 0, ...args);
  try { assert.deepEqual(await realDebrid.download(ctx), { title: "Movie" }); } finally { globalThis.setTimeout = originalTimeout; }
  assert.equal(calls.find(call => call.url.includes("selectFiles")).body.get("files"), "1,3");
  assert.deepEqual(saved.map(file => file.url), ["https://rd/l1/dl", "https://rd/l2/dl"]);
  assert.equal(calls.at(-1).method, "DELETE");
});

test("TorBox creates a torrent, waits until it is cached, and requests each file link", async () => {
  const { ctx, saved, calls } = fakeContext("magnet:?xt=urn:btih:abc", { apiKey: "tb", deleteAfter: true }, {
    "POST https://api.torbox.app/v1/api/torrents/createtorrent": { success: true, data: { torrent_id: 7 } },
    "GET https://api.torbox.app/v1/api/torrents/mylist?id=7": { success: true, data: { name: "Show", download_present: true, files: [{ id: 0, short_name: "E1.mkv" }, { id: 1, short_name: "readme.txt" }] } },
    "GET https://api.torbox.app/v1/api/torrents/requestdl": (url) => ({ success: true, data: `https://cdn.tb/${new URL(url).searchParams.get("file_id")}` }),
    "POST https://api.torbox.app/v1/api/torrents/controltorrent": { success: true },
  });
  assert.deepEqual(await torBox.download(ctx), { title: "Show" });
  assert.deepEqual(saved, [{ url: "https://cdn.tb/0", filename: "E1.mkv" }]);
  assert.equal(new URL(calls.find(call => call.url.includes("requestdl")).url).searchParams.get("token"), "tb");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { torrent_id: 7, operation: "delete" });
});

test("the custom HTTP API plugin searches and resolves through configured endpoints", async () => {
  const seen = [];
  const server = await startHttp({
    "/search": (req, res) => { seen.push(req); res.end(JSON.stringify({ data: { items: [{ name: "Clip", id: "abc", bytes: 5 }] } })); },
    "/resolve": (req, res) => { let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => { seen.push({ headers: req.headers, body }); res.end(JSON.stringify({ title: "Resolved clip", files: [{ link: `http://${req.headers.host}/file`, name: "clip.mp4" }] })); }); },
    "/file": (req, res) => { seen.push(req); res.end("bytes"); },
  });
  const config = {
    resolveUrl: `${server.url}/resolve`, resolveMethod: "POST", resolveBody: "{\"id\": \"{source}\"}", fileUrlPath: "files[].link", fileNamePath: "files[].name", titlePath: "title",
    searchUrl: `${server.url}/search?q={query}`, searchResultsPath: "data.items", searchTitlePath: "name", searchSourcePath: "id", searchSizePath: "bytes",
    headers: "Authorization: Bearer key", sendHeadersToFiles: false,
  };
  const http = createHttp();
  try {
    assert.deepEqual(await httpApi.search({ query: "a b", config, http }), [{ title: "Clip", source: "abc", description: undefined, size: 5 }]);
    assert.equal(new URL(seen[0].url, "http://x").searchParams.get("q"), "a b");
    const titles = [];
    await httpApi.download({ source: "abc\"", config, http, workDir: join(dataDir, "api"), progress: update => update.title && titles.push(update.title), log() {} });
    assert.deepEqual(JSON.parse(seen[1].body), { id: "abc\"" });
    assert.equal(seen[1].headers.authorization, "Bearer key");
    assert.equal(seen[2].headers.authorization, undefined, "API headers are not sent to file hosts unless enabled");
    assert.equal(readFileSync(join(dataDir, "api", "clip.mp4"), "utf8"), "bytes");
    assert.deepEqual(titles, ["Resolved clip"]);
  } finally { http.close(); await server.close(); }
});
