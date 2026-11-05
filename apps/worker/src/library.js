import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mime from "mime-types";
import { db, generatedDir, reindexAssetSearch, tagAssetWithTopic } from "@kiwi/database";

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

// Tags deleted since the download was queued are skipped.
function tagTopics(assetId, topicIds) {
  if (!topicIds.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const topicId of topicIds) if (db.prepare("SELECT 1 FROM topics WHERE id=?").get(topicId)) tagAssetWithTopic(assetId, topicId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

const siteName = source => { try { return new URL(source).hostname.replace(/^www\./, ""); } catch { return null; } };

// Adds finished downloads to the library right away and prepares thumbnails, without rescanning the folder.
// A single media file takes the downloader's title (e.g. the video title rather than its file name).
export async function importDownloadedFiles({ root, files, source, title, topicIds = [], targetAssetId = null }) {
  const media = files.filter(path => mediaKinds[extname(path).toLowerCase()]);
  if (targetAssetId) return attachToAsset(root, media, targetAssetId, topicIds);
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
    const assetId = id || db.prepare("SELECT id FROM assets WHERE file_path=?").get(path).id;
    ids.push(assetId);
    tagTopics(assetId, topicIds);
    if (!id) continue;
    reindexAssetSearch(id);
    try { await enrichFile(db.prepare("SELECT * FROM assets WHERE id=?").get(id)); } catch {}
  }
  return ids;
}

// A saved movie or episode becomes the local copy of the catalog item it was downloaded for: the item keeps
// its title, artwork, progress, likes, and tags, and plays from disk from now on.
async function attachToAsset(root, media, assetId, topicIds) {
  const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
  const path = media.find(file => mediaKinds[extname(file).toLowerCase()] === "video");
  if (!asset || !path) return [];
  const info = await stat(path), timestamp = now();
  const existing = db.prepare("SELECT id FROM assets WHERE file_path=? AND id!=?").get(path, assetId);
  if (existing) return [assetId];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE assets SET file_path=?,availability='ready',updated_at=? WHERE id=?").run(path, timestamp, assetId);
    db.prepare("DELETE FROM files WHERE asset_id=? AND role='original'").run(assetId);
    db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)").run(randomUUID(), assetId, "original", root.id, relative(root.absolute_path, path), mime.lookup(path) || null, info.size, null, timestamp);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  tagTopics(assetId, topicIds);
  try {
    const probe = await probeFile(path), video = probe.streams?.find(stream => stream.codec_type === "video");
    const metadata = JSON.parse(asset.metadata_json || "{}");
    const duration = Math.round(Number(probe.format?.duration || 0) * 1000) || null;
    if (duration) metadata.probedDuration = duration;
    db.prepare("UPDATE assets SET duration_ms=coalesce(?,duration_ms),width=?,height=?,metadata_json=? WHERE id=?").run(duration, video?.width || null, video?.height || null, JSON.stringify(metadata), assetId);
  } catch { /* The catalog runtime stays until the file is probed again. */ }
  return [assetId];
}

// Tags in which cameras, phones, and editors record when a video or recording was made.
const DATE_TAGS = ["com.apple.quicktime.creationdate", "creation_time", "date_recorded", "date"];
// Containers write these when no date was set (the QuickTime and Unix epochs), so they mean "unknown".
const EARLIEST = Date.UTC(1971, 0, 1);

// When a file was recorded: the date embedded in it, else the file's last-modified time (when it was saved or
// downloaded, which is usually close). Returns { at, source } with source "embedded" or "file", or null.
export function recordedDate(probe, info) {
  const tags = [probe?.format?.tags, ...(probe?.streams || []).map(stream => stream.tags)].filter(Boolean)
    .map(list => Object.fromEntries(Object.entries(list).map(([key, value]) => [key.toLowerCase(), value])));
  for (const key of DATE_TAGS) {
    for (const list of tags) {
      const time = Date.parse(String(list[key] ?? "").trim());
      if (Number.isFinite(time) && time >= EARLIEST && time <= Date.now() + 86_400_000) return { at: new Date(time).toISOString(), source: "embedded" };
    }
  }
  const modified = info?.mtimeMs;
  return Number.isFinite(modified) && modified >= EARLIEST ? { at: new Date(modified).toISOString(), source: "file" } : null;
}

