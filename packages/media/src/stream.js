import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Repackages a video for the browser as it plays: the chosen audio track (re-encoded to AAC), and the
// video copied untouched or re-encoded to H.264 when the browser cannot decode the original.
// Output is fragmented MP4 piped as it is made, so playback starts at once; seeking restarts it at a new offset.
function inputArgs(input, start, audioPosition) {
  const args = ["-nostdin", "-v", "error"];
  if (/^https?:/i.test(input)) args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-user_agent", "Kiwi/1.0");
  if (start > 0) args.push("-ss", String(start));
  return [...args, "-i", input, "-map", "0:v:0", "-map", `0:a:${audioPosition}?`];
}

function codecArgs({ video, videoCodec, maxHeight, keyframeSeconds }) {
  if (video === "copy") return ["-c:v", "copy", ...(videoCodec === "hevc" ? ["-tag:v", "hvc1"] : [])];
  const filter = [maxHeight ? `scale=-2:'min(${maxHeight},ih)'` : "scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p"].join(",");
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-vf", filter, ...(keyframeSeconds ? ["-force_key_frames", `expr:gte(t,n_forced*${keyframeSeconds})`] : [])];
}

// Repackages a video for the browser as it plays: the chosen audio track (re-encoded to AAC), and the
// video copied untouched or re-encoded to H.264 when the browser cannot decode the original.
// Output is fragmented MP4 piped as it is made, so playback starts at once; seeking restarts it at a new offset.
export function startRemux({ input, start = 0, audioPosition = 0, video = "copy", videoCodec, maxHeight } = {}) {
  const args = [...inputArgs(input, start, audioPosition), "-sn", "-dn", "-map_chapters", "-1", ...codecArgs({ video, videoCodec, maxHeight }),
    "-c:a", "aac", "-ac", "2", "-b:a", "192k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
  return { child, stream: child.stdout, errors: () => errors, stop: () => { if (!child.killed) child.kill("SIGKILL"); } };
}

// Apple browsers (every browser on iOS) refuse a progressive stream that cannot be range-requested, so they
// get the same repackaged video as HLS: ffmpeg writes a growing playlist and fragments into a session folder,
// served to the player until it has been idle for a while.
export function createHlsSessions({ directory, idleMs = 90_000, max = 4 } = {}) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const sessions = new Map();
  const close = id => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearInterval(session.timer);
    if (!session.child.killed) session.child.kill("SIGKILL");
    rmSync(session.dir, { recursive: true, force: true });
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  return {
    async start({ input, start = 0, audioPosition = 0, video = "copy", videoCodec }) {
      // Only a few at a time: a new one pushes out the one idle the longest.
      while (sessions.size >= max) close([...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0][0]);
      const id = randomBytes(12).toString("hex");
      const dir = join(directory, id);
      mkdirSync(dir, { recursive: true });
      const args = [...inputArgs(input, start, audioPosition), "-sn", "-dn", "-map_chapters", "-1", ...codecArgs({ video, videoCodec, keyframeSeconds: 4 }),
        "-c:a", "aac", "-ac", "2", "-b:a", "192k",
        "-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", join(dir, "seg%05d.m4s"), "-hls_flags", "independent_segments+temp_file", join(dir, "index.m3u8")];
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let errors = "", exited = false;
      child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
      child.once("close", () => { exited = true; });
      const session = { dir, child, touched: Date.now(), timer: null };
      session.timer = setInterval(() => { if (Date.now() - session.touched > idleMs) close(id); }, 10_000);
      session.timer.unref?.();
      sessions.set(id, session);
      // Ready once the first fragment is listed.
      for (let tries = 0; tries < 300; tries++) {
        const playlist = join(dir, "index.m3u8");
        if (existsSync(playlist) && /#EXTINF/.test(readFileSync(playlist, "utf8"))) return { id };
        if (exited) { close(id); throw new Error(errors.trim().split("\n").pop() || "The stream could not be prepared."); }
        await wait(100);
      }
      close(id);
      throw new Error("The stream took too long to start.");
    },
    // The file for a request, or null for an unknown session or name. Every request counts as activity.
    file(id, name) {
      const session = sessions.get(id);
      if (!session || !/^(index\.m3u8|init\.mp4|seg\d{5}\.m4s)$/.test(name)) return null;
      session.touched = Date.now();
      const path = join(session.dir, name);
      return existsSync(path) ? path : null;
    },
    get size() { return sessions.size; },
    closeAll() { for (const id of [...sessions.keys()]) close(id); },
  };
}
