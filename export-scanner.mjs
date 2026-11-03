import fs from 'node:fs';
import path from 'node:path';
import { scanQce, readInlineQce } from './qce.mjs';
import { readWeFlowAudio } from './weflow.mjs';
import { sha256 } from './cache-identity.mjs';
import { isWithin, resolveExportAudio } from './paths.mjs';
import { JobQueue } from './job-queue.mjs';
import { detectAudioFormat } from './audio-core.mjs';

// Read only a JSON array literal. Never evaluate HTML JavaScript.
export function readWeFlowHtml(html) {
  const match = /window\.WEFLOW_DATA\s*=\s*\[/.exec(html);
  if (!match) throw new Error('Missing WEFLOW_DATA array');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quoted) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { if (--depth === 0) return JSON.parse(html.slice(start, i + 1)); }
  }
  throw new Error('Truncated WEFLOW_DATA');
}

function collectionFiles(inputPath, excludeGenerated) {
  const absolute = path.resolve(inputPath);
  const files = [];
  const generated = name => /\.enhanced\.(json|html)$/i.test(name) || name.startsWith('.chat-audio-');
  function visit(directory) {
    if (excludeGenerated && fs.existsSync(path.join(directory, 'chat-audio-transcriber-manifest.json'))) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excludeGenerated && generated(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && !['resources', 'media', 'work', 'cache', 'node_modules', '.git'].includes(entry.name)) visit(filename);
      else if (entry.isFile() && /\.(json|html)$/i.test(entry.name)) files.push(filename);
    }
  }
  const singleFile = fs.statSync(absolute).isFile();
  if (singleFile) {
    if (excludeGenerated && generated(path.basename(absolute))) throw new Error('Generated output cannot be used as workflow input');
    if (excludeGenerated && fs.existsSync(path.join(path.dirname(absolute), 'chat-audio-transcriber-manifest.json'))) throw new Error('Generated output cannot be used as workflow input');
    for (const name of fs.readdirSync(path.dirname(absolute))) if (/\.(json|html)$/i.test(name) && !(excludeGenerated && generated(name))) files.push(path.join(path.dirname(absolute), name));
  } else visit(absolute);
  return { files, selectedFile: singleFile ? absolute : null };
}
const weKey = (id, platformId) => `${id}\0${platformId || ''}`;
function equalIds(left, right) {
  const rightSet = new Set(right);
  return left.length === right.length && new Set(left).size === left.length && rightSet.size === right.length
    && left.every(id => rightSet.has(id));
}

export function discoverExports(inputPath, { excludeGenerated = false } = {}) {
  const { files, selectedFile } = collectionFiles(inputPath, excludeGenerated);
  const collections = [], errors = [];
  for (const jsonPath of files.filter(f => f.endsWith('.json') && (!selectedFile || !selectedFile.endsWith('.json') || f === selectedFile))) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch (error) { errors.push({ file: jsonPath, code: 'INVALID_JSON', message: error.message }); continue; }
    const platform = doc.metadata?.name === 'QQChatExporter' && doc.metadata.version === '0.1.0' ? 'qq'
      : doc.weflow?.version === '1.0.3' ? 'wechat' : null;
    if (!platform) continue;
    if (excludeGenerated && doc.messages?.some(m => m.transcription?.generatedBy === 'ChatAudioTranscriber')) {
      errors.push({ file: jsonPath, code: 'GENERATED_INPUT', message: 'Enhanced JSON is not an original export' }); continue;
    }
    const htmls = files.filter(f => f.endsWith('.html') && path.dirname(f) === path.dirname(jsonPath));
    const candidates = htmls.filter(filename => {
      try {
        const html = fs.readFileSync(filename, 'utf8');
        if (platform === 'qq') {
          if (doc.messages.some(m => typeof m.id !== 'string')) throw new Error('QQ IDs must remain strings');
          const inline = readInlineQce(html);
          return equalIds(doc.messages.map(m => `msg-${m.id}`), inline.chunks.flatMap(c => c.messages.map(m => m.id)));
        }
        return equalIds(doc.messages.map(m => weKey(m.localId, m.platformMessageId)),
          readWeFlowHtml(html).map(m => weKey(m.i, m.p)));
      } catch { return false; }
    });
    if (selectedFile?.endsWith('.html') && !candidates.includes(selectedFile)) continue;
    collections.push({ jsonPath, doc, platform, candidates, source: {
      platform, sourceRoot: path.dirname(jsonPath),
      accountScope: platform === 'qq' ? doc.chatInfo?.selfUid ?? '' : '',
      chatScope: platform === 'qq' ? doc.chatInfo?.peerUid ?? '' : doc.session?.wxid ?? '',
      schemaVersion: platform === 'qq' ? doc.metadata.version : doc.weflow.version
    } });
  }
  return { collections, errors };
}

