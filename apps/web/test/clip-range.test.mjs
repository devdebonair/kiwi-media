import test from "node:test";
import assert from "node:assert/strict";
import { clipLength, clipTime, laneClips, moveEdge, newRange, timeAt } from "../src/clip-range.mjs";

test("times read like an editor's: minutes, seconds, and tenths", () => {
  assert.equal(clipTime(61_250), "1:01.3");
  assert.equal(clipTime(3_725_000), "1:02:05.0");
  assert.equal(clipTime(5_000, { tenths: false }), "0:05");
  assert.equal(clipLength(14_960), "15.0s");
  assert.equal(clipLength(95_000), "1:35");
});

test("a new clip starts at the playhead, or ends there when marking the out point first", () => {
  assert.deepEqual(newRange(30_000, 600_000), { startMs: 30_000, endMs: 45_000 });
  assert.deepEqual(newRange(595_000, 600_000), { startMs: 595_000, endMs: 600_000 }, "stops at the end of the video");
  assert.deepEqual(newRange(40_000, 600_000, { endingHere: true }), { startMs: 25_000, endMs: 40_000 });
  assert.deepEqual(newRange(4_000, 600_000, { endingHere: true }), { startMs: 0, endMs: 4_000 });
});

test("moving an edge keeps the clip inside the video and at least a second long", () => {
  const range = { startMs: 10_000, endMs: 20_000 };
  assert.deepEqual(moveEdge(range, "start", 12_000, 60_000), { startMs: 12_000, endMs: 20_000 });
  assert.deepEqual(moveEdge(range, "start", 25_000, 60_000), { startMs: 25_000, endMs: 26_000 }, "the out point is pushed along");
  assert.deepEqual(moveEdge(range, "end", 5_000, 60_000), { startMs: 4_000, endMs: 5_000 }, "the in point is pushed back");
  assert.deepEqual(moveEdge(range, "end", 90_000, 60_000), { startMs: 10_000, endMs: 60_000 });
  assert.deepEqual(moveEdge(range, "start", -5, 60_000), { startMs: 0, endMs: 20_000 });
});

test("overlapping clips get their own lanes; clips that follow each other share one", () => {
  const lanes = laneClips([{ id: "a", startMs: 0, endMs: 10 }, { id: "b", startMs: 5, endMs: 15 }, { id: "c", startMs: 10, endMs: 20 }, { id: "d", startMs: 1, endMs: 30 }]);
  const lane = id => lanes.find(item => item.clip.id === id).lane;
  assert.equal(lane("a"), 0);
  assert.notEqual(lane("d"), lane("a"));
  assert.notEqual(lane("b"), lane("a"));
  assert.equal(lane("c"), 0, "starts where a ends");
  assert.ok(lanes.every(item => item.lane < 3));
});

test("a pointer position on the track maps to a time", () => {
  const rect = { left: 100, width: 212 };
  assert.equal(timeAt(106, rect, 60_000), 0);
  assert.equal(timeAt(206, rect, 60_000), 30_000);
  assert.equal(timeAt(1000, rect, 60_000), 60_000);
});
