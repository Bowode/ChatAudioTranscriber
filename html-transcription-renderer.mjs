import { fragment, elements, attr, hasClass, editsTo, text, serializeOuter } from './html-data.mjs';

const labels = { empty_result: '未识别出文字', failed: '语音转写失败', missing_audio: '音频文件缺失',
  ambiguous_audio: '音频关联存在歧义', unresolved_audio_path: '音频路径未定位', pending: '语音尚未转写' };
export const controlDisplay = value => value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function blockHtml(part, messageId, count) {
  const node = fragment('<div class="chat-audio-transcription" data-cat-owner="ChatAudioTranscriber" data-cat-schema="1"><div class="chat-audio-transcription-label"></div><div class="chat-audio-transcription-text"></div></div>').childNodes[0];
  node.attrs.push({ name: 'data-cat-message-id', value: messageId }, { name: 'data-cat-part-index', value: String(part.partIndex) }, { name: 'data-cat-status', value: part.status });
  const title = part.status === 'success' ? count === 1 ? '[语音转写]' : `[语音片段 ${part.partIndex + 1}]` : `[语音片段 ${part.partIndex + 1}：${labels[part.status]}]`;
  function addText(parent, value) { parent.childNodes.push({ nodeName: '#text', value, parentNode: parent }); }
  addText(node.childNodes[0], title);
  addText(node.childNodes[1], part.status === 'success' ? controlDisplay(part.text) : '');
  return serializeOuter(node);
}
export function injectByNodes(html, nodes, parts, messageId) {
  if (nodes.length !== parts.length) throw new Error('Audio DOM node count does not match transcription part count');
  const tree = fragment(html);
  if (elements(tree, n => hasClass(n, 'chat-audio-transcription')).length) throw new Error('Original HTML already contains transcription blocks; enhanced HTML is not an input');
  return editsTo(html, nodes.map((node, i) => {
    const end = node.sourceCodeLocation?.endOffset;
    if (!Number.isSafeInteger(end)) throw new Error('Audio node has no reliable source location');
    return { start: end, end, value: blockHtml(parts[i], messageId, parts.length) };
  }));
}
export const css = `.chat-audio-transcription{display:block;margin:.45em 0 .15em;padding:.45em .65em;border-left:3px solid #78909c;background:rgba(127,127,127,.09);border-radius:4px;max-width:100%;min-width:0;box-sizing:border-box;white-space:normal;line-height:1.55;font-size:.88em;color:inherit}.chat-audio-transcription-label{opacity:.7;font-size:.9em}.chat-audio-transcription-text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}`;
