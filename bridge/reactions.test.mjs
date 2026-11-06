// Reactions: the outcome lines, the blocked list, loop detection, the strip rows, and how they land in the prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { shortName, reasonText, outcomeText, recentLines, blockedLines, findPattern, reactionContext, reactionRows, LOOP_MS, REPEAT_MS } from './reactions.mjs';
import { createTracker } from './decisions.mjs';
import { planTurn, userMessage } from './brain.mjs';
import { buildOptions } from './options.mjs';
import { emptyMemory } from './memory.mjs';
import { readBase, loadScenarios, buildScenario } from './eval/scenarios.mjs';

const NOW = 1_000_000;
const rec = (o = {}) => ({ id: 'x', seq: 1, at: NOW - 1000, run: 'r1', verb: 'ENTER', key: 'ENTER:7', name: 'ENTER house W', result: null, why: '', hp: 0, lost: 0, chase: 0, ...o });
const away = (o = {}) => rec({ verb: 'GOTO', key: 'AWAY', name: 'GOTO away', result: 'done', ...o });
const enter = (o = {}) => rec(o);

test('an order is named by its verb, plus the building or the walk', () => {
  assert.equal(shortName({ verb: 'ENTER', id: 'b1', name: 'house W' }), 'ENTER house W');
  assert.equal(shortName({ verb: 'GOTO', id: 'away' }), 'GOTO away');
  assert.equal(shortName({ verb: 'SEARCH', id: 'search' }), 'SEARCH');
  assert.equal(shortName(null), 'order');
  assert.equal(shortName({ id: 'keep', verb: null }), 'order');
});

test('the menu names a building walk by kind and side, not by its id', () => {
  const p = readBase();
  const b1 = buildOptions(p, emptyMemory(), { now: NOW }).find((o) => o.id === 'b1');
  assert.equal(b1.name, 'house N');
  assert.equal(shortName(b1), 'ENTER house N');
});

test('reasons come out in plain words, and an unknown one is kept short', () => {
  assert.equal(reasonText('zombie', 'ENTER'), 'zombies at the door');
  assert.equal(reasonText('zombie', 'SEARCH'), 'zombies too close');
  assert.equal(reasonText('stuck'), 'got stuck on the way');
  assert.equal(reasonText(''), '');
  assert.equal(reasonText('x'.repeat(100)).length, 40);
});

test('outcome lines: failed, done and chased, cut off, no result, died', () => {
  assert.equal(outcomeText(enter({ result: 'failed', why: 'zombie', lost: 20 })), 'failed, zombies at the door, lost 20 HP');
  assert.equal(outcomeText(away({ chase: 2 })), 'done, still chased by 2');
  assert.equal(outcomeText(away()), 'done');
  assert.equal(outcomeText(enter({ result: 'done', lost: 0.4 })), 'done', 'a scratch under 1 HP is not mentioned');
  assert.equal(outcomeText(enter({ result: 'replaced' })), 'cut off by a newer order');
  assert.equal(outcomeText(enter({ result: 'unfinished', why: 'no result in 5 minutes' })), 'no result in time');
  assert.equal(outcomeText(enter({ result: 'unfinished', why: 'died' })), 'she died before it finished');
});

test('the running order reads the percept: rooms left, the body\'s note, or not started', () => {
  const search = rec({ verb: 'SEARCH', name: 'SEARCH', seq: 7 });
  assert.equal(outcomeText(search, { lastSeq: 7, inBldg: { id: '1', roomsLeft: 2 } }), 'running, 2 rooms left');
  assert.equal(outcomeText(search, { lastSeq: 7, inBldg: { id: '1', roomsLeft: 1 } }), 'running, 1 room left');
  assert.equal(outcomeText(rec({ seq: 7 }), { lastSeq: 7, res: { seq: 7, status: 'running', why: 'walking' } }), 'running, walking');
  assert.equal(outcomeText(rec({ seq: 7 }), { lastSeq: 6 }), 'sent, not started yet');
  assert.equal(outcomeText(rec({ seq: 7 }), null), 'running');
});

