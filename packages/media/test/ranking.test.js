import test from "node:test";
import assert from "node:assert/strict";
import { rankCandidates, matchTarget } from "../src/ranking.js";
import { parseRelease } from "../src/release.js";

const baseRules = {
  preferredResolution: 1080, minResolution: 480, maxResolution: 2160, directPlay: true, allowHdr: false, maxGbPerHour: 12, requireCached: true,
  excludeTerms: ["cam", "hdcam", "telesync"], preferGroups: [], avoidGroups: [], avoidHardcodedSubs: true,
  anime: { preferDualAudio: true, preferGroups: ["SubsPlease"], allowBatches: true },
};
const playback = { audioLanguages: ["eng", "jpn", "zho"], subtitleLanguages: ["eng", "jpn", "zho"], subtitleMode: "auto" };
const candidate = (releaseName, extra = {}) => ({ infoHash: releaseName.slice(0, 8), releaseName, fileName: releaseName, cached: true, seeders: 10, idBased: true, ...extra });
const show = { runtimeMin: 45, originalLanguage: "eng", names: ["Some Show"] };
const episode = { type: "episode", season: 1, episode: 2 };
const best = (candidates, context) => rankCandidates(candidates, { rules: baseRules, playback, ...context }).accepted.map(item => item.releaseName);

test("prefers 1080p H.264 web releases that play directly over 4K HDR remuxes", () => {
  const order = best([
    candidate("Some.Show.S01E02.2160p.WEB-DL.DV.HDR.H265-GRP", { size: 6e9 }),
    candidate("Some.Show.S01E02.1080p.WEB-DL.H264-GRP", { size: 2e9 }),
    candidate("Some.Show.S01E02.720p.HDTV.x264-GRP", { size: 1e9 }),
  ], { title: show, target: episode });
  assert.equal(order[0], "Some.Show.S01E02.1080p.WEB-DL.H264-GRP");
  assert.equal(order.at(-1), "Some.Show.S01E02.2160p.WEB-DL.DV.HDR.H265-GRP");
});

test("a cached release beats a nicer one that is not cached, and uncached are rejected by default", () => {
  const rules = { ...baseRules, requireCached: false };
  const { accepted, rejected } = rankCandidates([
    candidate("Some.Show.S01E02.2160p.BluRay.x264-AAA", { cached: false, seeders: 400 }),
    candidate("Some.Show.S01E02.720p.WEB.h264-BBB", { cached: true }),
  ], { rules, playback, title: show, target: episode });
  assert.equal(accepted[0].releaseName, "Some.Show.S01E02.720p.WEB.h264-BBB");
  const strict = rankCandidates([candidate("Some.Show.S01E02.1080p.WEB.h264-X", { cached: false })], { rules: baseRules, playback, title: show, target: episode });
  assert.equal(strict.rejected[0].rejected, "not cached on TorBox");
});

test("rejects cams, wrong episodes, foreign-only audio, and oversized files", () => {
  const { accepted, rejected } = rankCandidates([
    candidate("Some.Show.S01E02.HDCAM.x264"),
    candidate("Some.Show.S01E03.1080p.WEB.h264-X"),
    candidate("Some.Show.S01E02.1080p.WEB.h264.RUS-X"),
    candidate("Some.Show.S01E02.1080p.WEB.h264-HUGE", { size: 60e9 }),
    candidate("Some.Show.S01E02.1080p.WEB.h264-OK", { size: 2e9 }),
  ], { rules: baseRules, playback, title: show, target: episode });
  assert.deepEqual(accepted.map(item => item.releaseName), ["Some.Show.S01E02.1080p.WEB.h264-OK"]);
  assert.equal(rejected.length, 4);
});

test("season packs satisfy an episode but rank below a direct episode release", () => {
  const { accepted } = rankCandidates([
    candidate("Some.Show.S01.1080p.WEB-DL.H264-PACK", { size: 30e9 }),
    candidate("Some.Show.S01E02.1080p.WEB-DL.H264-SINGLE", { size: 2e9 }),
  ], { rules: baseRules, playback, title: show, target: episode });
  assert.equal(accepted[0].releaseName.endsWith("SINGLE"), true);
  assert.equal(accepted[1].match.needsFile, true);
});

