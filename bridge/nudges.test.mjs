// Nudges: the request, the refusals, the frozen record, and the examples that go into the prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture } from './fixtures/load.mjs';
import { planTurn, resolveChoice } from './brain.mjs';
import { memorySlice } from './memory.mjs';
import {
  parseNudgeBody, planNudge, planSlice, situationOf, situationLabel, indexNudges, pickExamples, exampleLines,
  examplesEnabled, MAX_WHY, MAX_EXAMPLES,
} from './nudges.mjs';

const NOW = 1_000_000;
const T0 = Date.parse('2026-11-04T10:00:00Z');

function snapshotOf(fixture, { serial = 1, choice = 'b1' } = {}) {
  const { percept, memory } = loadFixture(fixture);
  const turn = planTurn(percept, memory, { now: NOW });
  const snap = {
    serial, percept, menu: turn.options, choice, by: 'model gemma4:12b', rule: null, thought: 'A house to search.',
    kind: turn.kind, memory: memorySlice(memory, percept), plan: null,
  };
  return { snap, percept, memory };
}

const ctxFor = (s, extra = {}) => ({
  snapshots: [s.snap], percept: s.percept, perceptAt: T0, map: s.memory, now: T0 + 1000, run: 'run-1',
  resolve: (menu, id) => resolveChoice(s.percept, s.memory, menu, id), ...extra,
});

test('the request body is checked, whatever the page sends', () => {
  const ok = parseNudgeBody(JSON.stringify({ mode: 'log', turn: 3, pick: ' away ', why: '  too   close\n', missing: '' }));
  assert.deepEqual(ok, { ok: true, mode: 'log', turn: 3, pick: 'away', missing: '', why: 'too close' });
  assert.equal(parseNudgeBody('{"mode":').ok, false);
  assert.equal(parseNudgeBody('[]').ok, false);
  assert.equal(parseNudgeBody(JSON.stringify({ mode: 'later', pick: 'a' })).ok, false);
  assert.equal(parseNudgeBody(JSON.stringify({ mode: 'log', pick: 5 })).ok, false);
  assert.match(parseNudgeBody(JSON.stringify({ mode: 'log' })).message, /Pick an option/);
  assert.match(parseNudgeBody(JSON.stringify({ mode: 'now', missing: 'a ladder' })).message, /needs an option/);
  assert.equal(parseNudgeBody(JSON.stringify({ mode: 'log', missing: 'a ladder', turn: '3' })).turn, null);
  const long = parseNudgeBody(JSON.stringify({ mode: 'log', pick: 'away', why: 'w'.repeat(5000) }));
  assert.equal(long.why.length, MAX_WHY);
});

test('"Just log it" freezes the percept, menu, brain pick and thought and changes nothing', () => {
  const s = snapshotOf('v2-outside-unaware-near.json');
  const body = parseNudgeBody(JSON.stringify({ mode: 'log', turn: 1, pick: 'away', why: 'too close' }));
  const got = planNudge(body, ctxFor(s));
  assert.equal(got.ok, true);
  assert.equal(got.order, null);
  const r = got.record;
  assert.equal(r.t, 'nudge');
  assert.equal(r.mode, 'log');
  assert.equal(r.applied, false);
  assert.equal(r.pick, 'away');
  assert.equal(r.pickKey, 'AWAY');
  assert.equal(r.why, 'too close');
  assert.equal(r.brain.id, 'b1');
  assert.equal(r.brain.key, 'ENTER:4051');
  assert.equal(r.brain.thought, 'A house to search.');
  assert.equal(r.percept, s.percept);
  assert.deepEqual(r.menu.map((o) => o.id), s.snap.menu.map((o) => o.id));
  assert.equal(r.run, 'run-1');
  assert.match(r.situation, /^outside, day, not chased/);
  assert.ok(r.memory.buildings['4051']);
});

test('"Do it now" hands back the option to send, through the same menu entry', () => {
  const s = snapshotOf('v2-outside-unaware-near.json');
  const got = planNudge(parseNudgeBody(JSON.stringify({ mode: 'now', turn: 1, pick: 'away' })), ctxFor(s));
  assert.equal(got.ok, true);
  assert.equal(got.record.applied, true);
  assert.equal(got.order, s.snap.menu.find((o) => o.id === 'away'));
  assert.equal(got.order.verb, 'GOTO');
});

