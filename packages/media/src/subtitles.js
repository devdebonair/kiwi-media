import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { db, generatedDir } from "@kiwi/database";
import { normalizeLanguage } from "./tracks.js";

const exec = promisify(execFile);
const now = () => new Date().toISOString();
export const subtitlesDir = join(generatedDir, "subtitles");
const LABELS = { eng: "English", jpn: "Japanese", zho: "Chinese", kor: "Korean", spa: "Spanish", fra: "French", deu: "German", ita: "Italian", por: "Portuguese", rus: "Russian", ara: "Arabic", hin: "Hindi" };

export const languageLabel = code => LABELS[code] || (code ? code.toUpperCase() : "Unknown");

export function trackLabel(track) {
  const parts = [languageLabel(track.language)];
  if (track.title && !new RegExp(`^${languageLabel(track.language)}$`, "i").test(track.title.trim())) parts.push(track.title.trim());
  else {
    if (track.forced) parts.push("forced");
    if (track.sdh) parts.push("SDH");
  }
  return parts.join(" · ");
}

// SubRip → WebVTT: the only differences are the header and the decimal separator in timestamps.
export function srtToVtt(text) {
  const body = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (/^WEBVTT/.test(body)) return `${body}\n`;
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/<\/?font[^>]*>/gi, "").replace(/\{\\an?\d\}/g, "")}\n`;
}

const rowTrack = row => ({
  id: row.id, origin: row.origin, language: row.language, label: row.label, codec: row.codec, forced: Boolean(row.forced), sdh: Boolean(row.sdh),
  status: row.status, error: row.error, url: row.status === "ready" ? `/api/v1/subtitles/${row.id}.vtt` : null,
});

export function createSubtitleService({ resolveInput, external, log = () => {} } = {}) {
  const extracting = new Map();
  let active = 0;
  const waiting = [];
  const slot = async () => { if (active >= 2) await new Promise(resolve => waiting.push(resolve)); active++; };
  const free = () => { active--; waiting.shift()?.(); };

  const listRows = (assetId, sourceKey) => db.prepare("SELECT * FROM subtitle_tracks WHERE asset_id=? AND coalesce(source_key,'')=coalesce(?,'') ORDER BY (origin='sidecar') DESC, language, stream_index").all(assetId, sourceKey ?? null);

  // Records the text subtitle streams of the current file so they can be extracted when first wanted.
  function syncEmbedded(assetId, sourceKey, info) {
    const timestamp = now();
    const known = new Map(listRows(assetId, sourceKey).filter(row => row.origin === "embedded").map(row => [row.stream_index, row]));
    const insert = db.prepare("INSERT INTO subtitle_tracks (id,asset_id,source_key,origin,language,label,codec,stream_index,forced,sdh,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const stream of info.subtitles) {
      if (known.has(stream.index)) continue;
      insert.run(randomUUID(), assetId, sourceKey ?? null, "embedded", stream.language, trackLabel(stream), stream.codec, stream.index, Number(stream.forced), Number(stream.sdh), stream.text ? "pending" : "unsupported", timestamp, timestamp);
    }
  }

  // Subtitle files next to a downloaded video: "Show.S01E01.en.srt", "Show.S01E01.srt", or a Subs folder.
  async function syncSidecars(assetId, filePath) {
    if (!filePath || !existsSync(filePath)) return;
    const stem = basename(filePath, extname(filePath)).toLowerCase();
    const folders = [dirname(filePath), join(dirname(filePath), "Subs"), join(dirname(filePath), "Subtitles"), join(dirname(filePath), "Subs", stem)];
    const known = new Set(listRows(assetId, null).filter(row => row.origin === "sidecar").map(row => row.file_path));
    for (const folder of folders) {
      let names = [];
      try { names = readdirSync(folder); } catch { continue; }
      for (const name of names) {
        if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) continue;
        const lower = name.toLowerCase();
        if (folder === dirname(filePath) ? !lower.startsWith(stem) : !(lower.startsWith(stem) || /^\d+_/.test(lower) || folder.endsWith(stem))) continue;
        const path = join(folder, name);
        if (known.has(path)) continue;
        const language = normalizeLanguage(...lower.slice(stem.length).split(/[.\-_ ]+/), lower.replace(/\.[^.]+$/, "").split(/[.\-_ ]+/).pop());
        const timestamp = now();
        db.prepare("INSERT INTO subtitle_tracks (id,asset_id,source_key,origin,language,label,codec,forced,sdh,file_path,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(randomUUID(), assetId, null, "sidecar", language, trackLabel({ language, forced: /forced/.test(lower), sdh: /sdh|\bcc\b/.test(lower) }), extname(name).slice(1).toLowerCase(), Number(/forced/.test(lower)), Number(/sdh|\bcc\b/.test(lower)), path, "pending", timestamp, timestamp);
      }
    }
  }

  async function writeVtt(row, text) {
    await mkdir(subtitlesDir, { recursive: true });
    const file = join(subtitlesDir, `${row.id}.vtt`);
    await writeFile(file, text);
    db.prepare("UPDATE subtitle_tracks SET file_path=?,status='ready',error=NULL,updated_at=? WHERE id=?").run(file, now(), row.id);
  }

  async function extractEmbedded(row) {
    const input = await resolveInput(row.asset_id);
    await mkdir(subtitlesDir, { recursive: true });
    const file = join(subtitlesDir, `${row.id}.vtt`);
    const args = ["-nostdin", "-v", "error", "-y"];
    if (/^https?:/i.test(input)) args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
    await exec("ffmpeg", [...args, "-i", input, "-map", `0:${row.stream_index}`, "-c:s", "webvtt", "-f", "webvtt", file], { timeout: 15 * 60_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    db.prepare("UPDATE subtitle_tracks SET file_path=?,status='ready',error=NULL,updated_at=? WHERE id=?").run(file, now(), row.id);
  }

  async function convertSidecar(row) {
    if (/\.vtt$/i.test(row.file_path)) { db.prepare("UPDATE subtitle_tracks SET status='ready',updated_at=? WHERE id=?").run(now(), row.id); return; }
    if (/\.srt$/i.test(row.file_path)) return writeVtt(row, srtToVtt(await readFile(row.file_path, "utf8")));
    await mkdir(subtitlesDir, { recursive: true });
    const file = join(subtitlesDir, `${row.id}.vtt`);
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", row.file_path, "-f", "webvtt", file], { timeout: 60_000 });
    db.prepare("UPDATE subtitle_tracks SET file_path=?,status='ready',updated_at=? WHERE id=?").run(file, now(), row.id);
  }

  // Makes one track playable (extracting or converting it first), sharing work between callers.
  function ensure(trackId) {
    const row = db.prepare("SELECT * FROM subtitle_tracks WHERE id=?").get(trackId);
    if (!row) return null;
    if (row.status === "ready" && row.file_path && existsSync(row.file_path)) return Promise.resolve(row);
    if (row.status === "unsupported") return Promise.resolve(row);
    if (!extracting.has(trackId)) {
      db.prepare("UPDATE subtitle_tracks SET status='working',updated_at=? WHERE id=?").run(now(), trackId);
      extracting.set(trackId, (async () => {
        await slot();
        try {
          if (row.origin === "embedded") await extractEmbedded(row);
          else if (row.origin === "sidecar") await convertSidecar(row);
          else if (row.origin === "external" && external && !(row.file_path && existsSync(row.file_path))) await external.fetchTrack(row, writeVtt);
        } catch (error) {
          log(`subtitle ${trackId} failed: ${error.message}`);
          db.prepare("UPDATE subtitle_tracks SET status='failed',error=?,updated_at=? WHERE id=?").run(String(error.message).slice(0, 200), now(), trackId);
        } finally { free(); extracting.delete(trackId); }
        return db.prepare("SELECT * FROM subtitle_tracks WHERE id=?").get(trackId);
      })());
    }
    return extracting.get(trackId);
  }

  return {
    syncEmbedded, syncSidecars, ensure, listRows, rowTrack, writeVtt,
    // Sidecar and online tracks belong to the item; embedded tracks belong to the current file.
    tracks: (assetId, sourceKey) => [...listRows(assetId, null), ...(sourceKey ? listRows(assetId, sourceKey) : [])].map(rowTrack),
    get: id => db.prepare("SELECT * FROM subtitle_tracks WHERE id=?").get(id),
    // Looks the same language up online when the file has none; one lookup per asset and language.
    async findExternal(assetId, sourceKey, language, query) {
      if (!external) return null;
      const exists = db.prepare("SELECT * FROM subtitle_tracks WHERE asset_id=? AND origin='external' AND language=?").get(assetId, language);
      if (exists) return exists;
      const found = await external.search({ ...query, language }).catch(error => { log(`subtitle search failed: ${error.message}`); return []; });
      const best = found[0];
      if (!best) return null;
      const id = randomUUID(), timestamp = now();
      db.prepare("INSERT INTO subtitle_tracks (id,asset_id,source_key,origin,language,label,codec,external_id,forced,sdh,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, assetId, null, "external", language, `${languageLabel(language)} · OpenSubtitles`, "srt", String(best.fileId), 0, Number(Boolean(best.sdh)), "pending", timestamp, timestamp);
      return db.prepare("SELECT * FROM subtitle_tracks WHERE id=?").get(id);
    },
    async forget(assetId) {
      for (const row of listRows(assetId, null)) if (row.file_path?.startsWith(subtitlesDir)) await rm(row.file_path, { force: true });
      db.prepare("DELETE FROM subtitle_tracks WHERE asset_id=?").run(assetId);
    },
  };
}
