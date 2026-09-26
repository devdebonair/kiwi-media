import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { dataDir } from "@kiwi/database";
import { binaryPath, binaryVersion } from "./binaries.js";
import { ConfigError, describeFields, mergeConfig } from "./fields.js";
import { createHttp, DownloadError } from "./http.js";
import { piaWireguardConfig } from "./pia.js";

// VPN profiles never require a VPN client on the host. Proxy profiles use a provider's SOCKS5/HTTP
// endpoint; WireGuard profiles run a userspace tunnel (wireproxy) that exposes a private local SOCKS5 port.
export const vpnTypes = {
  proxy: {
    name: "SOCKS5 / HTTP proxy",
    description: "A VPN provider's proxy endpoint, or any SOCKS5, HTTP, or HTTPS proxy (for example a Gluetun container).",
    fields: [
      { key: "url", label: "Proxy address", type: "text", required: true, placeholder: "socks5://proxy-nl.privateinternetaccess.com:1080", help: "socks5://, http://, or https:// with host and port. Hostnames are resolved through the proxy." },
      { key: "username", label: "Username", type: "text" },
      { key: "password", label: "Password", type: "secret" },
    ],
    presets: [
      { id: "pia", label: "Private Internet Access (SOCKS5)", values: { url: "socks5://proxy-nl.privateinternetaccess.com:1080" }, help: "Generate SOCKS credentials (an “x” username) in PIA's Client Control Panel. The proxy is not encrypted; use PIA WireGuard for an encrypted tunnel." },
      { id: "nordvpn", label: "NordVPN (SOCKS5)", values: { url: "socks5://amsterdam.nl.socks.nordhold.net:1080" }, help: "Use your NordVPN service credentials from the Nord Account dashboard, not your login email." },
      { id: "gluetun", label: "Gluetun HTTP proxy", values: { url: "http://gluetun:8888" }, help: "Run Gluetun with HTTPPROXY=on for OpenVPN-only providers, then point this at its HTTP proxy." },
    ],
  },
  wireguard: {
    name: "WireGuard config",
    description: "Paste a WireGuard .conf from your provider (Mullvad, Proton VPN, IVPN, Surfshark, AirVPN, your own server…).",
    requires: "wireproxy",
    fields: [{ key: "config", label: "WireGuard configuration", type: "secret-textarea", required: true, placeholder: "[Interface]\nPrivateKey = …\nAddress = 10.2.0.2/32\nDNS = 10.2.0.1\n\n[Peer]\nPublicKey = …\nEndpoint = 203.0.113.5:51820\nAllowedIPs = 0.0.0.0/0" }],
  },
  "pia-wireguard": {
    name: "Private Internet Access (WireGuard)",
    description: "Signs in to PIA and registers a fresh WireGuard key each time the tunnel starts.",
    requires: "wireproxy",
    fields: [
      { key: "username", label: "PIA username", type: "text", required: true, placeholder: "p1234567" },
      { key: "password", label: "PIA password", type: "secret", required: true },
      { key: "region", label: "Region", type: "select", required: true, optionsUrl: "/api/v1/vpn/pia/regions" },
    ],
  },
};

export async function listVpnTypes() {
  const wireproxy = await binaryVersion("wireproxy");
  return Object.entries(vpnTypes).map(([id, type]) => ({ id, name: type.name, description: type.description, presets: type.presets || [],
    fields: describeFields(type.fields), available: !type.requires || wireproxy.available, unavailableReason: type.requires && !wireproxy.available ? wireproxy.reason : undefined }));
}

const wgKeys = { interface: ["address", "privatekey", "dns", "mtu", "listenport"], peer: ["publickey", "presharedkey", "endpoint", "allowedips", "persistentkeepalive"] };
// Keeps only the settings wireproxy understands; wg-quick hooks such as PostUp are dropped, never run.
export function parseWireguard(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[(\w+)\]$/);
    if (header) { current = { name: header[1].toLowerCase(), values: [] }; sections.push(current); continue; }
    const pair = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!pair || !current) throw new ConfigError(`Unrecognized WireGuard line: ${line.slice(0, 60)}`);
    if (wgKeys[current.name]?.includes(pair[1].toLowerCase())) current.values.push([pair[1], pair[2].trim()]);
  }
  const iface = sections.filter(section => section.name === "interface"), peers = sections.filter(section => section.name === "peer");
  const has = (section, key) => section.values.some(([name]) => name.toLowerCase() === key);
  if (iface.length !== 1 || !has(iface[0], "privatekey") || !has(iface[0], "address")) throw new ConfigError("The WireGuard config needs one [Interface] with PrivateKey and Address.");
  if (!peers.length || peers.some(peer => !has(peer, "publickey") || !has(peer, "endpoint"))) throw new ConfigError("Each WireGuard [Peer] needs PublicKey and Endpoint.");
  return [...iface, ...peers].map(section => [`[${section.name === "peer" ? "Peer" : "Interface"}]`, ...section.values.map(([key, value]) => `${key} = ${value}`)].join("\n")).join("\n\n");
}

export function normalizeProxy(value) {
  let url;
  try { url = new URL(value); } catch { throw new ConfigError("Enter a proxy address such as socks5://host:1080."); }
  if (!["socks5:", "socks5h:", "socks:", "http:", "https:"].includes(url.protocol)) throw new ConfigError("Proxy address must start with socks5://, http://, or https://.");
  if (!url.hostname || !url.port) throw new ConfigError("Proxy address needs a host and port.");
  if (url.pathname !== "/" && url.pathname !== "" || url.search) throw new ConfigError("Proxy address must not include a path.");
  return `${url.protocol.startsWith("socks") ? "socks5h:" : url.protocol}//${url.host}`;
}

