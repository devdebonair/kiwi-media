"use client";

import { useEffect, useRef, useState } from "react";
import { Heart, Sparkle } from "@phosphor-icons/react";

const labels = ["Like", "Liked", "Really like", "Love it", "Love it!", "Adored"];
const particleCounts = [0, 6, 10, 14, 20, 28];

function LikeBurst({ level }) {
  return <span className="like-burst" aria-hidden="true">
    <span className="like-ring" />
    {level >= 3 && <span className="like-ring like-ring-secondary" />}
    {level === 5 && <span className="like-aura" />}
    {Array.from({ length: particleCounts[level] }, (_, index) => {
      const angle = (index / particleCounts[level]) * Math.PI * 2 - Math.PI / 2;
      const distance = 19 + level * 8 + (index % 3) * 7;
      const shape = level >= 4 && index % 3 === 0 ? "heart" : level >= 3 && index % 3 === 1 ? "star" : "dot";
      return <span key={index} className={`like-particle like-particle-${shape}`} style={{
        "--x": `${Math.cos(angle) * distance}px`,
        "--y": `${Math.sin(angle) * distance}px`,
        "--turn": `${(index % 2 ? 1 : -1) * (30 + index * 13)}deg`,
        "--delay": `${level >= 4 ? (index % 4) * 45 : (index % 2) * 25}ms`,
        "--particle-size": `${shape === "dot" ? 3 + index % 3 : 9 + index % 4}px`,
        "--particle-color": index % 3 === 0 ? "var(--like-highlight)" : "var(--like-color)",
      }}>{shape === "heart" ? <Heart weight="fill" /> : shape === "star" ? <Sparkle weight="fill" /> : null}</span>;
    })}
  </span>;
}

export function LikeButton(props) {
  // A new item starts with its own pending request and celebration state.
  return <AnimatedLikeButton key={props.asset.id} {...props} />;
}

function AnimatedLikeButton({ asset, api, onChange }) {
  const [pendingCount, setPendingCount] = useState(null);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [burst, setBurst] = useState(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const count = pendingCount ?? (asset.my_likes || 0);
  const busy = pendingCount !== null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!burst) return;
    const timer = setTimeout(() => setBurst(null), 1450);
    return () => clearTimeout(timer);
  }, [burst]);

  function celebrate(level) {
    setBurst({ level, sequence: ++sequence.current });
  }

  async function update(nextCount) {
    if (pending.current) return;
    pending.current = true;
    setPendingCount(nextCount); setError(""); setAnnouncement("");
    if (nextCount) celebrate(nextCount);
    else setBurst(null);
    try {
      const result = await api(`/api/v1/assets/${asset.id}/likes`, {
        method: "PUT", body: JSON.stringify({ count: nextCount }),
      });
      if (!mounted.current) return;
      onChange(result);
      setAnnouncement(nextCount ? `${labels[nextCount]}. ${nextCount} of 5 likes given${nextCount === 5 ? ". All the love!" : "."}` : "Likes cleared.");
    } catch (e) {
      if (!mounted.current) return;
      setError(e.message || "Could not save your like. Try again.");
      setBurst(null);
    } finally {
      pending.current = false;
      if (mounted.current) setPendingCount(null);
    }
  }

  const replay = count === 5;
  return <div className="like-control animated-like-control" data-like-level={count}>
    <button className={`like-button ${burst ? "is-celebrating" : ""}`} aria-disabled={busy} aria-busy={busy}
      aria-label={replay ? `Adored ${asset.title}. All 5 likes given. Replay celebration` : `Like ${asset.title}, ${count} of 5 likes given. Add a like`}
      title={replay ? "All the love. Tap to celebrate again." : `${count} of 5 likes. Tap to add a little more love.`}
      onClick={() => { if (!pending.current) { if (replay) celebrate(5); else update(count + 1); } }}>
      <span className="like-heart-stage" aria-hidden="true">
        <span key={`heart-${burst?.sequence ?? "resting"}`} className="like-heart"><Heart size={20} weight={count ? "fill" : "regular"} /></span>
        {burst && <LikeBurst key={`burst-${burst.sequence}`} level={burst.level} />}
      </span>
      <span className="like-button-copy" aria-hidden="true"><span className="like-label">{labels[count]}</span></span>
    </button>
    <span className="like-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {error && <span role="alert">{error}</span>}
  </div>;
}
