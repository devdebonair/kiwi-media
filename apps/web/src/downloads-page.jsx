"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CaretDown, CheckCircle, DownloadSimple, MagnifyingGlass, Plus, Rows, ShieldCheck, SpinnerGap, SquaresFour, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";
import { active, DownloadForm, formatBytes, formatEta } from "./download-dialog.jsx";

const viewKey = "kiwi.downloads.view", collapsedKey = "kiwi.downloads.collapsed", formKey = "kiwi.downloads.form-open", pageSize = 48;
const stored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const when = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
const sections = [
  { key: "active", title: "In progress", empty: "Nothing is downloading right now." },
  { key: "failed", title: "Failed & canceled", empty: "No failed downloads." },
  { key: "completed", title: "Completed", empty: "Completed downloads appear here." },
];

// Download history in three sections (active first), as a table or a thumbnail grid.
// Completed videos use the library thumbnail, so hover previews, playlists, and tags work as on Home.
export function DownloadsPage({ api, navigate, Thumb, AppLink }) {
  const [view, setView] = useState("table"), [collapsed, setCollapsed] = useState({});
  const [query, setQuery] = useState(""), [lists, setLists] = useState(null), [summary, setSummary] = useState(null);
  const [completedLimit, setCompletedLimit] = useState(pageSize), [selected, setSelected] = useState(new Set()), [showForm, setShowForm] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { setView(stored(viewKey, "table")); setCollapsed(stored(collapsedKey, {})); setShowForm(stored(formKey, true)); }, []);

  const latest = useRef({});
  latest.current = { query, completedLimit };
  const load = async () => {
    const { query: q, completedLimit: limit } = latest.current;
    const search = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : "";
    const [activeRows, failed, completed, counts] = await Promise.all([
      api(`/api/v1/downloads?status=active&limit=200${search}`), api(`/api/v1/downloads?status=failed&limit=200${search}`),
      api(`/api/v1/downloads?status=completed&limit=${limit}${search}`), api("/api/v1/downloads/summary"),
    ]);
    setLists({ active: activeRows, failed, completed }); setSummary(counts); setError("");
    return activeRows.length;
  };
  useEffect(() => {
    let timer, stopped = false;
    const poll = async () => {
      let running = 0;
      try { running = await load(); } catch (failure) { setError(failure.message); }
      if (!stopped) timer = setTimeout(poll, running ? 2000 : 10000);
    };
    const debounce = setTimeout(poll, query ? 250 : 0);
    return () => { stopped = true; clearTimeout(timer); clearTimeout(debounce); };
  }, [query, completedLimit]);

  const changeView = value => { setView(value); localStorage.setItem(viewKey, JSON.stringify(value)); };
  const toggleSection = key => setCollapsed(current => { const next = { ...current, [key]: !current[key] }; localStorage.setItem(collapsedKey, JSON.stringify(next)); return next; });
  const replace = rows => setLists(current => current && Object.fromEntries(Object.entries(current).map(([key, list]) => [key, list.map(item => rows.find(row => row.id === item.id) || item)])));
  const all = lists ? [...lists.active, ...lists.failed, ...lists.completed] : [];
  const chosen = all.filter(item => selected.has(item.id));
  const toggle = (ids, on) => setSelected(current => { const next = new Set(current); for (const id of ids) on ? next.add(id) : next.delete(id); return next; });
  const act = async (items, action) => {
    setError("");
    for (const item of items) {
      try { await api(`/api/v1/downloads/${item.id}${action === "remove" ? "" : `/${action}`}`, action === "remove" ? { method: "DELETE" } : { method: "POST", body: "{}" }); }
      catch (failure) { setError(failure.message); }
    }
    if (action === "remove") toggle(items.map(item => item.id), false);
    await load().catch(() => {});
  };
  const context = { api, navigate, Thumb, AppLink, selected, toggle, act, replace };

  return <div className="content downloads-page">
    <div className="section-heading">
      <div><span className="eyebrow">From the web</span><h1>Downloads</h1><p>Add links in bulk, follow progress, and tag what you download.</p></div>
      <div className="downloads-toolbar">
        <label className="downloads-filter"><MagnifyingGlass size={17} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter downloads" aria-label="Filter downloads by title or link" /></label>
        <div className="view-toggle" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "table"} title="Table" aria-label="Table view" onClick={() => changeView("table")}><Rows size={18} /></button>
          <button type="button" aria-pressed={view === "grid"} title="Thumbnails" aria-label="Thumbnail view" onClick={() => changeView("grid")}><SquaresFour size={18} /></button>
        </div>
      </div>
    </div>

    <section className={`downloads-add ${showForm ? "" : "is-collapsed"}`}>
      <button type="button" className="downloads-section-toggle" aria-expanded={showForm} onClick={() => setShowForm(value => { localStorage.setItem(formKey, JSON.stringify(!value)); return !value; })}>
        <span><Plus size={18} /> Add downloads</span><CaretDown size={18} className="caret" />
      </button>
      {showForm && <div className="downloads-add-body"><DownloadForm api={api} rows={5} onQueued={() => load().catch(() => {})}
        footer={<button type="button" className="text-button" onClick={() => navigate("/settings#downloads")}>Downloaders &amp; VPN settings</button>} /></div>}
    </section>

    {chosen.length > 0 && <div className="selection-bar" role="region" aria-label="Selected downloads">
      <strong>{chosen.length} selected</strong>
      <AddTag asset={{ title: `${chosen.length} downloads`, topics: [] }} api={api} label="Tag selected" endpoint="/api/v1/downloads/topics" extraBody={{ downloadIds: chosen.map(item => item.id) }} onChange={(_, value) => replace(value.downloads)} />
      {chosen.some(item => ["failed", "canceled"].includes(item.status)) && <button type="button" className="outline-button" onClick={() => act(chosen.filter(item => ["failed", "canceled"].includes(item.status)), "retry")}><ArrowClockwise size={16} /> Retry</button>}
      {chosen.some(item => ["queued", "running"].includes(item.status)) && <button type="button" className="outline-button" onClick={() => act(chosen.filter(item => ["queued", "running"].includes(item.status)), "cancel")}><X size={16} /> Cancel</button>}
      {chosen.some(item => !active(item.status)) && <button type="button" className="outline-button" onClick={() => act(chosen.filter(item => !active(item.status)), "remove")}><Trash size={16} /> Remove from history</button>}
      <button type="button" className="text-button" onClick={() => setSelected(new Set())}>Clear selection</button>
    </div>}
    {error && <div className="error-notice" role="alert">{error}</div>}

    {!lists ? <div className="download-loading"><SpinnerGap className="spin" size={22} /> Loading downloads…</div> : sections.map(section => {
      // Counts come from the summary unless a filter narrows the lists.
      const items = lists[section.key], total = query.trim() ? items.length : summary?.[section.key] ?? items.length;
      const open = section.key === "active" || !collapsed[section.key];
      if (section.key === "failed" && !items.length && !query) return null;
      const allSelected = items.length > 0 && items.every(item => selected.has(item.id));
      return <section key={section.key} className={`downloads-section section-${section.key}`}>
        <div className="downloads-section-head">
          {section.key === "active" ? <h2>{section.title} <span className="count">{total}</span></h2>
            : <button type="button" className="downloads-section-toggle" aria-expanded={open} onClick={() => toggleSection(section.key)}><h2>{section.title} <span className="count">{total}</span></h2><CaretDown size={18} className="caret" /></button>}
          {open && items.length > 0 && <label className="select-all"><input type="checkbox" checked={allSelected} onChange={event => toggle(items.map(item => item.id), event.target.checked)} /> Select all</label>}
          {section.key === "failed" && open && items.length > 0 && <div className="section-actions">
            <button type="button" className="outline-button" onClick={() => act(items, "retry")}><ArrowClockwise size={16} /> Retry all</button>
            <button type="button" className="outline-button" onClick={() => act(items, "remove")}><Trash size={16} /> Clear all</button>
          </div>}
        </div>
        {open && (!items.length ? <p className="muted downloads-empty">{query ? "No matches." : section.empty}</p>
          : view === "table" ? <DownloadTable items={items} {...context} /> : <DownloadGrid items={items} {...context} />)}
        {open && section.key === "completed" && items.length >= completedLimit && <button type="button" className="outline-button load-more" onClick={() => setCompletedLimit(limit => limit + pageSize)}>Load more</button>}
      </section>;
    })}
  </div>;
}

