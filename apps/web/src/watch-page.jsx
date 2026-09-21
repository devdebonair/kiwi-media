"use client";

import { TopicLabel } from "./topic-label.jsx";
import { useEffect, useRef, useState } from "react";
import { BookmarkSimple, CaretLeft, DownloadSimple } from "@phosphor-icons/react";
import { LikeButton, ViewCount, usePlaybackTracking } from "./engagement.jsx";
import { resumeSeconds } from "./playback-progress.mjs";

export function WatchPage({ id, navigate, api, AppLink, MediaCard, Loading, formatDuration }) {
  const [asset, setAsset] = useState(null);
  const [related, setRelated] = useState([]);
  const [error, setError] = useState("");
  const [playbackError, setPlaybackError] = useState(false);
  const [saving, setSaving] = useState(false);
  const mediaRef = useRef(null);

  useEffect(() => {
    let active = true;
    setAsset(null); setError(""); setPlaybackError(false);
    api(`/api/v1/assets/${id}`).then(value => {
      if (!active) return;
      setAsset(value);
      const topic = value.topics?.[0];
      api(`/api/v1/assets?limit=9${topic ? `&topic=${encodeURIComponent(topic.slug)}` : ""}`)
        .then(rows => { if (active) setRelated(rows.filter(row => row.id !== id).slice(0, 8)); })
        .catch(() => {});
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id, api]);

  usePlaybackTracking({
    id,
    initialSeconds: resumeSeconds(asset, typeof window === "undefined" ? null : new URLSearchParams(location.search).get("t")),
    ready: Boolean(asset), mediaRef, api,
    onChange: values => setAsset(current => ({ ...current, ...values })),
    still: Boolean(asset && !["video", "audio"].includes(asset.kind)),
  });

  if (!asset) return error ? <div className="content"><p role="alert">{error}</p><button className="outline-button" onClick={() => navigate("/")}>Back to library</button></div> : <Loading />;
  const hasFile = Boolean(asset.file_path);
  const src = `/api/v1/assets/${asset.id}/file`;
  const save = async () => {
    setSaving(true); setError("");
    try {
      const value = await api(`/api/v1/assets/${asset.id}/save`, { method: "POST" });
      setAsset(current => ({ ...current, saved: value.saved }));
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return <div className="content watch-page">
    <button className="back-button" onClick={() => history.length > 1 ? history.back() : navigate("/")}><CaretLeft size={17} /> Back to browsing</button>
    <div className={`watch-layout ${related.length ? "" : "without-related"}`}>
      <div className="watch-primary">
        <div className="player-shell">
          {hasFile && asset.kind === "video" ? <video ref={mediaRef} src={src} poster={asset.thumbnail_url} controls autoPlay playsInline onError={() => setPlaybackError(true)} />
            : hasFile && asset.kind === "audio" ? <div className="audio-player">{asset.thumbnail_url && <img src={asset.thumbnail_url} alt="" />}<audio ref={mediaRef} src={src} controls autoPlay onError={() => setPlaybackError(true)} /></div>
            : <div className="poster-player">{(asset.kind === "image" && hasFile) || asset.thumbnail_url ? <img src={asset.kind === "image" && hasFile ? src : asset.thumbnail_url} alt={asset.title} /> : <div className="media-unavailable">No preview available</div>}{hasFile && asset.kind !== "image" && <a className="outline-button original-link" href={src} download><DownloadSimple size={18} /> Open original</a>}</div>}
        </div>
        {playbackError && <p className="error-notice" role="alert">This media could not play in this browser. <a href={src} download>Download the original</a> to play it in another player.</p>}
        <section className="watch-info">
          <h1>{asset.title}</h1>
          <div className="watch-toolbar"><ViewCount count={asset.view_count} /><div className="watch-actions"><LikeButton asset={asset} api={api} onChange={values => setAsset(current => ({ ...current, ...values }))} /><button className={asset.saved ? "primary-button" : "outline-button"} disabled={saving} onClick={save}><BookmarkSimple weight={asset.saved ? "fill" : "regular"} />{asset.saved ? "Saved" : "Save"}</button></div></div>
          {error && <p role="alert">{error}</p>}
        </section>
        {(asset.description || asset.topics?.length > 0) && <section className="watch-description">
          {asset.topics?.length > 0 && <div className="watch-topics">{asset.topics.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate}><TopicLabel topic={topic} /></AppLink>)}</div>}
          {asset.description && <p>{asset.description}</p>}
        </section>}
        {asset.moments?.length > 0 && <section className="moments"><h2>Notable moments</h2>{asset.moments.map((moment, index) => <button key={index} onClick={() => { if (mediaRef.current) { mediaRef.current.currentTime = moment.start_ms / 1000; mediaRef.current.play().catch(() => {}); } }}><span>{formatDuration(moment.start_ms)}</span><div><strong>{moment.topic || "Moment"}</strong><p>{moment.note_markdown}</p></div></button>)}</section>}
      </div>
      {related.length > 0 && <aside className="watch-related" aria-label="More to explore"><div className="related-media">{related.map(item => <MediaCard key={item.id} asset={item} navigate={navigate} />)}</div></aside>}
    </div>
  </div>;
}
