import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPlaybackCache } from '../src/playback.js';
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('converts MPEG-4/PCM to cached H.264/AAC and invalidates changed sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiwi-playback-'));
  try {
    const source = join(dir, 'legacy.avi');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x96:d=0.5', '-f', 'lavfi', '-i', 'sine=duration=0.5', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', source]);
    const cache = createPlaybackCache(join(dir, 'cache'));
    assert.equal(cache.prepare(source).status, 'preparing');
    assert.equal(cache.prepare(source).status, 'preparing');
    for (let n = 0; n < 100 && cache.prepare(source).status === 'preparing'; n++) await sleep(100);
    assert.equal(cache.prepare(source).status, 'ready');
    const output = cache.fileFor(source);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output]);
    const { streams } = JSON.parse(stdout);
    assert.equal(streams[0].codec_name, 'h264');
    assert.equal(streams[0].pix_fmt, 'yuv420p');
    assert.equal(streams[0].width / streams[0].height, 64 / 96);
    assert.equal(streams[1].codec_name, 'aac');
    await writeFile(source, 'changed');
    assert.notEqual(cache.fileFor(source), output);
    assert.equal(cache.prepare(source).status, 'preparing');
    for (let n = 0; n < 100 && cache.prepare(source).status === 'preparing'; n++) await sleep(100);
    assert.equal(cache.prepare(source).status, 'failed');
    assert.equal(existsSync(cache.fileFor(source)), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('repackages H.264/AAC FLV without re-encoding video packets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiwi-remux-'));
  try {
    const source = join(dir, 'legacy.flv');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x96:d=0.5', '-f', 'lavfi', '-i', 'sine=duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const cache = createPlaybackCache(join(dir, 'cache'));
    assert.equal(cache.prepare(source).status, 'preparing');
    for (let n = 0; n < 100 && cache.prepare(source).status === 'preparing'; n++) await sleep(100);
    assert.equal(cache.prepare(source).status, 'ready');
    const packets = async file => JSON.parse((await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', file])).stdout).packets;
    assert.deepEqual(await packets(cache.fileFor(source)), await packets(source));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
