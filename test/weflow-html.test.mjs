import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePage, fragment, elements, attr, hasClass, text, safeJson } from '../html-data.mjs';

const adapter = process.env.CHAT_AUDIO_WEFLOW_ADAPTER
  ? pathToFileURL(path.resolve(process.env.CHAT_AUDIO_WEFLOW_ADAPTER)) : new URL('../weflow-html-adapter.mjs', import.meta.url);
const { enhanceWeFlow, readWeFlowPage } = await import(adapter.href);
const notice = '原始音频文件未定位，暂时无法转写。';
const passthrough = { rewriteHtml: value => value };
function fixture(count = 1, unresolved = 1) {
  const messages = [], records = [], rows = [], matches = [];
  for (let i = 0; i < count; i++) {
    const missing = i >= count - unresolved;
    const message = { localId: i + 1, platformMessageId: `voice-${i}`, localType: 34, content: '语音消息' };
    if (!missing) message.mediaPath = `media/voice-${i}.wav`;
    const status = missing ? 'unresolved_audio_path' : 'success';
    const transcription = { generatedBy: 'ChatAudioTranscriber', schemaVersion: 1, status,
      parts: [{ partIndex: 0, status, text: missing ? '' : `Synthetic cached text ${i}` }] };
    messages.push(message);
    records.push({ i: message.localId, p: message.platformMessageId, t: i, s: 0, a: '<span>avatar</span>',
      b: `<div class="message-time">2026-10-30 09:53:40</div><div class="message-content">${missing
        ? '<div class="message-text">语音消息</div>' : `<audio controls src="${message.mediaPath}"></audio>`}</div>` });
    rows.push({ message_key: `id:${message.platformMessageId}`, part_index: 0, scan_availability: missing ? status : 'ready' });
    matches.push({ message, transcription });
  }
  messages.push({ localId: count + 1, platformMessageId: 'ordinary', localType: 1, content: 'ordinary message' });
  records.push({ i: count + 1, p: 'ordinary', t: 1000, s: 1, a: '', b: '<div>ordinary message</div>' });
  const viewer = "class ChunkedRenderer {}\n// item.b.toLowerCase().includes(keyword)\n// ${item.b}";
  const html = `<html><head></head><body><script>window.WEFLOW_DATA=${safeJson(records)};</script><script>${viewer}</script></body></html>`;
  return { messages, records, rows, matches, html, viewer };
}
function run(f) {
  const result = enhanceWeFlow(f.html, parsePage(f.html), { messages: f.messages }, f.rows, f.matches, passthrough);
  return { ...result, records: readWeFlowPage(parsePage(result.html)).value };
}
function replaceBody(f, body) {
  f.records[0].b = body;
  f.html = `<html><head></head><body><script>window.WEFLOW_DATA=${safeJson(f.records)};</script><script>${f.viewer}</script></body></html>`;
}

test('WeFlow 193 playable + 79 unresolved: preserve identity, order, media and searchable status notices', () => {
  const f = fixture(272, 79), result = run(f);
  assert.equal(result.searchUpdates, 272);
  assert.ok(result.html.includes(f.viewer));
  assert.equal(result.records.length, f.records.length);
  for (let i = 0; i < 272; i++) {
    const before = f.records[i], after = result.records[i], tree = fragment(after.b);
    const stripped = { ...after }; delete stripped.b; delete stripped.transcription;
    const original = { ...before }; delete original.b;
    assert.deepEqual(stripped, original);
    const blocks = elements(tree, n => hasClass(n, 'chat-audio-transcription'));
    assert.equal(blocks.length, 1);
    assert.equal(attr(blocks[0], 'data-cat-message-id'), before.p);
    assert.equal(attr(blocks[0], 'data-cat-part-index'), '0');
    const audio = elements(tree, n => n.tagName === 'audio');
    if (i < 193) {
      assert.equal(audio.length, 1); assert.equal(attr(audio[0], 'src'), f.messages[i].mediaPath);
      assert.equal(text(elements(blocks[0], n => hasClass(n, 'chat-audio-transcription-text'))[0]), f.matches[i].transcription.parts[0].text);
    } else {
      assert.equal(audio.length, 0); assert.equal(attr(blocks[0], 'data-cat-status'), 'unresolved_audio_path');
      assert.equal(text(elements(blocks[0], n => hasClass(n, 'chat-audio-transcription-text'))[0]), notice);
      assert.equal(f.matches[i].transcription.parts[0].text, '');
      assert.ok(after.b.includes(notice));
    }
    assert.equal(after.b.replace(blocks[0].sourceCodeLocation ? after.b.slice(blocks[0].sourceCodeLocation.startOffset, blocks[0].sourceCodeLocation.endOffset) : '', ''), before.b);
  }
  assert.deepEqual(result.records.at(-1), f.records.at(-1));
});

test('WeFlow zero audio still rejects success/failed/other states, located media, or multiple parts', () => {
  for (const status of ['success', 'failed', 'empty_result', 'pending', 'missing_audio', 'ambiguous_audio']) {
    const f = fixture(); f.matches[0].transcription.parts[0].status = status;
    assert.throws(() => run(f), /Audio DOM node count/);
  }
  const located = fixture(); located.messages[0].mediaPath = 'media/located.wav';
  assert.throws(() => run(located), /Audio DOM node count/);
  const multiple = fixture(); multiple.matches[0].transcription.parts.push({ partIndex: 1, status: 'unresolved_audio_path', text: '' });
  assert.throws(() => run(multiple), /Audio DOM node count/);
  const wrongRegistration = fixture(); wrongRegistration.rows[0].scan_availability = 'ready';
  assert.throws(() => run(wrongRegistration), /Audio DOM node count/);
  const ordinary = fixture(); ordinary.messages[0].localType = 1;
  assert.throws(() => run(ordinary), /Audio DOM node count/);
});

test('WeFlow playable audio count remains strict', () => {
  const f = fixture(1, 0);
  replaceBody(f, '<div class="message-content"><audio src="media/a.wav"></audio><audio src="media/b.wav"></audio></div>');
  assert.throws(() => run(f), /Audio DOM node count/);
});

test('WeFlow unresolved branch rejects missing, ambiguous, mismatched or already enhanced placeholders', () => {
  for (const body of [
    '<div class="message-content"></div>',
    '<div class="message-content"><div class="message-text">语音消息</div><div class="message-text">语音消息</div></div>',
    '<div class="message-content"><div class="message-text">different content</div></div>',
    '<div class="message-content"><div class="message-text">语音消息</div></div><div class="message-content"></div>',
    '<div class="message-content"><div class="message-text">语音消息</div><div class="chat-audio-transcription"></div></div>'
  ]) {
    const f = fixture(); replaceBody(f, body);
    assert.throws(() => run(f), /Unresolved WeFlow voice placeholder/);
  }
  const wrongPart = fixture(); wrongPart.matches[0].transcription.parts[0].partIndex = 1;
  assert.throws(() => run(wrongPart), /Unresolved WeFlow voice placeholder/);
});

test('WeFlow identity and registration checks are unchanged', () => {
  const missing = fixture(); missing.messages[0].platformMessageId = 'wrong-id';
  assert.throws(() => run(missing), /HTML\/JSON identity mismatch/);
  const duplicate = fixture(); duplicate.rows.push({ ...duplicate.rows[0] });
  assert.throws(() => run(duplicate), /voice part count/);
});
