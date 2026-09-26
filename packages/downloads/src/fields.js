// Shared settings schema for downloader plugins and VPN profile types.
// Field types: text, url, secret, textarea, secret-textarea, select, boolean, number.
export class ConfigError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = "ConfigError"; this.statusCode = statusCode; }
}

const secretTypes = new Set(["secret", "secret-textarea"]);
export const isSecret = field => secretTypes.has(field.type);

// Public field descriptors carry no stored values, so they are safe to send to the browser.
export const describeFields = fields => (fields || []).map(({ key, label, type = "text", required = false, placeholder, help, options, optionsUrl, default: value }) =>
  ({ key, label, type, required, placeholder, help, options, optionsUrl, default: value }));

// Secrets never leave the server; the browser only learns whether each one is set.
export function maskConfig(fields, config = {}) {
  const values = {}, secrets = {};
  for (const field of fields || []) {
    if (isSecret(field)) secrets[field.key] = Boolean(config[field.key]);
    else if (config[field.key] !== undefined) values[field.key] = config[field.key];
  }
  return { values, secrets };
}

// Validates submitted values against the schema. Omitted or empty secrets keep their previous value;
// `clearSecrets` lists secrets the user explicitly removed.
export function mergeConfig(fields, previous = {}, input = {}, clearSecrets = []) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ConfigError("Settings must be an object.");
  const config = {};
  for (const field of fields || []) {
    const raw = input[field.key];
    let value;
    if (isSecret(field)) {
      if (typeof raw === "string" && raw !== "") value = raw;
      else if (!clearSecrets.includes(field.key)) value = previous[field.key];
    } else value = raw === undefined ? previous[field.key] ?? field.default : raw;
    value = coerce(field, value);
    if (value === undefined || value === "") {
      if (field.required) throw new ConfigError(`${field.label} is required.`);
      continue;
    }
    config[field.key] = value;
  }
  return config;
}

function coerce(field, value) {
  if (value === undefined || value === null) return undefined;
  const { type = "text", label } = field;
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new ConfigError(`${label} must be on or off.`);
    return value;
  }
  if (type === "number") {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (value === "") return undefined;
    if (typeof number !== "number" || !Number.isFinite(number)) throw new ConfigError(`${label} must be a number.`);
    return number;
  }
  if (typeof value !== "string") throw new ConfigError(`${label} must be text.`);
  const text = type.endsWith("textarea") ? value.replace(/\r\n/g, "\n") : value.trim();
  if (text.length > 64 * 1024) throw new ConfigError(`${label} is too long.`);
  if (type === "url" && text && !/^https?:\/\/[^\s]+$/i.test(text)) throw new ConfigError(`${label} must be an http(s) URL.`);
  if (type === "select" && text && field.options && !field.options.some(option => option.value === text)) throw new ConfigError(`${label} has an invalid choice.`);
  return text;
}
