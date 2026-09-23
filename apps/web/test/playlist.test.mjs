import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlaylist, playlistReducer as reduce, restorePlaylist } from '../src/playlist-state.mjs';
const a = { id: 'a', title: 'First', kind: 'video' }, b = { id: 'b', title: 'Second', kind: 'video' };
test('first add creates a playlist, duplicates do not interrupt playback', () => {
  let state = reduce(emptyPlaylist(), { type: 'add', asset: a });
  state = reduce(state, { type: 'add', asset: b });
  state = reduce(state, { type: 'add', asset: a });
  assert.equal(state.activeId, 'a'); assert.equal(state.items.length, 2);
  assert.deepEqual(restorePlaylist(JSON.stringify(state)), state);
});
test('completed or removed videos advance and the last one clears playback', () => {
  let state = reduce(reduce(emptyPlaylist(), { type: 'add', asset: a }), { type: 'add', asset: b });
  state = reduce(state, { type: 'remove', id: 'a' });
  assert.equal(state.activeId, 'b'); assert.deepEqual(state.items.map(a => a.id), ['b']);
  assert.deepEqual(reduce(state, { type: 'remove', id: 'b' }), emptyPlaylist());
});
test('playing a queued video keeps the other unwatched items', () => {
  let state = reduce(reduce(emptyPlaylist(), { type: 'add', asset: a }), { type: 'play', asset: b });
  assert.equal(state.activeId, 'b');
  state = reduce(state, { type: 'remove', id: 'b' });
  assert.equal(state.activeId, 'a');
});
test('invalid storage recovers and nonvideos are never queued', () => {
  for (const value of [null, '{}', 'invalid', '{"items":null}']) assert.deepEqual(restorePlaylist(value), emptyPlaylist());
  const state = restorePlaylist(JSON.stringify({ items: [null, a, a, { id: 4 }, b], activeId: 'missing' }));
  assert.deepEqual(state.items.map(a => a.id), ['a', 'b']); assert.equal(state.activeId, 'a');
  assert.deepEqual(reduce(emptyPlaylist(), { type: 'add', asset: { ...a, kind: 'audio' } }), emptyPlaylist());
});
