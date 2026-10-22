import test from "node:test";
import assert from "node:assert/strict";
import { activeCues, cueLines, parseVtt } from "../src/subtitle-cues.mjs";
import { createTimelineMedia, planSeek } from "../src/timeline-media.mjs";

const vtt = `WEBVTT

NOTE a comment

1
00:00:01.000 --> 00:00:03.500 align:center
Hello <i>there</i>

00:03.600 --> 00:05.000
{\\an8}Top line\\NSecond &amp; third

00:00:04.000 --> 00:00:06.000
Overlapping
`;

test("parses WebVTT with short timestamps, settings, notes, and overlapping cues", () => {
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map(cue => [cue.start, cue.end]), [[1, 3.5], [3.6, 5], [4, 6]]);
});

test("finds the cues showing at a moment, including overlaps", () => {
  const cues = parseVtt(vtt);
  assert.deepEqual(activeCues(cues, 0.5), []);
  assert.deepEqual(activeCues(cues, 2).map(cue => cue.text), ["Hello <i>there</i>"]);
  assert.equal(activeCues(cues, 4.5).length, 2);
  assert.deepEqual(activeCues(cues, 6.5), []);
});

test("cue text keeps only safe styling, decodes entities, and drops override tags", () => {
  assert.deepEqual(cueLines("Hello <i>there</i> <b>you</b>")[0].map(run => [run.text, run.italic, run.bold]), [["Hello ", false, false], ["there", true, false], [" ", false, false], ["you", false, true]]);
  const lines = cueLines("{\\an8}Top line\\NSecond &amp; third");
  assert.equal(lines.length, 2);
  assert.equal(lines[1][0].text, "Second & third");
  assert.deepEqual(cueLines("<script>alert(1)</script>x").flat().map(run => run.text).join(""), "alert(1)x");
  assert.deepEqual(cueLines("<c.yellow>a</c><00:00:01.000>b").flat().map(run => run.text), ["a", "b"]);
});

test("a wrapped video reports whole-movie time and routes seeks through the player", () => {
  const calls = [];
  const element = { currentTime: 4, duration: Infinity, paused: false, play() { calls.push("play"); return this; } };
  const media = createTimelineMedia(element, { position: () => 100 + element.currentTime, duration: () => 600, seek: time => calls.push(["seek", time]) });
  assert.equal(media.currentTime, 104);
  assert.equal(media.duration, 600);
  media.currentTime = 300;
  assert.deepEqual(calls, [["seek", 300]]);
  assert.equal(element.currentTime, 4, "the element itself is untouched");
  media.play();
  assert.equal(calls.at(-1), "play");
  assert.equal(media.paused, false);
});

test("seeking inside received data is local; beyond it restarts the stream at the target", () => {
  assert.deepEqual(planSeek({ target: 105, offset: 100, bufferedEnd: 20 }), { type: "local", time: 5 });
  assert.deepEqual(planSeek({ target: 90, offset: 100, bufferedEnd: 20 }), { type: "restart", offset: 90 });
  assert.deepEqual(planSeek({ target: 500, offset: 100, bufferedEnd: 20 }), { type: "restart", offset: 500 });
  assert.deepEqual(planSeek({ target: 100, offset: 100, bufferedEnd: 0 }), { type: "local", time: 0 });
});
