"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CheckCircle, DownloadSimple, GearSix, LinkSimple, MagnifyingGlass, Plus, ShieldCheck, ShieldSlash, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { Modal } from "./modal.jsx";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";

export const active = status => ["queued", "running", "canceling"].includes(status);
const formStorage = "kiwi.download.form";
export const formatBytes = bytes => {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};
export const formatEta = seconds => {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = Math.round(seconds % 60);
  return h ? `${h}h ${m}m left` : m ? `${m}m ${s}s left` : `${s}s left`;
};

// Navbar entry point. The badge counts downloads that are queued or in progress.
export function UploadButton({ api, navigate }) {
  const [open, setOpen] = useState(false), [count, setCount] = useState(0);
  useEffect(() => {
    if (open) return; // The open dialog polls and reports the count itself.
    let timer, stopped = false;
    const poll = async () => {
      let running = 0;
      try { running = (await api("/api/v1/downloads?limit=50")).filter(item => active(item.status)).length; setCount(running); } catch {}
      if (!stopped) timer = setTimeout(poll, running ? 4000 : 20000);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [open]);
  return <>
    <button type="button" className="upload-button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={count ? `Upload from the web, ${count} active` : "Upload from the web"} title="Upload media from the web">
      <UploadSimple size={19} weight="bold" /><span>Upload</span>{count > 0 && <span className="upload-badge" aria-hidden="true">{count}</span>}
    </button>
    {open && <DownloadDialog api={api} navigate={navigate} close={() => setOpen(false)} onCount={setCount} />}
  </>;
}

// Link form shared by the Upload dialog and the Downloads page: links, destination, downloader, VPN, and tags.
export function DownloadForm({ api, onQueued, footer, rows = 3 }) {
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(formStorage) || "{}"); } catch { return {}; } }, []);
  const [options, setOptions] = useState(null), [loadError, setLoadError] = useState("");
  const [sources, setSources] = useState(""), [rootId, setRootId] = useState(saved.rootId || ""), [subfolder, setSubfolder] = useState(saved.subfolder || "");
  const [downloaderId, setDownloaderId] = useState(saved.downloaderId || ""), [vpn, setVpn] = useState(saved.vpn || "auto");
  const [topics, setTopics] = useState([]);
  const [tab, setTab] = useState("link"), [busy, setBusy] = useState(false), [message, setMessage] = useState(null);

  useEffect(() => {
    Promise.all([api("/api/v1/downloads/destinations"), api("/api/v1/downloaders"), api("/api/v1/vpn/profiles")]).then(([roots, downloaders, profiles]) => {
      setOptions({ roots, downloaders: downloaders.filter(item => item.enabled && item.installed), profiles });
      const writable = roots.filter(root => root.writable);
      setRootId(current => writable.some(root => root.id === current) ? current : writable[0]?.id || "");
      setDownloaderId(current => downloaders.some(item => item.id === current && item.enabled) ? current : "");
      setVpn(current => current === "auto" || current === "none" || profiles.some(profile => profile.id === current) ? current : "auto");
    }).catch(error => setLoadError(error.message));
  }, []);

  const lines = [...new Set(sources.split("\n").map(line => line.trim()).filter(Boolean))];
  const submit = async event => {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      const created = await api("/api/v1/downloads", { method: "POST", body: JSON.stringify({
        sources: lines, libraryRootId: rootId, subfolder, downloaderId: downloaderId || undefined, vpn,
        topics: topics.map(topic => topic.id ? { topicId: topic.id } : { name: topic.name }),
      }) });
      localStorage.setItem(formStorage, JSON.stringify({ rootId, subfolder, downloaderId, vpn }));
      setSources("");
      setMessage({ kind: "ok", text: `${created.length === 1 ? "Download" : `${created.length} downloads`} queued.` });
      onQueued?.(created);
    } catch (error) { setMessage({ kind: "error", text: error.message }); }
    finally { setBusy(false); }
  };
  const searchable = options?.downloaders.filter(item => item.searchable) || [];
  const roots = options?.roots || [];
  const noWritable = options && !roots.some(root => root.writable);

  if (loadError) return <div className="error-notice">{loadError}</div>;
  if (!options) return <div className="download-loading"><SpinnerGap className="spin" size={22} /> Loading…</div>;
  return <>
    {searchable.length > 0 && <div className="download-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "link"} className={tab === "link" ? "active" : ""} onClick={() => setTab("link")}><LinkSimple size={16} /> Links</button>
      <button type="button" role="tab" aria-selected={tab === "search"} className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><MagnifyingGlass size={16} /> Search</button>
    </div>}
    {tab === "search" && <SearchPanel api={api} downloaders={searchable} onPick={(source, downloader) => { setSources(current => `${current.trim() ? `${current.trim()}\n` : ""}${source}`); setDownloaderId(downloader); setTab("link"); }} />}
    {tab === "link" && <form className="download-form" onSubmit={submit}>
      <label htmlFor="download-sources">Links</label>
      <textarea id="download-sources" autoFocus rows={rows} value={sources} onChange={event => setSources(event.target.value)} spellCheck={false}
        placeholder={"https://www.youtube.com/watch?v=…\nmagnet:?xt=urn:btih:…"} />
      <small className="field-help">One link, magnet, or ID per line{lines.length > 1 ? ` · ${lines.length} links` : ""}.</small>
      <div className="download-grid">
        <div className="config-field"><label htmlFor="download-root">Save to</label>
          <select id="download-root" value={rootId} onChange={event => setRootId(event.target.value)} required>
            {!roots.length && <option value="">No library folders yet</option>}
            {roots.map(root => <option key={root.id} value={root.id} disabled={!root.writable}>{root.name}{root.writable ? "" : root.read_only ? " (read-only)" : " (not writable)"}</option>)}
          </select></div>
        <div className="config-field"><label htmlFor="download-subfolder">Subfolder <span className="optional">optional</span></label>
          <input id="download-subfolder" value={subfolder} onChange={event => setSubfolder(event.target.value)} placeholder="e.g. Web/2026" spellCheck={false} /></div>
        <div className="config-field"><label htmlFor="download-downloader">Downloader</label>
          <select id="download-downloader" value={downloaderId} onChange={event => setDownloaderId(event.target.value)}>
            <option value="">Automatic</option>
            {options.downloaders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>
        <div className="config-field"><label htmlFor="download-vpn">VPN</label>
          <select id="download-vpn" value={vpn} onChange={event => setVpn(event.target.value)}>
            <option value="auto">Automatic (rules)</option>
            <option value="none">No VPN</option>
            {options.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select></div>
      </div>
      <div className="config-field"><span className="field-label">Tags <span className="optional">added when each download finishes</span></span>
        <div className="download-topics chips">
          {topics.map(topic => <button type="button" key={topic.id || topic.name} title={`Remove ${topic.name}`} aria-label={`Remove tag ${topic.name}`} onClick={() => setTopics(current => current.filter(item => item !== topic))}><TopicLabel topic={topic} /><X size={14} /></button>)}
          <AddTag asset={{ title: "new downloads", topics }} api={api} label="Add tag" onPick={topic => setTopics(current => current.some(item => item.name.toLowerCase() === topic.name.toLowerCase()) ? current : [...current, topic.create ? { name: topic.name } : topic])} />
        </div></div>
      <PlanPreview api={api} source={lines[0]} downloaderId={downloaderId} vpn={vpn} extra={lines.length - 1} />
      {noWritable && <div className="error-notice">{roots.length ? roots.find(root => root.blocked_reason)?.blocked_reason : "Add a media library folder in Settings first."}</div>}
      {message && <div className={message.kind === "error" ? "error-notice" : "notice"} role="status">{message.text}</div>}
      <div className="download-actions">
        {footer || <span />}
        <button className="primary-button" disabled={busy || !lines.length || !rootId}>{busy ? <SpinnerGap className="spin" size={16} /> : <Plus size={16} />} {lines.length > 1 ? `Download ${lines.length}` : "Download"}</button>
      </div>
    </form>}
  </>;
}

function DownloadDialog({ api, navigate, close, onCount }) {
  const [downloads, setDownloads] = useState(null);
  useEffect(() => {
    let timer, stopped = false;
    const poll = async () => {
      let rows = [];
      try { rows = await api("/api/v1/downloads?limit=30"); setDownloads(rows); onCount(rows.filter(item => active(item.status)).length); } catch {}
      if (!stopped) timer = setTimeout(poll, rows.some(item => active(item.status)) ? 1500 : 6000);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const refresh = () => api("/api/v1/downloads?limit=30").then(rows => { setDownloads(rows); onCount(rows.filter(item => active(item.status)).length); }).catch(() => {});
  const go = href => { close(); navigate(href); };
  return <Modal title="Upload from the web" close={close} className="download-dialog">
    <DownloadForm api={api} onQueued={refresh} footer={<div className="download-links">
      <button type="button" className="text-button" onClick={() => go("/downloads")}><DownloadSimple size={16} /> All downloads</button>
      <button type="button" className="text-button" onClick={() => go("/settings#downloads")}><GearSix size={16} /> Downloaders &amp; VPN</button>
    </div>} />
    <DownloadList downloads={downloads?.slice(0, 8)} api={api} refresh={refresh} openAsset={id => go(`/watch/${id}`)} />
  </Modal>;
}

// Shows which downloader and VPN route the first link will take before it is queued.
function PlanPreview({ api, source, downloaderId, vpn, extra }) {
  const [plan, setPlan] = useState(null);
  useEffect(() => {
    if (!source) { setPlan(null); return; }
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ source, vpn, ...(downloaderId ? { downloaderId } : {}) });
      api(`/api/v1/downloads/plan?${query}`).then(value => setPlan({ value }), error => setPlan({ error: error.message }));
    }, 350);
    return () => clearTimeout(timer);
  }, [source, downloaderId, vpn]);
  if (!plan) return null;
  if (plan.error) return <div className="plan-preview is-error"><WarningCircle size={17} /> {plan.error}</div>;
  const { downloader, vpn: route } = plan.value;
  return <div className="plan-preview">
    {route.id ? <ShieldCheck size={17} className="vpn-on" /> : <ShieldSlash size={17} />}
    <span><strong>{downloader.name}</strong> · {route.id ? <>via <strong>{route.name}</strong></> : "no VPN"} <span className="muted">— {route.reason}{extra > 0 ? ` (first link; ${extra} more checked on submit)` : ""}</span></span>
  </div>;
}

