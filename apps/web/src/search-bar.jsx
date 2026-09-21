"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, MagnifyingGlass, Play, Tag, X } from "@phosphor-icons/react";

const kindLabels = { video: "Video", audio: "Audio", image: "Photo", article: "Article", document: "Document" };

export function SearchBar({ query, setQuery, onSubmit, navigate, inputRef }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState({ query: "", items: [], status: "idle" });
  const listRef = useRef(null);
  const term = query.trim();
  const expanded = open && Boolean(term);
  const items = result.query === term ? result.items : [];
  const status = result.query === term ? result.status : "loading";

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setResult({ query: term, items: [], status: "loading" });
      try {
        const response = await fetch(`/api/v1/search?q=${encodeURIComponent(term)}&kind=all`, { signal: controller.signal });
        if (!response.ok) throw new Error("Search unavailable");
        const rows = await response.json();
        if (!controller.signal.aborted) {
          setResult({ query: term, items: rows.slice(0, 7), status: "ready" });
          setActive(-1);
        }
      } catch {
        if (!controller.signal.aborted) setResult({ query: term, items: [], status: "error" });
      }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, expanded]);

  useEffect(() => {
    if (active >= 0) listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(index) {
    const item = items[index];
    setOpen(false); setActive(-1); inputRef.current?.blur();
    navigate(item ? item.entityType === "topic" ? `/topic/${encodeURIComponent(item.slug)}` : `/watch/${encodeURIComponent(item.id)}` : `/search?q=${encodeURIComponent(term)}`);
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
      placeholder="Search your library…" aria-label="Search your library" />
    {query ? <button type="button" onClick={() => { setQuery(""); setActive(-1); inputRef.current?.focus(); }} aria-label="Clear search"><X size={18} /></button> : <kbd>⌘ / Ctrl K</kbd>}
    {expanded && <div className="search-suggestions">
      <div className="search-suggestions-heading" role="status">{status === "loading" ? "Searching your library…" : status === "error" ? "Suggestions unavailable. Press Enter to search." : items.length ? "From your library" : "No matches yet. Try another search."}</div>
      <div id={listId} ref={listRef} role="listbox" aria-label="Search suggestions" className="search-suggestions-list">
        {items.map((item, index) => {
          const topic = item.entityType === "topic";
          const picture = topic ? item.avatar_url : item.thumbnail_url;
          return <button type="button" tabIndex={-1} role="option" aria-selected={active === index} id={`${listId}-${index}`} key={`${item.entityType}-${item.id}`} className="search-suggestion" onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
            <span className={`suggestion-image ${topic ? "is-topic" : ""}`}>{topic ? <Tag size={18} /> : <Play size={18} />}{picture && <img src={picture} alt="" onError={event => { event.currentTarget.hidden = true; }} />}</span>
            <span className="suggestion-copy"><strong>{topic ? item.name : item.title}</strong><small>{topic ? "Topic" : kindLabels[item.kind] || "Media"}</small></span><ArrowUpRight size={16} aria-hidden="true" />
          </button>;
        })}
        <button type="button" tabIndex={-1} role="option" aria-selected={active === items.length} id={`${listId}-${items.length}`} className="search-suggestion search-all" onMouseDown={event => event.preventDefault()} onClick={() => choose(items.length)}><MagnifyingGlass size={18} /><span>Search for “{term}”</span><ArrowUpRight size={16} /></button>
      </div>
    </div>}
  </form>;
}
