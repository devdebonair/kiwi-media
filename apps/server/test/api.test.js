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
