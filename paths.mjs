import fs from 'node:fs';
import path from 'node:path';

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// QCE uses literal filesystem paths: no URL decoding or shell interpolation.
export function resolveExportAudio(exportDirectory, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')
      || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
      || relativePath.includes(':')) throw new Error('Expected a relative audio path');
  const root = path.resolve(exportDirectory);
  const target = path.resolve(root, relativePath.replaceAll('\\', '/'));
  if (!isWithin(root, target)) throw new Error('Audio path escapes export directory');
  if (fs.existsSync(target) && !isWithin(fs.realpathSync(root), fs.realpathSync(target))) {
    throw new Error('Audio symlink escapes export directory');
  }
  return target;
}
