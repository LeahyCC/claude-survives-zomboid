// Follows the mod's reflex log (Zomboid/Lua/local_reflex.txt) and copies each new line into
// bridge/decisions.jsonl as a reflex line, so review.mjs can count escapes and hits by stance.
// The mod writes a call line when the reflex takes a stance, and an out line five seconds later
// with what came of it (docs/combat.md, the reflex log).
//
// The file starts again each game session and past its size cap. A bridge that starts reads from
// the end, so a restart does not copy old lines twice. A file that got shorter is read from 0.

import fs from 'node:fs';
import { parseLines } from './jsonl.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// One mod line as a decisions.jsonl line. The mod's t (call or out) becomes kind.
export function toLogLine(line, now = Date.now()) {
  if (!isObj(line) || (line.t !== 'call' && line.t !== 'out')) return null;
  const { t, ...rest } = line;
  return { t: 'reflex', kind: t, at: new Date(now).toISOString(), ...rest };
}

// write(obj) appends one line. Returns poll(), which reads what is new; call it once a second.
// readFrom lets a test start at 0 instead of the end.
export function createReflexFollower({ file, write, readFrom = 'end', fsImpl = fs }) {
  let offset = null;
  let partial = '';
  return function poll(now = Date.now()) {
    let size;
    try {
      size = fsImpl.statSync(file).size;
    } catch {
      return 0;
    }
    if (offset === null) offset = readFrom === 'end' ? size : 0;
    if (size < offset) {
      offset = 0;
      partial = '';
    }
    if (size === offset) return 0;
    let text = '';
    try {
      const fd = fsImpl.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fsImpl.readSync(fd, buf, 0, buf.length, offset);
        text = buf.toString('utf8');
      } finally {
        fsImpl.closeSync(fd);
      }
    } catch {
      return 0;
    }
    offset = size;
    // A line the mod has not finished writing waits for the next poll.
    text = partial + text;
    const cut = text.lastIndexOf('\n');
    partial = cut >= 0 ? text.slice(cut + 1) : text;
    let n = 0;
    for (const line of parseLines(cut >= 0 ? text.slice(0, cut) : '')) {
      const out = toLogLine(line, now);
      if (out) {
        write(out);
        n += 1;
      }
    }
    return n;
  };
}
