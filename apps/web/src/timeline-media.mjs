// Repackaged playback is a stream that starts at some offset into the movie, so the browser's own clock
// restarts at zero. This wraps a <video> so everything that reads or sets its time (progress tracking,
// moments, the guide) sees real positions in the whole movie.
export function createTimelineMedia(element, timeline) {
  return new Proxy(element, {
    get(target, property) {
      if (property === "currentTime") return timeline.position();
      if (property === "duration") return timeline.duration() ?? target.duration;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "currentTime") { timeline.seek(Number(value)); return true; }
      return Reflect.set(target, property, value, target);
    },
  });
}

// Where a seek should land: inside the data already received it is a plain currentTime change; beyond it the
// stream is restarted at the new offset.
export function planSeek({ target, offset, bufferedEnd }) {
  if (target >= offset && target <= offset + bufferedEnd + 0.25) return { type: "local", time: Math.max(0, target - offset) };
  return { type: "restart", offset: Math.max(0, target) };
}

export function bufferedEndOf(media) {
  const ranges = media.buffered;
  for (let index = 0; index < ranges.length; index++) if (ranges.start(index) <= media.currentTime + 0.25 && ranges.end(index) >= media.currentTime) return ranges.end(index);
  return media.currentTime;
}
