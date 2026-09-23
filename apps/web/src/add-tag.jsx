"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, MagnifyingGlass, Plus, Tag } from "@phosphor-icons/react";

export function AddTag({ asset, api, onChange, endpoint = `/api/v1/assets/${asset.id}/topics` }) {
  const panel = useRef(null), trigger = useRef(null), input = useRef(null), busy = useRef(false);
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [topics, setTopics] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const name = query.trim();
  const matching = topics.filter(topic => topic.name.toLowerCase().includes(name.toLowerCase()));
  const options = loaded ? [...matching] : [];
  if (loaded && name && !topics.some(topic => topic.name.toLowerCase() === name.toLowerCase())) options.push({ name, create: true });
  const active = Math.min(selected, Math.max(0, options.length - 1));
  const attached = topic => asset.topics?.some(item => item.id === topic.id);
  const close = () => { panel.current?.hidePopover(); };

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true); setLoaded(false); setError("");
    input.current?.focus();
    api("/api/v1/topics").then(rows => { if (current) { setTopics(rows); setLoaded(true); } })
      .catch(e => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    const position = () => {
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 24);
      const height = Math.min(360, window.innerHeight - 24);
      Object.assign(panel.current.style, {
        left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
        top: `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12))}px`,
      });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { current = false; window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, api]);

  useEffect(() => {
    if (open) document.getElementById(`${uid}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, uid, query]);

  const add = async topic => {
    if (!topic || attached(topic) || busy.current || loading) return;
    busy.current = true; setSaving(true); setError("");
    try {
      const value = await api(endpoint, {
        method: "POST", body: JSON.stringify(topic.create ? { name: topic.name } : { topicId: topic.id }),
      });
      onChange(value.topics); close(); trigger.current?.focus();
    } catch (e) { setError(e.message); }
    finally { busy.current = false; setSaving(false); }
  };

  return <div className="add-tag">
    <button ref={trigger} className="add-tag-trigger" onClick={() => { if (!open) { setQuery(""); setSelected(0); setLoaded(false); setLoading(true); } }} popoverTarget={`${uid}-panel`} aria-expanded={open} aria-haspopup="dialog"><Plus size={16}/>Add tag</button>
    <div ref={panel} id={`${uid}-panel`} popover="auto" role="dialog" aria-label="Add tag" className="tag-popover" onToggle={event => setOpen(event.newState === "open")}>
      <div className="tag-search-field"><MagnifyingGlass size={18} aria-hidden="true"/>
      <input ref={input} className="tag-search" role="combobox" aria-label="Find or create a tag" placeholder="Find or create a tag…" maxLength={100} autoComplete="off" aria-expanded={open} aria-controls={`${uid}-list`} aria-autocomplete="list" aria-activedescendant={!loading && options.length ? `${uid}-option-${active}` : undefined} disabled={saving} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected(options.length ? (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length : 0); }
        if (event.key === "Enter") { event.preventDefault(); add(options[active]); }
      }}/></div>
      <div id={`${uid}-list`} role="listbox" aria-label="Tags" aria-busy={loading || saving} className="tag-options">
        {!loading && options.map((topic, index) => <div key={topic.id || "create"} id={`${uid}-option-${index}`} role="option" aria-selected={index === active} aria-disabled={attached(topic) || saving} className={`tag-option ${index === active ? "is-selected" : ""}`} onMouseEnter={() => setSelected(index)} onMouseDown={event => event.preventDefault()} onClick={() => add(topic)}>
          <span className="tag-avatar">{topic.avatar_url ? <img src={topic.avatar_url} alt="" onError={event => { event.currentTarget.hidden = true; }}/> : topic.create ? <Plus size={18}/> : <Tag size={18}/>}</span>
          <span className="tag-option-name">{topic.create ? `Create “${topic.name}”` : topic.name}</span>{attached(topic) && <Check size={16} aria-label="Already added"/>}
        </div>)}
        {error && <p className="tag-empty tag-error" role="alert">{error}</p>}
        {saving && <p className="tag-empty" role="status">Adding tag…</p>}
        {loading && <p className="tag-empty" role="status">Loading tags…</p>}
        {!loading && !error && !options.length && <p className="tag-empty">Type a name to create your first tag.</p>}
      </div>
    </div>
  </div>;
}
