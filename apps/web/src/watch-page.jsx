"use client";

import { usePlaylist, PlaylistQueue } from "./playlist.jsx";
import { playlistReducer } from "./playlist-state.mjs";
import { VideoPlayer } from "./video-player.jsx";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";
import { useEffect, useRef, useState } from "react";
import { BookmarkSimple, DownloadSimple, ArrowsOutSimple, X } from "@phosphor-icons/react";
import { LikeButton, ViewCount, usePlaybackTracking } from "./engagement.jsx";
import { resumeSeconds } from "./playback-progress.mjs";

// Matches the `max-width: 860px` block in modern.css where the watch layout collapses to one column.
const STACKED_WATCH_QUERY = "(max-width: 860px)";

export function WatchPage({ id, navigate, api, AppLink, MediaCard, Loading, formatDuration, mini = false, suspended = false }) {
  const playlist = usePlaylist();
  const [initialSeconds, setInitialSeconds] = useState(0);
  const [asset, setAsset] = useState(null);
  const [related, setRelated] = useState([]);
  const [error, setError] = useState("");
  const [playbackError, setPlaybackError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [theater, setTheater] = useState(false);
  const [stacked, setStacked] = useState(false);
  const mediaRef = useRef(null);
  const playerRef = useRef(null);
  const [playerHeight, setPlayerHeight] = useState(0);

  useEffect(() => {
    const query = window.matchMedia(STACKED_WATCH_QUERY);
    const update = () => setStacked(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let active = true;
    setAsset(null); setError(""); setPlaybackError(false);
    api(`/api/v1/assets/${id}`).then(value => {
      if (!active) return;
      setInitialSeconds(resumeSeconds(value, new URLSearchParams(location.search).get("t")));
      setAsset(value);
      if (value.kind === "video") playlist.dispatch({ type: "play", asset: value });
      const topic = value.topics?.[0];
      api(`/api/v1/assets?limit=9${topic ? `&topic=${encodeURIComponent(topic.slug)}` : ""}`)
        .then(rows => { if (active) setRelated(rows.filter(row => row.id !== id).slice(0, 8)); })
        .catch(() => {});
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id, api]);

  usePlaybackTracking({
    id,
    initialSeconds,
    ready: Boolean(asset), mediaRef, api,
    onChange: values => setAsset(current => ({ ...current, ...values })),
    still: Boolean(asset && !["video", "audio"].includes(asset.kind)),
  });

  useEffect(() => { if (suspended) mediaRef.current?.pause(); }, [suspended, asset?.id]);

  // The side playlist stretches to the player's height, like a queue panel docked beside the video.
  useEffect(() => {
    const shell = playerRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => setPlayerHeight(Math.round(shell.getBoundingClientRect().height)));
    observer.observe(shell);
    return () => observer.disconnect();
  }, [asset?.id, mini]);

  const finish = () => {
    const next = playlistReducer(playlist, { type: "remove", id });
    playlist.dispatch({ type: "remove", id });
    if (!mini && next.activeId) navigate(`/watch/${next.activeId}`);
  };

  const queueIndex = playlist.items.findIndex(item => item.id === id);
  const goToQueueItem = item => {
    playlist.dispatch({ type: "play", asset: item });
    if (!mini) navigate(`/watch/${item.id}`);
  };
  const previous = queueIndex > 0 ? () => goToQueueItem(playlist.items[queueIndex - 1]) : undefined;
  const next = queueIndex >= 0 && queueIndex < playlist.items.length - 1 ? () => goToQueueItem(playlist.items[queueIndex + 1]) : undefined;

  if (!asset && mini) return <div className="content watch-page mini-player"><div className="player-mode-bar"><span>{error || "Loading video…"}</span><button className="icon-button" aria-label="Close player and clear playlist" onClick={() => playlist.dispatch({ type: "clear" })}><X size={20}/></button></div><PlaylistQueue navigate={navigate} mini formatDuration={formatDuration}/></div>;
  if (!asset) return error ? <div className="content"><p role="alert">{error}</p><button className="outline-button" onClick={() => navigate("/")}>Back to library</button></div> : <Loading />;
  const hasFile = Boolean(asset.file_path);
  // The playlist sits beside the player; theater mode, the mini player, and single-column layouts keep it under the video.
  const playlistBeside = !mini && !theater && !stacked;
  const hasAside = related.length > 0 || (playlistBeside && playlist.items.length > 0);
  const src = `/api/v1/assets/${asset.id}/file`;
  const save = async () => {
    setSaving(true); setError("");
    try {
      const value = await api(`/api/v1/assets/${asset.id}/save`, { method: "POST" });
      setAsset(current => ({ ...current, saved: value.saved }));
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return <div className={`content watch-page ${mini ? "mini-player" : theater ? "theater-mode" : ""}`} hidden={suspended}>
    {asset.kind === "video" && mini && <div className="player-mode-bar"><span>{asset.title}</span><button className="icon-button" title="Expand player" aria-label="Expand player" onClick={() => navigate(`/watch/${id}`)}><ArrowsOutSimple size={20}/></button><button className="icon-button" aria-label="Close player and clear playlist" onClick={() => playlist.dispatch({ type: "clear" })}><X size={20}/></button></div>}
    <div className={`watch-layout ${hasAside ? "" : "without-related"}`} style={playerHeight ? { "--player-height": `${playerHeight}px` } : undefined}>
      <div className="watch-primary">
        <div className="player-shell" ref={playerRef}>
          {hasFile && asset.kind === "video" ? <VideoPlayer key={asset.id} asset={asset} mediaRef={mediaRef} initialSeconds={initialSeconds} autoPlay={!suspended} onEnded={finish} onPlay={() => playlist.dispatch({ type: "play", asset })} onPrevious={previous} onNext={next} theater={theater} onToggleTheater={mini ? undefined : () => setTheater(value => !value)} onMinimize={mini ? undefined : () => { playlist.dispatch({ type: "play", asset }); navigate("/"); }} />
            : hasFile && asset.kind === "audio" ? <div className="audio-player">{asset.thumbnail_url && <img src={asset.thumbnail_url} alt="" />}<audio ref={mediaRef} src={src} controls autoPlay onError={() => setPlaybackError(true)} /></div>
            : <div className="poster-player">{(asset.kind === "image" && hasFile) || asset.thumbnail_url ? <img src={asset.kind === "image" && hasFile ? src : asset.thumbnail_url} alt={asset.title} /> : <div className="media-unavailable">No preview available</div>}{hasFile && asset.kind !== "image" && <a className="outline-button original-link" href={src} download><DownloadSimple size={18} /> Open original</a>}</div>}
        </div>
        {!playlistBeside && <PlaylistQueue navigate={navigate} mini={mini} formatDuration={formatDuration}/>}
        {playbackError && <p className="error-notice" role="alert">This media could not play in this browser. <a href={src} download>Download the original</a> to play it in another player.</p>}
        <section className="watch-info">
          <h1>{asset.title}</h1>
          <div className="watch-toolbar"><ViewCount count={asset.view_count} /><div className="watch-actions"><LikeButton asset={asset} api={api} onChange={values => setAsset(current => ({ ...current, ...values }))} /><button className={asset.saved ? "primary-button" : "outline-button"} disabled={saving} onClick={save}><BookmarkSimple weight={asset.saved ? "fill" : "regular"} />{asset.saved ? "Saved" : "Save"}</button></div></div>
          {error && <p role="alert">{error}</p>}
        </section>
        <section className="watch-description">
          <div className="watch-topics">{asset.topics?.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate}><TopicLabel topic={topic} /></AppLink>)}{!mini && <AddTag key={asset.id} asset={asset} api={api} onChange={topics => setAsset(current => current?.id === asset.id ? { ...current, topics } : current)}/>}</div>
          {asset.description && <p>{asset.description}</p>}
        </section>
        {asset.moments?.length > 0 && <section className="moments"><h2>Notable moments</h2>{asset.moments.map((moment, index) => <button key={index} onClick={() => { if (mediaRef.current) { mediaRef.current.currentTime = moment.start_ms / 1000; mediaRef.current.play().catch(() => {}); } }}><span>{formatDuration(moment.start_ms)}</span><div><strong>{moment.topic || "Moment"}</strong><p>{moment.note_markdown}</p></div></button>)}</section>}
      </div>
      {hasAside && <aside className="watch-related" aria-label="More to explore">
        {playlistBeside && <PlaylistQueue navigate={navigate} formatDuration={formatDuration}/>}
        {related.length > 0 && <div className="related-media">{related.map(item => <MediaCard key={item.id} asset={item} navigate={navigate} />)}</div>}
      </aside>}
    </div>
  </div>;
}