test('recent lines: the last 3, oldest first, each under 90 characters', () => {
  const h = [away({ at: 1 }), enter({ at: 2, result: 'failed', why: 'zombie', lost: 20 }), away({ at: 3, chase: 2 }),
    rec({ at: 4, verb: 'SEARCH', name: 'SEARCH', seq: 9 })];
  const lines = recentLines(h, { lastSeq: 9, inBldg: { id: '1', roomsLeft: 2 } }, 'r1');
  assert.deepEqual(lines, [
    'ENTER house W: failed, zombies at the door, lost 20 HP',
    'GOTO away: done, still chased by 2',
    'SEARCH: running, 2 rooms left',
  ]);
  assert.ok(lines.every((l) => l.length <= 90));
  const long = recentLines([enter({ result: 'failed', why: 'q'.repeat(300), lost: 12, name: 'ENTER ' + 'z'.repeat(120) })], null, 'r1');
  assert.ok(long[0].length <= 90);
});

test('recent lines leave out another character\'s orders and junk entries', () => {
  const h = [enter({ run: 'old', result: 'done' }), null, 'x', enter({ run: 'r1', result: 'done' })];
  assert.equal(recentLines(h, null, 'r1').length, 1);
  assert.equal(recentLines(h, null, null).length, 2, 'no run id: nothing is filtered by run');
  assert.deepEqual(recentLines(undefined, null, 'r1'), []);
  assert.deepEqual(recentLines('no', null, 'r1'), []);
});

// A map memory with a house listed in the percept and a failure parked on it.
function failedHouse(why, agoMs) {
  const mem = emptyMemory();
  mem.fails['ENTER:4060'] = { why, at: NOW - agoMs };
  return mem;
}

test('blocked lines name the house by where it is now, with the reason and how long ago', () => {
  const p = readBase();
  const mem = failedHouse('locked', 4 * 60_000);
  assert.deepEqual(blockedLines(mem, p, NOW), ['house N: the door is locked, 4 min ago']);
  mem.fails['ENTER:4060'] = { why: 'zombie', at: NOW - 10_000 };
  assert.deepEqual(blockedLines(mem, p, NOW), ['house N: zombies at the door, just now']);
});

test('blocked lines skip expired fails, a building the percept does not list, and the EQUIP park', () => {
  const p = readBase();
  // A failed ENTER with zombies stays off for 5 minutes now (memory.mjs, ENTER_ZOMBIE_MS), other orders 30 s.
  assert.equal(blockedLines(failedHouse('zombie', 31_000), p, NOW).length, 1);
  assert.deepEqual(blockedLines(failedHouse('zombie', 5 * 60_000 + 1000), p, NOW), []);
  const elsewhere = emptyMemory();
  elsewhere.fails['ENTER:9999'] = { why: 'locked', at: NOW - 1000 };
  assert.deepEqual(blockedLines(elsewhere, p, NOW), []);
  const parked = emptyMemory();
  parked.fails.EQUIP = { why: 'just sent', at: NOW - 1000 };
  assert.deepEqual(blockedLines(parked, p, NOW), []);
  assert.deepEqual(blockedLines(null, p, NOW), []);
  assert.deepEqual(blockedLines({ fails: 'no' }, p, NOW), []);
});

test('blocked lines: other keys get words, newest first, at most 3', () => {
  const p = readBase();
  const mem = failedHouse('locked', 2 * 60_000);
  mem.fails.AWAY = { why: 'stuck', at: NOW - 20_000 };
  mem.fails.DRINK = { why: 'no water', at: NOW - 60_000 };
  mem.fails['SEARCH:4060'] = { why: 'full', at: NOW - 90_000 };
  const lines = blockedLines(mem, p, NOW);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'walking away: got stuck on the way, just now');
  assert.match(lines[1], /^drink: no water, 1 min ago$/);
  assert.match(lines[2], /^searching this building: full, 2 min ago$/);
});

