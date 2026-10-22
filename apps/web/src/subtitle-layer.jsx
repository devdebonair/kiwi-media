"use client";

import { useEffect, useMemo, useState } from "react";
import { activeCues, cueLines, parseVtt } from "./subtitle-cues.mjs";

const STYLE_KEY = "kiwi.subtitle.style.v1";
export const SUBTITLE_SIZES = [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Extra large"]];
export const SUBTITLE_BACKGROUNDS = [["shadow", "Outline"], ["box", "Box"], ["none", "None"]];

export function useSubtitleStyle() {
  const [style, setStyle] = useState({ size: "m", background: "shadow" });
  useEffect(() => { try { setStyle(current => ({ ...current, ...JSON.parse(localStorage.getItem(STYLE_KEY) || "{}") })); } catch { /* Defaults apply. */ } }, []);
  const update = patch => setStyle(current => {
    const next = { ...current, ...patch };
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(next)); } catch { /* The choice lasts for this visit. */ }
    return next;
  });
  return [style, update];
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

// Downloads and parses the selected subtitle track. Tracks inside a large file are extracted on first use,
// which can take a little while, so the server answers "working" until it is ready.
export function useSubtitleCues(trackId) {
  const [state, setState] = useState({ cues: [], status: "off" });
  useEffect(() => {
    if (!trackId) { setState({ cues: [], status: "off" }); return; }
    const controller = new AbortController();
    setState({ cues: [], status: "loading" });
    (async () => {
      for (let tries = 0; tries < 80; tries++) {
        const response = await fetch(`/api/v1/subtitles/${trackId}.vtt`, { signal: controller.signal });
        if (response.status === 202) { await wait(3000, controller.signal); continue; }
        if (!response.ok) { setState({ cues: [], status: response.status === 415 ? "unsupported" : "failed" }); return; }
        setState({ cues: parseVtt(await response.text()), status: "ready" });
        return;
      }
      setState({ cues: [], status: "failed" });
    })().catch(() => { if (!controller.signal.aborted) setState({ cues: [], status: "failed" }); });
    return () => controller.abort();
  }, [trackId]);
  return state;
}

// Draws the cues showing at `time` over the video. `raised` lifts them above the controls while those are visible.
export function SubtitleLayer({ cues, time, size, background, raised }) {
  const active = useMemo(() => activeCues(cues, time), [cues, time]);
  const lines = useMemo(() => active.flatMap(cue => cueLines(cue.text)), [active]);
  if (!lines.length) return null;
  return <div className={`kiwi-subtitles size-${size} bg-${background} ${raised ? "raised" : ""}`} aria-live="off">
    {lines.map((line, index) => <p key={index}>{line.map((run, position) => <span key={position} style={{ fontStyle: run.italic ? "italic" : undefined, fontWeight: run.bold ? 700 : undefined, textDecoration: run.underline ? "underline" : undefined }}>{run.text}</span>)}</p>)}
  </div>;
}
