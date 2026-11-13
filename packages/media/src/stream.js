import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Where a repackaged stream starts. Copied video can only begin on a keyframe, which is usually a second or more before the asked-for time, while
// audio is cut exactly there. MP4 cannot leave a hole at the start of a track, so the muxer stretched the first
// audio frame over the gap; browsers play audio frames back to back, so the sound ran ahead of the picture by
// up to the distance between keyframes. So the stream starts on the keyframe itself, audio is read from the same
// place, and a little silence leads the audio so it is never the later track. `origin` is the moment of the movie
// the stream's time 0 shows, for the player to map its clock back onto the movie.
const LEAD = 0.3;          // seconds of silence before the first picture; more than any B-frame reordering delay
const RATE = 48_000;       // audio is resampled to this, so the lead can be counted in samples
const PRIMING = 1024;      // the AAC encoder starts every stream with one frame of priming samples
// ffmpeg seeks this much earlier when the video reorders frames (fftools' "dts heuristic"); added back so the
// seek lands on the keyframe that was found.
const DTS_HEURISTIC = 3 / 23;

// The keyframe a seek to `start` lands on, and whether the video reorders frames.
export function probeKeyframe(input, start, { timeoutMs = 15_000 } = {}) {
  return new Promise(resolve => {
    execFile("ffprobe", ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${start}%+#1`, "-show_entries", "packet=pts_time:stream=has_b_frames", "-of", "json", input],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        try {
          const body = JSON.parse(stdout);
          const time = Number(body.packets?.[0]?.pts_time);
          resolve(Number.isFinite(time) ? { time, reorders: Number(body.streams?.[0]?.has_b_frames) > 0 } : null);
        } catch { resolve(null); }
      });
  });
}

// How to cut a stream that should start at `start` seconds, and the movie time its time 0 will show.
export async function planStart({ input, start = 0, video = "copy", probe = probeKeyframe }) {
  // `at`: where the first picture is, in seconds after the seek point; the silence starts LEAD before it.
  const padded = (seek, accurate, at, pictureTime) => ({ seek, accurate, firstPts: Math.round((at - LEAD) * RATE), origin: pictureTime - LEAD - PRIMING / RATE });
  if (!(start > 0)) return padded(0, true, 0, 0);
  // Re-encoded video is decoded and cut exactly where asked, like the audio.
  if (video !== "copy") return padded(start, true, 0, start);
  const keyframe = await probe(input, start);
  // Without the keyframe, cut the old way: the audio may run early by the distance to the keyframe.
  if (!keyframe) return { seek: start, accurate: true, firstPts: null, origin: start };
  const seek = keyframe.time + (keyframe.reorders ? DTS_HEURISTIC + 0.005 : 0.001);
  return padded(seek, false, keyframe.time - seek, keyframe.time);
}

function inputArgs(input, { seek, accurate }, audioPosition) {
  const args = ["-nostdin", "-v", "error"];
  if (/^https?:/i.test(input)) args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-user_agent", "Kiwi/1.0");
  if (seek > 0) args.push("-ss", seek.toFixed(3), ...(accurate ? [] : ["-noaccurate_seek"]));
  return [...args, "-i", input, "-map", "0:v:0", "-map", `0:a:${audioPosition}?`];
}

// Stereo AAC, padded with silence up to the planned start and kept continuous: gaps in the source's audio are
// filled rather than closed up, so the sound cannot slowly drift ahead of the picture either.
function audioArgs({ firstPts }) {
  const resample = firstPts == null ? `aresample=${RATE}:async=1` : `aresample=${RATE}:async=1:first_pts=${firstPts}`;
  return ["-af", resample, "-c:a", "aac", "-ac", "2", "-b:a", "192k"];
}

function codecArgs({ video, videoCodec, maxHeight, keyframeSeconds }) {
  if (video === "copy") return ["-c:v", "copy", ...(videoCodec === "hevc" ? ["-tag:v", "hvc1"] : [])];
  const filter = [maxHeight ? `scale=-2:'min(${maxHeight},ih)'` : "scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p"].join(",");
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-vf", filter, ...(keyframeSeconds ? ["-force_key_frames", `expr:gte(t,n_forced*${keyframeSeconds})`] : [])];
}

