import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

// A single encoder keeps large libraries from exhausting the host. Completed
// outputs are atomic and keyed by source identity so edits invalidate the cache.
export function createPlaybackCache(directory, { onError = () => {} } = {}) {
  const jobs = new Map();
  let running = false;
  function fileFor(source) {
    const stat = statSync(source);
    const key = createHash('sha256').update(JSON.stringify([source, stat.size, stat.mtimeMs, 'h264-v1'])).digest('hex');
    return join(directory, `${key}.mp4`);
  }
  function prepare(source) {
    const file = fileFor(source);
    if (existsSync(file)) return { status: 'ready' };
    if (jobs.has(file)) return { status: jobs.get(file) };
    if (running) return { status: 'busy' };
    mkdirSync(directory, { recursive: true });
    running = true;
    jobs.set(file, 'preparing');
    const temporary = `${file}.partial.mp4`;
    const exec = promisify(execFile);
    const options = { timeout: 2 * 60 * 60 * 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 };
    const convert = async () => {
      // FLV/MKV can contain browser-compatible codecs in an unsupported container.
      // Repackage those streams without a slow, lossy video encode.
      try {
        const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', source], { ...options, timeout: 30_000 });
        const streams = JSON.parse(stdout).streams;
        const video = streams.find(stream => stream.codec_type === 'video');
        const audio = streams.find(stream => stream.codec_type === 'audio');
        if (video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && (!audio || audio.codec_name === 'aac')) {
          await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
            '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-sn', '-dn',
            '-movflags', '+faststart', temporary], options);
          return;
        }
      } catch { /* If probing or repackaging fails, try decoding and encoding. */ }
      await exec('ffmpeg', [
      '-nostdin', '-v', 'error', '-y', '-threads', '2', '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-ac', '2',
      '-b:a', '160k', '-movflags', '+faststart', temporary,
    ], options);
    };
    convert()
      .then(() => rename(temporary, file))
      .then(() => jobs.delete(file))
      .catch(async error => {
        onError(error);
        jobs.set(file, 'failed');
        await rm(temporary, { force: true }).catch(() => {});
        const timer = setTimeout(() => jobs.delete(file), 60_000);
        timer.unref();
      }).finally(() => { running = false; });
    return { status: 'preparing' };
  }
  return { prepare, fileFor };
}
