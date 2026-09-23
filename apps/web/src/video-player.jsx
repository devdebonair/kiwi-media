"use client";

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, SpeakerHigh, SpeakerSlash, ArrowsOut, DownloadSimple, ArrowClockwise, ArrowCounterClockwise } from '@phosphor-icons/react';

const time = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

export function VideoPlayer({ asset, mediaRef, initialSeconds = 0 }) {
  const original = `/api/v1/assets/${asset.id}/file`;
  const shell = useRef(null);
  const resume = useRef(initialSeconds);
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

  const convert = () => {
    resume.current = mediaRef.current?.currentTime || initialSeconds;
    mediaRef.current?.pause();
    setFailed(false); setWaiting(false); setPreparing(true);
    setMessage('Preparing a compatible version…');
  };
  const toggle = () => {
    const video = mediaRef.current;
    if (!video || preparing || failed) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  };
  const seek = value => {
    if (!duration) return;
    const target = Math.max(0, Math.min(duration, value));
    setPosition(target);
    mediaRef.current.currentTime = target;
  };
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shell.current.requestFullscreen) await shell.current.requestFullscreen();
      else mediaRef.current.webkitEnterFullscreen?.();
    } catch { /* Fullscreen may be disabled by the embedding browser. */ }
  };
  return <div className="kiwi-player" ref={shell} role="region" aria-label="Video player" tabIndex={0} onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if ([' ', 'k', 'ArrowLeft', 'ArrowRight', 'm', 'f'].includes(event.key)) event.preventDefault();
    if (event.key === ' ' || event.key === 'k') toggle();
    if (event.key === 'ArrowLeft') seek(position - 10);
    if (event.key === 'ArrowRight') seek(position + 10);
    if (event.key === 'm') mediaRef.current.muted = !mediaRef.current.muted;
    if (event.key === 'f') fullscreen();
  }}>
    <div className="kiwi-screen">
      <video ref={mediaRef} src={compatible ? `${original}?compatible=1` : original} poster={asset.thumbnail_url} autoPlay playsInline preload="metadata"
        onClick={toggle} onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)} onCanPlay={() => setWaiting(false)}
        onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
        onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onVolumeChange={event => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); }}
        onLoadedMetadata={event => { if (compatible) event.currentTarget.currentTime = Math.min(resume.current, event.currentTarget.duration || resume.current); event.currentTarget.playbackRate = rate; }}
        onError={event => {
          if (!compatible && [3, 4].includes(event.currentTarget.error?.code)) convert();
          else { setFailed(true); setWaiting(false); setMessage('This video could not load. Try again or download the original.'); }
        }} />
      {(preparing || failed) ? <div className="kiwi-status" role="status"><span className="kiwi-status-mark">{failed ? '!' : '◌'}</span><strong>{failed ? 'Playback unavailable' : 'Getting your video ready'}</strong><p>{message}</p>{failed && <button onClick={() => { setFailed(false); setMessage(''); mediaRef.current.load(); }}> <ArrowClockwise size={18} /> Try again</button>}<a href={original} download>Download original</a></div>
        : !playing ? <button className="kiwi-big-play" aria-label="Play video" onClick={toggle}><Play size={30} weight="fill" /></button>
        : waiting && <span className="kiwi-buffering" role="status">Buffering…</span>}
    </div>
    <div className="kiwi-controls">
      <input className="kiwi-seek" aria-label="Seek video" aria-valuetext={`${time(position)} of ${time(duration)}`} type="range" min="0" max={duration || 1} step="0.1" value={Math.min(position, duration || 1)} disabled={!duration || preparing || failed} onInput={event => seek(Number(event.currentTarget.value))} style={{ '--progress': `${duration ? position / duration * 100 : 0}%` }} />
      <div className="kiwi-control-row">
        <button aria-label={playing ? 'Pause' : 'Play'} disabled={preparing || failed} onClick={toggle}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button>
        <button className="kiwi-skip" aria-label="Back 10 seconds" onClick={() => seek(position - 10)}><ArrowCounterClockwise /></button>
        <span className="kiwi-time">{time(position)} <span>/ {time(duration)}</span></span>
        <div className="kiwi-control-spacer" />
        <button aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => { mediaRef.current.muted = !muted; }}>{muted || volume === 0 ? <SpeakerSlash /> : <SpeakerHigh />}</button>
        <input className="kiwi-volume" type="range" aria-label="Volume" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={event => { mediaRef.current.volume = Number(event.target.value); mediaRef.current.muted = false; }} />
        <select aria-label="Playback speed" value={rate} onChange={event => { const value = Number(event.target.value); setRate(value); mediaRef.current.playbackRate = value; }}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select>
        <a href={original} download aria-label="Download original" title="Download original"><DownloadSimple /></a>
        <button aria-label="Fullscreen" onClick={fullscreen}><ArrowsOut /></button>
      </div>
      <div className="kiwi-player-footer"><span><i /> {compatible ? 'Compatible playback' : 'Original quality'}</span>{!compatible && <button disabled={preparing} onClick={convert}>Playback issues? Use compatibility mode</button>}</div>
    </div>
  </div>;
}
