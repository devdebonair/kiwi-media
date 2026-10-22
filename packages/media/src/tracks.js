import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { iso3 } from "./tmdb.js";

const exec = promisify(execFile);

// Normalizes the many ways files label a language to the three-letter codes used in settings.
const LANGUAGE_NAMES = {
  eng: ["en", "eng", "english", "en-us", "en-gb", "english (us)", "english (uk)"], jpn: ["ja", "jpn", "jap", "japanese", "ja-jp", "日本語"],
  zho: ["zh", "zho", "chi", "chinese", "cmn", "yue", "mandarin", "cantonese", "zh-cn", "zh-tw", "zh-hk", "chs", "cht", "中文", "简体中文", "繁體中文"],
  kor: ["ko", "kor", "korean"], spa: ["es", "spa", "spanish", "castellano", "latino"], fra: ["fr", "fre", "fra", "french"], deu: ["de", "ger", "deu", "german"],
  ita: ["it", "ita", "italian"], por: ["pt", "por", "portuguese", "pt-br"], rus: ["ru", "rus", "russian"], ara: ["ar", "ara", "arabic"], hin: ["hi", "hin", "hindi"],
};
const byName = new Map(Object.entries(LANGUAGE_NAMES).flatMap(([code, names]) => names.map(name => [name, code])));
export function normalizeLanguage(...values) {
  for (const value of values) {
    const key = String(value || "").trim().toLowerCase();
    if (!key || key === "und" || key === "unk") continue;
    if (byName.has(key)) return byName.get(key);
    const word = key.split(/[\s\[\]()_/,-]+/).find(part => byName.has(part));
    if (word) return byName.get(word);
  }
  return null;
}

const TEXT_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "microdvd", "subviewer"]);
const COMMENTARY = /commentary|descriptive|audio description|isolated|karaoke/i;
const SIGNS_ONLY = /signs?\s*(?:&|and|\/)\s*songs?|forced|signs only/i;

