import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithin, resolveExportAudio } from './paths.mjs';
import { digestFile, outputPathKey } from './json-exporter.mjs';
import { parsePage, fragment, elements, attr, editsTo, text } from './html-data.mjs';

const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const asUrl = value => value.split('/').map(encodeURIComponent).join('/');
export class MediaPlan {
  constructor(sourceRoot) {
    this.root = fs.realpathSync(sourceRoot);
    this.files = new Map(); this.missing = new Set(); this.external = new Set();
  }
  addFile(relative) {
    const sourcePath = resolveExportAudio(this.root, relative);
    if (!fs.existsSync(sourcePath)) { this.missing.add(relative); return; }
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error('Expected a media resource file');
    const real = fs.realpathSync.native(sourcePath), key = outputPathKey(relative);
    const previous = this.files.get(key);
    if (previous) {
      if (previous.real !== real || previous.dev !== stat.dev || previous.ino !== stat.ino) {
        throw Object.assign(new Error(`Different source files map to one output resource: ${relative}`), { code: 'OUTPUT_PATH_CONFLICT' });
      }
      return previous;
    }
    // Use the on-disk spelling for case aliases; preserve logical paths through symlinks.
    if (process.platform === 'win32' && real.toLowerCase() === sourcePath.toLowerCase()) relative = path.relative(this.root, real).replaceAll('\\', '/');
    const resource = { sourcePath, relative, size: stat.size, sha256: digestFile(sourcePath), real, dev: stat.dev, ino: stat.ino };
    this.files.set(key, resource);
    return resource;
  }
  addTree(relative, ancestors = new Set()) {
    const sourcePath = resolveExportAudio(this.root, relative);
    if (!fs.existsSync(sourcePath)) return;
    const real = fs.realpathSync(sourcePath);
    if (!fs.statSync(sourcePath).isDirectory()) { this.addFile(relative); return; }
    if (ancestors.has(real)) throw new Error('Resource directory symlink cycle');
    const next = new Set([...ancestors, real]);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      const resolved = resolveExportAudio(this.root, child); // Includes realpath containment for links.
      if (fs.statSync(resolved).isDirectory()) this.addTree(child, next); else this.addFile(child);
    }
  }
  reference(value, base = '') {
    const original = value.trim();
    if (!original || /^(?:#|data:|blob:|mailto:|tel:|javascript:)/i.test(original)) return value;
    if (/^(?:https?:)?\/\//i.test(original)) { this.external.add(original); return value; }
    let relative, absolute = false;
    if (/^file:/i.test(original) || path.win32.isAbsolute(original) || path.posix.isAbsolute(original)) {
      const candidate = /^file:/i.test(original) ? fileURLToPath(original) : original;
      const full = path.resolve(candidate);
      if (!isWithin(this.root, full)) throw new Error('Absolute media path escapes export directory');
      relative = path.relative(this.root, full).replaceAll('\\', '/'); absolute = true;
    } else relative = path.posix.normalize(path.posix.join(base, original.replaceAll('\\', '/')));
    let candidate = resolveExportAudio(this.root, relative);
    // Literal filenames win, including '%' and backticks. Decode only a URL
    // spelling that did not locate a literal file, once, then repeat containment.
    if (!fs.existsSync(candidate) && relative.includes('%')) {
      let decoded;
      try { decoded = decodeURIComponent(relative); } catch { decoded = relative; }
      candidate = resolveExportAudio(this.root, decoded);
      if (fs.existsSync(candidate)) relative = decoded;
    }
    if (!fs.existsSync(candidate) && /[?#]/.test(relative)) {
      const clean = relative.split(/[?#]/)[0];
      candidate = resolveExportAudio(this.root, clean);
      if (fs.existsSync(candidate)) relative = clean;
    }
    const resource = this.addFile(relative);
    if (resource) relative = resource.relative;
    const local = base ? path.posix.relative(base, relative) : relative;
    // Encode known filesystem names, not an unconditional URL decode. This
    // fixes literal '%'/'#'/backticks when native media URL parsing is involved.
    return absolute || fs.existsSync(candidate) ? (original.startsWith('./') && !absolute ? './' : '') + asUrl(local) : value;
  }
  rewriteCss(css, base = '') {
    return css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (all, quote, value) => {
      const result = this.reference(value, base);
      return result === value ? all : `url("${result.replaceAll('"', '%22')}")`;
    });
  }
  rewriteHtml(html, wholePage = false) {
    const tree = wholePage ? parsePage(html) : fragment(html), edits = [];
    for (const node of elements(tree)) {
      for (const attribute of node.attrs || []) {
        if (attribute.name === 'srcset') throw new Error('Unsupported srcset resource syntax in this viewer format');
        let value = attribute.value;
        if (['src', 'href', 'poster', 'data-src', 'data-fallback-src', 'data-original'].includes(attribute.name)) value = this.reference(value);
        else if (attribute.name === 'style') value = this.rewriteCss(value);
        else continue;
        if (value !== attribute.value) {
          const location = node.sourceCodeLocation?.attrs?.[attribute.name];
          if (!location) throw new Error('Resource attribute location missing');
          edits.push({ start: location.startOffset, end: location.endOffset, value: `${attribute.name}="${escapeAttribute(value)}"` });
        }
      }
      if (node.tagName === 'style') {
        const old = text(node), rewritten = this.rewriteCss(old);
        if (old !== rewritten) edits.push({ start: node.sourceCodeLocation.startTag.endOffset, end: node.sourceCodeLocation.endTag.startOffset, value: rewritten });
      }
    }
    return editsTo(html, edits);
  }
  finish() {
    // Known export resource trees cover dynamic viewer references as well as
    // DOM src/href. CSS outside those trees is accepted only unchanged.
    for (const file of this.files.values()) if (/\.css$/i.test(file.relative)) {
      const css = fs.readFileSync(file.sourcePath, 'utf8');
      if (this.rewriteCss(css, path.posix.dirname(file.relative)) !== css) throw new Error('External CSS would require URL rewriting; this template is unsupported');
    }
    const resources = [...this.files.values()].sort((a, b) => a.relative.localeCompare(b.relative));
    return { resources, missing: [...this.missing].sort(), external: [...this.external].sort(),
      count: resources.length, totalBytes: resources.reduce((sum, r) => sum + r.size, 0) };
  }
}
