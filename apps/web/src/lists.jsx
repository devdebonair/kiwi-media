"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarksSimple, CaretDown, Check, CheckSquare, DotsThree, ListPlus, PencilSimple, Plus, Square, Trash, X } from "@phosphor-icons/react";
import { PosterCard } from "./poster-card.jsx";

// Lists: each profile's Watch List (where every + button adds things) and any lists it makes.
// They hold movies, shows, and home videos; an episode is listed as its series.

const KINDS = [["all", "All"], ["movies", "Movies"], ["shows", "TV shows"], ["anime", "Anime"], ["videos", "Home videos"]];
const SORTS = [["added", "Recently added"], ["title", "Title"], ["year", "Newest release"], ["rating", "Rating"]];
const keyOf = item => item.kind === "title" ? `t:${item.title.id}` : `a:${item.asset.id}`;
const refOf = item => item.kind === "title" ? { titleId: item.title.id } : { assetId: item.asset.id };
const nameOf = item => item.kind === "title" ? item.title.title : item.asset.title;
const countFor = (list, kind) => kind === "all" ? list.itemCount : list.counts[kind] || 0;

// Opens a small menu of your lists for one title or video: tick a list to add it there, untick to remove it.
export function ListPicker({ api, item, onChange, className = "outline-button icon-only", label = "Lists" }) {
  const [open, setOpen] = useState(false), [lists, setLists] = useState(null), [name, setName] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const anchor = useRef(null);
  const query = item.titleId ? `titleId=${encodeURIComponent(item.titleId)}` : `assetId=${encodeURIComponent(item.assetId)}`;
  const load = () => api(`/api/v1/lists?${query}`).then(value => { setLists(value.lists); return value.lists; });
  useEffect(() => {
    if (!open) return;
    load().catch(e => setError(e.message));
    const away = event => { if (!anchor.current?.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", onKey); };
  }, [open, query]);
  const after = fresh => onChange?.(fresh.some(list => list.contains));
  const toggle = async list => {
    setBusy(list.id); setError("");
    try {
      await api(`/api/v1/lists/${list.id}/items${list.contains ? "/remove" : ""}`, { method: "POST", body: JSON.stringify(item) });
      after(await load());
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const create = async event => {
    event.preventDefault(); setBusy("new"); setError("");
    try {
      const { list } = await api("/api/v1/lists", { method: "POST", body: JSON.stringify({ name }) });
      await api(`/api/v1/lists/${list.id}/items`, { method: "POST", body: JSON.stringify(item) });
      setName(""); after(await load());
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  return <div className="list-picker" ref={anchor}>
    <button type="button" className={className} onClick={() => setOpen(value => !value)} aria-haspopup="dialog" aria-expanded={open} aria-label="Add to a list" title="Add to a list"><ListPlus size={16} />{label && <span>{label}</span>}<CaretDown size={12} /></button>
    {open && <div className="list-picker-panel" role="dialog" aria-label="Your lists">
      <strong className="list-picker-title">Save to…</strong>
      {lists === null ? <p className="muted">Loading…</p> : <ul>{lists.map(list => <li key={list.id}>
        <label><input type="checkbox" checked={Boolean(list.contains)} disabled={busy !== ""} onChange={() => toggle(list)} /><span>{list.name}</span><small>{list.itemCount}</small></label>
      </li>)}</ul>}
      <form onSubmit={create} className="list-picker-new"><input value={name} onChange={event => setName(event.target.value)} placeholder="New list" maxLength={60} aria-label="New list name" /><button className="icon-button" disabled={!name.trim() || busy !== ""} aria-label="Create list and add"><Plus size={16} /></button></form>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>}
  </div>;
}

export function ListsPage({ api, navigate, AppLink, MediaCard, Loading, Empty, listId }) {
  const [lists, setLists] = useState(null), [data, setData] = useState(null), [error, setError] = useState("");
  const [kind, setKind] = useState("all"), [sort, setSort] = useState("added");
  const [selecting, setSelecting] = useState(false), [selected, setSelected] = useState(() => new Set()), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const [dialog, setDialog] = useState(null), [menu, setMenu] = useState(false), [moveMenu, setMoveMenu] = useState(false);
  const loadLists = () => api("/api/v1/lists").then(value => { setLists(value.lists); return value.lists; });
  useEffect(() => { loadLists().catch(e => setError(e.message)); }, []);
  const current = lists && (lists.find(list => list.id === listId) || (!listId && lists[0]));
  const loadItems = () => current && api(`/api/v1/lists/${current.id}/items?kind=${kind}&sort=${sort}&limit=500`).then(setData).catch(e => setError(e.message));
  useEffect(() => { setData(null); loadItems(); }, [current?.id, kind, sort]);
  useEffect(() => { setSelected(new Set()); setSelecting(false); setNote(""); setKind("all"); }, [current?.id]);
  useEffect(() => { if (lists && listId && !current) navigate("/lists"); }, [lists, listId]);

  const refresh = async () => { await Promise.all([loadLists(), loadItems()]); };
  const run = async (work, message) => {
    setBusy(true); setError(""); setNote("");
    try { await work(); await refresh(); if (message) setNote(message); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const chosen = useMemo(() => (data?.items || []).filter(item => selected.has(keyOf(item))), [data, selected]);
  const toggleOne = item => setSelected(current => { const next = new Set(current); next.has(keyOf(item)) ? next.delete(keyOf(item)) : next.add(keyOf(item)); return next; });
  const allSelected = data?.items.length > 0 && chosen.length === data.items.length;
  const removeItems = items => run(() => api(`/api/v1/lists/${current.id}/items/remove`, { method: "POST", body: JSON.stringify({ items: items.map(refOf) }) }).then(() => setSelected(new Set())),
    `Removed ${items.length === 1 ? nameOf(items[0]) : `${items.length} items`} from ${current.name}`);
  const copyTo = (target, items) => run(() => api(`/api/v1/lists/${target.id}/items`, { method: "POST", body: JSON.stringify({ items: items.map(refOf) }) }).then(() => setMoveMenu(false)),
    `Added ${items.length === 1 ? nameOf(items[0]) : `${items.length} items`} to ${target.name}`);

  if (!lists) return error ? <Empty title="Lists are unavailable" message={error} /> : <Loading />;
  if (!current) return <Loading />;
  const others = lists.filter(list => list.id !== current.id);

  return <div className="content lists-page">
    <div className="section-heading"><div><span className="eyebrow">My List</span><h1>{current.name}</h1>
      <p>{current.system ? "Everything you add with + lands here. Make more lists to sort things your way." : `${current.itemCount} ${current.itemCount === 1 ? "item" : "items"}`}</p></div>
      <div className="lists-heading-actions">
        <button className="outline-button" onClick={() => setDialog({ kind: "create" })}><Plus /> New list</button>
        {!current.system && <div className="menu-anchor">
          <button className="outline-button icon-only" aria-haspopup="menu" aria-expanded={menu} aria-label={`More for ${current.name}`} onClick={() => setMenu(value => !value)}><DotsThree size={20} weight="bold" /></button>
          {menu && <div className="action-menu" role="menu" onMouseLeave={() => setMenu(false)}>
            <button role="menuitem" onClick={() => { setMenu(false); setDialog({ kind: "rename", list: current }); }}><PencilSimple size={16} /> Rename list</button>
            <button role="menuitem" className="danger" onClick={() => { setMenu(false); if (confirm(`Delete “${current.name}”? What's on it stays on your other lists.`)) run(async () => { await api(`/api/v1/lists/${current.id}`, { method: "DELETE" }); navigate("/lists"); }); }}><Trash size={16} /> Delete list</button>
          </div>}
        </div>}
      </div>
    </div>

    <nav className="list-tabs" aria-label="Your lists">{lists.map(list => <AppLink key={list.id} href={list.system ? "/lists" : `/lists/${list.id}`} navigate={navigate} aria-current={list.id === current.id ? "page" : undefined} className={list.id === current.id ? "is-current" : ""}>
      <span className="list-tab-art">{list.previews.length ? list.previews.slice(0, 4).map((src, index) => <img key={index} src={src} alt="" loading="lazy" />) : <BookmarksSimple size={18} />}</span>
      <span className="list-tab-copy"><strong>{list.name}</strong><small>{list.itemCount} {list.itemCount === 1 ? "item" : "items"}</small></span>
    </AppLink>)}</nav>

    <div className="list-toolbar">
      <div className="chips" role="group" aria-label="Show">{KINDS.filter(([key]) => key === "all" || countFor(current, key) > 0 || kind === key).map(([key, label]) =>
        <button key={key} className={kind === key ? "selected" : ""} aria-pressed={kind === key} onClick={() => setKind(key)}>{label}<span className="chip-count">{countFor(current, key)}</span></button>)}</div>
      <div className="list-toolbar-end">
        <label className="list-sort"><span>Sort</span><select value={sort} onChange={event => setSort(event.target.value)}>{SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {data?.items.length > 0 && <button className={selecting ? "primary-button" : "outline-button"} onClick={() => { setSelecting(value => !value); setSelected(new Set()); }}>{selecting ? <><X /> Done</> : <><CheckSquare /> Select</>}</button>}
      </div>
    </div>

    {selecting && <div className="list-selection" role="region" aria-label="Selection">
      <button className="text-button" onClick={() => setSelected(allSelected ? new Set() : new Set(data.items.map(keyOf)))}>{allSelected ? "Clear selection" : "Select all"}</button>
      <span>{chosen.length} selected</span>
      <div className="list-selection-actions">
        {others.length > 0 && <div className="menu-anchor">
          <button className="outline-button" disabled={!chosen.length || busy} aria-haspopup="menu" aria-expanded={moveMenu} onClick={() => setMoveMenu(value => !value)}><ListPlus /> Add to list<CaretDown size={12} /></button>
          {moveMenu && <div className="action-menu" role="menu" onMouseLeave={() => setMoveMenu(false)}>{others.map(list => <button key={list.id} role="menuitem" onClick={() => copyTo(list, chosen)}>{list.name}</button>)}</div>}
        </div>}
        <button className="outline-button danger" disabled={!chosen.length || busy} onClick={() => removeItems(chosen)}><Trash /> Remove</button>
      </div>
    </div>}
    {note && <p className="notice list-note" role="status">{note}</p>}
    {error && <p className="error-notice" role="alert">{error}</p>}

    {!data ? <Loading /> : !data.items.length ? <Empty title={kind === "all" ? `${current.name} is empty` : "Nothing of this kind here"} message={current.system ? "Press + on any movie, show, or anime, or Save on a video, and it shows up here." : "Use “Lists” on a title or video page to add things to this list."} />
      : <div className={`list-grid ${selecting ? "is-selecting" : ""}`}>{data.items.map(item => {
        const key = keyOf(item), isSelected = selected.has(key);
        return <div key={key} className={`list-item ${item.kind === "asset" ? "is-video" : ""} ${isSelected ? "is-selected" : ""}`}>
          {item.kind === "title" ? <PosterCard item={item.title} AppLink={AppLink} navigate={navigate} /> : <MediaCard asset={item.asset} navigate={navigate} />}
          {selecting
            ? <button className="list-item-select" onClick={() => toggleOne(item)} aria-pressed={isSelected} aria-label={`${isSelected ? "Deselect" : "Select"} ${nameOf(item)}`}>{isSelected ? <CheckSquare size={22} weight="fill" /> : <Square size={22} />}</button>
            : <button className="list-item-remove" disabled={busy} onClick={() => removeItems([item])} aria-label={`Remove ${nameOf(item)} from ${current.name}`} title={`Remove from ${current.name}`}><X size={14} weight="bold" /></button>}
        </div>;
      })}</div>}

    {dialog && <ListNameDialog title={dialog.kind === "create" ? "New list" : "Rename list"} initial={dialog.list?.name || ""} close={() => setDialog(null)}
      submit={async name => {
        if (dialog.kind === "create") { const { list } = await api("/api/v1/lists", { method: "POST", body: JSON.stringify({ name }) }); await loadLists(); setDialog(null); navigate(`/lists/${list.id}`); }
        else { await api(`/api/v1/lists/${dialog.list.id}`, { method: "PATCH", body: JSON.stringify({ name }) }); await loadLists(); setDialog(null); }
      }} />}
  </div>;
}

function ListNameDialog({ title, initial, close, submit }) {
  const [name, setName] = useState(initial), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  return <div className="dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog-head"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close"><X /></button></div>
      <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { await submit(name); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>
        <label>Name<input autoFocus value={name} maxLength={60} onChange={event => setName(event.target.value)} placeholder="Weekend movies" /></label>
        {error && <p className="field-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy || !name.trim()}><Check /> {title === "New list" ? "Create list" : "Save"}</button>
      </form>
    </div>
  </div>;
}
