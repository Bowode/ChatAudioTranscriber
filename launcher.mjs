// Portable Edition: relative configuration and first-use database initialization; original workflow unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { runWorkflow } from './workflow.mjs';
import { AudioCacheDatabase } from './cache-db.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { enhancedPath } from './sibling-publisher.mjs';

const project = fileURLToPath(new URL('.', import.meta.url));

export function parseDroppedPath(value) {
  let result = value.trim();
  if (result.startsWith('"') && result.endsWith('"')) result = result.slice(1, -1);
  if (!result || result.includes('"')) throw new Error('请一次拖入一个完整导出文件夹。');
  return path.resolve(result);
}

export function loadConfiguration() {
  const config = JSON.parse(fs.readFileSync(path.join(project, 'launcher.config.json'), 'utf8'));
  for (const key of ['databasePath', 'modelDirectory', 'ffmpegPath', 'workDirectory']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`配置缺少 ${key}`);
    config[key] = path.resolve(project, config[key]);
  }
  if (fs.existsSync(config.databasePath) && !fs.statSync(config.databasePath).isFile()) throw new Error('数据库路径不是普通文件。');
  return config;
}

export function progressText(event) {
  if (event.phase === 'processing') {
    const percent = event.total ? Math.min(100, Math.floor(event.processed * 100 / event.total)) : 100;
    const filled = Math.floor(percent / 5);
    return `[${'='.repeat(filled)}${' '.repeat(20 - filled)}] ${percent}% 语音 ${event.processed}/${event.total} | 缓存 ${event.cacheHits} | ASR成功 ${event.asrSuccess} | 失败 ${event.failures}`;
  }
  if (event.phase === 'scan-preview') return '正在扫描原始导出…';
  if (event.phase === 'scan') return '正在登记消息与查询缓存…';
  if (['json', 'html'].includes(event.phase)) return `${event.phase.toUpperCase()} 生成：${event.status === 'completed' ? '完成' : event.status === 'failed' ? '失败' : '处理中…'}`;
  return null;
}

export async function launch({ ask, write = console.log, config = loadConfiguration(), workflow = runWorkflow } = {}) {
  write('ChatAudioTranscriber · 本地语音转写\n增强文件生成在原始目录，直接复用原有媒体资源。');
  const inputPath = parseDroppedPath(await ask('请拖入完整导出文件夹，然后按 Enter：'));
  if (!fs.statSync(inputPath).isDirectory()) throw new Error('请拖入包含配套 JSON、HTML 和媒体资源的完整文件夹。');
  const options = { ...config, inputPaths: [inputPath], sameDirectory: true,
    onProgress: event => { const text = progressText(event); if (text) write(text); } };
  const preview = await workflow({ ...options, dryRun: true });
  write(`发现 ${preview.collectionCount} 组导出，共 ${preview.totals.messages} 条消息、${preview.totals.fragments} 个语音片段。`);
  for (const item of preview.preview) write(`${item.platform === 'qq' ? 'QQ / QCE' : '微信 / WeFlow'}：${item.messageCount} 条消息，${item.fragments} 个语音片段\n  JSON：${item.jsonPath}\n  HTML：${item.htmlPath}`);
  const existing = [...new Set(preview.preview.flatMap(item => [enhancedPath(item.jsonPath), enhancedPath(item.htmlPath)]))].filter(p => fs.existsSync(p));
  if (existing.length) {
    write(`发现 ${existing.length} 个已有增强文件：\n${existing.map(p => `  ${p}`).join('\n')}`);
    if ((await ask('覆盖这些增强文件吗？输入 Y 确认，其他输入取消：')).trim().toLowerCase() !== 'y') {
      write('已取消，没有修改文件。'); return { status: 'cancelled' };
    }
  } else if ((await ask('按 Enter 开始处理；输入其他内容取消：')).trim()) {
    write('已取消，没有修改文件。'); return { status: 'cancelled' };
  }
  // Initialize only after confirmation, so cancelling the preview remains read-only.
  if (!fs.existsSync(config.databasePath)) {
    const lock = acquireInstanceLock(config.databasePath);
    try { const database = new AudioCacheDatabase(config.databasePath); database.close(); }
    finally { lock.release(); }
  }
  const result = await workflow({ ...options, overwriteGenerated: existing.length > 0 });
  write(`处理${result.status === 'completed' ? '完成' : '未全部完成'}：${result.totals.success || 0} 个转写成功；ASR 调用 ${result.calls.asrCalls}；模型初始化 ${result.calls.modelInitializations}；媒体复制 ${result.totals.resourceFiles || 0}。`);
  for (const source of result.sources) {
    if (source.errorMessage) write(`失败阶段 ${source.phase}：${source.errorMessage}`);
    for (const kind of ['json', 'html']) for (const filename of source[kind]?.outputFiles || []) write(filename);
    if (source.status === 'skipped-no-audio') write('此导出没有语音，已跳过。');
  }
  write(`执行报告：${result.reportPath}`);
  return result;
}

async function main() {
  // Queue input lines: redirected input and a fast paste must behave like keyboard input.
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  const ask = async prompt => {
    process.stdout.write(prompt);
    const line = await lines.next();
    if (line.done) throw new Error('输入已结束，操作取消。');
    return line.value;
  };
  let progressLine = false;
  const write = value => {
    if (process.stdout.isTTY && value.startsWith('[')) {
      process.stdout.write('\r\x1b[2K' + value); progressLine = true;
    } else {
      if (progressLine) { process.stdout.write('\n'); progressLine = false; }
      console.log(value);
    }
  };
  try {
    const result = await launch({ ask, write });
    if (!['completed', 'cancelled'].includes(result.status)) process.exitCode = 1;
  } catch (error) { console.error(`\n无法完成：${error.message}`); process.exitCode = 1; }
  finally { reader.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