function partsFor(collection) {
  const { doc, platform, candidates, jsonPath } = collection;
  if (candidates.length !== 1) {
    const availability = candidates.length > 1 ? 'ambiguous_audio' : 'unresolved_audio_path';
    return doc.messages.flatMap((m, jsonIndex) => {
      const parts = platform === 'qq' ? (m.content?.elements ?? []).filter(e => e.type === 'audio') : m.localType === 34 ? [{}] : [];
      return parts.map((_, partIndex) => ({ message: { messageId: platform === 'qq' ? m.id : m.platformMessageId,
        localId: m.localId, partIndex, sourceLocator: { jsonIndex } }, audioRelativePath: '', availabilityStatus: availability }));
    });
  }
  const htmlPath = candidates[0];
  if (platform === 'qq') return scanQce(jsonPath, htmlPath, { inspectAudio: false }).records.map(r => {
    if (r.chunkId !== r.indexChunkId) throw new Error('QCE chunk/index mismatch');
    const message = doc.messages[r.jsonIndex];
    return { message: { messageId: r.messageId, partIndex: r.partIndex, sender: message.sender,
      timestampRaw: message.timestamp, sourceLocator: { jsonIndex: r.jsonIndex, htmlId: r.htmlId,
        chunkId: r.chunkId, chunkOffset: r.chunkOffset, indexChunkId: r.indexChunkId, jsonPath, htmlPath } },
      audioRelativePath: r.relativeAudioPath ?? '', availabilityStatus: r.status };
  });
  const renderRecords = readWeFlowHtml(fs.readFileSync(htmlPath, 'utf8'));
  return readWeFlowAudio(jsonPath, { allowMissingPaths: true }).map(r => {
    const candidates = renderRecords.filter(m => weKey(m.i, m.p) === weKey(r.localId, r.messageId));
    const srcs = candidates.flatMap(m => [...m.b.matchAll(/<audio\b[^>]*\bsrc="([^"]*)"/g)].map(match => match[1]));
    let status = !r.audioPath ? 'unresolved_audio_path' : !fs.existsSync(r.audioPath) ? 'missing_audio' : 'ready';
    if (srcs.length !== 1) status = srcs.length > 1 ? 'ambiguous_audio' : 'unresolved_audio_path';
    else {
      let src = srcs[0];
      if (src !== r.relativeAudioPath) { try { src = decodeURIComponent(src); } catch { status = 'unresolved_audio_path'; } }
      resolveExportAudio(path.dirname(htmlPath), src);
      if (src !== r.relativeAudioPath) status = 'ambiguous_audio';
    }
    return { message: { messageId: r.messageId, localId: r.localId, partIndex: r.partIndex,
      sender: r.sender, timestampRaw: r.timestampRaw, sourceLocator: { jsonIndex: r.jsonIndex,
        localId: r.localId, platformMessageId: r.messageId ?? null, jsonPath, htmlPath } },
      audioRelativePath: r.relativeAudioPath, availabilityStatus: status };
  });
}

export async function scanExports({ inputPath, database, identity, lock, dryRun = false, excludeGenerated = false, onPart = async () => {} }) {
  if (!dryRun) lock.assertOwned();
  const discovered = discoverExports(inputPath, { excludeGenerated });
  // Multiple JSON snapshots of one source cannot each declare the other's messages stale.
  const scopeKey = c => JSON.stringify([c.platform, fs.realpathSync(c.source.sourceRoot), c.source.accountScope, c.source.chatScope]);
  const scopeCounts = new Map();
  for (const c of discovered.collections) scopeCounts.set(scopeKey(c), (scopeCounts.get(scopeKey(c)) || 0) + 1);
  const summaries = [...discovered.errors];
  const queue = database && new JobQueue(database);
  for (const collection of discovered.collections) {
    let exportId, scanId;
    const summary = { platform: collection.platform, messageCount: collection.doc.messages.length,
      audioMessages: 0, fragments: 0, ready: 0, missing_audio: 0, ambiguous_audio: 0, unresolved_audio_path: 0 };
    try {
      if (!dryRun) {
        if (isWithin(fs.realpathSync(collection.source.sourceRoot), database.filename)) throw new Error('Database must be outside export directory');
        exportId = database.transaction(() => database.registerSource(collection.source));
        scanId = database.transaction(() => database.connection.prepare(`INSERT INTO scan_runs(export_id,generation,status)
          SELECT ?,coalesce(max(generation),0)+1,'running' FROM scan_runs WHERE export_id=? RETURNING id`).get(exportId, exportId).id);
      }
      if (scopeCounts.get(scopeKey(collection)) > 1) throw new Error('Multiple JSON exports share one source scope; select a single JSON file');
      const parts = partsFor(collection);
      const observed = [];
      summary.audioMessages = new Set(parts.map(p => p.message.messageId ?? `local:${p.message.localId}`)).size;
      summary.fragments = parts.length;
      for (const part of parts) {
        summary[part.availabilityStatus]++;
        if (!dryRun) {
          lock.assertOwned();
          const input = { source: collection.source, message: part.message, audioRelativePath: part.audioRelativePath };
          let asset = null;
          if (part.availabilityStatus === 'ready') {
            const bytes = fs.readFileSync(resolveExportAudio(collection.source.sourceRoot, part.audioRelativePath));
            let detectedFormat;
            try { detectedFormat = detectAudioFormat(bytes).format; } catch { detectedFormat = 'unknown'; }
            asset = { rawHash: sha256(bytes), byteSize: bytes.length, detectedFormat };
          }
          observed.push({ part, input, asset });
          await onPart({ ...part, exportId });
        }
      }
      for (const entry of observed) {
        entry.partId = database.recordInput(entry.input, entry.asset);
        database.transaction(() => database.connection.prepare('UPDATE message_parts SET scan_availability=? WHERE id=?').run(entry.part.availabilityStatus, entry.partId));
      }
      if (collection.candidates.length !== 1) throw new Error(`HTML pairing candidates: ${collection.candidates.length}`);
      if (!dryRun) {
        lock.assertOwned();
        database.transaction(() => {
          for (const entry of observed) {
            database.connection.prepare('UPDATE message_parts SET last_seen_scan_id=? WHERE id=?').run(scanId, entry.partId);
            if (entry.asset) queue.enqueue(entry.partId, entry.asset.rawHash, identity, entry.input);
          }
          database.connection.prepare(`UPDATE message_parts SET source_presence_status=
            CASE WHEN last_seen_scan_id=? THEN 'present' ELSE 'stale_source' END WHERE export_id=?`).run(scanId, exportId);
          database.connection.prepare(`UPDATE scan_runs SET status='completed',completed_at=CURRENT_TIMESTAMP,summary_json=? WHERE id=?`).run(JSON.stringify(summary), scanId);
        });
      }
      summaries.push({ ...summary, exportId, scanId, status: 'completed' });
    } catch (error) {
      if (!dryRun && scanId) database.transaction(() => database.connection.prepare(`UPDATE scan_runs SET status='failed',completed_at=CURRENT_TIMESTAMP,
        error_code=?,error_message=? WHERE id=?`).run(String(error.code || 'SCAN_FAILED'), error.message, scanId));
      if (String(error.code).startsWith('ERR_SQLITE')) throw error;
      summaries.push({ ...summary, exportId, scanId, status: 'failed', error: error.message });
    }
  }
  return summaries;
}
