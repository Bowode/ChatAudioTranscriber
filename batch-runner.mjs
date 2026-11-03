import fs from 'node:fs';
import { sha256 } from './cache-identity.mjs';
import { resolveExportAudio } from './paths.mjs';
import { JobQueue } from './job-queue.mjs';

export async function runPending({ database, service, lock, exportId = null, shouldStop = () => false,
  onProgress = () => {}, afterCacheCommit = async () => {} }) {
  lock.assertOwned();
  const queue = new JobQueue(database);
  const recovered = queue.recover();
  database.transaction(() => database.connection.prepare(`UPDATE scan_runs SET status='failed',error_code='INTERRUPTED',
    error_message='Previous scan did not complete',completed_at=CURRENT_TIMESTAMP WHERE status='running'`).run());
  const summary = { recovered, succeeded: 0, failed: 0, asr: 0, raw_cache: 0, pcm_cache: 0, stopped: false };
  const previousHook = service.onStage;
  let currentStage = 'input', job;
  const signal = () => { summary.stopped = true; };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  try {
    while (!summary.stopped && !shouldStop()) {
      lock.assertOwned();
      job = queue.claim(service.identity, exportId);
      if (!job) break;
      currentStage = 'input';
      service.onStage = stage => { currentStage = stage; queue.stage(job.id, stage); };
      try {
        const input = JSON.parse(job.input_json);
        let bytes;
        try { bytes = fs.readFileSync(resolveExportAudio(input.source.sourceRoot, input.audioRelativePath)); }
        catch (error) {
          if (error.code === 'ENOENT') database.transaction(() => database.connection.prepare(`UPDATE message_parts
            SET availability_status='missing_audio',scan_availability='missing_audio' WHERE id=?`).run(job.message_part_id));
          throw error;
        }
        if (sha256(bytes) !== job.input_raw_hash) throw Object.assign(new Error('Source audio changed; rescan to create a new task'), { code: 'INPUT_CHANGED' });
        const result = await service.process(input);
        if (!['success', 'empty_result'].includes(result.status)) throw Object.assign(new Error(result.error || result.reason || 'Provider did not complete'), { code: 'PROVIDER_FAILED' });
        await afterCacheCommit(job, result); // Testable crash window: result durable, job still running.
        lock.assertOwned();
        summary[queue.succeed(job.id, result)]++;
        summary.succeeded++;
      } catch (error) {
        lock.assertOwned();
        const databaseError = String(error.code).startsWith('ERR_SQLITE') || /database is (locked|readonly)|disk.*full/i.test(error.message);
        const modelError = currentStage === 'asr' && service.provider.stats?.modelInitializations === 0;
        queue.fail(job.id, modelError ? 'model_load' : currentStage, error);
        summary.failed++;
        if (databaseError || modelError) throw error;
      }
      onProgress({ jobId: job.id, ...summary }); // No transcript text.
    }
  } finally {
    service.onStage = previousHook;
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
  }
  return summary;
}
