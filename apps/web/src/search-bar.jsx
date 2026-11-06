"use client";

import { AddToPlaylist } from "./playlist.jsx";
import { Fragment, useEffect, useId, useState } from "react";
import { ArrowUpRight, FilmSlate, MagnifyingGlass, Play, Scissors, Tag, X } from "@phosphor-icons/react";
import { clipHref } from "./clips.jsx";
import { clipTime } from "./clip-range.mjs";

const kindLabels = { video: "Video", audio: "Audio", image: "Photo", article: "Article", document: "Document" };

export function SearchBar({ query, setQuery, onSubmit, navigate, inputRef }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState({ query: "", items: [], titleIds: [], status: "idle" });
  // Movies, shows, and anime you haven't added yet, from the catalog (TMDB). Empty when streaming isn't set up.
  const [catalog, setCatalog] = useState({ query: "", items: [] });
  const term = query.trim();
  const expanded = open && Boolean(term);
  const library = result.query === term ? result.items : [];
  const status = result.query === term ? result.status : "loading";
  const inLibrary = new Set(result.query === term ? result.titleIds : []);
  const found = catalog.query === term ? catalog.items.filter(item => !item.titleId || !inLibrary.has(item.titleId)).slice(0, 5).map(item => ({ ...item, entityType: "catalog" })) : [];
  const items = [...library, ...found];

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController(), { signal } = controller;
    const timer = setTimeout(() => {
      setResult({ query: term, items: [], titleIds: [], status: "loading" });
      (async () => {
        try {
          const response = await fetch(`/api/v1/search?q=${encodeURIComponent(term)}&kind=all&limit=6`, { signal });
          if (!response.ok) throw new Error("Search unavailable");
          const rows = await response.json();
          if (!signal.aborted) {
            setResult({ query: term, items: rows, titleIds: rows.filter(row => row.entityType === "title").map(row => row.id), status: "ready" });
            setActive(-1);
          }
        } catch {
          if (!signal.aborted) setResult({ query: term, items: [], titleIds: [], status: "error" });
        }
      })();
      (async () => {
        try {
          const response = await fetch(`/api/v1/catalog/search?q=${encodeURIComponent(term)}`, { signal });
          const body = response.ok ? await response.json() : {};
          if (!signal.aborted) { setCatalog({ query: term, items: body.items || [] }); setActive(-1); }
        } catch {
          if (!signal.aborted) setCatalog({ query: term, items: [] });
        }
      })();
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, expanded]);

  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  function choose(index) {
    const item = items[index];
    setOpen(false); setActive(-1); inputRef.current?.blur();
    navigate(!item ? `/search?q=${encodeURIComponent(term)}`
      : item.entityType === "topic" ? `/topic/${encodeURIComponent(item.slug)}`
      : item.entityType === "title" ? `/title/${encodeURIComponent(item.ref)}`
      : item.entityType === "catalog" ? `/title/${encodeURIComponent(item.titleId || item.ref)}`
      : item.entityType === "clip" ? clipHref(item)
      : `/watch/${encodeURIComponent(item.id)}`);
  }

  function handleKey(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); setActive(-1); }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && term) {
      event.preventDefault(); setOpen(true);
      const length = items.length + 1;
      setActive(current => event.key === "ArrowDown" ? (current + 1) % length : current <= 0 ? length - 1 : current - 1);
    }
    if (event.key === "Enter" && expanded && active >= 0) { event.preventDefault(); choose(active); }
  }

  return <form className="search" role="search" onSubmit={event => { setOpen(false); setActive(-1); inputRef.current?.blur(); onSubmit(event); }} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1); }
  }}>
    <MagnifyingGlass size={20} aria-hidden="true" />
    <input ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
      autoComplete="off" spellCheck={false} value={query} onChange={event => { setQuery(event.target.value); setOpen(true); setActive(-1); }} onFocus={() => setOpen(true)} onKeyDown={handleKey}
      placeholder="Search movies, shows, anime, and videos…" aria-label="Search" />
    {query ? <button type="button" onClick={() => { setQuery(""); setActive(-1); inputRef.current?.focus(); }} aria-label="Clear search"><X size={18} /></button> : <kbd>⌘ / Ctrl K</kbd>}
    {expanded && <div className="search-suggestions">
      <div className="search-suggestions-heading" role="status">{status === "loading" ? "Searching your library…" : status === "error" ? "Library suggestions unavailable. Press Enter to search." : library.length ? "From your library" : found.length ? "Not in your library yet" : "No matches yet. Try another search."}</div>
      <div id={listId} role="listbox" aria-label="Search suggestions" className="search-suggestions-list">
        {items.map((item, index) => {
          const topic = item.entityType === "topic", title = item.entityType === "title" || item.entityType === "catalog", clip = item.entityType === "clip";
          const picture = topic ? item.avatar_url : title ? item.poster : clip ? item.asset.thumbnail_url : item.thumbnail_url;
          const name = topic ? item.name : clip ? item.title || item.topics.map(tag => tag.name).join(" · ") || "Untitled clip" : item.title;
          const label = topic ? "Topic" : title ? `${item.type === "movie" ? "Movie" : item.isAnime ? "Anime" : "Series"}${item.year ? ` · ${item.year}` : ""}`
            : clip ? `Clip · ${clipTime(item.startMs, { tenths: false })} in ${item.asset.title}` : kindLabels[item.kind] || "Media";
          const divider = item.entityType === "catalog" && index === library.length && library.length > 0
            ? <div role="presentation" className="search-suggestions-heading is-divider">From the catalog</div> : null;
          return <Fragment key={`${item.entityType}-${item.ref || item.id}`}>{divider}<div tabIndex={-1} role="option" aria-selected={active === index} id={`${listId}-${index}`} className="search-suggestion" onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
            <span className={`suggestion-image thumb ${topic ? "is-topic" : ""}`}>{topic ? <Tag size={18} /> : clip ? <Scissors size={18} /> : title ? <FilmSlate size={18} /> : <Play size={18} />}{picture && <img src={picture} alt="" onError={event => { event.currentTarget.hidden = true; }} />}{!topic && !title && !clip && <AddToPlaylist asset={item}/>}</span>
            <span className="suggestion-copy"><strong>{name}</strong><small>{label}</small></span><ArrowUpRight size={16} aria-hidden="true" />
          </div></Fragment>;
        })}
        <button type="button" tabIndex={-1} role="option" aria-selected={active === items.length} id={`${listId}-${items.length}`} className="search-suggestion search-all" onMouseDown={event => event.preventDefault()} onClick={() => choose(items.length)}><MagnifyingGlass size={18} /><span>Search for “{term}”</span><ArrowUpRight size={16} /></button>
      </div>
    </div>}
  </form>;
}