test('a flee and a walk back in, twice in two minutes, is a loop', () => {
  const h = [away({ at: NOW - 110_000 }), enter({ at: NOW - 95_000, result: 'replaced' }), away({ at: NOW - 70_000 }),
    enter({ at: NOW - 55_000, result: 'failed', why: 'zombie' })];
  assert.match(findPattern(h, NOW, 'r1'), /^You keep getting chased off houses/);
  // One cycle is not a pattern yet.
  assert.equal(findPattern(h.slice(2), NOW, 'r1'), '');
  // The same orders spread over more than two minutes are not a loop.
  assert.equal(findPattern(h.map((e) => ({ ...e, at: e.at - LOOP_MS })), NOW, 'r1'), '');
  // A flee followed by something else is not a re-entry.
  const other = [away({ at: NOW - 100_000 }), rec({ at: NOW - 90_000, verb: 'SEARCH', key: 'SEARCH:1', result: 'done' }),
    away({ at: NOW - 60_000 }), rec({ at: NOW - 50_000, verb: 'SEARCH', key: 'SEARCH:1', result: 'done' })];
  assert.equal(findPattern(other, NOW, 'r1'), '');
});

test('the same kind of order failing twice in a row is named, and a success in between clears it', () => {
  const f = (verb, ago, o = {}) => rec({ verb, key: `${verb}:1`, at: NOW - ago, result: 'failed', why: 'stuck', ...o });
  assert.equal(findPattern([f('ENTER', 90_000), f('ENTER', 30_000)], NOW, 'r1'), 'Walking into a building failed twice in a row. Try something else first.');
  assert.match(findPattern([f('SEARCH', 150_000), f('SEARCH', 90_000), f('SEARCH', 30_000)], NOW, 'r1'), /^Searching failed 3 times in a row/);
  assert.equal(findPattern([f('ENTER', 90_000), f('ENTER', 30_000, { result: 'done' })], NOW, 'r1'), '');
  assert.equal(findPattern([f('ENTER', 90_000), f('SEARCH', 60_000), f('ENTER', 30_000)], NOW, 'r1'), 'Walking into a building failed twice in a row. Try something else first.');
  assert.equal(findPattern([f('ENTER', 90_000), f('SEARCH', 30_000)], NOW, 'r1'), '', 'two failures of different kinds');
  assert.equal(findPattern([f('ENTER', 600_000), f('ENTER', 500_000)], NOW, 'r1'), '', 'too old');
  assert.equal(findPattern([f('ENTER', 90_000), f('ENTER', 30_000, { run: 'old' })], NOW, 'r1'), '', 'the other character\'s order');
  assert.equal(findPattern([], NOW, 'r1'), '');
  assert.equal(findPattern(null, NOW, 'r1'), '');
});

test('an order that just failed and is already back on the menu gets a warning line', () => {
  const failed = enter({ at: NOW - 40_000, result: 'failed', why: 'zombie', name: 'ENTER house N' });
  const menu = [{ id: 'b1', key: 'ENTER:7' }, { id: 'wait', key: 'WAIT' }];
  assert.equal(findPattern([failed], NOW, 'r1', menu),
    'Your last order, ENTER house N, failed (zombies at the door). It is on the menu again. Try something else first.');
  assert.equal(findPattern([failed], NOW, 'r1', [{ id: 'wait', key: 'WAIT' }]), '', 'not offered again');
  assert.equal(findPattern([failed], NOW, 'r1'), '', 'no menu given');
  assert.equal(findPattern([failed, away({ at: NOW - 20_000 })], NOW, 'r1', menu), '', 'a newer order was sent since');
  assert.equal(findPattern([{ ...failed, at: NOW - REPEAT_MS - 1000 }], NOW, 'r1', menu), '', 'too old');
});

