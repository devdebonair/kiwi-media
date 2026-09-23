"use client";

import { TopicLabel } from "./topic-label.jsx";
import { InfiniteScroll } from "./infinite-scroll.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Compass, Heart, SquaresFour, Tag } from "@phosphor-icons/react";

export function Home({ navigate, api, AppLink, MediaCard, Loading, Empty }) {
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

  useEffect(() => { api("/api/v1/topics").then(setTopics).catch(() => {}); }, [api]);
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

  const followed = topics.filter(topic => topic.followed);
  const suggested = (followed.length ? followed : topics).slice(0, 4);
  const showSpotlight = selected === "all" && assets?.length > 4;
  const libraryAssets = showSpotlight ? assets.slice(2) : assets;

  return <div className="content library-page">
    <div className="chips" role="group" aria-label="Filter library by topic">
      <button aria-pressed={selected === "all"} className={selected === "all" ? "selected" : ""} onClick={() => setSelected("all")}><SquaresFour size={17} weight={selected === "all" ? "fill" : "regular"} /> All media</button>
      {topics.slice(0, 6).map(topic => <button key={topic.id} aria-pressed={selected === topic.slug} className={selected === topic.slug ? "selected" : ""} onClick={() => setSelected(topic.slug)}><TopicLabel topic={topic} /></button>)}
      <AppLink className="chip-browse" href="/topics" navigate={navigate} aria-label="Browse all topics"><ArrowRight size={18} /></AppLink>
    </div>
    {error && <div className="error-notice" role="alert"><span>{error}</span><button className="outline-button" onClick={() => assets?.length ? loadMore() : setRetry(value => value + 1)}>Try again</button></div>}
    {!assets ? <Loading /> : <>
      {showSpotlight && <div className={`discovery-row ${suggested.length ? "" : "without-topics"}`}>
        <section className="spotlight-section" aria-labelledby="spotlight-heading">
          <div className="row-heading"><h2 id="spotlight-heading"><Compass size={21} /> Rediscover your collection</h2><span>Picked from your library</span></div>
          <div className="spotlight-grid">{assets.slice(0, 2).map(asset => <MediaCard key={asset.id} asset={asset} navigate={navigate} />)}</div>
        </section>
        {suggested.length > 0 && <section className="favorite-section" aria-labelledby="favorite-heading">
          <div className="row-heading"><h2 id="favorite-heading">{followed.length ? <Heart size={21} /> : <Tag size={21} />}{followed.length ? "Your favorite topics" : "Find your interests"}</h2></div>
          <div className="favorite-topics">{suggested.map(topic => <AppLink key={topic.id} href={`/topic/${topic.slug}`} navigate={navigate} className="favorite-topic"><img src={topic.avatar_url || "/assets/profile-placeholder.svg"} alt="" /><div><strong>{topic.name}</strong><span>{topic.item_count.toLocaleString()} {topic.item_count === 1 ? "item" : "items"}</span></div><ArrowUpRight size={17} /></AppLink>)}
            <AppLink href="/topics" navigate={navigate} className="all-topics">Explore all topics <ArrowRight size={16} /></AppLink>
          </div>
        </section>}
      </div>}
      {assets.length ? <section aria-labelledby="library-section-heading">
        <div className="row-heading library-section-heading"><h2 id="library-section-heading"><SquaresFour size={21} />{selected === "all" ? "Browse your library" : topics.find(topic => topic.slug === selected)?.name || "Your media"}</h2><span>{assets.length.toLocaleString()}{hasMore ? "+" : ""} items</span></div>
        <div className="media-grid">{libraryAssets.map(asset => <MediaCard key={asset.id} asset={asset} navigate={navigate} />)}</div>
      </section> : !error && <Empty />}
      <InfiniteScroll enabled={hasMore && !error} loading={loadingMore} onLoadMore={loadMore} />
    </>}
  </div>;
}