test('a missing-option note is logged with no pick, and never sent', () => {
  const s = snapshotOf('v2-outside-unaware-near.json');
  const got = planNudge(parseNudgeBody(JSON.stringify({ mode: 'log', turn: 1, missing: 'climb the fence' })), ctxFor(s));
  assert.equal(got.ok, true);
  assert.equal(got.record.pick, null);
  assert.equal(got.record.pickKey, null);
  assert.equal(got.record.missing, 'climb the fence');
});

test('"Do it now" is refused while the reflex owns the moment', () => {
  const s = snapshotOf('v2-outside-unaware-near.json');
  const chased = loadFixture('v2-outside-chased.json').percept;
  const got = planNudge(parseNudgeBody(JSON.stringify({ mode: 'now', turn: 1, pick: 'away' })), ctxFor(s, { percept: chased }));
  assert.equal(got.ok, false);
  assert.equal(got.status, 409);
  assert.match(got.message, /reflex owns this moment/);
  assert.match(got.message, /Nothing was sent/);
});

test('"Do it now" is refused while she is asleep', () => {
  const s = snapshotOf('v2-outside-unaware-near.json');
  const got = planNudge(parseNudgeBody(JSON.stringify({ mode: 'now', turn: 1, pick: 'away' })), ctxFor(s, { percept: { ...s.percept, asleep: true } }));
  assert.equal(got.ok, false);
  assert.match(got.message, /asleep/);
});

test('"Do it now" is refused with no live senses, a stale menu, keep, or the job already running', () => {
  const s = snapshotOf('v2-outside-unaware-near.json');
  const now = (pick, extra) => planNudge(parseNudgeBody(JSON.stringify({ mode: 'now', turn: 1, pick })), ctxFor(s, extra));
  assert.match(now('away', { perceptAt: T0 - 60_000 }).message, /No live senses/);
  assert.match(now('away', { percept: { ...s.percept, dead: true } }).message, /No live senses/);
  // The page looked at menu 1, but menu 2 is on now.
  const newer = { ...s.snap, serial: 2 };
  assert.match(now('away', { snapshots: [s.snap, newer] }).message, /menu changed/);
  // "Just log it" still works against the menu he saw.
  const logged = planNudge(parseNudgeBody(JSON.stringify({ mode: 'log', turn: 1, pick: 'away' })), ctxFor(s, { snapshots: [s.snap, newer] }));
  assert.equal(logged.ok, true);
  assert.equal(logged.record.percept, s.snap.percept);
  // keep is on a busy menu.
  const keep = { id: 'keep', verb: null, key: 'KEEP', label: 'keep going' };
  const busy = { ...s, snap: { ...s.snap, menu: [...s.snap.menu, keep] } };
  assert.match(planNudge(parseNudgeBody(JSON.stringify({ mode: 'now', turn: 1, pick: 'keep' })), ctxFor(busy)).message, /keep/);
  assert.match(now('away', { resolve: () => null }).message, /already doing that/);
});

test('a pick that is not on the menu, or a menu that is gone, is refused', () => {
  const s = snapshotOf('v2-outside-unaware-near.json');
  const body = (o) => parseNudgeBody(JSON.stringify({ mode: 'log', ...o }));
  assert.equal(planNudge(body({ turn: 1, pick: 'nope' }), ctxFor(s)).status, 400);
  assert.equal(planNudge(body({ turn: 9, pick: 'away' }), ctxFor(s)).status, 409);
  assert.equal(planNudge(body({ turn: 1, pick: 'away' }), ctxFor(s, { snapshots: [] })).status, 409);
  // No turn number: the newest menu is used.
  assert.equal(planNudge(body({ pick: 'away' }), ctxFor(s)).ok, true);
});

test('the plan slice keeps only what the menu reads', () => {
  assert.deepEqual(planSlice({ goal: 'g', steps: ['a', 3, 'b'], home: 4021, why: 'x', hours: 3 }), { goal: 'g', steps: ['a', 'b'], home: '4021' });
  assert.equal(planSlice(null), null);
  assert.equal(planSlice({ steps: [] }), null);
});

test('situations name place, time, chase and the main need', () => {
  const day = loadFixture('v2-outside-unaware-near.json').percept;
  assert.deepEqual(situationOf(day), { where: 'outside', time: 'day', chased: false, needs: ['heavy'] });
  const night = situationOf(loadFixture('v2-night-outside.json').percept);
  assert.equal(night.time, 'night');
  assert.ok(!night.needs.includes('night outside'));
  assert.equal(situationLabel({ where: 'inside', time: 'day', chased: true, needs: [] }), 'inside, day, chased, no urgent need');
});

// ---- examples ----

