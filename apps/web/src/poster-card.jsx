"use client";

import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, Check, FilmSlate, MonitorPlay, Play, Plus, Star } from "@phosphor-icons/react";

export const typeLabel = item => item.type === "movie" ? "Movie" : item.isAnime ? "Anime" : "Series";
const typeChip = item => item.type === "movie" ? "Movie" : item.isAnime ? "Anime" : "TV";

// The small grey facts under a poster: type, year, and rating.
export function MetaChips({ item, extra }) {
  return <div className="meta-chips">
    {extra}
    <span className="meta-chip is-type">{typeChip(item)}</span>
    {item.year && <span className="meta-chip">{item.year}</span>}
    {item.rating > 0 && <span className="meta-chip"><Star size={11} weight="fill" />{item.rating.toFixed(1)}</span>}
  </div>;
}

function Art({ src, alt, Icon, title }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <div className="poster-empty"><Icon size={34} /><span>{title}</span></div>;
}

// A 2:3 poster for a movie or series. The corner button adds it to or removes it from My list.
export function PosterCard({ item, AppLink, navigate, onToggle, busy }) {
  const Icon = item.type === "movie" ? FilmSlate : MonitorPlay;
  const progress = item.watchedCount > 0 && item.episodeCount > 0 ? item.watchedCount / item.episodeCount : item.progressMs > 0 && item.durationMs > 0 ? item.progressMs / item.durationMs : 0;
  const foot = item.watchedCount > 0 && item.episodeCount > 0 ? `${item.watchedCount} / ${item.episodeCount} watched` : item.inLibrary ? "In My list" : null;
  return <article className="poster-card">
    <AppLink href={`/title/${item.ref}`} navigate={navigate} className="poster-link" aria-label={`${item.title}${item.year ? ` (${item.year})` : ""}`}>
      <div className="poster-art">
        <Art src={item.poster} alt="" Icon={Icon} title={item.title} />
        <span className="poster-hover" aria-hidden="true"><Play size={30} weight="fill" /></span>
        {foot && <span className="poster-foot"><span>{foot}</span></span>}
        {progress > 0 && <span className="poster-progress"><i style={{ width: `${Math.min(100, progress * 100)}%` }} /></span>}
      </div>
      <MetaChips item={item} />
      <h3>{item.title}</h3>
    </AppLink>
    {onToggle && <button className={`poster-add ${item.inLibrary ? "is-added" : ""}`} disabled={busy} aria-label={item.inLibrary ? `Remove ${item.title} from My list` : `Add ${item.title} to My list`} title={item.inLibrary ? "In My list" : "Add to My list"} onClick={event => { event.preventDefault(); event.stopPropagation(); onToggle(item); }}>
      {item.inLibrary ? <Check size={14} weight="bold" /> : <Plus size={14} weight="bold" />}
    </button>}
  </article>;
}

const remaining = asset => {
  if (!(asset.durationMs > 0 && asset.progressMs > 0)) return null;
  const minutes = Math.max(1, Math.round((asset.durationMs - asset.progressMs) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
};

// Something in progress, as a poster: which episode is next and how far along it is.
export function ContinueCard({ entry, AppLink, navigate }) {
  const { asset, title } = entry;
  const label = title.type === "show" ? `S${asset.season} · E${asset.episode}` : "Movie";
  const left = entry.resume ? remaining(asset) : "Up next";
  return <article className="poster-card continue-card">
    <AppLink href={`/watch/${asset.id}`} navigate={navigate} className="poster-link" aria-label={`${entry.resume ? "Resume" : "Play"} ${title.title} ${title.type === "show" ? label : ""}`}>
      <div className="poster-art">
        <Art src={title.poster || asset.thumbnail} alt="" Icon={title.type === "movie" ? FilmSlate : MonitorPlay} title={title.title} />
        <span className="poster-hover" aria-hidden="true"><Play size={30} weight="fill" /></span>
        <span className="poster-foot"><strong>{label}</strong>{left && <span>{left}</span>}</span>
        {asset.progressMs > 0 && asset.durationMs > 0 && <span className="poster-progress"><i style={{ width: `${Math.min(100, asset.progressMs / asset.durationMs * 100)}%` }} /></span>}
      </div>
      <MetaChips item={title} />
      <h3>{title.title}</h3>
    </AppLink>
  </article>;
}

// A titled row that scrolls sideways a page at a time, with a "1 / 4" pager in its heading.
export function Rail({ title, subtitle, children, action, className = "" }) {
  const track = useRef(null);
  const [pages, setPages] = useState({ current: 1, total: 1 });
  const measure = () => {
    const el = track.current;
    if (!el) return;
    const total = Math.max(1, Math.round(el.scrollWidth / el.clientWidth + 0.35));
    const current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 ? total : Math.min(total, Math.floor(el.scrollLeft / el.clientWidth + 0.1) + 1);
    setPages(value => value.current === current && value.total === total ? value : { current, total });
  };
  useEffect(() => { measure(); const el = track.current; if (!el) return; const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect(); }, [children]);
  const scroll = direction => track.current?.scrollBy({ left: direction * track.current.clientWidth, behavior: "smooth" });
  return <section className={`rail ${className}`}>
    <div className="shelf-head">
      <h2>{title}</h2>{subtitle && <span className="shelf-sub">{subtitle}</span>}
      <div className="shelf-tools">{action}{pages.total > 1 && <Pager current={pages.current} total={pages.total} onPrevious={() => scroll(-1)} onNext={() => scroll(1)} />}</div>
    </div>
    <div className="rail-track" ref={track} onScroll={measure}>{children}</div>
  </section>;
}

export function Pager({ current, total, onPrevious, onNext }) {
  return <div className="pager">
    <button type="button" aria-label="Previous page" disabled={current <= 1} onClick={onPrevious}><CaretLeft size={15} weight="bold" /></button>
    <span aria-live="polite">{current}/{total}</span>
    <button type="button" aria-label="Next page" disabled={current >= total} onClick={onNext}><CaretRight size={15} weight="bold" /></button>
  </div>;
}

// A pill switch like "All · Movies · Series · Anime".
export function Segmented({ options, value, onChange, label }) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key} className={value === key ? "active" : ""} onClick={() => onChange(key)}>{text}</button>)}
  </div>;
}
