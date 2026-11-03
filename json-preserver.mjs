import assert from 'node:assert/strict';

// Keep every original numeric token as a JSON number, including unsafe integers,
// long decimal fractions, exponents and -0. Never convert IDs or numbers to strings.
export function parseLossless(text) {
  if (typeof JSON.rawJSON !== 'function') throw new Error('This exporter requires Node JSON.rawJSON support');
  return JSON.parse(text, (key, value, context) => {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') throw new Error('Lossless numeric JSON parsing is unavailable');
    return JSON.rawJSON(context.source);
  });
}
export function stringifyLossless(value) { return JSON.stringify(value, null, 2) + '\n'; }
export function safeInteger(value) {
  const number = JSON.isRawJSON(value) ? Number(value.rawJSON) : value;
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe or invalid integer in message locator');
  return number;
}
export function localIdKey(value) {
  if (typeof value === 'string' && value) return value;
  return String(safeInteger(value));
}
export function ownsTranscription(message) {
  return message.transcription?.generatedBy === 'ChatAudioTranscriber'
    && safeVersion(message.transcription.schemaVersion) === 1;
}
function safeVersion(value) { try { return safeInteger(value); } catch { return null; } }
export function fieldConflicts(message) {
  const fields = ['transcription', 'ai_text'].filter(field => Object.hasOwn(message, field));
  return fields.length && !ownsTranscription(message) ? fields : [];
}
export function assertOriginalFields(original, enhanced, augmentedIndices) {
  // Serialization reparses raw-number wrappers without losing their original tokens.
  const left = parseLossless(stringifyLossless(original));
  const right = parseLossless(stringifyLossless(enhanced));
  assert.equal(left.messages.length, right.messages.length, 'Message count changed');
  for (const index of augmentedIndices) for (const field of ['transcription', 'ai_text']) {
    delete left.messages[index][field]; delete right.messages[index][field];
  }
  assert.deepStrictEqual(right, left, 'An original JSON field or message order changed');
}
