// Decides whether a file can go to the browser untouched or must be repackaged on the server, and with what.
// Browsers only play the container's default audio track and a few audio codecs; some video needs re-encoding.
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "flac", "vorbis"]);

// What the browser can take as it is. Apple browsers (every browser on iOS) cannot play Matroska at all and
// need repackaged video as HLS; Chromium plays Matroska and WebM; Firefox plays WebM only.
export function detectEnvironment(nav = typeof navigator === "undefined" ? null : navigator) {
  if (!nav) return {};
  const agent = nav.userAgent || "";
  const ios = /iP(hone|ad|od)/.test(agent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const safari = /Safari\//.test(agent) && /Apple/.test(nav.vendor || "") && !/Chrome|Chromium|Edg|OPR/.test(agent);
  return { apple: ios || safari, chromium: !ios && /Chrome|Chromium|Edg|OPR/.test(agent) };
}

const containerPlays = (container, env) => {
  if (!container) return true;
  if (/mp4|mov/.test(container)) return true;
  if (/matroska/.test(container)) return Boolean(env.chromium);
  if (/webm/.test(container)) return !env.apple;
  return false;
};

export function planPlayback(info, { audioPosition = null, transcode = false, env = { chromium: true } } = {}) {
  const tracks = info?.audio || [];
  // The track a browser plays on its own: the first flagged one in file order, else the first track.
  const inFileOrder = [...tracks].sort((a, b) => a.position - b.position);
  const defaultAudio = (inFileOrder.find(track => track.default) || inFileOrder[0])?.position ?? 0;
  const audio = audioPosition ?? defaultAudio;
  const track = tracks.find(item => item.position === audio);
  const video = transcode || info?.playback?.video === "transcode" ? "transcode" : "copy";
  const playable = containerPlays(info?.container, env);
  const remux = Boolean(info) && tracks.length > 0 && (video === "transcode" || !playable || audio !== defaultAudio || Boolean(track && !BROWSER_AUDIO.has(track.codec)));
  return { remux, audio, defaultAudio, video, hevc: info?.video?.codec === "hevc", hls: Boolean(env.apple) };
}

export function remuxUrl(base, plan, start) {
  return `${base}?remux=1&audio=${plan.audio}&video=${plan.video}${plan.hevc && plan.video === "copy" ? "&codec=hevc" : ""}${plan.hls ? "&hls=1" : ""}&start=${Math.max(0, Math.floor(start))}`;
}
