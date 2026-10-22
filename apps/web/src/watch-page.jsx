"use client";

import { usePlaylist, PlaylistQueue } from "./playlist.jsx";
import { playlistReducer } from "./playlist-state.mjs";
import { VideoPlayer } from "./video-player.jsx";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";
import { useEffect, useRef, useState } from "react";
import { BookmarkSimple, CheckCircle, DownloadSimple, ArrowsOutSimple, Play, X } from "@phosphor-icons/react";
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
  const [upNext, setUpNext] = useState(null);
  // Streamed items open their source before the <video> exists, so tracking waits for it.
  const [mediaReady, setMediaReady] = useState(false);
  const [saveNote, setSaveNote] = useState("");
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
    setAsset(null); setError(""); setPlaybackError(false); setUpNext(null); setMediaReady(false); setSaveNote("");
    api(`/api/v1/assets/${id}`).then(value => {
      if (!active) return;
      setInitialSeconds(resumeSeconds(value, new URLSearchParams(location.search).get("t")));
      setAsset(value);
      // Movies and episodes never join the home-video playlist or its related list; episodes have their own queue.
      if (value.catalog) { setRelated([]); return; }
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
    ready: Boolean(asset) && (!asset.catalog || mediaReady), mediaRef, api,
    onChange: values => setAsset(current => ({ ...current, ...values })),
    still: Boolean(asset && !["video", "audio"].includes(asset.kind)),
  });

  useEffect(() => { if (suspended) mediaRef.current?.pause(); }, [suspended, asset?.id]);

  // When an episode ends, the next one starts after a short countdown that can be cancelled.
  useEffect(() => {
    if (!upNext) return;
    if (upNext.seconds <= 0) { navigate(`/watch/${upNext.episode.id}`); return; }
    const timer = setTimeout(() => setUpNext(current => current && { ...current, seconds: current.seconds - 1 }), 1000);
    return () => clearTimeout(timer);
  }, [upNext]);

  // The side playlist stretches to the player's height, like a queue panel docked beside the video.
  useEffect(() => {
    const shell = playerRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => setPlayerHeight(Math.round(shell.getBoundingClientRect().height)));
    observer.observe(shell);
    return () => observer.disconnect();
  }, [asset?.id, mini]);

  const finish = () => {
    if (asset?.catalog) {
      if (asset.catalog.next && !mini) setUpNext({ episode: asset.catalog.next, seconds: 8 });
      return;
    }
    const next = playlistReducer(playlist, { type: "remove", id });
    playlist.dispatch({ type: "remove", id });
    if (!mini && next.activeId) navigate(`/watch/${next.activeId}`);
  };

  const episodeLink = episode => episode ? () => navigate(`/watch/${episode.id}`) : undefined;
  const queueIndex = playlist.items.findIndex(item => item.id === id);
  const goToQueueItem = item => {
    playlist.dispatch({ type: "play", asset: item });
    if (!mini) navigate(`/watch/${item.id}`);
  };
  const previous = queueIndex > 0 ? () => goToQueueItem(playlist.items[queueIndex - 1]) : undefined;
  const next = queueIndex >= 0 && queueIndex < playlist.items.length - 1 ? () => goToQueueItem(playlist.items[queueIndex + 1]) : undefined;

  if (!asset && mini) return <div className="content watch-page mini-player"><div className="player-mode-bar"><span>{error || "Loading video…"}</span><button className="icon-button" aria-label="Close player and clear playlist" onClick={() => playlist.dispatch({ type: "clear" })}><X size={20}/></button></div><PlaylistQueue navigate={navigate} mini formatDuration={formatDuration}/></div>;
  if (!asset) return error ? <div className="content"><p role="alert">{error}</p><button className="outline-button" onClick={() => navigate("/")}>Back to library</button></div> : <Loading />;
  const catalog = asset.catalog;
  const hasFile = Boolean(asset.file_path) || Boolean(catalog && asset.kind === "video");
  // The playlist sits beside the player; theater mode, the mini player, and single-column layouts keep it under the video.
  const playlistBeside = !mini && !theater && !stacked;
  const episodesAside = Boolean(catalog && catalog.type === "show" && !mini);
  const hasAside = episodesAside || related.length > 0 || (!catalog && playlistBeside && playlist.items.length > 0);
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
          {hasFile && asset.kind === "video" ? <VideoPlayer key={asset.id} asset={asset} api={api} mediaRef={mediaRef} onMediaChange={setMediaReady} initialSeconds={initialSeconds} autoPlay={!suspended} onEnded={finish} onPlay={() => { if (!catalog) playlist.dispatch({ type: "play", asset }); }}
            onPrevious={catalog ? episodeLink(catalog.previous) : previous} onNext={catalog ? episodeLink(catalog.next) : next} theater={theater} onToggleTheater={mini ? undefined : () => setTheater(value => !value)}
            onMinimize={mini || catalog ? undefined : () => { playlist.dispatch({ type: "play", asset }); navigate("/"); }} />
            : hasFile && asset.kind === "audio" ? <div className="audio-player">{asset.thumbnail_url && <img src={asset.thumbnail_url} alt="" />}<audio ref={mediaRef} src={src} controls autoPlay onError={() => setPlaybackError(true)} /></div>
            : <div className="poster-player">{(asset.kind === "image" && hasFile) || asset.thumbnail_url ? <img src={asset.kind === "image" && hasFile ? src : asset.thumbnail_url} alt={asset.title} /> : <div className="media-unavailable">No preview available</div>}{hasFile && asset.kind !== "image" && <a className="outline-button original-link" href={src} download><DownloadSimple size={18} /> Open original</a>}</div>}
          {upNext && <div className="up-next" role="status">
            {upNext.episode.thumbnail && <img src={upNext.episode.thumbnail} alt="" />}
            <div><span>Up next · starting in {upNext.seconds}s</span><strong>S{upNext.episode.season} · E{upNext.episode.episode} — {upNext.episode.title}</strong>
              <div><button className="primary-button" onClick={() => navigate(`/watch/${upNext.episode.id}`)}><Play weight="fill" size={16} /> Play now</button><button className="outline-button" onClick={() => setUpNext(null)}>Cancel</button></div></div>
          </div>}
        </div>
        {!catalog && !playlistBeside && <PlaylistQueue navigate={navigate} mini={mini} formatDuration={formatDuration}/>}
        {playbackError && <p className="error-notice" role="alert">This media could not play in this browser. <a href={src} download>Download the original</a> to play it in another player.</p>}
        <section className="watch-info">
          {catalog && <div className="watch-series"><AppLink href={`/title/${catalog.titleId}`} navigate={navigate}>{catalog.title}</AppLink>{catalog.type === "show" && catalog.season != null && <span>Season {catalog.season} · Episode {catalog.episode}</span>}{catalog.type === "movie" && catalog.year && <span>{catalog.year}</span>}</div>}
          <h1>{asset.title}</h1>
          <div className="watch-toolbar"><ViewCount count={asset.view_count} /><div className="watch-actions"><LikeButton asset={asset} api={api} onChange={values => setAsset(current => ({ ...current, ...values }))} /><button className={asset.saved ? "primary-button" : "outline-button"} disabled={saving} onClick={save}><BookmarkSimple weight={asset.saved ? "fill" : "regular"} />{asset.saved ? "Saved" : "Save"}</button>
            {catalog && !mini && (asset.file_path ? <span className="download-state" title="Saved in your library folder"><CheckCircle weight="fill" size={18} /> Downloaded</span> : <button className="outline-button" onClick={async () => { try { const result = await api(`/api/v1/assets/${asset.id}/download`, { method: "POST" }); setSaveNote(result.queued.length ? "Download started" : result.skipped[0]?.reason === "already queued" ? "Already downloading" : "Already saved"); } catch (e) { setSaveNote(e.message); } }}><DownloadSimple />Download</button>)}</div></div>
          {saveNote && <p className="download-note" role="status">{saveNote} · <AppLink href="/downloads" navigate={navigate}>Open downloads</AppLink></p>}
          {error && <p role="alert">{error}</p>}
        </section>
        <section className="watch-description">
          <div className="watch-topics">{asset.topics?.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate}><TopicLabel topic={topic} /></AppLink>)}{!mini && <AddTag key={asset.id} asset={asset} api={api} onChange={topics => setAsset(current => current?.id === asset.id ? { ...current, topics } : current)}/>}</div>
          {asset.description && <p>{asset.description}</p>}
        </section>
        {asset.moments?.length > 0 && <section className="moments"><h2>Notable moments</h2>{asset.moments.map((moment, index) => <button key={index} onClick={() => { if (mediaRef.current) { mediaRef.current.currentTime = moment.start_ms / 1000; mediaRef.current.play().catch(() => {}); } }}><span>{formatDuration(moment.start_ms)}</span><div><strong>{moment.topic || "Moment"}</strong><p>{moment.note_markdown}</p></div></button>)}</section>}
      </div>
      {hasAside && <aside className="watch-related" aria-label="More to explore">
        {episodesAside && <EpisodeList api={api} catalog={catalog} currentId={asset.id} navigate={navigate} formatDuration={formatDuration} height={playerHeight} />}
        {!catalog && playlistBeside && <PlaylistQueue navigate={navigate} formatDuration={formatDuration}/>}
        {related.length > 0 && <div className="related-media">{related.map(item => <MediaCard key={item.id} asset={item} navigate={navigate} />)}</div>}
      </aside>}
    </div>
  </div>;
}

