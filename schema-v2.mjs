export function migrateV2(db) {
  db.exec(`CREATE TABLE scan_runs (
    id INTEGER PRIMARY KEY, export_id INTEGER NOT NULL REFERENCES exports(id), generation INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, summary_json TEXT,
    error_code TEXT, error_message TEXT, UNIQUE(export_id,generation)
  ) STRICT;
  ALTER TABLE message_parts ADD COLUMN last_seen_scan_id INTEGER REFERENCES scan_runs(id);
  ALTER TABLE message_parts ADD COLUMN source_presence_status TEXT NOT NULL DEFAULT 'present';
  ALTER TABLE message_parts ADD COLUMN scan_availability TEXT NOT NULL DEFAULT 'ready';
  UPDATE message_parts SET scan_availability=availability_status;
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY, message_part_id INTEGER NOT NULL REFERENCES message_parts(id),
    input_raw_hash TEXT NOT NULL REFERENCES audio_assets(raw_hash), normalizer_key TEXT NOT NULL, recognizer_key TEXT NOT NULL,
    input_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed')),
    stage TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
    completion_kind TEXT, result_pcm_hash TEXT, result_status TEXT,
    last_error_code TEXT, last_error_message TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT,
    UNIQUE(message_part_id,input_raw_hash,normalizer_key,recognizer_key)
  ) STRICT;
  CREATE INDEX jobs_status ON jobs(status,normalizer_key,recognizer_key);
  PRAGMA user_version=2;`);
}