export function validateVpnConfig(type, previous, input, clearSecrets) {
  const definition = vpnTypes[type];
  if (!definition) throw new ConfigError("Unknown VPN type.");
  const config = mergeConfig(definition.fields, previous, input, clearSecrets);
  if (type === "proxy") {
    let url;
    try { url = new URL(config.url.includes("://") ? config.url : `socks5://${config.url}`); }
    catch { throw new ConfigError("Enter a proxy address such as socks5://host:1080."); }
    // Credentials typed into the address move to the dedicated fields so they stay masked.
    if (url.username && !config.username) config.username = decodeURIComponent(url.username);
    if (url.password && !config.password) config.password = decodeURIComponent(url.password);
    url.username = ""; url.password = "";
    config.url = normalizeProxy(url.href);
  }
  if (type === "wireguard") config.config = parseWireguard(config.config);
  return config;
}

export function proxyUrlFor(config) {
  const url = new URL(config.url);
  if (config.username) { url.username = encodeURIComponent(config.username); url.password = encodeURIComponent(config.password || ""); }
  return url.href.replace(/\/$/, "");
}

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const portOpen = port => new Promise(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

// Shares one tunnel per profile across concurrent jobs and stops it after it has been idle.
export function createTunnelManager({ idleMs = 60_000, wireguardConfig = piaWireguardConfig, log = () => {} } = {}) {
  const tunnels = new Map();
  async function start(profile) {
    const config = profile.config;
    const wgText = profile.type === "pia-wireguard" ? await wireguardConfig(config) : config.config;
    const port = await freePort();
    const username = randomBytes(8).toString("hex"), password = randomBytes(16).toString("hex");
    const dir = join(dataDir, "downloads", "tunnels", randomBytes(8).toString("hex"));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "wireproxy.conf");
    await writeFile(file, `${parseWireguard(wgText)}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\nUsername = ${username}\nPassword = ${password}\n`, { mode: 0o600 });
    const child = spawn(binaryPath("wireproxy"), ["-c", file], { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const collect = chunk => { output.push(...String(chunk).split("\n").filter(Boolean)); output.splice(0, Math.max(0, output.length - 20)); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    let exited = false;
    child.once("exit", () => { exited = true; });
    const spawnError = new Promise((_, reject) => child.once("error", error => reject(new DownloadError(error.code === "ENOENT" ? "wireproxy is not installed on the server" : error.message))));
    try {
      await Promise.race([spawnError, (async () => {
        for (let waited = 0; waited < 15_000; waited += 150) {
          if (exited) throw new DownloadError(`WireGuard tunnel stopped: ${output.slice(-3).join(" ") || "wireproxy exited"}`);
          if (await portOpen(port)) return;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        throw new DownloadError("WireGuard tunnel did not start within 15 seconds");
      })()]);
    } catch (error) { child.kill(); throw error; }
    finally { await rm(dir, { recursive: true, force: true }); } // The private key is no longer needed on disk.
    log(`Started WireGuard tunnel for ${profile.name}`);
    return { child, proxyUrl: `socks5h://${username}:${password}@127.0.0.1:${port}` };
  }
  async function acquire(profile) {
    if (profile.type === "proxy") return { proxyUrl: proxyUrlFor(profile.config), release() {} };
    const key = `${profile.id}:${profile.updated_at}`;
    let entry = tunnels.get(key);
    if (!entry) {
      entry = { refs: 0, ready: start(profile) };
      tunnels.set(key, entry);
      entry.ready.then(({ child }) => child.once("exit", () => { if (tunnels.get(key) === entry) tunnels.delete(key); }), () => tunnels.delete(key));
    }
    entry.refs++;
    clearTimeout(entry.timer);
    let tunnel;
    try { tunnel = await entry.ready; } catch (error) { entry.refs--; throw error; }
    let released = false;
    return { proxyUrl: tunnel.proxyUrl, release() {
      if (released) return;
      released = true;
      if (--entry.refs === 0) entry.timer = setTimeout(() => { tunnels.delete(key); tunnel.child.kill(); }, idleMs);
    } };
  }
  async function closeAll() {
    for (const entry of tunnels.values()) { clearTimeout(entry.timer); entry.ready.then(({ child }) => child.kill(), () => {}); }
    tunnels.clear();
  }
  return { acquire, closeAll };
}

async function publicAddress(http) {
  try {
    const info = await http.json("https://ipinfo.io/json", { timeout: 15_000 });
    return { ip: info.ip, city: info.city, region: info.region, country: info.country, org: info.org };
  } catch {
    const info = await http.json("https://api.ipify.org?format=json", { timeout: 15_000 });
    return { ip: info.ip };
  }
}

// Reports the exit address seen through the profile next to the server's own address.
export async function testVpnProfile(profile, tunnels) {
  const tunnel = await tunnels.acquire(profile);
  const through = createHttp({ proxyUrl: tunnel.proxyUrl }), direct = createHttp();
  try {
    const [vpn, server] = await Promise.all([publicAddress(through), publicAddress(direct).catch(() => null)]);
    return { vpn, server, changed: !server || server.ip !== vpn.ip };
  } catch (error) {
    throw new DownloadError(`Could not connect through ${profile.name}: ${error.message}`);
  } finally { through.close(); direct.close(); tunnel.release(); }
}
