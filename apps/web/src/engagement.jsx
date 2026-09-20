"use client";
import { useEffect, useRef, useState } from "react";
import { Heart, Eye } from "@phosphor-icons/react";

export function ViewCount({ count = 0 }) {
  return <span className="view-count"><Eye size={16} aria-hidden="true" />{count.toLocaleString()} {count === 1 ? "view" : "views"}</span>;
}

export function LikeButton({ asset, api, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update(count) {
    setBusy(true); setError("");
    try { onChange(await api(`/api/v1/assets/${asset.id}/likes`, { method: "PUT", body: JSON.stringify({ count }) })); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <div className="like-control">
    <button className={asset.my_likes ? "primary-button" : "outline-button"} disabled={busy || asset.my_likes >= 5} onClick={() => update((asset.my_likes || 0) + 1)} aria-label={`Like ${asset.title}, ${asset.my_likes || 0} of 5 likes used`}>
      <Heart weight={asset.my_likes ? "fill" : "regular"} aria-hidden="true" />Like · {asset.my_likes || 0}/5
    </button>
    {asset.my_likes > 0 && <button className="reset-likes" disabled={busy} onClick={() => update(0)} aria-label={`Clear likes for ${asset.title}`}>Clear</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}

// One session per mounted item. The server deduplicates retries with the same ID.
export function usePlaybackTracking({ id, ready, mediaRef, api, onChange, still = false }) {
  const session = useRef(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!ready) return;
    if (!session.current) session.current = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    let counted = false, pending = false, played = false, active = true;
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
    const record = () => {
      if (!played) return;
      view();
      api(`/api/v1/assets/${id}/progress`, { method: "PUT", keepalive: true, body: JSON.stringify({ progressMs: Math.round(media.currentTime * 1000), completed: media.ended }) }).catch(() => {});
    };
    const playing = () => { played = true; record(); };
    media.addEventListener("playing", playing);
    media.addEventListener("pause", record);
    media.addEventListener("ended", record);
    window.addEventListener("pagehide", record);
    if (!media.paused && media.readyState >= 3) playing();
    const timer = setInterval(() => { if (!media.paused) record(); }, 20000);
    return () => {
      active = false; record(); clearInterval(timer);
      media.removeEventListener("playing", playing);
      media.removeEventListener("pause", record);
      media.removeEventListener("ended", record);
      window.removeEventListener("pagehide", record);
    };
  }, [id, ready, still, api, mediaRef]);
}
