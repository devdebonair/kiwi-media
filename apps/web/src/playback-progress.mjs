// Wait for metadata before seeking; opening a player alone must not erase progress.
export function trackPlaybackProgress(media, { initialSeconds = 0, save, onPlay, page = window, documentTarget = document }) {
  let restored = false, played = false, latest = null;
  const restore = () => {
    if (restored || media.readyState < 1) return;
    const duration = media.duration;
    const target = Number.isFinite(initialSeconds) && initialSeconds > 0 &&
      (!Number.isFinite(duration) || initialSeconds < duration) ? initialSeconds : 0;
    media.currentTime = target;
    restored = true;
  };
  const capture = () => {
    if (!played || !restored || !Number.isFinite(media.currentTime)) return;
    latest = { progressMs: Math.round(media.currentTime * 1000), completed: media.ended };
  };
  const record = () => { capture(); if (latest) save(latest); };
  const playing = () => { restore(); played = true; onPlay(); record(); };
  const hidden = () => { if (documentTarget.hidden) record(); };
  media.addEventListener('loadedmetadata', restore);
  media.addEventListener('playing', playing);
  media.addEventListener('timeupdate', capture);
  media.addEventListener('seeked', record);
  media.addEventListener('pause', record);
  media.addEventListener('ended', record);
  page.addEventListener('pagehide', record);
  documentTarget.addEventListener('visibilitychange', hidden);
  restore();
  if (!media.paused && media.readyState >= 3) playing();
  const timer = setInterval(() => { if (!media.paused) record(); }, 5000);
  return () => {
    // React may already have detached/reset the media element during cleanup.
    if (latest) save(latest);
    clearInterval(timer);
    media.removeEventListener('loadedmetadata', restore);
    media.removeEventListener('playing', playing);
    media.removeEventListener('timeupdate', capture);
    media.removeEventListener('seeked', record);
    media.removeEventListener('pause', record);
    media.removeEventListener('ended', record);
    page.removeEventListener('pagehide', record);
    documentTarget.removeEventListener('visibilitychange', hidden);
  };
}

export function resumeSeconds(asset, timestamp) {
  if (timestamp !== null && timestamp !== '' && Number.isFinite(Number(timestamp)) && Number(timestamp) >= 0) return Number(timestamp);
  return asset?.completed ? 0 : Math.max(0, Number(asset?.progress_ms) || 0) / 1000;
}
