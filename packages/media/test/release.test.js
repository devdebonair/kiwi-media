import test from "node:test";
import assert from "node:assert/strict";
import { parseRelease, titleScore, normalizeTitle } from "../src/release.js";

const cases = [
  ["Game.of.Thrones.S01E01.Winter.Is.Coming.1080p.BluRay.x264-ROVERS", { title: "Game of Thrones", season: 1, episodes: [1], resolution: 1080, source: "bluray", codec: "h264", group: "ROVERS" }],
  ["Game of Thrones S01E01 Winter Is Coming REPACK 2160p MAX WEB-DL TrueHD 7 1 Atmos DV HDR H 265-Kitsune", { season: 1, episodes: [1], resolution: 2160, source: "web-dl", codec: "hevc", dolbyVision: true, repack: true }],
  ["The.Matrix.1999.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-EPSiLON", { title: "The Matrix", year: 1999, resolution: 2160, source: "remux", hdr: "hdr", codec: "hevc" }],
  ["Show.Name.S02E05E06.720p.HDTV.x264-LOL", { season: 2, episodes: [5, 6], source: "hdtv" }],
  ["Show.Name.S03E01-E03.1080p.WEB.H264-GLHF", { season: 3, episodes: [1, 2, 3] }],
  ["Show Name 1x07 720p", { season: 1, episodes: [7], resolution: 720 }],
  ["Show.Name.S04.Complete.1080p.BluRay.x265-RARBG", { seasonPack: true, season: 4, complete: true, codec: "hevc" }],
  ["Show Name Season 1-3 1080p", { seasonPack: true, seasons: [1, 2, 3] }],
  ["[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv", { title: "Sousou no Frieren", absolute: 12, resolution: 1080, group: "SubsPlease", episodes: [] }],
  ["[Erai-raws] One Piece - 1085 [1080p][Multiple Subtitle][ABC]", { title: "One Piece", absolute: 1085, resolution: 1080, group: "Erai-raws", multiSubs: true }],
  ["[Judas] Attack on Titan - S04E28 [1080p][HEVC x265 10bit][Dual-Audio]", { season: 4, episodes: [28], bitDepth: 10, dualAudio: true, codec: "hevc" }],
  ["[Group] Anime Title - 05v2 [BD 1080p Hi10P FLAC]", { absolute: 5, bitDepth: 10, resolution: 1080 }],
  ["[Group] Anime Title (BD 1080p) Batch 01-24", { complete: true, batch: [1, 24] }],
  ["Movie.Name.2023.1080p.WEBRip.x264.AAC5.1-RARBG", { title: "Movie Name", year: 2023, source: "webrip", resolution: 1080, audio: ["aac"] }],
  ["Movie Name 2023 HDCAM x264", { source: "cam" }],
  ["Movie.Name.2022.HDTS.720p", { source: "telesync" }],
  ["Movie.Name.2021.1080p.BluRay.x264.Dual.Audio.ENG.JPN", { dualAudio: true }],
  ["Show.S01E01.1080p.WEB-DL.RUS", { languages: ["rus"] }],
  ["Show.S01E01.1080p.WEB-DL.VOSTFR", { languages: [], subLanguages: ["fra"] }],
  ["Show.S01E01.1080p.WEB-DL.KORSUB.x264", { hardSubs: true }],
];

for (const [name, expected] of cases) {
  test(`parses ${name}`, () => {
    const parsed = parseRelease(name);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(parsed[key], value, `${key} of ${name}: ${JSON.stringify(parsed)}`);
  });
}

test("multi-subtitle releases are not treated as multi-audio", () => {
  const parsed = parseRelease("[Erai-raws] Show - 03 [1080p][Multi-Subs]");
  assert.equal(parsed.dualAudio, false);
  assert.equal(parsed.multiSubs, true);
});

test("title matching tolerates punctuation and articles", () => {
  assert.equal(normalizeTitle("Frieren: Beyond Journey's End"), "frieren beyond journeys end");
  assert.ok(titleScore("Frieren Beyond Journeys End", ["Frieren: Beyond Journey's End"]) > 0.95);
  assert.ok(titleScore("Sousou no Frieren", ["Frieren: Beyond Journey's End", "Sousou no Frieren"]) > 0.95);
  assert.ok(titleScore("Naruto Shippuden", ["Boruto"]) < 0.2);
});

test("anime season labels: 'S2 - 05' and '2nd Season - 05' are episode 5 of season 2", () => {
  for (const name of ["[SubsPlease] Sousou no Frieren S2 - 05 (1080p) [6AAEC79A].mkv", "[SubsPlease] Show Name 2nd Season - 05 (1080p).mkv"]) {
    const parsed = parseRelease(name);
    assert.equal(parsed.season, 2, name);
    assert.deepEqual(parsed.episodes, [5], name);
    assert.equal(parsed.seasonPack, false, name);
  }
});
