"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, FilmStrip, Folder, ListBullets, MagnifyingGlass, MinusCircle, Tag, Trash, X } from "@phosphor-icons/react";
import { Modal } from "./modal.jsx";
import { TopicLabel } from "./topic-label.jsx";
import { useRatings, useSession } from "./profiles.jsx";
import { clock } from "./guide-time.mjs";

const MAX_SOURCES = 50;
const TYPES = [["movies", "Movies"], ["shows", "TV shows"], ["anime", "Anime"], ["home", "Home videos"]];
const ORDERS = [["shuffle", "Shuffle"], ["in_order", "In order, oldest first"], ["newest", "Newest first"]];
const BLOCKS = [[1, "1 episode"], [2, "2 episodes"], [4, "4 episodes"], [0, "A whole season"]];
const TABS = [["topics", "Tags", Tag], ["titles", "Shows & movies", FilmStrip], ["lists", "Lists", ListBullets], ["roots", "Folders", Folder]];
const EMPTY = { topics: [], titles: [], lists: [], roots: [], excludeTopics: [] };

const yearValue = text => /^\d{4}$/.test(text) ? Number(text) : null;
const noun = (count, one, many) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

// Makes or edits a channel: what it airs (tags, shows and movies, lists, folders), filters that narrow that down,
// how it's programmed, and who has it. The server explains each rule in apps/server/src/channel-rules.js.
export function ChannelEditor({ api, channel, close, onSaved, onDeleted }) {
  const { isAdmin } = useSession();
  const ratings = useRatings();
  const [sources, setSources] = useState(() => ({ ...EMPTY, ...channel?.sources }));
  const rules = channel?.rules || {};
  const [match, setMatch] = useState(rules.match || "all");
  const [types, setTypes] = useState(rules.types || []);
  const [maxRating, setMaxRating] = useState(rules.maxRating || "");
  const [allowUnrated, setAllowUnrated] = useState(rules.allowUnrated ?? true);
  const [yearFrom, setYearFrom] = useState(rules.yearFrom ? String(rules.yearFrom) : "");
  const [yearTo, setYearTo] = useState(rules.yearTo ? String(rules.yearTo) : "");
  const [order, setOrder] = useState(channel?.order || "shuffle");
  const [episodeBlock, setEpisodeBlock] = useState(channel?.episodeBlock ?? 2);
  const [scope, setScope] = useState(channel?.scope || (isAdmin ? "household" : "personal"));
  const [name, setName] = useState(channel?.name || "");
  const [tab, setTab] = useState(channel && !channel.sources.topics.length ? TABS.find(([key]) => channel.sources[key]?.length)?.[0] || "topics" : "topics");
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  const body = useMemo(() => ({
    topicIds: sources.topics.map(item => item.id), match, titleIds: sources.titles.map(item => item.id),
    listIds: sources.lists.map(item => item.id), rootIds: sources.roots.map(item => item.id), excludeTopicIds: sources.excludeTopics.map(item => item.id),
    types, maxRating: maxRating || null, allowUnrated, yearFrom: yearValue(yearFrom), yearTo: yearValue(yearTo),
  }), [sources, match, types, maxRating, allowUnrated, yearFrom, yearTo]);
  const sourceCount = sources.topics.length + sources.titles.length + sources.lists.length + sources.roots.length;

  useEffect(() => {
    setPreview(null);
    if (!sourceCount) return;
    let active = true;
    const timer = setTimeout(() => api("/api/v1/guide/preview", { method: "POST", body: JSON.stringify({ rules: body, order, episodeBlock, channelId: channel?.id }) })
      .then(value => { if (active) setPreview(value); }).catch(e => { if (active) setPreview({ error: e.message }); }), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [body, order, episodeBlock, sourceCount, api, channel?.id]);

  const has = (kind, item) => sources[kind].some(entry => entry.id === item.id);
  const toggle = (kind, item) => setSources(current => ({
    ...current,
    [kind]: current[kind].some(entry => entry.id === item.id) ? current[kind].filter(entry => entry.id !== item.id)
      : current[kind].length < MAX_SOURCES ? [...current[kind], item] : current[kind],
  }));
  const suggested = [...sources.topics.map(item => item.name), ...sources.titles.map(item => item.title), ...sources.lists.map(item => item.name), ...sources.roots.map(item => item.name)]
    .join(sources.topics.length > 1 && match === "all" ? " + " : " & ").slice(0, 60);

  const save = async event => {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      const payload = JSON.stringify({ name: name.trim() || suggested, scope, rules: body, order, episodeBlock });
      const saved = await api(channel ? `/api/v1/guide/channels/${channel.id}` : "/api/v1/guide/channels", { method: channel ? "PUT" : "POST", body: payload });
      onSaved(saved);
    } catch (e) { setError(e.message); setSaving(false); }
  };
  const remove = async () => {
    setSaving(true); setError("");
    try {
      await api(`/api/v1/guide/channels/${channel.id}`, { method: "DELETE" });
      onDeleted(channel);
    } catch (e) { setError(e.message); setSaving(false); }
  };

  const yearsInvalid = (yearFrom && !yearValue(yearFrom)) || (yearTo && !yearValue(yearTo)) || (yearValue(yearFrom) && yearValue(yearTo) && yearValue(yearFrom) > yearValue(yearTo));
  const tabs = TABS.filter(([key]) => key !== "roots" || isAdmin || sources.roots.length);

  return <Modal title={channel ? `Edit channel ${channel.number}` : "New channel"} close={close} className="channel-editor">
    <form onSubmit={save}>
      <div className="channel-editor-body">
        <label>Channel name<input value={name} maxLength={60} placeholder={suggested || "Name your channel"} onChange={event => setName(event.target.value)} /></label>

        {isAdmin ? <fieldset className="channel-match">
          <legend>Who has it</legend>
          <Segmented label="Who has it" value={scope} onChange={setScope} options={[["household", "Everyone"], ["personal", "Just me"]]} />
        </fieldset> : <p className="muted channel-scope-note">Channels you make are yours: only your profile has them.</p>}

        <section className="channel-section" aria-labelledby="channel-sources">
          <h3 id="channel-sources">What it airs</h3>
          <PickedSources sources={sources} match={match} onRemove={toggle} />
          {sources.topics.length > 1 && <Segmented label="Match tags" value={match} onChange={setMatch} options={[["all", "Videos with all of these tags"], ["any", "Videos with any of them"]]} />}
          <div className="channel-tabs" role="tablist" aria-label="Add to the channel">
            {tabs.map(([key, label, Icon]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "selected" : ""} onClick={() => setTab(key)}>
              <Icon size={15} /> {label}{sources[key].length > 0 && <span className="channel-tab-count">{sources[key].length}</span>}
            </button>)}
          </div>
          {tab === "topics" && <TopicPicker api={api} picked={item => has("topics", item)} onToggle={item => toggle("topics", item)} />}
          {tab === "titles" && <TitlePicker api={api} picked={item => has("titles", item)} onToggle={item => toggle("titles", item)} />}
          {tab === "lists" && <ListPicker api={api} picked={item => has("lists", item)} onToggle={item => toggle("lists", item)} />}
          {tab === "roots" && <RootPicker api={api} picked={item => has("roots", item)} onToggle={item => toggle("roots", item)} />}
        </section>

        <section className="channel-section" aria-labelledby="channel-filters">
          <h3 id="channel-filters">Only include</h3>
          <div className="chips channel-types" role="group" aria-label="Media types">
            {TYPES.map(([key, label]) => <button key={key} type="button" aria-pressed={types.includes(key)} className={types.includes(key) ? "selected" : ""}
              onClick={() => setTypes(list => list.includes(key) ? list.filter(item => item !== key) : [...list, key])}>{types.includes(key) && <Check size={13} weight="bold" />}{label}</button>)}
          </div>
          <p className="channel-hint">{types.length ? "Only these kinds of videos air." : "Every kind of video airs. Pick some to narrow it down."}</p>
          <div className="channel-row">
            <label>Rated up to
              <select value={maxRating} onChange={event => setMaxRating(event.target.value)}>
                <option value="">Any rating</option>
                {ratings.map(rating => <option key={rating.key} value={rating.key}>{rating.label}{rating.description ? ` — ${rating.description}` : ""}</option>)}
              </select>
            </label>
            <label className="channel-years">Years
              <span><input inputMode="numeric" maxLength={4} placeholder="From" value={yearFrom} aria-label="From year" onChange={event => setYearFrom(event.target.value.replace(/\D/g, ""))} />
                <span aria-hidden="true">–</span>
                <input inputMode="numeric" maxLength={4} placeholder="To" value={yearTo} aria-label="To year" onChange={event => setYearTo(event.target.value.replace(/\D/g, ""))} /></span>
            </label>
          </div>
          <label className="channel-check"><input type="checkbox" checked={allowUnrated} onChange={event => setAllowUnrated(event.target.checked)} /> Include unrated videos</label>
          {yearsInvalid && <p className="tag-error" role="alert">Years are four digits, and the first comes before the second.</p>}
          <ExcludePicker api={api} picked={sources.excludeTopics} onToggle={item => toggle("excludeTopics", item)} />
        </section>

        <section className="channel-section" aria-labelledby="channel-programming">
          <h3 id="channel-programming">Programming</h3>
          <div className="channel-row">
            <label>Order<select value={order} onChange={event => setOrder(event.target.value)}>{ORDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Episodes in a row<select value={episodeBlock} onChange={event => setEpisodeBlock(Number(event.target.value))}>{BLOCKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
        </section>

        <ChannelPreview preview={preview} sourceCount={sourceCount} />
      </div>

      {error && <p className="tag-error" role="alert">{error}</p>}
      <div className="channel-editor-actions">
        {channel && (confirmDelete
          ? <span className="channel-delete-confirm">Delete this channel? <button type="button" className="outline-button danger" disabled={saving} onClick={remove}>Delete</button><button type="button" className="outline-button" onClick={() => setConfirmDelete(false)}>Keep</button></span>
          : <button type="button" className="outline-button" onClick={() => setConfirmDelete(true)}><Trash size={16} /> Delete</button>)}
        <button type="button" className="outline-button" onClick={close}>Cancel</button>
        <button className="primary-button" disabled={saving || !sourceCount || yearsInvalid}>{saving ? "Saving…" : channel ? "Save channel" : "Create channel"}</button>
      </div>
    </form>
  </Modal>;
}

function Segmented({ label, value, onChange, options }) {
  return <div className="channel-segmented" role="radiogroup" aria-label={label}>
    {options.map(([key, text]) => <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? "selected" : ""} onClick={() => onChange(key)}>{text}</button>)}
  </div>;
}

// Everything picked, in one row of chips; clicking one takes it off.
function PickedSources({ sources, match, onRemove }) {
  const chips = [
    ...sources.topics.map(item => ["topics", item, <TopicLabel topic={item} />]),
    ...sources.titles.map(item => ["titles", item, <><FilmStrip size={14} />{item.title}{item.year ? ` (${item.year})` : ""}</>]),
    ...sources.lists.map(item => ["lists", item, <><ListBullets size={14} />{item.name}{item.owner ? ` · ${item.owner}` : ""}</>]),
    ...sources.roots.map(item => ["roots", item, <><Folder size={14} />{item.name}</>]),
  ];
  if (!chips.length) return <p className="muted channel-empty-sources">Add tags, shows and movies, lists, or folders below. The channel airs everything they add up to.</p>;
  return <div className="channel-picked">
    <div className="chips folder-tags">{chips.map(([kind, item, label]) => <button key={`${kind}:${item.id}`} type="button" className="selected" onClick={() => onRemove(kind, item)} aria-label={`Remove ${item.name || item.title}`}>{label}<X size={14} /></button>)}</div>
    {sources.topics.length > 1 && (sources.titles.length + sources.lists.length + sources.roots.length) > 0 && <p className="channel-hint">Videos with {match === "all" ? "all of the tags" : "any of the tags"}, plus everything else picked.</p>}
  </div>;
}

function SearchField({ value, onChange, placeholder }) {
  return <div className="tag-search-field"><MagnifyingGlass size={18} aria-hidden="true" />
    <input className="tag-search" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} autoComplete="off" />
  </div>;
}

function OptionList({ label, items, loading, empty, picked, onToggle, render, busy }) {
  return <div className="channel-tag-list" role="listbox" aria-multiselectable="true" aria-label={label} aria-busy={loading}>
    {loading ? <p className="tag-empty">Loading…</p> : !items.length ? <p className="tag-empty">{empty}</p>
      : items.map(item => <div key={item.key || item.id} role="option" aria-selected={picked(item)} tabIndex={0} className={`tag-option ${picked(item) ? "is-picked" : ""}`}
        onClick={() => onToggle(item)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(item); } }}>
        {render(item)}
        <span className="channel-tag-check" aria-hidden="true">{busy === (item.key || item.id) ? "…" : picked(item) && <Check size={14} weight="bold" />}</span>
      </div>)}
  </div>;
}

