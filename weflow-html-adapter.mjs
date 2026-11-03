import { elements, text, jsonArraySpan, safeJson, scriptEdit, editsTo, fragment, hasClass, serializeOuter } from './html-data.mjs';
import { injectByNodes, blockHtml } from './html-transcription-renderer.mjs';
import { messageKey } from './transcription-mapper.mjs';
import { localIdKey, safeInteger } from './json-preserver.mjs';

export function readWeFlowPage(page) {
  const candidates = elements(page, n => n.tagName === 'script').filter(n => /window\.WEFLOW_DATA\s*=\s*\[/.test(text(n)));
  if (candidates.length !== 1) throw new Error('Unsupported or ambiguous WEFLOW_DATA');
  const node = candidates[0], body = text(node);
  return { node, body, ...jsonArraySpan(body, /window\.WEFLOW_DATA\s*=\s*\[/) };
}
const identity = (localId, platformId) => `${localIdKey(localId)}\0${platformId || ''}`;
export function enhanceWeFlow(html, page, document, rows, matches, media) {
  const data = readWeFlowPage(page), records = data.value;
  if (data.entries.length !== records.length) throw new Error('Unsupported WeFlow record serialization');
  const before = records.map(safeJson);
  const byIdentity = new Map();
  for (const record of records) {
    const key = identity(record.i, record.p);
    if (byIdentity.has(key)) throw new Error('Duplicate WeFlow render identity');
    byIdentity.set(key, record);
  }
  if (records.length !== document.messages.length || document.messages.some(m => !byIdentity.has(identity(m.localId, m.platformMessageId)))) throw new Error('WeFlow HTML/JSON identity mismatch');
  // Require the actual supported original renderer and original search mechanism.
  const viewer = elements(page, n => n.tagName === 'script').map(text).join('\n');
  if (!viewer.includes('item.b.toLowerCase().includes(keyword)') || !viewer.includes('class ChunkedRenderer') || !viewer.includes('${item.b}')) throw new Error('Unsupported WeFlow renderer/search implementation');
  for (const match of matches) {
    const record = byIdentity.get(identity(match.message.localId, match.message.platformMessageId));
    const registered = rows.filter(r => r.message_key === messageKey(match.message, 'wechat'));
    if (registered.length !== 1 || registered[0].part_index !== 0) throw new Error('Unsupported WeFlow voice part count');
    const tree = fragment(record.b), voices = elements(tree, n => n.tagName === 'audio');
    const parts = match.transcription.parts;
    const messageId = match.message.platformMessageId || `local:${localIdKey(match.message.localId)}`;
    if (!voices.length && !match.message.mediaPath && safeInteger(match.message.localType) === 34
        && parts.length === 1 && parts[0].status === 'unresolved_audio_path'
        && registered[0].scan_availability === 'unresolved_audio_path') {
      // A registered voice can be exported as text when no audio resource is located.
      // Validate that specific representation separately; playable voices keep the existing node check.
      const contents = elements(tree, n => n.tagName === 'div' && hasClass(n, 'message-content'));
      const placeholders = contents.length === 1 ? elements(contents[0], n => n.tagName === 'div' && hasClass(n, 'message-text')) : [];
      const end = placeholders[0]?.sourceCodeLocation?.endOffset;
      if (parts[0].partIndex !== 0 || placeholders.length !== 1 || !Number.isSafeInteger(end)
          || typeof match.message.content !== 'string' || text(placeholders[0]) !== match.message.content
          || elements(tree, n => hasClass(n, 'chat-audio-transcription')).length) {
        throw new Error('Unresolved WeFlow voice placeholder is missing, ambiguous or already enhanced');
      }
      const block = fragment(blockHtml(parts[0], messageId, 1)).childNodes[0];
      const body = elements(block, n => hasClass(n, 'chat-audio-transcription-text'))[0];
      body.childNodes.push({ nodeName: '#text', value: '原始音频文件未定位，暂时无法转写。', parentNode: body });
      record.b = editsTo(record.b, [{ start: end, end, value: serializeOuter(block) }]);
    } else {
      record.b = injectByNodes(record.b, voices, parts, messageId);
    }
    record.transcription = match.transcription;
  }
  for (const record of records) {
    record.b = media.rewriteHtml(record.b);
    if (record.a) record.a = media.rewriteHtml(record.a);
  }
  // Preserve the array and every untouched record literal; replace only changed records.
  const body = editsTo(data.body, records.flatMap((record, i) => {
    const value = safeJson(record);
    return value === before[i] ? [] : [{ ...data.entries[i], value }];
  }));
  return { html: editsTo(html, [scriptEdit(data.node, body)]), fragments: records.flatMap(r => [r.b, r.a || '']),
    resourceRoots: ['media'], searchUpdates: matches.length,
    evidence: { messageCount: records.length, dataField: 'WEFLOW_DATA[].b', originalSearchPreserved: true, lazyRendererPreserved: true } };
}
