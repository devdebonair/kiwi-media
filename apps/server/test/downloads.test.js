import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "kiwi-downloads-api-"));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import("../src/index.js");
const { db } = await import("@kiwi/database");
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
const call = async (method, url, payload) => { const response = await app.inject({ method, url, payload }); return { status: response.statusCode, body: response.body ? response.json() : null }; };

test("downloaders and VPN profiles never expose secrets, and in-use profiles cannot be deleted", async () => {
  const plugins = (await call("GET", "/api/v1/downloads/plugins")).body.plugins.map(plugin => plugin.id);
  assert.deepEqual(plugins, ["yt-dlp", "direct", "real-debrid", "torbox", "http-api"]);
  assert.equal((await call("GET", "/api/v1/downloaders")).body[0].is_default, true, "yt-dlp is ready by default");

  const vpn = await call("POST", "/api/v1/vpn/profiles", { name: "PIA NL", type: "proxy", config: { url: "socks5://proxy-nl.privateinternetaccess.com:1080", username: "x1", password: "hunter2" } });
  assert.equal(vpn.status, 201);
  assert.deepEqual(vpn.body.secrets, { password: true });
  assert.ok(!JSON.stringify(vpn.body).includes("hunter2"));
  assert.equal((await call("POST", "/api/v1/vpn/profiles", { name: "Bad", type: "wireguard", config: { config: "nonsense" } })).status, 400);

  const rd = await call("POST", "/api/v1/downloaders", { plugin: "real-debrid", name: "RD", config: { apiToken: "tok-123" }, vpnProfileId: vpn.body.id });
  assert.equal(rd.status, 201);
  assert.ok(!JSON.stringify((await call("GET", "/api/v1/downloaders")).body).includes("tok-123"));
  const renamed = await call("PATCH", `/api/v1/downloaders/${rd.body.id}`, { name: "Real-Debrid", config: { apiToken: "" } });
  assert.equal(renamed.body.secrets.apiToken, true, "blank secrets keep the saved value");
  assert.equal(db.prepare("SELECT json_extract(config_json,'$.apiToken') token FROM downloaders WHERE id=?").get(rd.body.id).token, "tok-123");
  assert.equal((await call("POST", "/api/v1/downloaders", { plugin: "real-debrid", config: {} })).status, 400);
  assert.equal((await call("POST", "/api/v1/downloaders", { plugin: "nope" })).status, 404);

  assert.equal((await call("POST", "/api/v1/vpn/rules", { domain: "https://www.YouTube.com/watch?v=1", vpnProfileId: vpn.body.id })).body[0].domain, "youtube.com");
  const blocked = await call("DELETE", `/api/v1/vpn/profiles/${vpn.body.id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Real-Debrid.*youtube\.com/);
  await call("DELETE", "/api/v1/vpn/rules/youtube.com");
  await call("PATCH", `/api/v1/downloaders/${rd.body.id}`, { vpnProfileId: null });
  assert.equal((await call("DELETE", `/api/v1/vpn/profiles/${vpn.body.id}`)).status, 204);
});

test("cookies.txt uploads are validated and stored privately", async () => {
  const id = "downloader-yt-dlp";
  assert.equal((await call("PUT", `/api/v1/downloaders/${id}/cookies`, { content: "hello" })).status, 400);
  const saved = await call("PUT", `/api/v1/downloaders/${id}/cookies`, { content: ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tcookie-value-xyz\n" });
  assert.equal(saved.body.hasCookies, true);
  assert.ok(!JSON.stringify(saved.body).includes("cookie-value-xyz"));
  const path = join(directory, "downloads", "cookies", `${id}.txt`);
  assert.ok(existsSync(path));
  assert.equal((await call("DELETE", `/api/v1/downloaders/${id}/cookies`)).body.hasCookies, false);
  assert.ok(!existsSync(path));
});

test("downloads target writable library folders and can be planned, canceled, retried, and removed", async () => {
  const library = join(directory, "library"), readOnly = join(directory, "read-only");
  mkdirSync(library); mkdirSync(readOnly);
  const root = (await call("POST", "/api/v1/library/roots", { path: library })).body;
  const locked = (await call("POST", "/api/v1/library/roots", { path: readOnly })).body;
  chmodSync(readOnly, 0o555);
  const destinations = (await call("GET", "/api/v1/downloads/destinations")).body;
  assert.equal(destinations.find(item => item.id === root.id).writable, true);
  if (process.getuid?.() !== 0) {
    assert.equal(destinations.find(item => item.id === locked.id).writable, false);
    assert.equal((await call("POST", "/api/v1/downloads", { sources: ["https://example.com/v"], libraryRootId: locked.id })).status, 400);
  }

  assert.equal(root.read_only, 0, "new folders accept downloads");
  assert.equal((await call("PATCH", `/api/v1/library/roots/${root.id}`, { readOnly: true })).body.read_only, 1);
  const flagged = (await call("GET", "/api/v1/downloads/destinations")).body.find(item => item.id === root.id);
  assert.deepEqual([flagged.writable, flagged.read_only], [false, 1]);
  assert.match((await call("POST", "/api/v1/downloads", { sources: ["https://example.com/v"], libraryRootId: root.id })).body.error, /marked read-only/);
  assert.equal((await call("PATCH", `/api/v1/library/roots/${root.id}`, { readOnly: "no" })).status, 400);
  const restored = (await call("PATCH", `/api/v1/library/roots/${root.id}`, { readOnly: false })).body;
  assert.deepEqual([restored.read_only, restored.enabled], [0, 1], "the toggle leaves scanning alone");
  const vpn = (await call("POST", "/api/v1/vpn/profiles", { name: "Proxy", type: "proxy", config: { url: "http://127.0.0.1:8888" } })).body;
  await call("POST", "/api/v1/vpn/rules", { domain: "example.com", vpnProfileId: vpn.id });
  const plan = (await call("GET", "/api/v1/downloads/plan?source=https%3A%2F%2Fm.example.com%2Fv")).body;
  assert.deepEqual([plan.downloader.plugin, plan.vpn.name, plan.vpn.reason], ["yt-dlp", "Proxy", "Domain rule for example.com"]);

  assert.equal((await call("POST", "/api/v1/downloads", { sources: ["https://example.com/v"], libraryRootId: root.id, subfolder: "../../etc" })).status, 400);
  assert.match((await call("POST", "/api/v1/downloads", { sources: ["magnet:?xt=urn:btih:1"], libraryRootId: root.id, downloaderId: "downloader-yt-dlp" })).body.error, /cannot download/);
  assert.equal((await call("GET", "/api/v1/downloads/plan?source=magnet%3A%3Fxt%3Durn%3Abtih%3A1")).body.downloader.plugin, "real-debrid", "magnets go to a downloader that accepts them");
  const created = await call("POST", "/api/v1/downloads", { sources: ["https://example.com/a", " ", "https://other.org/b"], libraryRootId: root.id, subfolder: "Web", vpn: "auto" });
  assert.equal(created.status, 202);
  assert.deepEqual(created.body.map(item => [item.vpn_name, item.subfolder, item.status]), [["Proxy", "Web", "queued"], [null, "Web", "queued"]]);

  const [first] = created.body;
  assert.equal((await call("DELETE", `/api/v1/downloads/${first.id}`)).status, 409);
  assert.equal((await call("DELETE", `/api/v1/vpn/profiles/${vpn.id}`)).status, 409);
  assert.equal((await call("POST", `/api/v1/downloads/${first.id}/cancel`)).body.status, "canceled");
  await call("DELETE", "/api/v1/vpn/rules/example.com");
  const retried = (await call("POST", `/api/v1/downloads/${first.id}/retry`)).body;
  assert.deepEqual([retried.status, retried.vpn_profile_id], ["queued", null], "automatic VPN choices follow current rules on retry");
  await call("POST", `/api/v1/downloads/${first.id}/cancel`);
  assert.equal((await call("DELETE", `/api/v1/downloads/${first.id}`)).status, 204);
  assert.equal((await call("GET", "/api/v1/downloads")).body.length, 1);
  chmodSync(readOnly, 0o755);
});