test('the strip: the last 8 rows, each with the choice that came next', () => {
  const h = Array.from({ length: 10 }, (_, i) => rec({ seq: i, at: i, name: `n${i}`, result: i === 9 ? null : 'done', hp: -i, lost: i }));
  const rows = reactionRows(h);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].choice, 'n2');
  assert.equal(rows[0].next, 'n3');
  assert.equal(rows[7].next, null, 'the newest has no next yet');
  assert.equal(rows[7].status, 'running');
  assert.equal(rows[7].hp, null, 'a running order has no hp change yet');
  assert.equal(rows[0].hp, -2);
  const f = reactionRows([enter({ result: 'failed', why: 'zombie', hp: -20, lost: 20 }), away()]);
  assert.equal(f[0].result, 'failed, zombies at the door, lost 20 HP');
  assert.equal(f[0].next, 'GOTO away');
  assert.deepEqual(reactionRows(null), []);
  assert.equal(reactionRows([enter({ result: 'replaced', hp: -3 })])[0].hp, null);
});

test('the strip carries each order\'s id and the critic summary for it, when there is one', () => {
  const h = [rec({ id: 'a1', seq: 1, at: 1, name: 'n1', result: 'done' }), rec({ id: 'a2', seq: 2, at: 2, name: 'n2' })];
  const seen = [];
  const rows = reactionRows(h, null, 8, (id) => { seen.push(id); return id === 'a1' ? { flag: true, pPick: 0.04, top: 'away', danger: 0.8 } : null; });
  assert.deepEqual(rows.map((r) => r.id), ['a1', 'a2']);
  assert.deepEqual(rows[0].critic, { flag: true, pPick: 0.04, top: 'away', danger: 0.8 });
  assert.equal(rows[1].critic, null);
  assert.deepEqual(seen, ['a1', 'a2']);
  assert.equal(reactionRows(h)[0].critic, null, 'no critic, no summary');
  assert.equal(reactionRows([{ verb: 'GOTO' }], null, 8, () => { throw new Error('asked with no id'); })[0].critic, null);
});

test('the tracker keeps a record per order with its result, hp change, chase and name', () => {
  const lines = [];
  const tr = createTracker({ write: (o) => lines.push(o) });
  const opt = { id: 'b1', verb: 'ENTER', key: 'ENTER:7', name: 'house W', label: 'walk into house 9 tiles W', a: 0, b: 0, target: '7' };
  const live = (o = {}) => ({ v: 2, hp: 100, hoursAlive: 10, day: 1, hour: 12, zChasing: 0, zList: [], ...o });
  tr.decide({ percept: live(), run: 'r1', menu: [opt], option: opt, seq: 5, by: 'model', choice: 'b1' }, 0);
  assert.equal(tr.history().length, 1);
  assert.equal(tr.history()[0].result, null, 'running has no result');
  assert.equal(tr.history()[0].name, 'ENTER house W');
  tr.observe(live({ hp: 80, zChasing: 2, zList: [{ d: 4, chase: true }, { d: 6, chase: true }], res: { seq: 5, status: 'failed', verb: 'ENTER', why: 'zombie' } }), 12_000);
  const h = tr.history()[0];
  assert.equal(h.result, 'failed');
  assert.equal(h.why, 'zombie');
  assert.equal(h.hp, -20);
  assert.equal(h.lost, 20);
  assert.equal(h.chase, 2);
  assert.equal(h.run, 'r1');
  // A newer order cuts the running one off, and "keep" adds no record.
  const go = { id: 'away', verb: 'GOTO', key: 'AWAY', a: 1, b: 2, target: '', label: 'walk away' };
  tr.decide({ percept: live(), run: 'r1', menu: [opt], option: opt, seq: 6, by: 'model', choice: 'b1' }, 20_000);
  tr.decide({ percept: live({ hp: 100, zChasing: 1 }), run: 'r1', menu: [go], option: go, seq: 7, by: 'model', choice: 'away' }, 25_000);
  tr.decide({ percept: live(), run: 'r1', menu: [go], option: null, seq: 0, by: 'model', choice: 'keep' }, 26_000);
  const all = tr.history();
  assert.equal(all.length, 3);
  assert.equal(all[1].result, 'replaced');
  assert.equal(all[2].name, 'GOTO away');
  // History is a copy: editing it changes nothing inside.
  all[0].result = 'done';
  assert.equal(tr.history()[0].result, 'failed');
});

