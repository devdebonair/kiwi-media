import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "kiwi-asset-order-"));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import("../src/index.js");
const { db } = await import("@kiwi/database");
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

test("video order and seeded shuffle stay consistent across pages", async () => {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO topics(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)").run("topic", "sample", "Sample", now, now);
  for (let index = 0; index < 75; index++) {
    const id = `video-${String(index).padStart(3, "0")}`;
    const added = new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString();
    db.prepare("INSERT INTO assets(id,kind,title,added_at,updated_at) VALUES(?,?,?,?,?)").run(id, "video", id, added, now);
    db.prepare("INSERT INTO annotations(id,asset_id,created_at,updated_at) VALUES(?,?,?,?)").run(`annotation-${index}`, id, now, now);
    db.prepare("INSERT INTO annotation_topics VALUES(?,?,?)").run(`annotation-${index}`, "topic", "mentioned");
  }
  db.prepare("INSERT INTO assets(id,kind,title,added_at,updated_at) VALUES(?,?,?,?,?)").run("audio", "audio", "Audio", now, now);
  const get = async query => (await app.inject(`/api/v1/assets?${query}`)).json();
  const ordered = await get("kind=video&topic=sample&limit=60");
  assert.equal(ordered[0].id, "video-074");
  assert.equal(ordered.length, 60);
  const shuffled = await get("kind=video&topic=sample&sort=shuffle&seed=27&limit=60");
  const rest = await get("kind=video&topic=sample&sort=shuffle&seed=27&limit=60&offset=60");
  assert.equal(new Set([...shuffled, ...rest].map(asset => asset.id)).size, 75);
  assert.notDeepEqual(shuffled.map(asset => asset.id), ordered.map(asset => asset.id));
  assert.notDeepEqual(shuffled.map(asset => asset.id), (await get("kind=video&topic=sample&sort=shuffle&seed=456&limit=60")).map(asset => asset.id));
});
