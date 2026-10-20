"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, MagnifyingGlass, Tag, Trash, X } from "@phosphor-icons/react";
import { Modal } from "./modal.jsx";
import { TopicLabel } from "./topic-label.jsx";

const MAX_TOPICS = 20;

// Create or edit a channel that airs every video matching a combination of tags.
export function ChannelEditor({ api, channel, close, onSaved, onDeleted }) {
  const [topics, setTopics] = useState(null);
  const [picked, setPicked] = useState(channel?.topics || []);
  const [match, setMatch] = useState(channel?.match || "all");
  const [name, setName] = useState(channel?.name || "");
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api("/api/v1/topics").then(setTopics).catch(e => setError(e.message)); }, [api]);
  useEffect(() => {
    setCount(null);
    if (!picked.length) return;
    let active = true;
    const timer = setTimeout(() => api(`/api/v1/guide/count?match=${match}&topics=${picked.map(topic => topic.id).join(",")}`)
      .then(value => { if (active) setCount(value.item_count); }).catch(() => {}), 200);
    return () => { active = false; clearTimeout(timer); };
  }, [picked, match, api]);

  const pickedIds = new Set(picked.map(topic => topic.id));
  const options = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (topics || []).filter(topic => !term || topic.name.toLowerCase().includes(term)).slice(0, 150);
  }, [topics, search]);
  const suggested = picked.map(topic => topic.name).join(match === "all" ? " + " : " or ").slice(0, 60);
  const toggle = topic => setPicked(list => pickedIds.has(topic.id) ? list.filter(item => item.id !== topic.id)
    : list.length < MAX_TOPICS ? [...list, topic] : list);

  const save = async event => {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      const body = JSON.stringify({ name: name.trim() || suggested, match, topicIds: picked.map(topic => topic.id) });
      const saved = await api(channel ? `/api/v1/guide/channels/${channel.id}` : "/api/v1/guide/channels", { method: channel ? "PUT" : "POST", body });
      onSaved(saved);
    } catch (e) { setError(e.message); setSaving(false); }
  };
  const remove = async () => {
    setSaving(true); setError("");
    try {
      await api(`/api/v1/guide/channels/${channel.id}`, { method: "DELETE" });
      onDeleted(channel);
    } catch (e) { setError(e.message); setSaving(false); }
  };

  return <Modal title={channel ? `Edit channel ${channel.number}` : "New channel"} close={close} className="channel-editor">
    <form onSubmit={save}>
      <label>Channel name<input value={name} maxLength={60} placeholder={suggested || "Name your channel"} onChange={event => setName(event.target.value)} /></label>

      <fieldset className="channel-match">
        <legend>Air videos that have</legend>
        <div role="radiogroup" aria-label="Match tags">
          {[["all", "All of these tags"], ["any", "Any of these tags"]].map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={match === value} className={match === value ? "selected" : ""} onClick={() => setMatch(value)}>{label}</button>)}
        </div>
      </fieldset>

      <div className="channel-picked" aria-live="polite">
        {picked.length ? <div className="chips folder-tags">{picked.map(topic => <button key={topic.id} type="button" className="selected" onClick={() => toggle(topic)} aria-label={`Remove ${topic.name}`}><TopicLabel topic={topic} /><X size={14} /></button>)}</div>
          : <p className="muted">Pick one or more tags below.</p>}
        {picked.length > 0 && <p className="channel-count">{count === null ? "Counting videos…" : count ? `${count.toLocaleString()} ${count === 1 ? "video" : "videos"} will air on this channel` : match === "all" ? "No videos have all of these tags yet" : "No videos have these tags yet"}</p>}
      </div>

      <div className="tag-search-field"><MagnifyingGlass size={18} aria-hidden="true" />
        <input className="tag-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find tags…" aria-label="Find tags" autoComplete="off" />
      </div>
      <div className="channel-tag-list" role="listbox" aria-multiselectable="true" aria-label="Tags" aria-busy={!topics}>
        {!topics ? <p className="tag-empty">Loading tags…</p> : !options.length ? <p className="tag-empty">No tags match “{search}”.</p>
          : options.map(topic => <div key={topic.id} role="option" aria-selected={pickedIds.has(topic.id)} tabIndex={0} className={`tag-option ${pickedIds.has(topic.id) ? "is-picked" : ""}`} onClick={() => toggle(topic)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(topic); } }}>
            <span className="tag-avatar">{topic.avatar_url ? <img src={topic.avatar_url} alt="" onError={event => { event.currentTarget.hidden = true; }} /> : <Tag size={18} />}</span>
            <span className="tag-option-name">{topic.name}</span>
            <span className="channel-tag-count">{topic.item_count.toLocaleString()}</span>
            <span className="channel-tag-check" aria-hidden="true">{pickedIds.has(topic.id) && <Check size={14} weight="bold" />}</span>
          </div>)}
      </div>

      {error && <p className="tag-error" role="alert">{error}</p>}
      <div className="channel-editor-actions">
        {channel && (confirmDelete
          ? <span className="channel-delete-confirm">Delete this channel? <button type="button" className="outline-button danger" disabled={saving} onClick={remove}>Delete</button><button type="button" className="outline-button" onClick={() => setConfirmDelete(false)}>Keep</button></span>
          : <button type="button" className="outline-button" onClick={() => setConfirmDelete(true)}><Trash size={16} /> Delete</button>)}
        <button type="button" className="outline-button" onClick={close}>Cancel</button>
        <button className="primary-button" disabled={saving || !picked.length}>{saving ? "Saving…" : channel ? "Save channel" : "Create channel"}</button>
      </div>
    </form>
  </Modal>;
}
