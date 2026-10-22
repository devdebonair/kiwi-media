"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { InfiniteScroll } from "./infinite-scroll.jsx";
import { ContinueCard, PosterCard, Rail } from "./poster-card.jsx";

export const KINDS = {
  movies: { title: "Movies", blurb: "Films from your list and the catalog. Press play and it starts.", search: "Search movies", libraryQuery: "type=movie&anime=0" },
  shows: { title: "TV Shows", blurb: "Series, season by season, picking up where you left off.", search: "Search TV shows", libraryQuery: "type=show&anime=0" },
  anime: { title: "Anime", blurb: "Series and films, kept together as one series even when seasons are split elsewhere.", search: "Search anime", libraryQuery: "anime=1" },
};
const SORTS = [["popular", "Popular"], ["rated", "Top rated"], ["new", "Newest"]];

export function SetupNotice({ message, AppLink, navigate }) {
  return <div className="setup-notice" role="status">
    <h2>Set up streaming</h2>
    <p>{message}</p>
    <AppLink href="/settings#streaming" navigate={navigate} className="primary-button">Open streaming settings</AppLink>
  </div>;
}

// Movies, TV Shows, and Anime share one page: your list and what you're watching first, then the catalog.
export function CatalogPage({ kind, api, navigate, AppLink, Loading, Empty, formatDuration }) {
  const config = KINDS[kind];
  const [type, setType] = useState("show");
  const [genres, setGenres] = useState([]);
  const [genre, setGenre] = useState(null);
  const [sort, setSort] = useState("popular");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [home, setHome] = useState(null);
  const [mine, setMine] = useState([]);
  const [continuing, setContinuing] = useState([]);
  const [browse, setBrowse] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const generation = useRef(0), pending = useRef(false);
  const animeType = kind === "anime" ? type : null;
  const browsing = Boolean(genre || sort !== "popular" || search);

  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setGenre(null); setSort("popular"); setQuery(""); setSearch(""); setType("show"); }, [kind]);

  const loadMine = useCallback(() => {
    api(`/api/v1/titles?${config.libraryQuery}${animeType ? `&type=${animeType}` : ""}&limit=60&sort=added`).then(setMine).catch(() => setMine([]));
    api(`/api/v1/continue?kind=${kind}`).then(rows => setContinuing(animeType ? rows.filter(row => row.title.type === animeType) : rows)).catch(() => setContinuing([]));
  }, [api, kind, animeType, config.libraryQuery]);
  useEffect(() => { loadMine(); }, [loadMine]);

  useEffect(() => {
    let active = true;
    setHome(null); setError(null);
    // The anime page splits its rails by tab: the films rail on one side, series rails on the other.
    const visible = rail => kind !== "anime" || (animeType === "movie") === (rail.id === "movies");
    api(`/api/v1/catalog/home?kind=${kind}`).then(value => { if (active) setHome(value.rails.filter(visible)); })
      .catch(e => { if (active) setError(e.message); });
    api(`/api/v1/catalog/genres?kind=${kind}${animeType ? `&type=${animeType}` : ""}`).then(value => { if (active) setGenres(value); }).catch(() => {});
    return () => { active = false; };
  }, [api, kind, animeType]);

  const url = page => search
    ? `/api/v1/catalog/search?q=${encodeURIComponent(search)}&kind=${kind}&page=${page}${animeType ? `&type=${animeType}` : ""}`
    : `/api/v1/catalog/browse?kind=${kind}&sort=${sort}&page=${page}${genre ? `&genre=${genre}` : ""}${animeType ? `&type=${animeType}` : ""}`;

  useEffect(() => {
    if (!browsing) { setBrowse(null); return; }
    const current = ++generation.current;
    setBrowse(null);
    api(url(1)).then(value => { if (generation.current === current) setBrowse({ items: value.items, page: value.page, totalPages: value.totalPages, loading: false }); })
      .catch(e => { if (generation.current === current) setBrowse({ items: [], page: 1, totalPages: 1, error: e.message }); });
  }, [browsing, kind, genre, sort, search, animeType]);

  const loadMore = useCallback(async () => {
    if (pending.current || !browse || browse.page >= browse.totalPages) return;
    pending.current = true;
    const current = generation.current;
    setBrowse(value => ({ ...value, loading: true }));
    try {
      const value = await api(url(browse.page + 1));
      if (generation.current === current) setBrowse(previous => ({ ...previous, items: [...previous.items, ...value.items.filter(item => !previous.items.some(old => old.ref === item.ref))], page: value.page, loading: false }));
    } catch { if (generation.current === current) setBrowse(previous => ({ ...previous, loading: false, page: previous.totalPages })); }
    finally { pending.current = false; }
  }, [browse, kind, genre, sort, search, animeType]);

  const toggle = async item => {
    setBusy(item.ref);
    try {
      // Opening the title makes it exist locally; the list toggle then applies to that entry.
      const title = item.titleId ? { id: item.titleId } : await api(`/api/v1/titles/${item.ref}`);
      const updated = await api(`/api/v1/titles/${title.id}/library`, { method: "PUT", body: JSON.stringify({ inLibrary: !item.inLibrary }) });
      const patch = row => row.ref === item.ref || row.titleId === title.id ? { ...row, titleId: title.id, ref: row.ref, inLibrary: updated.inLibrary } : row;
      setHome(rails => rails && rails.map(rail => ({ ...rail, items: rail.items.map(patch) })));
      setBrowse(value => value && { ...value, items: value.items.map(patch) });
      loadMine();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const setup = error && /key|Settings/.test(error) && !home;
  const card = item => <PosterCard key={item.ref} item={item} AppLink={AppLink} navigate={navigate} onToggle={toggle} busy={busy === item.ref} />;

  return <div className="content catalog-page">
    <div className="section-heading">
      <div><h1>{config.title}</h1><p>{config.blurb}</p></div>
      <label className="catalog-search"><MagnifyingGlass size={18} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={config.search} aria-label={config.search} />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={16} /></button>}</label>
    </div>
    {kind === "anime" && <div className="tabs" role="tablist">
      {[["show", "Series"], ["movie", "Films"]].map(([value, label]) => <button key={value} role="tab" aria-selected={type === value} className={type === value ? "active" : ""} onClick={() => { setType(value); setGenre(null); }}>{label}</button>)}
    </div>}
    {!setup && <div className="catalog-filters">
      <div className="chips" role="group" aria-label="Genres">
        <button className={!genre ? "selected" : ""} aria-pressed={!genre} onClick={() => { setGenre(null); setQuery(""); }}>All</button>
        {genres.map(item => <button key={item.id} className={String(genre) === String(item.id) ? "selected" : ""} aria-pressed={String(genre) === String(item.id)} onClick={() => { setGenre(item.id); setQuery(""); }}>{item.name}</button>)}
      </div>
      <select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort" disabled={Boolean(search)}>{SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    </div>}
    {setup ? <SetupNotice message={error} AppLink={AppLink} navigate={navigate} />
      : browsing ? (!browse ? <Loading /> : browse.error ? <div className="error-notice" role="alert"><span>{browse.error}</span></div> : browse.items.length ? <>
        <div className="poster-grid">{browse.items.map(card)}</div>
        <InfiniteScroll enabled={browse.page < browse.totalPages} loading={browse.loading} onLoadMore={loadMore} />
      </> : <Empty title="No matches" message="Try another genre or a different search." />)
      : <>
        {continuing.length > 0 && <Rail title="Continue watching"><>{continuing.map(entry => <ContinueCard key={entry.title.id} entry={entry} AppLink={AppLink} navigate={navigate} formatDuration={formatDuration} />)}</></Rail>}
        {mine.length > 0 && <Rail title="My list" subtitle={`${mine.length} ${mine.length === 1 ? "title" : "titles"}`}><>{mine.map(item => <PosterCard key={item.id} item={{ ...item, ref: item.id, titleId: item.id }} AppLink={AppLink} navigate={navigate} onToggle={toggle} busy={busy === item.id} />)}</></Rail>}
        {home === null && !error ? <Loading /> : error ? <div className="error-notice" role="alert"><span>{error}</span></div> : home.map(rail => <Rail key={rail.id} title={rail.title}><>{rail.items.map(card)}</></Rail>)}
        {home && !home.length && !mine.length && <Empty title="Nothing to show yet" message="The catalog returned no titles. Try again in a moment." />}
      </>}
  </div>;
}