const probeFile = async (path, args = ["-show_format", "-show_streams"]) =>
  JSON.parse((await exec("ffprobe", ["-v", "error", "-of", "json", ...args, path], { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 })).stdout);

export async function enrichFile(asset) {
  const metadata = JSON.parse(asset.metadata_json);
  let durationMs = null, width = null, height = null, probe = null;
  if (["video", "audio"].includes(asset.kind)) {
    probe = await probeFile(asset.file_path);
    const video = probe.streams?.find(stream => stream.codec_type === "video");
    const audio = probe.streams?.find(stream => stream.codec_type === "audio");
    durationMs = Math.round(Number(probe.format?.duration || 0) * 1000) || null;
    width = video?.width || null; height = video?.height || null;
    metadata.videoCodec = video?.codec_name || null;
    metadata.audioCodec = audio?.codec_name || null;
  }
  const thumbPath = resolve(generatedDir, `${asset.id}.jpg`);
  let thumbnailError = false;
  // Catalog items keep their artwork instead of a frame grab.
  if (["video", "image"].includes(asset.kind) && !asset.title_id) {
    try {
      await exec("ffmpeg", ["-v", "error", "-nostdin", "-y", "-threads", "1", ...(asset.kind === "video" ? ["-ss", "0"] : []), "-i", asset.file_path, "-frames:v", "1", "-vf", "scale=640:-2", "-threads", "1", thumbPath], { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    } catch { thumbnailError = true; }
  }
  metadata.libraryEnriched = !thumbnailError;
  // Movies and episodes have their air date; a home video gets when it was recorded, unless it already has a date.
  let recorded = null;
  if (!asset.title_id && !asset.captured_at) {
    recorded = recordedDate(probe, await stat(asset.file_path).catch(() => null));
    metadata.capturedAtSource = recorded?.source || "unknown";
  }
  db.prepare("UPDATE assets SET duration_ms=?,width=?,height=?,thumbnail_url=?,captured_at=coalesce(captured_at,?),metadata_json=?,updated_at=? WHERE id=?")
    .run(durationMs, width, height, asset.title_id ? asset.thumbnail_url : existsSync(thumbPath) ? `/generated/${asset.id}.jpg` : null, recorded?.at || null, JSON.stringify(metadata), now(), asset.id);
  return !thumbnailError;
}

// Gives home videos imported before recording dates were read one, a batch at a time (only the tags are read, so
// it's quick). Returns { checked, dated }; checked is 0 when none are left. A file that's gone is marked unknown,
// but when none of a batch can be found (a disconnected drive) nothing is marked and it's tried again later.
export async function backfillRecordedDates({ batch = 200, concurrency = 4 } = {}) {
  const assets = db.prepare(`SELECT id, kind, file_path, metadata_json FROM assets WHERE title_id IS NULL AND captured_at IS NULL
    AND file_path IS NOT NULL AND file_path!='' AND json_extract(metadata_json,'$.capturedAtSource') IS NULL ORDER BY added_at LIMIT ?`).all(batch);
  const found = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < assets.length) {
      const asset = assets[next++];
      const info = await stat(asset.file_path).catch(() => null);
      const probe = info && ["video", "audio"].includes(asset.kind) ? await probeFile(asset.file_path, ["-show_entries", "format_tags:stream_tags"]).catch(() => null) : null;
      found.push({ asset, info, recorded: info ? recordedDate(probe, info) : null });
    }
  }));
  if (found.length && found.every(entry => !entry.info)) return { checked: 0, dated: 0, unreachable: found.length };
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE assets SET captured_at=coalesce(captured_at,?), metadata_json=? WHERE id=?");
    for (const { asset, recorded } of found) {
      const metadata = JSON.parse(asset.metadata_json || "{}");
      metadata.capturedAtSource = recorded?.source || "unknown";
      update.run(recorded?.at || null, JSON.stringify(metadata), asset.id);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { checked: found.length, dated: found.filter(entry => entry.recorded).length };
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
