"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, searchSettings } from "./settings-index.mjs";

// Scrolls to a setting (or its section when the setting isn't on screen yet) and flashes it.
// Sections load their data separately, so this waits a few seconds for the element to appear.
export function locateSetting(target, section = target, { focus = false, smooth = true } = {}) {
  const started = Date.now();
  const attempt = () => {
    const exact = document.getElementById(target);
    const element = exact || document.getElementById(section);
    if (!element) { if (Date.now() - started < 4000) setTimeout(attempt, 100); return; }
    const isSection = element.id === section;
    element.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: isSection ? "start" : "center" });
    const highlight = isSection ? element : element.closest(".config-field, .config-toggle, .provider-card, .library-folder-form, .language-columns > div") || element;
    highlight.classList.remove("settings-located");
    void highlight.offsetWidth; // Restart the flash if it is already running.
    highlight.classList.add("settings-located");
    setTimeout(() => highlight.classList.remove("settings-located"), 1800);
    if (focus && exact && /^(INPUT|SELECT|TEXTAREA)$/.test(exact.tagName)) exact.focus({ preventScroll: true });
    if (window.location.hash !== `#${section}`) history.replaceState(history.state, "", `#${section}`);
  };
  attempt();
}

// The section nearest the top of the window, for highlighting the sidebar.
function useActiveSection() {
  const [active, setActive] = useState(SETTINGS_SECTIONS[0].id);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = Math.min(window.innerHeight * 0.3, 220);
      let current = SETTINGS_SECTIONS[0].id;
      for (const section of SETTINGS_SECTIONS) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= line) current = section.id;
      }
      // At the very bottom, the last section is the one being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = SETTINGS_SECTIONS.at(-1).id;
      setActive(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, []);
  return active;
}

export function SettingsSidebar() {
  const [query, setQuery] = useState(""), [cursor, setCursor] = useState(0);
  const active = useActiveSection();
  const input = useRef(null);
  const results = useMemo(() => searchSettings(query), [query]);
  useEffect(() => setCursor(0), [query]);
  // Arriving at /settings#section (e.g. from "Manage profiles" or "Open streaming settings").
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id && SETTINGS_SECTIONS.some(section => section.id === id)) locateSetting(id, id, { smooth: false });
  }, []);
  // "/" jumps to the settings search, unless you are typing somewhere.
  useEffect(() => {
    const onKey = event => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      event.preventDefault(); input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = result => { locateSetting(result.target, result.section, { focus: result.kind === "setting" }); setQuery(""); };
  const onKeyDown = event => {
    if (event.key === "Escape") { setQuery(""); return; }
    if (!results.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor(index => (index + 1) % results.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor(index => (index - 1 + results.length) % results.length); }
    else if (event.key === "Enter") { event.preventDefault(); go(results[cursor]); }
  };
  const searching = query.trim().length > 0;

  return <aside className="settings-sidebar" aria-label="Settings sections">
    <div className="settings-search" role="search">
      <MagnifyingGlass size={16} aria-hidden="true" />
      <input ref={input} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Find a setting" aria-label="Find a setting"
        role="combobox" aria-expanded={searching} aria-controls="settings-search-results" aria-activedescendant={searching && results[cursor] ? `settings-result-${cursor}` : undefined} autoComplete="off" spellCheck={false} />
      {searching ? <button type="button" className="settings-search-clear" onClick={() => { setQuery(""); input.current?.focus(); }} aria-label="Clear search"><X size={14} /></button> : <kbd aria-hidden="true">/</kbd>}
    </div>
    {searching ? <ul className="settings-results" id="settings-search-results" role="listbox" aria-label="Matching settings">
      {results.length ? results.map((result, index) => <li key={result.key} id={`settings-result-${index}`} role="option" aria-selected={index === cursor}>
        <button type="button" className={index === cursor ? "is-current" : ""} onMouseEnter={() => setCursor(index)} onClick={() => go(result)}>
          <strong>{result.label}</strong>
          <small>{result.kind === "section" ? result.group : `${result.group} › ${result.sectionTitle}`}</small>
        </button>
      </li>) : <li className="settings-no-results" role="presentation">No settings match “{query.trim()}”.</li>}
    </ul> : <nav className="settings-nav" aria-label="Settings">
      {SETTINGS_GROUPS.map(group => <div className="settings-nav-group" key={group.id}>
        <span className="settings-nav-title">{group.title}</span>
        {group.sections.map(section => <a key={section.id} href={`#${section.id}`} aria-current={active === section.id ? "true" : undefined} className={active === section.id ? "is-active" : ""}
          onClick={event => { event.preventDefault(); locateSetting(section.id); }}>{section.title}</a>)}
      </div>)}
    </nav>}
  </aside>;
}

// A titled group of settings cards in the page body.
export function SettingsGroup({ id, children }) {
  const group = SETTINGS_GROUPS.find(entry => entry.id === id);
  return <div className="settings-group" id={`group-${id}`} aria-labelledby={`group-${id}-title`}>
    <h2 className="settings-group-title" id={`group-${id}-title`}>{group.title}</h2>
    {children}
  </div>;
}
