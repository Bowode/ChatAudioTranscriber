import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAudioFormat, parseWav, transcribe, normalizeToWav16kMonoPcm16 } from '../audio-core.mjs';
import { resolveExportAudio } from '../paths.mjs';
import { createSenseVoiceProvider } from '../sensevoice-provider.mjs';

test('header detection distinguishes prefixed SILK from AMR regardless of extension', () => {
  assert.deepEqual(detectAudioFormat(Buffer.from('\x02#!SILK_V3')), { format: 'silk', prefixBytes: 1 });
  assert.deepEqual(detectAudioFormat(Buffer.from('#!SILK_V3')), { format: 'silk', prefixBytes: 0 });
  assert.equal(detectAudioFormat(Buffer.from('#!AMR\n')).format, 'amr');
  assert.equal(detectAudioFormat(Buffer.from('unknown')).format, 'unknown');
});

test('WAV parser walks chunks and rejects truncated data and inconsistent PCM', () => {
  // fmt followed by a non-audio JUNK chunk, then PCM: data is not at byte 44.
  const data = Buffer.alloc(58);
  data.write('RIFF'); data.writeUInt32LE(50, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('JUNK', 36); data.writeUInt32LE(2, 40);
  data.write('data', 46); data.writeUInt32LE(4, 50);
  assert.equal(parseWav(data).dataOffset, 54);
  assert.equal(parseWav(data).frames, 2);
  assert.throws(() => parseWav(data.subarray(0, 57)), /length/);
  data.writeUInt32LE(32000, 28);
  assert.throws(() => parseWav(data), /Inconsistent/);
});

test('relative audio paths preserve literal characters and reject traversal/absolute paths/junction escape', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-audio-path-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'export');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  const name = '100%20`(voice).wav';
  fs.writeFileSync(path.join(root, name), 'sample');
  assert.equal(resolveExportAudio(root, name), path.join(root, name));
  assert.equal(resolveExportAudio(root, '%2e%2e/outside.wav'), path.join(root, '%2e%2e', 'outside.wav'));
  for (const input of ['../outside/x.wav', '..\\outside\\x.wav', '/tmp/x', 'C:\\x', '\\\\server\\share', 'https://host/x']) {
    assert.throws(() => resolveExportAudio(root, input));
  }
  fs.writeFileSync(path.join(outside, 'x.wav'), 'sample');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveExportAudio(root, 'link/x.wav'), /symlink/);
});

test('normalization refuses existing output before invoking FFmpeg', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-audio-write-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'source.amr');
  fs.writeFileSync(file, '\x02#!SILK_V3');
  await assert.rejects(normalizeToWav16kMonoPcm16(file, file), /refusing overwrite/);
  assert.equal(fs.readFileSync(file, 'utf8'), '\x02#!SILK_V3');
});

test('ASR unavailable model is skipped; provider exceptions are failed', async () => {
  const unavailable = createSenseVoiceProvider();
  assert.equal((await transcribe('unused.wav', unavailable)).status, 'skipped');
  const failure = await transcribe('unused.wav', { transcribe() { throw new Error('decoder failure'); } });
  assert.deepEqual(failure, { status: 'failed', error: 'decoder failure' });
});

test('sherpa native Node binding exposes the verified async recognizer API', async () => {
  const { default: sherpa } = await import('sherpa-onnx-node');
  assert.equal(typeof sherpa.OfflineRecognizer.createAsync, 'function');
  assert.equal(typeof sherpa.OfflineRecognizer.prototype.decodeAsync, 'function');
});
