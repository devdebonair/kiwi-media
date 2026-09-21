import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "kiwi-topics-"));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import("../src/index.js");
const { db } = await import("@kiwi/database");
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

test("profile totals include videos beyond the first page, without counting duplicate annotations", async () => {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO topics(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)").run("profile", "example-profile", "Example", now, now);
  for (let i = 0; i < 65; i++) {
    db.prepare("INSERT INTO assets(id,kind,title,added_at,updated_at) VALUES(?,?,?,?,?)").run(`v${i}`, "video", `Video ${i}`, now, now);
    db.prepare("INSERT INTO annotations(id,asset_id,created_at,updated_at) VALUES(?,?,?,?)").run(`an${i}`, `v${i}`, now, now);
    db.prepare("INSERT INTO annotation_topics VALUES(?,?,?)").run(`an${i}`, "profile", "mentioned");
  }
  db.prepare("INSERT INTO annotations(id,asset_id,created_at,updated_at) VALUES(?,?,?,?)").run("duplicate", "v0", now, now);
  db.prepare("INSERT INTO annotation_topics VALUES(?,?,?)").run("duplicate", "profile", "subject");
  const profile = (await app.inject("/api/v1/topics/example-profile")).json();
  assert.equal(profile.item_count, 65);
  assert.equal(profile.assets.length, 60);
  const next = (await app.inject("/api/v1/assets?topic=profile&limit=60&offset=60")).json();
  assert.equal(next.length, 5);
  assert.equal(new Set([...profile.assets, ...next].map(a => a.id)).size, 65);
});