function nudgeRecord(fixture, pick, why, at, choice = 'b1') {
  const s = snapshotOf(fixture, { choice });
  const got = planNudge(parseNudgeBody(JSON.stringify({ mode: 'log', turn: 1, pick, why })), ctxFor(s, { now: Date.parse(at) }));
  assert.equal(got.ok, true, got.message);
  return got.record;
}

test('examples come from nudges in a similar spot, disagreements first, and only for a pick on the menu', () => {
  const { percept, memory } = loadFixture('v2-outside-unaware-near.json');
  const options = planTurn(percept, memory, { now: NOW }).options;
  const disagree = nudgeRecord('v2-outside-unaware-near.json', 'away', 'the zombie is too close', '2026-11-04T10:00:00Z');
  const agree = nudgeRecord('v2-outside-unaware-near.json', 'b1', 'good house', '2026-11-04T10:01:00Z');
  const index = indexNudges([disagree, agree, { t: 'nudge', pickKey: null }, 'junk', { t: 'decision' }]);
  assert.equal(index.length, 2);
  assert.equal(index[0].agreed, false);
  assert.equal(index[1].agreed, true);

  const one = pickExamples(index, percept, options, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].option.id, 'away');
  const two = pickExamples(index, percept, options);
  assert.equal(two.length, MAX_EXAMPLES);
  assert.deepEqual(two.map((c) => c.option.id), ['away', 'b1']);

  const lines = exampleLines(two);
  assert.equal(lines[0], `In a similar spot, the better pick was away (${options.find((o) => o.id === 'away').label.slice(0, 70)}) because the zombie is too close.`);

  // The same key under a different id still counts: the pick is matched on the key.
  const renamed = options.map((o) => (o.key === 'AWAY' ? { ...o, id: 'run' } : o));
  assert.equal(pickExamples(index, percept, renamed, 1)[0].option.id, 'run');
  // A pick that is no longer on the menu is not quoted.
  assert.deepEqual(pickExamples(index, percept, options.filter((o) => o.key !== 'AWAY' && o.key !== 'ENTER:4051')), []);
});

test('examples skip a different place, time of day or chase, and different needs', () => {
  const { percept, memory } = loadFixture('v2-outside-unaware-near.json');
  const options = planTurn(percept, memory, { now: NOW }).options;
  const index = indexNudges([nudgeRecord('v2-outside-unaware-near.json', 'away', 'x', '2026-11-04T10:00:00Z')]);
  assert.equal(pickExamples(index, percept, options).length, 1);
  assert.equal(pickExamples(index, { ...percept, hour: 23 }, options).length, 0, 'night');
  assert.equal(pickExamples(index, { ...percept, outside: false, inBldg: { id: '4051' } }, options).length, 0, 'inside');
  assert.equal(pickExamples(index, { ...percept, zChasing: 1, zList: [{ dx: 5, dy: 0, d: 5, chase: true }] }, options).length, 0, 'chased');
  assert.equal(pickExamples(index, { ...percept, thirst: 0.9, hunger: 0.9 }, options).length, 0, 'thirsty and hungry now, not then');
  assert.deepEqual(pickExamples([], percept, options), []);
  assert.deepEqual(pickExamples(index, null, options), []);
});

test('the user message carries the example lines only when nudges are passed in', () => {
  const { percept, memory } = loadFixture('v2-outside-unaware-near.json');
  const index = indexNudges([nudgeRecord('v2-outside-unaware-near.json', 'away', 'too close to walk past', '2026-11-04T10:00:00Z')]);
  const plain = planTurn(percept, memory, { now: NOW });
  const withNudges = planTurn(percept, memory, { now: NOW, nudges: index });
  assert.equal(plain.kind, 'ask');
  assert.doesNotMatch(plain.user, /similar spot/);
  assert.match(withNudges.user, /EXAMPLES:\n- In a similar spot, the better pick was away \(.*\) because too close to walk past\./);
  // Same prompt otherwise: the lines are an addition, not a rewrite.
  assert.equal(withNudges.user.replace(/EXAMPLES:\n- [^\n]*\n\n/, ''), plain.user);
});

test('PZ_EXAMPLES switches the examples on and off', () => {
  assert.equal(examplesEnabled({ PZ_EXAMPLES: '0' }), false);
  assert.equal(examplesEnabled({ PZ_EXAMPLES: 'off' }), false);
  assert.equal(examplesEnabled({ PZ_EXAMPLES: '1' }), true);
  assert.equal(examplesEnabled({ PZ_EXAMPLES: 'on' }), true);
  assert.equal(typeof examplesEnabled({}), 'boolean');
});
