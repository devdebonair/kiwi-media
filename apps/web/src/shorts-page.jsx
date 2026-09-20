"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Gear, Play, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { LikeButton, ViewCount, usePlaybackTracking } from "./engagement.jsx";

function Short({ initial, active, api, navigate }) {
  const [asset, setAsset] = useState(initial);
  const [error, setError] = useState("");
  const mediaRef = useRef(null);
  const [paused, setPaused] = useState(true), [muted, setMuted] = useState(true), [progress, setProgress] = useState(0);
  usePlaybackTracking({ id: asset.id, ready: true, mediaRef, api, onChange: values => setAsset(a => ({ ...a, ...values })) });
  useEffect(() => {
    const media = mediaRef.current;
    if (active && !document.hidden) media.play().catch(() => {});
    else media.pause();
    const visibility = () => { if (document.hidden) media.pause(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { media.pause(); document.removeEventListener("visibilitychange", visibility); };
  }, [active]);
  return <article className="short-item" aria-label={asset.title}>
    <video ref={mediaRef} src={`/api/v1/assets/${asset.id}/file`} poster={asset.thumbnail_url} muted={muted} loop playsInline onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onTimeUpdate={e => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration * 100 : 0)} preload={active ? "auto" : "none"} onError={() => setError("This video could not play. Open it to download the original.")} />
    <button className="short-play-toggle" aria-label={paused ? "Play video" : "Pause video"} onClick={() => { const video = mediaRef.current; if (video.paused) video.play().catch(() => setError("Tap play to try again.")); else video.pause(); }}>{paused && <Play size={58} weight="fill" />}</button>
    <button className="short-sound" aria-label={muted ? "Unmute video" : "Mute video"} onClick={() => setMuted(value => !value)}>{muted ? <SpeakerSlash size={24} /> : <SpeakerHigh size={24} />}</button>
    <div className="short-info"><div><button className="short-title" onClick={() => navigate(`/watch/${asset.id}`)}>{asset.title}</button><ViewCount count={asset.view_count} /></div><LikeButton asset={asset} api={api} onChange={values => setAsset(a => ({ ...a, ...values }))} /></div>
    <input className="short-progress" type="range" min="0" max="100" step="0.1" value={progress} aria-label="Video progress" onChange={e => { const video = mediaRef.current; if (Number.isFinite(video.duration)) video.currentTime = Number(e.target.value) / 100 * video.duration; }} />
    {error && <p className="short-playback-error" role="alert">{error}</p>}
  </article>;
}

export function ShortsPage({ api, navigate }) {
  const [limit, setLimit] = useState(null), [draft, setDraft] = useState(90);
  const [assets, setAssets] = useState([]), [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false), [more, setMore] = useState(false), [error, setError] = useState("");
  const [saving, setSaving] = useState(false), [settingsOpen, setSettingsOpen] = useState(false);
  const root = useRef(null), pending = useRef(false), generation = useRef(0);
  useEffect(() => { let live = true; api("/api/v1/settings").then(s => { if (live) { setLimit(s.shortsMaxSeconds); setDraft(s.shortsMaxSeconds); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; generation.current++; }; }, [api]);
  async function load(offset, version = generation.current) {
    if (pending.current) return;
    pending.current = true; setLoading(true); setError("");
    try {
      const rows = await api(`/api/v1/shorts?limit=20&offset=${offset}`);
      if (version !== generation.current) return;
      setAssets(previous => offset ? [...previous, ...rows] : rows); setMore(rows.length === 20);
    } catch (e) { if (version === generation.current) setError(e.message); }
    finally { pending.current = false; setLoading(false); }
  }
  useEffect(() => { if (limit !== null) { setAssets([]); setActive(0); root.current?.scrollTo(0, 0); load(0); } }, [limit]);
  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= .65) {
        const index = Number(entry.target.dataset.index); setActive(index);
      }
    }, { root: root.current, threshold: .65 });
    root.current.querySelectorAll("[data-index]").forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [assets.length]);
  useEffect(() => { if (more && active >= assets.length - 3 && !loading && !error) load(assets.length); }, [active, more, assets.length, loading, error]);
  async function save(e) {
    e.preventDefault(); setSaving(true); setError("");
    try {
      const result = await api("/api/v1/settings", { method: "PUT", body: JSON.stringify({ shortsMaxSeconds: Number(draft) }) });
      setLimit(result.shortsMaxSeconds); setSettingsOpen(false);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  return <div className="shorts-page">
    <div className="shorts-heading"><button className="shorts-icon" aria-label="Exit Shorts" onClick={() => navigate("/")}><ArrowLeft size={24}/></button><h1>Shorts</h1><button className="shorts-icon" aria-label="Shorts settings" aria-expanded={settingsOpen} aria-controls="shorts-settings" onClick={() => setSettingsOpen(open => !open)}><Gear size={24}/></button></div>
      {settingsOpen && <form id="shorts-settings" className="shorts-settings" onSubmit={save}><label htmlFor="shorts-duration">Under</label><input id="shorts-duration" type="number" min="1" max="3600" required value={draft} onChange={e => setDraft(e.target.value)} /><span>seconds</span><button className="outline-button" disabled={saving || loading || limit === null}>{saving ? "Saving…" : "Apply"}</button></form>}
    {error && <div className="shorts-error" role="alert">{error} <button onClick={() => limit === null ? location.reload() : load(assets.length)}>Retry</button></div>}
    <div className="shorts-feed" ref={root} tabIndex={0} aria-label="Short videos" onKeyDown={e => {
      if (e.target !== e.currentTarget || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
      e.preventDefault(); root.current.children[Math.max(0, Math.min(assets.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)))]?.scrollIntoView({ block: "nearest" });
    }}>
      {assets.map((asset, index) => <div className="short-slide" data-index={index} key={asset.id}><Short initial={asset} active={index === active} api={api} navigate={navigate} /></div>)}
      {!assets.length && !loading && limit !== null && !error && <div className="empty"><h2>No shorts yet</h2><p>No videos under {limit} seconds. Change the limit or scan more videos.</p></div>}
      {loading && <p role="status">Loading shorts…</p>}
      {more && <button className="outline-button" disabled={loading} onClick={() => load(assets.length)}>Load more</button>}
    </div>
  </div>;
}
