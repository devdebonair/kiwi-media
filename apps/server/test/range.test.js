import test from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/range.js";

test("video streaming accepts bounded, open-ended, and suffix byte ranges", () => {
  assert.deepEqual(parseRange("bytes=0-1", 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange("bytes=50-", 100), { start: 50, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-200", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=90-999", 100), { start: 90, end: 99 });
});

test("rejects malformed, empty, multiple, and unsatisfiable ranges", () => {
  for (const range of ["bytes=", "bytes=-", "bytes=-0", "bytes=100-", "bytes=90-80", "bytes=0-1,2-3", "other bytes=0-1", "bytes=0-1garbage", "bytes=999999999999999999999-"]) {
    assert.equal(parseRange(range, 100), null, range);
  }
  assert.equal(parseRange("bytes=0-", 0), null);
});
