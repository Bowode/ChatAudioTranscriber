import { elements, text, parseData, safeJson, scriptEdit, editsTo, fragment, hasClass, attr } from './html-data.mjs';
import { injectByNodes } from './html-transcription-renderer.mjs';
import { textBloom } from './qce-bloom.mjs';
import { messageKey } from './transcription-mapper.mjs';

export function readQcePage(page) {
  let manifest, manifestNode;
  const chunks = [], index = new Map();
  for (const node of elements(page, n => n.tagName === 'script')) {
    const body = text(node).trim();
    if (body.startsWith('window.__QCE_MANIFEST__ &&')) {
      if (manifest) throw new Error('Ambiguous QCE manifest');
      manifest = parseData(body.slice(body.indexOf('(', body.indexOf('&&')) + 1, body.lastIndexOf(')'))); manifestNode = node;
    } else if (body.startsWith('window.__QCE_CHUNK__ &&')) {
      const match = body.match(/^window\.__QCE_CHUNK__ && window\.__QCE_CHUNK__\(\{id:("[^"\n]+"),messages:([\s\S]*)\}\);$/);
      if (!match) throw new Error('Unsupported QCE inline chunk envelope');
      chunks.push({ id: parseData(match[1]), messages: parseData(match[2]), node });
    } else if (body.startsWith('window.__QCE_MSGID_INDEX__ &&')) {
      const match = body.match(/^window\.__QCE_MSGID_INDEX__ && window\.__QCE_MSGID_INDEX__\(\d+,\s*([\s\S]*)\);$/);
      if (!match) throw new Error('Unsupported QCE inline index');
      for (const [id, chunkId] of parseData(match[1])) {
        if (index.has(id)) throw new Error('Duplicate QCE index identity'); index.set(id, chunkId);
      }
    }
  }
  if (manifest?.format !== 'qce-modern-html-chunked' || manifest.version !== 1 || manifest.exporter?.version !== '0.1.0'
    || !chunks.length || chunks.length !== manifest.chunks.length) throw new Error('Unsupported QCE HTML format/version or external chunks');
  return { manifest, manifestNode, chunks, index };
}

export function enhanceQce(html, page, document, rows, matches, media) {
  const data = readQcePage(page), { manifest, chunks, index } = data;
  if (document.messages.length !== chunks.reduce((sum, c) => sum + c.messages.length, 0) || index.size !== document.messages.length) throw new Error('QCE JSON/HTML message count mismatch');
  const records = new Map();
  for (const chunk of chunks) for (const [offset, record] of chunk.messages.entries()) {
    if (records.has(record.id) || index.get(record.id) !== chunk.id) throw new Error('QCE ID/chunk/index linkage mismatch');
    records.set(record.id, { record, chunk, offset });
  }
  if (document.messages.some(m => !records.has(`msg-${m.id}`))) throw new Error('QCE JSON/HTML identities do not match');
  for (const chunk of chunks) {
    const meta = manifest.chunks.find(c => c.id === chunk.id);
    if (!meta || meta.count !== chunk.messages.length || meta.textBloomIncomplete
      || textBloom(chunk.messages, manifest.bloom) !== meta.textBloom) throw new Error('Cannot reliably reconstruct QCE source Bloom index');
  }
  const changedChunks = new Set();
  for (const match of matches) {
    const id = `msg-${match.message.id}`, target = records.get(id);
    const locators = rows.filter(r => r.message_key === messageKey(match.message, 'qq')).map(r => JSON.parse(r.source_locator_json));
    if (locators.some(l => l.chunkId !== target.chunk.id || l.chunkOffset !== target.offset || l.htmlId !== id)) throw new Error('QCE registered HTML locator changed');
    const tree = fragment(target.record.html);
    const voiceNodes = elements(tree, n => hasClass(n, 'voice-bubble'));
    const audio = (match.message.content?.elements || []).filter(e => e.type === 'audio');
    const descriptions = audio.length ? audio.map(e => e.data) : (match.message.content?.resources || []).filter(r => r.type === 'audio');
    if (voiceNodes.length !== descriptions.length || voiceNodes.some((n, i) => attr(n, 'data-name') !== descriptions[i].filename)) throw new Error('QCE voice DOM/part identity mismatch');
    target.record.html = injectByNodes(target.record.html, voiceNodes, match.transcription.parts, id);
    target.record.text += '\n' + match.transcription.parts.map(p => p.status === 'success' ? p.text : `[${p.status}]`).join('\n').toLowerCase();
    target.record.transcription = match.transcription;
    changedChunks.add(target.chunk.id);
  }
  const edits = [];
  // Resource URL changes are limited to parsed attributes in each actual record.
  for (const chunk of chunks) {
    for (const record of chunk.messages) record.html = media.rewriteHtml(record.html);
    const body = `window.__QCE_CHUNK__ && window.__QCE_CHUNK__({id:${safeJson(chunk.id)},messages:[\n${chunk.messages.map(safeJson).join(',\n')}\n]});\n`;
    const meta = manifest.chunks.find(c => c.id === chunk.id);
    meta.bytes = Buffer.byteLength(body);
    if (changedChunks.has(chunk.id)) meta.textBloom = textBloom(chunk.messages, manifest.bloom);
    edits.push(scriptEdit(chunk.node, body));
  }
  for (const sender of manifest.senders || []) if (sender.avatar) sender.avatar = media.reference(sender.avatar);
  if (manifest.chat.avatar) manifest.chat.avatar = media.reference(manifest.chat.avatar);
  edits.push(scriptEdit(data.manifestNode, `window.__QCE_MANIFEST__ && window.__QCE_MANIFEST__(${safeJson(manifest)});`));
  return { html: editsTo(html, edits), fragments: chunks.flatMap(c => c.messages.map(r => r.html)),
    resourceRoots: [manifest.paths?.resourcesDir, manifest.paths?.assetsDir, manifest.paths?.dataDir].filter(Boolean),
    searchUpdates: changedChunks.size, evidence: { messageCount: records.size, chunks: chunks.length, indexEntries: index.size,
      bloomRebuilt: changedChunks.size, originalBloomReproduced: true, chunkBytesUpdated: chunks.length } };
}
