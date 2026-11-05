// The decision log: decision, outcome and after lines, the join between them, and the file rotation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTracker, joinRecords, compactPercept, harm, AFTER_MS, DEATH_MS } from './decisions.mjs';
import { createAppender, readLog, parseLines } from './jsonl.mjs';
import { readBase } from './eval/scenarios.mjs';

const live = (o = {}) => ({ v: 2, hp: 100, hoursAlive: 10, day: 1, hour: 12, zChasing: 0, zList: [], ...o });
const enter = { id: 'b1', verb: 'ENTER', key: 'ENTER:7', label: 'walk into house 9 tiles N, not visited', a: 0, b: 0, target: '7' };
const wait = { id: 'wait', verb: 'WAIT', key: 'WAIT', label: 'wait here and watch', a: 0, b: 0, target: '' };

function setup() {
  const lines = [];
  const tr = createTracker({ write: (o) => lines.push(o) });
  const send = (percept, seq, now, extra = {}) => tr.decide({
    percept, run: 'run-1', menu: [enter, wait], option: enter, seq, by: 'model', choice: 'b1', thought: 'a house', ms: 310, ...extra,
  }, now);
  return { lines, tr, send };
}

test('a decision line carries the percept, the menu, who decided and the latency', () => {
  const { lines, send } = setup();
  const id = send(live(), 5, 1000);
  const d = lines[0];
  assert.equal(d.t, 'decision');
  assert.equal(d.id, id);
  assert.equal(d.run, 'run-1');
  assert.equal(d.by, 'model');
  assert.equal(d.choice, 'b1');
  assert.equal(d.verb, 'ENTER');
  assert.equal(d.seq, 5);
  assert.equal(d.ms, 310);
  assert.equal(d.percept.hp, 100);
  assert.deepEqual(d.menu.map((o) => o.id), ['b1', 'wait']);
  assert.equal(d.menu[0].key, 'ENTER:7');
});

test('the compact percept is small and survives a junk percept', () => {
  const c = compactPercept(readBase());
  assert.ok(JSON.stringify(c).length < 1500, `${JSON.stringify(c).length} bytes`);
  assert.equal(c.hp, 95);
  assert.equal(c.inside, false);
  assert.doesNotThrow(() => compactPercept({ hp: 'x', zList: 'no', inv: 5, res: 7, inBldg: 'y', wounds: 'z' }));
  assert.equal(compactPercept(null), null);
  assert.equal(compactPercept([]), null);
});

test('keeping the running job logs a decision and watches nothing', () => {
  const { lines, tr } = setup();
  tr.decide({ percept: live(), menu: [enter], option: null, by: 'model', choice: 'keep', thought: 'carry on' }, 0);
  assert.equal(lines[0].sent, false);
  assert.equal(lines[0].seq, null);
  assert.equal(tr.openCount(), 0);
});

test('an order that finishes gets an outcome line, then an after line with the hp and chase', () => {
  const { lines, tr, send } = setup();
  const id = send(live(), 5, 0);
  tr.observe(live({ hp: 90, res: { seq: 5, status: 'running', verb: 'ENTER' } }), 5_000);
  assert.equal(lines.length, 1, 'nothing written while it runs');
  tr.observe(live({ hp: 85, res: { seq: 5, status: 'done', verb: 'ENTER', why: 'in by a door' } }), 20_000);
  const out = lines[1];
  assert.equal(out.t, 'outcome');
  assert.equal(out.id, id);
  assert.equal(out.result, 'done');
  assert.equal(out.why, 'in by a door');
  assert.equal(out.ms, 20_000);
  assert.equal(out.hpDuring, -15);
  assert.equal(out.lostDuring, 15);
  // 10 more hp lost and a chase begins inside the minute after.
  tr.observe(live({ hp: 75, zChasing: 1, zList: [{ d: 6, chase: true }] }), 40_000);
  tr.observe(live({ hp: 75 }), 20_000 + AFTER_MS + 1_000);
  // Hp lost after the minute does not count, and neither does a later chase.
  tr.observe(live({ hp: 50, zChasing: 2 }), 150_000);
  assert.equal(lines.length, 2, 'the after line waits for the 5 minute window');
  tr.observe(live({ hp: 50 }), DEATH_MS + 1_000);
  const after = lines[2];
  assert.equal(after.t, 'after');
  assert.equal(after.id, id);
  assert.equal(after.hpAfter, -10);
  assert.equal(after.lostAfter, 10);
  assert.equal(after.chased, true);
  assert.equal(after.died, false);
  assert.equal(tr.openCount(), 0);
});

test('a failed order records the reason', () => {
  const { lines, tr, send } = setup();
  send(live(), 8, 0);
  tr.observe(live({ res: { seq: 8, status: 'failed', verb: 'ENTER', why: 'stuck' } }), 4_000);
  assert.equal(lines[1].result, 'failed');
  assert.equal(lines[1].why, 'stuck');
});

test('a result for a different order does not finish this one', () => {
  const { lines, tr, send } = setup();
  send(live(), 8, 0);
  tr.observe(live({ res: { seq: 7, status: 'done', verb: 'GOTO' } }), 4_000);
  assert.equal(lines.length, 1);
});

