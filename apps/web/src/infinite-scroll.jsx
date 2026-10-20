"use client";

import { useEffect, useRef } from "react";

// `rootRef` watches a scrolling container instead of the page.
export function InfiniteScroll({ enabled, loading, onLoadMore, rootRef }) {
  const sentinel = useRef(null);

  useEffect(() => {
    if (!enabled || loading || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) onLoadMore();
    }, { root: rootRef?.current || null, rootMargin: "700px 0px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [enabled, loading, onLoadMore, rootRef]);

  return enabled ? <div ref={sentinel} className="scroll-sentinel" aria-live="polite">{loading ? "Loading more…" : ""}</div> : null;
}
