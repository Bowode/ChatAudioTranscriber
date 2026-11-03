import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isWithin } from './paths.mjs';
import { hash, realTarget, overlaps, ownedOutput, publish } from './json-exporter.mjs';
import { parseLossless, fieldConflicts } from './json-preserver.mjs';
import { locateRows, selectConfiguration } from './transcription-mapper.mjs';
import { parsePage, elements, attr, editsTo } from './html-data.mjs';
import { css } from './html-transcription-renderer.mjs';
import { enhanceQce } from './qce-html-adapter.mjs';
import { enhanceWeFlow } from './weflow-html-adapter.mjs';
import { MediaPlan } from './media-copier.mjs';
import { enhancedPath, publishSiblings } from './sibling-publisher.mjs';

export function exportHtml({ databasePath = process.env.CHAT_AUDIO_DB_PATH || 'cache/asr.sqlite', exportId,
  outputDirectory, normalizerKey, recognizerKey, dryRun = false, overwriteGenerated = false, sameDirectory = false,
  workDirectory = process.env.CHAT_AUDIO_WORK_DIR || 'work/batch',
  modelDirectory = process.env.SENSEVOICE_MODEL_DIR || 'models/sensevoice', onEstimate = () => {} }) {
  if (!Number.isSafeInteger(exportId) || exportId <= 0 || !outputDirectory) throw new Error('An explicit positive --source and --output are required');
  const output = realTarget(outputDirectory), databaseFile = fs.realpathSync(databasePath);
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  let snapshotOpen = false;
  try {
    db.exec('BEGIN'); snapshotOpen = true;
    if (db.prepare('PRAGMA user_version').get().user_version !== 2) throw new Error('HTML export requires schema v2; no migration performed');
    const source = db.prepare('SELECT * FROM exports WHERE id=?').get(exportId);
    if (!source) throw new Error('Unknown export source');
    const root = fs.realpathSync(source.source_root);
    if (!sameDirectory && [root, path.dirname(databaseFile), realTarget(workDirectory), realTarget(modelDirectory)].some(p => overlaps(p, output))) throw new Error('HTML output must be separate from source/database/work/model directories');
    if (sameDirectory && output !== root) throw new Error('Sibling output must use the original source directory');
    if (db.prepare("SELECT id FROM scan_runs WHERE export_id=? AND status='running' LIMIT 1").get(exportId)) throw new Error('Source scan is running');
    const rows = db.prepare("SELECT * FROM message_parts WHERE export_id=? AND source_presence_status='present' ORDER BY message_key,part_index").all(exportId);
    if (!rows.length) throw new Error('No present registered fragments');
    const configuration = selectConfiguration(db, exportId, { normalizerKey, recognizerKey });
    const groups = new Map();
    for (const row of rows) {
      const locator = JSON.parse(row.source_locator_json);
      if (!locator.jsonPath || !locator.htmlPath) throw new Error('Original JSON/HTML source locator is missing; rescan first');
      const jsonPath = fs.realpathSync(locator.jsonPath), htmlPath = fs.realpathSync(locator.htmlPath);
      if (!isWithin(root, jsonPath) || !isWithin(root, htmlPath)) throw new Error('HTML/JSON source locator escapes source directory');
      if (!groups.has(htmlPath)) groups.set(htmlPath, { jsonPath, rows: [] });
      if (groups.get(htmlPath).jsonPath !== jsonPath) throw new Error('Ambiguous JSON to HTML registration');
      groups.get(htmlPath).rows.push(row);
    }
    // Same-directory mode preserves every original URL and never visits/copies media.
    const media = sameDirectory ? { rewriteHtml: html => html, reference: value => value, addTree() {},
      finish: () => ({ resources: [], missing: [], external: [], count: 0, totalBytes: 0 }) } : new MediaPlan(root);
    const files = [], originals = [], documents = [];
    const summary = { platform: source.platform, exportId, htmlFiles: groups.size, jsonFiles: groups.size,
      voiceMessages: 0, fragments: 0, success: 0, empty_result: 0, failed: 0, missing_audio: 0,
      ambiguous_audio: 0, unresolved_audio_path: 0, pending: 0, transcriptionBlocks: 0, searchUpdates: 0,
      conflictCount: 0, ...configuration, outputPath: output };
    for (const [htmlPath, group] of groups) {
      const originalJson = fs.readFileSync(group.jsonPath), originalHtml = fs.readFileSync(htmlPath);
      const document = parseLossless(originalJson.toString('utf8'));
      const matches = locateRows(document, source, group.rows, configuration, db);
      let html = originalHtml.toString('utf8'), page = parsePage(html);
      if (elements(page, n => n.tagName === 'meta' && attr(n, 'name') === 'chat-audio-transcriber').length) throw new Error('Enhanced HTML is not an original input');
      for (const match of matches) {
        summary.conflictCount += fieldConflicts(match.message).length;
        summary.voiceMessages++; summary.fragments += match.count; summary.transcriptionBlocks += match.count;
        for (const part of match.transcription.parts) summary[part.status]++;
      }
      if (summary.conflictCount) throw new Error('Original JSON contains transcription ownership conflicts');
      const enhanced = source.platform === 'qq' ? enhanceQce(html, page, document, group.rows, matches, media)
        : enhanceWeFlow(html, page, document, group.rows, matches, media);
      for (const directory of enhanced.resourceRoots) media.addTree(directory);
      html = media.rewriteHtml(enhanced.html, true);
      page = parsePage(html);
      const head = elements(page, n => n.tagName === 'head')[0];
      const at = head?.sourceCodeLocation?.endTag?.startOffset;
      if (!Number.isSafeInteger(at)) throw new Error('Unsupported viewer document head');
      html = editsTo(html, [{ start: at, end: at, value: `<meta name="chat-audio-transcriber" content="1"><style data-cat-style="1">${css}</style>` }]);
      // Final parse verifies structure without executing any original scripts.
      if (elements(parsePage(html), n => n.tagName === 'meta' && attr(n, 'name') === 'chat-audio-transcriber').length !== 1) throw new Error('Invalid generated HTML marker');
      const name = `${path.basename(htmlPath, '.html')}.enhanced.html`;
      if (files.some(f => f.name === name)) throw new Error('HTML output filename collision');
      const bytes = Buffer.from(html);
      files.push({ name, bytes, original: htmlPath, target: enhancedPath(htmlPath) });
      documents.push({ originalJson: path.relative(root, group.jsonPath).replaceAll('\\', '/'), originalJsonSha256: hash(originalJson),
        originalHtml: path.relative(root, htmlPath).replaceAll('\\', '/'), originalHtmlSha256: hash(originalHtml), outputHtml: name,
        outputHtmlSha256: hash(bytes), searchIndex: enhanced.evidence });
      originals.push({ path: group.jsonPath, digest: hash(originalJson) }, { path: htmlPath, digest: hash(originalHtml) });
      summary.searchUpdates += enhanced.searchUpdates;
    }
    const plan = media.finish();
    Object.assign(summary, { resourceFiles: plan.count, resourceBytes: plan.totalBytes, missingResources: plan.missing.length,
      ambiguousResources: 0, externalResources: plan.external.length });
    if (!sameDirectory && fs.existsSync(output)) {
      if (!overwriteGenerated) throw new Error('Output already exists; refusing overwrite');
      ownedOutput(output, source, 'html');
    }
    for (const original of originals) if (hash(fs.readFileSync(original.path)) !== original.digest) throw new Error('Original export changed during generation');
    const copyResults = plan.resources.map(r => ({ originalRelativePath: r.relative, outputRelativePath: r.relative,
      bytes: r.size, sha256: r.sha256, status: 'copied-and-verified' }));
    const manifest = { schemaVersion: 1, generatedBy: 'ChatAudioTranscriber', programVersion: '1.0.0', outputKind: 'html',
      exportId, sourceKey: source.source_key, platform: source.platform, ...configuration,
      documents, transcriptionMessages: summary.voiceMessages, transcriptionFragments: summary.fragments,
      resourceFiles: plan.count, resourceBytes: plan.totalBytes, resources: copyResults,
      missingResources: plan.missing, externalDependencies: plan.external, searchIndexUpdated: true,
      files: [...files.map(f => ({ outputPath: f.name, outputSha256: hash(f.bytes) })),
        ...plan.resources.map(r => ({ outputPath: r.relative, outputSha256: r.sha256 }))] };
    db.exec('COMMIT'); snapshotOpen = false;
    if (dryRun) return { ...summary, dryRun: true, resourceWarnings: { missing: plan.missing, external: plan.external } };
    onEstimate({ files: plan.count, bytes: plan.totalBytes, missing: plan.missing.length, external: plan.external.length });
    if (sameDirectory) return { ...summary, dryRun: false, mediaMode: 'reuse-original',
      ...publishSiblings(files, files.map(f => f.original), overwriteGenerated) };
    const copyFiles = plan.resources.map(r => ({ name: r.relative, sourcePath: r.sourcePath, expectedHash: r.sha256 }));
    return { ...summary, dryRun: false, ...publish([...files, ...copyFiles], manifest, output, source, overwriteGenerated, 'html') };
  } finally { if (snapshotOpen) db.exec('ROLLBACK'); db.close(); }
}
