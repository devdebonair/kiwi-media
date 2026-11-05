import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const dir = await mkdtemp(join(tmpdir(), "kiwi-dates-test-"));
process.env.KIWI_DATA_DIR = join(dir, "data");
const { db } = await import("@kiwi/database");
const { recordedDate, scanRoot, enrichRoot, backfillRecordedDates } = await import("../src/library.js");
test.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

const ffmpeg = (path, ...args) => promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-c:v", "libx264", ...args, path]);
const modified = new Date("2019-03-04T05:06:07Z");
const asset = path => db.prepare("SELECT * FROM assets WHERE file_path=?").get(path);

test("a recording date comes from the file's own tags, else from when the file was last modified", () => {
  const info = { mtimeMs: modified.getTime() };
  assert.deepEqual(recordedDate({ format: { tags: { creation_time: "2012-07-01T10:00:00.000000Z" } } }, info), { at: "2012-07-01T10:00:00.000Z", source: "embedded" });
  // Apple's own tag wins (it carries the camera's time zone), and tag names are matched in any case.
  assert.equal(recordedDate({ format: { tags: { creation_time: "2012-07-01T10:00:00Z", "com.apple.quicktime.creationdate": "2012-06-30T22:00:00-0700" } } }, info).at, "2012-07-01T05:00:00.000Z");
  assert.equal(recordedDate({ streams: [{ tags: { CREATION_TIME: "2010-01-02T00:00:00Z" } }] }, info).at, "2010-01-02T00:00:00.000Z");
  // Containers write the QuickTime or Unix epoch when no date was set; those, nonsense, and future dates are ignored.
  for (const value of ["1904-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "not a date", "2999-01-01T00:00:00Z"])
    assert.deepEqual(recordedDate({ format: { tags: { creation_time: value } } }, info), { at: modified.toISOString(), source: "file" }, value);
  assert.equal(recordedDate(null, null), null);
});

test("new files get their recording date when they're enriched", async () => {
  const root = join(dir, "camera");
  await mkdir(root, { recursive: true });
  const tagged = join(root, "tagged.mp4"), plain = join(root, "plain.mp4");
  await ffmpeg(tagged, "-metadata", "creation_time=2014-08-09T10:11:12Z");
  await ffmpeg(plain);
  await utimes(plain, modified, modified);
  await scanRoot(root);
  assert.equal(asset(tagged).captured_at, null, "registration stays quick");
  await enrichRoot(root);
  assert.equal(asset(tagged).captured_at, "2014-08-09T10:11:12.000Z");
  assert.equal(JSON.parse(asset(tagged).metadata_json).capturedAtSource, "embedded");
  assert.equal(asset(plain).captured_at, modified.toISOString());
  assert.equal(JSON.parse(asset(plain).metadata_json).capturedAtSource, "file");
});

test("videos imported earlier are dated in the background, and an unreachable drive is left for later", async () => {
  const root = join(dir, "old");
  await mkdir(root, { recursive: true });
  const older = join(root, "older.mp4"), gone = join(root, "gone.mp4");
  await ffmpeg(older, "-metadata", "creation_time=2008-01-02T03:04:05Z");
  await writeFile(gone, "soon deleted");
  await scanRoot(root);
  // Already enriched before dates were read.
  db.prepare("UPDATE assets SET metadata_json=json_set(metadata_json,'$.libraryEnriched',1) WHERE file_path IN (?,?)").run(older, gone);
  await rm(gone);

  // Everything in the batch is missing: the drive may just be disconnected, so nothing is marked.
  const offline = join(dir, "offline");
  db.prepare("INSERT INTO assets (id,kind,title,file_path,added_at,updated_at) VALUES ('offline-1','video','Offline','/nowhere/a.mp4','2000-01-01','2000-01-01')").run();
  assert.deepEqual(await backfillRecordedDates({ batch: 1 }), { checked: 0, dated: 0, unreachable: 1 });
  assert.equal(JSON.parse(db.prepare("SELECT metadata_json FROM assets WHERE id='offline-1'").get().metadata_json).capturedAtSource, undefined);
  db.prepare("DELETE FROM assets WHERE id='offline-1'").run();

  // (The database's demo items are dated in the same pass.)
  const result = await backfillRecordedDates();
  assert.ok(result.checked >= 2 && result.dated === result.checked - 1, JSON.stringify(result));
  assert.equal(asset(older).captured_at, "2008-01-02T03:04:05.000Z");
  assert.equal(JSON.parse(asset(gone).metadata_json).capturedAtSource, "unknown", "a deleted file isn't tried again");
  assert.deepEqual(await backfillRecordedDates(), { checked: 0, dated: 0 }, "nothing left");
  // A date set some other way is never overwritten.
  assert.equal(asset(join(dir, "camera", "tagged.mp4")).captured_at, "2014-08-09T10:11:12.000Z");
});
