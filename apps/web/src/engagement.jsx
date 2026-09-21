"use client";
import { useEffect, useRef } from "react";
import { trackPlaybackProgress } from "./playback-progress.mjs";
import { Eye } from "@phosphor-icons/react";

export function ViewCount({ count = 0 }) {
  return <span className="view-count"><Eye size={16} aria-hidden="true" />{count.toLocaleString()} {count === 1 ? "view" : "views"}</span>;
}

export { LikeButton } from "./animated-like-button.jsx";

// One session per mounted item. The server deduplicates retries with the same ID.
export function usePlaybackTracking({ id, ready, mediaRef, api, onChange, still = false, initialSeconds = 0 }) {
  const session = useRef(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!ready) return;
    if (!session.current) session.current = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    let counted = false, pending = false, active = true;
    const media = mediaRef.current;
    const view = async () => {
      if (counted || pending) return;
      pending = true;
      try {
        const result = await api(`/api/v1/assets/${id}/views`, { method: "POST", keepalive: true, body: JSON.stringify({ sessionId: session.current }) });
        counted = true;
        if (active) change.current?.({ view_count: result.view_count });
      } catch { /* Retry on the next playback update. */ }
      finally { pending = false; }
    };
    if (still) { view(); return () => { active = false; }; }
    if (!media) return;
    const stop = trackPlaybackProgress(media, {
      initialSeconds,
      onPlay: view,
      save: progress => {
        view();
        api(`/api/v1/assets/${id}/progress`, { method: "PUT", keepalive: true, body: JSON.stringify(progress) }).catch(() => {});
      },
    });
    return () => { active = false; stop(); };
  }, [id, ready, still, api, mediaRef, initialSeconds]);
}