// The episodes of the season being watched, beside the player: pick any to jump there.
function EpisodeList({ api, catalog, currentId, navigate, formatDuration, height }) {
  const [rows, setRows] = useState(null);
  const listRef = useRef(null);
  useEffect(() => {
    let active = true;
    setRows(null);
    api(`/api/v1/titles/${catalog.titleId}/episodes?season=${catalog.season}`).then(result => { if (active) setRows(result.episodes); }).catch(() => { if (active) setRows([]); });
    return () => { active = false; };
  }, [api, catalog.titleId, catalog.season]);
  useEffect(() => { listRef.current?.querySelector(".is-playing")?.scrollIntoView({ block: "nearest" }); }, [rows, currentId]);
  if (!rows?.length) return null;
  return <section className="episode-queue" aria-label={`Season ${catalog.season} episodes`} style={height ? { maxHeight: `${Math.max(height, 320)}px` } : undefined}>
    <h2>Season {catalog.season}<span>{rows.length} episodes</span></h2>
    <ol ref={listRef}>{rows.map(episode => <li key={episode.id} className={episode.id === currentId ? "is-playing" : ""}>
      <button disabled={episode.availability === "unaired"} onClick={() => navigate(`/watch/${episode.id}`)} aria-label={`Play episode ${episode.episode}, ${episode.title}`}>
        <span className="episode-number">{episode.id === currentId ? <Play size={11} weight="fill" /> : episode.episode}</span>
        <span className="episode-thumb">{episode.thumbnail && <img src={episode.thumbnail} alt="" loading="lazy" />}{episode.durationMs > 0 && <em>{formatDuration(episode.durationMs)}</em>}
          {episode.progressMs > 0 && !episode.watched && <i style={{ width: `${Math.min(100, episode.progressMs / episode.durationMs * 100)}%` }} />}</span>
        <span className="episode-copy"><strong>{episode.title}</strong><small>{episode.availability === "unaired" ? `Airs ${episode.airDate}` : episode.watched ? "Watched" : episode.id === currentId ? "Now playing" : ""}</small></span>
      </button>
    </li>)}</ol>
  </section>;
}
