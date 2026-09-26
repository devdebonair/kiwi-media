"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, SquaresFour } from "@phosphor-icons/react";
import { TopicLabel } from "./topic-label.jsx";
import { InfiniteScroll } from "./infinite-scroll.jsx";

export function LikedPage({ api, navigate, MediaCard, Loading, Empty }) {
  const [assets, setAssets] = useState(null);
  const [filters, setFilters] = useState({ levels: [], topics: [] });
  const [likes, setLikes] = useState(null);
  const [topic, setTopic] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const pageUrl = (offset = 0) => `/api/v1/liked?limit=60&offset=${offset}${likes ? `&likes=${likes}` : ""}${topic ? `&topic=${encodeURIComponent(topic)}` : ""}`;

  useEffect(() => { api("/api/v1/liked/filters").then(setFilters).catch(() => {}); }, [api]);
  useEffect(() => {
    const current = ++generation.current;
    setAssets(null); setError(""); setLoadingMore(false); setHasMore(false);
    api(pageUrl()).then(rows => {
      if (generation.current === current) { setAssets(rows); setHasMore(rows.length === 60); }
    }).catch(e => { if (generation.current === current) { setError(e.message); setAssets([]); } });
    return () => { generation.current++; };
  }, [likes, topic, retry]);

  const loadMore = useCallback(async () => {
    if (pending.current || !assets || !hasMore) return;
    pending.current = true;
    const current = generation.current;
    setLoadingMore(true); setError("");
    try {
      const rows = await api(pageUrl(assets.length));
      if (generation.current === current) { setAssets(previous => [...previous, ...rows]); setHasMore(rows.length === 60); }
    } catch (e) { if (generation.current === current) setError(e.message); }
    finally { pending.current = false; if (generation.current === current) setLoadingMore(false); }
  }, [assets, hasMore, likes, topic]);

  const unfiltered = !likes && !topic;
  const hasFilters = filters.levels.length > 1 || filters.topics.length > 0;

  return <div className="content library-page liked-page">
    <div className="section-heading"><div><h1>Liked videos</h1><p>Ranked by your likes, most loved first.</p></div></div>
    {hasFilters && <div className="chips" role="group" aria-label="Filter liked videos">
      <button aria-pressed={unfiltered} className={unfiltered ? "selected" : ""} onClick={() => { setLikes(null); setTopic(null); }}><SquaresFour size={17} weight={unfiltered ? "fill" : "regular"} /> All</button>
      {filters.levels.length > 1 && filters.levels.map(level => <button key={level.likes} aria-pressed={likes === level.likes} aria-label={`${level.likes} ${level.likes === 1 ? "like" : "likes"}, ${level.item_count} ${level.item_count === 1 ? "video" : "videos"}`} data-level={level.likes} className={`like-level-chip ${likes === level.likes ? "selected" : ""}`} onClick={() => setLikes(value => value === level.likes ? null : level.likes)}>
        <Heart size={16} weight="fill" /> {level.likes}<span className="chip-count">{level.item_count.toLocaleString()}</span>
      </button>)}
      {filters.levels.length > 1 && filters.topics.length > 0 && <span className="chip-divider" aria-hidden="true" />}
      {filters.topics.map(item => <button key={item.id} aria-pressed={topic === item.slug} className={topic === item.slug ? "selected" : ""} onClick={() => setTopic(value => value === item.slug ? null : item.slug)}><TopicLabel topic={item} /></button>)}
    </div>}
    {error && <div className="error-notice" role="alert"><span>{error}</span><button className="outline-button" onClick={() => assets?.length ? loadMore() : setRetry(value => value + 1)}>Try again</button></div>}
    {!assets ? <Loading /> : assets.length ? <div className="media-grid">{assets.map(asset => <MediaCard key={asset.id} asset={asset} navigate={navigate} />)}</div>
      : !error && (unfiltered
        ? <Empty title="No liked videos yet" message="Like a video from the player and it will show up here, ranked by how much you love it." />
        : <Empty title="Nothing matches these filters" message="Try another like level or topic." />)}
    <InfiniteScroll enabled={hasMore && !error} loading={loadingMore} onLoadMore={loadMore} />
  </div>;
}
