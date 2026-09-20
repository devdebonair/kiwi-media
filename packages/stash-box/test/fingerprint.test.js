import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, utimes, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeOshash, fingerprintFile } from "../src/index.js";

const exec = promisify(execFile);
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "kiwi-fingerprint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("OSHASH matches Stash's published vectors, including short and overlapping files", async t => {
  const dir = await temporary(t);
  // Expected values from stash/pkg/hash/oshash/oshash_test.go, v0.31.1.
  const vectors = [
    [Buffer.from("this is a test".repeat(2 ** 15)), "6a0eba04654d0b9b"],
    [Buffer.from("hello world"), "d3e392dee38cd4df"],
    [Buffer.concat([Buffer.alloc(131072 - 12), Buffer.from("this is dumb")]), "d5d6ddd820756920"],
    [Buffer.concat([Buffer.alloc(131072 - 12), Buffer.from("dumb is this")]), "d5d6ddd820756920"],
    [Buffer.alloc(65537, 255), "000000000000c001"],
  ];
  for (const [data, expected] of vectors) {
    const path = join(dir, "video");
    await writeFile(path, data);
    assert.equal(await computeOshash(path), expected);
  }
});

test("OSHASH rejects missing and too-small files", async t => {
  const dir = await temporary(t);
  await assert.rejects(computeOshash(join(dir, "missing")), /ENOENT/);
  for (const length of [0, 5, 8]) {
    const path = join(dir, "tiny");
    await writeFile(path, Buffer.alloc(length));
    await assert.rejects(computeOshash(path), /larger than 8/);
  }
});

test("real FFprobe, cache reuse, and same-path file replacement", async t => {
  const dir = await temporary(t);
  const path = join(dir, "video with spaces.mp4");
  const cacheDir = join(dir, "cache");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-c:v", "mpeg4", path]);
  const first = await fingerprintFile(path, { cacheDir });
  assert.equal(first.durationSeconds, 1);
  assert.equal(first.fingerprints[0].algorithm, "OSHASH");
  const [cacheName] = await readdir(cacheDir);
  const cachePath = join(cacheDir, cacheName);
  const cachedText = await readFile(cachePath, "utf8");
  await utimes(cachePath, 1, 1);
  assert.deepEqual(await fingerprintFile(path, { cacheDir }), first);
  // A cache hit doesn't rewrite its entry.
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(cachePath)).mtimeMs, 1000);
  assert.equal(await readFile(cachePath, "utf8"), cachedText);
  await exec("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=2", "-c:v", "mpeg4", path]);
  const second = await fingerprintFile(path, { cacheDir });
  assert.equal(second.durationSeconds, 2);
  assert.notEqual(second.signature, first.signature);
  assert.notEqual(second.fingerprints[0].hash, first.fingerprints[0].hash);
});

test("PHASH uses the executable without shell interpretation and pads its output", async t => {
  const dir = await temporary(t);
  const path = join(dir, "video $(touch nope).mp4");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=64x64:d=1", "-c:v", "mpeg4", path]);
  const phasherPath = join(dir, "fake-phasher");
  await writeFile(phasherPath, `#!${process.execPath}\nimport assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ['-q', '--', ${JSON.stringify(path)}]);\nconsole.log('a1');\n`, { mode: 0o755 });
  const result = await fingerprintFile(path, { phash: true, phasherPath });
  assert.deepEqual(result.fingerprints[1], { algorithm: "PHASH", hash: "00000000000000a1" });
  await writeFile(phasherPath, `#!${process.execPath}\nconsole.log('not a hash');\n`, { mode: 0o755 });
  await assert.rejects(fingerprintFile(path, { phash: true, phasherPath }), /invalid 64-bit/);
  await assert.rejects(fingerprintFile(path, { ffprobePath: join(dir, "missing") }), /Executable not found/);
});
