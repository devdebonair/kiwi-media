import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startHttp, startSocks, tempDataDir, until } from "./helpers.js";

const dataDir = tempDataDir();
const { db } = await import("@kiwi/database");
const { planDownload, destinationFor, createTunnelManager } = await import("../src/index.js");
const { createDownloadRunner } = await import("../src/runner.js");
const now = new Date().toISOString();
const root = join(dataDir, "library");
mkdirSync(root);
db.prepare("INSERT INTO library_roots (id,name,absolute_path,read_only,created_at) VALUES ('root','Library',?,0,?)").run(root, now);
const addProfile = (id, type, config) => db.prepare("INSERT INTO vpn_profiles VALUES (?,?,?,?,?,?)").run(id, id, type, JSON.stringify(config), now, now);
const addDownloader = (id, plugin, extra = {}) => db.prepare("INSERT INTO downloaders (id,name,plugin,config_json,vpn_profile_id,enabled,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(id, id, plugin, JSON.stringify(extra.config || {}), extra.vpn || null, extra.enabled ?? 1, 0, now, now);
const queue = (id, source, extra = {}) => db.prepare("INSERT INTO downloads (id,source,downloader_id,plugin,library_root_id,subfolder,vpn_mode,vpn_profile_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run(id, source, extra.downloader || "direct", "direct", "root", extra.subfolder || "", extra.vpn ? "profile" : "none", extra.vpn || null, "queued", new Date().toISOString(), now);
const job = id => db.prepare("SELECT * FROM downloads WHERE id=?").get(id);
after(() => db.close());

test("plans pick the most specific domain rule, then the downloader default, and honor explicit choices", async () => {
  addProfile("vpn-a", "proxy", { url: "socks5h://127.0.0.1:1" });
  addProfile("vpn-b", "proxy", { url: "socks5h://127.0.0.1:2" });
  addDownloader("direct", "direct", { vpn: "vpn-a" });
  db.prepare("INSERT INTO vpn_domain_rules VALUES ('example.com','vpn-a',?),('music.example.com','vpn-b',?)").run(now, now);
  let plan = await planDownload({ source: "https://a.music.example.com/x" });
  assert.equal(plan.downloader.id, "downloader-yt-dlp");
  assert.equal(plan.profile.id, "vpn-b");
  assert.equal(plan.reason, "Domain rule for music.example.com");
  plan = await planDownload({ source: "https://notexample.com/x", downloaderId: "direct" });
  assert.equal(plan.profile.id, "vpn-a");
  assert.equal(plan.reason, "Default for direct");
  assert.equal((await planDownload({ source: "https://example.com/x", vpn: "none" })).profile, null);
  assert.equal((await planDownload({ source: "https://other.org/x", downloaderId: "direct", vpn: "vpn-b" })).profile.id, "vpn-b");
  await assert.rejects(planDownload({ source: "magnet:?xt=urn:btih:abc" }), /Real-Debrid or TorBox/);
  await assert.rejects(planDownload({ source: "magnet:?xt=urn:btih:abc", downloaderId: "direct" }), /cannot download/);
  db.exec("DELETE FROM vpn_domain_rules; UPDATE downloaders SET vpn_profile_id=NULL");
});

test("destinations stay inside the chosen library folder", () => {
  assert.equal(destinationFor("root", "Clips/2026/").path, join(root, "Clips/2026"));
  assert.equal(destinationFor("root", "/etc").path, join(root, "etc"), "leading slashes are relative to the library folder");
  for (const bad of ["../escape", "a/../../b", "..", ".kiwi-download-x"]) assert.throws(() => destinationFor("root", bad), /inside the library/, bad);
  assert.throws(() => destinationFor("missing"), { statusCode: 404 });
});

test("a proxied download is staged, moved into the library without overwriting, and imported", async () => {
  const origin = await startHttp({ "/clip.mp4": Buffer.from("video-bytes") });
  const socks = await startSocks();
  addProfile("socks", "proxy", { url: `socks5h://127.0.0.1:${socks.port}` });
  mkdirSync(join(root, "Clips"), { recursive: true });
  writeFileSync(join(root, "Clips", "clip.mp4"), "existing");
  const imported = [];
  const runner = createDownloadRunner({ workerId: "t", importFiles: async input => { imported.push(input); return ["asset-1"]; }, log() {} });
  try {
    queue("proxied", `${origin.url.replace("127.0.0.1", "localhost")}/clip.mp4`, { vpn: "socks", subfolder: "Clips" });
    runner.claim();
    await runner.idle();
    const row = job("proxied");
    assert.equal(row.status, "completed", row.error);
    assert.deepEqual(JSON.parse(row.files_json), [join(root, "Clips", "clip (1).mp4")]);
    assert.equal(readFileSync(join(root, "Clips", "clip (1).mp4"), "utf8"), "video-bytes");
    assert.equal(readFileSync(join(root, "Clips", "clip.mp4"), "utf8"), "existing");
    assert.deepEqual(JSON.parse(row.asset_ids_json), ["asset-1"]);
    assert.equal(socks.requests[0].host, "localhost");
    assert.equal(imported[0].root.id, "root");
    assert.ok(!readdirSync(join(root, "Clips")).some(name => name.startsWith(".kiwi-download-")));
    assert.match(row.log_text, /Routing through VPN profile/);
  } finally { await origin.close(); await socks.close(); }
});

test("folders marked read-only in Settings never receive downloads", async () => {
  db.prepare("UPDATE library_roots SET read_only=1 WHERE id='root'").run();
  const runner = createDownloadRunner({ workerId: "t", log() {} });
  try {
    queue("blocked", "http://127.0.0.1:9/never.bin");
    runner.claim();
    await runner.idle();
    assert.equal(job("blocked").status, "failed");
    assert.match(job("blocked").error, /marked read-only/);
  } finally { db.prepare("UPDATE library_roots SET read_only=0 WHERE id='root'").run(); }
});

test("VPN failures fail closed instead of using the server's own connection", async () => {
  const origin = await startHttp({ "/leak.bin": Buffer.from("x") });
  addProfile("dead", "proxy", { url: "socks5h://127.0.0.1:9" });
  const runner = createDownloadRunner({ workerId: "t", log() {} });
  try {
    queue("closed", `${origin.url}/leak.bin`, { vpn: "dead" });
    queue("deleted", `${origin.url}/leak.bin`, { vpn: "deleted-profile" });
    runner.claim();
    await runner.idle();
    assert.equal(job("closed").status, "failed");
    assert.equal(job("deleted").status, "failed");
    assert.match(job("deleted").error, /VPN profile was deleted/);
    assert.ok(!existsSync(join(root, "leak.bin")));
  } finally { await origin.close(); }
});

test("canceling a running download stops it and removes partial files", async () => {
  const origin = await startHttp({ "/slow.bin": (req, res) => { res.writeHead(200, { "content-length": 1e7 }); res.write(Buffer.alloc(1024)); } });
  const runner = createDownloadRunner({ workerId: "t", log() {} });
  try {
    queue("cancel-me", `${origin.url}/slow.bin`);
    runner.claim();
    await until(() => job("cancel-me").bytes_done > 0 || readdirSync(root).some(name => name.startsWith(".kiwi-download-")));
    db.prepare("UPDATE downloads SET status='canceling' WHERE id='cancel-me'").run();
    await runner.idle();
    assert.equal(job("cancel-me").status, "canceled");
    assert.ok(!readdirSync(root).some(name => name.startsWith(".kiwi-download-") || name === "slow.bin"));
  } finally { await origin.close(); }
});

test("WireGuard profiles start a private userspace SOCKS tunnel and share it across jobs", async () => {
  const fake = fileURLToPath(new URL("./fake-wireproxy.js", import.meta.url));
  chmodSync(fake, 0o755);
  const logFile = join(dataDir, "wireproxy.log");
  process.env.KIWI_WIREPROXY_PATH = fake; process.env.FAKE_WIREPROXY_LOG = logFile;
  const origin = await startHttp({ "/a.bin": Buffer.from("a"), "/b.bin": Buffer.from("b") });
  const tunnels = createTunnelManager({ idleMs: 50 });
  addProfile("wg", "wireguard", { config: "[Interface]\nPrivateKey = abc=\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = def=\nEndpoint = 1.2.3.4:51820" });
  const runner = createDownloadRunner({ workerId: "t", tunnels, log() {} });
  try {
    queue("wg-a", `${origin.url}/a.bin`, { vpn: "wg" });
    queue("wg-b", `${origin.url}/b.bin`, { vpn: "wg" });
    runner.claim();
    await runner.idle();
    assert.equal(job("wg-a").status, "completed", job("wg-a").error);
    assert.equal(job("wg-b").status, "completed", job("wg-b").error);
    const configs = readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(configs.length, 1, "one tunnel serves both jobs");
    assert.match(configs[0], /\[Socks5\]\nBindAddress = 127\.0\.0\.1:\d+\nUsername = \w+\nPassword = \w+/);
    assert.equal(readdirSync(join(dataDir, "downloads", "tunnels")).length, 0, "the private key is removed from disk once the tunnel is up");
  } finally { await tunnels.closeAll(); await origin.close(); delete process.env.KIWI_WIREPROXY_PATH; }
});

const ytDlp = resolve(fileURLToPath(new URL("../../../data/bin/yt-dlp", import.meta.url)));
test("yt-dlp downloads through the VPN proxy end to end", { skip: !existsSync(ytDlp) && "yt-dlp is not installed in data/bin" }, async () => {
  process.env.KIWI_YTDLP_PATH = ytDlp;
  const clip = join(dataDir, "source.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-c:v", "libx264", clip]);
  const origin = await startHttp({ "/watch/clip.mp4": readFileSync(clip) });
  const socks = await startSocks({ username: "u", password: "p" });
  addProfile("yt-socks", "proxy", { url: `socks5h://127.0.0.1:${socks.port}`, username: "u", password: "p" });
  const runner = createDownloadRunner({ workerId: "t", log() {} });
  try {
    queue("yt", `${origin.url.replace("127.0.0.1", "localhost")}/watch/clip.mp4`, { downloader: "downloader-yt-dlp", vpn: "yt-socks", subfolder: "yt" });
    runner.claim();
    await runner.idle();
    const row = job("yt");
    assert.equal(row.status, "completed", `${row.error}\n${row.log_text}`);
    assert.equal(row.title, "clip");
    assert.deepEqual(JSON.parse(row.files_json), [join(root, "yt", "clip [clip].mp4")]);
    assert.ok(socks.requests.some(request => request.host === "localhost"));
  } finally { await origin.close(); await socks.close(); }
});