function SearchPanel({ api, downloaders, onPick }) {
  const [downloader, setDownloader] = useState(downloaders[0].id), [query, setQuery] = useState(""), [state, setState] = useState({ status: "idle", results: [] });
  const search = async event => {
    event.preventDefault();
    setState({ status: "loading", results: [] });
    try { setState({ status: "done", ...await api(`/api/v1/downloaders/${downloader}/search`, { method: "POST", body: JSON.stringify({ query }) }) }); }
    catch (error) { setState({ status: "error", error: error.message, results: [] }); }
  };
  return <div className="download-search">
    <form onSubmit={search}>
      {downloaders.length > 1 && <select aria-label="Search with" value={downloader} onChange={event => setDownloader(event.target.value)}>{downloaders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
      <div className="download-search-field"><MagnifyingGlass size={17} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" aria-label="Search" /></div>
      <button className="outline-button" disabled={!query.trim() || state.status === "loading"}>Search</button>
    </form>
    {state.status === "loading" && <div className="download-loading"><SpinnerGap className="spin" size={20} /> Searching…</div>}
    {state.status === "error" && <div className="error-notice">{state.error}</div>}
    {state.status === "done" && !state.results.length && <p className="muted">No results.</p>}
    {state.results.length > 0 && <ul className="search-results">{state.results.map((result, index) => <li key={`${result.source}-${index}`}>
      <div><strong>{result.title}</strong>{(result.description || result.size) && <small>{[result.description, result.size && formatBytes(result.size)].filter(Boolean).join(" · ")}</small>}</div>
      <button type="button" className="outline-button" onClick={() => onPick(result.source, downloader)}><Plus size={15} /> Add</button>
    </li>)}</ul>}
  </div>;
}

function DownloadList({ downloads, api, refresh, openAsset }) {
  if (!downloads?.length) return null;
  return <section className="download-list" aria-label="Recent downloads">
    <h3>Recent downloads</h3>
    <ul>{downloads.map(item => <DownloadItem key={item.id} item={item} api={api} refresh={refresh} openAsset={openAsset} />)}</ul>
  </section>;
}

export function DownloadItem({ item, api, refresh, openAsset }) {
  const [details, setDetails] = useState(null), [busy, setBusy] = useState(false);
  const act = async (path, method = "POST") => { setBusy(true); try { await api(`/api/v1/downloads/${item.id}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) }); await refresh(); } catch {} finally { setBusy(false); } };
  const toggleDetails = async () => setDetails(details ? null : await api(`/api/v1/downloads/${item.id}`).catch(error => ({ log: error.message })));
  const running = item.status === "running";
  const percent = item.progress != null ? Math.round(item.progress * 100) : null;
  const stats = running ? [item.bytes_done != null && (item.bytes_total ? `${formatBytes(item.bytes_done)} of ${formatBytes(item.bytes_total)}` : formatBytes(item.bytes_done)), item.speed && `${formatBytes(item.speed)}/s`, formatEta(item.eta_seconds)].filter(Boolean).join(" · ") : "";
  const StatusIcon = item.status === "completed" ? CheckCircle : item.status === "failed" ? WarningCircle : active(item.status) ? SpinnerGap : X;
  return <li className={`download-item status-${item.status}`}>
    <div className="download-item-head">
      <StatusIcon size={18} className={active(item.status) ? "spin-slow" : ""} aria-hidden="true" />
      <div className="download-item-copy">
        <strong title={item.source}>{item.title || item.source}</strong>
        <small>{item.message || item.status}{percent != null && running ? ` · ${percent}%` : ""}{stats ? ` · ${stats}` : ""}</small>
        <small className="download-route">{item.root_name}{item.subfolder ? ` / ${item.subfolder}` : ""} · {item.downloader_name}{item.vpn_name ? <> · <ShieldCheck size={12} className="vpn-on" /> {item.vpn_name}</> : ""}</small>
      </div>
      <div className="download-item-actions">
        {item.status === "completed" && item.asset_ids?.length > 0 && <button type="button" className="icon-button" title="Open" aria-label={`Open ${item.title || "download"}`} onClick={() => openAsset(item.asset_ids[0])}><ArrowSquareOut size={17} /></button>}
        {(item.status === "queued" || running) && <button type="button" className="icon-button" disabled={busy} title="Cancel" aria-label="Cancel download" onClick={() => act("/cancel")}><X size={17} /></button>}
        {["failed", "canceled"].includes(item.status) && <button type="button" className="icon-button" disabled={busy} title="Retry" aria-label="Retry download" onClick={() => act("/retry")}><ArrowClockwise size={17} /></button>}
        {!active(item.status) && <button type="button" className="icon-button" disabled={busy} title="Remove from list" aria-label="Remove from list" onClick={() => act("", "DELETE")}><Trash size={17} /></button>}
      </div>
    </div>
    {active(item.status) && <div className={`download-progress ${percent == null ? "is-indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span style={percent == null ? undefined : { width: `${percent}%` }} /></div>}
    {item.status === "failed" && <p className="download-error">{item.error}</p>}
    {(item.status === "failed" || item.status === "completed") && <button type="button" className="text-button small" onClick={toggleDetails}>{details ? "Hide details" : "Details"}</button>}
    {details && <pre className="download-log">{details.log || "No output recorded."}{details.files?.length ? `\n\nSaved:\n${details.files.join("\n")}` : ""}</pre>}
  </li>;
}
