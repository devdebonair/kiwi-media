"use client";

import { useEffect, useRef, useState } from "react";
import { SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { resumeSeconds } from "./playback-progress.mjs";

const HOVER_DELAY_MS = 700;
const MUTED_KEY = "kiwi.preview-muted";
// Previews never fall back to compatibility transcodes, so skip files the browser already rejected.
const unplayable = new Set();

const clock = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0)), h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
const storedMuted = () => { try { return localStorage.getItem(MUTED_KEY) !== "false"; } catch { return true; } };

// Mouse hover on a video thumbnail plays a muted preview after a short delay. The returned
// `seconds` lets the thumbnail link open the watch page where the preview left off.
export function useHoverPreview(asset) {
  const enabled = asset.kind === "video" && Boolean(asset.file_path);
  const [active, setActive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const stop = () => { clearTimeout(timer.current); setActive(false); setSeconds(0); };
  const bind = enabled ? {
    onPointerEnter: event => {
      if (event.pointerType !== "mouse" || unplayable.has(asset.id) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setActive(true), HOVER_DELAY_MS);
    },
    onPointerLeave: stop,
  } : {};
  const preview = active ? <HoverPreview asset={asset} onTime={setSeconds} onFail={() => { unplayable.add(asset.id); stop(); }} /> : null;
  return { bind, seconds: active ? Math.floor(seconds) : 0, previewing: active, preview };
}

function HoverPreview({ asset, onTime, onFail }) {
  const video = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(asset.duration_ms ? asset.duration_ms / 1000 : 0);
  const [muted, setMuted] = useState(storedMuted);
  const [hover, setHover] = useState(null);
  const [dragging, setDragging] = useState(false);

  const fraction = event => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  };
  const seek = value => {
    const media = video.current;
    if (!media || !duration) return;
    media.currentTime = value * duration;
    setPosition(media.currentTime);
    onTime(media.currentTime);
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try { localStorage.setItem(MUTED_KEY, String(next)); } catch { /* Preference lasts for this preview only. */ }
  };

  return <div className={`hover-preview ${playing ? "is-playing" : ""}`}>
    <video ref={video} src={`/api/v1/assets/${asset.id}/file`} muted={muted} autoPlay playsInline preload="auto" disablePictureInPicture
      onLoadedMetadata={event => {
        const media = event.currentTarget;
        if (Number.isFinite(media.duration)) setDuration(media.duration);
        const start = resumeSeconds(asset, null);
        if (start > 0 && start < media.duration - 1) media.currentTime = start;
      }}
      onPlaying={() => setPlaying(true)}
      onTimeUpdate={event => { if (!dragging) { setPosition(event.currentTarget.currentTime); onTime(event.currentTarget.currentTime); } }}
      onEnded={event => { event.currentTarget.currentTime = 0; event.currentTarget.play().catch(() => {}); }}
      onError={onFail} />
    {playing && <>
      <button type="button" className="hover-preview-mute" aria-label={muted ? "Unmute preview" : "Mute preview"} title={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
        {muted ? <SpeakerSlash size={16} weight="fill" /> : <SpeakerHigh size={16} weight="fill" />}
      </button>
      <div className={`hover-preview-scrubber ${dragging ? "is-dragging" : ""}`} aria-hidden="true"
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); seek(fraction(event)); }}
        onPointerMove={event => { const value = fraction(event); setHover(value); if (dragging) seek(value); }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onPointerLeave={() => setHover(null)}
        onClick={event => event.preventDefault()}>
        {hover !== null && <span className="hover-preview-time" style={{ left: `clamp(24px, ${hover * 100}%, calc(100% - 24px))` }}>{clock(hover * duration)}</span>}
        <div className="hover-preview-track"><div className="hover-preview-progress" style={{ transform: `scaleX(${duration ? Math.min(1, position / duration) : 0})` }} /></div>
      </div>
    </>}
  </div>;
}
