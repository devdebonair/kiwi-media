import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { dataDir } from "@kiwi/database";

const exec = promisify(execFile);
const envNames = { "yt-dlp": "KIWI_YTDLP_PATH", wireproxy: "KIWI_WIREPROXY_PATH" };

// Explicit env path, then a copy in <data>/bin, then PATH.
export function binaryPath(name) {
  const configured = process.env[envNames[name]];
  if (configured) return configured;
  const local = join(dataDir, "bin", name);
  return existsSync(local) ? local : name;
}

const versions = new Map();
// Cached for a minute so settings pages can show availability without spawning on every request.
export async function binaryVersion(name, path = binaryPath(name)) {
  const cached = versions.get(path);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value;
  try {
    const { stdout, stderr } = await exec(path, [name === "wireproxy" ? "-v" : "--version"], { timeout: 10_000 });
    value = { available: true, version: (stdout || stderr).trim().split("\n")[0] };
  } catch { value = { available: false, reason: `${name} was not found. Install it on the server or set ${envNames[name]}.` }; }
  versions.set(path, { at: Date.now(), value });
  return value;
}
