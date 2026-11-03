import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decode } from 'silk-wasm';

export function parseWav(data) {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  const end = data.readUInt32LE(4) + 8;
  if (end !== data.length) throw new Error('WAV RIFF length does not match file size');
  let fmt, pcm;
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) throw new Error('Truncated WAV chunk header');
    const name = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size % 2) > end) throw new Error('Truncated WAV chunk');
    if (name === 'fmt ') {
      if (fmt || size < 16) throw new Error('Invalid WAV fmt chunk');
      fmt = { format: data.readUInt16LE(start), channels: data.readUInt16LE(start + 2),
        sampleRate: data.readUInt32LE(start + 4), byteRate: data.readUInt32LE(start + 8),
        blockAlign: data.readUInt16LE(start + 12), bits: data.readUInt16LE(start + 14) };
    } else if (name === 'data') {
      if (pcm) throw new Error('Multiple WAV data chunks are unsupported');
      pcm = { dataOffset: start, dataBytes: size };
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !pcm || !pcm.dataBytes) throw new Error('Missing/empty WAV fmt or data');
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.sampleRate < 1) {
    throw new Error('Only PCM16 WAV input is supported in this milestone');
  }
  if (fmt.blockAlign !== fmt.channels * 2 || fmt.byteRate !== fmt.sampleRate * fmt.blockAlign
      || pcm.dataBytes % fmt.blockAlign) throw new Error('Inconsistent WAV PCM parameters');
  return { ...fmt, ...pcm, frames: pcm.dataBytes / fmt.blockAlign,
    durationSeconds: pcm.dataBytes / fmt.byteRate };
}

// Detect by content, never by extension. Buffer input is also useful for tests.
export function detectAudioFormat(input) {
  const data = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
    return { format: 'pcm_wav', wav: parseWav(data) };
  }
  const prefixBytes = data[0] === 2 ? 1 : 0;
  if (data.toString('ascii', prefixBytes, prefixBytes + 9) === '#!SILK_V3') {
    return { format: 'silk', prefixBytes };
  }
  if (data.subarray(0, 6).equals(Buffer.from('#!AMR\n'))) return { format: 'amr' };
  return { format: 'unknown' };
}

export async function decodeSilk(input, sampleRate = 24000) {
  const data = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const info = detectAudioFormat(data);
  if (info.format !== 'silk') throw new Error('Expected SILK file header');
  if (![8000, 12000, 16000, 24000].includes(sampleRate)) throw new Error('Unsupported SILK output rate');
  // silk-wasm 3.7.1 accepts the Tencent 0x02 prefix itself. Do not strip it.
  const result = await decode(data, sampleRate);
  const pcm = Buffer.from(result.data);
  if (!pcm.length || pcm.length % 2) throw new Error('Invalid decoded PCM16');
  return { pcm, sampleRate, channels: 1, bits: 16, prefixBytes: info.prefixBytes,
    decoderDurationMs: result.duration, durationSeconds: pcm.length / (sampleRate * 2) };
}

export async function normalizeToWav16kMonoPcm16(inputPath, outputPath, { ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', onOperation } = {}) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  if (fs.existsSync(output)) throw new Error('Output already exists; refusing overwrite');
  const info = detectAudioFormat(input);
  let decoded;
  let inputArgs;
  if (info.format === 'pcm_wav') inputArgs = ['-i', input];
  else if (info.format === 'silk') {
    onOperation?.('silkDecode');
    decoded = await decodeSilk(input);
    inputArgs = ['-f', 's16le', '-ar', String(decoded.sampleRate), '-ac', '1', '-i', 'pipe:0'];
  } else throw new Error(`Unsupported audio format: ${info.format}`);
  // An argument array with shell disabled preserves %, backticks, parentheses, etc.
  onOperation?.('ffmpeg');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...inputArgs,
    '-map', '0:a:0', '-map_metadata', '-1', '-af', 'aresample=16000', '-ac', '1',
    '-c:a', 'pcm_s16le', '-f', 'wav', output], { input: decoded?.pcm, windowsHide: true, shell: false });
  const wav = parseWav(fs.readFileSync(output));
  if (wav.sampleRate !== 16000 || wav.channels !== 1 || wav.bits !== 16) throw new Error('Unexpected output parameters');
  return { outputPath: output, inputFormat: info, wav,
    silk: decoded ? { prefixBytes: decoded.prefixBytes, prefixHandling: 'passed_through_unchanged',
      decoderDurationMs: decoded.decoderDurationMs, decodedPcmBytes: decoded.pcm.length,
      durationSeconds: decoded.durationSeconds } : null };
}

// Provider contract: transcribe(wavPath) -> {status, text?, reason?, error?}.
export async function transcribe(wavPath, provider) {
  try { return await provider.transcribe(wavPath); }
  catch (error) { return { status: 'failed', error: error.message }; }
}
