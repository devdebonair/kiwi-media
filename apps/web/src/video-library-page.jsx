"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InfiniteScroll } from "./infinite-scroll.jsx";

export function VideoLibraryPage({ api, navigate, MediaCard, Loading, Empty }) {
  const [assets, setAssets] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    setAssets(null); setHasMore(false); setError("");
    api("/api/v1/assets?kind=video&limit=60&offset=0").then(rows => {
      if (generation.current === current) { setAssets(rows); setHasMore(rows.length === 60); }
    }).catch(e => { if (generation.current === current) setError(e.message); });
    return () => { generation.current++; };
  }, [api, retry]);

  const loadMore = useCallback(async () => {
    if (pending.current || !assets || !hasMore) return;
    pending.current = true;
    const current = generation.current;
    setLoadingMore(true); setError("");
    try {
      const rows = await api(`/api/v1/assets?kind=video&limit=60&offset=${assets.length}`);
      if (generation.current === current) {
        setAssets(previous => [...previous, ...rows]);
        setHasMore(rows.length === 60);
      }
    } catch (e) { if (generation.current === current) setError(e.message); }
    finally { pending.current = false; if (generation.current === current) setLoadingMore(false); }
  }, [api, assets, hasMore]);

  return <div className="content library-page">
    <div className="section-heading"><h1>Library</h1></div>
    {error && <div className="error-notice" role="alert"><span>{error}</span><button className="outline-button" onClick={() => assets ? loadMore() : setRetry(value => value + 1)}>Try again</button></div>}
    {!assets && !error ? <Loading /> : assets?.length ? <div className="media-grid">{assets.map(asset => <MediaCard key={asset.id} asset={asset} navigate={navigate} />)}</div> : !error && <Empty title="No videos yet" message="Videos will appear here when they are added to your library." />}
    <InfiniteScroll enabled={hasMore && !error} loading={loadingMore} onLoadMore={loadMore} />
  </div>;
}
