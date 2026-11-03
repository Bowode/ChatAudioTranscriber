import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverExports, scanExports } from './export-scanner.mjs';
import { AudioCacheDatabase } from './cache-db.mjs';
import { AudioCacheService } from './audio-cache.mjs';
import { createCacheIdentity } from './cache-identity.mjs';
import { createSenseVoiceProvider } from './sensevoice-provider.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { runPending } from './batch-runner.mjs';
import { exportJson, realTarget, overlaps, ownedOutput } from './json-exporter.mjs';
import { exportHtml } from './html-exporter.mjs';
import { enhancedPath } from './sibling-publisher.mjs';

function scanStatistics(row) {
  const result = {};
  for (const key of ['platform', 'exportId', 'scanId', 'status', 'code', 'messageCount', 'audioMessages', 'fragments',
    'ready', 'missing_audio', 'ambiguous_audio', 'unresolved_audio_path']) if (row[key] !== undefined) result[key] = row[key];
  if (row.error || row.code) { result.status = 'failed'; result.code ||= 'SCAN_FAILED'; }
  return result;
}

// Orchestration only: the existing modules retain decoding, cache, queue and publishing responsibilities.
export async function runWorkflow({ inputPaths, outputDirectory, databasePath = process.env.CHAT_AUDIO_DB_PATH || 'cache/asr.sqlite',
  workDirectory = process.env.CHAT_AUDIO_WORK_DIR || 'work/batch', modelDirectory = process.env.SENSEVOICE_MODEL_DIR || 'models/sensevoice',
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', dryRun = false, sameDirectory = false,
  overwriteGenerated = false, onProgress = () => {} },
  { identityFactory = createCacheIdentity, providerFactory = createSenseVoiceProvider } = {}) {
  if (!Array.isArray(inputPaths) || !inputPaths.length || (!sameDirectory && !outputDirectory)) throw new Error('workflow requires --input and --output');
  const inputs = [...new Set(inputPaths.map(p => fs.realpathSync(p)))];
  const filename = realTarget(databasePath), work = realTarget(workDirectory), model = realTarget(modelDirectory);
  const output = sameDirectory ? path.join(work, 'launcher-reports') : realTarget(outputDirectory);
  const roots = inputs.map(p => fs.statSync(p).isDirectory() ? p : path.dirname(p));
  if (roots.some(root => [output, path.dirname(filename), work, model].some(p => overlaps(root, p)))
      || (!sameDirectory && [path.dirname(filename), work, model].some(p => overlaps(output, p)))) {
    throw new Error('Input, output, database directory, work and model directories must be separate');
  }
  const collections = new Map();
  for (const input of inputs) {
    const found = discoverExports(input, { excludeGenerated: true });
    if (found.errors.length) throw new Error(`Discovery refused: ${found.errors.map(e => `${path.basename(e.file)} (${e.code})`).join(', ')}`);
    for (const collection of found.collections) collections.set(fs.realpathSync(collection.jsonPath), collection);
  }
  if (!collections.size) throw new Error('No supported original export collections found');
  const scopes = new Set();
  for (const collection of collections.values()) {
    if (collection.candidates.length !== 1) throw new Error('Each completed export must have exactly one matching original HTML');
    const scope = JSON.stringify([collection.platform, fs.realpathSync(collection.source.sourceRoot), collection.source.accountScope, collection.source.chatScope]);
    if (scopes.has(scope)) throw new Error('Multiple JSON snapshots share one source scope; select a single JSON file');
    scopes.add(scope);
  }
  const preview = [];
  onProgress({ phase: 'scan-preview' });
  for (const collection of collections.values()) {
    preview.push(...(await scanExports({ inputPath: collection.jsonPath, dryRun: true, excludeGenerated: true })).map(row => ({
      ...scanStatistics(row), jsonPath: collection.jsonPath, htmlPath: collection.candidates[0] })));
  }
  if (preview.some(r => r.status !== 'completed')) throw new Error('Export scan preview failed; no workflow writes performed');
  const report = { generatedBy: 'ChatAudioTranscriber', reportKind: 'workflow-6a', schemaVersion: 1,
    startedAt: new Date().toISOString(), dryRun, status: dryRun ? 'preview' : 'running',
    outputDirectory: output, collectionCount: collections.size, preview, sources: [],
    calls: { asrCalls: 0, normalizations: 0, silkDecode: 0, ffmpeg: 0, modelInitializations: 0 },
    totals: { messages: preview.reduce((n, r) => n + r.messageCount, 0), fragments: preview.reduce((n, r) => n + r.fragments, 0) } };
  if (dryRun) return report; // No DB, lock, model fingerprints, output or external processes in preview.

  if (sameDirectory) {
    if (!fs.existsSync(filename)) throw new Error('Configured database does not exist; no fallback database will be created');
    // Check every selected output before registering messages or starting audio work.
    for (const collection of collections.values()) for (const original of [collection.jsonPath, collection.candidates[0]]) {
      const target = enhancedPath(original);
      if (fs.existsSync(target) && (!overwriteGenerated || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) {
        throw new Error('Existing enhanced output requires confirmation and must be a regular file');
      }
    }
  }

  let database, lock, service, provider;
  lock = acquireInstanceLock(filename);
  try {
    const identity = await identityFactory({ modelDir: model, ffmpegPath });
    database = new AudioCacheDatabase(filename);
    provider = providerFactory({ modelDir: model }); // Existing provider initializes its model only on first transcribe().
    service = new AudioCacheService({ database, identity, provider, workDir: work, ffmpegPath });
    const configuration = { normalizerKey: identity.normalizerKey, recognizerKey: identity.recognizerKey };
    report.configuration = { ...configuration, modelFingerprintFilesRead: identity.modelFingerprintFilesRead ?? null,
      ffmpegVersionQueries: identityFactory === createCacheIdentity ? 1 : null };
    fs.mkdirSync(output, { recursive: true });
    for (const collection of collections.values()) {
      lock.assertOwned();
      const entry = { platform: collection.platform, status: 'running', phase: 'scan' };
      report.sources.push(entry);
      try {
        onProgress({ phase: 'scan', platform: collection.platform });
        const scans = await scanExports({ inputPath: collection.jsonPath, database, identity, lock, excludeGenerated: true });
        entry.scan = scanStatistics(scans[0]); entry.exportId = entry.scan.exportId;
        if (scans.length !== 1 || entry.scan.status !== 'completed') throw Object.assign(new Error('Collection scan failed'), { code: 'SCAN_FAILED' });
        if (!entry.scan.fragments) { entry.status = 'skipped-no-audio'; entry.phase = 'done'; continue; }
        const source = database.connection.prepare('SELECT * FROM exports WHERE id=?').get(entry.exportId);
        const destination = path.join(output, collection.platform, `source-${entry.exportId}`);
        const jsonDirectory = sameDirectory ? source.source_root : path.join(destination, 'json');
        const htmlDirectory = sameDirectory ? source.source_root : path.join(destination, 'html');
        entry.phase = 'output-preflight';
        // Refuse foreign/edited output before starting any audio work.
        for (const [directory, kind] of [[jsonDirectory, 'json'], [htmlDirectory, 'html']]) {
          if (!sameDirectory && fs.existsSync(directory)) ownedOutput(directory, source, kind);
        }
        entry.phase = 'processing';
        const existing = database.connection.prepare(`SELECT j.status,count(*) n FROM jobs j JOIN message_parts m ON m.id=j.message_part_id
          WHERE m.export_id=? AND m.source_presence_status='present' AND m.raw_hash=j.input_raw_hash
          AND j.normalizer_key=? AND j.recognizer_key=? GROUP BY j.status`).all(entry.exportId, identity.normalizerKey, identity.recognizerKey);
        const already = existing.find(r => r.status === 'succeeded')?.n || 0;
        const unavailable = ['missing_audio', 'ambiguous_audio', 'unresolved_audio_path'].reduce((n, key) => n + (entry.scan[key] || 0), 0);
        const failed = (existing.find(r => r.status === 'failed')?.n || 0) + unavailable;
        const progressEvent = progress => onProgress({ exportId: entry.exportId, phase: 'processing', ...progress,
          total: entry.scan.fragments, processed: already + failed + (progress.succeeded || 0) + (progress.failed || 0),
          cacheHits: already + (progress.raw_cache || 0) + (progress.pcm_cache || 0),
          asrSuccess: progress.asr || 0, failures: failed + (progress.failed || 0) });
        progressEvent({});
        entry.processing = await runPending({ database, service, lock, exportId: entry.exportId,
          onProgress: progressEvent });
        progressEvent(entry.processing);
        if (entry.processing.stopped) { entry.status = 'stopped'; report.status = 'stopped'; break; }
        const options = { databasePath: filename, exportId: entry.exportId, ...configuration, workDirectory: work,
          modelDirectory: model, overwriteGenerated: sameDirectory ? overwriteGenerated : true, sameDirectory };
        entry.phase = 'json';
        onProgress({ exportId: entry.exportId, phase: 'json', status: 'running' });
        entry.json = exportJson({ ...options, outputDirectory: jsonDirectory });
        onProgress({ exportId: entry.exportId, phase: 'json', status: 'completed' });
        if (entry.json.conflictCount) throw Object.assign(new Error('JSON field conflict'), { code: 'JSON_CONFLICT' });
        entry.phase = 'html';
        onProgress({ exportId: entry.exportId, phase: 'html', status: 'running' });
        entry.html = exportHtml({ ...options, outputDirectory: htmlDirectory,
          onEstimate: estimate => onProgress({ exportId: entry.exportId, phase: 'media-estimate', ...estimate }) });
        onProgress({ exportId: entry.exportId, phase: 'html', status: 'completed' });
        entry.status = entry.processing.failed || entry.json.failed || entry.json.pending || entry.json.missing_audio
          || entry.json.ambiguous_audio || entry.json.unresolved_audio_path ? 'partial' : 'completed';
        entry.phase = 'done';
      } catch (error) {
        entry.status = 'failed'; entry.errorCode = String(error.code || 'WORKFLOW_FAILED');
        entry.errorMessage = error instanceof SyntaxError ? 'Malformed source data; JSON text omitted' : error.message;
      }
      onProgress({ exportId: entry.exportId, phase: entry.phase, status: entry.status });
    }
    if (report.status !== 'stopped') report.status = report.sources.some(s => ['failed', 'partial'].includes(s.status)) ? 'partial' : 'completed';
    Object.assign(report.calls, service.stats, { modelInitializations: provider.stats?.modelInitializations || 0 });
    report.finishedAt = new Date().toISOString();
    report.completedCollections = report.sources.filter(s => s.status === 'completed').length;
    report.failedCollections = report.sources.filter(s => ['failed', 'partial'].includes(s.status)).length;
    report.skippedCollections = report.sources.filter(s => s.status === 'skipped-no-audio').length;
    report.unprocessedCollections = collections.size - report.sources.length;
    Object.assign(report.totals, {
      success: report.sources.reduce((n, s) => n + (s.json?.success || 0), 0),
      resourceFiles: report.sources.reduce((n, s) => n + (s.html?.resourceFiles || 0), 0),
      resourceBytes: report.sources.reduce((n, s) => n + (s.html?.resourceBytes || 0), 0)
    });
    lock.assertOwned();
    const reportPath = path.join(output, `workflow-report-${report.startedAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return { ...report, reportPath };
  } finally {
    try { database?.close(); } finally { lock.release(); }
  }
}
