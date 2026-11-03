import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseWav } from './audio-core.mjs';

const require = createRequire(import.meta.url);

// Shared by the runtime and cache fingerprint; paths and timings are excluded.
export const SENSEVOICE_SETTINGS = Object.freeze({
  sampleRate: 16000, featureDim: 80, language: 'auto',
  useInverseTextNormalization: 1, provider: 'cpu', decodingMethod: 'greedy_search'
});

export function createSenseVoiceProvider({ modelDir, numThreads = 2 } = {}) {
  if (!modelDir) return { transcribe: async () => ({ status: 'skipped', reason: 'SenseVoice model directory is not configured (SENSEVOICE_MODEL_DIR)' }) };
  const model = path.resolve(modelDir, 'model.int8.onnx');
  const tokens = path.resolve(modelDir, 'tokens.txt');
  const missing = [model, tokens].filter(file => !fs.existsSync(file));
  if (missing.length) return { transcribe: async () => ({ status: 'skipped', reason: `Missing model files: ${missing.join(', ')}` }) };
  // One initialization promise per provider; multiple audio files share the recognizer.
  let recognizerPromise;
  const stats = { modelInitializations: 0, asrCalls: 0 };
  return {
    stats,
    async transcribe(wavPath) {
      const data = fs.readFileSync(wavPath);
      const wav = parseWav(data);
      if (wav.sampleRate !== 16000 || wav.channels !== 1) throw new Error('ASR requires 16 kHz mono PCM16 WAV');
      recognizerPromise ??= (async () => {
        const { OfflineRecognizer } = require('sherpa-onnx-node');
        const recognizer = await OfflineRecognizer.createAsync({
          featConfig: { sampleRate: SENSEVOICE_SETTINGS.sampleRate, featureDim: SENSEVOICE_SETTINGS.featureDim },
          modelConfig: { senseVoice: { model, language: SENSEVOICE_SETTINGS.language,
            useInverseTextNormalization: SENSEVOICE_SETTINGS.useInverseTextNormalization },
            tokens, numThreads, provider: SENSEVOICE_SETTINGS.provider, debug: 0 },
          decodingMethod: SENSEVOICE_SETTINGS.decodingMethod
        });
        stats.modelInitializations++;
        return recognizer;
      })();
      const recognizer = await recognizerPromise;
      const samples = new Float32Array(wav.frames);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(wav.dataOffset + i * 2) / 32768;
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });
      stats.asrCalls++;
      const result = await recognizer.decodeAsync(stream);
      if (typeof result.text !== 'string') throw new Error('ASR returned an invalid text field');
      if (!result.text.trim()) return { status: 'empty_result', text: '', result };
      return { status: 'success', text: result.text, result, engine: 'sherpa-onnx-node', model: 'SenseVoiceSmall INT8' };
    }
  };
}
