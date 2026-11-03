import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isWithin } from './paths.mjs';
import { parseLossless, stringifyLossless, fieldConflicts, assertOriginalFields } from './json-preserver.mjs';
import { locateRows, selectConfiguration } from './transcription-mapper.mjs';
import { buildAiText } from './ai-text-builder.mjs';
import { enhancedPath, publishSiblings } from './sibling-publisher.mjs';

const manifestName = 'chat-audio-transcriber-manifest.json';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);
export const outputPathKey = relative => process.platform === 'win32' ? path.normalize(relative).toLowerCase() : path.normalize(relative);
export function realTarget(filename) {
  const tail = [];
  let current = path.resolve(filename);
  while (!fs.existsSync(current)) { tail.unshift(path.basename(current)); current = path.dirname(current); }
  return path.join(fs.realpathSync(current), ...tail);
}
export function digestFile(filename) {
  const digest = createHash('sha256'), buffer = Buffer.alloc(512 * 1024);
  const fd = fs.openSync(filename, 'r');
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function validRelative(name) {
  return typeof name === 'string' && name && !name.includes('\\') && !name.includes(':')
    && !name.includes('\0') && !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..');
}
function directoryEntries(directory, prefix = '') {
  const entries = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    entries.push(name + (entry.isDirectory() ? '/' : ''));
    if (entry.isDirectory()) entries.push(...directoryEntries(path.join(directory, entry.name), `${name}/`));
    else if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Output contains a symlink or non-file resource');
  }
  return entries;
}
function ownedNames(manifest) {
  const names = manifest.files.map(f => f.outputJson || f.outputPath);
  if (new Set(names).size !== names.length || names.some(n => !validRelative(n) || n === manifestName)) throw new Error('Invalid generated output manifest');
  return names;
}
export function ownedOutput(directory, source, outputKind = 'json') {
  if (!fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Output must be a regular generated directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, manifestName), 'utf8'));
  if (manifest.generatedBy !== 'ChatAudioTranscriber' || manifest.schemaVersion !== 1 || manifest.exportId !== source.id
    || manifest.sourceKey !== source.source_key || (manifest.outputKind || 'json') !== outputKind
    || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Output manifest does not identify a supported generated copy of this source');
  const names = ownedNames(manifest), expected = new Set([...names, manifestName]);
  for (const name of names) { let parent = path.posix.dirname(name); while (parent !== '.') { expected.add(`${parent}/`); parent = path.posix.dirname(parent); } }
  if (directoryEntries(directory).sort().join('\0') !== [...expected].sort().join('\0')) throw new Error('Output contains unrelated files; refusing replacement');
  for (const file of manifest.files) {
    const filename = path.join(directory, file.outputJson || file.outputPath);
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()
      || digestFile(filename) !== file.outputSha256) throw new Error('Existing generated JSON/resource was modified; refusing replacement');
  }
  return manifest;
}