function Status({ item }) {
  const percent = item.progress != null ? Math.round(item.progress * 100) : null;
  const stats = item.status === "running" ? [item.bytes_done != null && (item.bytes_total ? `${formatBytes(item.bytes_done)} of ${formatBytes(item.bytes_total)}` : formatBytes(item.bytes_done)), item.speed && `${formatBytes(item.speed)}/s`, formatEta(item.eta_seconds)].filter(Boolean).join(" · ") : "";
  const Icon = item.status === "completed" ? CheckCircle : ["failed", "canceled"].includes(item.status) ? WarningCircle : SpinnerGap;
  return <div className={`download-status status-${item.status}`}>
    <span className="download-status-line"><Icon size={15} className={active(item.status) ? "spin-slow" : ""} aria-hidden="true" />{item.message || item.status}{percent != null && item.status === "running" ? ` · ${percent}%` : ""}</span>
    {stats && <small>{stats}</small>}
    {active(item.status) && <div className={`download-progress ${percent == null ? "is-indeterminate" : ""}`} role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span style={percent == null ? undefined : { width: `${percent}%` }} /></div>}
    {item.error && <small className="download-error-text" title={item.error}>{item.error}</small>}
  </div>;
}

// Tags on a download: its media's tags once complete, otherwise the tags queued for import.
function Tags({ item, api, replace }) {
  const remove = async topic => { try { replace([(await api(`/api/v1/downloads/${item.id}/topics/${topic.id}`, { method: "DELETE" })).download]); } catch {} };
  return <div className="download-tags">
    {item.topics.map(topic => item.status === "completed"
      ? <span key={topic.id} className="tag-pill"><TopicLabel topic={topic} /></span>
      : <button type="button" key={topic.id} className="tag-pill" title={`Remove ${topic.name}`} aria-label={`Remove tag ${topic.name}`} onClick={() => remove(topic)}><TopicLabel topic={topic} /><X size={12} /></button>)}
    <AddTag compact asset={{ title: item.title || "this download", topics: item.topics }} api={api} endpoint={`/api/v1/downloads/${item.id}/topics`} label="Add tag" onChange={(_, value) => replace([value.download])} />
  </div>;
}

