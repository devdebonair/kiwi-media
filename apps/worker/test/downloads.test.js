import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("finished downloads join the library with their source and title; scans skip in-progress staging folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiwi-download-import-"));
  process.env.KIWI_DATA_DIR = join(dir, "data");
  const { db } = await import("@kiwi/database");
  try {
    const { importDownloadedFiles, scanRoot } = await import("../src/library.js");
    const root = join(dir, "media");
    await mkdir(join(root, ".kiwi-download-job"), { recursive: true });
    await writeFile(join(root, ".kiwi-download-job", "partial.mp4"), "partial");
    const video = join(root, "Clip [abc].mp4");
    await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=64x64:d=1", "-c:v", "libx264", video]);
    await writeFile(join(root, "notes.nfo"), "info");
    db.prepare("INSERT INTO library_roots (id,name,absolute_path,read_only,created_at) VALUES ('r','media',?,1,?)").run(root, new Date().toISOString());

    const ids = await importDownloadedFiles({ root: { id: "r", absolute_path: root }, files: [video, join(root, "notes.nfo")], source: "https://www.example.com/watch?v=abc", title: "A Real Title" });
    assert.equal(ids.length, 1);
    const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(ids[0]);
    assert.deepEqual([asset.title, asset.source_url, asset.description, asset.duration_ms], ["A Real Title", "https://www.example.com/watch?v=abc", "Downloaded from example.com", 1000]);
    assert.equal(db.prepare("SELECT site_name FROM asset_sources WHERE asset_id=?").get(asset.id).site_name, "example.com");
    assert.equal(db.prepare("SELECT library_root_id FROM files WHERE asset_id=?").get(asset.id).library_root_id, "r");
    assert.ok(db.prepare("SELECT 1 FROM search_index WHERE entity_id=? AND title='A Real Title'").get(asset.id));
    db.prepare("INSERT INTO topics (id,slug,name,created_at,updated_at) VALUES ('t1','t1','Queued',?,?)").run(new Date().toISOString(), new Date().toISOString());
    assert.deepEqual(await importDownloadedFiles({ root: { id: "r", absolute_path: root }, files: [video], source: "magnet:?xt=1", topicIds: ["t1", "deleted-topic"] }), ids, "already imported files keep their asset");
    assert.ok(db.prepare("SELECT 1 FROM annotations a JOIN annotation_topics at ON at.annotation_id=a.id WHERE a.asset_id=? AND at.topic_id='t1'").get(ids[0]), "queued tags are applied; deleted ones are skipped");
    assert.equal(db.prepare("SELECT count(*) n FROM assets WHERE file_path=?").get(video).n, 1);
    assert.deepEqual(await scanRoot(root), { total: 1, imported: 0 });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
