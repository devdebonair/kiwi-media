import { currentProfile, profileContext } from "@kiwi/database";
import { guideChannels, schedule } from "./guide.js";

// Keeps the channels you are watching ready ahead of time: the movie or episode airing now and whatever starts
// in the next few minutes get their source found, opened, and probed before you (or the change of program)
// need them. Only channels tuned in recently are warmed, so nothing runs while nobody is watching.
// Each channel is warmed as the profile watching it sees it (its lineup and its anchor), which also keeps that
// anchor up to date while someone watches.
const TUNED_FOR = 30 * 60_000;
const AHEAD = 10 * 60_000;
const MAX_PER_RUN = 6;

export function createGuideWarmer({ prepare, now = Date.now, log = () => {} }) {
  // `${profile id}\n${channel key}` → { key, profile, at }
  const tuned = new Map();
  let running = null, timer = null;

  async function work() {
    for (const [id, entry] of tuned) if (now() - entry.at > TUNED_FOR) tuned.delete(id);
    if (!tuned.size) return [];
    const viewers = new Map();
    for (const { key, profile } of tuned.values()) {
      if (!viewers.has(profile.id)) viewers.set(profile.id, { profile, keys: new Set() });
      viewers.get(profile.id).keys.add(key);
    }
    const ids = [];
    for (const { profile, keys } of viewers.values()) {
      profileContext.run(profile, () => {
        const { channels, info } = guideChannels();
        for (const channel of channels.filter(item => keys.has(item.key))) {
          const at = now();
          for (const program of schedule(channel, info, at, at + AHEAD, { now: at, persist: true })) {
            if (info.get(program.id)?.titleId && !ids.includes(program.id)) ids.push(program.id);
          }
        }
      });
    }
    const ready = [];
    for (const id of ids.slice(0, MAX_PER_RUN)) {
      try { await prepare(id); ready.push(id); } catch (error) { log(`guide warm-up for ${id}: ${error.message}`); }
    }
    return ready;
  }

  const run = () => {
    running ||= work().finally(() => { running = null; });
    return running;
  };

  return {
    // A channel was tuned in (or is still being watched) by the current profile: get its programs ready now.
    tune(key) {
      const profile = currentProfile();
      tuned.set(`${profile.id}\n${key}`, { key, profile, at: now() });
      run().catch(() => {});
    },
    run,
    tuned: () => [...new Set([...tuned.values()].map(entry => entry.key))],
    start(intervalMs = 60_000) { timer ||= setInterval(() => run().catch(() => {}), intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
