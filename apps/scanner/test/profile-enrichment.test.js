import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyProfiles, exactCandidates, makePlan, normalizeName, resolveProfiles, safeURL, titleMatches } from "../src/profile-enrichment.js";

const entry = { name: "Jane Example", variants: ["Jane Example"], title_count: 1, sources: [{ id: "video", title: "Jane Example - interview" }] };
const performer = { id: "p1", name: "Jane Example", aliases: ["Jane_Example"], urls: [{ url: "https://example.com/people/jane" }], images: [], provider: "stashdb" };
const cache = p => ({ count: p.length, performers: p });

test("matches bounded names, handles and filename separators, not substrings", () => {
  for (const title of ["Jane Example's interview", "20260101_Jane.Example-interview", "@Jane_Example"]) assert.equal(titleMatches(title, "Jane Example"), true);
  for (const title of ["MaryJane Example", "Jane Examples", "Jane Example123"]) assert.equal(titleMatches(title, "Jane Example"), false);
  assert.equal(normalizeName("@Jane_Example"), normalizeName("Jane Example"));
  assert.equal(safeURL("javascript:alert(1)"), null);
  assert.equal(safeURL("https://secret@example.com"), null);
});

test("rejects fuzzy, deleted, ambiguous and truncated provider results", () => {
  assert.equal(exactCandidates(entry, [{ ...performer, name: "Jane Else", aliases: [] }]).length, 0);
  assert.equal(exactCandidates(entry, [{ ...performer, deleted: true }]).length, 0);
  const ambiguous = resolveProfiles([entry], { stashdb: { [entry.name]: cache([performer, { ...performer, id: "p2" }]) } });
  assert.equal(ambiguous.groups.length, 0);
  assert.match(ambiguous.review[0].reason, /multiple exact/);
  const truncated = resolveProfiles([entry], { stashdb: { [entry.name]: { ...cache([performer]), count: 101 } } });
  assert.equal(truncated.groups.length, 0);
});

test("merges aliases through provider IDs; cross-provider matches need shared identity URLs", () => {
  const alias = { ...entry, name: "Jane_Example" };
  const merged = resolveProfiles([entry, alias], { stashdb: { [entry.name]: cache([performer]), [alias.name]: cache([performer]) } });
  assert.equal(merged.groups.length, 1);
  assert.equal(merged.groups[0].entries.length, 2);
  const conflicting = resolveProfiles([entry], { stashdb: { [entry.name]: cache([performer]) }, tpdb: { [entry.name]: cache([{ ...performer, id: "other", urls: [{ url: "https://example.com/people/someone-else" }] }]) } });
  assert.equal(conflicting.groups.length, 0);
  assert.match(conflicting.review[0].reason, /shared identity/);
  const bare = resolveProfiles([entry], { stashdb: { [entry.name]: cache([performer]) }, tpdb: { [entry.name]: cache([{ ...performer, id: "bare", urls: [] }]) } });
  assert.equal(bare.groups.length, 1);
  assert.equal(bare.groups[0].providers.length, 1);
  assert.equal(bare.groups[0].providers[0].provider, "stashdb");
});

test("planning only associates current videos whose titles still match", () => {
  const groups = [{ name: entry.name, providers: [performer], entries: [{ ...entry, sources: [...entry.sources, { id: "image" }, { id: "changed" }, { id: "deleted" }] }] }];
  const assets = new Map([
    ["video", { id: "video", kind: "video", title: entry.sources[0].title }],
    ["image", { id: "image", kind: "image", title: entry.sources[0].title }],
    ["changed", { id: "changed", kind: "video", title: "Different person" }],
  ]);
  assert.deepEqual(makePlan(groups, {}, assets)[0].assets.map(a => a.id), ["video"]);
});

test("reviewed disambiguation is limited to the evidenced title context", () => {
  const contextual = { ...entry, sources: [{ id: "match", title: "Jane Example - Example Studio" }, { id: "other", title: "Jane Example - unknown studio" }] };
  const results = { stashdb: { [entry.name]: cache([performer, { ...performer, id: "someone-else" }]) } };
  const resolved = resolveProfiles([contextual], results, { [entry.name]: { provider: "stashdb", id: performer.id, evidenceURL: "https://example.com/people/jane", titlePattern: "Example Studio" } });
  assert.equal(resolved.groups.length, 1);
  assert.deepEqual(resolved.groups[0].entries[0].sources.map(s => s.id), ["match"]);
  assert.equal(resolved.review[0].titleCount, 1);
});

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE topics(id TEXT PRIMARY KEY,slug TEXT UNIQUE,name TEXT,summary TEXT,body_markdown TEXT,avatar_url TEXT,topic_type TEXT,created_at TEXT,updated_at TEXT,metadata_json TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,title TEXT,kind TEXT,description TEXT);
    CREATE TABLE topic_aliases(id TEXT PRIMARY KEY,topic_id TEXT REFERENCES topics(id),alias TEXT,normalized_alias TEXT,UNIQUE(topic_id,normalized_alias));
    CREATE TABLE annotations(id TEXT PRIMARY KEY,asset_id TEXT REFERENCES assets(id),motivation TEXT,note_markdown TEXT,confidence REAL,origin TEXT,visibility TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE annotation_topics(annotation_id TEXT REFERENCES annotations(id),topic_id TEXT REFERENCES topics(id),role TEXT,PRIMARY KEY(annotation_id,topic_id,role));
    CREATE VIRTUAL TABLE search_index USING fts5(entity_id UNINDEXED,entity_type UNINDEXED,title,body,tags);
    INSERT INTO assets VALUES('video','Jane Example - interview','video','');`);
  return db;
}
const profile = { key: "stashdb:p1", name: entry.name, aliases: [entry.name], summary: "Public biography", links: [], sources: [{ provider: "stashdb", id: "p1", url: "https://example.com/jane" }], assets: [{ id: "video", title: entry.sources[0].title, matchedName: entry.name }], portrait: { url: "/generated/profiles/jane.jpg" } };

test("apply is idempotent, rebuilds search, and repeatedly preserves manual changes", () => {
  const db = database();
  try {
    const first = applyProfiles(db, [profile], { runId: "first" });
    assert.equal(first.createdTopics, 1);
    assert.equal(first.createdAssociations, 1);
    db.prepare("UPDATE topics SET summary=? WHERE id=?").run("My own biography", first.topicIds[0]);
    for (const runId of ["second", "third"]) {
      const next = applyProfiles(db, [{ ...profile, summary: "New remote biography" }], { runId });
      assert.equal(next.createdTopics, 0);
      assert.equal(next.createdAssociations, 0);
      assert.equal(db.prepare("SELECT summary FROM topics").get().summary, "My own biography");
    }
    assert.equal(db.prepare("SELECT count(*) n FROM search_index WHERE search_index MATCH 'Jane'").get().n, 2);
    assert.equal(db.prepare("SELECT role FROM annotation_topics").get().role, "mentioned");
  } finally { db.close(); }
});

test("apply rejects identity collisions atomically and skips changed titles", () => {
  const db = database();
  try {
    db.exec("UPDATE assets SET title='Changed'");
    const result = applyProfiles(db, [profile], { runId: "first" });
    assert.equal(result.createdAssociations, 0);
    assert.equal(result.skippedAssociations, 1);
    const conflict = { ...profile, sources: [{ provider: "stashdb", id: "different" }] };
    assert.throws(() => applyProfiles(db, [conflict], { runId: "second" }), /identity review/);
    assert.equal(db.prepare("SELECT count(*) n FROM topics").get().n, 1);
  } finally { db.close(); }
});
