import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { dataDir, db } from "@kiwi/database";
import { binaryPath } from "./binaries.js";
import { createHttp, DownloadError } from "./http.js";
import { getPlugin } from "./registry.js";
import { cookiesPath, destinationFor, downloadBlocker, getDownloader, getVpnProfile } from "./store.js";
import { createTunnelManager } from "./vpn.js";

const now = () => new Date().toISOString();
const partial = /\.(part|ytdl|temp|tmp)$|\.part-Frag\d+|\.f\d+\.\w+$/i;

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile() && !partial.test(entry.name)) files.push(path);
  }
  return files;
}

// Never overwrite: "Video.mp4" becomes "Video (1).mp4" when the name is taken.
async function freeName(path) {
  if (!existsSync(path)) return path;
  const ext = extname(path), base = path.slice(0, path.length - ext.length);
  for (let index = 1; ; index++) if (!existsSync(`${base} (${index})${ext}`)) return `${base} (${index})${ext}`;
}

async function moveInto(file, workDir, destination) {
  const target = await freeName(join(destination, relative(workDir, file)));
  await mkdir(dirname(target), { recursive: true });
  try { await rename(file, target); }
  catch (error) { if (error.code !== "EXDEV") throw error; await copyFile(file, target); await rm(file); }
  return target;
}

class Canceled extends Error {}
class Stopped extends Error {}

// Runs a child process tied to the job's abort signal, reporting each output line.
function runner(signal, env, log) {
  return (command, args, { onLine = log, onExit, cwd } = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); };
    signal.addEventListener("abort", abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";
      stream.on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) try { onLine(line); } catch {}
      });
    }
    child.once("error", error => reject(new DownloadError(error.code === "ENOENT" ? `${basename(command)} is not installed on the server` : error.message)));
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return reject(signal.reason);
      try {
        if (onExit) onExit(code);
        else if (code) throw new DownloadError(`${basename(command)} exited with code ${code}`);
        resolve(code);
      } catch (error) { reject(error); }
    });
  });
}

