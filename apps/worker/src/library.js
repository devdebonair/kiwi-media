import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mime from "mime-types";
import { db, generatedDir, reindexAssetSearch } from "@kiwi/database";

const exec = promisify(execFile);
const now = () => new Date().toISOString();
const mediaKinds = Object.fromEntries(Object.entries({
  video: [".mp4", ".mkv", ".mov", ".webm", ".m4v", ".avi", ".wmv", ".ts", ".mts", ".m2ts", ".flv", ".mpg", ".mpeg"],
  audio: [".mp3", ".m4a", ".flac", ".wav", ".ogg"], image: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
  document: [".pdf"], article: [".md", ".html", ".txt"],
}).flatMap(([kind, extensions]) => extensions.map(ext => [ext, kind])));

export function enqueue(type, root) {
  const payload = JSON.stringify({ root: resolve(root) });
  if (db.prepare("SELECT 1 FROM jobs WHERE type=? AND payload_json=? AND status IN ('queued','running')").get(type, payload)) return;
  const timestamp = now();
  db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), type, payload, "queued", type === "scan-root" ? 10 : 0, 0, timestamp, null, null, 0, null, timestamp, timestamp);
}

async function walk(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    // In-progress downloads are staged here and moved into place when complete.
    if (entry.isDirectory() && entry.name.startsWith(".kiwi-download-")) continue;
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.isFile() && mediaKinds[extname(entry.name).toLowerCase()]) found.push(path);
  }
  return found;
}

export async function scanRoot(input, progress = () => {}) {
  const root = resolve(input);
  const files = await walk(root);
  db.prepare("INSERT OR IGNORE INTO library_roots (id,name,absolute_path,read_only,created_at) VALUES (?,?,?,?,?)").run(randomUUID(), basename(root), root, 1, now());
  const rootId = db.prepare("SELECT id FROM library_roots WHERE absolute_path=?").get(root).id;
  let imported = 0;
  for (const [index, path] of files.entries()) {
    if (await registerFile(root, rootId, path)) imported++;
    if (index % 50 === 0 || index === files.length - 1) progress((index + 1) / files.length);
  }
  return { total: files.length, imported };
}

// Registration needs no full-file checksum, thumbnail, or external metadata. Returns the new asset ID.
async function registerFile(root, rootId, path, { title, description = `Imported from ${basename(root)}`, sourceUrl = null } = {}) {
  if (db.prepare("SELECT 1 FROM assets WHERE file_path=?").get(path)) return null;
  const info = await stat(path), ext = extname(path).toLowerCase();
  const id = randomUUID(), timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO assets (id,kind,title,description,source_url,file_path,added_at,updated_at,visibility) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, mediaKinds[ext], title || basename(path, ext), description, sourceUrl, path, timestamp, timestamp, "private");
    db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), id, "original", rootId, relative(root, path), mime.lookup(path) || null, info.size, null, timestamp);
    if (sourceUrl) {
      db.prepare("INSERT INTO asset_sources (id,asset_id,source_url,canonical_url,site_name,retrieved_at) VALUES (?,?,?,?,?,?)")
        .run(randomUUID(), id, sourceUrl, sourceUrl, siteName(sourceUrl), timestamp);
    }
    db.exec("COMMIT");
    return id;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

const siteName = source => { try { return new URL(source).hostname.replace(/^www\./, ""); } catch { return null; } };

// Adds finished downloads to the library right away and prepares thumbnails, without rescanning the folder.
// A single media file takes the downloader's title (e.g. the video title rather than its file name).
export async function importDownloadedFiles({ root, files, source, title }) {
  const media = files.filter(path => mediaKinds[extname(path).toLowerCase()]);
  const sourceUrl = /^https?:\/\//i.test(source) ? source : null;
  const site = siteName(source);
  const ids = [];
  for (const path of media) {
    const id = await registerFile(root.absolute_path, root.id, path, {
      title: media.length === 1 && title ? title : undefined,
      description: site ? `Downloaded from ${site}` : "Downloaded from the web",
      sourceUrl,
    });
    // A file saved over a path that was imported before keeps its existing asset.
    if (!id) { ids.push(db.prepare("SELECT id FROM assets WHERE file_path=?").get(path).id); continue; }
    ids.push(id);
    reindexAssetSearch(id);
    try { await enrichFile(db.prepare("SELECT * FROM assets WHERE id=?").get(id)); } catch {}
  }
  return ids;
}

export async function enrichFile(asset) {
  const metadata = JSON.parse(asset.metadata_json);
  let durationMs = null, width = null, height = null;
  if (["video", "audio"].includes(asset.kind)) {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-of", "json", "-show_format", "-show_streams", asset.file_path], { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 });
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find(stream => stream.codec_type === "video");
    const audio = probe.streams?.find(stream => stream.codec_type === "audio");
    durationMs = Math.round(Number(probe.format?.duration || 0) * 1000) || null;
    width = video?.width || null; height = video?.height || null;
    metadata.videoCodec = video?.codec_name || null;
    metadata.audioCodec = audio?.codec_name || null;
  }
  const thumbPath = resolve(generatedDir, `${asset.id}.jpg`);
  let thumbnailError = false;
  if (["video", "image"].includes(asset.kind)) {
    try {
      await exec("ffmpeg", ["-v", "error", "-nostdin", "-y", "-threads", "1", ...(asset.kind === "video" ? ["-ss", "0"] : []), "-i", asset.file_path, "-frames:v", "1", "-vf", "scale=640:-2", "-threads", "1", thumbPath], { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    } catch { thumbnailError = true; }
  }
  metadata.libraryEnriched = !thumbnailError;
  db.prepare("UPDATE assets SET duration_ms=?,width=?,height=?,thumbnail_url=?,metadata_json=?,updated_at=? WHERE id=?")
    .run(durationMs, width, height, existsSync(thumbPath) ? `/generated/${asset.id}.jpg` : null, JSON.stringify(metadata), now(), asset.id);
  return !thumbnailError;
}

export async function enrichRoot(root, progress = () => {}) {
  const assets = db.prepare(`SELECT DISTINCT a.* FROM assets a JOIN files f ON f.asset_id=a.id JOIN library_roots r ON r.id=f.library_root_id
    WHERE r.absolute_path=? AND coalesce(json_extract(a.metadata_json,'$.libraryEnriched'),0)=0 ORDER BY a.added_at DESC,a.id DESC`).all(resolve(root));
  let next = 0, completed = 0, failed = 0;
  async function consume() {
    while (next < assets.length) {
      const asset = assets[next++];
      try { if (!await enrichFile(asset)) failed++; } catch { failed++; }
      completed++;
      if (completed % 10 === 0 || completed === assets.length) progress(completed / assets.length);
    }
  }
  await Promise.all(Array.from({ length: 4 }, consume));
  return { total: assets.length, failed };
}
