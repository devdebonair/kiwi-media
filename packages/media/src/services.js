import { existsSync } from "node:fs";
import { db } from "@kiwi/database";
import { createImageStore } from "./images.js";
import { createNyaa, createTorrentio } from "./indexers.js";
import { createOpenSubtitles } from "./opensubtitles.js";
import { getPlayback, getProvider } from "./settings.js";
import { createSourceService, describeSource } from "./sources.js";
import { createSubtitleService, languageLabel } from "./subtitles.js";
import { createTmdb } from "./tmdb.js";
import { createTorbox } from "./torbox.js";
import { chooseTracks, playbackPlan, probe } from "./tracks.js";

let media;

// One set of service objects per process. Tests can swap in fakes with setMedia().
export function getMedia() {
  if (media) return media;
  const tmdb = createTmdb(), torbox = createTorbox(), images = createImageStore(), opensubs = createOpenSubtitles();
  const sources = createSourceService({ torbox, indexers: [createTorrentio(), createNyaa()], log: message => console.log(`[media] ${message}`) });
  const subtitles = createSubtitleService({
    resolveInput: async assetId => {
      const asset = db.prepare("SELECT file_path FROM assets WHERE id=?").get(assetId);
      if (asset?.file_path && existsSync(asset.file_path)) return asset.file_path;
      return (await sources.streamUrl(assetId)).url;
    },
    external: {
      search: query => opensubs.available() ? opensubs.search(query) : [],
      fetchTrack: (row, write) => opensubs.fetchTrack(row, write),
    },
    log: message => console.log(`[media] ${message}`),
  });
  media = { tmdb, torbox, images, sources, subtitles, opensubs };
  return media;
}
export function setMedia(custom) { media = custom; }

// Tracks in your language order first, so the ones you are likely to want lead the menus.
const rankIn = (languages, code) => { const index = languages.indexOf(code); return index === -1 ? languages.length : index; };
export const orderAudio = audio => {
  const { audioLanguages } = getPlayback();
  // Browsers play the flagged default track, or the first one when none is flagged. That must survive the reordering below.
  // Several tracks are often flagged; the first one in the file is the one browsers pick.
  const first = (audio.filter(track => track.default)[0] || audio[0])?.position;
  return audio.map(track => ({
    position: track.position, language: track.language, codec: track.codec, default: track.position === first,
    label: [languageLabel(track.language), track.title && !new RegExp(`^${languageLabel(track.language)}`, "i").test(track.title) ? track.title : null, track.channels && track.channels !== 2 ? `${track.channels === 6 ? "5.1" : track.channels === 8 ? "7.1" : `${track.channels}ch`}` : null].filter(Boolean).join(" · "),
  })).sort((a, b) => rankIn(audioLanguages, a.language) - rankIn(audioLanguages, b.language) || a.position - b.position);
};
const orderSubtitles = tracks => {
  const { subtitleLanguages } = getPlayback();
  return [...tracks].sort((a, b) => rankIn(subtitleLanguages, a.language) - rankIn(subtitleLanguages, b.language) || Number(a.forced) - Number(b.forced) || Number(a.sdh) - Number(b.sdh) || String(a.label).localeCompare(String(b.label)));
};

const sourceKeyOf = prepared => prepared.origin === "local" ? "local" : prepared.sourceId;

// Everything the player needs to start: how to fetch the file, and the audio and subtitle tracks with the chosen defaults.
export function describePrepared(assetId, prepared) {
  const { subtitles } = getMedia();
  const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
  const key = sourceKeyOf(prepared);
  if (prepared.info) subtitles.syncEmbedded(assetId, key, prepared.info);
  if (prepared.origin === "local") subtitles.syncSidecars(assetId, asset.file_path).catch(() => {});
  const tracks = subtitles.tracks(assetId, key);
  const chosenSubtitle = prepared.chosen?.subtitle ? tracks.find(track => track.origin === "embedded" && subtitles.listRows(assetId, key).find(row => row.id === track.id)?.stream_index === prepared.chosen.subtitle.index) : null;
  const source = prepared.sourceId ? db.prepare("SELECT * FROM playback_sources WHERE id=?").get(prepared.sourceId) : null;
  return {
    status: "ready", origin: prepared.origin, source: source ? describeSource(source) : null, durationMs: prepared.info?.durationMs || asset.duration_ms, container: prepared.info?.container || null, video: prepared.info?.video ? { codec: prepared.info.video.codec, width: prepared.info.video.width, height: prepared.info.video.height } : null,
    playback: prepared.plan, audio: orderAudio(prepared.info?.audio || []),
    subtitles: orderSubtitles(tracks), chosen: { audioPosition: prepared.chosen?.audio?.position ?? null, subtitleId: chosenSubtitle?.id ?? null, subtitleReason: prepared.chosen?.subtitleReason ?? null },
    needsExternalSubtitles: Boolean(prepared.chosen?.needsExternalSubtitles), onlineSubtitles: getProvider("opensubtitles").configured,
  };
}

// For any local video (including home videos): list its tracks without changing how it plays.
export async function describeLocalTracks(assetId, { caps = [] } = {}) {
  const asset = db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
  if (!asset?.file_path || !existsSync(asset.file_path)) return null;
  const info = await probe(asset.file_path);
  const chosen = chooseTracks(info, getPlayback());
  return describePrepared(assetId, { origin: "local", info, chosen, plan: playbackPlan(info, chosen, { caps }) });
}