export function describeStreams(probe) {
  const streams = probe.streams || [];
  const video = streams.find(stream => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  let audioPosition = 0, subtitlePosition = 0;
  const audio = streams.filter(stream => stream.codec_type === "audio").map(stream => ({
    index: stream.index, position: audioPosition++, codec: stream.codec_name, channels: stream.channels || null,
    language: normalizeLanguage(stream.tags?.language, stream.tags?.title), title: stream.tags?.title || null,
    default: stream.disposition?.default === 1, commentary: COMMENTARY.test(stream.tags?.title || ""),
  }));
  const subtitles = streams.filter(stream => stream.codec_type === "subtitle").map(stream => {
    const title = stream.tags?.title || "";
    return {
      index: stream.index, position: subtitlePosition++, codec: stream.codec_name, language: normalizeLanguage(stream.tags?.language, title), title: title || null,
      forced: stream.disposition?.forced === 1 || SIGNS_ONLY.test(title), sdh: /sdh|hearing|cc\b|closed/i.test(title) || stream.disposition?.hearing_impaired === 1,
      default: stream.disposition?.default === 1, text: TEXT_SUBTITLES.has(stream.codec_name),
    };
  });
  return {
    durationMs: Math.round(Number(probe.format?.duration || 0) * 1000) || null, container: probe.format?.format_name || null, bitRate: Number(probe.format?.bit_rate) || null,
    video: video ? { codec: video.codec_name, profile: video.profile || null, width: video.width, height: video.height, pixFmt: video.pix_fmt, bitDepth: /10/.test(video.pix_fmt || "") ? 10 : 8, hdr: /smpte2084|arib-std-b67/.test(video.color_transfer || "") } : null,
    audio, subtitles,
  };
}

export async function probe(input, { timeoutMs = 45_000 } = {}) {
  const args = ["-v", "error", "-print_format", "json", "-show_streams", "-show_format"];
  if (/^https?:/i.test(input)) args.push("-user_agent", "Kiwi/1.0", "-rw_timeout", "30000000");
  const { stdout } = await exec("ffprobe", [...args, input], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
  return describeStreams(JSON.parse(stdout));
}

// Picks the audio track and subtitle track to start with. Audio follows your language order. Subtitles
// are for the audio you cannot follow: in "auto" mode they appear only when the audio is not your first language.
export function chooseTracks(info, playback, { originalLanguage } = {}) {
  const languages = playback.audioLanguages, subtitleLanguages = playback.subtitleLanguages;
  const candidates = info.audio.filter(track => !track.commentary);
  const pool = candidates.length ? candidates : info.audio;
  let audio = null;
  for (const code of languages) {
    const matches = pool.filter(track => track.language === code);
    if (matches.length) { audio = matches.find(track => track.default) || matches.sort((a, b) => (b.channels || 0) - (a.channels || 0))[0]; break; }
  }
  // The show's own language is fine too (a Korean drama with subtitles). Untagged tracks are assumed usable.
  const original = originalLanguage && pool.find(track => track.language === iso3(originalLanguage) || track.language === originalLanguage);
  audio ||= original || pool.find(track => track.language === null && track.default) || pool.find(track => track.language === null) || null;
  // Only foreign tracks left: this release cannot be followed. (No audio at all is left to the player.)
  const foreignOnly = !audio && pool.length > 0;
  audio ||= pool.find(track => track.default) || pool[0] || null;

  const usable = info.subtitles.filter(track => track.text);
  const full = usable.filter(track => !track.forced);
  const rank = track => { const index = subtitleLanguages.indexOf(track.language); return index === -1 ? 99 : index; };
  const best = list => [...list].sort((a, b) => rank(a) - rank(b) || Number(a.sdh) - Number(b.sdh) || Number(b.default) - Number(a.default))[0] || null;
  const audioIsFirstChoice = audio?.language === languages[0];
  let subtitle = null, reason = "off";
  if (playback.subtitleMode === "always" || (playback.subtitleMode === "auto" && !audioIsFirstChoice && audio?.language !== null)) {
    const pick = best(full.filter(track => rank(track) < 99 && track.language !== audio?.language));
    if (pick) { subtitle = pick; reason = "for audio you may not follow"; }
  }
  if (!subtitle && playback.subtitleMode !== "off" && audioIsFirstChoice) {
    // English audio still benefits from forced subtitles for foreign dialogue.
    const forced = usable.find(track => track.forced && track.language === audio.language && !/signs?\s*(?:&|and|\/)\s*songs?/i.test(track.title || ""));
    if (forced) { subtitle = forced; reason = "forced subtitles"; }
  }
  const wantsSubtitles = playback.subtitleMode === "always" || (playback.subtitleMode === "auto" && !audioIsFirstChoice && audio?.language !== null);
  return { audio, subtitle, foreignOnly, subtitleReason: subtitle ? reason : null, needsExternalSubtitles: wantsSubtitles && !subtitle };
}

const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "flac", "vorbis"]);
// How the browser should receive the file: untouched, or repackaged with the chosen audio (and re-encoded video if needed).
export function playbackPlan(info, chosen, { caps = [] } = {}) {
  const video = info.video;
  // Browsers play the container's default audio; any other choice needs the file repackaged.
  const defaultAudio = info.audio.find(track => track.default) || info.audio[0];
  const wrongDefault = chosen.audio && defaultAudio && chosen.audio.position !== defaultAudio.position;
  const audioUnsupported = chosen.audio && !BROWSER_AUDIO.has(chosen.audio.codec);
  const videoUnsupported = video && (
    (video.codec === "hevc" && !caps.includes("hevc")) || (video.codec === "av1" && !caps.includes("av1")) ||
    (video.codec === "h264" && video.bitDepth === 10) || !["h264", "hevc", "av1", "vp9", "vp8"].includes(video.codec));
  if (!wrongDefault && !audioUnsupported && !videoUnsupported) return { mode: "direct" };
  return {
    mode: "remux", audioPosition: chosen.audio?.position ?? 0, video: videoUnsupported ? "transcode" : "copy",
    reason: [wrongDefault && "selected audio track", audioUnsupported && `${chosen.audio.codec} audio`, videoUnsupported && `${video.codec} video`].filter(Boolean).join(", "),
  };
}
