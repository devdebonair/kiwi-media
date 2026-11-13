import test from "node:test";
import assert from "node:assert/strict";
import { planStart } from "../src/stream.js";

const LEAD = 0.3 + 1024 / 48_000;

test("a stream from the start leads the audio with silence and says so", async () => {
  const plan = await planStart({ input: "x", start: 0, probe: () => assert.fail("no lookup needed") });
  assert.equal(plan.seek, 0);
  assert.equal(plan.firstPts, -0.3 * 48_000);
  assert.ok(Math.abs(plan.origin + LEAD) < 1e-9);
});

test("copied video starts on the keyframe a seek lands on, audio read from the same place", async () => {
  const plan = await planStart({ input: "x", start: 600, probe: async () => ({ time: 598.641, reorders: true }) });
  assert.equal(plan.accurate, false, "audio is not cut at 600 while the picture starts at 598.641");
  assert.ok(plan.seek > 598.641 + 3 / 23 && plan.seek < 598.641 + 3 / 23 + 0.01, "ffmpeg's earlier seek for reordered video lands back on the keyframe");
  assert.ok(Math.abs(plan.origin - (598.641 - LEAD)) < 1e-9);
  assert.equal(plan.firstPts, Math.round((598.641 - plan.seek - 0.3) * 48_000));
  const plain = await planStart({ input: "x", start: 600, probe: async () => ({ time: 598, reorders: false }) });
  assert.ok(Math.abs(plain.seek - 598.001) < 1e-9);
});

test("re-encoded video is cut exactly; an unreadable file falls back to cutting at the asked time", async () => {
  const transcoded = await planStart({ input: "x", start: 600, video: "transcode", probe: () => assert.fail("no lookup needed") });
  assert.deepEqual([transcoded.seek, transcoded.accurate], [600, true]);
  assert.ok(Math.abs(transcoded.origin - (600 - LEAD)) < 1e-9);
  const unknown = await planStart({ input: "x", start: 600, probe: async () => null });
  assert.deepEqual(unknown, { seek: 600, accurate: true, firstPts: null, origin: 600 });
});

test("a growing HLS playlist tells the player to start at its first segment, once", async () => {
  const { startAtBeginning } = await import("../src/stream.js");
  const playlist = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg00000.m4s\n";
  const started = startAtBeginning(playlist);
  assert.equal(started.split("\n")[1], "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
  assert.equal(started.replace("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n", ""), playlist);
  assert.equal(startAtBeginning(started), started);
});
