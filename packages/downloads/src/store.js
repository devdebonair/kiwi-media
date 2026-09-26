import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataDir, db } from "@kiwi/database";
import { ConfigError, maskConfig } from "./fields.js";
import { getPlugin, loadPlugins, pluginAccepts, pluginSearchable } from "./registry.js";
import { vpnTypes } from "./vpn.js";

const parse = value => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
export const cookiesPath = id => join(dataDir, "downloads", "cookies", `${id}.txt`);

export function getVpnProfile(id) {
  const row = id && db.prepare("SELECT * FROM vpn_profiles WHERE id=?").get(id);
  return row ? { ...row, config: parse(row.config_json) } : null;
}

export function publicVpnProfile(row) {
  const profile = row.config ? row : getVpnProfile(row.id);
  const { values, secrets } = maskConfig(vpnTypes[profile.type]?.fields, profile.config);
  return { id: profile.id, name: profile.name, type: profile.type, config: values, secrets, created_at: profile.created_at, updated_at: profile.updated_at,
    downloaders: db.prepare("SELECT id,name FROM downloaders WHERE vpn_profile_id=? ORDER BY name").all(profile.id),
    domains: db.prepare("SELECT domain FROM vpn_domain_rules WHERE vpn_profile_id=? ORDER BY domain").all(profile.id).map(rule => rule.domain) };
}

export function getDownloader(id) {
  const row = id && db.prepare("SELECT * FROM downloaders WHERE id=?").get(id);
  return row ? { ...row, config: parse(row.config_json) } : null;
}

export async function publicDownloader(row) {
  const downloader = row.config ? row : getDownloader(row.id);
  const plugin = (await loadPlugins()).plugins.find(item => item.id === downloader.plugin);
  const { values, secrets } = maskConfig(plugin?.fields, downloader.config);
  return { id: downloader.id, name: downloader.name, plugin: downloader.plugin, pluginName: plugin?.name || downloader.plugin, installed: Boolean(plugin),
    config: values, secrets, enabled: Boolean(downloader.enabled), is_default: Boolean(downloader.is_default), vpn_profile_id: downloader.vpn_profile_id,
    cookies: Boolean(plugin?.cookies), hasCookies: existsSync(cookiesPath(downloader.id)), searchable: Boolean(plugin && pluginSearchable(plugin, downloader.config)),
    created_at: downloader.created_at, updated_at: downloader.updated_at };
}

// Accepts a bare domain, a wildcard, or a pasted URL; www. is dropped so a rule covers the whole site.
export function normalizeDomain(input) {
  if (typeof input !== "string") throw new ConfigError("Enter a domain such as youtube.com.");
  let value = input.trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(value)) value = new URL(value).hostname; } catch {}
  value = value.replace(/^\*\./, "").replace(/^www\./, "").replace(/[:\/].*$/, "").replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)) throw new ConfigError("Enter a domain such as youtube.com.");
  return value;
}

export function sourceHost(source) {
  try { const url = new URL(source); return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase().replace(/\.$/, "") : null; } catch { return null; }
}

