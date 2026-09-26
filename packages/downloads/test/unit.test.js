import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createPrivateKey } from "node:crypto";
import { tempDataDir, startHttp, startSocks } from "./helpers.js";

tempDataDir();
const { maskConfig, mergeConfig, cookieHeader, validateCookiesFile, validateVpnConfig, parseWireguard, proxyUrlFor, createHttp, checkPlugin, validatePluginConfig, getPlugin } = await import("../src/index.js");
const { pick } = await import("../src/plugins/http-api.js");
const { ytDlpArgs } = await import("../src/plugins/yt-dlp.js");
const { piaWireguardConfig } = await import("../src/pia.js");

test("secrets are masked for the browser and kept unless replaced or cleared", () => {
  const fields = [{ key: "token", label: "Token", type: "secret", required: true }, { key: "mode", label: "Mode", type: "text", default: "fast" }];
  const saved = mergeConfig(fields, {}, { token: "s3cret" });
  assert.deepEqual(saved, { token: "s3cret", mode: "fast" });
  assert.deepEqual(maskConfig(fields, saved), { values: { mode: "fast" }, secrets: { token: true } });
  assert.equal(mergeConfig(fields, saved, { token: "", mode: "slow" }).token, "s3cret");
  assert.throws(() => mergeConfig(fields, saved, {}, ["token"]), /Token is required/);
  assert.throws(() => mergeConfig([{ key: "on", label: "On", type: "boolean" }], {}, { on: "yes" }), /on or off/);
});