// Repackages a video for the browser as it plays: the chosen audio track (re-encoded to AAC), and the
// video copied untouched or re-encoded to H.264 when the browser cannot decode the original.
// Output is fragmented MP4 piped as it is made, so playback starts at once; seeking restarts it at a new offset.
export function startRemux({ input, plan = { seek: 0, accurate: true, firstPts: null }, audioPosition = 0, video = "copy", videoCodec, maxHeight } = {}) {
  const args = [...inputArgs(input, plan, audioPosition), "-sn", "-dn", "-map_chapters", "-1", ...codecArgs({ video, videoCodec, maxHeight }),
    ...audioArgs(plan), "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
  return { child, stream: child.stdout, errors: () => errors, stop: () => { if (!child.killed) child.kill("SIGKILL"); } };
}

// The HLS playlist grows while ffmpeg works (an EVENT playlist). Without a start point, AVPlayer joins such a playlist
// a few segments from its newest one, the way it joins a live broadcast. Repackaging runs far faster than playback,
// so that skipped minutes of the video (from the resume point on) and the episode seemed to end early. Every stream
// is cut to begin where it should be watched from, so players are told to start at its first segment.
export function startAtBeginning(playlist) {
  if (/^#EXT-X-START:/m.test(playlist)) return playlist;
  return playlist.replace(/^#EXTM3U[^\S\n]*\r?\n/, line => `${line}#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n`);
}

// Apple browsers (every browser on iOS) refuse a progressive stream that cannot be range-requested, so they
// get the same repackaged video as HLS: ffmpeg writes a growing playlist and fragments into a session folder,
// served to the player until it has been idle for a while.
export function createHlsSessions({ directory, idleMs = 90_000, max = 4 } = {}) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const sessions = new Map();
  // Safari asks for the same stream more than once (and reloads a growing playlist from its original address),
  // so identical requests share one session instead of each starting a new encode.
  const byKey = new Map();
  const close = id => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    if (session.key && byKey.get(session.key) === id) byKey.delete(session.key);
    clearInterval(session.timer);
    if (!session.child.killed) session.child.kill("SIGKILL");
    rmSync(session.dir, { recursive: true, force: true });
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  return {
    async start({ input, plan = { seek: 0, accurate: true, firstPts: null }, audioPosition = 0, video = "copy", videoCodec, key }) {
      const existing = key && sessions.get(byKey.get(key));
      if (existing) { existing.touched = Date.now(); await existing.ready; return { id: byKey.get(key) }; }
      // Only a few at a time: a new one pushes out the one idle the longest.
      while (sessions.size >= max) close([...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0][0]);
      const id = randomBytes(12).toString("hex");
      const dir = join(directory, id);
      mkdirSync(dir, { recursive: true });
      const args = [...inputArgs(input, plan, audioPosition), "-sn", "-dn", "-map_chapters", "-1", ...codecArgs({ video, videoCodec, keyframeSeconds: 4 }),
        ...audioArgs(plan),
        "-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", join(dir, "seg%05d.m4s"), "-hls_flags", "independent_segments+temp_file", join(dir, "index.m3u8")];
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let errors = "", exited = false;
      child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
      child.once("close", () => { exited = true; });
      const session = { dir, child, key, touched: Date.now(), timer: null, ready: null };
      session.timer = setInterval(() => { if (Date.now() - session.touched > idleMs) close(id); }, 10_000);
      session.timer.unref?.();
      sessions.set(id, session);
      if (key) byKey.set(key, id);
      // Ready once the first fragment is listed.
      session.ready = (async () => {
        for (let tries = 0; tries < 300; tries++) {
          const playlist = join(dir, "index.m3u8");
          if (existsSync(playlist) && /#EXTINF/.test(readFileSync(playlist, "utf8"))) return;
          if (exited) { close(id); throw new Error(errors.trim().split("\n").pop() || "The stream could not be prepared."); }
          await wait(100);
        }
        close(id);
        throw new Error("The stream took too long to start.");
      })();
      await session.ready;
      return { id };
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