const useTopics = api => {
  const [topics, setTopics] = useState(null);
  useEffect(() => { if (api) api("/api/v1/topics").then(setTopics).catch(() => setTopics([])); }, [api]);
  return topics;
};
const tagRow = topic => <>
  <span className="tag-avatar">{topic.avatar_url ? <img src={topic.avatar_url} alt="" onError={event => { event.currentTarget.hidden = true; }} /> : <Tag size={18} />}</span>
  <span className="tag-option-name">{topic.name}</span>
  <span className="channel-tag-count">{topic.item_count?.toLocaleString()}</span>
</>;
const slimTopic = topic => ({ id: topic.id, slug: topic.slug, name: topic.name, avatar_url: topic.avatar_url });

function TopicPicker({ api, picked, onToggle }) {
  const topics = useTopics(api);
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const options = (topics || []).filter(topic => !term || topic.name.toLowerCase().includes(term)).slice(0, 150);
  return <>
    <SearchField value={search} onChange={setSearch} placeholder="Find tags…" />
    <OptionList label="Tags" items={options} loading={!topics} empty={term ? `No tags match “${search}”.` : "No tags yet."} picked={picked} onToggle={topic => onToggle(slimTopic(topic))} render={tagRow} />
  </>;
}

// Shows and movies: those on your lists, or any from the catalog by search. A catalog result is opened first so the
// channel can hold it.
function TitlePicker({ api, picked, onToggle }) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(null);
  const term = search.trim();
  useEffect(() => {
    let active = true;
    setItems(null); setMessage("");
    const load = term ? api(`/api/v1/catalog/search?q=${encodeURIComponent(term)}`).then(value => value.items)
      : api("/api/v1/titles?limit=60").then(rows => rows.map(row => ({ ...row, titleId: row.id })));
    const timer = setTimeout(() => load.then(value => { if (active) setItems(value.map(item => ({ ...item, key: item.ref || item.id }))); })
      .catch(e => { if (active) { setItems([]); setMessage(e.message); } }), term ? 300 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [api, term]);
  const asSource = item => ({ id: item.titleId || item.id, type: item.type, title: item.title, year: item.year, poster: item.poster, isAnime: item.isAnime });
  const choose = async item => {
    if (item.titleId) return onToggle(asSource(item));
    setBusy(item.key); setMessage("");
    try {
      const title = await api(`/api/v1/titles/${encodeURIComponent(item.ref)}`);
      setItems(list => list.map(entry => entry.key === item.key ? { ...entry, titleId: title.id } : entry));
      onToggle(asSource({ ...item, titleId: title.id }));
    } catch (e) { setMessage(e.message); } finally { setBusy(null); }
  };
  return <>
    <SearchField value={search} onChange={setSearch} placeholder="Search movies and shows…" />
    <OptionList label="Shows and movies" items={items || []} loading={!items} busy={busy}
      empty={message || (term ? `Nothing matches “${search}”.` : "Nothing on your Watch List yet. Search to find a show or movie.")}
      picked={item => Boolean(item.titleId) && picked({ id: item.titleId })} onToggle={choose}
      render={item => <>
        <span className="channel-poster">{item.poster ? <img src={item.poster} alt="" /> : <FilmStrip size={18} />}</span>
        <span className="tag-option-name">{item.title}{item.year ? <small> {item.year}</small> : null}</span>
        <span className="channel-tag-count">{item.isAnime ? "Anime" : item.type === "movie" ? "Movie" : "Show"}</span>
      </>} />
    {message && items?.length > 0 && <p className="tag-error" role="alert">{message}</p>}
  </>;
}

function ListPicker({ api, picked, onToggle }) {
  const [lists, setLists] = useState(null);
  useEffect(() => { api("/api/v1/lists").then(value => setLists(value.lists)).catch(() => setLists([])); }, [api]);
  return <OptionList label="Lists" items={lists || []} loading={!lists} empty="You don't have any lists yet." picked={picked} onToggle={list => onToggle({ id: list.id, name: list.name, owner: null })}
    render={list => <><span className="tag-avatar"><ListBullets size={18} /></span><span className="tag-option-name">{list.name}</span><span className="channel-tag-count">{noun(list.itemCount, "item", "items")}</span></>} />;
}

function RootPicker({ api, picked, onToggle }) {
  const [roots, setRoots] = useState(null);
  useEffect(() => { api("/api/v1/library/roots").then(setRoots).catch(() => setRoots([])); }, [api]);
  return <OptionList label="Source folders" items={roots || []} loading={!roots} empty="No source folders yet. Add them in Settings → Library." picked={picked} onToggle={root => onToggle({ id: root.id, name: root.name })}
    render={root => <><span className="tag-avatar"><Folder size={18} /></span><span className="tag-option-name">{root.name}<small> {root.absolute_path}</small></span></>} />;
}

// Tags whose videos never air on this channel.
function ExcludePicker({ api, picked, onToggle }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const topics = useTopics(open ? api : null);
  const term = search.trim().toLowerCase();
  const options = term ? (topics || []).filter(topic => topic.name.toLowerCase().includes(term)).slice(0, 8) : [];
  return <div className="channel-exclude">
    <div className="channel-exclude-head">
      <span>Leave out videos tagged</span>
      {!open && <button type="button" className="text-button" onClick={() => setOpen(true)}><MinusCircle size={15} /> Add a tag</button>}
    </div>
    {picked.length > 0 && <div className="chips folder-tags">{picked.map(topic => <button key={topic.id} type="button" className="selected is-excluded" onClick={() => onToggle(topic)} aria-label={`Stop leaving out ${topic.name}`}><TopicLabel topic={topic} /><X size={14} /></button>)}</div>}
    {open && <>
      <SearchField value={search} onChange={setSearch} placeholder="Find a tag to leave out…" />
      {term && <OptionList label="Tags to leave out" items={options} loading={!topics} empty={`No tags match “${search}”.`} picked={topic => picked.some(item => item.id === topic.id)} onToggle={topic => onToggle(slimTopic(topic))} render={tagRow} />}
    </>}
  </div>;
}

function ChannelPreview({ preview, sourceCount }) {
  if (!sourceCount) return null;
  return <section className="channel-preview" aria-live="polite" aria-labelledby="channel-preview">
    <h3 id="channel-preview">{!preview ? "Counting videos…" : preview.error ? "Couldn't preview this channel" : preview.item_count ? `${noun(preview.item_count, "video", "videos")} will air` : "Nothing matches these rules yet"}</h3>
    {preview?.error && <p className="tag-error">{preview.error}</p>}
    {preview?.upcoming?.length > 0 && <ol>{preview.upcoming.map(program => <li key={`${program.id}:${program.start}`}>
      <time>{program.start <= Date.now() ? "Now" : clock(program.start)}</time>
      <span><strong>{program.title}</strong>{program.subtitle && <small>{program.subtitle}</small>}</span>
    </li>)}</ol>}
  </section>;
}
