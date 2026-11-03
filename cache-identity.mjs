import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseWav } from './audio-core.mjs';
import { SENSEVOICE_SETTINGS } from './sensevoice-provider.mjs';

const require = createRequire(import.meta.url);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Cache configuration must be JSON data');
  return result;
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function configKey(description) { return sha256(canonicalJson(description)); }
export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const data of fs.createReadStream(filename)) hash.update(data);
  return hash.digest('hex');
}

export function pcmIdentity(data) {
  const wav = parseWav(data);
  if (wav.sampleRate !== 16000 || wav.channels !== 1) throw new Error('PCM identity requires 16k mono PCM16');
  const format = { version: 'pcm-identity/1', sampleRate: wav.sampleRate, channels: wav.channels, sampleFormat: 's16le' };
  const pcmHash = createHash('sha256').update(canonicalJson(format)).update('\0')
    .update(data.subarray(wav.dataOffset, wav.dataOffset + wav.dataBytes)).digest('hex');
  return { pcmHash, sampleRate: wav.sampleRate, channels: wav.channels,
    sampleFormat: 's16le', sampleCount: wav.frames, durationMs: wav.durationSeconds * 1000 };
}

export async function createCacheIdentity({ modelDir, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' }) {
  if (!modelDir) throw new Error('SENSEVOICE_MODEL_DIR is required for the persistent cache');
  // Initialization only. No per-audio model reads, no pathname/mtime cache shortcut.
  const [modelHash, tokensHash] = await Promise.all([
    hashFile(path.join(modelDir, 'model.int8.onnx')), hashFile(path.join(modelDir, 'tokens.txt'))
  ]);
  const sherpa = require('sherpa-onnx-node');
  const packageVersion = name => JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
  const normalizerDescription = {
    version: 'normalizer/1', implementationHash: sha256(fs.readFileSync(new URL('./audio-core.mjs', import.meta.url))),
    silkWasmVersion: packageVersion('silk-wasm'),
    ffmpegBuild: execFileSync(ffmpegPath, ['-version'], { encoding: 'utf8', shell: false, windowsHide: true }).trim(),
    target: { sampleRate: 16000, channels: 1, sampleFormat: 's16le' },
    resampling: 'aresample=16000', codec: 'pcm_s16le', inputStream: '0:a:0',
    silkDecodeRate: 24000, silkPrefix: 'preserve-0x02'
  };
  const recognizerDescription = {
    version: 'recognizer/1', modelHash, tokensHash,
    bindingVersion: packageVersion('sherpa-onnx-node'), nativeVersion: sherpa.version,
    nativeGitSha1: sherpa.gitSha1, onnxruntimeVersion: sherpa.onnxruntimeVersion,
    providerImplementation: 'sensevoice-provider/2',
    providerImplementationHash: sha256(fs.readFileSync(new URL('./sensevoice-provider.mjs', import.meta.url))),
    settings: SENSEVOICE_SETTINGS, textPostprocessing: 'identity-text/1'
  };
  return { normalizerKey: configKey(normalizerDescription), recognizerKey: configKey(recognizerDescription),
    normalizerDescription, recognizerDescription, modelFingerprintFilesRead: 2 };
}
