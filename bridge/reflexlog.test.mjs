// The bridge side of the reflex log: new lines in local_reflex.txt become reflex lines in the
// decision log, once each, and a file that starts again is followed from its start.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReflexFollower, toLogLine } from './reflexlog.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflexlog-'));
  return path.join(dir, 'local_reflex.txt');
}
const call = (id, o = {}) => JSON.stringify({ t: 'call', id, stance: 'BREAK', act: 'break', why: 'pack', tick: 5, f: { chasers: 3 }, ...o });
const out = (id, o = {}) => JSON.stringify({ t: 'out', id, stance: 'BREAK', escaped: true, hits: 0, hpLost: 0, kills: 0, ...o });

test('a mod line becomes a reflex line with its kind, and other lines are dropped', () => {
  const l = toLogLine(JSON.parse(call('a-1')), Date.parse('2026-11-04T12:00:00Z'));
  assert.equal(l.t, 'reflex');
  assert.equal(l.kind, 'call');
  assert.equal(l.stance, 'BREAK');
  assert.equal(l.at, '2026-11-04T12:00:00.000Z');
  assert.deepEqual(l.f, { chasers: 3 });
  assert.equal(toLogLine({ t: 'other' }), null);
  assert.equal(toLogLine({ t: 'count', from: 1, to: 3 }).kind, 'count', 'the crowd growing in a fight is kept');
  assert.equal(toLogLine(null), null);
});

test('the follower copies only new lines, waits for a half-written one, and restarts on a new file', () => {
  const file = tmpFile();
  const got = [];
  fs.writeFileSync(file, call('old-1') + '\n');
  const poll = createReflexFollower({ file, write: (o) => got.push(o) });
  assert.equal(poll(), 0, 'what was there before the bridge started is skipped');
  fs.appendFileSync(file, call('s-1') + '\n' + out('s-1').slice(0, 20));
  assert.equal(poll(), 1);
  assert.equal(got[0].id, 's-1');
  fs.appendFileSync(file, out('s-1').slice(20) + '\n');
  assert.equal(poll(), 1);
  assert.equal(got[1].kind, 'out');
  assert.equal(got[1].escaped, true);
  assert.equal(poll(), 0, 'nothing new');
  // A new game session starts the file again.
  fs.writeFileSync(file, call('n-1') + '\n');
  assert.equal(poll(), 1);
  assert.equal(got[2].id, 'n-1');
});

test('no file yet is not an error', () => {
  const poll = createReflexFollower({ file: path.join(os.tmpdir(), 'no-such-dir-xyz', 'local_reflex.txt'), write: () => {} });
  assert.equal(poll(), 0);
});

test('readFrom start copies what is already there', () => {
  const file = tmpFile();
  fs.writeFileSync(file, call('x-1') + '\n' + out('x-1') + '\nnot json\n');
  const got = [];
  const poll = createReflexFollower({ file, write: (o) => got.push(o), readFrom: 'start' });
  assert.equal(poll(), 2);
  assert.deepEqual(got.map((g) => g.kind), ['call', 'out']);
});
