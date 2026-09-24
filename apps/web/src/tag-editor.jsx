"use client";

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowClockwise, LinkSimple, PencilSimple, X } from '@phosphor-icons/react';

const labels = { name: 'Name', summary: 'Description', avatar_url: 'Picture', topic_type: 'Type', aliases: 'Aliases' };
const names = { wikidata: 'Wikidata', stashdb: 'StashDB', tpdb: 'ThePornDB' };
const imageFallback = '/assets/profile-placeholder.svg';
const nonempty = value => Array.isArray(value) ? value.length > 0 : Boolean(value);
const show = value => Array.isArray(value) ? value.join(', ') : value || '—';
const safeLink = url => /^https?:\/\//i.test(url || '');

export function TagSources({ topic }) {
  let metadata; try { metadata = JSON.parse(topic.metadata_json || '{}'); } catch { metadata = {}; }
  const sources = [...(topic.providerLinks || []).map(link => ({ label: names[link.provider] || link.provider, url: link.url })), ...(topic.providerLinks || []).flatMap(link => link.entity.links || []), ...Object.values(metadata.tagEnrichment?.attribution || {}).flat()];
  const unique = [...new Map(sources.filter(source => safeLink(source.url)).map(source => [source.url, source])).values()];
  if (!unique.length) return null;
  return <div className="profile-links tag-source-links" aria-label="Metadata sources">{unique.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a>)}</div>;
}

export function TagEditor({ topic, api, onChange }) {
  const [open, setOpen] = useState(false);
  return <><button className="outline-button" onClick={() => setOpen(true)}><PencilSimple size={17}/>Edit tag</button>{open && createPortal(<Editor key={topic.id} topic={topic} api={api} onChange={onChange} close={() => setOpen(false)}/>, document.body)}</>;
}

