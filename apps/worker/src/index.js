import { db, rebuildSearch } from "@kiwi/database";
import { createDownloadRunner } from "@kiwi/downloads/runner";
import { registerPlugin } from "@kiwi/downloads";
import { mediaDownloadPlugin } from "@kiwi/media";
import { scanRoot, enrichRoot, enqueue, importDownloadedFiles } from "./library.js";
import { checkAvailability, refreshLibrary } from "./catalog.js";

const workerId = `worker-${process.pid}`;
const now = () => new Date().toISOString();
let busy = false;

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const job = db.prepare("SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY priority DESC,created_at LIMIT 1").get(now());
    if (!job) return;
    const claimed = db.prepare("UPDATE jobs SET status='running',locked_at=?,locked_by=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").run(now(), workerId, now(), job.id);
    if (!claimed.changes) return;
    try {
      const { root } = JSON.parse(job.payload_json);
      const progress = value => db.prepare("UPDATE jobs SET progress=?,updated_at=? WHERE id=?").run(value, now(), job.id);
      if (job.type === "scan-root") {
        const result = await scanRoot(root, progress);
        rebuildSearch();
        enqueue("enrich-root", root);
        console.log(JSON.stringify({ job: job.id, ...result }));
      } else if (job.type === "enrich-root") {
        const result = await enrichRoot(root, progress);
        if (result.failed) db.prepare("UPDATE jobs SET error=? WHERE id=?").run(`${result.failed} files could not be fully probed or thumbnailed; originals remain available.`, job.id);
        console.log(JSON.stringify({ job: job.id, ...result }));
      } else throw new Error(`Unknown job type: ${job.type}`);
      db.prepare("UPDATE jobs SET status='completed',progress=1,updated_at=? WHERE id=?").run(now(), job.id);
    } catch (error) {
      db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(String(error.stack || error), now(), job.id);
    }
  } finally { busy = false; }
}

// Downloads run on their own queue so a long download never blocks library scans.
registerPlugin(mediaDownloadPlugin);
const downloads = createDownloadRunner({ workerId, importFiles: importDownloadedFiles });
downloads.start();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => downloads.stop().finally(() => process.exit(0)));

// Library titles refresh in the background; the first pass waits a minute so startup stays quick.
const maintain = () => refreshLibrary().then(result => { if (result.refreshed || result.pruned) console.log(JSON.stringify({ catalog: result })); }).catch(console.error);
setTimeout(maintain, 60_000).unref();
setInterval(maintain, 3_600_000).unref();
// Streamed episodes are checked for a playable release in small batches, so the TV guide skips the ones without.
let checking = false;
const check = () => {
  if (checking) return;
  checking = true;
  checkAvailability().then(result => { if (result.checked) console.log(JSON.stringify({ availability: result })); }).catch(console.error).finally(() => { checking = false; });
};
setTimeout(check, 90_000).unref();
setInterval(check, 10 * 60_000).unref();

console.log(`Kiwi worker ${workerId} ready`);
setInterval(() => poll().catch(console.error), 1500);
poll().catch(console.error);
