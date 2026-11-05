// Append-only JSON lines files for the decision and nudge logs. Lines are only ever appended,
// so a turn never waits on a rewrite. A log that grows past maxBytes is moved to <file>.1 (the
// old .1 is dropped) and a fresh file starts. Reads skip any line that is not an object, so a
// half-written last line or a hand edit cannot break the report tools.

import fs from 'node:fs';

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

// The size is counted in memory after the first look, so a turn costs one append and no stat.
export function createAppender(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let size = null;
  const sizeNow = () => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  return function append(obj) {
    const line = JSON.stringify(obj) + '\n';
    const bytes = Buffer.byteLength(line);
    try {
      if (size === null) size = sizeNow();
      if (size > 0 && size + bytes > maxBytes) {
        fs.rmSync(file + '.1', { force: true });
        fs.renameSync(file, file + '.1');
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += bytes;
      return true;
    } catch {
      // A full disk or a locked file must not stop the survivor.
      size = null;
      return false;
    }
  };
}

export function parseLines(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
    } catch { /* partial line */ }
  }
  return out;
}

// The rotated file first, so lines stay in time order. A missing file is an empty log.
export function readLog(file, { rotated = true } = {}) {
  const read = (f) => {
    try {
      return parseLines(fs.readFileSync(f, 'utf8'));
    } catch {
      return [];
    }
  };
  return [...(rotated ? read(file + '.1') : []), ...read(file)];
}
