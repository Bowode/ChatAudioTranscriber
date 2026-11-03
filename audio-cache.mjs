import fs from 'node:fs';
import path from 'node:path';
import { detectAudioFormat, normalizeToWav16kMonoPcm16 } from './audio-core.mjs';
import { sha256, pcmIdentity } from './cache-identity.mjs';
import { isWithin, resolveExportAudio } from './paths.mjs';

// Platform-neutral, single-process service. The caller owns the DB and provider lifetime.
export class AudioCacheService {
  constructor({ database, provider, identity, workDir = process.env.CHAT_AUDIO_WORK_DIR || 'work/audio-cache',
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', onStage = () => {} }) {
    this.database = database;
    this.provider = provider;
    this.identity = identity;
    this.workDir = path.resolve(workDir);
    this.ffmpegPath = ffmpegPath;
    this.onStage = onStage;
    this.stats = { asrCalls: 0, normalizations: 0, silkDecode: 0, ffmpeg: 0 };
  }

  async process(input) {
    this.onStage('input');
    const audioPath = resolveExportAudio(input.source.sourceRoot, input.audioRelativePath);
    // Prohibit output through a work-dir symlink into the source tree as well.
    fs.mkdirSync(this.workDir, { recursive: true });
    if (isWithin(fs.realpathSync(input.source.sourceRoot), fs.realpathSync(this.workDir))
        || isWithin(fs.realpathSync(input.source.sourceRoot), fs.realpathSync(path.dirname(this.database.filename)))) {
      throw new Error('Cache DB and work directory must be outside the export directory');
    }
    let bytes;
    try { bytes = fs.readFileSync(audioPath); }
    catch (error) {
      if (error.code === 'ENOENT') this.database.recordInput(input, null);
      throw error;
    }
    const rawHash = sha256(bytes);
    const asset = this.database.getAsset(rawHash);
    this.onStage('detect');
    const messagePartId = this.database.recordInput(input, { rawHash, byteSize: bytes.length,
      detectedFormat: asset?.detected_format ?? detectAudioFormat(bytes).format });
    const { normalizerKey, recognizerKey } = this.identity;
    const mapped = this.database.getNormalization(rawHash, normalizerKey);
    const makeResult = (row, cacheLevel) => ({ status: row.status, text: row.transcript,
      language: row.language, durationMs: row.duration_ms, inferenceMs: row.inference_ms,
      rawHash, pcmHash: row.pcm_hash, normalizerKey, recognizerKey, messagePartId,
      cached: cacheLevel !== null, cacheLevel });
    if (mapped) {
      const hit = this.database.getTranscription(mapped.pcm_hash, recognizerKey);
      if (hit) return makeResult(hit, 'raw');
    }
    const runDir = fs.mkdtempSync(path.join(this.workDir, 'normalize-'));
    const wavPath = path.join(runDir, 'audio.wav');
    this.stats.normalizations++;
    this.onStage('normalize');
    await normalizeToWav16kMonoPcm16(audioPath, wavPath, { ffmpegPath: this.ffmpegPath,
      onOperation: operation => { this.stats[operation]++; this.onStage(operation === 'silkDecode' ? 'decode' : 'normalize'); } });
    const pcm = pcmIdentity(fs.readFileSync(wavPath));
    this.database.saveNormalization(rawHash, normalizerKey, pcm);
    const hit = this.database.getTranscription(pcm.pcmHash, recognizerKey);
    if (hit) return makeResult(hit, 'pcm');
    // No SQLite transaction is open while the provider is loading or inferring.
    this.stats.asrCalls++;
    this.onStage('asr');
    const started = performance.now();
    const asr = await this.provider.transcribe(wavPath);
    const inferenceMs = performance.now() - started;
    if (!['success', 'empty_result'].includes(asr.status)) {
      return { ...asr, rawHash, pcmHash: pcm.pcmHash, normalizerKey, recognizerKey, messagePartId, cached: false, cacheLevel: null };
    }
    if (typeof asr.text !== 'string') throw new Error('Provider terminal result must contain string text');
    const status = asr.text.trim() ? asr.status : 'empty_result';
    this.onStage('store_result');
    this.database.saveTranscription(pcm.pcmHash, recognizerKey, {
      status, transcript: status === 'empty_result' ? '' : asr.text,
      language: asr.result?.lang ?? null, durationMs: pcm.durationMs, inferenceMs,
      metadata: { result: asr.result ?? null, engine: asr.engine ?? null,
        normalizer: this.identity.normalizerDescription, recognizer: this.identity.recognizerDescription }
    });
    return makeResult(this.database.getTranscription(pcm.pcmHash, recognizerKey), null);
  }
}
