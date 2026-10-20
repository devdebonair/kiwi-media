import test from 'node:test';
import assert from 'node:assert/strict';
import { airing, halfHour, liveOffset, placement, programAt, slots, span, SLOT_MS } from '../src/guide-time.mjs';

const minute = 60_000;
const base = Date.UTC(2026, 9, 19, 20);
const programs = [
  { id: 'a', start: base, end: base + 12 * minute },
  { id: 'b', start: base + 12 * minute, end: base + 40 * minute },
  { id: 'c', start: base + 40 * minute, end: base + 95 * minute },
];

test('half-hour slots line up the guide header', () => {
  assert.equal(halfHour(base + 29 * minute), base);
  assert.equal(halfHour(base + 30 * minute), base + SLOT_MS);
  assert.deepEqual(slots(base, base + 2 * 60 * minute).map(time => (time - base) / minute), [0, 30, 60, 90]);
});

test('finding the program on air and keeping the time anchor when moving between channels', () => {
  assert.equal(airing(programs, base + 12 * minute).id, 'b');
  assert.equal(airing(programs, base + 95 * minute), null);
  assert.equal(programAt(programs, base + 50 * minute).id, 'c');
  assert.equal(programAt(programs, base - minute).id, 'a', 'before the lineup: the next program');
  assert.equal(programAt(programs, base + 200 * minute).id, 'c', 'after the lineup: the last program');
  assert.equal(programAt([], base), null);
});

test('joining live starts at the elapsed time, and only while the program airs', () => {
  assert.equal(liveOffset(programs[1], base + 15 * minute + 2500), 182);
  assert.equal(liveOffset(programs[1], base + 40 * minute), null);
  assert.equal(liveOffset(programs[1], base), null);
});

test('programs are clipped to the guide window', () => {
  const start = base + 30 * minute, end = start + 60 * minute;
  assert.deepEqual(placement(programs[1], start, end), { x: 0, width: 10, continued: true });
  assert.deepEqual(placement(programs[2], start, end), { x: 10, width: 50, continued: false });
});

test('durations read like a TV listing', () => {
  assert.equal(span(30 * 1000), '1 min');
  assert.equal(span(12 * minute), '12 min');
  assert.equal(span(60 * minute), '1 hr');
  assert.equal(span(95 * minute), '1 hr 35 min');
});
