import test from "node:test";
import assert from "node:assert/strict";
import { detectEnvironment, planPlayback, remuxUrl } from "../src/playback-plan.mjs";

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

const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", vendor: "Apple Computer, Inc.", platform: "iPhone", maxTouchPoints: 5 };
const chrome = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", vendor: "Google Inc.", platform: "Linux x86_64", maxTouchPoints: 0 };
const firefox = { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", vendor: "", platform: "Linux x86_64", maxTouchPoints: 0 };
const desktopSafari = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", vendor: "Apple Computer, Inc.", platform: "MacIntel", maxTouchPoints: 0 };

test("browsers are told apart: every iOS browser is Apple, Chrome is Chromium, Firefox is neither", () => {
  assert.deepEqual(detectEnvironment(iphone), { apple: true, chromium: false });
  assert.deepEqual(detectEnvironment(chrome), { apple: false, chromium: true });
  assert.deepEqual(detectEnvironment(firefox), { apple: false, chromium: false });
  assert.deepEqual(detectEnvironment(desktopSafari), { apple: true, chromium: false });
});

test("Matroska plays directly only in Chromium; everything else gets a repackaged stream, as HLS on Apple", () => {
  const mkv = info({ container: "matroska,webm" });
  assert.equal(planPlayback(mkv, { env: detectEnvironment(chrome) }).remux, false);
  const phone = planPlayback(mkv, { env: detectEnvironment(iphone) });
  assert.equal(phone.remux, true);
  assert.equal(phone.hls, true);
  assert.equal(planPlayback(mkv, { env: detectEnvironment(firefox) }).remux, true);
  assert.equal(planPlayback(mkv, { env: detectEnvironment(firefox) }).hls, false);
  assert.equal(planPlayback(info({ container: "mov,mp4,m4a,3gp,3g2,mj2" }), { env: detectEnvironment(iphone) }).remux, false, "MP4 plays everywhere");
  assert.match(remuxUrl("/f", phone, 12), /&hls=1&start=12$/);
});
