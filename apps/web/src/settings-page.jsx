"use client";
import { useEffect, useState } from "react";
import { FolderOpen, Plus, X } from "@phosphor-icons/react";

import { AddTag } from "./add-tag";
import { TopicLabel } from "./topic-label";

export function SettingsPage({ api }) {
  const [roots, setRoots] = useState(null), [jobs, setJobs] = useState([]);
  const [path, setPath] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const load = async () => {
    const [folders, recent] = await Promise.all([api("/api/v1/library/roots"), api("/api/v1/jobs")]);
    setRoots(folders); setJobs(recent);
  };
  useEffect(() => {
    const refresh = () => load().catch(error => setMessage(error.message));
    refresh(); const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);
  const perform = async action => {
    setBusy(true); setMessage("");
    try { await action(); await load(); } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  return <div className="content settings-page narrow">
    <div className="section-heading"><div><span className="eyebrow">Server</span><h1>Settings</h1><p>Manage local library ingestion and server status.</p></div></div>
    <section className="settings-card">
      <div><h2>Media libraries</h2><p>Connected folders are saved in your library. Originals are never modified.</p></div>
      <button className="primary-button" disabled={busy || !roots?.some(root => root.enabled)} onClick={() => perform(async () => {
        const result = await api("/api/v1/library/scan", { method: "POST" });
        setMessage(`${result.queued} scan job${result.queued === 1 ? "" : "s"} queued`);
      })}><FolderOpen /> Scan library</button>
      <div className="library-folders">
        {roots === null ? <p>Loading folders…</p> : roots.length === 0 ? <p>No folders connected yet.</p> : roots.map(root => <div className="library-folder" key={root.id}>
          <div><strong>{root.name}</strong><p>{root.absolute_path}</p><small>{root.enabled ? "Scanning enabled" : "Scanning paused"}</small>
            <div className="folder-tags chips" aria-label={`Tags for ${root.name}`}>
              {root.topics?.map(topic => <button key={topic.id} disabled={busy} title={`Remove ${topic.name} from this folder`} aria-label={`Remove ${topic.name} from ${root.name}`} onClick={() => perform(() => api(`/api/v1/library/roots/${root.id}/topics/${topic.id}`, { method: "DELETE" }))}><TopicLabel topic={topic}/><X size={14}/></button>)}
              <AddTag asset={root} api={api} endpoint={`/api/v1/library/roots/${root.id}/topics`} onChange={topics => setRoots(current => current.map(folder => folder.id === root.id ? { ...folder, topics } : folder))}/>
            </div>
          </div>
          <button className="outline-button" disabled={busy} aria-label={`${root.enabled ? "Pause" : "Enable"} scanning for ${root.absolute_path}`} onClick={() => perform(() => api(`/api/v1/library/roots/${root.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !root.enabled }) }))}>{root.enabled ? "Pause scanning" : "Enable scanning"}</button>
        </div>)}
      </div>
      <form className="library-folder-form" onSubmit={event => { event.preventDefault(); perform(async () => {
        await api("/api/v1/library/roots", { method: "POST", body: JSON.stringify({ path }) }); setPath("");
      }); }}>
        <label htmlFor="library-folder-path">Folder path on the server</label>
        <div><input id="library-folder-path" value={path} onChange={event => setPath(event.target.value)} placeholder="/mnt/media/videos" required disabled={busy} /><button className="primary-button" disabled={busy || !path}><Plus /> Add folder</button></div>
      </form>
      <p>Folder tags apply to all imported content, including subfolders and future imports.</p>
      <p>Pausing excludes a folder from future scans. Jobs already queued continue, and imported media stays in your library.</p>
      {message && <div className="notice" role="status">{message}</div>}
    </section>
    <section><h2>Recent jobs</h2><div className="job-list">{jobs.length ? jobs.map(job => <div key={job.id}><span className={`status ${job.status}`} /><div><strong>{job.type}</strong><small>{job.status} · {Math.round(job.progress * 100)}%</small></div></div>) : <p className="muted">No background jobs yet.</p>}</div></section>
  </div>;
}
