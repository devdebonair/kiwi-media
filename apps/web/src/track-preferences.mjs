// Remembers the audio and subtitle language chosen for a series (or a single video), so every episode follows.
const KEY = "kiwi.tracks.v1";
const LIMIT = 300;

export function loadPreference(key, storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(KEY) || "{}")[key] || null; } catch { return null; }
}

export function savePreference(key, patch, storage = globalThis.localStorage) {
  try {
    const all = JSON.parse(storage.getItem(KEY) || "{}");
    all[key] = { ...(all[key] || {}), ...patch, at: Date.now() };
    const keep = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, LIMIT);
    storage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* Preferences are a convenience only. */ }
}

// Picks the starting tracks: your saved choice for this series if it applies to this file, else the server's defaults.
export function applyPreference(info, preference) {
  const audio = preference?.audio ? info.audio.find(track => track.language === preference.audio) : null;
  let subtitleId = info.chosen.subtitleId;
  if (preference?.subtitle === "off") subtitleId = null;
  else if (preference?.subtitle) {
    const matches = info.subtitles.filter(track => track.language === preference.subtitle && track.status !== "unsupported" && track.status !== "failed");
    const best = matches.find(track => !track.forced) || matches[0];
    if (best) subtitleId = best.id;
  }
  return { audioPosition: audio ? audio.position : info.chosen.audioPosition, subtitleId };
}
