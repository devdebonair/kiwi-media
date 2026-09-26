"use client";
import { useEffect, useState } from "react";
import { Cookie, Globe, PencilSimple, Plus, ShieldCheck, SpinnerGap, Star, Trash, WarningCircle } from "@phosphor-icons/react";
import { ConfigFields } from "./config-fields.jsx";
import { Modal } from "./modal.jsx";

export function DownloadSettings({ api }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [editor, setEditor] = useState(null), [busy, setBusy] = useState(false);
  const load = async () => {
    const [plugins, downloaders, types, profiles, rules] = await Promise.all(["/api/v1/downloads/plugins", "/api/v1/downloaders", "/api/v1/vpn/types", "/api/v1/vpn/profiles", "/api/v1/vpn/rules"].map(path => api(path)));
    setData({ ...plugins, downloaders, types, profiles, rules });
  };
  useEffect(() => {
    load().then(() => { if (location.hash === "#downloads") document.getElementById("downloads")?.scrollIntoView(); }).catch(failure => setError(failure.message));
  }, []);
  const perform = async action => {
    setBusy(true); setError("");
    try { await action(); await load(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  if (!data) return <section id="downloads" className="settings-card download-settings"><div><h2>Downloads</h2><p>{error || "Loading…"}</p></div></section>;
  const pluginFor = id => data.plugins.find(plugin => plugin.id === id);
  const typeFor = id => data.types.find(type => type.id === id);

  return <>
    <section id="downloads" className="settings-card download-settings">
      <div className="settings-card-head">
        <div><h2>Downloaders</h2><p>Sources used by the Upload button. Kiwi picks the default downloader unless another one fits the link better.</p></div>
        <button className="primary-button" disabled={busy} onClick={() => setEditor({ kind: "pick-plugin" })}><Plus /> Add downloader</button>
      </div>
      <ul className="settings-list">{data.downloaders.map(item => {
        const plugin = pluginFor(item.plugin);
        const profile = data.profiles.find(entry => entry.id === item.vpn_profile_id);
        return <li key={item.id}>
          <div className="settings-list-copy">
            <strong>{item.name}{item.is_default && <span className="pill accent"><Star size={12} weight="fill" /> Default</span>}{!item.enabled && <span className="pill">Off</span>}</strong>
            <small>{item.pluginName}{profile && <> · <ShieldCheck size={13} className="vpn-on" /> {profile.name}</>}{item.cookies && <> · <Cookie size={13} /> {item.hasCookies ? "Cookies saved" : "No cookies"}</>}</small>
            {!item.installed && <small className="field-error">Plugin “{item.plugin}” is not installed.</small>}
            {plugin && !plugin.available && <small className="field-error">{plugin.unavailableReason}</small>}
          </div>
          <div className="settings-list-actions">
            {!item.is_default && <button className="outline-button" disabled={busy} onClick={() => perform(() => api(`/api/v1/downloaders/${item.id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) }))}>Make default</button>}
            <button className="outline-button" disabled={busy} onClick={() => perform(() => api(`/api/v1/downloaders/${item.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) }))}>{item.enabled ? "Turn off" : "Turn on"}</button>
            <button className="icon-button" disabled={busy || !plugin} aria-label={`Edit ${item.name}`} title="Edit" onClick={() => setEditor({ kind: "downloader", item, plugin })}><PencilSimple size={18} /></button>
            <button className="icon-button" disabled={busy} aria-label={`Delete ${item.name}`} title="Delete" onClick={() => confirm(`Delete ${item.name}?`) && perform(() => api(`/api/v1/downloaders/${item.id}`, { method: "DELETE" }))}><Trash size={18} /></button>
          </div>
        </li>;
      })}</ul>
      {data.errors.map(entry => <div key={entry.file} className="error-notice"><WarningCircle size={18} /> Plugin {entry.file} could not load: {entry.error}</div>)}
      <p className="settings-footnote">Custom downloader plugins are JavaScript modules placed in <code>{data.directory}</code>. They run with the server's permissions, so only install plugins you trust.</p>
    </section>

    <section className="settings-card download-settings">
      <div className="settings-card-head">
        <div><h2>VPN profiles</h2><p>Route downloads through a VPN provider's proxy or a WireGuard tunnel without installing a VPN on the server. Downloads assigned to a VPN stop rather than fall back to the server's own connection.</p></div>
        <button className="primary-button" disabled={busy} onClick={() => setEditor({ kind: "pick-vpn" })}><Plus /> Add VPN profile</button>
      </div>
      {data.profiles.length ? <ul className="settings-list">{data.profiles.map(profile => <VpnRow key={profile.id} profile={profile} type={typeFor(profile.type)} api={api} busy={busy}
        edit={() => setEditor({ kind: "vpn", item: profile, type: typeFor(profile.type) })}
        remove={() => confirm(`Delete ${profile.name}?`) && perform(() => api(`/api/v1/vpn/profiles/${profile.id}`, { method: "DELETE" }))} />)}</ul>
        : <p className="muted">No VPN profiles yet.</p>}
    </section>

    <section className="settings-card download-settings">
      <div className="settings-card-head"><div><h2>VPN by website</h2><p>Always use a VPN profile for a site and its subdomains. Site rules take priority over a downloader's default VPN; you can still override both for a single download.</p></div></div>
      {data.rules.length > 0 && <ul className="settings-list">{data.rules.map(rule => <li key={rule.domain}>
        <div className="settings-list-copy"><strong><Globe size={15} /> {rule.domain}</strong><small><ShieldCheck size={13} className="vpn-on" /> {rule.vpn_name}</small></div>
        <div className="settings-list-actions"><button className="icon-button" disabled={busy} aria-label={`Remove rule for ${rule.domain}`} title="Remove" onClick={() => perform(() => api(`/api/v1/vpn/rules/${encodeURIComponent(rule.domain)}`, { method: "DELETE" }))}><Trash size={18} /></button></div>
      </li>)}</ul>}
      {data.profiles.length ? <RuleForm profiles={data.profiles} busy={busy} add={(domain, vpnProfileId) => perform(() => api("/api/v1/vpn/rules", { method: "POST", body: JSON.stringify({ domain, vpnProfileId }) }))} />
        : <p className="muted">Add a VPN profile to create website rules.</p>}
    </section>
    {error && <div className="error-notice" role="alert">{error}</div>}

    {editor?.kind === "pick-plugin" && <Modal title="Add downloader" close={() => setEditor(null)} className="settings-dialog">
      <ul className="choice-list">{data.plugins.map(plugin => <li key={plugin.id}><button type="button" onClick={() => setEditor({ kind: "downloader", plugin })}>
        <strong>{plugin.name}{!plugin.builtIn && <span className="pill">Plugin</span>}</strong><small>{plugin.description}</small>{!plugin.available && <small className="field-error">{plugin.unavailableReason}</small>}
      </button></li>)}</ul>
    </Modal>}
    {editor?.kind === "pick-vpn" && <Modal title="Add VPN profile" close={() => setEditor(null)} className="settings-dialog">
      <ul className="choice-list">{data.types.map(type => <li key={type.id}><button type="button" onClick={() => setEditor({ kind: "vpn", type })}>
        <strong>{type.name}</strong><small>{type.description}</small>{!type.available && <small className="field-error">{type.unavailableReason}</small>}
      </button></li>)}</ul>
    </Modal>}
    {editor?.kind === "downloader" && <DownloaderEditor api={api} plugin={editor.plugin} item={editor.item} profiles={data.profiles} close={() => setEditor(null)} saved={() => { setEditor(null); load(); }} />}
    {editor?.kind === "vpn" && <VpnEditor api={api} type={editor.type} item={editor.item} close={() => setEditor(null)} saved={() => { setEditor(null); load(); }} />}
  </>;
}

function VpnRow({ profile, type, api, busy, edit, remove }) {
  const [test, setTest] = useState(null);
  const run = async () => {
    setTest({ status: "loading" });
    try { setTest({ status: "done", ...await api(`/api/v1/vpn/profiles/${profile.id}/test`, { method: "POST", body: "{}" }) }); }
    catch (failure) { setTest({ status: "error", error: failure.message }); }
  };
  const uses = [...profile.downloaders.map(item => item.name), ...profile.domains];
  const place = info => [info.city, info.country].filter(Boolean).join(", ");
  return <li>
    <div className="settings-list-copy">
      <strong><ShieldCheck size={16} className="vpn-on" /> {profile.name}</strong>
      <small>{type?.name || profile.type}{profile.config.url ? ` · ${profile.config.url}` : ""}{uses.length ? ` · Used by ${uses.join(", ")}` : ""}</small>
      {test?.status === "loading" && <small><SpinnerGap size={13} className="spin" /> Connecting…</small>}
      {test?.status === "error" && <small className="field-error">{test.error}</small>}
      {test?.status === "done" && <small className={test.changed ? "vpn-result" : "field-error"}>
        {test.changed ? "Connected" : "Warning: the exit address matches the server's own address"} · exit IP {test.vpn.ip}{place(test.vpn) ? ` (${place(test.vpn)})` : ""}{test.server ? ` · server IP ${test.server.ip}` : ""}
      </small>}
    </div>
    <div className="settings-list-actions">
      <button className="outline-button" disabled={busy || test?.status === "loading"} onClick={run}>Test</button>
      <button className="icon-button" disabled={busy} aria-label={`Edit ${profile.name}`} title="Edit" onClick={edit}><PencilSimple size={18} /></button>
      <button className="icon-button" disabled={busy} aria-label={`Delete ${profile.name}`} title="Delete" onClick={remove}><Trash size={18} /></button>
    </div>
  </li>;
}

function RuleForm({ profiles, busy, add }) {
  const [domain, setDomain] = useState(""), [profile, setProfile] = useState(profiles[0].id);
  return <form className="rule-form" onSubmit={event => { event.preventDefault(); add(domain, profile); setDomain(""); }}>
    <input aria-label="Website" value={domain} onChange={event => setDomain(event.target.value)} placeholder="youtube.com" spellCheck={false} required />
    <select aria-label="VPN profile" value={profile} onChange={event => setProfile(event.target.value)}>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    <button className="outline-button" disabled={busy || !domain.trim()}><Plus size={16} /> Add rule</button>
  </form>;
}

function useSave(saved) {
  const [state, setState] = useState({ busy: false, error: "" });
  const save = async work => {
    setState({ busy: true, error: "" });
    try { await work(); saved(); } catch (failure) { setState({ busy: false, error: failure.message }); }
  };
  return [state, save];
}

function DownloaderEditor({ api, plugin, item, profiles, close, saved }) {
  const [name, setName] = useState(item?.name || plugin.name), [values, setValues] = useState(item?.config || {});
  const [vpn, setVpn] = useState(item?.vpn_profile_id || ""), [isDefault, setDefault] = useState(Boolean(item?.is_default));
  const [cookies, setCookies] = useState(null), [removeCookies, setRemoveCookies] = useState(false), [cleared, setCleared] = useState([]);
  const [state, save] = useSave(saved);
  const submit = event => {
    event.preventDefault();
    save(async () => {
      const body = { name, config: values, clearSecrets: cleared, vpnProfileId: vpn || null, ...(isDefault ? { isDefault: true } : {}) };
      const result = item ? await api(`/api/v1/downloaders/${item.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/api/v1/downloaders", { method: "POST", body: JSON.stringify({ ...body, plugin: plugin.id }) });
      if (cookies) await api(`/api/v1/downloaders/${result.id}/cookies`, { method: "PUT", body: JSON.stringify({ content: cookies.text }) });
      else if (removeCookies) await api(`/api/v1/downloaders/${result.id}/cookies`, { method: "DELETE" });
    });
  };
  return <Modal title={item ? `Edit ${item.name}` : `Add ${plugin.name}`} close={close} className="settings-dialog">
    <form className="settings-form" onSubmit={submit}>
      <p className="muted">{plugin.description}</p>
      {!plugin.available && <div className="error-notice">{plugin.unavailableReason}</div>}
      <div className="config-field"><label htmlFor="downloader-name">Name</label><input id="downloader-name" value={name} onChange={event => setName(event.target.value)} required maxLength={100} /></div>
      <ConfigFields fields={plugin.fields} values={values} secrets={item?.secrets} onChange={setValues} cleared={cleared} onClear={setCleared} api={api} />
      <div className="config-field"><label htmlFor="downloader-vpn">Default VPN</label>
        <select id="downloader-vpn" value={vpn} onChange={event => setVpn(event.target.value)}>
          <option value="">None</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select><small className="field-help">Used for this downloader unless a website rule or the download itself chooses another.</small></div>
      {plugin.cookies && <div className="config-field"><label htmlFor="downloader-cookies">Cookies (cookies.txt)</label>
        <input id="downloader-cookies" type="file" accept=".txt,text/plain" onChange={async event => {
          const file = event.target.files?.[0];
          setCookies(file ? { name: file.name, text: await file.text() } : null); setRemoveCookies(false);
        }} />
        <small className="field-help">{cookies ? `${cookies.name} will be saved.` : item?.hasCookies && !removeCookies ? "A cookies file is saved. Choose a new file to replace it." : "Netscape-format cookies let the downloader use your signed-in sessions (for age-restricted or members-only media)."}</small>
        {item?.hasCookies && !cookies && <label className="config-toggle"><input type="checkbox" checked={removeCookies} onChange={event => setRemoveCookies(event.target.checked)} /><span>Remove saved cookies</span></label>}
      </div>}
      {!item?.is_default && <label className="config-toggle"><input type="checkbox" checked={isDefault} onChange={event => setDefault(event.target.checked)} /><span>Make this the default downloader</span></label>}
      {state.error && <div className="error-notice" role="alert">{state.error}</div>}
      <button className="primary-button" disabled={state.busy}>{state.busy ? "Saving…" : "Save"}</button>
    </form>
  </Modal>;
}

function VpnEditor({ api, type, item, close, saved }) {
  const [name, setName] = useState(item?.name || ""), [values, setValues] = useState(item?.config || {}), [help, setHelp] = useState(""), [cleared, setCleared] = useState([]);
  const [state, save] = useSave(saved);
  const submit = event => {
    event.preventDefault();
    save(() => item ? api(`/api/v1/vpn/profiles/${item.id}`, { method: "PATCH", body: JSON.stringify({ name, config: values, clearSecrets: cleared }) })
      : api("/api/v1/vpn/profiles", { method: "POST", body: JSON.stringify({ name, type: type.id, config: values }) }));
  };
  return <Modal title={item ? `Edit ${item.name}` : `Add ${type.name}`} close={close} className="settings-dialog">
    <form className="settings-form" onSubmit={submit}>
      <p className="muted">{type.description}</p>
      {!type.available && <div className="error-notice">{type.unavailableReason}</div>}
      {!item && type.presets.length > 0 && <div className="preset-row" aria-label="Presets">{type.presets.map(preset => <button type="button" key={preset.id} className="outline-button" onClick={() => {
        setValues(current => ({ ...current, ...preset.values })); setHelp(preset.help); if (!name) setName(preset.label.replace(/ \(.*\)$/, ""));
      }}>{preset.label}</button>)}</div>}
      {help && <div className="notice">{help}</div>}
      <div className="config-field"><label htmlFor="vpn-name">Name</label><input id="vpn-name" value={name} onChange={event => setName(event.target.value)} required maxLength={100} placeholder="PIA Netherlands" /></div>
      <ConfigFields fields={type.fields} values={values} secrets={item?.secrets} onChange={setValues} cleared={cleared} onClear={setCleared} api={api} />
      {state.error && <div className="error-notice" role="alert">{state.error}</div>}
      <button className="primary-button" disabled={state.busy}>{state.busy ? "Saving…" : "Save"}</button>
    </form>
  </Modal>;
}
