import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KIWI_DATA_DIR = mkdtempSync(join(tmpdir(), "kiwi-path-"));
const { libraryPath } = await import("../src/download-plugin.js");

test("shows are filed like media servers expect: Show (Year)/Season NN/Show - SxxEyy - Title", () => {
  const path = libraryPath({ season_number: 1, episode_number: 2, title: "It Didn't Have to Be Magic..." }, { type: "show", title: "Frieren: Beyond Journey's End", year: 2023 }, ".mkv");
  assert.deepEqual(path.dir, ["Frieren - Beyond Journey's End (2023)", "Season 01"]);
  assert.equal(path.filename, "Frieren - Beyond Journey's End - S01E02 - It Didn't Have to Be Magic.mkv");
});

test("movies get their own folder, specials go in Specials, and unsafe characters are removed", () => {
  assert.deepEqual(libraryPath({}, { type: "movie", title: "What If...?", year: 2021 }, ".mp4"), { dir: ["What If... (2021)"], filename: "What If... (2021).mp4" });
  assert.deepEqual(libraryPath({ season_number: 0, episode_number: 3, title: "A/B" }, { type: "show", title: "Show", year: null }, ".mkv").dir, ["Show", "Specials"]);
});
