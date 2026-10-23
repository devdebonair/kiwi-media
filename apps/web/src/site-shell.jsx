"use client";

import { useEffect, useRef, useState } from "react";
import { SearchBar } from "./search-bar.jsx";
import { UploadButton } from "./download-dialog.jsx";
import { CaretRight, ClockCounterClockwise, DownloadSimple, FilmStrip, Gear, Heart, House, Leaf, List, MagnifyingGlass, MonitorPlay, Play, Rows, Sparkle, Tag, Television, VideoCamera, X } from "@phosphor-icons/react";

// Below this width the icon rail is replaced by a top bar with a menu button; it matches `max-width: 899px` in shell.css.
export const MOBILE_NAV_QUERY = "(max-width: 899px)";

// Streaming first, then your own media, then what you have collected. Settings sits at the bottom of the rail.
const groups = [
  [["/", "Home", "home", House], ["/movies", "Movies", "movies", FilmStrip], ["/shows", "TV Shows", "shows", MonitorPlay], ["/anime", "Anime", "anime", Sparkle], ["/guide", "TV Guide", "guide", Television]],
  [["/library", "Home Videos", "library", VideoCamera], ["/shorts", "Shorts", "shorts", Play], ["/topics", "Topics", "topics", Tag]],
  [["/feeds", "Feeds", "feeds", Rows], ["/liked", "Liked", "liked", Heart], ["/history", "History", "history", ClockCounterClockwise], ["/downloads", "Downloads", "downloads", DownloadSimple]],
];

// A feed lights up Feeds and a topic lights up Topics.
const active = (route, page) => route.page === page || (page === "feeds" && route.page === "feed") || (page === "topics" && route.page === "topic");

export function Brand({ navigate, compact = false }) {
  return <a href="/" className={`brand ${compact ? "is-compact" : ""}`} aria-label="Kiwi home" onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate("/");
  }}><span className="brand-mark"><Leaf size={20} weight="fill" /></span>{!compact && <span className="brand-word">kiwi</span>}</a>;
}

// The page header: a search field floating over the page (and over the banner art on pages that have one).
// It gains a blurred background once the page scrolls. On phones it also carries the logo and the menu button.
export function Header({ query, setQuery, onSubmit, navigate, api, menuOpen, toggleMenu }) {
  const searchRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  useEffect(() => {
    const shortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") { event.preventDefault(); setSearching(true); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => { if (searching) searchRef.current?.focus(); }, [searching]);

  return <header className={`site-header ${scrolled || menuOpen ? "is-scrolled" : ""} ${searching ? "is-searching" : ""}`}>
    <div className="header-start"><Brand navigate={navigate} /></div>
    <div className="header-search">
      <button type="button" className="header-icon search-close" onClick={() => setSearching(false)} aria-label="Close search"><X size={20} /></button>
      <SearchBar query={query} setQuery={setQuery} navigate={navigate} inputRef={searchRef} onSubmit={event => { setSearching(false); onSubmit(event); }} />
    </div>
    <div className="header-end">
      <UploadButton api={api} navigate={navigate} />
      <button type="button" className="header-icon search-open" onClick={() => setSearching(true)} aria-label="Search"><MagnifyingGlass size={21} /></button>
      <button type="button" className="header-icon menu-open" onClick={toggleMenu} aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="site-menu">{menuOpen ? <X size={21} /> : <List size={21} />}</button>
    </div>
  </header>;
}

// The narrow icon rail on the left of larger screens. Labels appear beside each icon on hover or focus.
export function Rail({ route, navigate, AppLink }) {
  const link = ([href, label, page, Icon]) => {
    const current = active(route, page);
    return <AppLink key={page} href={href} navigate={navigate} data-label={label} aria-label={label} aria-current={current ? "page" : undefined} className={`rail-link ${current ? "active" : ""}`}><Icon size={20} weight={current ? "fill" : "regular"} /></AppLink>;
  };
  return <aside className="site-rail" aria-label="Site">
    <Brand navigate={navigate} compact />
    <nav aria-label="Main">{groups.map((group, index) => <div className="rail-group" key={index}>{group.map(link)}</div>)}</nav>
    <div className="rail-bottom">{link(["/settings", "Settings", "settings", Gear])}</div>
  </aside>;
}

// On phones the menu button opens a panel of large tiles under the top bar.
export function MobileMenu({ open, close, route, navigate, AppLink }) {
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia(MOBILE_NAV_QUERY);
    const closeWhenWide = () => { if (!query.matches) close(); };
    const onKey = event => { if (event.key === "Escape") close(); };
    query.addEventListener("change", closeWhenWide);
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector("a")?.focus();
    return () => { query.removeEventListener("change", closeWhenWide); document.removeEventListener("keydown", onKey); };
  }, [open]);
  if (!open) return null;
  return <>
    <button className="menu-scrim" onClick={close} aria-label="Close menu" tabIndex={-1} />
    <nav ref={panel} id="site-menu" className="mobile-menu" aria-label="Site">
      <div className="menu-tiles">{groups.flat().map(([href, label, page, Icon]) => <AppLink key={page} href={href} navigate={navigate} onClick={close} aria-current={active(route, page) ? "page" : undefined} className={active(route, page) ? "active" : ""}><Icon size={20} weight={active(route, page) ? "fill" : "regular"} /><span>{label}</span></AppLink>)}</div>
      <AppLink href="/settings" navigate={navigate} onClick={close} className={`menu-row ${route.page === "settings" ? "active" : ""}`} aria-current={route.page === "settings" ? "page" : undefined}><Gear size={18} /><span>Settings</span><CaretRight size={15} /></AppLink>
    </nav>
  </>;
}
