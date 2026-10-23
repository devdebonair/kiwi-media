"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Broadcast, Leaf, Rows, SpeakerHigh } from "@phosphor-icons/react";
import { clock, halfHour, programAt, slots, span } from "./guide-time.mjs";

// The guide shows an hour and a half and three channels at a time, like a TV's on-screen guide.
const WINDOW = 90 * 60_000, ROWS = 3;
// The guide fades away when left alone; after flipping channels only the program line shows, briefly.
const IDLE_MS = 12_000, PEEK_MS = 4_000;
const MOVES = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

// Live TV across the whole window: the tuned channel plays behind an on-screen guide that is driven like a
// remote. Up/down change the channel row, left/right move through time, Enter tunes, Esc hides the guide.
// With the guide hidden, up/down flip channels directly.
export function TheaterGuide({ channels, total, channel, program, tuned, now, start, end, select, tune, tuneChannel, loadMore, exit, setControls, toggleFullscreen, navigate, Logo }) {
  const [mode, setMode] = useState("full");
  const [view, setView] = useState(() => halfHour(now));
  const timer = useRef(null), lastWheel = useRef(0);
  const row = Math.max(0, channels.findIndex(item => item.key === channel?.key));
  const viewEnd = view + WINDOW;

  const wake = useCallback((to = "full") => {
    setMode(to);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMode("hidden"), to === "peek" ? PEEK_MS : IDLE_MS);
  }, []);
  const hide = useCallback(() => { clearTimeout(timer.current); setMode("hidden"); }, []);
  useEffect(() => { wake(); return () => clearTimeout(timer.current); }, [wake]);

  // The visible hour and a half follows the selection and stays inside the loaded schedule.
  useEffect(() => {
    setView(current => {
      const low = start, high = Math.max(start, end - WINDOW);
      let next = Math.min(Math.max(current, low), high);
      if (program && (program.start >= next + WINDOW || program.end <= next)) next = Math.min(Math.max(halfHour(Math.max(program.start, start)), low), high);
      return next;
    });
  }, [program?.start, start, end]);

  // Moves the selection like the guide grid: through a channel's lineup, or to the same time on the next channel.
  const move = (key, state) => {
    const { channels, row, program, start, end, view } = state;
    if (!program || !channels.length) return;
    let targetRow = row, target = null;
    const lineup = channels[row].programs, index = lineup.findIndex(item => item.start === program.start);
    if (key === "ArrowRight") target = lineup[index + 1]?.start < end ? lineup[index + 1] : null;
    else if (key === "ArrowLeft") target = lineup[index - 1]?.end > start ? lineup[index - 1] : null;
    else {
      targetRow = row + (key === "ArrowDown" ? 1 : -1);
      target = channels[targetRow] ? programAt(channels[targetRow].programs, Math.max(program.start, view, start)) : null;
    }
    if (targetRow >= channels.length - ROWS && channels.length < state.total) state.loadMore();
    if (target) state.select(channels[targetRow], target);
  };
  // Flips to the channel above or below the one playing, like pressing channel up/down on a remote.
  const surf = (key, state) => {
    const { channels, tuned } = state;
    const index = channels.findIndex(item => item.key === tuned?.key);
    const next = channels[index + (key === "ArrowDown" ? 1 : -1)];
    if (index + 1 >= channels.length - ROWS && channels.length < state.total) state.loadMore();
    if (next) state.tuneChannel(next);
  };
  const latest = useRef(null);
  latest.current = { channels, total, row, program, channel, tuned, start, end, view, mode, select, tune, tuneChannel, loadMore, toggleFullscreen };

  useEffect(() => {
    const onKey = event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      const state = latest.current, key = event.key;
      if (key === "Escape") { event.preventDefault(); if (state.mode === "full") hide(); else wake(); return; }
      if (key === "f" || key === "F") { event.preventDefault(); state.toggleFullscreen(); return; }
      if (![...MOVES, "Enter", " "].includes(key)) return;
      // A focused button handles its own Enter and Space.
      if ((key === "Enter" || key === " ") && event.target.closest?.("button, a")) return;
      event.preventDefault();
      if (state.mode !== "full") {
        if (key === "ArrowUp" || key === "ArrowDown") { surf(key, state); wake("peek"); }
        else wake();
        return;
      }
      wake();
      if (key === "Enter" || key === " ") {
        if (!state.channel || !state.program) return;
        const live = state.program.start <= Date.now() && Date.now() < state.program.end;
        state.tune(state.channel, state.program);
        if (live) wake("peek");
        return;
      }
      move(key, state);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hide, wake]);

  // A mouse wheel over the guide scrolls through channels.
  const onWheel = event => {
    if (Math.abs(event.deltaY) < 4 || Date.now() - lastWheel.current < 160) return;
    lastWheel.current = Date.now();
    wake();
    move(event.deltaY > 0 ? "ArrowDown" : "ArrowUp", latest.current);
  };
  const activate = (item, show) => {
    wake();
    if (item.key === channel?.key && show.start === program?.start) {
      const live = show.start <= Date.now() && Date.now() < show.end;
      tune(item, show);
      if (live) wake("peek");
    } else select(item, show);
  };

  const first = Math.min(Math.max(0, row - 1), Math.max(0, channels.length - ROWS));
  const visible = channels.slice(first, first + ROWS);
  const live = program && program.start <= now && now < program.end;
  const playing = live && tuned?.key === channel?.key;
  const percent = time => `${(time - view) / WINDOW * 100}%`;
  const nowInView = now >= view && now < viewEnd;

  return <div className={`theater is-${mode}`} onPointerMove={() => wake()}
    onClick={event => { if (event.target === event.currentTarget) { if (mode === "full") hide(); else wake(); } }}
    onDoubleClick={event => { if (event.target === event.currentTarget) toggleFullscreen(); }}>
    <header className="theater-top" inert={mode !== "full"}>
      <button type="button" className="theater-brand" onClick={() => navigate("/")} aria-label="Kiwi home"><span className="brand-mark"><Leaf size={20} weight="fill" /></span><strong>Kiwi</strong></button>
      <span className="theater-section">Live TV</span>
      <div className="theater-tools">
        <div ref={setControls} className="theater-controls" />
        <button type="button" className="theater-key-button" onClick={hide}><kbd>Esc</kbd>Hide guide</button>
        <button type="button" className="theater-key-button" onClick={exit} title="Show every channel in the full grid"><Rows size={16} />Full guide</button>
      </div>
    </header>

    <section className="theater-panel" aria-label="On-screen guide" onWheel={onWheel} inert={mode === "hidden"}>
      {channel && <div className="theater-now" aria-live="polite">
        <span className="theater-now-icon">{playing ? <SpeakerHigh size={20} weight="fill" /> : live ? <Broadcast size={20} weight="fill" /> : null}</span>
        <div>
          <p className="theater-now-title"><span>{channel.number} {channel.name}</span>{program && <><i aria-hidden="true">·</i><strong>{program.title}</strong></>}</p>
          {program && <p className="theater-now-meta">{program.subtitle && <span>{program.subtitle.replace(/^S(\d+)E(\d+)/, "S$1 E$2")}</span>}
            <span>{live ? `Live · ${span(program.end - now)} left` : program.end <= now ? "Already aired" : `${clock(program.start)} · starts in ${span(program.start - now)}`}</span></p>}
          {live && <span className="theater-progress"><i style={{ transform: `scaleX(${(now - program.start) / (program.end - program.start)})` }} /></span>}
        </div>
      </div>}

      <div className="theater-grid" role="grid" inert={mode !== "full"} aria-label={`Channels ${first + 1} to ${first + visible.length} of ${total}, ${clock(view)} to ${clock(viewEnd)}`}>
        <div className="theater-row theater-head" role="row">
          <div className="theater-corner" role="columnheader">{new Date(view).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div>
          <div className="theater-times">{slots(view, viewEnd).map(time => <span key={time} role="columnheader" style={{ left: percent(time) }}>{clock(time)}</span>)}</div>
        </div>
        {visible.map(item => {
          const isTuned = item.key === tuned?.key;
          return <div key={item.key} className={`theater-row ${item.key === channel?.key ? "is-current" : ""}`} role="row">
            <button type="button" className={`theater-channel ${isTuned ? "is-tuned" : ""}`} role="rowheader" onClick={() => { tuneChannel(item); wake("peek"); }} aria-label={`Watch channel ${item.number}, ${item.name}`}>
              <span className="theater-number">{item.number}</span><Logo channel={item} /><span className="theater-channel-name">{item.name}</span>
              {isTuned && <SpeakerHigh size={16} weight="fill" className="theater-tuned" aria-label="Now playing" />}
            </button>
            <div className="theater-programs">
              {nowInView && <i className="theater-now-line" style={{ left: percent(now) }} aria-hidden="true" />}
              {item.programs.filter(show => show.end > view && show.start < viewEnd).map(show => {
                const from = Math.max(show.start, view), to = Math.min(show.end, viewEnd), width = (to - from) / WINDOW;
                const selected = item.key === channel?.key && show.start === program?.start;
                const onNow = show.start <= now && now < show.end;
                return <div key={show.start} role="gridcell" aria-selected={selected} className={`theater-cell ${selected ? "is-selected" : ""} ${onNow && isTuned ? "is-playing" : ""} ${show.end <= now ? "is-past" : ""} ${width < .2 ? "is-narrow" : ""}`} style={{ left: percent(from), width: `${width * 100}%` }}>
                  <button type="button" onClick={() => activate(item, show)} title={`${show.title} · ${clock(show.start)}–${clock(show.end)}`}
                    aria-label={`${show.title}${show.subtitle ? `, ${show.subtitle}` : ""}, ${clock(show.start)} to ${clock(show.end)}${onNow ? ", on now" : ""}${selected ? ". Press again to watch" : ""}`}>
                    {show.thumbnail_url && width >= .2 && <img src={show.thumbnail_url} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />}
                    <span className="theater-cell-copy"><strong>{show.title}</strong><small>{show.subtitle ? show.subtitle.replace(/^S(\d+)E(\d+)/, "S$1 E$2") : `${clock(show.start)} · ${span(show.duration_ms)}`}</small></span>
                  </button>
                </div>;
              })}
              {!item.programs.length && <p className="theater-empty">No programming</p>}
            </div>
          </div>;
        })}
      </div>

      <div className="theater-keys" aria-hidden="true">
        <span><kbd><ArrowUp size={14} /></kbd><kbd><ArrowDown size={14} /></kbd>Channel</span>
        <span><kbd><ArrowLeft size={14} /></kbd><kbd><ArrowRight size={14} /></kbd>Time</span>
        <span><kbd>Enter</kbd>Tune</span>
        <span><kbd>Esc</kbd>Hide guide</span>
        <span><kbd>F</kbd>Full screen</span>
      </div>
    </section>
  </div>;
}
