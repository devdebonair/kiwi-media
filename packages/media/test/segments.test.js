import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "kiwi-segments-"));
process.env.KIWI_DATA_DIR = directory;
const { chapterSegments, tidySegments, findSegments, createIntroDb } = await import("../src/segments.js");
const { saveProvider } = await import("../src/settings.js");
const { db } = await import("@kiwi/database");
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

const minute = 60_000;

test("named chapters become skippable parts; numbered ones say nothing", () => {
  // Shaman King: Opening, Part A, Part B, Ending, Preview. Mushoku Tensei names its parts in Japanese.
  const chapters = [["Opening", 0, 91], ["Part A", 91, 727], ["Part B", 727, 1286], ["Ending", 1286, 1356], ["Preview", 1356, 1386]]
    .map(([title, start, end]) => ({ title, startMs: start * 1000, endMs: end * 1000 }));
  assert.deepEqual(chapterSegments(chapters).map(segment => [segment.type, segment.startMs / 1000, segment.endMs / 1000]), [["intro", 0, 91], ["credits", 1286, 1356], ["preview", 1356, 1386]]);
  assert.deepEqual(chapterSegments([{ title: "エンディング", startMs: 1326e3, endMs: 1416e3 }, { title: "次回予告", startMs: 1416e3, endMs: 1446e3 }, { title: "アバン", startMs: 0, endMs: 154e3 }]).map(segment => segment.type), ["credits", "preview"]);
  assert.deepEqual(chapterSegments(["Chapter 01", "02", "Opera", "Introduction", "Edit"].map((title, index) => ({ title, startMs: index * minute, endMs: (index + 1) * minute }))), []);
  // The last chapter may have no end of its own: it runs to the end of the file.
  assert.equal(chapterSegments([{ title: "Credits", startMs: 20 * minute, endMs: null }], 22 * minute)[0].endMs, 22 * minute);
});

test("segments are cleaned against the file's length", () => {
  const tidy = tidySegments([
    { type: "credits", startMs: 20 * minute, endMs: null }, { type: "recap", startMs: 0, endMs: 0 }, { type: "intro", startMs: 30_000, endMs: 120_000 },
    { type: "intro", startMs: 10 * minute, endMs: 11 * minute }, { type: "preview", startMs: 25 * minute, endMs: 26 * minute },
  ], 22 * minute);
  assert.deepEqual(tidy.map(segment => [segment.type, segment.startMs, segment.endMs]), [["intro", 30_000, 120_000], ["credits", 20 * minute, 22 * minute]],
    "empty, out-of-range, and second intros are dropped; open credits run to the end");
});

test("files without named chapters ask TheIntroDB, matched to their length; chapters win when they have them", async () => {
  const requests = [];
  const introDb = createIntroDb({ fetchImpl: async target => {
    const url = new URL(target);
    requests.push(Object.fromEntries(url.searchParams));
    if (url.searchParams.get("tmdb_id") === "999") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ intro: [{ start_ms: 0, end_ms: 59_000 }], recap: [{ start_ms: 0, end_ms: 0 }], credits: [{ start_ms: 1_391_000, end_ms: null }], preview: [] }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const title = { tmdb_id: 246, type: "show" }, asset = { season_number: 1, episode_number: 2, duration_ms: 1_450_000 };
  const found = await findSegments({ title, asset, info: { durationMs: 1_452_300, chapters: [] }, introDb });
  assert.deepEqual(found.map(segment => [segment.type, segment.startMs, segment.endMs, segment.source]), [["intro", 0, 59_000, "theintrodb"], ["credits", 1_391_000, 1_452_300, "theintrodb"]]);
  assert.deepEqual(requests[0], { tmdb_id: "246", season: "1", episode: "2", duration_ms: "1452000" });

  const chaptered = await findSegments({ title, asset, info: { durationMs: 1_452_300, chapters: [{ title: "OP", startMs: 29_000, endMs: 89_000 }] }, introDb });
  assert.deepEqual(chaptered.map(segment => segment.source), ["chapters"]);
  assert.equal(requests.length, 1, "no lookup when the file's chapters already mark the intro");

  // Not in the database: remembered, so the next play doesn't ask again.
  assert.deepEqual(await findSegments({ title: { tmdb_id: 999, type: "movie" }, asset: {}, info: { durationMs: 6e6, chapters: [] }, introDb }), []);
  await findSegments({ title: { tmdb_id: 999, type: "movie" }, asset: {}, info: { durationMs: 6e6, chapters: [] }, introDb });
  assert.equal(requests.length, 2);

  // Switched off in Settings: chapters only.
  saveProvider("theintrodb", { enabled: false });
  assert.deepEqual(await findSegments({ title, asset: { ...asset, episode_number: 3 }, info: { durationMs: 1_452_300, chapters: [] }, introDb }), []);
  assert.equal(requests.length, 2);
});