test('the tracker keeps at most 12 orders and closes the open one when she dies', () => {
  const tr = createTracker({ write: () => {} });
  const opt = { id: 'b1', verb: 'ENTER', key: 'ENTER:7', name: 'house W' };
  const p = { v: 2, hp: 100, hoursAlive: 10, zChasing: 0, zList: [] };
  for (let i = 0; i < 15; i++) tr.decide({ percept: p, run: 'r1', menu: [opt], option: opt, seq: i + 1 }, i * 1000);
  assert.equal(tr.history().length, 12);
  tr.observe({ ...p, dead: true }, 20_000);
  assert.equal(tr.history().at(-1).result, 'unfinished');
  assert.equal(tr.history().at(-1).why, 'died');
});

const house = (id, dx, dy) => ({ d: Math.abs(dx) + Math.abs(dy), door: { x: 10650 + dx, y: 9830 + dy }, dx, dy, id, res: true, shop: false, visited: false });

test('the prompt shows the three sections only when there is something to say', () => {
  const s = loadScenarios().find((x) => x.name === 'flee-loop-quieter-house');
  const { percept, memory, history } = buildScenario(s);
  const withAll = planTurn(percept, memory, { now: NOW, history });
  assert.equal(withAll.kind, 'ask');
  assert.match(withAll.user, /RECENT CHOICES:\n- ENTER house N: cut off by a newer order\n- GOTO away: done, still chased by 2\n- ENTER house N: failed, zombies at the door, lost 20 HP\n/);
  assert.match(withAll.user, /\nYou keep getting chased off houses\./);
  assert.ok(withAll.user.indexOf('RECENT CHOICES') < withAll.user.indexOf('OPTIONS:'));
  const plain = planTurn(percept, memory, { now: NOW });
  assert.doesNotMatch(plain.user, /RECENT CHOICES|NOT ON THE MENU|keep getting/);
});

test('a failed house is listed as not on the menu, with why and when, and is not an option', () => {
  const base = readBase();
  const p = { ...base, buildings: [house('4060', 0, -9), house('4061', 16, 0)] };
  const mem = emptyMemory();
  mem.fails['ENTER:4060'] = { why: 'zombie', at: NOW - 12_000 };
  const plan = planTurn(p, mem, { now: NOW, history: [enter({ run: null, at: NOW - 12_000, result: 'failed', why: 'zombie', lost: 20, name: 'ENTER house N' })] });
  assert.equal(plan.kind, 'ask');
  assert.ok(!plan.options.some((o) => o.target === '4060'));
  assert.match(plan.user, /NOT ON THE MENU NOW:\n- house N: zombies at the door, just now\n/);
  // The three sections sit between the examples/rules and the menu, in this order.
  const at = (t) => plan.user.indexOf(t);
  assert.ok(at('RECENT CHOICES') < at('NOT ON THE MENU') && at('NOT ON THE MENU') < at('OPTIONS:'));
});

test('the prompt stays short: three recent lines, three blocked lines and a pattern line', () => {
  const p = readBase();
  const mem = emptyMemory();
  const opts = buildOptions(p, mem, { now: NOW });
  const plain = userMessage(p, mem, opts, [], [], []);
  const full = userMessage(p, mem, opts, [], [], recentLines([away(), away(), away()], null, 'r1'), {
    blocked: ['house N: zombies at the door, 4 min ago', 'walking away: got stuck on the way, 1 min ago', 'drink: no water, 2 min ago'],
    pattern: 'You keep getting chased off houses. Try a quieter house, or leave this street.',
  });
  assert.ok(full.length - plain.length < 560, `${full.length - plain.length} extra characters`);
});

test('reactionContext survives empty input', () => {
  const ctx = reactionContext({ history: undefined, mem: emptyMemory(), p: readBase(), now: NOW });
  assert.deepEqual(ctx, { recent: [], blocked: [], pattern: '' });
});
