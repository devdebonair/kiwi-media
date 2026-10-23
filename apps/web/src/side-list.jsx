"use client";

import { useEffect, useState } from "react";
import { CaretDown, CaretRight, CaretUp, Television } from "@phosphor-icons/react";
import { rememberChannel } from "./guide-page.jsx";

// A boxed list beside the main column, like a "Top airing" panel: a heading that links somewhere and a few rows,
// with the rest behind a "show more" bar.
export function SidePanel({ title, href, AppLink, navigate, children, count, initial = 4 }) {
  const [open, setOpen] = useState(false);
  const rows = Array.isArray(children) ? children : [children];
  return <section className="side-panel">
    <h2>{href ? <AppLink href={href} navigate={navigate}><CaretRight size={14} weight="bold" />{title}</AppLink> : title}</h2>
    <div className="side-rows">{open ? rows : rows.slice(0, initial)}</div>
    {(count ?? rows.length) > initial && <button type="button" className="side-more" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label={open ? "Show fewer" : "Show more"}>{open ? <CaretUp size={16} /> : <CaretDown size={16} />}</button>}
  </section>;
}

// One row: a small poster or still, a backdrop that fades in from the right, a title, and a line of facts.
export function SideRow({ href, onClick, AppLink, navigate, image, backdrop, title, facts = [], dot, wide = false }) {
  const body = <>
    {backdrop && <span className="side-backdrop" aria-hidden="true"><img src={backdrop} alt="" loading="lazy" /></span>}
    <span className={`side-thumb ${wide ? "is-wide" : ""}`}>{image ? <img src={image} alt="" loading="lazy" /> : <Television size={22} />}</span>
    <span className="side-copy">
      <strong>{dot && <i className={`side-dot ${dot}`} aria-hidden="true" />}{title}</strong>
      {facts.length > 0 && <span className="side-facts">{facts.map(fact => <span key={fact}>{fact}</span>)}</span>}
    </span>
  </>;
  return href ? <AppLink href={href} navigate={navigate} onClick={onClick} className="side-row">{body}</AppLink> : <button type="button" className="side-row" onClick={onClick}>{body}</button>;
}

const clock = ms => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Movies and episodes airing right now on the TV Guide's channels. A row tunes the guide to that channel.
export function OnNow({ api, AppLink, navigate }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let active = true;
    api("/api/v1/guide?hours=1&limit=60").then(value => {
      if (!active) return;
      const now = value.now;
      const seen = new Set(), list = [];
      for (const channel of value.channels) {
        const program = channel.programs.find(item => item.start <= now && item.end > now);
        if (!program?.catalog || seen.has(program.title_id)) continue;
        seen.add(program.title_id);
        list.push({ channel, program });
      }
      setRows(list.slice(0, 10));
    }).catch(() => { if (active) setRows([]); });
    return () => { active = false; };
  }, [api]);
  if (!rows?.length) return null;
  return <SidePanel title="On now" href="/guide" AppLink={AppLink} navigate={navigate} initial={5}>
    {rows.map(({ channel, program }) => <SideRow key={channel.key} href="/guide" AppLink={AppLink} navigate={navigate} onClick={() => rememberChannel(channel)} wide
      image={program.thumbnail_url} title={program.title} dot="is-live"
      facts={[`${channel.number} ${channel.name}`, program.season != null ? `S${program.season} E${program.episode}` : "Movie", `until ${clock(program.end)}`]} />)}
  </SidePanel>;
}

// Followed topics first (or the biggest ones), as round avatars.
export function TopicsPanel({ topics, AppLink, navigate }) {
  const followed = topics.filter(topic => topic.followed);
  const list = (followed.length ? followed : [...topics].sort((a, b) => b.item_count - a.item_count)).slice(0, 10);
  if (!list.length) return null;
  return <SidePanel title={followed.length ? "Your topics" : "Topics"} href="/topics" AppLink={AppLink} navigate={navigate} initial={5}>
    {list.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate} className="side-row is-topic">
      <span className="side-thumb is-round"><img src={topic.avatar_url || "/assets/profile-placeholder.svg"} alt="" loading="lazy" /></span>
      <span className="side-copy"><strong>{topic.name}</strong><span className="side-facts"><span>{topic.item_count.toLocaleString()} {topic.item_count === 1 ? "item" : "items"}</span>{topic.title_count > 0 && <span>{topic.title_count} titles</span>}</span></span>
    </AppLink>)}
  </SidePanel>;
}
