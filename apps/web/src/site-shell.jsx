"use client";

import { useEffect, useRef, useState } from "react";
import { SearchBar } from "./search-bar.jsx";
import { ClockCounterClockwise, Compass, FolderOpen, Gear, Leaf, List, Play, Rows, Tag, X } from "@phosphor-icons/react";

export function Brand({ navigate }) {
  return <a href="/" className="brand" aria-label="Kiwi home" onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate("/");
  }}><span className="brand-mark"><Leaf size={22} weight="fill" /></span><span>kiwi<span className="brand-dot">.</span></span></a>;
}

export function Header({ query, setQuery, onSubmit, openMenu, navigate, mobileOpen, collapsed }) {
  const searchRef = useRef(null);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 860px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const shortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  return <header className="topbar">
    <div className="brand-group">
      <button className="menu-toggle icon-button" onClick={openMenu} aria-label="Toggle navigation" aria-controls="site-navigation" aria-expanded={mobile ? mobileOpen : !collapsed}><List size={23} /></button>
      <Brand navigate={navigate} />
    </div>
    <SearchBar query={query} setQuery={setQuery} onSubmit={onSubmit} navigate={navigate} inputRef={searchRef} />
  </header>;
}

const groups = [
  { label: "DISCOVER", items: [["/", "Home", "home", Compass], ["/library", "Library", "library", FolderOpen], ["/shorts", "Shorts", "shorts", Play], ["/topics", "Topics", "topics", Tag]] },
  { label: "COLLECTION", items: [["/feeds", "Your feeds", "feeds", Rows], ["/history", "Watch history", "history", ClockCounterClockwise], ["/search", "Explore", "search", FolderOpen]] },
];

export function Sidebar({ route, navigate, open, close, AppLink }) {
  const sidebarRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    sidebarRef.current?.querySelector("button")?.focus();
    const handleKey = event => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        const items = sidebarRef.current?.querySelectorAll("a, button");
        const first = items?.[0], last = items?.[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previousFocus?.focus(); };
  }, [open]);

  return <>
    {open && <button className="scrim" onClick={close} aria-label="Close navigation" />}
    <aside ref={sidebarRef} id="site-navigation" className={`sidebar ${open ? "open" : ""}`}>
      <div className="mobile-sidebar-heading"><Brand navigate={href => { close(); navigate(href); }} /><button className="icon-button" onClick={close} aria-label="Close navigation"><X size={22} /></button></div>
      {groups.map(group => <nav className="nav-group" aria-label={group.label.toLowerCase()} key={group.label}>
        {group.label !== "DISCOVER" && <span className="nav-label">{group.label}</span>}
        {group.items.map(([href, label, page, Icon]) => <AppLink key={page} href={href} navigate={navigate} onClick={close} title={label} aria-current={route.page === page || (page === "feeds" && route.page === "feed") ? "page" : undefined} className={route.page === page || (page === "feeds" && route.page === "feed") ? "active" : ""}><Icon size={22} /><span>{label}</span></AppLink>)}
      </nav>)}
      <div className="sidebar-bottom">
        <AppLink href="/settings" navigate={navigate} onClick={close} title="Settings" aria-current={route.page === "settings" ? "page" : undefined} className={route.page === "settings" ? "active" : ""}><Gear size={22} /><span>Settings</span></AppLink>
      </div>
    </aside>
  </>;
}
