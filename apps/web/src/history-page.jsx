"use client";
import { useEffect, useRef, useState } from "react";

export function HistoryPage({ api, navigate, ResultCard, Loading, Empty }) {
  const [assets, setAssets] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const pending = useRef(false);

  const [scope, setScope] = useState("all");

  async function load(offset = 0, which = scope) {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const rows = await api(`/api/v1/history?limit=60&offset=${offset}&scope=${which}`);
      if (!active.current) return;
      setAssets(previous => offset ? [...previous, ...rows] : rows);
      setHasMore(rows.length === 60);
    } catch (e) {
      if (active.current) setError(e.message);
    } finally {
      pending.current = false;
      if (active.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => { setAssets(null); setError(""); load(0, scope); }, [scope]);

  return <div className="content narrow">
    <div className="section-heading"><div><h1>Watch history</h1><p>Most recently watched first.</p></div></div>
    <div className="scope-tabs" role="group" aria-label="Show history for">{[["all", "Everything"], ["home", "Home videos"], ["catalog", "Movies & shows"]].map(([value, label]) => <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>{label}</button>)}</div>
    {error && <div role="alert"><p>{error}</p><button className="outline-button" onClick={() => load(assets?.length || 0)}>Try again</button></div>}
    {!assets && !error ? <Loading /> : assets?.length ? <div className="result-list">
      {assets.map(asset => <ResultCard key={asset.id} asset={asset} navigate={navigate} />)}
    </div> : !error && <Empty title="No watch history yet" message="Play a video or audio item and it will appear here." />}
    {hasMore && !error && <div style={{ display: "flex", justifyContent: "center", padding: "32px 0" }}>
      <button className="outline-button" disabled={loading} onClick={() => load(assets.length)}>{loading ? "Loading…" : "Load more"}</button>
    </div>}
  </div>;
}
