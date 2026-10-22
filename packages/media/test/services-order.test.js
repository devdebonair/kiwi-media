import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KIWI_DATA_DIR = mkdtempSync(join(tmpdir(), "kiwi-order-"));
const { orderAudio } = await import("../src/services.js");

const track = (position, language, extra = {}) => ({ position, language, codec: "aac", channels: 2, default: false, title: null, ...extra });

test("tracks are listed in language order without losing which one the browser plays by default", () => {
  const listed = orderAudio([track(0, "hin"), track(1, "jpn"), track(2, "eng")]);
  assert.deepEqual(listed.map(item => item.language), ["eng", "jpn", "hin"]);
  assert.deepEqual(listed.filter(item => item.default).map(item => item.language), ["hin"], "with no flag, the first track in the file is the default");
});

test("a flagged default track stays the default", () => {
  const listed = orderAudio([track(0, "hin"), track(1, "jpn", { default: true }), track(2, "eng")]);
  assert.deepEqual(listed.filter(item => item.default).map(item => item.language), ["jpn"]);
});

test("labels use language names, mention unusual layouts, and skip repeated titles", () => {
  const [english, other] = orderAudio([track(0, "eng", { title: "English", channels: 6 }), track(1, "fra", { title: "Version Française" })]);
  assert.equal(english.label, "English · 5.1");
  assert.equal(other.label, "French · Version Française");
});

test("when several tracks are flagged default, only the first in the file is reported as the default", () => {
  const listed = orderAudio([track(0, "hin", { default: true }), track(1, "jpn", { default: true }), track(2, "eng", { default: true })]);
  assert.deepEqual(listed.filter(item => item.default).map(item => item.language), ["hin"]);
});