test('dying inside the window closes the order as died', () => {
  const { lines, tr, send } = setup();
  const id = send(live(), 5, 0);
  tr.observe(live({ hp: 40 }), 10_000);
  tr.observe({ dead: true }, 30_000);
  assert.deepEqual(lines.slice(1).map((l) => l.t), ['outcome', 'after']);
  assert.equal(lines[1].result, 'unfinished');
  assert.equal(lines[1].why, 'died');
  assert.equal(lines[2].died, true);
  assert.equal(lines[2].id, id);
  assert.equal(tr.openCount(), 0);
});

test('a newer order replaces the one before it', () => {
  const { lines, tr, send } = setup();
  const first = send(live(), 5, 0);
  tr.observe(live({ hp: 90 }), 2_000);
  send(live({ hp: 90 }), 6, 3_000);
  const out = lines.find((l) => l.t === 'outcome');
  assert.equal(out.id, first);
  assert.equal(out.result, 'replaced');
  assert.equal(out.lostDuring, 10);
});

test('an order with no result is closed after five minutes', () => {
  const { lines, tr, send } = setup();
  send(live(), 5, 0);
  tr.observe(live(), DEATH_MS + 1_000);
  assert.equal(lines.find((l) => l.t === 'outcome').result, 'unfinished');
});

test('a new character (hours going back) closes the order without a death', () => {
  const { lines, tr, send } = setup();
  send(live({ hoursAlive: 50 }), 5, 0);
  tr.observe(live({ hoursAlive: 1 }), 5_000);
  assert.equal(lines.at(-1).t, 'after');
  assert.equal(lines.at(-1).died, false);
});

test('joinRecords attaches the outcome and after lines by id, in decision order', () => {
  const { lines, tr, send } = setup();
  const a = send(live(), 5, 0);
  tr.observe(live({ res: { seq: 5, status: 'done', verb: 'ENTER', why: 'ok' } }), 3_000);
  const b = send(live(), 6, 4_000);
  tr.observe(live({ hp: 60 }), 10_000);
  tr.observe(live({ hp: 60 }), DEATH_MS + AFTER_MS + 10_000);
  const recs = joinRecords(lines);
  assert.deepEqual(recs.map((r) => r.id), [a, b]);
  assert.equal(recs[0].outcome.result, 'done');
  assert.ok(recs[0].after);
  assert.equal(recs[1].outcome.result, 'unfinished');
  assert.equal(harm(recs[1]), 40);
  // Lines for an id with no decision, or that are not objects, are ignored.
  assert.equal(joinRecords([...lines, { t: 'outcome', id: 'zzz' }, null, 'x', { t: 'decision' }]).length, 2);
  assert.deepEqual(joinRecords(null), []);
});

test('the appender rotates to .1 past the size cap and keeps every line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-log-'));
  try {
    const file = path.join(dir, 'decisions.jsonl');
    const append = createAppender(file, { maxBytes: 400 });
    for (let i = 0; i < 9; i++) assert.ok(append({ t: 'decision', id: `d${i}`, pad: 'x'.repeat(60) }));
    assert.ok(fs.existsSync(file + '.1'), 'rotated');
    assert.ok(fs.statSync(file).size <= 400, 'the live file stays under the cap');
    assert.ok(fs.statSync(file + '.1').size <= 400);
    const ids = readLog(file).map((l) => l.id);
    assert.deepEqual(ids, ids.slice().sort(), 'rotated lines come first, in order');
    assert.equal(ids.at(-1), 'd8');
    // A second rotation drops the oldest file, not the newest.
    for (let i = 9; i < 40; i++) append({ t: 'decision', id: `d${i}`, pad: 'x'.repeat(60) });
    assert.equal(readLog(file).at(-1).id, 'd39');
    assert.ok(readLog(file).length < 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the appender picks up the size of a file that is already there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-log-'));
  try {
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, '{"id":"old","pad":"' + 'x'.repeat(300) + '"}\n');
    createAppender(file, { maxBytes: 400 })({ id: 'new', pad: 'y'.repeat(200) });
    assert.equal(readLog(file, { rotated: false }).map((l) => l.id).join(), 'new');
    assert.equal(parseLines(fs.readFileSync(file + '.1', 'utf8'))[0].id, 'old');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readers skip junk lines and a missing file', () => {
  assert.deepEqual(parseLines('{"a":1}\nnot json\n\n[1]\n{"b":2'), [{ a: 1 }]);
  assert.deepEqual(readLog(path.join(os.tmpdir(), 'ls-no-such-file.jsonl')), []);
});

test('a death line carries the cause, the job and the zombies close, and is not a decision', () => {
  const { lines, tr } = setup();
  tr.death({
    start: '2026-11-05T07:03:14.591Z', cause: 'overrun while fleeing', day: 3, hoursAlive: 12.5, startHours: 1, kills: 6,
    death: { job: 'GOTO', order: 'GOTO', status: 'running', zAdj: 3, zClose: 5, zChasing: 2, hpLost10: 90, inside: false, reflex: 'flee', source: 'mod', text: 'You died.' },
  }, 5000);
  const d = lines[0];
  assert.equal(d.t, 'death');
  assert.equal(d.run, '2026-11-05T07:03:14.591Z');
  assert.equal(d.cause, 'overrun while fleeing');
  assert.equal(d.job, 'GOTO');
  assert.equal(d.zClose, 3);
  assert.equal(d.zChasing, 2);
  assert.equal(d.hpLost10, 90);
  assert.equal(d.hours, 11.5);
  assert.equal(d.source, 'mod');
  assert.deepEqual(joinRecords(lines), []);
  tr.death(null);
  assert.equal(lines.length, 1);
});
