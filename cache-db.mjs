import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configKey } from './cache-identity.mjs';
import { migrateV2 } from './schema-v2.mjs';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL, source_root TEXT NOT NULL,
  account_scope TEXT NOT NULL, chat_scope TEXT NOT NULL, schema_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TABLE IF NOT EXISTS audio_assets (
  raw_hash TEXT PRIMARY KEY, byte_size INTEGER NOT NULL, detected_format TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TABLE IF NOT EXISTS message_parts (
  id INTEGER PRIMARY KEY, export_id INTEGER NOT NULL REFERENCES exports(id),
  message_key TEXT NOT NULL, message_id TEXT, part_index INTEGER NOT NULL CHECK(part_index >= 0),
  sender TEXT, timestamp_raw TEXT, source_locator_json TEXT NOT NULL,
  audio_relative_path TEXT NOT NULL, raw_hash TEXT REFERENCES audio_assets(raw_hash),
  availability_status TEXT NOT NULL CHECK(availability_status IN ('ready','missing_audio')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(export_id, message_key, part_index)
) STRICT;
CREATE INDEX IF NOT EXISTS message_parts_raw_hash ON message_parts(raw_hash);
CREATE TABLE IF NOT EXISTS normalizations (
  raw_hash TEXT NOT NULL REFERENCES audio_assets(raw_hash), normalizer_key TEXT NOT NULL,
  pcm_hash TEXT NOT NULL, sample_rate INTEGER NOT NULL, channels INTEGER NOT NULL,
  sample_format TEXT NOT NULL, sample_count INTEGER NOT NULL, duration_ms REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(raw_hash, normalizer_key)
) STRICT;
CREATE INDEX IF NOT EXISTS normalizations_pcm_hash ON normalizations(pcm_hash);
CREATE TABLE IF NOT EXISTS transcriptions (
  pcm_hash TEXT NOT NULL, recognizer_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','empty_result')), transcript TEXT NOT NULL,
  language TEXT, duration_ms REAL NOT NULL, inference_ms REAL NOT NULL, metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(pcm_hash, recognizer_key),
  CHECK((status = 'success' AND length(trim(transcript)) > 0) OR (status = 'empty_result' AND transcript = ''))
) STRICT;`;

export class AudioCacheDatabase {
  constructor(filename = process.env.CHAT_AUDIO_DB_PATH || 'cache/asr.sqlite', { schemaVersion = 2 } = {}) {
    this.filename = path.resolve(filename);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.connection = new DatabaseSync(this.filename);
    try {
      this.connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      const version = this.connection.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, 2].includes(version) || ![1, 2].includes(schemaVersion) || version > schemaVersion) throw new Error(`Unsupported SQLite schema version: ${version}`);
      this.transaction(() => {
        this.connection.exec(SCHEMA_SQL);
        if (version === 0) this.connection.exec('PRAGMA user_version=1');
        if (version < 2 && schemaVersion === 2) migrateV2(this.connection);
      });
    } catch (error) { this.connection.close(); throw error; }
  }

  transaction(callback) {
    this.connection.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.connection.exec('COMMIT'); return result; }
    catch (error) { this.connection.exec('ROLLBACK'); throw error; }
  }
  close() { this.connection.close(); }
  getAsset(rawHash) { return this.connection.prepare('SELECT * FROM audio_assets WHERE raw_hash=?').get(rawHash); }
  getNormalization(rawHash, key) {
    return this.connection.prepare('SELECT * FROM normalizations WHERE raw_hash=? AND normalizer_key=?').get(rawHash, key);
  }
  getTranscription(pcmHash, key) {
    return this.connection.prepare("SELECT * FROM transcriptions WHERE pcm_hash=? AND recognizer_key=? AND status IN ('success','empty_result')").get(pcmHash, key);
  }
  recordInput({ source, message, audioRelativePath }, asset) {
    const messageKey = this.messageKey(source, message);
    return this.transaction(() => {
      const exportId = this.registerSource(source);
      if (asset) this.connection.prepare('INSERT INTO audio_assets(raw_hash,byte_size,detected_format) VALUES(?,?,?) ON CONFLICT(raw_hash) DO NOTHING')
        .run(asset.rawHash, asset.byteSize, asset.detectedFormat);
      this.connection.prepare(`INSERT INTO message_parts(export_id,message_key,message_id,part_index,sender,timestamp_raw,
        source_locator_json,audio_relative_path,raw_hash,availability_status) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(export_id,message_key,part_index) DO UPDATE SET sender=excluded.sender,timestamp_raw=excluded.timestamp_raw,
        source_locator_json=excluded.source_locator_json,audio_relative_path=excluded.audio_relative_path,
        raw_hash=excluded.raw_hash,availability_status=excluded.availability_status`).run(
        exportId, messageKey, message.messageId ?? null, message.partIndex ?? 0,
        message.sender == null ? null : JSON.stringify(message.sender),
        message.timestampRaw == null ? null : JSON.stringify(message.timestampRaw),
        JSON.stringify(message.sourceLocator ?? {}), audioRelativePath, asset?.rawHash ?? null, asset ? 'ready' : 'missing_audio');
      return this.connection.prepare('SELECT id FROM message_parts WHERE export_id=? AND message_key=? AND part_index=?')
        .get(exportId, messageKey, message.partIndex ?? 0).id;
    });
  }
  sourceIdentity(source) {
    const sourceRoot = fs.realpathSync(source.sourceRoot);
    const identityRoot = process.platform === 'win32' ? sourceRoot.toLowerCase() : sourceRoot;
    const scope = { platform: source.platform, sourceRoot: identityRoot,
      accountScope: source.accountScope ?? '', chatScope: source.chatScope ?? '' };
    const sourceKey = configKey(scope);
    return { sourceRoot, scope, sourceKey };
  }
  messageKey(source, message) {
    // String IDs avoid accidental rounding of QQ's 64-bit message IDs.
    if (message.messageId !== undefined && message.messageId !== null && typeof message.messageId !== 'string') {
      throw new Error('messageId must remain a string');
    }
    const messageKey = message.messageId ? `id:${message.messageId}`
      : source.platform === 'wechat' && message.localId !== undefined ? `local:${message.localId}` : null;
    if (!messageKey) throw new Error('A stable messageId or export-scoped WeFlow localId is required');
    return messageKey;
  }
  registerSource(source) {
    const { sourceRoot, scope, sourceKey } = this.sourceIdentity(source);
    this.connection.prepare(`INSERT INTO exports(source_key,platform,source_root,account_scope,chat_scope,schema_version)
        VALUES(?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET updated_at=CURRENT_TIMESTAMP`).run(
        sourceKey, scope.platform, sourceRoot, scope.accountScope, scope.chatScope, source.schemaVersion ?? null);
    return this.connection.prepare('SELECT id FROM exports WHERE source_key=?').get(sourceKey).id;
  }
  saveNormalization(rawHash, key, pcm) {
    this.transaction(() => {
      this.connection.prepare(`INSERT INTO normalizations(raw_hash,normalizer_key,pcm_hash,sample_rate,channels,sample_format,sample_count,duration_ms)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(raw_hash,normalizer_key) DO NOTHING`)
        .run(rawHash, key, pcm.pcmHash, pcm.sampleRate, pcm.channels, pcm.sampleFormat, pcm.sampleCount, pcm.durationMs);
      if (this.getNormalization(rawHash, key).pcm_hash !== pcm.pcmHash) throw new Error('Normalizer produced different PCM for an existing identity');
    });
  }
  saveTranscription(pcmHash, key, value) {
    this.transaction(() => this.connection.prepare(`INSERT INTO transcriptions(pcm_hash,recognizer_key,status,transcript,language,duration_ms,inference_ms,metadata_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(pcm_hash,recognizer_key) DO NOTHING`).run(
      pcmHash, key, value.status, value.transcript, value.language, value.durationMs, value.inferenceMs, JSON.stringify(value.metadata)));
  }
  counts() {
    return {
      exports: this.connection.prepare('SELECT count(*) AS n FROM exports').get().n,
      messageParts: this.connection.prepare('SELECT count(*) AS n FROM message_parts').get().n,
      audioAssets: this.connection.prepare('SELECT count(*) AS n FROM audio_assets').get().n,
      normalizations: this.connection.prepare('SELECT count(*) AS n FROM normalizations').get().n,
      transcriptions: this.connection.prepare('SELECT count(*) AS n FROM transcriptions').get().n
    };
  }
}
