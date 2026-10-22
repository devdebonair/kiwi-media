"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowCounterClockwise, ArrowSquareOut, Broadcast, CaretDown, CaretLeft, ClosedCaptioning, CornersIn, CornersOut, FilmSlate, MagnifyingGlass, PencilSimple, Play, Plus, SpeakerHigh, SpeakerSlash, Stack, Television, X } from "@phosphor-icons/react";
import { InfiniteScroll } from "./infinite-scroll.jsx";
import { ChannelEditor } from "./guide-channel-editor.jsx";
import { Modal } from "./modal.jsx";
import { LikeButton } from "./animated-like-button.jsx";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";
import { airing, clock, dayLabel, halfHour, liveOffset, placement, programAt, slots, span } from "./guide-time.mjs";
import { detectCaps, usePlaybackSession } from "./playback-session.jsx";
import { planPlayback, remuxUrl } from "./playback-plan.mjs";
import { applyPreference, loadPreference } from "./track-preferences.mjs";
import { SubtitleLayer, useSubtitleCues, useSubtitleStyle } from "./subtitle-layer.jsx";

const HOURS = 4, PAGE = 40;
const filters = [["all", "All channels"], ["media", "Movies & shows"], ["genres", "Genres"], ["services", "Services"], ["custom", "My channels"], ["people", "People"], ["tags", "Tags"]];
// The last channel watched on this device, so the guide turns back on where you left it.
const LAST_CHANNEL_KEY = "kiwi.guide.channel.v1";
const lastChannel = () => {
  try { const value = JSON.parse(localStorage.getItem(LAST_CHANNEL_KEY)); return typeof value?.key === "string" ? value : null; } catch { return null; }
};
const rememberChannel = channel => {
  try {
    if (channel) localStorage.setItem(LAST_CHANNEL_KEY, JSON.stringify({ key: channel.key, number: channel.number, name: channel.name, type: channel.type, avatar_url: channel.avatar_url, slug: channel.slug }));
    else localStorage.removeItem(LAST_CHANNEL_KEY);
  } catch { /* The guide falls back to the top channel. */ }
};