function Editor({ topic, api, onChange, close }) {
  const dialog = useRef(null), lock = useRef(false), searchInput = useRef(null), previewPanel = useRef(null);
  const [data, setData] = useState(null), [providers, setProviders] = useState([]), [draft, setDraft] = useState({});
  const [provider, setProvider] = useState('wikidata'), [query, setQuery] = useState(topic.name);
  const [results, setResults] = useState(null), [hasMore, setHasMore] = useState(false), [preview, setPreview] = useState(null), [selected, setSelected] = useState([]), [preferred, setPreferred] = useState(true);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const base = `/api/v1/topics/${encodeURIComponent(topic.id)}`;
  const draftFor = value => ({ name: value.name || '', summary: value.summary || '', avatar_url: value.avatar_url || '', topic_type: value.topic_type || 'topic', aliases: (value.aliases || []).join('\n') });
  const changedFields = data ? Object.keys(draft).filter(key => draft[key] !== draftFor(data.topic)[key]) : [];
  const dirty = changedFields.length > 0;
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([api(`${base}/metadata`), api('/api/v1/metadata/providers')]).then(([value, list]) => {
      if (!active) return;
      setData(value); setDraft(draftFor(value.topic)); setProviders(list);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [base, api]);
  useEffect(() => { if (preview) previewPanel.current?.focus(); }, [preview]);
  const run = async (label, work) => {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(''); setNotice('');
    try { await work(); } catch (err) { setError(err.message); }
    finally { lock.current = false; setBusy(''); }
  };
  const update = value => {
    setData(value); setDraft(draftFor(value.topic));
    onChange({ ...value.topic, providerLinks: value.links });
  };
  const save = event => {
    event.preventDefault();
    run('Saving tag…', async () => {
      const payload = Object.fromEntries(changedFields.map(key => [key, key === 'aliases' ? draft.aliases.split('\n').map(x => x.trim()).filter(Boolean) : draft[key]]));
      update(await api(base, { method: 'PATCH', body: JSON.stringify(payload) }));
      setNotice('Tag saved. Your edits are protected from provider refreshes.');
    });
  };
  const search = event => {
    event?.preventDefault();
    run('Searching…', async () => {
      setPreview(null); setResults(null);
      const result = await api(`/api/v1/metadata/providers/${provider}/search?q=${encodeURIComponent(query.trim())}`);
      setResults(result.results); setHasMore(result.hasMore);
    });
  };
  const choose = candidate => run('Loading preview…', async () => {
    const value = await api(`${base}/metadata/preview?provider=${provider}&entityId=${encodeURIComponent(candidate.id)}`);
    setPreview(value);
    setSelected(Object.keys(labels).filter(field => nonempty(value.entity[field]) && field !== 'name' && !data.overrides.includes(field) && (!nonempty(data.topic[field]) || data.managed[field] || (field === 'topic_type' && data.topic[field] === 'topic'))));
    setPreferred(!data.preferred || data.preferred === provider);
  });
  const link = () => run('Linking provider…', async () => {
    update(await api(`${base}/metadata/links/${provider}`, { method: 'PUT', body: JSON.stringify({ token: preview.token, fields: selected, preferred }) }));
    setPreview(null); setResults(null); setNotice('Provider linked. Selected fields imported.');
  });
  const action = (item, operation) => run(operation === 'refresh' ? 'Refreshing metadata…' : 'Updating provider link…', async () => {
    const value = await api(`${base}/metadata/links/${item.provider}${operation === 'unlink' ? '' : `/${operation}`}`, { method: operation === 'unlink' ? 'DELETE' : 'POST', body: '{}' });
    update(value);
    const warnings = value.links.find(link => link.provider === item.provider)?.entity.warnings || [];
    setNotice(operation === 'unlink' ? 'Provider unlinked. Saved tag details were kept.' : warnings.length ? warnings.join(' ') : operation === 'prefer' ? 'Preferred source updated. Manual edits were kept.' : 'Metadata refreshed. Manual edits were kept.');
  });
  const disabled = Boolean(busy);
  return <dialog ref={dialog} className="tag-editor" aria-labelledby="tag-editor-title" onCancel={event => { if (lock.current) event.preventDefault(); else close(); }} onClose={close}>
    <header className="tag-editor-heading"><div><h2 id="tag-editor-title">Edit tag</h2><p>{topic.name}</p></div><button type="button" className="icon-button" aria-label="Close tag editor" disabled={disabled} onClick={close}><X size={22}/></button></header>
    <div className="tag-editor-body">
      {error && <p className="tag-editor-error" role="alert">{error}</p>}
      <div role="status" aria-live="polite">{(busy || notice) && <p className="tag-editor-status">{busy || notice}</p>}</div>
      {!data && !error && <p>Loading tag…</p>}
      {data && <>
        <form onSubmit={save} className="tag-details-form"><fieldset disabled={disabled}>
          <label>Name<input value={draft.name} maxLength={100} required onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
          <label>Description<textarea aria-label="Description" value={draft.summary} maxLength={5000} rows={3} onChange={e => setDraft({ ...draft, summary: e.target.value })}/></label>
          <div className="tag-editor-columns"><label>Type<input aria-label="Type" value={draft.topic_type} maxLength={50} list="tag-types" onChange={e => setDraft({ ...draft, topic_type: e.target.value })}/><datalist id="tag-types"><option value="person"/><option value="topic"/><option value="organization"/><option value="place"/></datalist></label><label>Picture URL<input value={draft.avatar_url} maxLength={2000} placeholder="https://…" onChange={e => setDraft({ ...draft, avatar_url: e.target.value })}/></label></div>
          <label>Aliases <span className="tag-editor-muted">(one per line)</span><textarea aria-label="Aliases" value={draft.aliases} rows={2} onChange={e => setDraft({ ...draft, aliases: e.target.value })}/></label>
          <div className="tag-editor-actions"><button className="primary-button" disabled={!dirty || !draft.name.trim()}>Save tag details</button>{dirty && <button type="button" className="outline-button" onClick={() => setDraft(draftFor(data.topic))}>Discard edits</button>}</div>
        </fieldset></form>
        <section className="tag-provider-section" aria-labelledby="tag-provider-heading"><h3 id="tag-provider-heading">Metadata providers</h3><p className="tag-editor-muted">Link this tag to a person, place, or topic. Choose which details to import. Refreshes keep your manual edits.</p>
          {dirty && <p className="tag-editor-status">Save or discard your edits before changing provider links.</p>}
          <fieldset disabled={disabled || dirty}>
            {data.links.length > 0 && <ul className="tag-linked-list">{data.links.map(item => <li key={item.provider}>
              <div className="tag-linked-title"><strong>{names[item.provider]}</strong>{data.preferred === item.provider && <span className="tag-preferred">Preferred</span>}</div>
              <a href={item.url} target="_blank" rel="noopener noreferrer">{item.entity.name || item.externalId}</a><small>{item.fetchedAt ? `Updated ${new Date(item.fetchedAt).toLocaleString()}` : 'Imported from an existing profile'}</small>
              <div className="tag-editor-actions"><button type="button" className="outline-button" disabled={!providers.find(p => p.id === item.provider)?.enabled} onClick={() => action(item, 'refresh')}><ArrowClockwise size={15}/>Refresh</button><button type="button" className="outline-button" disabled={!providers.find(p => p.id === item.provider)?.enabled} onClick={() => { setProvider(item.provider); setQuery(data.topic.name); setResults(null); setPreview(null); requestAnimationFrame(() => searchInput.current?.focus()); }}>Change match</button>{data.preferred !== item.provider && <button type="button" className="outline-button" onClick={() => action(item, 'prefer')}>Make preferred</button>}<button type="button" className="outline-button" onClick={() => action(item, 'unlink')}>Unlink</button></div>
            </li>)}</ul>}
            <form onSubmit={search} className="tag-provider-search"><label>Provider<select aria-label="Provider" value={provider} onChange={e => { setProvider(e.target.value); setResults(null); setPreview(null); }}>{providers.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{!item.enabled ? ' — not configured' : ''}</option>)}</select></label><p className="tag-editor-muted">{providers.find(item => item.id === provider)?.description}</p>
              <label>Find a match<input ref={searchInput} value={query} maxLength={300} placeholder="Name, provider ID, or profile URL" onChange={e => { setQuery(e.target.value); setPreview(null); setResults(null); }}/></label><button className="outline-button" disabled={!query.trim()}>Search provider</button>
            </form>
            {results && !preview && <div className="tag-match-results" aria-label="Provider matches">{!results.length && <p>No matches found. Try an alias or paste a provider profile URL.</p>}{results.map(item => <button type="button" className="tag-match" key={item.id} onClick={() => choose(item)}><img src={item.avatar_url || imageFallback} alt="" onError={e => { e.currentTarget.src = imageFallback; }}/><span><strong>{item.name}</strong><span>{item.description || 'No description available'}</span><small>{item.id}</small></span><span className="tag-match-select">Preview</span></button>)}{hasMore && <p className="tag-editor-muted">Showing the first 20 matches. Refine your search to find more.</p>}</div>}
            {preview && <div ref={previewPanel} tabIndex={-1} className="tag-import-preview" aria-label="Match preview"><div className="tag-preview-heading"><img src={preview.entity.avatar_url || imageFallback} alt="" onError={e => { e.currentTarget.src = imageFallback; }}/><div><h4>{preview.entity.name}</h4><p>{preview.entity.description}</p><a href={preview.entity.url} target="_blank" rel="noopener noreferrer">View on {names[provider]}</a></div></div>
              <p>Select the fields to import. Checked fields replace the current values.</p>
              <div className="tag-import-fields">{Object.entries(labels).filter(([field]) => nonempty(preview.entity[field])).map(([field, label]) => <label className="tag-import-field" key={field}><input type="checkbox" aria-label={`Import ${label.toLowerCase()}`} checked={selected.includes(field)} onChange={e => setSelected(e.target.checked ? [...selected, field] : selected.filter(x => x !== field))}/><span><strong>{label}</strong><span className="tag-current-value">Current: {show(data.topic[field])}</span><span>{show(preview.entity[field])}</span></span></label>)}</div>
              <label className="tag-prefer-checkbox"><input type="checkbox" checked={preferred} onChange={e => setPreferred(e.target.checked)}/>Use as preferred metadata source</label>
              <div className="tag-attribution">{preview.entity.attribution?.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a>)}</div>
              {preview.entity.warnings?.map(warning => <p key={warning} className="tag-editor-status">{warning}</p>)}
              <div className="tag-editor-actions"><button type="button" className="primary-button" onClick={link}><LinkSimple size={17}/>{data.links.some(item => item.provider === provider) ? 'Update link' : 'Link provider'}{selected.length ? ' and import' : ''}</button><button type="button" className="outline-button" onClick={() => setPreview(null)}>Back to matches</button></div>
            </div>}
          </fieldset>
        </section>
      </>}
    </div>
  </dialog>;
}
