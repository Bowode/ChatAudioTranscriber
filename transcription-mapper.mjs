import { localIdKey, safeInteger } from './json-preserver.mjs';
import { messageStatus } from './ai-text-builder.mjs';

export function voiceParts(message, platform) {
  if (platform === 'wechat') return safeInteger(message.localType) === 34 ? [{}] : [];
  const elements = (message.content?.elements ?? []).filter(e => e.type === 'audio');
  const resources = (message.content?.resources ?? []).filter(r => r.type === 'audio');
  return elements.length ? elements.map(e => e.data) : resources;
}
export function messageKey(message, platform) {
  const id = platform === 'qq' ? message.id : message.platformMessageId;
  if (id !== undefined && id !== null && id !== '' && typeof id !== 'string') throw new Error('Platform message ID must remain a string');
  if (id) return `id:${id}`;
  if (platform === 'wechat' && message.localId != null) return `local:${localIdKey(message.localId)}`;
  throw new Error('Voice message has no supported stable identity');
}

export function selectConfiguration(db, exportId, { normalizerKey, recognizerKey }) {
  const configs = db.prepare(`SELECT DISTINCT j.normalizer_key,j.recognizer_key FROM jobs j
    JOIN message_parts p ON p.id=j.message_part_id WHERE p.export_id=? AND p.source_presence_status='present'
    AND j.input_raw_hash=p.raw_hash`).all(exportId);
  const matching = configs.filter(c => (!normalizerKey || c.normalizer_key === normalizerKey) && (!recognizerKey || c.recognizer_key === recognizerKey));
  if (!configs.length && !normalizerKey && !recognizerKey) return { normalizerKey: null, recognizerKey: null };
  if (matching.length !== 1) throw new Error(matching.length > 1
    ? 'Multiple recognition configurations; specify --normalizer-key and/or --recognizer-key'
    : 'No matching recognition configuration in this source');
  return { normalizerKey: matching[0].normalizer_key, recognizerKey: matching[0].recognizer_key };
}

export function mapPart(db, row, configuration) {
  const base = { partIndex: row.part_index, status: 'pending', text: '', language: null, durationMs: null };
  if (['missing_audio', 'ambiguous_audio', 'unresolved_audio_path'].includes(row.scan_availability)) {
    return { ...base, status: row.scan_availability };
  }
  if (row.scan_availability !== 'ready') throw new Error(`Unsupported scan resource status: ${row.scan_availability}`);
  if (!configuration.normalizerKey || !configuration.recognizerKey) return base;
  const job = db.prepare(`SELECT * FROM jobs WHERE message_part_id=? AND input_raw_hash=?
    AND normalizer_key=? AND recognizer_key=?`).get(row.id, row.raw_hash, configuration.normalizerKey, configuration.recognizerKey);
  if (!job || ['pending', 'running'].includes(job.status)) return base;
  if (job.status === 'failed') return { ...base, status: 'failed', errorCode: job.last_error_code || 'PROCESSING_ERROR' };
  if (job.status !== 'succeeded') throw new Error('Unexpected job status');
  const mapping = db.prepare('SELECT pcm_hash FROM normalizations WHERE raw_hash=? AND normalizer_key=?').get(row.raw_hash, job.normalizer_key);
  const result = db.prepare('SELECT * FROM transcriptions WHERE pcm_hash=? AND recognizer_key=?').get(job.result_pcm_hash, job.recognizer_key);
  if (!result || !mapping || mapping.pcm_hash !== job.result_pcm_hash || result.status !== job.result_status
      || !['success', 'empty_result'].includes(result.status)
      || (result.status === 'success' && !result.transcript.trim())
      || (result.status === 'empty_result' && result.transcript !== '')) throw new Error('Database job/transcription linkage is inconsistent');
  return { ...base, status: result.status, text: result.transcript,
    language: result.language?.replace(/^<\|(.+)\|>$/, '$1') ?? null,
    durationMs: result.duration_ms, completionKind: job.completion_kind };
}

export function locateRows(document, source, rows, configuration, db) {
  if (!Array.isArray(document.messages)) throw new Error('Source JSON has no messages array');
  if (source.platform === 'qq') {
    if (document.metadata?.name !== 'QQChatExporter' || document.metadata.version !== '0.1.0'
      || (document.chatInfo?.peerUid ?? '') !== source.chat_scope
      || (document.chatInfo?.selfUid ?? '') !== source.account_scope) throw new Error('QCE source/account/chat scope mismatch');
  } else if (source.platform === 'wechat') {
    if (document.weflow?.version !== '1.0.3' || (document.session?.wxid ?? '') !== source.chat_scope) throw new Error('WeFlow source/chat scope mismatch');
  } else throw new Error('Unsupported source platform');
  const voices = new Map();
  for (const [index, message] of document.messages.entries()) {
    const parts = voiceParts(message, source.platform);
    if (!parts.length) continue;
    const key = messageKey(message, source.platform);
    if (voices.has(key)) throw new Error('Source JSON has ambiguous duplicate voice message identities');
    voices.set(key, { index, message, count: parts.length, parts: new Map() });
  }
  for (const row of rows) {
    const match = voices.get(row.message_key);
    if (!match) throw new Error('Registered voice message cannot be uniquely located in source JSON');
    const expectedId = source.platform === 'qq' ? match.message.id : match.message.platformMessageId ?? null;
    if ((row.message_id || null) !== (expectedId || null)) throw new Error('Message ID and message_key mismatch');
    const locator = JSON.parse(row.source_locator_json);
    if (locator.jsonIndex !== match.index) throw new Error('Source JSON message position changed; rescan before exporting');
    if (source.platform === 'qq') {
      if (locator.htmlId !== `msg-${match.message.id}` || !locator.chunkId || locator.indexChunkId !== locator.chunkId) throw new Error('QCE source locator mismatch');
    } else {
      if (locator.localId == null || localIdKey(match.message.localId) !== localIdKey(locator.localId)
        || (locator.platformMessageId || null) !== (expectedId || null)
        || (row.audio_relative_path && match.message.mediaPath !== row.audio_relative_path)) throw new Error('WeFlow source locator/mediaPath mismatch');
    }
    if (!Number.isSafeInteger(row.part_index) || row.part_index < 0 || row.part_index >= match.count || match.parts.has(row.part_index)) throw new Error('Voice part identity/order mismatch');
    match.parts.set(row.part_index, mapPart(db, row, configuration));
  }
  for (const match of voices.values()) {
    if (match.parts.size !== match.count) throw new Error('Source voice parts are missing from this export registration; rescan before exporting');
    const parts = [...match.parts.values()].sort((a, b) => a.partIndex - b.partIndex);
    match.transcription = { schemaVersion: 1, generatedBy: 'ChatAudioTranscriber', status: messageStatus(parts),
      normalizerKey: configuration.normalizerKey, recognizerKey: configuration.recognizerKey, parts };
  }
  return [...voices.values()];
}
