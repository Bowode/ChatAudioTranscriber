// SPDX-License-Identifier: GPL-3.0-only
// Adapted for QCE format compatibility from QQ Chat Exporter v6.3.2.
// Upstream: https://github.com/shuakami/qq-chat-exporter
// Sources: qce-chunked-viewer/src/qce/bloom.ts and qq-chat-export-core/src/bloom.rs.
// Attribution: shuakami and QQ Chat Exporter contributors.
// JavaScript adaptation: ChatAudioTranscriber contributors. See LICENSE and UPSTREAM.md.
// Source: local QCE core bloom.rs/add_text_to_bloom and viewer qce/bloom.ts.
// UTF-16 units, FNV-1a 32-bit, lower-case 2/3-grams, little-endian bit order.
function fnv(value, from, to, seed) {
  let result = seed;
  for (let i = from; i < to; i++) result = Math.imul(result ^ value.charCodeAt(i), 0x01000193);
  return result >>> 0;
}
export const messageIdBucket = (id, count) => fnv(id, 0, id.length, 0x811c9dc5) % count;
export function textBloom(records, { textBits, textHashes }) {
  // The observed viewer/core use power-of-two sizes; this also makes uint32
  // wrapping in core and JS's wider arithmetic identical for the bit modulo.
  if (!Number.isSafeInteger(textBits) || textBits < 8 || (textBits & (textBits - 1)) !== 0
    || !Number.isSafeInteger(textHashes) || textHashes < 1 || textHashes > 16) throw new Error('Unsupported QCE Bloom parameters');
  const bytes = Buffer.alloc(Math.ceil(textBits / 8));
  for (const record of records) {
    if (record.textTruncated) throw new Error('Cannot rebuild complete QCE Bloom from truncated source text');
    const value = `${record.text} ${record.nameLower}`.toLowerCase();
    for (const n of [2, 3]) for (let start = 0; start + n <= value.length; start++) {
      const h1 = fnv(value, start, start + n, 0x811c9dc5);
      const h2 = fnv(value, start, start + n, (0x811c9dc5 ^ 0x5bd1e995) >>> 0);
      for (let i = 0; i < textHashes; i++) { const bit = ((h1 + i * h2) >>> 0) % textBits; bytes[bit >> 3] |= 1 << (bit & 7); }
    }
  }
  return bytes.toString('base64');
}
