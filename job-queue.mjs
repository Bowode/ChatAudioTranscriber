export class JobQueue {
  constructor(database) { this.database = database; this.db = database.connection; }
  enqueue(partId, rawHash, identity, input) {
    this.db.prepare(`INSERT INTO jobs(message_part_id,input_raw_hash,normalizer_key,recognizer_key,input_json)
      VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`).run(partId, rawHash, identity.normalizerKey, identity.recognizerKey, JSON.stringify(input));
  }
  recover() {
    return this.database.transaction(() => this.db.prepare(`UPDATE jobs SET status='pending',stage='recovered',
      last_error_code='INTERRUPTED',updated_at=CURRENT_TIMESTAMP WHERE status='running'`).run().changes);
  }
  claim(identity, exportId = null) {
    return this.database.transaction(() => {
      const job = this.db.prepare(`SELECT j.* FROM jobs j JOIN message_parts m ON m.id=j.message_part_id
        WHERE j.status='pending' AND j.normalizer_key=? AND j.recognizer_key=?
        AND m.source_presence_status='present' AND m.scan_availability='ready' AND m.raw_hash=j.input_raw_hash
        AND (? IS NULL OR m.export_id=?) ORDER BY j.id LIMIT 1`)
        .get(identity.normalizerKey, identity.recognizerKey, exportId, exportId);
      if (!job) return null;
      this.db.prepare(`UPDATE jobs SET status='running',stage='input',attempt_count=attempt_count+1,
        started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,last_error_code=NULL,last_error_message=NULL WHERE id=?`).run(job.id);
      return job;
    });
  }
  stage(id, stage) { this.database.transaction(() => this.db.prepare('UPDATE jobs SET stage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(stage, id)); }
  succeed(id, result) {
    const kind = result.cacheLevel === 'raw' ? 'raw_cache' : result.cacheLevel === 'pcm' ? 'pcm_cache' : 'asr';
    this.database.transaction(() => this.db.prepare(`UPDATE jobs SET status='succeeded',stage='done',completion_kind=?,
      result_pcm_hash=?,result_status=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(kind, result.pcmHash, result.status, id));
    return kind;
  }
  fail(id, stage, error) {
    this.database.transaction(() => this.db.prepare(`UPDATE jobs SET status='failed',stage=?,last_error_code=?,
      last_error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(stage, String(error.code || 'PROCESSING_ERROR'), error.message, id));
  }
  retry({ exportId = null, jobId = null } = {}) {
    const jobs = this.db.prepare(`SELECT * FROM jobs WHERE status='failed' AND (? IS NULL OR id=?) AND message_part_id IN
      (SELECT id FROM message_parts WHERE (? IS NULL OR export_id=?))`).all(jobId, jobId, exportId, exportId);
    let requeued = 0;
    for (const job of jobs) {
      const input = JSON.parse(job.input_json);
      let bytes;
      try { bytes = fs.readFileSync(resolveExportAudio(input.source.sourceRoot, input.audioRelativePath)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (sha256(bytes) !== job.input_raw_hash) continue;
      this.database.transaction(() => {
        this.db.prepare("UPDATE jobs SET status='pending',stage='retry',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
        this.db.prepare("UPDATE message_parts SET availability_status='ready',scan_availability='ready' WHERE id=?").run(job.message_part_id);
      });
      requeued++;
    }
    return requeued;
  }
}

export function batchStatus(db) {
  return {
    sources: db.prepare('SELECT count(*) n FROM exports').get().n,
    scans: db.prepare('SELECT status,count(*) n FROM scan_runs GROUP BY status').all(),
    fragments: db.prepare('SELECT count(*) n FROM message_parts').get().n,
    resources: db.prepare('SELECT scan_availability,source_presence_status,count(*) n FROM message_parts GROUP BY 1,2').all(),
    jobs: db.prepare('SELECT status,count(*) n FROM jobs GROUP BY status').all(),
    completions: db.prepare('SELECT completion_kind,result_status,count(*) n FROM jobs WHERE status=\'succeeded\' GROUP BY 1,2').all()
  };
}
import fs from 'node:fs';
import { resolveExportAudio } from './paths.mjs';
import { sha256 } from './cache-identity.mjs';

