// Read-only adapter for the inspected QCE 0.1.0 inline chunked HTML format.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveExportAudio } from './paths.mjs';
import { detectAudioFormat } from './audio-core.mjs';

export function readInlineQce(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1].trim());
  const chunks = [];
  const msgid = new Map();
  let manifest;
  for (const script of scripts) {
    if (script.startsWith('window.__QCE_MANIFEST__ &&')) {
      manifest = JSON.parse(script.slice(script.indexOf('(', script.indexOf('&&')) + 1, script.lastIndexOf(')')));
    } else if (script.startsWith('window.__QCE_CHUNK__ &&')) {
      // The outer object is JS ({id:...,messages:...}); its messages array is JSON.
      // Parse the known envelope without evaluating any uploaded JavaScript.
      const m = script.match(/\(\{id:("[^"\n]+"),messages:([\s\S]*)\}\);$/);
      if (!m) throw new Error('Unsupported QCE chunk envelope');
      chunks.push({ id: JSON.parse(m[1]), messages: JSON.parse(m[2]) });
    } else if (script.startsWith('window.__QCE_MSGID_INDEX__ &&')) {
      const pairs = JSON.parse(script.slice(script.indexOf(',') + 1, script.lastIndexOf(')')));
      for (const [id, chunk] of pairs) msgid.set(id, chunk);
    }
  }
  if (manifest?.format !== 'qce-modern-html-chunked' || !chunks.length) {
    throw new Error('Expected the inspected inline qce-modern-html-chunked format');
  }
  return { manifest, chunks, msgid };
}

export function scanQce(jsonPath, htmlPath, { inspectAudio = true } = {}) {
  const document = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const { manifest, chunks, msgid } = readInlineQce(fs.readFileSync(htmlPath, 'utf8'));
  const htmlMessages = new Map();
  for (const chunk of chunks) {
    for (const [chunkOffset, message] of chunk.messages.entries()) {
      htmlMessages.set(message.id, { message, chunkId: chunk.id, chunkOffset });
    }
  }
  const records = [];
  for (const [jsonIndex, message] of document.messages.entries()) {
    const elements = (message.content?.elements ?? []).filter(e => e.type === 'audio');
    const resources = (message.content?.resources ?? []).filter(r => r.type === 'audio');
    if (message.type !== 'audio' && !elements.length && !resources.length) continue;
    const htmlId = `msg-${message.id}`; // Keep QQ's 64-bit message ID as a string.
    const match = htmlMessages.get(htmlId);
    // Exact voice-bubble attributes observed in the sample; not a general HTML parser.
    const voices = [...(match?.message.html ?? '').matchAll(/<div class="voice-bubble"[^>]*>/g)].map(m => ({
      src: m[0].match(/data-src="([^"]*)"/)?.[1],
      name: m[0].match(/data-name="([^"]*)"/)?.[1]
    }));
    const parts = elements.length ? elements.map(e => e.data) : resources;
    for (const [partIndex, audio] of parts.entries()) {
      const candidates = voices.filter(v => v.name === audio.filename);
      const voice = candidates.length === 1 ? candidates[0] : undefined;
      // These are literal relative paths; '%' and backticks occur in real filenames.
      const audioPath = voice?.src ? resolveExportAudio(path.dirname(htmlPath), voice.src) : null;
      const exists = audioPath !== null && fs.existsSync(audioPath);
      let wav = null;
      let audioFormat = null;
      if (exists && inspectAudio) {
        const info = detectAudioFormat(audioPath);
        audioFormat = info.format;
        wav = info.wav ?? null;
      }
      records.push({
        platform: 'qq', chatId: document.chatInfo.peerUid, messageId: message.id,
        partIndex, jsonIndex, htmlId, chunkId: match?.chunkId ?? null,
        chunkOffset: match?.chunkOffset ?? null, indexChunkId: msgid.get(htmlId) ?? null,
        filename: audio.filename, relativeAudioPath: voice?.src ?? null, audioPath,
        status: candidates.length > 1 ? 'ambiguous_audio' : !voice ? 'unresolved_audio_path' : !exists ? 'missing_audio' : 'ready',
        bytes: exists ? fs.statSync(audioPath).size : null, audioFormat, wav
      });
    }
  }
  return {
    jsonMessages: document.messages.length, htmlMessages: htmlMessages.size,
    manifestMessages: manifest.stats.totalMessages, chunkCount: chunks.length,
    indexEntries: msgid.size, audioMessages: new Set(records.map(r => r.messageId)).size,
    audioParts: records.length, records
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [jsonPath, htmlPath] = process.argv.slice(2);
  if (!jsonPath || !htmlPath) {
    console.error('Usage: node qce.mjs <export.json> <export.html>');
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(scanQce(jsonPath, htmlPath), null, 2));
  }
}
