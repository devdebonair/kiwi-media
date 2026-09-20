import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("fast import registers playable paths without tags or hashing; enrichment is separate and rescans are idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiwi-library-test-"));
  process.env.KIWI_DATA_DIR = join(dir, "data");
  const { db } = await import("@kiwi/database");
  try {
    const { scanRoot, enrichRoot, enqueue } = await import("../src/library.js");
    const root = join(dir, "media");
    await mkdir(join(root, "nested"), { recursive: true });
    const video = join(root, "Example [source-id].mp4");
    await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-c:v", "libx264", video]);
    await writeFile(join(root, "nested", "unreadable-video.flv"), "invalid video");
    const original = await readFile(video);
    assert.deepEqual(await scanRoot(root), { total: 2, imported: 2 });
    let asset = db.prepare("SELECT * FROM assets WHERE file_path=?").get(video);
    assert.equal(asset.title, "Example [source-id]");
    assert.equal(asset.duration_ms, null);
    assert.equal(asset.visibility, "private");
    assert.equal(db.prepare("SELECT count(*) n FROM annotations WHERE asset_id=?").get(asset.id).n, 0);
    assert.equal(db.prepare("SELECT checksum_sha256 FROM files WHERE asset_id=?").get(asset.id).checksum_sha256, null);
    assert.deepEqual(await scanRoot(root), { total: 2, imported: 0 });
    enqueue("enrich-root", root);enqueue("enrich-root", root);
    assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE type='enrich-root'").get().n, 1);
    assert.deepEqual(await enrichRoot(root), { total: 2, failed: 1 });
    asset = db.prepare("SELECT * FROM assets WHERE id=?").get(asset.id);
    assert.equal(asset.duration_ms, 1000);
    assert.equal(JSON.parse(asset.metadata_json).videoCodec, "h264");
    assert.ok(asset.thumbnail_url);
    assert.deepEqual(await readFile(video), original);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
