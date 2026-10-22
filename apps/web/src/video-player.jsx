"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, SpeakerHigh, SpeakerSlash, ArrowsOut, ArrowsOutLineHorizontal, ArrowsInLineHorizontal, DownloadSimple, ArrowClockwise, ArrowCounterClockwise, PictureInPicture, SkipBack, SkipForward, ClosedCaptioning, Translate, GearSix } from '@phosphor-icons/react';
import { usePlaybackSession } from './playback-session.jsx';
import { SubtitleLayer, useSubtitleCues, useSubtitleStyle } from './subtitle-layer.jsx';
import { AudioMenu, SourceMenu, SubtitleMenu } from './player-menus.jsx';
import { applyPreference, loadPreference, savePreference } from './track-preferences.mjs';
import { bufferedEndOf, createTimelineMedia, planSeek } from './timeline-media.mjs';
import { detectEnvironment, planPlayback, remuxUrl } from './playback-plan.mjs';

const time = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0)), h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export function VideoPlayer({ asset, api, mediaRef, initialSeconds = 0, onEnded, onMinimize, onPlay, onPrevious, onNext, onToggleTheater, theater = false, autoPlay = true, onMediaChange }) {
  const catalog = Boolean(asset.catalog);
  const original = `/api/v1/assets/${asset.id}/file`;
  const prefKey = catalog ? `title:${asset.catalog.titleId}` : `asset:${asset.id}`;
  const session = usePlaybackSession({ asset, api });
  const info = session.info;
  const shell = useRef(null);
  const video = useRef(null);
  const resume = useRef(initialSeconds);
  const pendingSeek = useRef(null);
  const keepPlaying = useRef(false);
  const controlsTimer = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [compatible, setCompatible] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);

  // Audio and subtitle choices. A series remembers what you picked, so the next episode starts the same way.
  const [applied, setApplied] = useState(false);
  const [audioPos, setAudioPos] = useState(null);
  const [subtitleId, setSubtitleId] = useState(null);
  const [subtitleTracks, setSubtitleTracks] = useState([]);
  const [offset, setOffset] = useState(0);
  const [transcode, setTranscode] = useState(false);
  const [menu, setMenu] = useState(null);
  const [subtitleStyle, updateSubtitleStyle] = useSubtitleStyle();
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const lastSubtitle = useRef(null);

  useEffect(() => {
    setApplied(false); setTranscode(false); setMenu(null); setSearchError('');
    if (!info) { setSubtitleTracks([]); setAudioPos(null); setSubtitleId(null); return; }
    const chosen = applyPreference(info, loadPreference(prefKey));
    setSubtitleTracks(info.subtitles);
    // Home videos keep the file's own audio unless you pick another; catalog items start in your language order.
    setAudioPos(catalog ? chosen.audioPosition : null);
    setSubtitleId(chosen.subtitleId);
    if (chosen.subtitleId) lastSubtitle.current = chosen.subtitleId;
    const start = Math.floor(pendingSeek.current ?? resume.current ?? 0);
    setOffset(start); setPosition(start);
    setApplied(true);
  }, [info, prefKey, catalog]);

  // Files that need a subtitle in your language and have none are searched online by the server; adopt the result when it lands.
  useEffect(() => {
    if (!info?.needsExternalSubtitles || !applied) return;
    let active = true, tries = 0;
    const poll = async () => {
      try {
        const { subtitles } = await api(`/api/v1/assets/${asset.id}/subtitles`);
        if (!active) return;
        const online = subtitles.find(track => track.origin === 'external' && track.status !== 'failed');
        if (online) {
          setSubtitleTracks(current => current.some(track => track.id === online.id) ? current : [...current, online]);
          if (loadPreference(prefKey)?.subtitle !== 'off') { setSubtitleId(current => current ?? online.id); lastSubtitle.current = online.id; }
          return;
        }
      } catch { /* Try again shortly. */ }
      if (active && ++tries < 8) setTimeout(poll, 4000);
    };
    const timer = setTimeout(poll, 2500);
    return () => { active = false; clearTimeout(timer); };
  }, [info, applied, asset.id, api, prefKey]);

  const audioTracks = info?.audio || [];
  const [env] = useState(() => detectEnvironment());
  const plan = planPlayback(info, { audioPosition: audioPos, transcode, env });
  const { remux, defaultAudio, audio: selectedAudio } = plan;
  const videoNeedsTranscode = plan.video === 'transcode';
  const ready = session.phase === 'ready' && (!catalog || applied);
  const total = remux && info?.durationMs ? info.durationMs / 1000 : duration;
  const src = remux ? remuxUrl(original, plan, offset) : compatible ? `${original}?compatible=1` : original;

  // Repackaged playback restarts at an offset; these let the rest of the app see real positions in the movie.
  const live = useRef({});
  live.current = { remux, offset, total, position };
  const seekTo = useCallback(value => {
    const el = video.current, state = live.current;
    if (!el) return;
    const target = Math.max(0, Math.min(state.total || Infinity, value));
    setPosition(target);
    if (!state.remux) { el.currentTime = target; return; }
    const plan = planSeek({ target, offset: state.offset, bufferedEnd: bufferedEndOf(el) });
    if (plan.type === 'local') el.currentTime = plan.time;
    else { keepPlaying.current = true; setOffset(Math.floor(plan.offset)); }
  }, []);
  const attach = useCallback(node => {
    video.current = node;
    onMediaChange?.(Boolean(node));
    mediaRef.current = node ? createTimelineMedia(node, {
      position: () => (live.current.remux ? live.current.offset : 0) + (video.current?.currentTime || 0),
      duration: () => live.current.remux && live.current.total ? live.current.total : null,
      seek: value => seekTo(value),
    }) : null;
  }, [mediaRef, seekTo, onMediaChange]);

  const subtitles = useSubtitleCues(subtitleId);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === shell.current;
      setIsFullscreen(active);
      setControlsVisible(!active);
      clearTimeout(controlsTimer.current);
      if (active && shell.current?.querySelector('.kiwi-controls')?.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      clearTimeout(controlsTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = event => { if (!event.target.closest?.('.player-menu, [data-menu-button]')) setMenu(null); };
    const escape = event => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);

  const revealControls = () => {
    if (document.fullscreenElement !== shell.current) return;
    setControlsVisible(true);
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setControlsVisible(false), 1800);
  };

  // Compatibility mode for home videos the browser rejected: a full converted copy prepared on the server.
  useEffect(() => {
    if (!preparing) return;
    let stopped = false, timer;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/assets/${asset.id}/playback`, { method: 'POST', signal: controller.signal });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(response.status === 404 && detail.message?.includes('Route ')
            ? 'The playback service needs to be restarted to enable compatibility mode.'
            : detail.error === 'Original file is unavailable'
              ? 'The original file is unavailable. Check that its media drive is connected.'
              : 'The playback service is unavailable. Please try again.');
        }
        const result = await response.json();
        if (stopped) return;
        if (result.status === 'ready') { setCompatible(true); setPreparing(false); setMessage(''); }
        else if (result.status === 'failed') throw new Error();
        else {
          setMessage(result.status === 'busy' ? 'Waiting to prepare your video…' : 'Preparing a compatible version. Larger videos may take a few minutes.');
          timer = setTimeout(poll, 2000);
        }
      } catch (error) {
        if (!stopped) { setPreparing(false); setFailed(true); setMessage(error.message || 'Unable to prepare this video. Try again or download the original.'); }
      }
    };
    poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [preparing, asset.id]);

  // Catalog items and repackaged playback convert on the fly; local files use the prepared copy.
  const convert = () => {
    const here = live.current.position || (video.current?.currentTime ?? 0);
    resume.current = here;
    video.current?.pause();
    setFailed(false); setWaiting(false);
    if (catalog || remux) { keepPlaying.current = true; setOffset(Math.floor(here)); setTranscode(true); setMessage(''); return; }
    setPreparing(true);
    setMessage('Preparing a compatible version…');
  };
  const toggle = () => {
    const el = video.current;
    if (!el || preparing || failed) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  };
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shell.current.requestFullscreen) await shell.current.requestFullscreen();
      else video.current.webkitEnterFullscreen?.();
    } catch { /* Fullscreen may be disabled by the embedding browser. */ }
  };

  const chooseSubtitle = id => {
    setSubtitleId(id); setMenu(null);
    if (id) lastSubtitle.current = id;
    const track = subtitleTracks.find(item => item.id === id);
    savePreference(prefKey, { subtitle: id ? track?.language || 'off' : 'off' });
  };
  const chooseAudio = track => {
    setMenu(null);
    if (track.position === selectedAudio) return;
    keepPlaying.current = !video.current?.paused;
    setOffset(Math.floor(live.current.position));
    setAudioPos(track.position);
    savePreference(prefKey, { audio: track.language || undefined });
  };
  const searchOnline = async () => {
    setSearching(true); setSearchError('');
    try {
      const { track } = await api(`/api/v1/assets/${asset.id}/subtitles/search`, { method: 'POST', body: JSON.stringify({}) });
      setSubtitleTracks(current => current.some(item => item.id === track.id) ? current : [...current, track]);
      chooseSubtitle(track.id);
    } catch (error) { setSearchError(error.message); }
    finally { setSearching(false); }
  };
  const switchSource = options => {
    pendingSeek.current = live.current.position;
    keepPlaying.current = !video.current?.paused;
    setMenu(null);
    session.retry(options);
  };
  const toggleSubtitles = () => chooseSubtitle(subtitleId ? null : lastSubtitle.current || subtitleTracks.find(track => track.status !== 'unsupported' && !track.forced)?.id || null);

  const stage = session.phase === 'error' ? null : session.stage || 'Finding the best source…';
  const screenReady = ready && !(preparing || failed);
  const menuButton = (name, label, Icon) => <button data-menu-button aria-label={label} title={label} aria-haspopup="menu" aria-expanded={menu === name} className={menu === name ? 'is-open' : ''} onClick={() => setMenu(current => current === name ? null : name)}><Icon /></button>;

  return <div className="kiwi-player" ref={shell} role="region" aria-label="Video player" tabIndex={0}
    onPointerMove={event => { if (event.pointerType === 'mouse') revealControls(); }}
    onPointerDown={event => { if (event.pointerType !== 'mouse') revealControls(); }}
    onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if ([' ', 'k', 'ArrowLeft', 'ArrowRight', 'm', 'f', 'c'].includes(event.key)) event.preventDefault();
    if (event.key === ' ' || event.key === 'k') toggle();
    if (event.key === 'ArrowLeft') seekTo(position - 10);
    if (event.key === 'ArrowRight') seekTo(position + 10);
    if (event.key === 'm' && video.current) video.current.muted = !video.current.muted;
    if (event.key === 'f') fullscreen();
    if (event.key === 'c') toggleSubtitles();
  }}>
    <div className="kiwi-screen">
      {ready ? <video key={asset.id} ref={attach} src={src} poster={asset.thumbnail_url} autoPlay={autoPlay} playsInline preload="metadata"
        onClick={toggle} onDoubleClick={fullscreen}
        onPlay={() => { setPlaying(true); onPlay?.(); }} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); onEnded?.(); }}
        onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)} onCanPlay={() => setWaiting(false)}
        onTimeUpdate={event => setPosition((live.current.remux ? live.current.offset : 0) + event.currentTarget.currentTime)}
        onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onVolumeChange={event => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); }}
        onLoadedMetadata={event => {
          const el = event.currentTarget;
          if (compatible && !remux) el.currentTime = Math.min(resume.current, el.duration || resume.current);
          // A new source for the same item resumes where the old one stopped.
          else if (!remux && pendingSeek.current != null) { el.currentTime = Math.min(pendingSeek.current, el.duration || pendingSeek.current); }
          pendingSeek.current = null;
          el.playbackRate = rate;
          if (keepPlaying.current) { keepPlaying.current = false; el.play().catch(() => {}); }
        }}
        onError={event => {
          const code = event.currentTarget.error?.code;
          if ((catalog || remux) && !transcode && info && [3, 4].includes(code)) convert();
          else if (!catalog && !remux && !compatible && [3, 4].includes(code)) convert();
          else { setFailed(true); setWaiting(false); setMessage('This video could not load. Try again or download the original.'); }
        }} />
        : <div className="kiwi-placeholder">{asset.thumbnail_url && <img src={asset.thumbnail_url} alt="" />}</div>}
      {screenReady && subtitleId && <SubtitleLayer cues={subtitles.cues} time={position - subtitleDelay} size={subtitleStyle.size} background={subtitleStyle.background} raised={isFullscreen && controlsVisible} />}
      {session.phase === 'loading' ? <div className="kiwi-status" role="status"><span className="kiwi-status-mark spin">◌</span><strong>Getting your video ready</strong><p>{stage}</p></div>
        : session.phase === 'error' ? <div className="kiwi-status" role="alert"><span className="kiwi-status-mark">!</span><strong>Playback unavailable</strong><p>{session.error.message}</p>
          <div className="kiwi-status-actions">
            {session.error.code === 'not-configured' ? <a className="kiwi-status-link" href="/settings#streaming">Open streaming settings</a> : <>
              <button onClick={() => session.retry()}><ArrowClockwise size={18} /> Try again</button>
              {session.error.code !== 'network' && <button onClick={() => session.retry({ rediscover: true })}>Search again</button>}</>}
          </div></div>
        : (preparing || failed) ? <div className="kiwi-status" role="status"><span className="kiwi-status-mark">{failed ? '!' : '◌'}</span><strong>{failed ? 'Playback unavailable' : 'Getting your video ready'}</strong><p>{message}</p>{failed && <button onClick={() => { setFailed(false); setMessage(''); if (catalog) session.retry(); else video.current?.load(); }}> <ArrowClockwise size={18} /> Try again</button>}{!catalog && <a href={original} download>Download original</a>}</div>
        : ready && !playing ? <button className="kiwi-big-play" aria-label="Play video" onClick={toggle}><Play size={30} weight="fill" /></button>
        : waiting && <span className="kiwi-buffering" role="status">Buffering…</span>}
    </div>
    <div className={`kiwi-controls ${isFullscreen && controlsVisible ? 'controls-visible' : ''}`}>
      {menu === 'subtitles' && <SubtitleMenu tracks={subtitleTracks} selectedId={subtitleId} status={subtitles.status} onSelect={chooseSubtitle} style={subtitleStyle} onStyle={updateSubtitleStyle} delay={subtitleDelay} onDelay={setSubtitleDelay}
        canSearch={Boolean(info?.onlineSubtitles)} onSearch={searchOnline} searching={searching} searchError={searchError} />}
      {menu === 'audio' && <AudioMenu tracks={audioTracks} selected={selectedAudio} onSelect={chooseAudio} repackaged={remux || selectedAudio !== defaultAudio} />}
      {menu === 'source' && catalog && <SourceMenu api={api} assetId={asset.id} current={info?.source} onPick={source => switchSource({ sourceId: source.id })} onSearchAgain={() => switchSource({ rediscover: true })} />}
      <input className="kiwi-seek" aria-label="Seek video" aria-valuetext={`${time(position)} of ${time(total)}`} type="range" min="0" max={total || 1} step="0.1" value={Math.min(position, total || 1)} disabled={!total || preparing || failed || !ready} onInput={event => seekTo(Number(event.currentTarget.value))} style={{ '--progress': `${total ? position / total * 100 : 0}%` }} />
      <div className="kiwi-control-row">
        <button aria-label="Previous" title={asset.catalog?.previous ? 'Previous episode' : 'Previous video in playlist'} disabled={!onPrevious} onClick={onPrevious}><SkipBack weight="fill" /></button>
        <button aria-label={playing ? 'Pause' : 'Play'} disabled={preparing || failed || !ready} onClick={toggle}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button>
        <button aria-label="Next" title={asset.catalog?.next ? 'Next episode' : 'Next video in playlist'} disabled={!onNext} onClick={onNext}><SkipForward weight="fill" /></button>
        <button className="kiwi-skip" aria-label="Back 10 seconds" onClick={() => seekTo(position - 10)}><ArrowCounterClockwise /></button>
        <span className="kiwi-time">{time(position)} <span>/ {time(total)}</span></span>
        <div className="kiwi-control-spacer" />
        <button aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => { if (video.current) video.current.muted = !muted; }}>{muted || volume === 0 ? <SpeakerSlash /> : <SpeakerHigh />}</button>
        <input className="kiwi-volume" type="range" aria-label="Volume" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={event => { if (video.current) { video.current.volume = Number(event.target.value); video.current.muted = false; } }} />
        {(subtitleTracks.length > 0 || info?.onlineSubtitles) && <span className={subtitleId ? 'is-on' : ''}>{menuButton('subtitles', 'Subtitles', ClosedCaptioning)}</span>}
        {audioTracks.length > 1 && menuButton('audio', 'Audio track', Translate)}
        {catalog && info?.source && menuButton('source', 'Source', GearSix)}
        <select aria-label="Playback speed" value={rate} onChange={event => { const value = Number(event.target.value); setRate(value); if (video.current) video.current.playbackRate = value; }}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select>
        {!catalog && <a href={original} download aria-label="Download original" title="Download original"><DownloadSimple /></a>}
        {onMinimize && <button aria-label="Minimize player" title="Minimize player" onClick={onMinimize}><PictureInPicture /></button>}
        {onToggleTheater && <button aria-label={theater ? 'Exit theater mode' : 'Theater mode'} title={theater ? 'Exit theater mode' : 'Theater mode'} aria-pressed={theater} onClick={onToggleTheater}>{theater ? <ArrowsInLineHorizontal /> : <ArrowsOutLineHorizontal />}</button>}
        <button aria-label="Fullscreen" onClick={fullscreen}><ArrowsOut /></button>
      </div>
      <div className="kiwi-player-footer"><span><i /> {catalog && info?.source ? `${info.source.resolution ? `${info.source.resolution}p ` : ''}${info.source.source || 'stream'}${remux ? (videoNeedsTranscode ? ' · converted for this browser' : ' · audio switched') : ''}` : remux ? (videoNeedsTranscode ? 'Converted for this browser' : 'Audio switched') : compatible ? 'Compatible playback' : 'Original quality'}</span>{!compatible && !transcode && ready && <button disabled={preparing} onClick={convert}>Playback issues? Use compatibility mode</button>}</div>
    </div>
  </div>;
}
