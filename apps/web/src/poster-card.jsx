"use client";

import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, Check, FilmSlate, MonitorPlay, Plus, Star } from "@phosphor-icons/react";

export const typeLabel = item => item.type === "movie" ? "Movie" : item.isAnime ? "Anime" : "Series";

// A 2:3 poster for a movie or series. Library items carry a check; the corner button adds or removes them.
export function PosterCard({ item, AppLink, navigate, onToggle, busy }) {
  const [failed, setFailed] = useState(false);
  const Icon = item.type === "movie" ? FilmSlate : MonitorPlay;
  return <article className="poster-card">
    <AppLink href={`/title/${item.ref}`} navigate={navigate} className="poster-link" aria-label={`${item.title}${item.year ? ` (${item.year})` : ""}`}>
      <div className="poster-art">
        {item.poster && !failed ? <img src={item.poster} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="poster-empty"><Icon size={36} /><span>{item.title}</span></div>}
        {item.rating > 0 && <span className="poster-rating"><Star size={11} weight="fill" />{item.rating.toFixed(1)}</span>}
        {item.watchedCount > 0 && item.episodeCount > 0 && <span className="poster-progress" title={`${item.watchedCount} of ${item.episodeCount} watched`}><i style={{ width: `${Math.min(100, item.watchedCount / item.episodeCount * 100)}%` }} /></span>}
        {item.progressMs > 0 && item.durationMs > 0 && <span className="poster-progress"><i style={{ width: `${Math.min(100, item.progressMs / item.durationMs * 100)}%` }} /></span>}
      </div>
      <h3>{item.title}</h3>
      <p>{[item.year, typeLabel(item)].filter(Boolean).join(" · ")}</p>
    </AppLink>
    {onToggle && <button className={`poster-add ${item.inLibrary ? "is-added" : ""}`} disabled={busy} aria-label={item.inLibrary ? `Remove ${item.title} from My list` : `Add ${item.title} to My list`} title={item.inLibrary ? "In My list" : "Add to My list"} onClick={event => { event.preventDefault(); event.stopPropagation(); onToggle(item); }}>
      {item.inLibrary ? <Check size={16} weight="bold" /> : <Plus size={16} weight="bold" />}
    </button>}
  </article>;
}

// A landscape card for something in progress: the episode's still, how far you are, and what comes next.
export function ContinueCard({ entry, AppLink, navigate, formatDuration }) {
  const { asset, title } = entry;
  const label = title.type === "show" ? `S${asset.season} · E${asset.episode}` : title.year;
  return <article className="continue-card">
    <AppLink href={`/watch/${asset.id}`} navigate={navigate} aria-label={`${entry.resume ? "Resume" : "Play"} ${title.title} ${label || ""}`}>
      <div className="continue-art">
        {(asset.thumbnail || title.backdropSmall) && <img src={asset.thumbnail || title.backdropSmall} alt="" loading="lazy" />}
        {asset.progressMs > 0 && <span className="poster-progress"><i style={{ width: `${Math.min(100, asset.progressMs / asset.durationMs * 100)}%` }} /></span>}
        {asset.durationMs > 0 && <span className="duration">{formatDuration(asset.durationMs)}</span>}
      </div>
      <h3>{title.title}</h3>
      <p>{[label, entry.resume ? "Resume" : "Up next"].filter(Boolean).join(" · ")}</p>
    </AppLink>
  </article>;
}

// A row that scrolls sideways, with arrow buttons where there is a mouse.
export function Rail({ title, subtitle, children, action }) {
  const track = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = track.current;
    if (el) setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  };
  useEffect(() => { measure(); const el = track.current; if (!el) return; const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect(); }, [children]);
  const scroll = direction => track.current?.scrollBy({ left: direction * track.current.clientWidth * 0.85, behavior: "smooth" });
  return <section className="rail">
    <div className="row-heading"><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}{action}</div>
    <div className="rail-frame">
      <button className="rail-arrow left" aria-label="Scroll left" disabled={edges.start} onClick={() => scroll(-1)}><CaretLeft size={20} weight="bold" /></button>
      <div className="rail-track" ref={track} onScroll={measure}>{children}</div>
      <button className="rail-arrow right" aria-label="Scroll right" disabled={edges.end} onClick={() => scroll(1)}><CaretRight size={20} weight="bold" /></button>
    </div>
  </section>;
}
