import test from 'node:test';
import assert from 'node:assert/strict';
import { trackPlaybackProgress, resumeSeconds } from '../src/playback-progress.mjs';

test('resume respects timestamp links and restarts completed items', () => {
  assert.equal(resumeSeconds({ progress_ms: 42000 }, null), 42);
  assert.equal(resumeSeconds({ progress_ms: 42000, completed: 1 }, null), 0);
  assert.equal(resumeSeconds({ progress_ms: 42000 }, '0'), 0);
  assert.equal(resumeSeconds({ progress_ms: 42000 }, '12'), 12);
  assert.equal(resumeSeconds({ progress_ms: 42000 }, 'invalid'), 42);
});

test('restores once after metadata, saves on hide/seek/pause/end, retains position on removal', () => {
  const media = Object.assign(new EventTarget(), { readyState: 0, currentTime: 0, duration: 100, paused: true, ended: false });
  const page = new EventTarget(), documentTarget = new EventTarget(), saved = [];
  let views = 0;
  const stop = trackPlaybackProgress(media, { initialSeconds: 42, save: value => saved.push(value), onPlay: () => views++, page, documentTarget });
  try {
    assert.equal(media.currentTime, 0);
    media.readyState = 1;
    media.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(media.currentTime, 42);
    assert.equal(saved.length, 0);
    media.dispatchEvent(new Event('playing'));
    assert.equal(views, 1);
    media.currentTime = 50;
    media.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(media.currentTime, 50);
    documentTarget.hidden = true;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(saved.at(-1).progressMs, 50000);
    media.currentTime = 10;
    media.dispatchEvent(new Event('seeked'));
    assert.equal(saved.at(-1).progressMs, 10000);
    media.currentTime = 20;
    media.dispatchEvent(new Event('pause'));
    assert.equal(saved.at(-1).progressMs, 20000);
    media.currentTime = 100; media.ended = true;
    media.dispatchEvent(new Event('ended'));
    assert.equal(saved.at(-1).completed, true);
    media.currentTime = 0; media.ended = false;
  } finally { stop(); }
  assert.deepEqual(saved.at(-1), { progressMs: 100000, completed: true });
});

test('opening without playback never overwrites a saved position; stale positions restart', () => {
  const media = Object.assign(new EventTarget(), { readyState: 1, currentTime: 0, duration: 10, paused: true });
  const saved = [];
  const stop = trackPlaybackProgress(media, { initialSeconds: 42, save: value => saved.push(value), onPlay() {}, page: new EventTarget(), documentTarget: new EventTarget() });
  assert.equal(media.currentTime, 0);
  stop();
  assert.deepEqual(saved, []);
});
