import test from "node:test";
import assert from "node:assert/strict";
import { planPlayback, remuxUrl } from "../src/playback-plan.mjs";

const info = (extra = {}) => ({ audio: [{ position: 0, codec: "aac", default: true }, { position: 1, codec: "aac", default: false }], video: { codec: "h264" }, playback: { mode: "direct" }, ...extra });

test("the file's default audio in a browser-friendly codec plays untouched", () => {
  assert.equal(planPlayback(info()).remux, false);
  assert.equal(planPlayback(info(), { audioPosition: 0 }).remux, false);
});

test("choosing another audio track, or one the browser cannot decode, repackages the file", () => {
  assert.equal(planPlayback(info(), { audioPosition: 1 }).remux, true);
  assert.equal(planPlayback(info({ audio: [{ position: 0, codec: "ac3", default: true }] })).remux, true);
});

test("video the browser cannot decode is re-encoded, and a failed attempt forces it", () => {
  assert.deepEqual(planPlayback(info({ playback: { mode: "remux", video: "transcode" } })).video, "transcode");
  assert.equal(planPlayback(info(), { transcode: true }).remux, true);
  assert.equal(planPlayback(info(), { transcode: true }).video, "transcode");
});

test("files without audio or session data are never repackaged", () => {
  assert.equal(planPlayback(null).remux, false);
  assert.equal(planPlayback({ audio: [] }).remux, false);
});

test("repackaged URLs carry the audio track, video mode, and start offset", () => {
  const plan = planPlayback({ ...info(), video: { codec: "hevc" } }, { audioPosition: 1 });
  assert.equal(remuxUrl("/f", plan, 62.9), "/f?remux=1&audio=1&video=copy&codec=hevc&start=62");
  assert.equal(remuxUrl("/f", planPlayback(info(), { audioPosition: 1, transcode: true }), -5), "/f?remux=1&audio=1&video=transcode&start=0");
});

test("the default is the first flagged track in file order, even when the list is sorted by language", () => {
  const sorted = { audio: [{ position: 2, codec: "aac", default: true }, { position: 0, codec: "aac", default: true }, { position: 1, codec: "aac", default: true }], playback: { mode: "direct" } };
  assert.equal(planPlayback(sorted).defaultAudio, 0);
  assert.equal(planPlayback(sorted, { audioPosition: 2 }).remux, true, "picking the English track needs repackaging when it is not first in the file");
  assert.equal(planPlayback(sorted, { audioPosition: 0 }).remux, false);
});