export function publish(files, manifest, output, source, overwriteGenerated, outputKind = 'json') {
  const plannedNames = new Set();
  for (const file of files) {
    if (!validRelative(file.name) || file.name === manifestName) throw new Error('Invalid staged filename');
    const key = outputPathKey(file.name);
    if (plannedNames.has(key)) throw Object.assign(new Error(`Output resource path conflict: ${file.name}`), { code: 'OUTPUT_PATH_CONFLICT' });
    plannedNames.add(key);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(output), '.chat-audio-json-stage-'));
  let backup;
  try {
    for (const file of files) {
      const target = path.join(stage, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (file.sourcePath) {
        fs.copyFileSync(file.sourcePath, target, fs.constants.COPYFILE_EXCL);
        if (digestFile(file.sourcePath) !== file.expectedHash || digestFile(target) !== file.expectedHash) throw new Error('Resource changed or copied with different content');
      } else fs.writeFileSync(target, file.bytes, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(stage, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    // Fully staged and validated before the visible output directory is touched.
    if (fs.existsSync(output)) {
      if (!overwriteGenerated) throw new Error('Output already exists; refusing overwrite');
      ownedOutput(output, source, outputKind);
      backup = `${output}.previous-${randomUUID()}`;
      fs.renameSync(output, backup);
    }
    try { fs.renameSync(stage, output); }
    catch (error) { if (backup) fs.renameSync(backup, output); backup = null; throw error; }
    if (backup) {
      // Never recursively delete a directory that might contain user additions.
      try {
        const old = ownedOutput(backup, source, outputKind);
        for (const name of ownedNames(old)) fs.unlinkSync(path.join(backup, name));
        fs.unlinkSync(path.join(backup, manifestName));
        for (const directory of directoryEntries(backup).filter(name => name.endsWith('/')).sort((a, b) => b.length - a.length)) fs.rmdirSync(path.join(backup, directory));
        fs.rmdirSync(backup); backup = null;
      } catch { /* Preserve the backup if its contents changed or cleanup failed. */ }
    }
    return { previousOutputRetained: backup || null };
  } finally {
    if (fs.existsSync(stage)) {
      if (path.dirname(stage) !== path.dirname(output) || !path.basename(stage).startsWith('.chat-audio-json-stage-')) throw new Error('Invalid temporary output cleanup target');
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}

export function exportJson({ databasePath = process.env.CHAT_AUDIO_DB_PATH || 'cache/asr.sqlite', exportId,
  outputDirectory, inputPath, normalizerKey, recognizerKey, dryRun = false, overwriteGenerated = false, sameDirectory = false,
  workDirectory = process.env.CHAT_AUDIO_WORK_DIR || 'work/batch' }) {
  if (!Number.isSafeInteger(exportId) || exportId <= 0 || !outputDirectory) throw new Error('An explicit positive --source and --output are required');
  const output = realTarget(outputDirectory);
  const filename = fs.realpathSync(databasePath);
  const db = new DatabaseSync(filename, { readOnly: true });
  let snapshotOpen = false;
  try {
    db.exec('BEGIN'); snapshotOpen = true;
    if (db.prepare('PRAGMA user_version').get().user_version !== 2) throw new Error('JSON export requires schema v2; no migration will be performed');
    const source = db.prepare('SELECT * FROM exports WHERE id=?').get(exportId);
    if (!source) throw new Error('Unknown export source');
    const root = fs.realpathSync(source.source_root);
    if (!sameDirectory && [root, path.dirname(filename), realTarget(workDirectory)].some(protectedPath => overlaps(protectedPath, output))) throw new Error('Output must be separate from source, database and processing work directories');
    if (sameDirectory && output !== root) throw new Error('Sibling output must use the original source directory');
    if (db.prepare("SELECT id FROM scan_runs WHERE export_id=? AND status='running' LIMIT 1").get(exportId)) throw new Error('Source scan is still running; wait for it to complete');
    const rows = db.prepare("SELECT * FROM message_parts WHERE export_id=? AND source_presence_status='present' ORDER BY message_key,part_index").all(exportId);
    if (!rows.length) throw new Error('Source has no present registered audio fragments');
    const configuration = selectConfiguration(db, exportId, { normalizerKey, recognizerKey });
    const grouped = new Map();
    for (const row of rows) {
      const locator = JSON.parse(row.source_locator_json);
      if (!locator.jsonPath) throw new Error('A registered JSON source locator is missing; rescan before export');
      const jsonPath = fs.realpathSync(locator.jsonPath);
      if (!isWithin(root, jsonPath)) throw new Error('JSON source locator escapes the export directory');
      if (!grouped.has(jsonPath)) grouped.set(jsonPath, []);
      grouped.get(jsonPath).push(row);
    }
    if (inputPath && (grouped.size !== 1 || !grouped.has(fs.realpathSync(inputPath)))) throw new Error('--input must be the registered original JSON; enhanced copies cannot be reused as input');
    const summary = { platform: source.platform, exportId, jsonFiles: grouped.size, voiceMessages: 0, fragments: 0,
      success: 0, empty_result: 0, failed: 0, missing_audio: 0, ambiguous_audio: 0, unresolved_audio_path: 0,
      pending: 0, newFields: 0, generatedFields: 0, conflictCount: 0, outputPath: output, ...configuration };
    const files = [], manifestFiles = [], originals = [];
    for (const [jsonPath, parts] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const originalBytes = fs.readFileSync(jsonPath);
      const original = parseLossless(originalBytes.toString('utf8'));
      const document = parseLossless(originalBytes.toString('utf8'));
      const matches = locateRows(document, source, parts, configuration, db);
      const indices = [];
      for (const match of matches) {
        summary.voiceMessages++; summary.fragments += match.count; summary.generatedFields += 2;
        summary.newFields += ['transcription', 'ai_text'].filter(key => !Object.hasOwn(match.message, key)).length;
        summary.conflictCount += fieldConflicts(match.message).length;
        for (const part of match.transcription.parts) summary[part.status]++;
        match.message.transcription = match.transcription;
        match.message.ai_text = buildAiText(match.message, source.platform, match.transcription.parts);
        indices.push(match.index);
      }
      const bytes = Buffer.from(stringifyLossless(document));
      assertOriginalFields(original, parseLossless(bytes.toString('utf8')), indices);
      const name = `${path.basename(jsonPath, '.json')}.enhanced.json`;
      if (files.some(file => file.name === name)) throw new Error('Output JSON filename collision');
      files.push({ name, bytes, original: jsonPath, target: enhancedPath(jsonPath) });
      manifestFiles.push({ originalJson: path.relative(root, jsonPath).replaceAll('\\', '/'), originalSha256: hash(originalBytes),
        outputJson: name, outputSha256: hash(bytes) });
      originals.push({ jsonPath, expectedHash: hash(originalBytes) });
    }
    if (!sameDirectory && fs.existsSync(output)) {
      if (!overwriteGenerated) throw new Error('Output already exists; refusing overwrite');
      ownedOutput(output, source);
    }
    // No filesystem changes in preview, even when reporting user-owned field conflicts.
    if (summary.conflictCount && !dryRun) throw new Error(`Refusing ${summary.conflictCount} user/third-party field conflicts`);
    for (const original of originals) if (hash(fs.readFileSync(original.jsonPath)) !== original.expectedHash) throw new Error('Original JSON changed during export');
    const { outputPath, ...manifestStatistics } = summary;
    const manifest = { schemaVersion: 1, generatedBy: 'ChatAudioTranscriber', programVersion: '1.0.0',
      exportId, sourceKey: source.source_key, platform: source.platform, ...configuration,
      files: manifestFiles, statistics: manifestStatistics };
    db.exec('COMMIT'); snapshotOpen = false;
    if (sameDirectory) return dryRun ? { ...summary, dryRun: true }
      : { ...summary, dryRun: false, ...publishSiblings(files, originals.map(o => o.jsonPath), overwriteGenerated) };
    return dryRun ? { ...summary, dryRun: true }
      : { ...summary, dryRun: false, ...publish(files, manifest, output, source, overwriteGenerated) };
  } finally {
    if (snapshotOpen) db.exec('ROLLBACK');
    db.close();
  }
}