export function createDownloadRunner({ workerId, concurrency = Number(process.env.KIWI_DOWNLOAD_CONCURRENCY || 2), importFiles = async () => [], tunnels = createTunnelManager({ log: console.log }), log = console.log } = {}) {
  const active = new Map();

  // A worker restart interrupts running jobs; queue them again rather than leaving them stuck.
  function recover() {
    db.prepare("UPDATE downloads SET status='queued',locked_by=NULL,message='Restarted after the worker stopped',updated_at=? WHERE status='running'").run(now());
    db.prepare("UPDATE downloads SET status='canceled',locked_by=NULL,finished_at=?,updated_at=? WHERE status='canceling'").run(now(), now());
  }

  function claim() {
    while (active.size < concurrency) {
      const row = db.prepare("SELECT * FROM downloads WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
      if (!row) return;
      const claimed = db.prepare("UPDATE downloads SET status='running',locked_by=?,attempts=attempts+1,started_at=?,finished_at=NULL,error=NULL,progress=NULL,updated_at=? WHERE id=? AND status='queued'").run(workerId, now(), now(), row.id);
      if (!claimed.changes) continue;
      const controller = new AbortController();
      const job = run(row, controller).finally(() => active.delete(row.id));
      active.set(row.id, { controller, job });
    }
  }

  async function run(row, controller) {
    const { signal } = controller;
    const lines = [];
    const state = { title: row.title, message: "Starting", progress: null, bytes_done: null, bytes_total: null, speed: null, eta_seconds: null };
    let dirty = true;
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      db.prepare("UPDATE downloads SET title=?,message=?,progress=?,bytes_done=?,bytes_total=?,speed=?,eta_seconds=?,log_text=?,updated_at=? WHERE id=?")
        .run(state.title ?? null, state.message, state.progress, state.bytes_done, state.bytes_total, state.speed, state.eta_seconds, lines.join("\n"), now(), row.id);
    };
    const writeLog = line => { lines.push(String(line).slice(0, 500)); if (lines.length > 200) lines.shift(); dirty = true; };
    const progress = update => {
      if (update.title) state.title = String(update.title).slice(0, 300);
      if (update.message) state.message = String(update.message).slice(0, 200);
      if (update.bytes != null) state.bytes_done = Math.round(update.bytes);
      if (update.totalBytes != null) state.bytes_total = Math.round(update.totalBytes);
      if ("speed" in update) state.speed = update.speed ?? null;
      if ("eta" in update) state.eta_seconds = update.eta ?? null;
      if ("fraction" in update) state.progress = update.fraction == null ? null : Math.max(0, Math.min(1, update.fraction));
      else if (update.bytes != null && update.totalBytes) state.progress = Math.min(1, update.bytes / update.totalBytes);
      dirty = true;
    };
    // Poll for cancel requests and persist progress at a steady pace.
    const ticker = setInterval(() => {
      if (db.prepare("SELECT status FROM downloads WHERE id=?").get(row.id)?.status === "canceling") controller.abort(new Canceled("Canceled"));
      flush();
    }, 750);
    const tmpDir = join(dataDir, "downloads", "tmp", row.id);
    let tunnel, http, workDir;
    try {
      const downloader = getDownloader(row.downloader_id);
      if (!downloader) throw new DownloadError("The downloader for this job was removed.");
      const plugin = await getPlugin(downloader.plugin);
      const { root, path: destination } = destinationFor(row.library_root_id, row.subfolder);
      const blocked = downloadBlocker(root);
      if (blocked) throw new DownloadError(blocked);
      await mkdir(destination, { recursive: true });

      // Fail closed: a job assigned to a VPN never falls back to the server's own connection.
      let proxyUrl = null;
      if (row.vpn_profile_id) {
        const profile = getVpnProfile(row.vpn_profile_id);
        if (!profile) throw new DownloadError("Its VPN profile was deleted, so the download stopped instead of using the server's own connection.");
        progress({ message: `Connecting to ${profile.name}` });
        tunnel = await tunnels.acquire(profile);
        proxyUrl = tunnel.proxyUrl;
        writeLog(`Routing through VPN profile “${profile.name}” (${row.vpn_reason || "selected"})`);
      }
      http = createHttp({ proxyUrl, signal });

      workDir = join(destination, `.kiwi-download-${row.id}`);
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      let cookiesFile = null, cookies = null;
      if (plugin.cookies && existsSync(cookiesPath(downloader.id))) {
        await mkdir(tmpDir, { recursive: true, mode: 0o700 });
        cookiesFile = join(tmpDir, "cookies.txt");
        await copyFile(cookiesPath(downloader.id), cookiesFile);
        cookies = await readFile(cookiesFile, "utf8");
      }
      const env = proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" } : {};
      progress({ message: "Starting download" });
      const result = await plugin.download({
        source: row.source, config: downloader.config, workDir, http, proxyUrl, cookiesFile, cookies, signal,
        progress, log: writeLog, run: runner(signal, env, writeLog), binaryPath,
      });
      if (result?.title) progress({ title: result.title });
      if (signal.aborted) throw signal.reason;

      const saved = await listFiles(workDir);
      if (!saved.length) throw new DownloadError("The downloader finished without saving a file.");
      progress({ message: "Adding to library" });
      const files = [];
      for (const file of saved) files.push(await moveInto(file, workDir, destination));
      await rm(workDir, { recursive: true, force: true });
      flush();
      let assetIds = [];
      try { assetIds = await importFiles({ root, files, source: row.source, title: state.title }); }
      catch (error) { writeLog(`Import failed: ${error.message}. Scan the library to add these files.`); }
      Object.assign(state, { message: `Saved ${files.length} file${files.length === 1 ? "" : "s"}`, progress: 1, eta_seconds: 0 });
      dirty = true; flush();
      db.prepare("UPDATE downloads SET status='completed',files_json=?,asset_ids_json=?,finished_at=?,updated_at=? WHERE id=?").run(JSON.stringify(files), JSON.stringify(assetIds), now(), now(), row.id);
      log(JSON.stringify({ download: row.id, files: files.length }));
    } catch (error) {
      const canceled = signal.aborted && signal.reason instanceof Canceled;
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
      if (signal.aborted && signal.reason instanceof Stopped) {
        state.message = "Waiting for the worker"; dirty = true; flush();
        db.prepare("UPDATE downloads SET status='queued',locked_by=NULL,updated_at=? WHERE id=? AND status='running'").run(now(), row.id);
        return;
      }
      if (!canceled) writeLog(`Error: ${error.message}`);
      state.message = canceled ? "Canceled" : "Failed";
      dirty = true; flush();
      db.prepare("UPDATE downloads SET status=?,error=?,finished_at=?,updated_at=? WHERE id=?").run(canceled ? "canceled" : "failed", canceled ? null : String(error.message || error).slice(0, 1000), now(), now(), row.id);
    } finally {
      clearInterval(ticker);
      http?.close();
      tunnel?.release();
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  let timer;
  return {
    start(interval = 1000) {
      recover();
      claim();
      timer = setInterval(() => { try { claim(); } catch (error) { log(error); } }, interval);
    },
    claim,
    recover,
    async stop() {
      clearInterval(timer);
      for (const { controller } of active.values()) controller.abort(new Stopped("Worker stopped"));
      await Promise.allSettled([...active.values()].map(entry => entry.job));
      await tunnels.closeAll();
    },
    idle: () => Promise.allSettled([...active.values()].map(entry => entry.job)),
    get active() { return active.size; },
  };
}
