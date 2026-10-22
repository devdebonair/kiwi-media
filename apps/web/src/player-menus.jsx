"use client";

import { useEffect, useState } from "react";
import { ArrowClockwise, Check, MagnifyingGlass, Minus, Plus, SpinnerGap } from "@phosphor-icons/react";
import { SUBTITLE_BACKGROUNDS, SUBTITLE_SIZES } from "./subtitle-layer.jsx";

const gigabytes = bytes => bytes ? `${(bytes / 1024 ** 3).toFixed(bytes > 10 * 1024 ** 3 ? 0 : 1)} GB` : null;
const originLabel = { embedded: "in file", sidecar: "file", external: "online" };

export function SubtitleMenu({ tracks, selectedId, status, onSelect, style, onStyle, delay, onDelay, canSearch, onSearch, searching, searchError }) {
  return <div className="player-menu" role="menu" aria-label="Subtitles">
    <h3>Subtitles</h3>
    <button role="menuitemradio" aria-checked={!selectedId} className={!selectedId ? "is-selected" : ""} onClick={() => onSelect(null)}><span>Off</span>{!selectedId && <Check size={16} />}</button>
    {tracks.map(track => {
      const unusable = track.status === "unsupported" || track.status === "failed";
      return <button key={track.id} role="menuitemradio" aria-checked={selectedId === track.id} disabled={unusable} className={selectedId === track.id ? "is-selected" : ""} onClick={() => onSelect(track.id)} title={track.status === "unsupported" ? "Image-based subtitles can't be shown" : track.error || undefined}>
        <span>{track.label || "Subtitles"}<small>{track.status === "unsupported" ? "image-based" : track.status === "failed" ? "unavailable" : originLabel[track.origin]}</small></span>
        {selectedId === track.id ? (status === "loading" ? <SpinnerGap size={16} className="spin" /> : <Check size={16} />) : null}
      </button>;
    })}
    {!tracks.length && <p className="player-menu-note">This video has no subtitle tracks.</p>}
    {canSearch && <button className="player-menu-action" onClick={onSearch} disabled={searching}>{searching ? <SpinnerGap size={16} className="spin" /> : <MagnifyingGlass size={16} />}<span>Search online</span></button>}
    {searchError && <p className="player-menu-note" role="alert">{searchError}</p>}
    {status === "failed" && <p className="player-menu-note" role="alert">That subtitle couldn't be loaded.</p>}
    <div className="player-menu-group" role="group" aria-label="Subtitle appearance">
      <span>Size</span>
      <div className="segmented">{SUBTITLE_SIZES.map(([value, label]) => <button key={value} aria-pressed={style.size === value} onClick={() => onStyle({ size: value })} title={label}>{{ s: "A", m: "A", l: "A", xl: "A" }[value]}<i className={`size-${value}`} /></button>)}</div>
    </div>
    <div className="player-menu-group" role="group" aria-label="Subtitle background">
      <span>Style</span>
      <div className="segmented text">{SUBTITLE_BACKGROUNDS.map(([value, label]) => <button key={value} aria-pressed={style.background === value} onClick={() => onStyle({ background: value })}>{label}</button>)}</div>
    </div>
    <div className="player-menu-group" role="group" aria-label="Subtitle timing">
      <span>Timing</span>
      <div className="stepper">
        <button aria-label="Show subtitles earlier" onClick={() => onDelay(Math.round((delay - 0.5) * 10) / 10)}><Minus size={14} /></button>
        <output>{delay === 0 ? "In sync" : `${delay > 0 ? "+" : ""}${delay.toFixed(1)}s`}</output>
        <button aria-label="Show subtitles later" onClick={() => onDelay(Math.round((delay + 0.5) * 10) / 10)}><Plus size={14} /></button>
        {delay !== 0 && <button className="reset" onClick={() => onDelay(0)}>Reset</button>}
      </div>
    </div>
  </div>;
}

export function AudioMenu({ tracks, selected, onSelect, repackaged }) {
  return <div className="player-menu" role="menu" aria-label="Audio">
    <h3>Audio</h3>
    {tracks.map(track => <button key={track.position} role="menuitemradio" aria-checked={selected === track.position} className={selected === track.position ? "is-selected" : ""} onClick={() => onSelect(track)}>
      <span>{track.label}<small>{track.codec}</small></span>{selected === track.position && <Check size={16} />}
    </button>)}
    {repackaged && <p className="player-menu-note">Audio is switched on the server, so seeking may pause for a moment.</p>}
  </div>;
}

export function SourceMenu({ api, assetId, current, onPick, onSearchAgain }) {
  const [sources, setSources] = useState(null);
  useEffect(() => { api(`/api/v1/assets/${assetId}/sources`).then(result => setSources(result.sources)).catch(() => setSources([])); }, [api, assetId, current?.id]);
  const line = source => [source.resolution && `${source.resolution}p`, source.source, source.codec && source.codec.toUpperCase(), gigabytes(source.size), source.group].filter(Boolean).join(" · ");
  return <div className="player-menu wide" role="menu" aria-label="Source">
    <h3>Source</h3>
    {current && <div className="source-current">
      <strong>{line(current) || current.releaseName}</strong>
      <small title={current.releaseName}>{current.releaseName}</small>
      <ul>{current.reasons.filter(reason => reason.points > 0 && reason.label !== "instant on TorBox").slice(0, 4).map(reason => <li key={reason.label}>{reason.label}</li>)}{current.cached && <li>instant</li>}</ul>
    </div>}
    {sources === null ? <p className="player-menu-note"><SpinnerGap size={14} className="spin" /> Loading other sources…</p>
      : sources.filter(source => !source.selected).map(source => <button key={source.id} role="menuitem" onClick={() => onPick(source)} title={source.releaseName}>
        <span>{line(source) || source.releaseName}<small>{source.releaseName}</small></span>
      </button>)}
    <button className="player-menu-action" onClick={onSearchAgain}><ArrowClockwise size={16} /><span>Search for sources again</span></button>
  </div>;
}
