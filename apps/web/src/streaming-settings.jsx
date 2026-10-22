"use client";

import { useEffect, useState } from "react";
import { ArrowCounterClockwise, ArrowDown, ArrowUp, CheckCircle, FloppyDisk, Plus, SpinnerGap, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { ConfigFields } from "./config-fields.jsx";

const RESOLUTIONS = [[480, "480p"], [720, "720p"], [1080, "1080p (Full HD)"], [2160, "2160p (4K)"]];
const list = value => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
const text = value => (value || []).join(", ");

function Toggle({ checked, onChange, label, help, disabled }) {
  return <label className="config-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}{help && <small className="field-help">{help}</small>}</span></label>;
}

// Languages in order of preference: the first one you can follow wins.
function LanguageOrder({ value, languages, onChange, label }) {
  const name = code => languages.find(item => item.code === code)?.name || code;
  const available = languages.filter(item => !value.includes(item.code));
  const move = (index, step) => { const next = [...value]; [next[index], next[index + step]] = [next[index + step], next[index]]; onChange(next); };
  return <div className="language-order" role="group" aria-label={label}>
    <ol>{value.map((code, index) => <li key={code}>
      <span className="language-rank">{index + 1}</span><strong>{name(code)}</strong>
      <span className="language-actions">
        <button className="icon-button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${name(code)} up`}><ArrowUp size={15} /></button>
        <button className="icon-button" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${name(code)} down`}><ArrowDown size={15} /></button>
        <button className="icon-button" disabled={value.length <= 1} onClick={() => onChange(value.filter(item => item !== code))} aria-label={`Remove ${name(code)}`}><X size={15} /></button>
      </span></li>)}</ol>
    {available.length > 0 && <select aria-label={`Add to ${label}`} value="" onChange={event => event.target.value && onChange([...value, event.target.value])}><option value="">Add a language…</option>{available.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select>}
  </div>;
}

function ProviderCard({ provider, api, reload }) {
  const [config, setConfig] = useState(provider.config), [clear, setClear] = useState([]), [enabled, setEnabled] = useState(provider.enabled);
  const [state, setState] = useState({ busy: "", message: "", error: "" });
  const indexer = provider.kind === "indexer";
  const save = async () => {
    setState({ busy: "save", message: "", error: "" });
    try { await api(`/api/v1/media/providers/${provider.id}`, { method: "PUT", body: JSON.stringify({ config, clearSecrets: clear, enabled }) }); setClear([]); await reload(); setState({ busy: "", message: "Saved.", error: "" }); }
    catch (error) { setState({ busy: "", message: "", error: error.message }); }
  };
  const test = async () => {
    setState({ busy: "test", message: "", error: "" });
    try { const result = await api(`/api/v1/media/providers/${provider.id}/test`, { method: "POST" }); setState({ busy: "", message: result.message || "Connected.", error: "" }); }
    catch (error) { setState({ busy: "", message: "", error: error.message }); }
  };
  const ready = provider.configured || !provider.fields.some(field => field.required);
  return <li className="provider-card">
    <div className="provider-head">
      <div><strong>{provider.name}<span className={`pill ${ready && provider.enabled ? "accent" : ""}`}>{ready ? (provider.enabled ? "On" : "Off") : "Not set up"}</span></strong><small>{provider.description}</small></div>
    </div>
    <ConfigFields fields={provider.fields} values={config} secrets={provider.secrets} onChange={setConfig} cleared={clear} onClear={setClear} api={api} disabled={state.busy !== ""} />
    {indexer && <Toggle checked={enabled} onChange={setEnabled} label="Use this indexer" />}
    <div className="provider-actions">
      <button className="primary-button" disabled={state.busy !== ""} onClick={save}>{state.busy === "save" ? <SpinnerGap className="spin" /> : <FloppyDisk />}Save</button>
      <button className="outline-button" disabled={state.busy !== "" || !ready} onClick={test}>{state.busy === "test" ? <SpinnerGap className="spin" /> : null}Test connection</button>
      {state.message && <span className="provider-ok" role="status"><CheckCircle size={16} weight="fill" /> {state.message}</span>}
      {state.error && <span className="field-error" role="alert"><WarningCircle size={16} /> {state.error}</span>}
    </div>
  </li>;
}

export function StreamingSettings({ api }) {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [rules, setRules] = useState(null), [playback, setPlayback] = useState(null), [downloads, setDownloads] = useState(null), [cache, setCache] = useState(null);
  const [notes, setNotes] = useState({}), [busy, setBusy] = useState("");
  const load = async () => {
    const value = await api("/api/v1/media/settings");
    setData(value); setRules(value.rules); setPlayback(value.playback); setDownloads(value.downloads);
    api("/api/v1/media/cache").then(setCache).catch(() => {});
  };
  useEffect(() => { load().then(() => { if (location.hash === "#streaming") document.getElementById("streaming")?.scrollIntoView(); }).catch(failure => setError(failure.message)); }, []);
  const run = (key, action) => async () => {
    setBusy(key); setNotes(current => ({ ...current, [key]: "" }));
    try { const message = await action(); setNotes(current => ({ ...current, [key]: message || "Saved." })); }
    catch (failure) { setNotes(current => ({ ...current, [key]: `⚠ ${failure.message}` })); }
    finally { setBusy(""); }
  };
  if (!data || !rules) return <section id="streaming" className="settings-card download-settings"><div><h2>Streaming</h2><p>{error || "Loading…"}</p></div></section>;
  const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
  const writable = data.roots.filter(root => !root.read_only);
  const setRule = patch => setRules(current => ({ ...current, ...patch }));
  const setAnime = patch => setRules(current => ({ ...current, anime: { ...current.anime, ...patch } }));
  const note = key => notes[key] && <span className={notes[key].startsWith("⚠") ? "field-error" : "provider-ok"} role="status">{notes[key]}</span>;
  const sizeMb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  return <>
    <section id="streaming" className="settings-card download-settings">
      <div className="settings-card-head"><div><h2>Catalogs and sources</h2><p>Movies, TV shows, and anime come from a metadata catalog and play from TorBox. Add your keys here; they stay on the server and are never shown again.</p></div></div>
      <ul className="settings-list provider-list">{data.providers.map(provider => <ProviderCard key={provider.id} provider={provider} api={api} reload={load} />)}</ul>
    </section>

    <section className="settings-card download-settings">
      <div className="settings-card-head"><div><h2>Source rules</h2><p>Kiwi ranks every release it finds with these rules and plays the best one, so you never have to choose. The defaults favor 1080p that plays directly in a browser, releases TorBox already has, and English-friendly audio.</p></div></div>
      <div className="rules-grid">
        <div className="config-field"><label htmlFor="rule-preferred">Preferred quality</label><select id="rule-preferred" value={rules.preferredResolution} onChange={event => setRule({ preferredResolution: Number(event.target.value) })}>{RESOLUTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small className="field-help">The best match. Higher or lower is still allowed, just ranked lower.</small></div>
        <div className="config-field"><label htmlFor="rule-min">Lowest quality</label><select id="rule-min" value={rules.minResolution} onChange={event => setRule({ minResolution: Number(event.target.value) })}>{RESOLUTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="config-field"><label htmlFor="rule-max">Highest quality</label><select id="rule-max" value={rules.maxResolution} onChange={event => setRule({ maxResolution: Number(event.target.value) })}>{RESOLUTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="config-field"><label htmlFor="rule-size">Size limit (GB per hour)</label><input id="rule-size" type="number" min="1" max="100" value={rules.maxGbPerHour} onChange={event => setRule({ maxGbPerHour: Number(event.target.value) })} /><small className="field-help">Keeps streams smooth on ordinary connections. About 5 GB/hour is typical for 1080p.</small></div>
      </div>
      <div className="rules-toggles">
        <Toggle checked={rules.requireCached} onChange={value => setRule({ requireCached: value })} label="Only instant sources" help="Play only releases TorBox already has, so playback starts in seconds. Turning this off lets slower torrents be chosen." />
        <Toggle checked={rules.directPlay} onChange={value => setRule({ directPlay: value })} label="Prefer files that play directly" help="Favors H.264 video and common audio so nothing needs converting on the server." />
        <Toggle checked={rules.allowHdr} onChange={value => setRule({ allowHdr: value })} label="Allow HDR and Dolby Vision" help="Usually looks washed out on standard screens, so these are ranked lower unless you turn this on." />
        <Toggle checked={rules.avoidHardcodedSubs} onChange={value => setRule({ avoidHardcodedSubs: value })} label="Avoid burned-in subtitles" help="Subtitles baked into the picture can't be turned off or changed." />
      </div>
      <div className="rules-grid wide">
        <div className="config-field"><label htmlFor="rule-exclude">Never use releases containing</label><textarea id="rule-exclude" rows={2} value={text(rules.excludeTerms)} onChange={event => setRule({ excludeTerms: list(event.target.value) })} /><small className="field-help">Separate with commas. Cam, screener, and telesync copies are always excluded.</small></div>
        <div className="config-field"><label htmlFor="rule-prefer">Preferred release groups</label><textarea id="rule-prefer" rows={2} value={text(rules.preferGroups)} onChange={event => setRule({ preferGroups: list(event.target.value) })} /></div>
        <div className="config-field"><label htmlFor="rule-avoid">Avoid release groups</label><textarea id="rule-avoid" rows={2} value={text(rules.avoidGroups)} onChange={event => setRule({ avoidGroups: list(event.target.value) })} /></div>
      </div>
      <h3 className="settings-subhead">Anime</h3>
      <div className="rules-toggles">
        <Toggle checked={rules.anime.preferDualAudio} onChange={value => setAnime({ preferDualAudio: value })} label="Prefer dual audio and English dubs" help="Releases with both Japanese and English audio rank first; Japanese with subtitles is next." />
        <Toggle checked={rules.anime.allowBatches} onChange={value => setAnime({ allowBatches: value })} label="Allow batch releases" help="Whole-season packs are fine when no single-episode release is available." />
      </div>
      <div className="config-field"><label htmlFor="rule-anime-groups">Preferred anime groups</label><textarea id="rule-anime-groups" rows={2} value={text(rules.anime.preferGroups)} onChange={event => setAnime({ preferGroups: list(event.target.value) })} /></div>
      <div className="settings-actions">
        <button className="primary-button" disabled={busy !== ""} onClick={run("rules", async () => { setRules(await put("/api/v1/media/rules", rules)); return "Saved."; })}>{busy === "rules" ? <SpinnerGap className="spin" /> : <FloppyDisk />}Save rules</button>
        <button className="outline-button" disabled={busy !== ""} onClick={run("rules", async () => { setRules(await api("/api/v1/media/rules/reset", { method: "POST" })); return "Back to the defaults."; })}><ArrowCounterClockwise />Reset to defaults</button>
        {note("rules")}
      </div>
    </section>

    <section className="settings-card download-settings">
      <div className="settings-card-head"><div><h2>Language and subtitles</h2><p>Audio and subtitles start in the first language below that the file has. Your choices while watching a series are remembered for the rest of its episodes.</p></div></div>
      <div className="language-columns">
        <div><h3 className="settings-subhead">Audio, in order</h3><LanguageOrder label="audio languages" value={playback.audioLanguages} languages={data.languages} onChange={value => setPlayback(current => ({ ...current, audioLanguages: value }))} /></div>
        <div><h3 className="settings-subhead">Subtitles, in order</h3><LanguageOrder label="subtitle languages" value={playback.subtitleLanguages} languages={data.languages} onChange={value => setPlayback(current => ({ ...current, subtitleLanguages: value }))} /></div>
      </div>
      <div className="config-field"><label htmlFor="subtitle-mode">Subtitles</label>
        <select id="subtitle-mode" value={playback.subtitleMode} onChange={event => setPlayback(current => ({ ...current, subtitleMode: event.target.value }))}>
          <option value="auto">Automatic — on when the audio isn't your first language</option><option value="always">Always on</option><option value="off">Off</option></select></div>
      <div className="settings-actions">
        <button className="primary-button" disabled={busy !== ""} onClick={run("playback", async () => { setPlayback(await put("/api/v1/media/playback", playback)); return "Saved."; })}>{busy === "playback" ? <SpinnerGap className="spin" /> : <FloppyDisk />}Save</button>{note("playback")}
      </div>
    </section>

    <section className="settings-card download-settings">
      <div className="settings-card-head"><div><h2>Saving movies and episodes</h2><p>Choose where downloaded movies and episodes go. They are named like <code>TV Shows/Show (2020)/Season 01/Show - S01E02 - Title.mkv</code>, and a saved copy plays from disk from then on, keeping its progress, likes, and tags.</p></div></div>
      {!writable.length ? <p className="muted">No folder allows downloads yet. Add one under Media libraries above, or allow downloads for an existing folder.</p> : <>
        <div className="config-field"><label htmlFor="download-root">Download folder</label>
          <select id="download-root" value={downloads.rootId || ""} onChange={event => setDownloads(current => ({ ...current, rootId: event.target.value || null }))}>
            <option value="">Not chosen</option>{writable.map(root => <option key={root.id} value={root.id}>{root.name} — {root.absolute_path}</option>)}</select></div>
        <div className="rules-grid">
          <div className="config-field"><label htmlFor="folder-movies">Movies folder</label><input id="folder-movies" value={downloads.moviesFolder} onChange={event => setDownloads(current => ({ ...current, moviesFolder: event.target.value }))} /></div>
          <div className="config-field"><label htmlFor="folder-shows">TV shows folder</label><input id="folder-shows" value={downloads.showsFolder} onChange={event => setDownloads(current => ({ ...current, showsFolder: event.target.value }))} /></div>
          <div className="config-field"><label htmlFor="folder-anime">Anime folder</label><input id="folder-anime" value={downloads.animeFolder} onChange={event => setDownloads(current => ({ ...current, animeFolder: event.target.value }))} /></div>
        </div>
        <div className="settings-actions">
          <button className="primary-button" disabled={busy !== ""} onClick={run("downloads", async () => { setDownloads(await put("/api/v1/media/downloads", downloads)); return "Saved."; })}>{busy === "downloads" ? <SpinnerGap className="spin" /> : <FloppyDisk />}Save</button>{note("downloads")}
        </div></>}
    </section>

    <section className="settings-card download-settings">
      <div className="settings-card-head"><div><h2>Cache</h2><p>Catalog answers and artwork are stored locally so browsing is fast and stays within each service's rate limits. Clearing it only means things are fetched again.</p></div>
        <button className="outline-button" disabled={busy !== ""} onClick={run("cache", async () => { setCache(await api("/api/v1/media/cache", { method: "DELETE" })); return "Cleared."; })}><Trash />Clear cache</button></div>
      {cache && <ul className="cache-stats">{cache.providers.map(item => <li key={item.provider}><strong>{item.provider}</strong><span>{item.entries} cached answers · {sizeMb(item.bytes || 0)}</span>{item.stats && <small>{item.stats.requests} requests · {item.stats.hits} cache hits · {item.stats.rateLimited} rate-limited</small>}</li>)}
        <li><strong>Artwork</strong><span>{cache.images.entries} images · {sizeMb(cache.images.bytes)}</span><small>{cache.images.pinned} kept for your list</small></li></ul>}
      {note("cache")}
    </section>
  </>;
}
