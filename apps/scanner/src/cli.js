#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readdir, stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintFile, identifyFile, identifyFileWithProviders } from "@kiwi/stash-box";
import { configuredProviders } from "./providers.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const videoExtensions = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".wmv", ".m4v", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".flv"]);
const help = `Usage: kiwi-metadata <fingerprint|lookup> [options] <file-or-directory>...

Commands write one JSON object per file to stdout (JSONL).
  fingerprint   Generate local fingerprints; no network requests.
  lookup        Fingerprint and retrieve all stash-box candidates.

Options:
  --phash             Also run Stash's standalone phasher (slower, perceptual).
  --recursive         Recurse into directories; directory inputs select videos.
  --endpoint URL      GraphQL URL (or STASH_BOX_ENDPOINT).
  --provider NAME     stashdb, tpdb, or all (default: all configured providers).
  --phasher PATH      Executable (or KIWI_PHASHER_PATH; defaults to data/bin/phasher or PATH).
  --ffprobe PATH      Executable (or KIWI_FFPROBE_PATH; defaults to ffprobe).
  --cache-dir PATH    Fingerprint cache (default: Kiwi data/fingerprints).
  --no-cache          Disable fingerprint caching.
  --help              Show this help.

Set STASH_BOX_API_KEY and/or TPDB_API_KEY for lookup. Keys are never CLI arguments.
Unmatched/ambiguous results are successful queries; any processing error exits 1.
Use -- before filenames beginning with a dash.
`;

async function* filesAt(path, recursive) {
  const info = await stat(path);
  if (info.isFile()) { yield path; return; }
  if (!info.isDirectory()) throw new Error(`Not a file or directory: ${path}`);
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory() && recursive) yield* filesAt(child, true);
    else if (entry.isFile() && videoExtensions.has(extname(entry.name).toLowerCase())) yield child;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      phash: { type: "boolean" }, recursive: { type: "boolean" }, endpoint: { type: "string" }, provider: { type: "string" },
      phasher: { type: "string" }, ffprobe: { type: "string" }, "cache-dir": { type: "string" },
      "no-cache": { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { process.stdout.write(help); return; }
  const [command, ...paths] = positionals;
  if (!["fingerprint", "lookup"].includes(command) || paths.length === 0) throw new Error(help);
  const dataDir = resolve(process.env.KIWI_DATA_DIR || resolve(repoRoot, "data"));
  let phasherPath = values.phasher || process.env.KIWI_PHASHER_PATH;
  if (!phasherPath) {
    const built = resolve(dataDir, "bin", process.platform === "win32" ? "phasher.exe" : "phasher");
    try { await access(built, constants.X_OK); phasherPath = built; } catch { phasherPath = "phasher"; }
  }
  const options = {
    phash: values.phash ?? false, phasherPath,
    ffprobePath: values.ffprobe || process.env.KIWI_FFPROBE_PATH || "ffprobe",
    cacheDir: values["no-cache"] ? undefined : values["cache-dir"] || resolve(dataDir, "fingerprints"),
  };
  const providers = command === "lookup" ? configuredProviders(values) : [];
  const seen = new Set();
  let count = 0;
  function reportError(path, error) {
    process.stdout.write(`${JSON.stringify({ path, status: "error", error: error.message })}\n`);
    process.exitCode = 1;
  }
  for (const input of paths) {
    const root = resolve(input);
    try {
      for await (const path of filesAt(root, values.recursive)) {
        if (seen.has(path)) continue;
        seen.add(path);
        count++;
        try {
          const result = providers.length > 1 ? await identifyFileWithProviders(path, { ...options, providers })
            : providers.length === 1 ? await identifyFile(path, { ...options, client: providers[0].client })
            : await fingerprintFile(path, options);
          if (result.status === "partial_error") process.exitCode = 1;
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) { reportError(path, error); }
      }
    } catch (error) { reportError(root, error); }
  }
  if (!count && !process.exitCode) throw new Error("No video files found in the supplied directories");
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
