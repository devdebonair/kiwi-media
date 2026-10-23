"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Broadcast, Rows, SpeakerHigh } from "@phosphor-icons/react";
import { clock, programAt, slots, span } from "./guide-time.mjs";
import { InfiniteScroll } from "./infinite-scroll.jsx";

// An hour and a half of the schedule fills the width; scroll sideways for the rest of the loaded hours.
const VISIBLE_MINUTES = 90;
// The guide fades away when left alone; after flipping channels only the program line shows, briefly.
const IDLE_MS = 12_000, PEEK_MS = 4_000;
const MOVES = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const episodeLine = text => text.replace(/^S(\d+)E(\d+)/, "S$1 E$2");

// Live TV beside the site's rail and under its search bar: the tuned channel fills the page behind an on-screen
// guide. The guide scrolls like any list (wheel or trackpad: channels up and down, time sideways) and can be driven
// like a remote: arrows move the selection, Enter tunes, Esc hides the guide. With the guide hidden, up and down
// flip channels directly.
export function TheaterGuide({ channels, total, loadingMore, channel, program, tuned, now, start, end, select, tune, tuneChannel, loadMore, exit, setControls, setActions, toggleFullscreen, Logo }) {
  const [mode, setMode] = useState("full");
  // Sizes read from the grid's CSS: pixels per minute (so 90 minutes fill the width), row pitch, and header height.
  const [box, setBox] = useState({ ppm: 8, row: 72, pitch: 80, head: 38, column: 268, height: 300 });
  const [scrollTop, setScrollTop] = useState(0);
  const { ppm } = box;
  const timer = useRef(null), scroller = useRef(null), placed = useRef(false), keyed = useRef(false);

  const wake = useCallback((to = "full") => {
    setMode(to);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMode("hidden"), to === "peek" ? PEEK_MS : IDLE_MS);
  }, []);
  const hide = useCallback(() => { clearTimeout(timer.current); setMode("hidden"); }, []);
  useEffect(() => { wake(); return () => clearTimeout(timer.current); }, [wake]);
  // Any mouse movement over the page (the rail and search bar included) brings everything back.
  useEffect(() => {
    const onMove = () => wake();
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => document.removeEventListener("pointermove", onMove);
  }, [wake]);

  // Measured on mount and whenever the grid changes size.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element), value = name => parseFloat(style.getPropertyValue(name));
      const gap = value("--gap"), column = value("--col") + gap;
      setBox({ ppm: Math.max(3, (element.clientWidth - column) / VISIBLE_MINUTES), row: value("--row"), pitch: value("--row") + gap, head: value("--head") + gap, column, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keeps the selection on screen: centered the first time the guide opens, then just into view as it moves.
  // Only rows near the visible part are rendered, so the position is worked out rather than read from the page.
  useEffect(() => {
    const element = scroller.current;
    const index = channels.findIndex(item => item.key === channel?.key);
    if (!element || index < 0 || !program) return;
    const { pitch, head, column, row: rowHeight } = box;
    const top = head + index * pitch, left = column + (Math.max(program.start, start) - start) / 60_000 * box.ppm;
    const width = (Math.min(program.end, end) - Math.max(program.start, start)) / 60_000 * box.ppm;
    if (!placed.current) {
      // Wait for the channel that is playing; the guide may still be loading pages to reach it.
      if (tuned && channel.key !== tuned.key) return;
      placed.current = true;
      element.scrollTo({ top: top - (element.clientHeight - rowHeight) / 2, left: Math.max(0, left - column - 40) });
      return;
    }
    if (!keyed.current) return;
    keyed.current = false;
    let nextTop = element.scrollTop, nextLeft = element.scrollLeft;
    if (top - head < element.scrollTop) nextTop = top - head;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) nextTop = top + rowHeight - element.clientHeight;
    if (left - column < element.scrollLeft) nextLeft = left - column;
    else if (left + Math.min(width, element.clientWidth - column) > element.scrollLeft + element.clientWidth) nextLeft = left + Math.min(width, element.clientWidth - column) - element.clientWidth;
    element.scrollTo({ top: nextTop, left: nextLeft, behavior: "smooth" });
  }, [channel?.key, program?.start, box, channels.length]);

  // Moves the selection like the guide grid: through a channel's lineup, or to the same time on the next channel.
  const move = (key, state) => {
    const { channels, program, channel } = state;
    if (!program || !channel || !channels.length) return;
    const row = channels.findIndex(item => item.key === channel.key);
    let targetRow = row, target = null;
    const lineup = channels[row].programs, index = lineup.findIndex(item => item.start === program.start);
    if (key === "ArrowRight") target = lineup[index + 1]?.start < state.end ? lineup[index + 1] : null;
    else if (key === "ArrowLeft") target = lineup[index - 1]?.end > state.start ? lineup[index - 1] : null;
    else {
      targetRow = row + (key === "ArrowDown" ? 1 : -1);
      target = channels[targetRow] ? programAt(channels[targetRow].programs, Math.max(program.start, state.start)) : null;
    }
    if (targetRow >= channels.length - 4 && channels.length < state.total) state.loadMore();
    if (target) { keyed.current = true; state.select(channels[targetRow], target); }
  };
  // Flips to the channel above or below the one playing, like pressing channel up/down on a remote.
  const surf = (key, state) => {
    const index = state.channels.findIndex(item => item.key === state.tuned?.key);
    const next = state.channels[index + (key === "ArrowDown" ? 1 : -1)];
    if (index + 1 >= state.channels.length - 4 && state.channels.length < state.total) state.loadMore();
    if (next) { keyed.current = true; state.tuneChannel(next); }
  };
  const latest = useRef(null);
  latest.current = { channels, total, program, channel, tuned, start, end, mode, select, tune, tuneChannel, loadMore, toggleFullscreen };

  useEffect(() => {
    const onKey = event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const state = latest.current, key = event.key;
      // Typing in the search bar or a tag picker keeps the guide up but is otherwise left alone.
      if (event.target.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog']")) { if (state.mode === "full") wake(); return; }
      if (key === "Escape") { event.preventDefault(); if (state.mode === "full") hide(); else wake(); return; }
      if (key === "f" || key === "F") { event.preventDefault(); state.toggleFullscreen(); return; }
      if (![...MOVES, "Enter", " "].includes(key)) return;
      // A focused button or link handles its own Enter and Space.
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

  const activate = (item, show) => {
    wake();
    if (item.key === channel?.key && show.start === program?.start) {
      const live = show.start <= Date.now() && Date.now() < show.end;
      tune(item, show);
      if (live) wake("peek");
    } else select(item, show);
  };

  const live = program && program.start <= now && now < program.end;
  const playing = live && tuned?.key === channel?.key;
  const x = time => (time - start) / 60_000 * ppm;
  const trackWidth = (end - start) / 60_000 * ppm;
  const nowX = now >= start && now < end ? x(now) : null;
  const row = channels.findIndex(item => item.key === channel?.key);
  // The rows in view plus a few either side.
  const first = Math.max(0, Math.floor((scrollTop - box.head) / box.pitch) - 3);
  const last = Math.min(channels.length, Math.ceil((scrollTop + box.height) / box.pitch) + 3);

  return <div className={`theater is-${mode}`}
    onClick={event => { if (event.target === event.currentTarget) { if (mode === "full") hide(); else wake(); } }}
    onDoubleClick={event => { if (event.target === event.currentTarget) toggleFullscreen(); }}>
    <div className="theater-top" inert={mode !== "full"}>
      <div ref={setActions} className="theater-actions" />
      <div className="theater-tools">
        <div ref={setControls} className="theater-controls" />
        <button type="button" className="theater-key-button" onClick={hide}><kbd>Esc</kbd>Hide guide</button>
        <button type="button" className="theater-key-button" onClick={exit} title="Show every channel in the full grid"><Rows size={16} />Full guide</button>
      </div>
    </div>

    <section className="theater-panel" aria-label="On-screen guide" inert={mode === "hidden"}>
      {channel && <div className="theater-now" aria-live="polite">
        <span className="theater-now-icon">{playing ? <SpeakerHigh size={20} weight="fill" /> : live ? <Broadcast size={20} weight="fill" /> : null}</span>
        <div>
          <p className="theater-now-title"><span>{channel.number} {channel.name}</span>{program && <><i aria-hidden="true">·</i><strong>{program.title}</strong></>}</p>
          {program && <p className="theater-now-meta">{program.subtitle && <span>{episodeLine(program.subtitle)}</span>}
            <span>{live ? `Live · ${span(program.end - now)} left` : program.end <= now ? "Already aired" : `${clock(program.start)} · starts in ${span(program.start - now)}`}</span></p>}
          {live && <span className="theater-progress"><i style={{ transform: `scaleX(${(now - program.start) / (program.end - program.start)})` }} /></span>}
        </div>
      </div>}

      <div className="theater-scroller" ref={scroller} role="grid" inert={mode !== "full"} onScroll={event => { wake(); setScrollTop(event.currentTarget.scrollTop); }}
        aria-label={`Guide, ${channels.length} of ${total} channels${row >= 0 ? `, channel ${row + 1} selected` : ""}`} style={{ "--track": `${trackWidth}px` }}>
        <div className="theater-row theater-head" role="row">
          <div className="theater-corner" role="columnheader">{new Date(start).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div>
          <div className="theater-times">{slots(start, end).map(time => <span key={time} role="columnheader" style={{ left: x(time) }}>{clock(time)}</span>)}</div>
        </div>
        {first > 0 && <div style={{ height: first * box.pitch }} aria-hidden="true" />}
        {channels.slice(first, last).map(item => {
          const isTuned = item.key === tuned?.key;
          return <div key={item.key} className={`theater-row ${item.key === channel?.key ? "is-current" : ""}`} role="row">
            <button type="button" className={`theater-channel ${isTuned ? "is-tuned" : ""}`} role="rowheader" onClick={() => { keyed.current = true; tuneChannel(item); wake("peek"); }} aria-label={`Watch channel ${item.number}, ${item.name}`}>
              <span className="theater-number">{item.number}</span><Logo channel={item} /><span className="theater-channel-name">{item.name}</span>
              {isTuned && <SpeakerHigh size={16} weight="fill" className="theater-tuned" aria-label="Now playing" />}
            </button>
            <div className="theater-programs">
              {nowX !== null && <i className="theater-now-line" style={{ left: nowX }} aria-hidden="true" />}
              {item.programs.filter(show => show.end > start && show.start < end).map(show => {
                const from = Math.max(show.start, start), width = x(Math.min(show.end, end)) - x(from);
                const selected = item.key === channel?.key && show.start === program?.start;
                const onNow = show.start <= now && now < show.end;
                return <div key={show.start} role="gridcell" aria-selected={selected} data-key={item.key} data-start={show.start}
                  className={`theater-cell ${selected ? "is-selected" : ""} ${onNow && isTuned ? "is-playing" : ""} ${show.end <= now ? "is-past" : ""} ${width < 190 ? "is-narrow" : ""}`} style={{ left: x(from), width }}>
                  <button type="button" tabIndex={selected ? 0 : -1} onClick={() => activate(item, show)} title={`${show.title} · ${clock(show.start)}–${clock(show.end)}`}
                    aria-label={`${show.title}${show.subtitle ? `, ${show.subtitle}` : ""}, ${clock(show.start)} to ${clock(show.end)}${onNow ? ", on now" : ""}${selected ? ". Press again to watch" : ""}`}>
                    {show.thumbnail_url && width >= 190 && <img src={show.thumbnail_url} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />}
                    <span className="theater-cell-copy"><strong>{show.title}</strong><small>{show.subtitle ? episodeLine(show.subtitle) : `${clock(show.start)} · ${span(show.duration_ms)}`}</small></span>
                  </button>
                </div>;
              })}
              {!item.programs.length && <p className="theater-empty">No programming</p>}
            </div>
          </div>;
        })}
        {last < channels.length && <div style={{ height: (channels.length - last) * box.pitch }} aria-hidden="true" />}
        <InfiniteScroll rootRef={scroller} enabled={channels.length < total} loading={loadingMore} onLoadMore={loadMore} />
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
