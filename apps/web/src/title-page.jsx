"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CaretDown, Check, CheckCircle, DownloadSimple, Minus, Play, Plus, Star, X } from "@phosphor-icons/react";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";
import { SetupNotice } from "./catalog-page.jsx";

const runtime = minutes => minutes ? (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ""}`.trim() : `${minutes}m`) : null;
const clock = ms => { const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; };
const seasonName = season => season.number === 0 ? "Specials" : `Season ${season.number}`;

// A movie or series: artwork, what to play next, your tags, and (for series) every season and episode.
export function TitlePage({ reference, api, navigate, AppLink, Loading, Empty, formatDuration }) {
  const [title, setTitle] = useState(null);
  const [error, setError] = useState(null);
  const [season, setSeason] = useState(null);
  const [episodes, setEpisodes] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);

  const load = useCallback(() => api(`/api/v1/titles/${encodeURIComponent(reference)}`).then(value => {
    setTitle(value);
    // The address becomes the permanent one once the title exists locally.
    if (reference !== value.id && typeof history !== "undefined") history.replaceState(history.state, "", `/title/${value.id}`);
    return value;
  }), [api, reference]);

  useEffect(() => {
    let active = true;
    setTitle(null); setError(null); setEpisodes(null); setSeason(null); setNote("");
    load().then(value => {
      if (!active || value.type !== "show") return;
      const next = value.nextUp?.season;
      const first = value.seasons.find(item => item.number >= 1) || value.seasons[0];
      setSeason(next >= 0 && value.seasons.some(item => item.number === next) ? next : first?.number ?? 1);
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [load]);

  const loadEpisodes = useCallback(() => {
    if (!title || title.type !== "show" || season === null) return;
    api(`/api/v1/titles/${title.id}/episodes?season=${season}`).then(value => setEpisodes(value.episodes)).catch(e => { setEpisodes([]); setNote(e.message); });
  }, [api, title?.id, title?.type, season]);
  useEffect(() => { setEpisodes(null); loadEpisodes(); }, [loadEpisodes]);

  useEffect(() => {
    if (!menu) return;
    const close = event => { if (!menuRef.current?.contains(event.target)) setMenu(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  if (error) return /key|Settings/.test(error) ? <div className="content"><SetupNotice message={error} AppLink={AppLink} navigate={navigate} /></div> : <div className="content"><Empty title="Couldn't open this title" message={error} /></div>;
  if (!title) return <Loading />;

  const next = title.nextUp;
  const toggleLibrary = async () => {
    setBusy("library"); setNote("");
    try { setTitle(await api(`/api/v1/titles/${title.id}/library`, { method: "PUT", body: JSON.stringify({ inLibrary: !title.inLibrary }) })); loadEpisodes(); }
    catch (e) { setNote(e.message); }
    finally { setBusy(""); }
  };
  const download = async (body, label) => {
    setMenu(false); setBusy("download"); setNote("");
    try {
      const result = await api(`/api/v1/titles/${title.id}/download`, { method: "POST", body: JSON.stringify(body) });
      setNote(result.queued.length ? `Queued ${result.queued.length} ${result.queued.length === 1 ? "download" : "downloads"} for ${label}.` : `Nothing new to download for ${label} (${result.skipped[0]?.reason || "already saved"}).`);
      load(); loadEpisodes();
    } catch (e) { setNote(e.message); }
    finally { setBusy(""); }
  };
  const playLabel = !next ? "Play" : next.resume ? `Resume${title.type === "show" ? ` S${next.season} · E${next.episode}` : ""}` : next.watched ? (title.type === "movie" ? "Watch again" : "Watch again") : title.type === "show" ? `${next.continuing ? "Next" : "Play"} S${next.season} · E${next.episode}` : "Play";
  const refresh = async () => { setBusy("refresh"); setNote(""); try { setTitle(await api(`/api/v1/titles/${title.id}/refresh`, { method: "POST" })); loadEpisodes(); } catch (e) { setNote(e.message); } finally { setBusy(""); } };
  const toggleAnime = async () => { try { setTitle(await api(`/api/v1/titles/${title.id}/anime`, { method: "PUT", body: JSON.stringify({ isAnime: !title.isAnime }) })); } catch (e) { setNote(e.message); } };
  const removeTopic = async topic => { const value = await api(`/api/v1/titles/${title.id}/topics/${topic.id}`, { method: "DELETE" }); setTitle(current => ({ ...current, topics: value.topics })); };
  const topicFor = name => title.topics?.find(topic => topic.name === name && topic.topic_type === "service");
  const meta = [title.year, title.certification, title.type === "movie" ? runtime(title.runtimeMin) : `${title.seasons.filter(item => item.number >= 1).length} ${title.seasons.filter(item => item.number >= 1).length === 1 ? "season" : "seasons"}`, title.status && title.type === "show" ? title.status : null].filter(Boolean);
  const currentSeason = title.seasons.find(item => item.number === season);

  return <div className="title-page">
    <section className="title-hero">
      {title.backdrop && <img className="title-backdrop" src={title.backdrop} alt="" />}
      <div className="title-hero-inner">
        {title.posterLarge && <img className="title-poster" src={title.posterLarge} alt={`${title.title} poster`} />}
        <div className="title-info">
          <span className="eyebrow">{title.type === "movie" ? "Movie" : title.isAnime ? "Anime series" : "Series"}{title.isAnime && title.type === "movie" ? " · Anime" : ""}</span>
          {title.logo ? <h1 className="title-logo"><img src={title.logo} alt={title.title} /></h1> : <h1>{title.title}</h1>}
          {title.originalTitle && title.originalTitle !== title.title && <p className="title-original">{title.originalTitle}</p>}
          <div className="title-meta">{meta.map((item, index) => <span key={index}>{item}</span>)}{title.rating > 0 && <span className="title-rating"><Star size={13} weight="fill" />{title.rating.toFixed(1)}</span>}</div>
          {title.tagline && <p className="title-tagline">{title.tagline}</p>}
          {title.overview && <p className="title-overview">{title.overview}</p>}
          <div className="title-actions">
            {next ? <AppLink href={`/watch/${next.id}`} navigate={navigate} className="primary-button"><Play weight="fill" size={18} />{playLabel}</AppLink> : <button className="primary-button" disabled><Play weight="fill" size={18} />{title.type === "show" ? "Loading episodes…" : "Play"}</button>}
            <button className={title.inLibrary ? "outline-button is-active" : "outline-button"} onClick={toggleLibrary} disabled={busy === "library"} aria-pressed={title.inLibrary}>{busy === "library" ? <ArrowsClockwise size={18} className="spin" /> : title.inLibrary ? <Check size={18} weight="bold" /> : <Plus size={18} weight="bold" />}{title.inLibrary ? "In My list" : "My list"}</button>
            <div className="menu-anchor" ref={menuRef}>
              <button className="outline-button" onClick={() => setMenu(value => !value)} aria-haspopup="menu" aria-expanded={menu} disabled={busy === "download"}><DownloadSimple size={18} />Download<CaretDown size={13} /></button>
              {menu && <div className="action-menu" role="menu">
                {title.type === "movie" ? <button role="menuitem" onClick={() => download({}, title.title)}>Download movie</button> : <>
                  {season !== null && season >= 0 && <button role="menuitem" onClick={() => download({ season }, currentSeason ? seasonName(currentSeason) : `season ${season}`)}>{currentSeason ? seasonName(currentSeason) : `Season ${season}`}</button>}
                  <button role="menuitem" onClick={() => download({}, "the whole series")}>Entire series</button></>}
                <small>Saves into your download folder in Settings → Streaming.</small>
              </div>}
            </div>
            <button className="icon-button" onClick={refresh} disabled={busy === "refresh"} aria-label="Refresh details" title="Refresh details from the catalog"><ArrowsClockwise size={18} className={busy === "refresh" ? "spin" : ""} /></button>
          </div>
          {note && <p className="title-note" role="status">{note} {/download/i.test(note) && <AppLink href="/downloads" navigate={navigate}>Open downloads</AppLink>}</p>}
          {title.services.length > 0 && <div className="title-services" aria-label="Available on">
            <span>Available on</span>
            {title.services.map(service => { const topic = topicFor(service.name); const inner = <>{service.logo && <img src={service.logo} alt="" />}{service.name}</>; return topic ? <AppLink key={service.name} href={`/topic/${topic.slug}`} navigate={navigate} className="service-badge">{inner}</AppLink> : <span key={service.name} className="service-badge">{inner}</span>; })}
          </div>}
        </div>
      </div>
    </section>
    <div className="content title-body">
      <section className="title-tags" aria-label="Tags">
        <div className="watch-topics">
          {title.topics.filter(topic => topic.topic_type !== "service").map(topic => <span className="tag-pill" key={topic.id}><AppLink href={`/topic/${topic.slug}`} navigate={navigate}><TopicLabel topic={topic} /></AppLink><button aria-label={`Remove ${topic.name}`} title={`Remove ${topic.name} from the whole ${title.type === "movie" ? "movie" : "series"}`} onClick={() => removeTopic(topic)}><X size={12} /></button></span>)}
          <AddTag asset={{ id: title.id, title: title.title, topics: title.topics }} api={api} endpoint={`/api/v1/titles/${title.id}/topics`} label={title.type === "movie" ? "Add tag" : "Tag series"} onChange={topics => setTitle(current => ({ ...current, topics }))} />
        </div>
        {title.type === "show" && <p className="muted">Tags added here apply to every episode. Tag a single episode with its tag button below.</p>}
        <button className="text-link" onClick={toggleAnime}>{title.isAnime ? "Not anime? Move to TV Shows" : "Mark as anime"}</button>
      </section>

      {title.type === "show" && <section className="episodes-section">
        <div className="episodes-head">
          <div className="season-select" role="tablist" aria-label="Seasons">{title.seasons.map(item => <button key={item.number} role="tab" aria-selected={item.number === season} className={item.number === season ? "active" : ""} onClick={() => setSeason(item.number)}>{seasonName(item)}</button>)}</div>
        </div>
        {currentSeason?.overview && <p className="season-overview">{currentSeason.overview}</p>}
        {episodes === null ? <Loading /> : !episodes.length ? <Empty title="No episodes yet" message="Episodes will appear here once the catalog lists them." /> : <ol className="episode-list">
          {episodes.map(episode => <EpisodeRow key={episode.id} episode={episode} api={api} navigate={navigate} AppLink={AppLink} formatDuration={formatDuration} onTagged={loadEpisodes} onDownload={() => download({ assetIds: [episode.id] }, `episode ${episode.episode}`)} current={next?.id === episode.id} />)}
        </ol>}
      </section>}

      {title.cast.length > 0 && <Rail2 title="Cast">{title.cast.map(person => <div key={person.name + person.character} className="cast-card">
        <div className="cast-photo">{person.profile ? <img src={person.profile} alt="" loading="lazy" /> : <span>{person.name[0]}</span>}</div><strong>{person.name}</strong><small>{person.character}</small></div>)}</Rail2>}
      {title.genres.length > 0 && <p className="muted title-genres">{title.genres.join(" · ")}</p>}
    </div>
  </div>;
}

function Rail2({ title, children }) {
  return <section className="cast-section"><h2>{title}</h2><div className="cast-row">{children}</div></section>;
}

function EpisodeRow({ episode, api, navigate, AppLink, formatDuration, onTagged, onDownload, current }) {
  const unaired = episode.availability === "unaired";
  const open = () => { if (!unaired) navigate(`/watch/${episode.id}`); };
  return <li className={`episode-row ${current ? "is-next" : ""} ${unaired ? "is-unaired" : ""}`}>
    <button className="episode-thumb-button" onClick={open} disabled={unaired} aria-label={`Play episode ${episode.episode}: ${episode.title}`}>
      <span className="episode-still">{episode.thumbnail && <img src={episode.thumbnail} alt="" loading="lazy" />}
        {!unaired && <span className="episode-play"><Play weight="fill" size={22} /></span>}
        {episode.durationMs > 0 && <em>{formatDuration(episode.durationMs)}</em>}
        {episode.progressMs > 0 && !episode.watched && <i style={{ width: `${Math.min(100, episode.progressMs / episode.durationMs * 100)}%` }} />}</span>
    </button>
    <div className="episode-body">
      <div className="episode-title"><span className="episode-index">{episode.episode}</span><h3>{episode.title}</h3>{episode.watched && <CheckCircle size={16} weight="fill" className="watched" aria-label="Watched" />}{current && !episode.watched && <span className="next-chip">{episode.progressMs > 0 ? "Resume" : "Up next"}</span>}</div>
      <small>{unaired ? `Airs ${episode.airDate}` : [episode.airDate, episode.durationMs ? `${Math.round(episode.durationMs / 60000)}m` : null].filter(Boolean).join(" · ")}{episode.absolute ? ` · #${episode.absolute} overall` : ""}</small>
      {episode.description && <p>{episode.description}</p>}
      {episode.topics.length > 0 && <div className="episode-tags">{episode.topics.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate}><TopicLabel topic={topic} /></AppLink>)}</div>}
    </div>
    <div className="episode-actions">
      <AddTag compact asset={{ id: episode.id, title: episode.title, topics: episode.topics }} api={api} onChange={onTagged} />
      {episode.downloaded ? <span className="download-state" title="Saved in your library folder"><CheckCircle size={18} weight="fill" /></span> : <button className="icon-button" onClick={onDownload} disabled={unaired} aria-label={`Download episode ${episode.episode}`} title="Download this episode"><DownloadSimple size={18} /></button>}
    </div>
  </li>;
}
