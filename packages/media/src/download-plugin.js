import { join } from "node:path";
import { db } from "@kiwi/database";
import { DownloadError, safeFilename } from "@kiwi/downloads";
import { getMedia } from "./services.js";

export const MEDIA_SCHEME = "kiwi-media://asset/";
export const MEDIA_DOWNLOADER_ID = "downloader-kiwi-media";
const pad = value => String(value).padStart(2, "0");
// "Show: The Subtitle" is written "Show - The Subtitle", the way media servers expect it.
const clean = value => safeFilename(String(value).replace(/:\s*/g, " - ").replace(/\s*[?*"<>|]+\s*/g, " ")).replace(/\s+/g, " ").replace(/[. ]+$/, "").trim();
const folder = clean;

// Plex-style layout so other media servers can read the folders as well:
//   Movies/Name (Year)/Name (Year).mkv     TV Shows/Name (Year)/Season 01/Name - S01E02 - Episode.mkv
export function libraryPath(asset, title, extension) {
  const show = folder(title.year ? `${title.title} (${title.year})` : title.title);
  if (title.type === "movie") return { dir: [show], filename: `${show}${extension}` };
  const episode = clean(`${title.title} - S${pad(asset.season_number)}E${pad(asset.episode_number)} - ${asset.title}`);
  return { dir: [show, asset.season_number === 0 ? "Specials" : `Season ${pad(asset.season_number)}`], filename: `${episode}${extension}` };
}

export const mediaDownloadPlugin = {
  id: "kiwi-media", name: "Kiwi catalog", hidden: true, description: "Saves streamed movies and episodes into your library.",
  fields: [], accepts: source => source.startsWith(MEDIA_SCHEME),
  async download(ctx) {
    const assetId = ctx.source.slice(MEDIA_SCHEME.length);
    const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
    const title = asset?.title_id && db.prepare("SELECT * FROM titles WHERE id=?").get(asset.title_id);
    if (!asset || !title) throw new DownloadError("That item no longer exists.");
    const { sources } = getMedia();
    ctx.progress({ title: title.type === "movie" ? title.title : `${title.title} S${pad(asset.season_number)}E${pad(asset.episode_number)}`, message: "Finding the best source" });
    let prepared;
    try { prepared = await sources.prepare(assetId); }
    catch (error) { throw new DownloadError(error.message); }
    if (prepared.origin === "local") throw new DownloadError("This item is already saved in your library.");
    const extension = (/\.[a-z0-9]{2,4}$/i.exec(prepared.fileName || "") || [".mkv"])[0].toLowerCase();
    const target = libraryPath(asset, title, extension);
    ctx.progress({ message: "Downloading" });
    // The link may have been issued a while ago; ask for a fresh one right before downloading.
    const { url } = await sources.streamUrl(assetId, { force: true });
    await ctx.http.download(url, { dir: join(ctx.workDir, ...target.dir), filename: target.filename, onProgress: ctx.progress });
    return {};
  },
};
