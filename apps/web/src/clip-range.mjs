// Range math for authoring clips on the player timeline. Times are milliseconds.
export const MIN_CLIP_MS = 1000;
export const DEFAULT_CLIP_MS = 15_000;

export function clipTime(ms, { tenths = true } = {}) {
  const value = Math.max(0, Math.round((ms || 0) / 100) / 10), whole = Math.floor(value);
  const h = Math.floor(whole / 3600), m = Math.floor(whole % 3600 / 60), s = whole % 60;
  const rest = tenths ? `.${Math.round((value - whole) * 10) % 10}` : "";
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${rest}` : `${m}:${String(s).padStart(2, "0")}${rest}`;
}

export const clipLength = ms => ms < 60_000 ? `${(Math.round(ms / 100) / 10).toFixed(1)}s` : clipTime(ms, { tenths: false });

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// A new clip around the playhead: from here forward, or ending here when "out" is pressed first.
export function newRange(positionMs, totalMs, { endingHere = false } = {}) {
  const total = totalMs > 0 ? totalMs : positionMs + DEFAULT_CLIP_MS;
  if (endingHere) {
    const endMs = clamp(Math.round(positionMs), MIN_CLIP_MS, total);
    return { startMs: Math.max(0, endMs - DEFAULT_CLIP_MS), endMs };
  }
  const startMs = clamp(Math.round(positionMs), 0, Math.max(0, total - MIN_CLIP_MS));
  return { startMs, endMs: Math.min(total, startMs + DEFAULT_CLIP_MS) };
}

// Moves one edge. Moving an edge past the other pushes it along so the clip never gets shorter than the minimum.
export function moveEdge(range, edge, valueMs, totalMs) {
  const total = totalMs > 0 ? totalMs : Math.max(range.endMs, valueMs) + MIN_CLIP_MS;
  const value = clamp(Math.round(valueMs), 0, total);
  if (edge === "start") {
    const startMs = Math.min(value, total - MIN_CLIP_MS);
    return { startMs, endMs: Math.max(range.endMs, startMs + MIN_CLIP_MS) };
  }
  const endMs = Math.max(value, MIN_CLIP_MS);
  return { startMs: Math.min(range.startMs, endMs - MIN_CLIP_MS), endMs };
}

// Stacks overlapping clips into lanes so none hides another under the timeline (at most `max` lanes).
export function laneClips(clips, max = 3) {
  const ends = [];
  return [...clips].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs).map(clip => {
    let lane = ends.findIndex(end => end <= clip.startMs);
    if (lane === -1) lane = ends.length < max ? ends.length : ends.indexOf(Math.min(...ends));
    ends[lane] = Math.max(ends[lane] ?? 0, clip.endMs);
    return { clip, lane };
  });
}

// Where along the seek track a time sits, accounting for the thumb inset at both ends.
export const trackLeft = (ms, totalMs) => `calc(6px + (100% - 12px) * ${totalMs > 0 ? clamp(ms / totalMs, 0, 1) : 0})`;
export const timeAt = (clientX, rect, totalMs) => clamp((clientX - rect.left - 6) / Math.max(1, rect.width - 12), 0, 1) * totalMs;
