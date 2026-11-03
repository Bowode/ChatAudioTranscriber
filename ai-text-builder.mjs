const unavailableText = {
  empty_result: '未识别出文字', failed: '转写失败', missing_audio: '音频文件缺失',
  ambiguous_audio: '音频关联存在歧义', unresolved_audio_path: '音频路径未定位', pending: '尚未转写'
};

export function messageStatus(parts) {
  if (!parts.length) throw new Error('A transcription must contain at least one voice part');
  if (parts.every(p => p.status === 'success')) return 'success';
  if (parts.some(p => p.status === 'success' && p.text.trim())) return 'partial';
  if (parts.every(p => p.status === 'empty_result')) return 'empty_result';
  if (parts.some(p => p.status === 'pending')) return 'pending';
  if (parts.some(p => p.status === 'failed')) return 'failed';
  if (parts.every(p => ['missing_audio', 'ambiguous_audio', 'unresolved_audio_path'].includes(p.status))) return 'unavailable';
  // Completed empty portions mixed with unavailable resources, with no usable text.
  return 'unavailable';
}

export function originalVoiceText(message, platform) {
  if (platform === 'qq') {
    // QCE's verified text elements: type=text, data.text. content.text can be
    // a generated [语音:...] placeholder, so it is not used as original prose.
    return (message.content?.elements ?? []).filter(e => e.type === 'text' && typeof e.data?.text === 'string')
      .map(e => e.data.text).join('\n');
  }
  // In verified WeFlow localType=34 messages, content equals mediaPath. There
  // is no independently verified mixed-prose field here; never treat it as text.
  return '';
}

export function buildAiText(message, platform, parts) {
  const sorted = [...parts].sort((a, b) => a.partIndex - b.partIndex);
  const speech = sorted.map(part => part.status === 'success'
    ? `${sorted.length === 1 ? '[语音转写]' : `[语音片段 ${part.partIndex + 1}]`} ${part.text}`
    : `[语音片段 ${part.partIndex + 1}：${unavailableText[part.status]}]`).join('\n');
  const original = originalVoiceText(message, platform);
  return original ? `原始文字：\n${original}\n\n语音转写：\n${speech}` : speech;
}
