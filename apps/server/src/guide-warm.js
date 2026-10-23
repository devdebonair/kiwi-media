import { guideChannels, schedule } from "./guide.js";

// Keeps the channels you are watching ready ahead of time: the movie or episode airing now and whatever starts
// in the next few minutes get their source found, opened, and probed before you (or the change of program)
// need them. Only channels tuned in recently are warmed, so nothing runs while nobody is watching.
const TUNED_FOR = 30 * 60_000;
const AHEAD = 10 * 60_000;
const MAX_PER_RUN = 6;

export function createGuideWarmer({ prepare, now = Date.now, log = () => {} }) {
  const tuned = new Map();
  let running = null, timer = null;

  async function work() {
    for (const [key, at] of tuned) if (now() - at > TUNED_FOR) tuned.delete(key);
    if (!tuned.size) return [];
    const { channels, info } = guideChannels();
    const ids = [];
    for (const channel of channels.filter(item => tuned.has(item.key))) {
      for (const program of schedule(channel, info, now(), now() + AHEAD)) {
        if (info.get(program.id)?.titleId && !ids.includes(program.id)) ids.push(program.id);
      }
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
    // A channel was tuned in (or is still being watched): get its programs ready now.
    tune(key) { tuned.set(key, now()); run().catch(() => {}); },
    run,
    tuned: () => [...tuned.keys()],
    start(intervalMs = 60_000) { timer ||= setInterval(() => run().catch(() => {}), intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
