import { open, stat, readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";

const execFileAsync = promisify(execFile);
const CHUNK_SIZE = 64 * 1024;

// Stash's OpenSubtitles hash: file size + little-endian uint64 sums of both ends.
// Short files deliberately have overlapping chunks, just like Stash.
export async function computeOshash(path) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 8 || !Number.isSafeInteger(info.size)) {
      throw new Error("OSHASH requires a regular file larger than 8 bytes with a safe integer size");
    }
    const length = Math.min(CHUNK_SIZE, Math.floor(info.size / 8) * 8);
    let sum = BigInt(info.size);
    const buffer = Buffer.alloc(length);
    for (const position of [0, info.size - length]) {
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) throw new Error("File changed or ended while computing OSHASH");
        offset += bytesRead;
      }
      for (let i = 0; i < length; i += 8) sum += buffer.readBigUInt64LE(i);
    }
    return BigInt.asUintN(64, sum).toString(16).padStart(16, "0");
  } finally {
    await file.close();
  }
}

async function run(executable, args, timeout) {
  try {
    return (await execFileAsync(executable, args, {
      timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    })).stdout;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Executable not found: ${executable}. See apps/scanner/README.md for setup.`);
    if (error.killed) throw new Error(`${executable} exceeded its timeout or output limit`);
    throw new Error(`${executable} failed (exit ${error.code ?? "unknown"})`);
  }
}

function identity(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
}

export async function fingerprintFile(input, {
  phash = false, phasherPath = "phasher", ffprobePath = "ffprobe",
  timeoutMs = 120_000, cacheDir,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  const path = resolve(input);
  const before = await stat(path, { bigint: true });
  if (!before.isFile()) throw new Error(`Not a regular file: ${path}`);
  const signature = identity(before);
  const cacheKey = createHash("sha256").update(JSON.stringify({
    version: 1, path, signature, phash, phasherPath, ffprobePath,
  })).digest("hex");
  const cachePath = cacheDir ? join(resolve(cacheDir), `${cacheKey}.json`) : null;
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      const algorithms = phash ? ["OSHASH", "PHASH"] : ["OSHASH"];
      if (cached.path === path && cached.signature === signature &&
          Number.isFinite(cached.durationSeconds) && cached.durationSeconds > 0 &&
          cached.fingerprints?.length === algorithms.length &&
          algorithms.every((algorithm, i) => cached.fingerprints[i]?.algorithm === algorithm && /^[a-f0-9]{16}$/.test(cached.fingerprints[i]?.hash))) {
        return cached;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  const probe = JSON.parse(await run(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path,
  ], timeoutMs));
  const durationSeconds = Number(probe.format?.duration);
  if (!probe.streams?.some(stream => stream.codec_type === "video") || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Expected a video with a finite, positive duration");
  }
  const fingerprints = [{ algorithm: "OSHASH", hash: await computeOshash(path) }];
  if (phash) {
    // Use the upstream implementation, not a generic image/video hash with a different algorithm.
    const output = (await run(phasherPath, ["-q", "--", path], timeoutMs)).trim();
    if (!/^[a-fA-F0-9]{1,16}$/.test(output)) throw new Error("phasher returned an invalid 64-bit hexadecimal hash");
    fingerprints.push({ algorithm: "PHASH", hash: output.toLowerCase().padStart(16, "0") });
  }
  if (identity(await stat(path, { bigint: true })) !== signature) {
    throw new Error("File changed during fingerprinting; retry when the download has finished");
  }
  const result = { path, signature, sizeBytes: Number(before.size), durationSeconds, fingerprints };
  if (cachePath) {
    await mkdir(resolve(cacheDir), { recursive: true });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
      await rename(temporary, cachePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return result;
}
