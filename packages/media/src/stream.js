import { spawn } from "node:child_process";

// Repackages a video for the browser as it plays: the chosen audio track (re-encoded to AAC), and the
// video copied untouched or re-encoded to H.264 when the browser cannot decode the original.
// Output is fragmented MP4 piped as it is made, so playback starts at once; seeking restarts it at a new offset.
export function startRemux({ input, start = 0, audioPosition = 0, video = "copy", videoCodec, maxHeight } = {}) {
  const args = ["-nostdin", "-v", "error"];
  if (/^https?:/i.test(input)) args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-user_agent", "Kiwi/1.0");
  if (start > 0) args.push("-ss", String(start));
  args.push("-i", input, "-map", "0:v:0", "-map", `0:a:${audioPosition}?`, "-sn", "-dn", "-map_chapters", "-1");
  if (video === "copy") args.push("-c:v", "copy", ...(videoCodec === "hevc" ? ["-tag:v", "hvc1"] : []));
  else {
    const filter = [maxHeight ? `scale=-2:'min(${maxHeight},ih)'` : "scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p"].join(",");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-vf", filter);
  }
  args.push("-c:a", "aac", "-ac", "2", "-b:a", "192k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
  return { child, stream: child.stdout, errors: () => errors, stop: () => { if (!child.killed) child.kill("SIGKILL"); } };
}
