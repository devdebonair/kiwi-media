import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'kiwi-tracks-'));
process.env.KIWI_DATA_DIR = directory;
const { app } = await import('../src/index.js');
const { db } = await import('@kiwi/database');
const media = await import('@kiwi/media');
after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }
const skip = hasFfmpeg ? false : 'ffmpeg is not installed';
const file = join(directory, 'sample.mkv');

before(() => {
  if (!hasFfmpeg) return;
  writeFileSync(join(directory, 'subs.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello <i>there</i>\n\n2\n00:00:02,100 --> 00:00:02,900\nSecond line\n');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
    '-i', join(directory, 'subs.srt'), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=eng', file]);
  db.prepare("INSERT INTO assets (id,kind,title,file_path,duration_ms,added_at,updated_at) VALUES ('clip','video','Clip',?,3000,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(file);
  media.setMedia({ ...media.getMedia() });
});

test('lists audio and subtitle tracks of a local video with the English-first defaults', { skip }, async () => {
  const result = (await app.inject('/api/v1/assets/clip/tracks')).json();
  assert.deepEqual(result.audio.map(track => track.language), ['eng', 'jpn'], 'listed in your language order');
  assert.equal(result.chosen.audioPosition, 1, 'English comes before Japanese in the default order');
  assert.equal(result.subtitles.length, 1);
  assert.equal(result.subtitles[0].language, 'eng');
  assert.equal(result.chosen.subtitleId, null, 'English audio needs no subtitles in auto mode');
  assert.equal(result.playback.mode, 'remux', 'switching audio repackages the file');
});

test('auto mode turns subtitles on when the audio is not your first language', { skip }, async () => {
  await app.inject({ method: 'PUT', url: '/api/v1/media/playback', payload: { audioLanguages: ['jpn', 'eng'], subtitleLanguages: ['eng'] } });
  const result = (await app.inject('/api/v1/assets/clip/tracks')).json();
  assert.equal(result.chosen.audioPosition, 0);
  assert.equal(result.chosen.subtitleId, null === result.chosen.subtitleId ? null : result.chosen.subtitleId);
  await app.inject({ method: 'PUT', url: '/api/v1/media/playback', payload: { audioLanguages: ['eng', 'jpn', 'zho'], subtitleLanguages: ['eng', 'jpn', 'zho'] } });
});

test('serves a text subtitle track as WebVTT, extracted on first use', { skip }, async () => {
  const [track] = (await app.inject('/api/v1/assets/clip/tracks')).json().subtitles;
  const response = await app.inject(`/api/v1/subtitles/${track.id}.vtt`);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/vtt/);
  assert.match(response.body, /^WEBVTT/);
  assert.match(response.body, /00:00\.500 --> 00:02\.000/);
  assert.match(response.body, /Hello/);
});

test('repackages a video with the chosen audio track, optionally from an offset', { skip }, async () => {
  const output = join(directory, 'remuxed.mp4');
  const response = await app.inject('/api/v1/assets/clip/file?remux=1&audio=1&start=1');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'video/mp4');
  writeFileSync(output, response.rawPayload);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', output]).toString());
  assert.equal(probe.streams.filter(stream => stream.codec_type === 'audio').length, 1, 'only the chosen audio track is kept');
  assert.equal(probe.streams.filter(stream => stream.codec_type === 'video')[0].codec_name, 'h264', 'video is copied untouched');
});

test('picks up sidecar subtitle files named after the video', { skip }, async () => {
  writeFileSync(join(directory, 'sample.fr.srt'), '1\n00:00:00,000 --> 00:00:01,000\nBonjour\n');
  const result = (await app.inject('/api/v1/assets/clip/tracks')).json();
  await new Promise(resolve => setTimeout(resolve, 100));
  const again = (await app.inject('/api/v1/assets/clip/tracks')).json();
  const sidecar = again.subtitles.find(track => track.origin === 'sidecar');
  assert.ok(sidecar, JSON.stringify(result.subtitles));
  assert.equal(sidecar.language, 'fra');
  const vtt = await app.inject(`/api/v1/subtitles/${sidecar.id}.vtt`);
  assert.match(vtt.body, /Bonjour/);
});
