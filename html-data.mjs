import { parse, parseFragment, serializeOuter } from 'parse5';

export const parsePage = html => parse(html, { sourceCodeLocationInfo: true });
export const fragment = html => parseFragment(html, { sourceCodeLocationInfo: true });
export function elements(root, predicate = () => true) {
  const results = [];
  function visit(node) { if (node.tagName && predicate(node)) results.push(node); for (const child of node.childNodes || []) visit(child); }
  visit(root); return results;
}
export const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
export const hasClass = (node, value) => (attr(node, 'class') || '').split(/\s+/).includes(value);
export function text(node) { return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join(''); }
export function safeJson(value) { return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'); }
export function parseData(value) {
  return JSON.parse(value, (key, item) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error('Unsafe number in embedded viewer data');
    return item;
  });
}
export function editsTo(html, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let previous = html.length + 1;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > previous) throw new Error('Overlapping or invalid structural HTML edits');
    html = html.slice(0, edit.start) + edit.value + html.slice(edit.end); previous = edit.start;
  }
  return html;
}
export function scriptEdit(node, value) {
  const location = node.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) throw new Error('Unsupported script source location');
  return { start: location.startTag.endOffset, end: location.endTag.startOffset, value };
}
export { serializeOuter };

// Locate a single JSON array literal with bracket/string awareness, not eval.
export function jsonArraySpan(source, marker) {
  const match = marker.exec(source);
  if (!match) throw new Error('Unsupported embedded data assignment');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false, entryStart;
  const entries = [];
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '[' || c === '{') { if (depth === 1 && c === '{') entryStart = i; depth++; }
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 1 && c === '}' && entryStart !== undefined) { entries.push({ start: entryStart, end: i + 1 }); entryStart = undefined; }
      if (depth === 0) return { start, end: i + 1, entries, value: parseData(source.slice(start, i + 1)) };
    }
  }
  throw new Error('Truncated embedded JSON array');
}
