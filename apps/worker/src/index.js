import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename, relative, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import mime from "mime-types";
import { db, generatedDir, rebuildSearch } from "@kiwi/database";

const workerId = `worker-${process.pid}`;
const mediaKinds = { ".mp4":"video", ".mkv":"video", ".mov":"video", ".webm":"video", ".mp3":"audio", ".m4a":"audio", ".flac":"audio", ".wav":"audio", ".ogg":"audio", ".jpg":"image", ".jpeg":"image", ".png":"image", ".webp":"image", ".gif":"image", ".pdf":"document", ".md":"article", ".html":"article", ".txt":"article" };
const now = () => new Date().toISOString();

async function walk(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (mediaKinds[extname(entry.name).toLowerCase()]) found.push(path);
  }
  return found;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("close", code => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || `${command} failed`)));
  });
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function importFile(path, root) {
  if (db.prepare("SELECT 1 FROM assets WHERE file_path=?").get(path)) return;
  const info = await stat(path), ext = extname(path).toLowerCase(), kind = mediaKinds[ext];
  const id = randomUUID(), timestamp = now();
  let durationMs = null, width = null, height = null;
  if (kind === "video" || kind === "audio") {
    try {
      const probe = JSON.parse(await run("ffprobe", ["-v","quiet","-print_format","json","-show_format","-show_streams",path]));
      durationMs = Math.round(Number(probe.format?.duration || 0) * 1000) || null;
      const video = probe.streams?.find(s => s.codec_type === "video");
      width = video?.width || null; height = video?.height || null;
    } catch {}
  }
  const thumbPath = resolve(generatedDir, `${id}.jpg`);
  try {
    if (kind === "video") await run("ffmpeg", ["-y","-ss","00:00:02","-i",path,"-frames:v","1","-vf","scale=640:-2",thumbPath]);
    if (kind === "image") await run("ffmpeg", ["-y","-i",path,"-frames:v","1","-vf","scale=640:-2",thumbPath]);
  } catch {}
  const title = basename(path, ext).replaceAll(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  db.prepare("INSERT INTO assets (id,kind,title,description,file_path,thumbnail_url,duration_ms,width,height,added_at,updated_at,visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id, kind, title, `Imported from ${basename(root)}`, path, existsSync(thumbPath) ? `/generated/${id}.jpg` : null, durationMs, width, height, timestamp, timestamp, "private");
  const rootRow = db.prepare("SELECT id FROM library_roots WHERE absolute_path=?").get(root);
  db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)").run(randomUUID(), id, "original", rootRow?.id || null, relative(root,path), mime.lookup(path) || null, info.size, await hashFile(path), timestamp);
}

async function execute(job) {
  const payload = JSON.parse(job.payload_json);
  if (job.type === "scan-root") {
    const files = await walk(payload.root);
    for (let i = 0; i < files.length; i++) {
      await importFile(files[i], payload.root);
      db.prepare("UPDATE jobs SET progress=?,updated_at=? WHERE id=?").run(files.length ? (i + 1) / files.length : 1, now(), job.id);
    }
    rebuildSearch();
  }
}

async function poll() {
  const job = db.prepare("SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY priority DESC,created_at LIMIT 1").get(now());
  if (!job) return;
  const claimed = db.prepare("UPDATE jobs SET status='running',locked_at=?,locked_by=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").run(now(), workerId, now(), job.id);
  if (!claimed.changes) return;
  try {
    await execute(job);
    db.prepare("UPDATE jobs SET status='completed',progress=1,updated_at=? WHERE id=?").run(now(), job.id);
  } catch (error) {
    db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(String(error.stack || error), now(), job.id);
  }
}

console.log(`Kiwi worker ${workerId} ready`);
setInterval(() => poll().catch(console.error), 1500);
poll().catch(console.error);
