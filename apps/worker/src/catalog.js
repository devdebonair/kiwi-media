import { db } from "@kiwi/database";
import { ensureAllSeasons, getMedia, getProvider, openTitle, pruneStubs } from "@kiwi/media";

const HOUR = 3_600_000;
// Titles that are still airing change often; finished ones almost never do.
const staleAfter = title => /ended|canceled|released/i.test(title.status || "") ? 14 * 24 * HOUR : 12 * HOUR;

// Keeps library titles fresh in small batches so catalog requests stay spread out, then tidies the caches.
export async function refreshLibrary({ batch = 8, log = console.log } = {}) {
  if (!getProvider("tmdb").configured) return { refreshed: 0, pruned: 0 };
  const { tmdb, images } = getMedia();
  const due = db.prepare("SELECT * FROM titles WHERE in_library=1 ORDER BY coalesce(synced_at,'') ASC").all()
    .filter(title => !title.synced_at || Date.now() - Date.parse(title.synced_at) > staleAfter(title)).slice(0, batch);
  let refreshed = 0;
  for (const title of due) {
    try {
      const fresh = await openTitle(title.type, title.tmdb_id, tmdb, { refresh: true });
      if (fresh.type === "show") await ensureAllSeasons(fresh.id, tmdb, { force: true });
      refreshed++;
    } catch (error) { log(`refresh of “${title.title}” failed: ${error.message}`); }
  }
  const pruned = pruneStubs();
  images.evict();
  return { refreshed, pruned };
}
