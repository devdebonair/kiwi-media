"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Info, Play, Plus, SpinnerGap, Star } from "@phosphor-icons/react";

const ROTATE_MS = 9000;
const kindLabel = item => item.type === "movie" ? "Movie" : item.isAnime ? "Anime" : "Series";
const runtime = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ""}`.trim() : `${minutes}m`;

// The banner at the top of Home and the Movies, TV Shows, and Anime pages: wide artwork that fills the top of the
// window (behind the header and rail), the title's logo, a few facts, and Watch / Details / My list. It moves on
// every few seconds, pausing while the pointer or keyboard focus is on it.
export function Hero({ kind = "home", api, navigate, AppLink }) {
  const [items, setItems] = useState(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const root = useRef(null);

  useEffect(() => {
    let active = true;
    setItems(null); setIndex(0);
    api(`/api/v1/catalog/featured?kind=${kind}`).then(value => { if (active) setItems(value.items); }).catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [api, kind]);

  useEffect(() => {
    if (!items?.length || items.length < 2 || paused) return;
    const timer = setTimeout(() => { if (!document.hidden) setIndex(value => (value + 1) % items.length); }, ROTATE_MS);
    return () => clearTimeout(timer);
  }, [items, index, paused]);

  if (items === null) return <section className="hero is-loading" aria-hidden="true"><div className="hero-backdrop"><div className="hero-scrim" /></div></section>;
  if (!items.length) return null;
  const item = items[index];

  // Catalog titles become local the first time they are opened; that gives them an episode to start.
  const resolve = async () => item.titleId ? { id: item.titleId } : await api(`/api/v1/titles/${encodeURIComponent(item.ref)}`);
  const watch = async () => {
    if (item.play) { navigate(`/watch/${item.play.id}`); return; }
    setBusy("watch"); setNote("");
    try {
      const title = await api(`/api/v1/titles/${encodeURIComponent(item.titleId || item.ref)}`);
      navigate(title.nextUp ? `/watch/${title.nextUp.id}` : `/title/${title.id}`);
    } catch (e) { setNote(e.message); setBusy(""); }
  };
  const toggleList = async () => {
    setBusy("list"); setNote("");
    try {
      const title = await resolve();
      const updated = await api(`/api/v1/titles/${title.id}/library`, { method: "PUT", body: JSON.stringify({ inLibrary: !item.inLibrary }) });
      setItems(list => list.map((entry, position) => position === index ? { ...entry, titleId: title.id, inLibrary: updated.inLibrary } : entry));
    } catch (e) { setNote(e.message); }
    finally { setBusy(""); }
  };
  const playLabel = item.play ? (item.play.resume ? "Resume" : "Continue") + (item.type === "show" && item.play.season != null ? ` S${item.play.season} · E${item.play.episode}` : "") : "Watch now";
  const facts = [kindLabel(item), item.year, item.certification, item.type === "movie" && item.runtimeMin ? runtime(item.runtimeMin) : null, ...item.genres].filter(Boolean);

  return <section ref={root} className="hero" aria-roledescription="carousel" aria-label="Featured"
    onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={event => { if (!root.current?.contains(event.relatedTarget)) setPaused(false); }}>
    <div className="hero-backdrop" aria-hidden="true">
      {items.map((entry, position) => <img key={entry.ref} src={entry.backdrop} alt="" className={position === index ? "is-active" : ""} loading={position === 0 ? "eager" : "lazy"} />)}
      <div className="hero-scrim" />
    </div>
    <div className="hero-content" key={item.ref} aria-roledescription="slide" aria-label={`${index + 1} of ${items.length}`}>
      <h1 className={`hero-title ${item.logo ? "has-logo" : ""}`}>{item.logo ? <img src={item.logo} alt={item.title} /> : item.title}</h1>
      <div className="hero-facts">{facts.map(fact => <span key={fact} className="hero-pill">{fact}</span>)}{item.rating > 0 && <span className="hero-pill"><Star size={12} weight="fill" />{item.rating.toFixed(1)}</span>}</div>
      {item.overview && <p className="hero-overview">{item.overview}</p>}
      <div className="hero-actions">
        <button type="button" className="primary-button" onClick={watch} disabled={busy === "watch"}>{busy === "watch" ? <SpinnerGap size={16} className="spin" /> : <Play size={16} weight="fill" />}{playLabel}</button>
        <AppLink href={`/title/${item.titleId || item.ref}`} navigate={navigate} className="outline-button"><Info size={16} />Details</AppLink>
        <button type="button" className={`outline-button icon-only ${item.inLibrary ? "is-active" : ""}`} onClick={toggleList} disabled={busy === "list"} aria-pressed={item.inLibrary} aria-label={item.inLibrary ? "Remove from My list" : "Add to My list"} title={item.inLibrary ? "In My list" : "Add to My list"}>{item.inLibrary ? <Check size={16} weight="bold" /> : <Plus size={16} />}</button>
      </div>
      {note && <p className="hero-note" role="status">{note}</p>}
    </div>
    {items.length > 1 && <div className="hero-dots">{items.map((entry, position) => <button key={entry.ref} type="button" className={position === index ? "active" : ""} aria-label={`Show ${entry.title}`} aria-current={position === index ? "true" : undefined} onClick={() => setIndex(position)} />)}</div>}
  </section>;
}
