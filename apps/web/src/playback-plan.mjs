// Decides whether a file can go to the browser untouched or must be repackaged on the server, and with what.
// Browsers only play the container's default audio track and a few audio codecs; some video needs re-encoding.
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "flac", "vorbis"]);

export function planPlayback(info, { audioPosition = null, transcode = false } = {}) {
  const tracks = info?.audio || [];
  // The track a browser plays on its own: the first flagged one in file order, else the first track.
  const inFileOrder = [...tracks].sort((a, b) => a.position - b.position);
  const defaultAudio = (inFileOrder.find(track => track.default) || inFileOrder[0])?.position ?? 0;
  const audio = audioPosition ?? defaultAudio;
  const track = tracks.find(item => item.position === audio);
  const video = transcode || info?.playback?.video === "transcode" ? "transcode" : "copy";
  const remux = Boolean(info) && tracks.length > 0 && (video === "transcode" || audio !== defaultAudio || Boolean(track && !BROWSER_AUDIO.has(track.codec)));
  return { remux, audio, defaultAudio, video, hevc: info?.video?.codec === "hevc" };
}

export function remuxUrl(base, plan, start) {
  return `${base}?remux=1&audio=${plan.audio}&video=${plan.video}${plan.hevc && plan.video === "copy" ? "&codec=hevc" : ""}&start=${Math.max(0, Math.floor(start))}`;
}