// The most specific rule wins: a rule for music.youtube.com beats one for youtube.com.
export function domainRuleFor(source) {
  const host = sourceHost(source);
  if (!host) return null;
  return db.prepare("SELECT * FROM vpn_domain_rules").all()
    .filter(rule => host === rule.domain || host.endsWith(`.${rule.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0] || null;
}

export async function chooseDownloader(source, downloaderId) {
  if (downloaderId) {
    const downloader = getDownloader(downloaderId);
    if (!downloader) throw new ConfigError("That downloader no longer exists.", 404);
    if (!downloader.enabled) throw new ConfigError(`${downloader.name} is turned off.`);
    const plugin = await getPlugin(downloader.plugin);
    if (!pluginAccepts(plugin, source)) throw new ConfigError(`${downloader.name} cannot download “${source.slice(0, 80)}”.`);
    return { downloader, plugin };
  }
  const { plugins } = await loadPlugins();
  const candidates = db.prepare("SELECT * FROM downloaders WHERE enabled=1 ORDER BY is_default DESC, created_at, id").all();
  for (const row of candidates) {
    const plugin = plugins.find(item => item.id === row.plugin);
    if (plugin && pluginAccepts(plugin, source)) return { downloader: { ...row, config: parse(row.config_json) }, plugin };
  }
  throw new ConfigError(/^magnet:/i.test(source) ? "Add a Real-Debrid or TorBox downloader in Settings to download magnets." : "No enabled downloader can handle this link.");
}

// VPN precedence: explicit choice, then the most specific domain rule, then the downloader's default.
export function chooseVpn(source, downloader, vpn = "auto") {
  if (vpn === "none") return { vpnMode: "none", profile: null, reason: "Turned off for this download" };
  if (vpn && vpn !== "auto") {
    const profile = getVpnProfile(vpn);
    if (!profile) throw new ConfigError("That VPN profile no longer exists.", 404);
    return { vpnMode: "profile", profile, reason: "Chosen for this download" };
  }
  const rule = domainRuleFor(source);
  if (rule) return { vpnMode: "auto", profile: getVpnProfile(rule.vpn_profile_id), reason: `Domain rule for ${rule.domain}` };
  if (downloader.vpn_profile_id) return { vpnMode: "auto", profile: getVpnProfile(downloader.vpn_profile_id), reason: `Default for ${downloader.name}` };
  return { vpnMode: "auto", profile: null, reason: "No VPN rule matches" };
}

export async function planDownload({ source, downloaderId, vpn }) {
  const { downloader, plugin } = await chooseDownloader(source, downloaderId);
  const choice = chooseVpn(source, downloader, vpn);
  return { downloader, plugin, ...choice };
}

// Downloads may only land inside a connected library folder.
export function destinationFor(libraryRootId, subfolder = "") {
  const root = db.prepare("SELECT * FROM library_roots WHERE id=?").get(libraryRootId);
  if (!root) throw new ConfigError("Choose a media library folder.", 404);
  if (typeof subfolder !== "string" || subfolder.length > 500 || subfolder.includes("\0")) throw new ConfigError("Subfolder is invalid.");
  const cleaned = subfolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (cleaned.split("/").some(part => part === ".." || part === "." || part.startsWith(".kiwi-download-")) || isAbsolute(cleaned)) throw new ConfigError("Subfolder must stay inside the library folder.");
  const path = resolve(root.absolute_path, cleaned);
  const inside = relative(root.absolute_path, path);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new ConfigError("Subfolder must stay inside the library folder.");
  return { root, subfolder: cleaned.split(sep).join("/"), path };
}

// Why downloads can't go into a folder: the Settings toggle first, then the filesystem itself.
export function downloadBlocker(root) {
  if (root.read_only) return `${root.name} is marked read-only in Settings → Media libraries.`;
  if (!rootWritable(root.absolute_path)) return `Kiwi cannot write to ${root.absolute_path}. Make the folder writable (and not a read-only mount) to download into it.`;
  return null;
}

export function rootWritable(path) {
  try { if (!statSync(path).isDirectory()) return false; accessSync(path, constants.W_OK); return true; } catch { return false; }
}

export const serializeDownload = row => {
  const root = db.prepare("SELECT name,absolute_path FROM library_roots WHERE id=?").get(row.library_root_id);
  const downloader = db.prepare("SELECT name FROM downloaders WHERE id=?").get(row.downloader_id);
  const vpn = row.vpn_profile_id ? db.prepare("SELECT name FROM vpn_profiles WHERE id=?").get(row.vpn_profile_id) : null;
  const { files_json, asset_ids_json, log_text, locked_by, ...rest } = row;
  return { ...rest, files: JSON.parse(files_json), asset_ids: JSON.parse(asset_ids_json), log: log_text, root_name: root?.name || "Removed folder",
    downloader_name: downloader?.name || row.plugin, vpn_name: vpn?.name || (row.vpn_profile_id ? "Deleted profile" : null) };
};
