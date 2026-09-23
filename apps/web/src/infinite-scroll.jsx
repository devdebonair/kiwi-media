"use client";

import { useEffect, useRef } from "react";

export function InfiniteScroll({ enabled, loading, onLoadMore }) {
  const sentinel = useRef(null);

  useEffect(() => {
    if (!enabled || loading || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) onLoadMore();
    }, { rootMargin: "700px 0px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [enabled, loading, onLoadMore]);

  return enabled ? <div ref={sentinel} className="scroll-sentinel" aria-live="polite">{loading ? "Loading more…" : ""}</div> : null;
}
