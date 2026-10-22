"use client";

import { useCallback, useEffect, useState } from "react";

// What this browser can decode without the server re-encoding the video.
export function detectCaps() {
  const caps = [];
  try {
    const probe = document.createElement("video");
    if (probe.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')) caps.push("hevc");
    if (probe.canPlayType('video/mp4; codecs="av01.0.05M.08"')) caps.push("av1");
  } catch { /* Defaults to the safest assumptions. */ }
  return caps;
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

// Asks the server to find, verify, and open a source for a movie or episode (it may take several seconds the
// first time), then reports the tracks and how the file should reach the browser. Home videos skip the
// search and only read their tracks.
export function usePlaybackSession({ asset, api }) {
  const catalog = Boolean(asset.catalog);
  const [state, setState] = useState({ phase: catalog ? "loading" : "ready", stage: "", error: null, info: null });
  const [attempt, setAttempt] = useState({ number: 0, options: {} });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const caps = detectCaps();
    if (!catalog) {
      setState({ phase: "ready", stage: "", error: null, info: null });
      if (asset.kind === "video" && asset.file_path) api(`/api/v1/assets/${asset.id}/tracks?caps=${caps.join(",")}`).then(info => { if (!signal.aborted) setState(current => ({ ...current, info })); }).catch(() => {});
      return () => controller.abort();
    }
    setState({ phase: "loading", stage: "Finding the best source…", error: null, info: null });
    (async () => {
      for (let tries = 0; tries < 160; tries++) {
        const response = await fetch(`/api/v1/assets/${asset.id}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caps, ...attempt.options }), signal });
        const body = await response.json().catch(() => ({}));
        if (response.status === 202) { setState(current => ({ ...current, stage: body.stage || current.stage })); await wait(1500, signal); continue; }
        if (!response.ok) { setState({ phase: "error", stage: "", error: { message: body.error || "Playback is unavailable.", code: body.code }, info: null }); return; }
        setState({ phase: "ready", stage: "", error: null, info: body });
        return;
      }
      setState({ phase: "error", stage: "", error: { message: "Preparing this stream is taking too long. Try again in a moment.", code: "timeout" }, info: null });
    })().catch(error => { if (!signal.aborted) setState({ phase: "error", stage: "", error: { message: error.message || "Playback is unavailable.", code: "network" }, info: null }); });
    return () => controller.abort();
  }, [asset.id, asset.file_path, catalog, attempt.number, api]);

  const retry = useCallback((options = {}) => setAttempt(current => ({ number: current.number + 1, options })), []);
  return { ...state, retry };
}
