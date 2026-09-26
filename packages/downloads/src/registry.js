import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir } from "@kiwi/database";
import { binaryVersion } from "./binaries.js";
import { ConfigError, describeFields, mergeConfig } from "./fields.js";
import direct from "./plugins/direct.js";
import { realDebrid, torBox } from "./plugins/debrid.js";
import httpApi from "./plugins/http-api.js";
import ytDlp from "./plugins/yt-dlp.js";

export const builtInPlugins = [ytDlp, direct, realDebrid, torBox, httpApi];
export const pluginsDir = () => process.env.KIWI_DOWNLOADER_PLUGINS_DIR || join(dataDir, "plugins", "downloaders");

const fieldTypes = new Set(["text", "url", "secret", "textarea", "secret-textarea", "select", "boolean", "number"]);
export function checkPlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw new Error("The module must default-export a plugin object.");
  if (typeof plugin.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(plugin.id)) throw new Error("id must be 2–41 lowercase letters, digits, or dashes.");
  if (typeof plugin.name !== "string" || !plugin.name.trim()) throw new Error("name is required.");
  if (typeof plugin.download !== "function") throw new Error("download(ctx) must be a function.");
  for (const name of ["accepts", "search", "validate", "searchable"]) if (plugin[name] !== undefined && typeof plugin[name] !== "function") throw new Error(`${name} must be a function.`);
  if (plugin.fields !== undefined && !Array.isArray(plugin.fields)) throw new Error("fields must be an array.");
  for (const field of plugin.fields || []) {
    if (typeof field?.key !== "string" || !/^\w{1,40}$/.test(field.key) || typeof field.label !== "string") throw new Error("Every field needs a key and label.");
    if (field.type && !fieldTypes.has(field.type)) throw new Error(`Field ${field.key} has unknown type ${field.type}.`);
  }
  return plugin;
}

let cache = { key: null, plugins: builtInPlugins, errors: [] };
// Rescans the plugin folder when files change, so new plugins appear without restarting.
// User plugins are trusted code: they run inside Kiwi with the same access as the server.
export async function loadPlugins() {
  const dir = pluginsDir();
  let entries = [];
  try { entries = (await readdir(dir)).filter(name => /\.(m?js)$/.test(name)).sort(); } catch {}
  const files = await Promise.all(entries.map(async name => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
  const key = JSON.stringify(files);
  if (key === cache.key) return cache;
  const plugins = [...builtInPlugins], errors = [];
  for (const { name, mtime } of files) {
    try {
      const module = await import(`${pathToFileURL(join(dir, name)).href}?v=${mtime}`);
      const plugin = checkPlugin(module.default);
      if (plugins.some(existing => existing.id === plugin.id)) throw new Error(`A plugin with id “${plugin.id}” already exists.`);
      plugins.push({ ...plugin, file: name });
    } catch (error) { errors.push({ file: name, error: error.message }); }
  }
  cache = { key, plugins, errors };
  return cache;
}

export async function getPlugin(id) {
  const plugin = (await loadPlugins()).plugins.find(item => item.id === id);
  if (!plugin) throw new ConfigError(`Downloader plugin “${id}” is not installed.`, 404);
  return plugin;
}

export async function describePlugins() {
  const { plugins, errors } = await loadPlugins();
  const described = await Promise.all(plugins.map(async plugin => {
    const requirement = plugin.requires ? await binaryVersion(plugin.requires) : { available: true };
    return { id: plugin.id, name: plugin.name, description: plugin.description || "", fields: describeFields(plugin.fields), cookies: Boolean(plugin.cookies),
      search: typeof plugin.search === "function", builtIn: !plugin.file, file: plugin.file, available: requirement.available, unavailableReason: requirement.reason, version: requirement.version };
  }));
  return { plugins: described, errors, directory: pluginsDir() };
}

export function validatePluginConfig(plugin, previous, input, clearSecrets) {
  const config = mergeConfig(plugin.fields, previous, input, clearSecrets);
  try { plugin.validate?.(config); } catch (error) { throw new ConfigError(error.message); }
  return config;
}

export const pluginAccepts = (plugin, source) => {
  try { return plugin.accepts ? Boolean(plugin.accepts(source)) : /^https?:\/\//i.test(source); } catch { return false; }
};
export const pluginSearchable = (plugin, config) => typeof plugin.search === "function" && (plugin.searchable ? Boolean(plugin.searchable(config)) : true);