function Actions({ item, act, navigate }) {
  const asset = item.assets?.[0];
  return <div className="download-row-actions">
    {asset && <button type="button" className="icon-button" title="Open" aria-label={`Open ${item.title || "download"}`} onClick={() => navigate(`/watch/${asset.id}`)}><ArrowSquareOut size={17} /></button>}
    {["queued", "running"].includes(item.status) && <button type="button" className="icon-button" title="Cancel" aria-label="Cancel download" onClick={() => act([item], "cancel")}><X size={17} /></button>}
    {["failed", "canceled"].includes(item.status) && <button type="button" className="icon-button" title="Retry" aria-label="Retry download" onClick={() => act([item], "retry")}><ArrowClockwise size={17} /></button>}
    {!active(item.status) && <button type="button" className="icon-button" title="Remove from history" aria-label="Remove from history" onClick={() => act([item], "remove")}><Trash size={17} /></button>}
  </div>;
}

const Route = ({ item }) => <>{item.downloader_name}{item.vpn_name && <> · <ShieldCheck size={12} className="vpn-on" /> {item.vpn_name}</>}</>;
const Placeholder = ({ item }) => <div className={`download-placeholder status-${item.status}`}>{item.status === "completed" ? <DownloadSimple size={30} /> : ["failed", "canceled"].includes(item.status) ? <WarningCircle size={30} /> : <SpinnerGap size={30} className="spin-slow" />}</div>;
const Source = ({ item }) => /^https?:\/\//i.test(item.source)
  ? <a className="download-source" href={item.source} target="_blank" rel="noopener noreferrer" title={item.source}>{item.source}</a>
  : <span className="download-source" title={item.source}>{item.source}</span>;

function DownloadTable({ items, api, navigate, Thumb, selected, toggle, act, replace }) {
  return <div className="download-table-wrap"><table className="download-table">
    <colgroup><col className="w-select" /><col className="w-media" /><col className="w-status" /><col className="w-tags" /><col className="w-where" /><col className="w-date" /><col className="w-actions" /></colgroup>
    <thead><tr><th className="col-select"><span className="sr-only">Select</span></th><th>Media</th><th>Status</th><th>Tags</th><th className="col-where">Saved to</th><th className="col-date">Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
    <tbody>{items.map(item => {
      const asset = item.assets?.[0];
      return <tr key={item.id} className={selected.has(item.id) ? "is-selected" : ""}>
        <td className="col-select"><input type="checkbox" checked={selected.has(item.id)} onChange={event => toggle([item.id], event.target.checked)} aria-label={`Select ${item.title || item.source}`} /></td>
        <td className="col-media"><div className="media-cell">
          <div className="table-thumb">{asset ? <Thumb asset={asset} navigate={navigate} /> : <Placeholder item={item} />}</div>
          <div className="media-cell-copy"><strong title={item.title || item.source}>{item.title || item.source}</strong>{item.title && <Source item={item} />}{item.assets?.length > 1 && <small>{item.assets.length} files</small>}</div>
        </div></td>
        <td className="col-status"><Status item={item} /></td>
        <td className="col-tags"><Tags item={item} api={api} replace={replace} /></td>
        <td className="col-where"><span>{item.root_name}{item.subfolder ? ` / ${item.subfolder}` : ""}</span><small><Route item={item} /></small></td>
        <td className="col-date"><time dateTime={item.created_at}>{when(item.created_at)}</time></td>
        <td className="col-actions"><Actions item={item} act={act} navigate={navigate} /></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function DownloadGrid({ items, api, navigate, Thumb, selected, toggle, act, replace }) {
  return <div className="download-grid-view">{items.map(item => {
    const asset = item.assets?.[0];
    return <article key={item.id} className={`download-card ${selected.has(item.id) ? "is-selected" : ""}`}>
      <div className="download-card-media">
        {asset ? <Thumb asset={asset} navigate={navigate} /> : <div className="thumb"><Placeholder item={item} /></div>}
        <label className="card-select"><input type="checkbox" checked={selected.has(item.id)} onChange={event => toggle([item.id], event.target.checked)} aria-label={`Select ${item.title || item.source}`} /></label>
      </div>
      <div className="download-card-body">
        <div className="download-card-title"><strong title={item.title || item.source}>{item.title || item.source}</strong><Actions item={item} act={act} navigate={navigate} /></div>
        {item.status !== "completed" && <Status item={item} />}
        <small className="muted">{item.root_name}{item.subfolder ? ` / ${item.subfolder}` : ""} · <Route item={item} /> · {when(item.finished_at || item.created_at)}</small>
        <Tags item={item} api={api} replace={replace} />
      </div>
    </article>;
  })}</div>;
}
