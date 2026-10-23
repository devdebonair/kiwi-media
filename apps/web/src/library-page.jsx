"use client";

import { TopicLabel } from "./topic-label.jsx";
import { InfiniteScroll } from "./infinite-scroll.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { ContinueCard, PosterCard, Rail, Segmented } from "./poster-card.jsx";
import { Hero } from "./hero.jsx";
import { OnNow, TopicsPanel } from "./side-list.jsx";

const LIST_FILTERS = [["all", "All"], ["movie", "Movies"], ["show", "Series"], ["anime", "Anime"]];
const listMatches = (item, filter) => filter === "all" || (filter === "anime" ? item.isAnime : !item.isAnime && item.type === filter);

// Home: a featured banner, then what you're watching and your list, the catalog's trending rows, and your own
// videos (shuffled, loading more as you scroll). The side column shows what's on the TV Guide and your topics.
export function Home({ navigate, api, AppLink, MediaCard, Loading, Empty, formatDuration }) {
  const [assets, setAssets] = useState(null);
  const [topics, setTopics] = useState([]);
  const [selected, setSelected] = useState("all");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [seed] = useState(() => Math.floor(Math.random() * 10000) + 1);
  const generation = useRef(0);
  const pending = useRef(false);
  const pageUrl = (offset = 0) => `/api/v1/assets?kind=video&sort=shuffle&seed=${seed}&limit=60&offset=${offset}${selected !== "all" ? `&topic=${encodeURIComponent(selected)}` : ""}`;

  const [continuing, setContinuing] = useState([]);
  const [mine, setMine] = useState([]);
  const [listFilter, setListFilter] = useState("all");
  const [trending, setTrending] = useState([]);
  const [busy, setBusy] = useState(null);
  // Movies, shows, and anime stay in their own rows; they are never mixed into the home-video grid.
  const loadMine = useCallback(() => {
    api("/api/v1/continue?limit=20").then(setContinuing).catch(() => {});
    api("/api/v1/titles?limit=60&sort=added").then(setMine).catch(() => {});
  }, [api]);
  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => {
    let active = true;
    Promise.allSettled(["movies", "shows", "anime"].map(kind => api(`/api/v1/catalog/home?kind=${kind}`))).then(results => {
      if (!active) return;
      const names = { movies: "Trending movies", shows: "Trending series", anime: "Popular anime" };
      setTrending(results.map((result, index) => {
        const kind = ["movies", "shows", "anime"][index];
        const rail = result.status === "fulfilled" ? result.value.rails[0] : null;
        return rail ? { id: kind, title: names[kind], href: `/${kind}`, items: rail.items } : null;
      }).filter(Boolean));
    });
    return () => { active = false; };
  }, [api]);
  useEffect(() => { api("/api/v1/topics").then(rows => setTopics(rows.filter(topic => topic.item_count > 0))).catch(() => {}); }, [api]);
  useEffect(() => {
    const current = ++generation.current;
    setAssets(null); setError(""); setLoadingMore(false); setHasMore(false);
    api(pageUrl()).then(rows => {
      if (generation.current === current) { setAssets(rows); setHasMore(rows.length === 60); }
    }).catch(e => {
      if (generation.current === current) { setError(e.message); setAssets([]); }
    });
    return () => { generation.current++; };
  }, [selected, retry]);

  const loadMore = useCallback(async () => {
    if (pending.current || !assets || !hasMore) return;
    pending.current = true;
    const current = generation.current;
    setLoadingMore(true); setError("");
    try {
      const rows = await api(pageUrl(assets.length));
      if (generation.current === current) {
        setAssets(previous => [...previous, ...rows]); setHasMore(rows.length === 60);
      }
    } catch (e) { if (generation.current === current) setError(e.message); }
    finally { pending.current = false; if (generation.current === current) setLoadingMore(false); }
  }, [assets, hasMore, selected, seed]);

  // Adding from a trending row makes the title local first, then puts it in My list.
  const toggle = async item => {
    setBusy(item.ref);
    try {
      const title = item.titleId ? { id: item.titleId } : await api(`/api/v1/titles/${item.ref}`);
      const updated = await api(`/api/v1/titles/${title.id}/library`, { method: "PUT", body: JSON.stringify({ inLibrary: !item.inLibrary }) });
      const patch = row => row.ref === item.ref || row.titleId === title.id ? { ...row, titleId: title.id, inLibrary: updated.inLibrary } : row;
      setTrending(rails => rails.map(rail => ({ ...rail, items: rail.items.map(patch) })));
      loadMine();
    } catch { /* The button stays as it was. */ }
    finally { setBusy(null); }
  };

  const shownMine = mine.filter(item => listMatches(item, listFilter));
  const card = item => <PosterCard key={item.ref} item={item} AppLink={AppLink} navigate={navigate} onToggle={toggle} busy={busy === item.ref} />;

  return <>
    <Hero kind="home" api={api} navigate={navigate} AppLink={AppLink} />
    <div className="content home-page">
      <div className="home-main">
        {continuing.length > 0 && <Rail title="Continue watching"><>{continuing.map(entry => <ContinueCard key={entry.title.id} entry={entry} AppLink={AppLink} navigate={navigate} />)}</></Rail>}
        {mine.length > 0 && <Rail title="My list" action={<Segmented label="Filter My list" options={LIST_FILTERS.filter(([key]) => key === "all" || mine.some(item => listMatches(item, key)))} value={listFilter} onChange={setListFilter} />}>
          <>{shownMine.map(item => <PosterCard key={item.id} item={{ ...item, ref: item.id, titleId: item.id }} AppLink={AppLink} navigate={navigate} />)}</>
        </Rail>}
        {trending.map(rail => <Rail key={rail.id} title={rail.title} action={<AppLink href={rail.href} navigate={navigate} className="shelf-link">View all</AppLink>}><>{rail.items.map(card)}</></Rail>)}

        <section className="home-videos" aria-labelledby="home-videos-heading">
          <div className="shelf-head"><h2 id="home-videos-heading">{selected === "all" ? "Home videos" : topics.find(topic => topic.slug === selected)?.name || "Your media"}</h2>
            {assets && <span className="shelf-sub">{assets.length.toLocaleString()}{hasMore ? "+" : ""} videos</span>}
            <div className="shelf-tools"><AppLink href="/library" navigate={navigate} className="shelf-link">Open library</AppLink></div></div>
          <div className="chips" role="group" aria-label="Filter home videos by topic">
            <button aria-pressed={selected === "all"} className={selected === "all" ? "selected" : ""} onClick={() => setSelected("all")}>All</button>
            {topics.slice(0, 8).map(topic => <button key={topic.id} aria-pressed={selected === topic.slug} className={selected === topic.slug ? "selected" : ""} onClick={() => setSelected(topic.slug)}><TopicLabel topic={topic} /></button>)}
            <AppLink className="chip-browse" href="/topics" navigate={navigate} aria-label="Browse all topics"><ArrowRight size={18} /></AppLink>
          </div>
          {error && <div className="error-notice" role="alert"><span>{error}</span><button className="outline-button" onClick={() => assets?.length ? loadMore() : setRetry(value => value + 1)}>Try again</button></div>}
          {!assets ? <Loading /> : assets.length ? <div className="media-grid">{assets.map(asset => <MediaCard key={asset.id} asset={asset} navigate={navigate} />)}</div> : !error && <Empty />}
          <InfiniteScroll enabled={Boolean(assets) && hasMore && !error} loading={loadingMore} onLoadMore={loadMore} />
        </section>
      </div>
      <aside className="home-side" aria-label="On the guide and your topics">
        <OnNow api={api} AppLink={AppLink} navigate={navigate} />
        <TopicsPanel topics={topics} AppLink={AppLink} navigate={navigate} />
      </aside>
    </div>
  </>;
}