// Phones get a page-scrolling layout: pinned player, compact toolbar, and program details in a bottom sheet.
const PHONE_QUERY = "(max-width: 680px)";
function usePhone() {
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(PHONE_QUERY), update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

// A DirecTV-style grid: every tag with enough videos is a channel looping its lineup on a shared clock.
export function GuidePage({ api, navigate, Loading }) {
  const [start, setStart] = useState(() => halfHour(Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [tuned, setTuned] = useState(lastChannel);
  const [selected, setSelected] = useState(() => tuned && { key: tuned.key, start: null });
  const [editing, setEditing] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const phone = usePhone();
  // Until the last channel's row is on screen, keep loading pages so it can be shown and selected.
  const revealing = useRef(Boolean(tuned));
  const gridRef = useRef(null), timebarRef = useRef(null), searchRef = useRef(null), generation = useRef(0), queryKey = useRef(null), pending = useRef(false), dataRef = useRef(null);
  dataRef.current = data;
  const end = start + HOURS * 3_600_000;
  const url = (offset, limit) => `/api/v1/guide?start=${start}&hours=${HOURS}&filter=${filter}&q=${encodeURIComponent(q)}&offset=${offset}&limit=${limit}`;

  useEffect(() => {
    // Timers stop while the page is in the background, so refresh the clock as soon as it is visible again.
    const tick = () => setNow(Date.now()), onVisible = () => { if (document.visibilityState === "visible") tick(); };
    const timer = setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  useEffect(() => { const timer = setTimeout(() => setQ(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  // The window always starts at the current half hour and rolls forward with the clock; scroll sideways to look ahead.
  useEffect(() => { if (halfHour(now) !== start) setStart(halfHour(now)); }, [now, start]);

  // New filters start over at the top; moving through time refreshes the rows already loaded in place.
  useEffect(() => {
    const key = `${filter}|${q}`, reset = key !== queryKey.current || !dataRef.current;
    queryKey.current = key;
    const current = ++generation.current;
    const limit = reset ? PAGE : Math.min(100, Math.max(PAGE, dataRef.current.channels.length));
    if (reset) { setData(null); gridRef.current?.scrollTo({ top: 0 }); }
    setError("");
    api(url(0, limit)).then(value => {
      if (generation.current === current) setData({ channels: value.channels, total: value.total });
    }).catch(e => {
      if (generation.current !== current) return;
      setError(e.message);
      if (reset) setData({ channels: [], total: 0 });
    });
  }, [start, filter, q, version]);

  const loadMore = useCallback(async () => {
    if (pending.current || !data || data.channels.length >= data.total) return;
    pending.current = true;
    const current = generation.current;
    setLoadingMore(true); setError("");
    try {
      const value = await api(url(data.channels.length, PAGE));
      if (generation.current === current) setData(previous => ({ total: value.total, channels: [...previous.channels, ...value.channels.filter(channel => !previous.channels.some(item => item.key === channel.key))] }));
    } catch (e) { if (generation.current === current) setError(e.message); }
    finally { pending.current = false; if (generation.current === current) setLoadingMore(false); }
  }, [data, start, filter, q]);

  const channels = data?.channels || [];
  const channel = channels.find(item => item.key === selected?.key) || channels[0] || null;
  const program = channel && (channel.programs.find(item => item.start === selected?.start)
    || programAt(channel.programs, now >= start && now < end ? now : start));
  useEffect(() => {
    if (!tuned && channels.length) { setTuned(channels[0]); setSelected(value => value || { key: channels[0].key, start: null }); }
    else if (tuned) { const fresh = channels.find(item => item.key === tuned.key); if (fresh && fresh !== tuned) setTuned(fresh); }
  }, [channels]);
  useEffect(() => { rememberChannel(tuned); }, [tuned?.key, tuned?.name, tuned?.number, tuned?.avatar_url]);
  useEffect(() => {
    if (!revealing.current || !data || !tuned) return;
    const row = channels.findIndex(item => item.key === tuned.key);
    if (row >= 0) {
      revealing.current = false;
      const grid = gridRef.current, element = grid?.querySelector(`[aria-rowindex="${row + 2}"]`);
      // Phones scroll the page; larger screens scroll the grid itself.
      if (element && phone) element.scrollIntoView({ block: "center" });
      else if (element) grid.scrollTo({ top: Math.max(0, element.offsetTop - grid.clientHeight / 2 + element.offsetHeight / 2) });
    } else if (channels.length < data.total && filter === "all" && !q) loadMore();
    else revealing.current = false;
  }, [data]);
  // The remembered channel no longer exists (deleted, or too few videos): fall back to the top channel.
  const lostChannel = useCallback(() => { revealing.current = false; setTuned(dataRef.current?.channels[0] || null); setSelected(null); }, []);
  // Keep the info panel on whatever is airing as programs end.
  useEffect(() => {
    if (channel && program && program.end <= now && program.end < end) setSelected({ key: channel.key, start: program.end });
  }, [now]);

  const select = useCallback((item, show) => setSelected({ key: item.key, start: show.start }), []);
  // Live programs change the channel in the player; anything else opens in the regular player.
  const tune = useCallback((item, show) => {
    if (liveOffset(show, Date.now()) !== null) { setTuned(item); setSelected({ key: item.key, start: show.start }); }
    else navigate(`/watch/${show.id}`);
  }, [navigate]);
  // A tap on a program: phones open its details in a sheet; elsewhere the first click selects and the second watches.
  const activate = useCallback((item, show, isSelected) => {
    if (phone) { select(item, show); setSheet(true); }
    else if (isSelected) tune(item, show);
    else select(item, show);
  }, [phone, select, tune]);
  const tuneChannel = useCallback(item => {
    setTuned(item);
    const show = airing(item.programs, Date.now());
    setSelected({ key: item.key, start: show?.start ?? null });
  }, []);
  const syncTimebar = event => { if (timebarRef.current) timebarRef.current.scrollLeft = event.currentTarget.scrollLeft; };
  // Focus inside the tap so iOS opens the keyboard.
  const toggleSearch = () => {
    if (searchOpen) { setSearchOpen(false); setSearch(""); return; }
    flushSync(() => setSearchOpen(true));
    searchRef.current?.focus();
  };

  // Arrow keys move like a remote: left/right through a channel's lineup, up/down at the same time on the next channel.
  const onKeyDown = event => {
    const cell = event.target.closest?.("[data-start]");
    if (!cell || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const row = Number(cell.dataset.row), at = Number(cell.dataset.start), lineup = channels[row]?.programs || [];
    const index = lineup.findIndex(item => item.start === at);
    let targetRow = row, target = null;
    if (event.key === "ArrowRight") target = lineup[index + 1]?.start < end ? lineup[index + 1] : null;
    else if (event.key === "ArrowLeft") target = lineup[index - 1]?.end > start ? lineup[index - 1] : null;
    else {
      targetRow = row + (event.key === "ArrowDown" ? 1 : -1);
      target = channels[targetRow] ? programAt(channels[targetRow].programs, Math.max(at, start)) : null;
    }
    event.preventDefault();
    if (!target) return;
    select(channels[targetRow], target);
    gridRef.current.querySelector(`[data-row="${targetRow}"][data-start="${target.start}"] button`)?.focus();
  };

  const saved = value => { setEditing(null); setSelected({ key: `custom:${value.id}`, start: null }); setVersion(v => v + 1); };
  const deleted = () => { setEditing(null); setSelected(null); setVersion(v => v + 1); };
  const nowX = (now - start) / 60_000;

  return <div className="content guide-page">
    <h1 className="sr-only">TV guide</h1>
    <GuideHero api={api} phone={phone} channel={channel} program={program} now={now} tuned={tuned} onTune={tune} onEdit={setEditing} onLost={lostChannel} navigate={navigate} />

    <div className={`guide-toolbar ${searchOpen ? "is-searching" : ""}`}>
      <div className="chips" role="group" aria-label="Filter channels">
        {filters.map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      <label className="guide-filter-select"><span className="sr-only">Show</span>
        <select value={filter} onChange={event => setFilter(event.target.value)}>{filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <CaretDown size={14} aria-hidden="true" />
      </label>
      <label className="guide-search search"><MagnifyingGlass size={17} aria-hidden="true" /><input ref={searchRef} type="search" enterKeyHint="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Channel number or name" aria-label="Find a channel" /></label>
      <button className="guide-search-toggle icon-button" onClick={toggleSearch} aria-expanded={searchOpen} aria-label={searchOpen ? "Close channel search" : "Find a channel"}>{searchOpen ? <X size={19} /> : <MagnifyingGlass size={19} />}</button>
      <button className="primary-button guide-new-channel" onClick={() => setEditing({})} aria-label="New channel"><Plus size={17} /><span>New channel</span></button>
    </div>

    {error && <div className="error-notice" role="alert"><span>{error}</span><button className="outline-button" onClick={() => channels.length && channels.length < data.total ? loadMore() : setVersion(v => v + 1)}>Try again</button></div>}

    <div className="guide-board" role="grid" aria-label={`Guide, ${dayLabel(start, now)} ${clock(start)} to ${clock(end)}`} aria-rowcount={(data?.total ?? 0) + 1} onKeyDown={onKeyDown} style={{ "--span": HOURS * 60 }}>
      {/* The time header lives outside the scroller so it can pin to the page on phones; it follows the grid sideways. */}
      <div className="guide-timebar" ref={timebarRef}>
        <div className="guide-row guide-head" role="row" aria-rowindex={1}>
          <div className="guide-corner" role="columnheader">{dayLabel(start, now)}</div>
          <div className="guide-times">
            {slots(start, end).map(time => <span key={time} role="columnheader" style={{ "--x": (time - start) / 60_000 }}>{clock(time)}</span>)}
            {nowX >= 0 && nowX <= HOURS * 60 && <i className="guide-now-marker" style={{ "--x": nowX }} aria-hidden="true" />}
          </div>
        </div>
      </div>
      <div className="guide-grid" ref={gridRef} onScroll={syncTimebar}>
        <div className="guide-canvas">
          {nowX >= 0 && nowX <= HOURS * 60 && <div className="guide-now" style={{ "--x": nowX }} aria-hidden="true" />}
          {!data ? <Loading /> : channels.map((item, row) => <GuideRow key={item.key} channel={item} row={row} start={start} end={end} now={now} isTuned={item.key === tuned?.key}
            selectedStart={item.key === channel?.key ? program?.start ?? null : undefined}
            onActivate={activate} onTuneChannel={tuneChannel} onEdit={setEditing} />)}
          {data && !channels.length && !error && <GuideEmpty filter={filter} q={q} create={() => setEditing({})} />}
          <InfiniteScroll rootRef={phone ? undefined : gridRef} enabled={Boolean(data) && channels.length < data.total && !error} loading={loadingMore} onLoadMore={loadMore} />
        </div>
      </div>
    </div>

    {editing && <ChannelEditor api={api} channel={editing.id ? editing : null} close={() => setEditing(null)} onSaved={saved} onDeleted={deleted} />}
    {phone && sheet && channel && program && <Modal title={`${channel.number} · ${channel.name}`} className="guide-sheet" close={() => setSheet(false)}>
      <ProgramInfo api={api} channel={channel} program={program} now={now} tuned={tuned} navigate={navigate} inSheet
        onTune={(item, show) => { setSheet(false); tune(item, show); }} onEdit={item => { setSheet(false); setEditing(item); }} />
    </Modal>}
  </div>;
}

const ChannelLogo = ({ channel }) => channel.type === "custom"
  ? <span className="guide-logo is-custom"><Stack size={18} weight="fill" /></span>
  : <span className="guide-logo">{channel.avatar_url ? <img src={channel.avatar_url} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} /> : <Television size={18} />}</span>;

// Rows only re-render when their own selection, the clock tick, or the window changes.
const GuideRow = memo(function GuideRow({ channel, row, start, end, now, isTuned, selectedStart, onActivate, onTuneChannel, onEdit }) {
  return <div className={`guide-row ${isTuned ? "is-tuned" : ""}`} role="row" aria-rowindex={row + 2} aria-current={isTuned || undefined}>
    <div className="guide-channel" role="rowheader">
      <button className="guide-channel-tune" onClick={() => onTuneChannel(channel)} title={`${channel.name} · ${channel.item_count.toLocaleString()} ${channel.item_count === 1 ? "video" : "videos"}`} aria-label={`Channel ${channel.number}, ${channel.name}. ${isTuned ? "Now playing" : "Watch live"}`}>
        <span className="guide-number">{isTuned ? <SpeakerHigh size={14} weight="fill" aria-hidden="true" /> : channel.number}</span><ChannelLogo channel={channel} /><span className="guide-channel-name">{channel.name}</span>
      </button>
      {channel.type === "custom" && <button className="guide-channel-edit icon-button" onClick={() => onEdit(channel)} aria-label={`Edit ${channel.name}`} title="Edit channel"><PencilSimple size={15} /></button>}
    </div>
    <div className="guide-programs">
      {channel.programs.map(show => {
        const { x, width, continued } = placement(show, start, end);
        if (width <= 0) return null;
        const live = show.start <= now && now < show.end, past = show.end <= now, isSelected = show.start === selectedStart;
        return <div key={show.start} role="gridcell" data-row={row} data-start={show.start} aria-selected={isSelected}
          className={`guide-cell ${live ? "is-live" : ""} ${past ? "is-past" : ""} ${isSelected ? "is-selected" : ""} ${width < 4 ? "is-tiny" : width < 10 ? "is-short" : ""}`}
          style={{ "--x": x, "--w": width }}>
          <button tabIndex={isSelected ? 0 : -1} title={`${show.title} · ${clock(show.start)}–${clock(show.end)}`}
            aria-label={`${show.title}, ${clock(show.start)} to ${clock(show.end)}${live ? ", on now" : ""}${isSelected ? ". Press again to watch" : ""}`}
            onClick={() => onActivate(channel, show, isSelected)}>
            {continued && <CaretLeft className="guide-continued" size={12} weight="bold" aria-hidden="true" />}
            <strong>{show.title}</strong><small>{show.season != null && show.episode != null ? `S${show.season}E${show.episode} · ` : ""}{clock(show.start)} · {span(show.duration_ms)}</small>
          </button>
        </div>;
      })}
      {!channel.programs.length && <p className="guide-row-empty">No videos match this channel's tags yet</p>}
    </div>
  </div>;
});

function GuideHero({ api, phone, tuned, onLost, navigate, ...info }) {
  return <section className="guide-hero" aria-label="Live TV">
    {!phone && <ProgramInfo api={api} tuned={tuned} navigate={navigate} {...info} />}
    {tuned ? <GuidePlayer key="player" api={api} channel={tuned} navigate={navigate} onLost={onLost} /> : <div className="guide-player is-idle" />}
  </section>;
}

// Details for the selected program: beside the player on larger screens, in a bottom sheet on phones.
function ProgramInfo({ api, channel, program, now, tuned, onTune, onEdit, navigate, inSheet = false }) {
  const [details, setDetails] = useState(null);
  useEffect(() => {
    setDetails(null);
    if (!program) return;
    let active = true;
    const timer = setTimeout(() => api(`/api/v1/assets/${program.id}`).then(value => { if (active) setDetails(value); }).catch(() => {}), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [program?.id, api]);
  if (!channel) return <div className="guide-info" />;
  const channelLine = !inSheet && <ChannelLine channel={channel} navigate={navigate} onEdit={onEdit} />;
  if (!program) return <div className="guide-info">{channelLine}<h2>No programming</h2><p className="guide-meta">Tag more videos to fill this channel.</p></div>;
  const live = program.start <= now && now < program.end;
  const progress = live ? (now - program.start) / (program.end - program.start) : 0;
  const status = live ? `${span(program.end - now)} left` : program.end <= now ? "Already aired" : `Starts in ${span(program.start - now)}`;
  const playing = live && tuned?.key === channel.key;
  return <div className={`guide-info ${inSheet ? "in-sheet" : ""}`}>
    {channelLine}
    <h2>{program.title}</h2>
    {program.subtitle && <p className="guide-episode">{program.subtitle}</p>}
    <p className="guide-meta">{live && <span className="guide-live-pill"><Broadcast size={13} weight="fill" /> Live</span>}{clock(program.start)} – {clock(program.end)} · {span(program.duration_ms)} · {status}</p>
    {live && <div className="guide-progress" role="progressbar" aria-label="Elapsed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ transform: `scaleX(${progress})` }} /></div>}
    {details?.description && <p className="guide-description">{details.description}</p>}
    {!playing && details?.topics?.length > 0 && <p className="guide-tags">{details.topics.slice(0, 6).map(topic => topic.name).join(" · ")}</p>}
    <div className="guide-actions">
      {playing ? <span className="guide-now-playing"><SpeakerHigh size={16} weight="fill" /> Now playing</span>
        : <button className="primary-button" onClick={() => onTune(channel, program)}><Play size={16} weight="fill" />{live ? "Watch live" : "Watch"}</button>}
      {live && <button className="outline-button" onClick={() => navigate(`/watch/${program.id}?t=0`)}><ArrowCounterClockwise size={16} /> Start over</button>}
      {inSheet && channel.type === "custom" && <button className="outline-button" onClick={() => onEdit(channel)}><PencilSimple size={16} /> Edit channel</button>}
    </div>
  </div>;
}

function ChannelLine({ channel, navigate, onEdit }) {
  return <div className="guide-channel-line">
    <ChannelLogo channel={channel} /><span className="guide-number">{channel.number}</span>
    {channel.slug ? <a href={`/topic/${channel.slug}`} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(`/topic/${channel.slug}`); }}>{channel.name}</a> : <span>{channel.name}</span>}
    {channel.type === "custom" && <>
      <span className="guide-channel-rule">{channel.topics.map(topic => topic.name).join(channel.match === "all" ? " + " : " or ")}</span>
      <button className="icon-button" onClick={() => onEdit(channel)} aria-label={`Edit ${channel.name}`} title="Edit channel"><PencilSimple size={15} /></button>
    </>}
  </div>;
}

// Live TV for the tuned channel: joins each program at the elapsed time and rolls into the next one,
// like the picture-in-picture window on a satellite guide. It never touches the playlist.
// Movies and episodes open their source first (and the next program is prepared a little before it starts);
// when the audio you want is not the file's default, the stream is repackaged from the live position.
function GuidePlayer({ api, channel, navigate, onLost }) {
  const [lineup, setLineup] = useState(null);
  const [airingStart, setAiringStart] = useState(null);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [transcode, setTranscode] = useState(false);
  const [restart, setRestart] = useState(0);
  const [time, setTime] = useState(0);
  const shell = useRef(null), video = useRef(null), counted = useRef(null);
  // Fetches the channel from now on and starts whatever is airing.
  const sync = useCallback(() => {
    let active = true;
    api(`/api/v1/guide?channel=${encodeURIComponent(channel.key)}&start=${Date.now()}&hours=3&limit=1`).then(value => {
      if (!active) return;
      if (!value.total) { onLost(); return; }
      const programs = value.channels[0]?.programs || [];
      setLineup(programs); setAiringStart(airing(programs, Date.now())?.start ?? null);
    }).catch(() => { if (active) setLineup([]); });
    return () => { active = false; };
  }, [api, channel.key, onLost]);
  useEffect(() => { setLineup(null); setFailed(false); return sync(); }, [sync]);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const program = lineup?.find(item => item.start === airingStart) || null;
  useEffect(() => { setFailed(false); setTranscode(false); setRestart(0); setTime(0); }, [program?.id, program?.start]);

  const guideAsset = useMemo(() => ({ id: program?.id || "none", kind: "video", catalog: program?.catalog ? { titleId: program.title_id } : undefined }), [program?.id, program?.catalog, program?.title_id]);
  const session = usePlaybackSession({ asset: guideAsset, api });
  const info = session.info;
  const chosen = useMemo(() => info ? applyPreference(info, loadPreference(`title:${program?.title_id}`)) : null, [info, program?.title_id]);
  const plan = useMemo(() => planPlayback(info, { audioPosition: chosen?.audioPosition ?? null, transcode }), [info, chosen, transcode]);
  const sessionReady = session.phase === "ready";
  // Where a repackaged stream begins: the live position when it is opened (or reopened after falling behind).
  const streamStart = useMemo(() => program ? Math.floor(Math.max(0, (Date.now() - program.start) / 1000)) : 0, [program?.id, program?.start, sessionReady, restart, transcode]);
  const subtitles = useSubtitleCues(captions && chosen?.subtitleId);
  const [subtitleStyle] = useSubtitleStyle();

  // Prepare the next program shortly before it starts so the change of program is seamless.
  useEffect(() => {
    if (!lineup || !program) return;
    const next = lineup.find(item => item.start === program.end);
    if (!next?.catalog) return;
    const timer = setTimeout(() => { fetch(`/api/v1/assets/${next.id}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caps: detectCaps() }) }).catch(() => {}); }, Math.max(0, program.end - 45_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [lineup, program?.id, program?.start]);

  // Stay on the broadcast clock: after a program ends (or playback fell behind), play what is airing now.
  const advance = () => {
    const live = lineup && airing(lineup, Date.now());
    if (live && live.start !== airingStart) setAiringStart(live.start);
    else if (program && lineup.some(item => item.start === program.end)) setAiringStart(program.end);
    else sync();
  };
  const liveSeconds = () => Math.max(0, (Date.now() - program.start) / 1000);
  const playMuted = media => media.play().catch(() => { media.muted = true; setMuted(true); media.play().catch(() => {}); });
  const playLive = media => {
    // A repackaged stream already begins at the live position.
    if (!plan.remux) media.currentTime = liveSeconds();
    // Browsers block sound until the page has been interacted with; fall back to muted playback.
    playMuted(media);
  };
  const start = event => {
    const media = event.currentTarget;
    const total = plan.remux && info?.durationMs ? info.durationMs / 1000 : media.duration;
    if (Number.isFinite(total) && liveSeconds() >= total - 1) { advance(); return; }
    playLive(media);
  };
  // Phones pause video while the browser is in the background; on return, rejoin the broadcast where it is now.
  const catchUp = () => {
    const live = lineup && airing(lineup, Date.now());
    if (!live) { if (lineup) sync(); return; }
    if (live.start !== airingStart) { setAiringStart(live.start); return; }
    if (plan.remux) { setRestart(value => value + 1); return; }
    if (video.current?.readyState >= 1) playLive(video.current);
  };
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") catchUpRef.current(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("pageshow", onVisible); };
  }, []);
  // Playback that resumes behind (a stall, or a pause in the system player) jumps back to live.
  const keepLive = event => {
    const here = (plan.remux ? streamStart : 0) + event.currentTarget.currentTime;
    if (Math.abs(liveSeconds() - here) <= 5) return;
    if (plan.remux) setRestart(value => value + 1); else event.currentTarget.currentTime = liveSeconds();
  };
  const countView = () => {
    const key = `${program.id}:${program.start}`;
    if (counted.current === key) return;
    counted.current = key;
    api(`/api/v1/assets/${program.id}/views`, { method: "POST", body: JSON.stringify({ sessionId: crypto.randomUUID() }) }).catch(() => {});
  };
  const onVideoError = event => {
    // Video the browser cannot decode is re-encoded by the server, once.
    if (program?.catalog && !transcode && [3, 4].includes(event.currentTarget.error?.code)) { setTranscode(true); setRestart(value => value + 1); return; }
    setFailed(true);
  };
  const toggleMute = () => { const next = !muted; setMuted(next); if (video.current) video.current.muted = next; };
  const toggleFullscreen = () => document.fullscreenElement ? document.exitFullscreen() : shell.current?.requestFullscreen?.();
  const base = program ? `/api/v1/assets/${program.id}/file` : "";
  const src = program && (plan.remux ? remuxUrl(base, plan, streamStart) : base);
  const tuning = program && session.phase === "loading";
  const unavailable = program && session.phase === "error";

  return <div className="guide-screen">
    <div ref={shell} className={`guide-player ${fullscreen ? "is-fullscreen" : ""}`} onDoubleClick={toggleFullscreen}>
      {program?.thumbnail_url && <img src={program.thumbnail_url} alt="" />}
      {program && sessionReady && !failed && <video ref={video} key={`${program.id}:${program.start}:${restart}`} src={src} muted={muted} playsInline disablePictureInPicture preload="auto"
        onLoadedMetadata={start} onPlaying={event => { countView(); keepLive(event); }} onEnded={advance} onError={onVideoError}
        onTimeUpdate={event => setTime((plan.remux ? streamStart : 0) + event.currentTarget.currentTime)} />}
      {sessionReady && !failed && captions && chosen?.subtitleId && <SubtitleLayer cues={subtitles.cues} time={time} size={subtitleStyle.size} background={subtitleStyle.background} />}
      {tuning && <div className="guide-player-message" role="status"><p>Tuning in… {session.stage}</p></div>}
      {unavailable && <div className="guide-player-message" role="alert"><p>{session.error.message}</p>{session.error.code === "not-configured" ? <a className="outline-button" href="/settings#streaming">Open streaming settings</a> : <button className="outline-button" onClick={() => session.retry()}>Try again</button>}</div>}
      {lineup && !program && <p className="guide-player-message">Nothing is airing on this channel right now.</p>}
      {failed && <div className="guide-player-message"><p>This video can't play here.</p><button className="outline-button" onClick={() => navigate(`/watch/${program.id}?t=${liveOffset(program, Date.now()) ?? 0}`)}><ArrowSquareOut size={16} /> Open in player</button></div>}
      <div className="guide-player-bar">
        <span className="guide-live-pill"><Broadcast size={13} weight="fill" /> Live</span>
        <span className="guide-player-title"><strong>{channel.number} · {channel.name}</strong>{program && <small>{program.subtitle ? `${program.title} · ${program.subtitle}` : program.title}</small>}</span>
        {chosen?.subtitleId && <button className="guide-player-button" onClick={() => setCaptions(value => !value)} aria-pressed={captions} aria-label={captions ? "Turn subtitles off" : "Turn subtitles on"} title={captions ? "Subtitles on" : "Subtitles off"}><ClosedCaptioning size={17} weight={captions ? "fill" : "regular"} /></button>}
        <button className="guide-player-button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>{muted ? <SpeakerSlash size={17} weight="fill" /> : <SpeakerHigh size={17} weight="fill" />}</button>
        <button className="guide-player-button" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit full screen" : "Full screen"} title={fullscreen ? "Exit full screen" : "Full screen"}>{fullscreen ? <CornersIn size={17} /> : <CornersOut size={17} />}</button>
      </div>
    </div>
    {program && <LiveActions key={program.id} api={api} id={program.id} navigate={navigate} />}
  </div>;
}

// Like and tag whatever is airing, below the picture rather than on top of it.
function LiveActions({ api, id, navigate }) {
  const [asset, setAsset] = useState(null);
  useEffect(() => {
    let active = true;
    api(`/api/v1/assets/${id}`).then(value => { if (active) setAsset(value); }).catch(() => {});
    return () => { active = false; };
  }, [api, id]);
  if (!asset) return <div className="guide-live-actions" aria-busy="true" />;
  const update = values => setAsset(current => ({ ...current, ...values }));
  return <div className="guide-live-actions" aria-label={`Now playing: ${asset.title}`} role="group">
    <LikeButton asset={asset} api={api} onChange={update} />
    <div className="watch-topics guide-live-tags">
      {asset.topics?.map(topic => <a key={topic.id} href={`/topic/${topic.slug}`} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(`/topic/${topic.slug}`); }}><TopicLabel topic={topic} /></a>)}
    </div>
    <AddTag asset={asset} api={api} onChange={topics => update({ topics })} />
  </div>;
}

function GuideEmpty({ filter, q, create }) {
  const [title, message] = q ? ["No channels match", "Try another channel number or name."]
    : ["media", "genres", "services"].includes(filter) ? ["Nothing on these channels yet", "Add movies, shows, or anime to My list and they join the guide, grouped by genre and service."]
    : filter === "custom" ? ["You haven't made a channel yet", "Combine tags into a channel that plays everything they share."]
    : ["No channels yet", "Any tag on three or more videos becomes a channel automatically."];
  return <div className="empty guide-empty"><Television size={38} /><h2>{title}</h2><p>{message}</p>{!q && <button className="primary-button" onClick={create}><Plus size={17} /> New channel</button>}</div>;
}
