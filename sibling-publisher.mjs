import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function enhancedPath(original) {
  const extension = path.extname(original);
  if (!/^\.(json|html)$/i.test(extension) || /\.enhanced\.(json|html)$/i.test(original)) throw new Error('Expected an original JSON/HTML file');
  return original.slice(0, -extension.length) + '.enhanced' + extension.toLowerCase();
}

// Stage beside the originals, then rename only the explicitly named enhanced files.
// The original directory and resources are never replaced or removed.
export function publishSiblings(files, originals, overwriteGenerated = false) {
  const targets = new Set();
  for (const file of files) {
    if (!originals.includes(file.original) || file.target !== enhancedPath(file.original) || targets.has(file.target)) throw new Error('Invalid sibling output target');
    targets.add(file.target);
    if (fs.existsSync(file.target)) {
      if (!overwriteGenerated) throw new Error('Enhanced file already exists; confirmation required');
      if (!fs.lstatSync(file.target).isFile() || fs.lstatSync(file.target).isSymbolicLink()) throw new Error('Enhanced output must be a regular file');
    }
  }
  const staged = [];
  let committed = false;
  try {
    for (const file of files) {
      const stage = fs.mkdtempSync(path.join(path.dirname(file.target), '.chat-audio-sibling-stage-'));
      const entry = { ...file, stage, staged: path.join(stage, 'output'), backup: null, installed: false };
      staged.push(entry);
      fs.writeFileSync(entry.staged, file.bytes, { flag: 'wx' });
    }
    for (const entry of staged) {
      if (fs.existsSync(entry.target)) {
        if (!overwriteGenerated || !fs.lstatSync(entry.target).isFile() || fs.lstatSync(entry.target).isSymbolicLink()) throw new Error('Enhanced output changed before publication');
        entry.backup = path.join(entry.stage, `previous-${randomUUID()}`);
        fs.renameSync(entry.target, entry.backup);
      }
      // Exclusive creation also refuses a file appearing after the existence check.
      fs.linkSync(entry.staged, entry.target);
      entry.installed = true;
    }
    committed = true;
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      if (entry.installed) { fs.unlinkSync(entry.target); entry.installed = false; }
      if (entry.backup) { fs.renameSync(entry.backup, entry.target); entry.backup = null; }
    }
    throw error;
  } finally {
    for (const entry of staged) {
      // A backup is retained if rollback itself failed.
      if (!committed && entry.backup) continue;
      fs.rmSync(entry.stage, { recursive: true, force: true });
    }
  }
  return { outputFiles: files.map(f => f.target), resourceFiles: 0 };
}
