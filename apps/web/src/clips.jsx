"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, PencilSimple, Play, Repeat, Scissors, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";
import { clipLength, clipTime, laneClips, moveEdge, newRange, timeAt, trackLeft } from "./clip-range.mjs";

// Clips are tags on a time range of a video ("virtual clips"). They are authored on the player's timeline:
// open a draft at the playhead, drag its edges (or press I and O), tag it, and save. Nothing is cut or copied.

export function useClips({ assetId, api, enabled = true }) {
  const [clips, setClips] = useState([]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // A range being played on its own (a saved clip, or a draft preview); playback pauses at its end.
  const [playing, setPlaying] = useState(null);

  useEffect(() => {
    setClips([]); setDraft(null); setPlaying(null); setError("");
    if (!enabled) return;
    let active = true;
    api(`/api/v1/assets/${assetId}/clips`).then(rows => { if (active) setClips(rows); }).catch(() => {});
    return () => { active = false; };
  }, [assetId, api, enabled]);

  const open = useCallback((positionMs, totalMs, options) => { setError(""); setDraft({ ...newRange(positionMs, totalMs, options), title: "", topics: [] }); }, []);
  const edit = useCallback(clip => { setError(""); setDraft({ id: clip.id, startMs: clip.startMs, endMs: clip.endMs, title: clip.title, topics: clip.topics }); }, []);
  const change = useCallback(patch => setDraft(current => current && { ...current, ...patch }), []);
  const cancel = useCallback(() => { setDraft(null); setError(""); setPlaying(current => current?.preview ? null : current); }, []);
  const play = useCallback((range, { preview = false, seek = true } = {}) => setPlaying({ startMs: range.startMs, endMs: range.endMs, id: range.id, preview, seek, token: Date.now() }), []);
  const stopPlaying = useCallback(() => setPlaying(null), []);

  const save = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true); setError("");
    const body = { startMs: Math.round(draft.startMs), endMs: Math.round(draft.endMs), title: draft.title.trim(), topics: draft.topics.map(topic => topic.id ? { topicId: topic.id } : { name: topic.name }) };
    try {
      const clip = draft.id
        ? await api(`/api/v1/clips/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api(`/api/v1/assets/${assetId}/clips`, { method: "POST", body: JSON.stringify(body) });
      setClips(current => [...current.filter(item => item.id !== clip.id), clip].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs));
      setDraft(null);
      setPlaying(current => current?.preview ? null : current);
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }, [draft, saving, api, assetId]);

  const remove = useCallback(async clip => {
    setError("");
    try {
      await api(`/api/v1/clips/${clip.id}`, { method: "DELETE" });
      setClips(current => current.filter(item => item.id !== clip.id));
      setDraft(current => current?.id === clip.id ? null : current);
    } catch (failure) { setError(failure.message); }
  }, [api]);

  return { clips, draft, saving, error, playing, open, edit, change, cancel, save, remove, play, stopPlaying };
}

// Saved clips as bars under the seek track, and the draft as a highlighted range with draggable edges.
export function ClipTimeline({ tools, totalMs, onScrub, onPlayClip }) {
  const frame = useRef(null);
  const drag = useRef(null);
  const { clips, draft } = tools;
  if (!totalMs) return null;
  const start = edge => event => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = edge;
  };
  const move = event => {
    if (!drag.current || !frame.current) return;
    const value = timeAt(event.clientX, frame.current.getBoundingClientRect(), totalMs);
    const next = moveEdge(tools.draft, drag.current, value, totalMs);
    tools.change(next);
    onScrub(drag.current === "start" ? next.startMs : next.endMs, false);
  };
  const end = event => {
    if (!drag.current) return;
    const next = tools.draft;
    onScrub(drag.current === "start" ? next.startMs : next.endMs, true);
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const nudge = edge => event => {
    const step = event.shiftKey ? 5000 : event.altKey ? 100 : 1000;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const next = moveEdge(draft, edge, (edge === "start" ? draft.startMs : draft.endMs) + delta, totalMs);
    tools.change(next);
    onScrub(edge === "start" ? next.startMs : next.endMs, true);
  };
  return <div className="clip-timeline" ref={frame}>
    {clips.length > 0 && <div className="clip-lanes" aria-label="Clips on this video">
      {laneClips(clips.filter(clip => clip.id !== draft?.id)).map(({ clip, lane }) => <button key={clip.id} type="button" className="clip-bar" style={{ left: trackLeft(clip.startMs, totalMs), width: `calc((100% - 12px) * ${(clip.endMs - clip.startMs) / totalMs})`, "--lane": lane }}
        title={`${clip.title || "Clip"} · ${clipTime(clip.startMs, { tenths: false })}–${clipTime(clip.endMs, { tenths: false })}${clip.topics.length ? ` · ${clip.topics.map(topic => topic.name).join(", ")}` : ""}`}
        aria-label={`Play clip ${clip.title || clip.topics.map(topic => topic.name).join(", ") || ""} from ${clipTime(clip.startMs, { tenths: false })}`} onClick={() => onPlayClip(clip)} />)}
    </div>}
    {draft && <div className="clip-draft" style={{ left: trackLeft(draft.startMs, totalMs), width: `calc((100% - 12px) * ${(draft.endMs - draft.startMs) / totalMs})` }}>
      <span role="slider" tabIndex={0} aria-label="Clip start" aria-valuemin={0} aria-valuemax={totalMs} aria-valuenow={Math.round(draft.startMs)} aria-valuetext={clipTime(draft.startMs)} className="clip-handle start"
        onPointerDown={start("start")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={nudge("start")} />
      <span role="slider" tabIndex={0} aria-label="Clip end" aria-valuemin={0} aria-valuemax={totalMs} aria-valuenow={Math.round(draft.endMs)} aria-valuetext={clipTime(draft.endMs)} className="clip-handle end"
        onPointerDown={start("end")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={nudge("end")} />
    </div>}
  </div>;
}

// The draft's details under the controls: exact in and out points, a name, tags, and save.
export function ClipEditor({ tools, api, positionMs, totalMs, onSeek, onPreview }) {
  const { draft, saving, error } = tools;
  const titleRef = useRef(null);
  const valid = draft && draft.endMs - draft.startMs >= 1000;
  const set = edge => () => { tools.change(moveEdge(draft, edge, positionMs, totalMs)); };
  const step = (edge, delta) => () => {
    const next = moveEdge(draft, edge, (edge === "start" ? draft.startMs : draft.endMs) + delta, totalMs);
    tools.change(next);
    onSeek(edge === "start" ? next.startMs : next.endMs);
  };
  const edgeControl = (edge, label) => <div className="clip-edge">
    <span>{label}</span>
    <button type="button" className="clip-time" onClick={() => onSeek(edge === "start" ? draft.startMs : draft.endMs)} title={`Jump to the ${label.toLowerCase()} point`}>{clipTime(edge === "start" ? draft.startMs : draft.endMs)}</button>
    <span className="clip-steps">
      <button type="button" onClick={step(edge, -1000)} aria-label={`${label} one second earlier`}>−1s</button>
      <button type="button" onClick={step(edge, 1000)} aria-label={`${label} one second later`}>+1s</button>
    </span>
    <button type="button" className="clip-set" onClick={set(edge)} title={`Set the ${label.toLowerCase()} point to the playhead (${edge === "start" ? "I" : "O"})`}>Set to {clipTime(positionMs, { tenths: false })}</button>
  </div>;
  return <form className="clip-editor" aria-label={draft.id ? "Edit clip" : "New clip"} onSubmit={event => { event.preventDefault(); if (valid) tools.save(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); tools.cancel(); } }}>
    <div className="clip-editor-head">
      <strong><Scissors size={16} /> {draft.id ? "Edit clip" : "New clip"}</strong>
      <span className="clip-duration">{clipLength(draft.endMs - draft.startMs)}</span>
      <small>Drag the green edges, or press <kbd>I</kbd> and <kbd>O</kbd> at the playhead.</small>
      <button type="button" className="icon-button" onClick={tools.cancel} aria-label="Close without saving"><X size={16} /></button>
    </div>
    <div className="clip-edges">{edgeControl("start", "In")}{edgeControl("end", "Out")}</div>
    <div className="clip-details">
      <input ref={titleRef} className="clip-title" value={draft.title} maxLength={200} placeholder="Name this clip (optional)" aria-label="Clip name" onChange={event => tools.change({ title: event.target.value })} />
      <div className="clip-tags">
        {draft.topics.map(topic => <span key={topic.id || topic.name} className="clip-tag"><TopicLabel topic={topic} /><button type="button" aria-label={`Remove ${topic.name}`} onClick={() => tools.change({ topics: draft.topics.filter(item => item !== topic) })}><X size={11} /></button></span>)}
        <AddTag asset={{ id: `clip-${draft.id || "new"}`, title: draft.title || "this clip", topics: draft.topics.filter(topic => topic.id) }} api={api} label="Tag clip"
          onPick={topic => { if (!draft.topics.some(item => (topic.id && item.id === topic.id) || item.name.toLowerCase() === topic.name.toLowerCase())) tools.change({ topics: [...draft.topics, topic.create ? { name: topic.name } : topic] }); }} />
      </div>
    </div>
    {error && <p className="clip-error" role="alert">{error}</p>}
    <div className="clip-actions">
      <button type="button" className="outline-button" onClick={onPreview}><Play size={15} weight="fill" /> Preview</button>
      {draft.id && <button type="button" className="outline-button danger" onClick={() => tools.remove(draft)}><Trash size={15} /> Delete</button>}
      <span className="clip-spacer" />
      <button type="button" className="outline-button" onClick={tools.cancel}>Cancel</button>
      <button className="primary-button" disabled={!valid || saving}>{saving ? <SpinnerGap size={15} className="spin" /> : <Check size={15} weight="bold" />}{draft.id ? "Save changes" : "Save clip"}</button>
    </div>
  </form>;
}

// Clips under the video: play one on its own, or open it in the editor.
export function ClipList({ tools, AppLink, navigate, onPlay, readOnly = false }) {
  const { clips, draft, playing } = tools;
  if (!clips.length) return null;
  return <section className="clip-list" aria-label="Clips">
    <h2><Scissors size={18} /> Clips <span>{clips.length}</span></h2>
    <ol>{clips.map(clip => <li key={clip.id} className={`${playing?.id === clip.id ? "is-playing" : ""} ${draft?.id === clip.id ? "is-editing" : ""}`}>
      <button type="button" className="clip-play" onClick={() => onPlay(clip)} aria-label={`Play clip from ${clipTime(clip.startMs, { tenths: false })} to ${clipTime(clip.endMs, { tenths: false })}`}>
        <span className="clip-range-chip">{playing?.id === clip.id ? <Repeat size={13} /> : <Play size={12} weight="fill" />}{clipTime(clip.startMs, { tenths: false })}–{clipTime(clip.endMs, { tenths: false })}</span>
        <span className="clip-copy"><strong>{clip.title || (clip.topics.length ? clip.topics.map(topic => topic.name).join(" · ") : "Untitled clip")}</strong><small>{clipLength(clip.endMs - clip.startMs)}</small></span>
      </button>
      <div className="clip-row-tags">{clip.topics.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate}><TopicLabel topic={topic} /></AppLink>)}</div>
      {!readOnly && <span className="clip-row-actions">
        <button type="button" className="icon-button" onClick={() => tools.edit(clip)} aria-label="Edit clip" title="Edit"><PencilSimple size={16} /></button>
        <button type="button" className="icon-button" onClick={() => confirm("Delete this clip? Its tags stay on everything else.") && tools.remove(clip)} aria-label="Delete clip" title="Delete"><Trash size={16} /></button>
      </span>}
    </li>)}</ol>
  </section>;
}

// A clip elsewhere in the app (topic pages, and later a clips feed): opens the video at the clip and stops at its end.
export function ClipCard({ clip, AppLink, navigate }) {
  const href = clipHref(clip);
  return <article className="clip-card">
    <AppLink href={href} navigate={navigate} className="clip-card-art" aria-label={`Play clip ${clip.title || ""} from ${clip.asset.title}`}>
      {clip.asset.thumbnail_url ? <img src={clip.asset.thumbnail_url} alt="" loading="lazy" /> : <span className="thumb-empty"><Scissors size={32} /></span>}
      <span className="clip-card-range"><Scissors size={12} />{clipTime(clip.startMs, { tenths: false })} · {clipLength(clip.endMs - clip.startMs)}</span>
    </AppLink>
    <AppLink href={href} navigate={navigate}><h3>{clip.title || clip.topics.map(topic => topic.name).join(" · ") || "Untitled clip"}</h3></AppLink>
    <p>{clip.asset.title}</p>
  </article>;
}

export const clipHref = clip => `/watch/${clip.assetId}?t=${Math.floor(clip.startMs / 1000)}&clip=${clip.id}`;

// A clip in search results: where it comes from, its range, and its tags.
export function ClipResult({ clip, AppLink, navigate }) {
  const href = clipHref(clip);
  return <article className="result-card clip-result">
    <AppLink href={href} navigate={navigate} className="clip-card-art" aria-label={`Play clip from ${clip.asset.title}`}>
      {clip.asset.thumbnail_url ? <img src={clip.asset.thumbnail_url} alt="" loading="lazy" /> : <span className="thumb-empty"><Scissors size={32} /></span>}
      <span className="clip-card-range"><Scissors size={12} />{clipTime(clip.startMs, { tenths: false })}–{clipTime(clip.endMs, { tenths: false })}</span>
    </AppLink>
    <div>
      <AppLink href={href} navigate={navigate}><span className="eyebrow">Clip · {clipLength(clip.endMs - clip.startMs)}</span><h2>{clip.title || clip.topics.map(topic => topic.name).join(" · ") || "Untitled clip"}</h2></AppLink>
      <p>From {clip.asset.title}</p>
      {clip.topics.length > 0 && <div className="clip-row-tags">{clip.topics.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate}><TopicLabel topic={topic} /></AppLink>)}</div>}
    </div>
  </article>;
}