test("anime: dual audio wins, then Japanese with confirmed subtitles, matched by absolute number", () => {
  const anime = { ...show, isAnime: true, originalLanguage: "jpn", names: ["Frieren: Beyond Journey's End", "Sousou no Frieren"], runtimeMin: 24 };
  const target = { type: "episode", season: 1, episode: 12, absolute: 12, isAnime: true };
  const order = best([
    candidate("[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv", { size: 1.4e9, idBased: false }),
    candidate("[Judas] Sousou no Frieren - 12 [1080p][Dual-Audio]", { size: 1.4e9, idBased: false }),
    candidate("[Group] Sousou no Frieren - 13 (1080p)", { idBased: false }),
    candidate("[Other] Totally Different Show - 12 (1080p)", { idBased: false }),
  ], { title: anime, target });
  assert.deepEqual(order, ["[Judas] Sousou no Frieren - 12 [1080p][Dual-Audio]", "[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv"]);
});

test("anime batches cover episodes by range and can be turned off", () => {
  const target = { type: "episode", season: 1, episode: 5, absolute: 5, isAnime: true };
  const parsed = parseRelease("[Group] Anime Title (BD 1080p) Batch 01-24");
  assert.equal(matchTarget(parsed, target, { idBased: true }).kind, "batch");
  assert.equal(matchTarget(parsed, target, { idBased: true, rules: { anime: { allowBatches: false } } }).ok, false);
});

test("movies match by year and reject episode releases", () => {
  const movie = { runtimeMin: 120, originalLanguage: "eng", year: 1999, names: ["The Matrix"] };
  const { accepted, rejected } = rankCandidates([
    candidate("The.Matrix.1999.1080p.BluRay.x264-GRP", { size: 9e9 }),
    candidate("The.Matrix.2003.1080p.BluRay.x264-GRP", { size: 9e9 }),
    candidate("The.Matrix.S01E01.1080p.WEB.x264-GRP"),
  ], { rules: baseRules, playback, title: movie, target: { type: "movie" } });
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 2);
});

test("explains the score", () => {
  const { accepted } = rankCandidates([candidate("Some.Show.S01E02.1080p.WEB-DL.H264-GRP", { size: 2e9 })], { rules: baseRules, playback, title: show, target: episode });
  assert.ok(accepted[0].reasons.some(item => item.label === "instant on TorBox"));
  assert.ok(accepted[0].reasons.some(item => item.label === "1080p"));
});

test("anime with an alternate season split only matches packs for that season", () => {
  const anime = { runtimeMin: 25, originalLanguage: "jpn", isAnime: true, names: ["Frieren: Beyond Journey's End", "Sousou no Frieren"] };
  const target = { type: "episode", season: 1, episode: 33, absolute: 33, isAnime: true, aliases: [{ season: 2, episode: 5 }] };
  const { accepted, rejected } = rankCandidates([
    candidate("[Judas] Sousou no Frieren (Season 01) [BD 1080p][HEVC x265 10bit]", { idBased: false }),
    candidate("[Judas] Sousou no Frieren (Season 02) [1080p][HEVC x265 10bit][Dual-Audio]", { idBased: false }),
    candidate("[SubsPlease] Sousou no Frieren S2 - 05 (1080p) [6AAEC79A].mkv", { idBased: false }),
  ], { rules: baseRules, playback, title: anime, target });
  assert.deepEqual(accepted.map(item => item.releaseName).sort(), ["[Judas] Sousou no Frieren (Season 02) [1080p][HEVC x265 10bit][Dual-Audio]", "[SubsPlease] Sousou no Frieren S2 - 05 (1080p) [6AAEC79A].mkv"].sort());
  assert.equal(rejected.length, 1);
});
