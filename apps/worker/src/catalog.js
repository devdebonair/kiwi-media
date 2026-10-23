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

// Looks for an instantly playable release for library movies and episodes that have not been checked (or had
// none last time), a few at a time. The TV guide only airs what is playable, so an episode with nothing
// available drops out before it would air instead of failing on screen, and comes back once a release appears.
export async function checkAvailability({ batch = 20, log = console.log } = {}) {
  if (!getProvider("torbox").configured) return { checked: 0, unavailable: 0 };
  const { sources } = getMedia();
  const recheckBefore = new Date(Date.now() - 24 * HOUR).toISOString();
  const due = db.prepare(`SELECT a.id FROM assets a JOIN titles t ON t.id=a.title_id
    WHERE t.in_library=1 AND (a.file_path IS NULL OR a.file_path='') AND (a.season_number IS NULL OR a.season_number>=1)
      AND (a.availability='unknown' OR (a.availability='unavailable' AND a.updated_at<?))
      AND NOT EXISTS (SELECT 1 FROM playback_sources p WHERE p.asset_id=a.id AND p.status IN ('candidate','selected'))
    ORDER BY a.availability='unavailable', t.title, a.season_number, a.episode_number LIMIT ?`).all(recheckBefore, batch);
  let checked = 0, unavailable = 0;
  for (const { id } of due) {
    try {
      const result = await sources.check(id);
      checked++;
      if (result === "unavailable") unavailable++;
    } catch (error) {
      log(`availability check for ${id} failed: ${error.message}`);
      if (error.statusCode === 429 || error.code === "rate-limited") break;
    }
  }
  return { checked, unavailable };
}
