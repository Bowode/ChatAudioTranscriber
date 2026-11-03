import fs from 'node:fs';
import path from 'node:path';
import { resolveExportAudio } from './paths.mjs';

// Minimal audio source adapter for the inspected JSON export schema 1.0.3.
// JSON mediaPath is literal; HTML's URL-encoded src is not needed here.
export function readWeFlowAudio(jsonPath, { allowMissingPaths = false } = {}) {
  const document = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (document.weflow?.version !== '1.0.3' || !Array.isArray(document.messages)) {
    throw new Error('Expected WeFlow JSON export schema 1.0.3');
  }
  return document.messages.flatMap((message, jsonIndex) => message.localType !== 34 ? [] : [{
    platform: 'wechat', messageId: message.platformMessageId,
    audioPath: !message.mediaPath && allowMissingPaths ? null : resolveExportAudio(path.dirname(jsonPath), message.mediaPath),
    relativeAudioPath: message.mediaPath ?? '', partIndex: 0, jsonIndex, localId: message.localId,
    sender: message.senderUsername, timestampRaw: message.createTime
  }]);
}