test("cookies.txt is validated and matched by domain, path, secure flag, and expiry", () => {
  const file = validateCookiesFile(".example.com\tTRUE\t/\tTRUE\t0\tsid\tabc\n#HttpOnly_media.example.com\tFALSE\t/videos\tFALSE\t0\tpref\t1\nold.example.com\tFALSE\t/\tFALSE\t1\texpired\tx\n");
  assert.match(file, /^# Netscape HTTP Cookie File/);
  assert.equal(cookieHeader(file, "https://media.example.com/videos/1"), "sid=abc; pref=1");
  assert.equal(cookieHeader(file, "http://media.example.com/videos/1"), "pref=1");
  assert.equal(cookieHeader(file, "https://example.org/"), undefined);
  assert.equal(cookieHeader(file, "https://old.example.com/"), "sid=abc");
  assert.throws(() => validateCookiesFile("not cookies"), /Netscape-format/);
});

test("proxy profiles normalize addresses and keep credentials in masked fields", () => {
  const config = validateVpnConfig("proxy", {}, { url: "socks5://x123:p@ss@proxy-nl.privateinternetaccess.com:1080" });
  assert.deepEqual(config, { url: "socks5h://proxy-nl.privateinternetaccess.com:1080", username: "x123", password: "p@ss" });
  assert.equal(proxyUrlFor(config), "socks5h://x123:p%40ss@proxy-nl.privateinternetaccess.com:1080");
  assert.equal(validateVpnConfig("proxy", {}, { url: "http://gluetun:8888" }).url, "http://gluetun:8888");
  for (const url of ["ftp://host:21", "socks5://host", "http://host:80/path", "::"]) assert.throws(() => validateVpnConfig("proxy", {}, { url }), { statusCode: 400 });
});

test("WireGuard configs keep tunnel settings and drop wg-quick hooks", () => {
  const conf = parseWireguard("[Interface]\nPrivateKey = abc=\nAddress = 10.0.0.2/32\nDNS = 10.0.0.1\nPostUp = rm -rf /\nTable = off\n\n[Peer]\nPublicKey = def=\nEndpoint = 1.2.3.4:51820 # home\nAllowedIPs = 0.0.0.0/0\n");
  assert.doesNotMatch(conf, /PostUp|Table/);
  assert.match(conf, /Endpoint = 1\.2\.3\.4:51820\n/);
  assert.throws(() => parseWireguard("[Interface]\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = x\nEndpoint = y:1"), /PrivateKey/);
  assert.throws(() => parseWireguard("[Interface]\nPrivateKey = a\nAddress = b\n"), /Peer/);
});

test("HTTP requests are routed through the SOCKS5 proxy with remote DNS", async () => {
  const origin = await startHttp({ "/hello.json": Buffer.from('{"ok":true}') });
  const socks = await startSocks({ username: "user", password: "pa:ss" });
  try {
    const port = new URL(origin.url).port;
    const http = createHttp({ proxyUrl: `socks5h://user:${encodeURIComponent("pa:ss")}@127.0.0.1:${socks.port}` });
    assert.deepEqual(await http.json(`http://localhost:${port}/hello.json`), { ok: true });
    assert.deepEqual(socks.requests, [{ host: "localhost", port: Number(port) }]);
    http.close();
    const wrong = createHttp({ proxyUrl: `socks5://user:nope@127.0.0.1:${socks.port}` });
    await assert.rejects(wrong.json(`http://localhost:${port}/hello.json`), /Could not reach/);
    wrong.close();
  } finally { await origin.close(); await socks.close(); }
});

test("plugin definitions are checked before loading", async () => {
  assert.throws(() => checkPlugin({ id: "Bad Id", name: "x", download() {} }), /id must be/);
  assert.throws(() => checkPlugin({ id: "ok", name: "x" }), /download/);
  assert.throws(() => checkPlugin({ id: "ok", name: "x", download() {}, fields: [{ key: "k", label: "K", type: "file" }] }), /unknown type/);
  const ytDlp = await getPlugin("yt-dlp");
  assert.throws(() => validatePluginConfig(ytDlp, {}, { outputTemplate: "../%(title)s.%(ext)s" }), /inside the download folder/);
  assert.throws(() => validatePluginConfig(ytDlp, {}, { rateLimit: "fast" }), /Speed limit/);
});

test("yt-dlp receives the proxy, cookies, and native fragment downloaders", () => {
  const args = ytDlpArgs({ source: "https://youtu.be/x", config: { allowPlaylists: false }, workDir: "/tmp/w", proxyUrl: "socks5h://127.0.0.1:9", cookiesFile: "/tmp/c.txt" });
  assert.deepEqual(args.slice(-2), ["--", "https://youtu.be/x"]);
  for (const pair of [["--proxy", "socks5h://127.0.0.1:9"], ["--cookies", "/tmp/c.txt"], ["-P", "/tmp/w"], ["--merge-output-format", "mp4"]]) assert.equal(args[args.indexOf(pair[0]) + 1], pair[1]);
  assert.ok(args.includes("--no-playlist") && args.includes("--ignore-config"));
  assert.equal(args[args.indexOf("--js-runtimes") + 1], `node:${process.execPath}`);
  assert.ok(!ytDlpArgs({ source: "https://a.b", config: {}, workDir: "/w" }).includes("--proxy"));
});

test("custom API paths expand arrays and nested fields", () => {
  const body = { data: { files: [{ url: "https://a/1", name: "one" }, { url: "https://a/2" }] }, results: [[{ t: 1 }]], download: "https://b" };
  assert.deepEqual(pick(body, "data.files[].url"), ["https://a/1", "https://a/2"]);
  assert.deepEqual(pick(body, "data.files[0].name"), ["one"]);
  assert.deepEqual(pick(body, "download"), ["https://b"]);
  assert.deepEqual(pick(body, "missing.path"), []);
  assert.deepEqual(pick(body, "__proto__"), []);
});

test("PIA WireGuard signs in, registers a fresh key with the region's server, and builds a config", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href.includes("/api/client/v2/token")) return Response.json({ token: "tok" });
    if (href.includes("serverlist")) return new Response(`${JSON.stringify({ regions: [{ id: "nl_amsterdam", name: "Netherlands", servers: { wg: [{ ip: "203.0.113.9", cn: "amsterdam401" }] } }] })}\nSIGNATURE`);
    if (href.includes(":1337/addKey")) return Response.json({ status: "OK", server_key: "SERVERKEY=", server_port: 1337, server_ip: "203.0.113.9", peer_ip: "10.1.2.3", dns_servers: ["10.0.0.243"] });
    throw new Error(`unexpected ${href}`);
  };
  const conf = await piaWireguardConfig({ username: "p123", password: "pw", region: "nl_amsterdam" }, { fetchImpl });
  const token = calls[0].init.body;
  assert.ok(token instanceof URLSearchParams, "credentials are sent as a form undici can serialize");
  assert.equal(token.get("username"), "p123");
  const addKey = new URL(calls.find(call => call.href.includes("addKey")).href);
  assert.equal(addKey.hostname, "203.0.113.9");
  assert.equal(addKey.searchParams.get("pt"), "tok");
  assert.ok(calls.find(call => call.href.includes("addKey")).init.dispatcher, "addKey uses a dispatcher pinned to PIA's CA");
  const privateKey = conf.match(/PrivateKey = (.+)/)[1];
  const derived = createPublicKey(createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: Buffer.from(privateKey, "base64").toString("base64url"), x: Buffer.from(addKey.searchParams.get("pubkey"), "base64").toString("base64url") }, format: "jwk" }));
  assert.equal(Buffer.from(derived.export({ format: "jwk" }).x, "base64url").toString("base64"), addKey.searchParams.get("pubkey"));
  assert.match(conf, /Address = 10\.1\.2\.3\n/);
  assert.match(conf, /Endpoint = 203\.0\.113\.9:1337\n/);
  assert.match(conf, /DNS = 10\.0\.0\.243/);
  await assert.rejects(piaWireguardConfig({ username: "p", password: "x", region: "nl_amsterdam" }, { fetchImpl: async () => new Response("{}", { status: 401 }) }), /rejected/);
});
