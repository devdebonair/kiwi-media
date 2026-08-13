import test from "node:test";
import assert from "node:assert/strict";
import { db } from "@kiwi/database";

test("seed contains browseable assets and topics", () => {
  assert.ok(db.prepare("SELECT count(*) count FROM assets").get().count >= 10);
  assert.ok(db.prepare("SELECT count(*) count FROM topics").get().count >= 5);
});

test("FTS index finds New York media", () => {
  const rows = db.prepare("SELECT entity_id FROM search_index WHERE search_index MATCH ?").all('"new"* AND "york"*');
  assert.ok(rows.length > 0);
});

test("anime fixtures include playable video and music metadata", () => {
  const fixtures = db.prepare("SELECT kind,file_path,source_url,metadata_json FROM assets WHERE id LIKE 'asset-anime-%'").all();
  assert.equal(fixtures.filter(asset => asset.kind === "video").length, 3);
  assert.equal(fixtures.filter(asset => asset.kind === "audio").length, 3);
  for (const fixture of fixtures) {
    assert.ok(fixture.file_path);
    assert.match(fixture.source_url, /^https:\/\/commons\.wikimedia\.org\//);
    assert.ok(JSON.parse(fixture.metadata_json).license);
  }
});
