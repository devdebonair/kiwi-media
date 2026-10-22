import test from "node:test";
import assert from "node:assert/strict";
import { applyPreference, loadPreference, savePreference } from "../src/track-preferences.mjs";

const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const info = {
  audio: [{ position: 0, language: "jpn" }, { position: 1, language: "eng" }],
  subtitles: [{ id: "s1", language: "eng", forced: true, status: "pending" }, { id: "s2", language: "eng", forced: false, status: "pending" }, { id: "s3", language: "jpn", forced: false, status: "unsupported" }],
  chosen: { audioPosition: 1, subtitleId: "s1" },
};

test("saved choices merge and are returned per series", () => {
  const storage = memory();
  savePreference("title:a", { audio: "jpn" }, storage);
  savePreference("title:a", { subtitle: "eng" }, storage);
  assert.deepEqual({ ...loadPreference("title:a", storage), at: 0 }, { audio: "jpn", subtitle: "eng", at: 0 });
  assert.equal(loadPreference("title:b", storage), null);
});

test("without a saved choice the server defaults win", () => {
  assert.deepEqual(applyPreference(info, null), { audioPosition: 1, subtitleId: "s1" });
});

test("a saved language picks the matching track, preferring full subtitles over forced ones", () => {
  assert.deepEqual(applyPreference(info, { audio: "jpn", subtitle: "eng" }), { audioPosition: 0, subtitleId: "s2" });
});

test("subtitles can be remembered as off, and unsupported tracks are never picked", () => {
  assert.equal(applyPreference(info, { subtitle: "off" }).subtitleId, null);
  assert.equal(applyPreference(info, { subtitle: "jpn" }).subtitleId, "s1", "falls back to the default when nothing usable matches");
  assert.equal(applyPreference(info, { audio: "kor" }).audioPosition, 1, "a language this file lacks falls back to the default");
});
