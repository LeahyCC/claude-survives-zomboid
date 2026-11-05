// The turn the reflex hands back (chase.mjs): the escape menu, the plan that carries it, the order
// it sends with a posture, and the decision line that lets review.mjs count it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture } from './fixtures/load.mjs';
import { planTurn, resolveChoice, orderLine } from './brain.mjs';
import { buildOptions, escapeOptions, MAX_ESCAPE } from './options.mjs';
import { holdReason } from './senses.mjs';
import { createTracker, joinRecords } from './decisions.mjs';

const NOW = 1_000_000;
const ids = (opts) => opts.map((o) => o.id);
const byId = (opts, id) => opts.find((o) => o.id === id);
const BACK = { why: 'the reflex has had this chase for 60 seconds', ms: 60_000 };

// The soak's character: unarmed, no breath, one chaser 8.4 tiles east, houses to the north and west.
function soak(over = {}, memOver = null) {
  const { percept, memory } = loadFixture('v2-outside-chased.json', NOW);
  const p = {
    ...percept, weapon: 'none', weapons: [], endurance: 0, hp: 100, panic: 0, panic01: 0, bleeding: 0, wounds: [],
    moodle: { endurance: 3, heavy: 0, panic: 0, thirsty: 0, hungry: 0, tired: 0, pain: 0 },
    zChasing: 1, zClose: 1, zDist: 8.4, zVisible: 1,
    zList: [{ chase: true, crawl: false, d: 8.4, down: false, dx: 8, dy: 3 }],
    res: { seq: 31, status: 'running', verb: 'MOVE', why: '' },
    ...over,
  };
  if (memOver) memOver(memory);
  return { p, memory };
}

test('the soak percept is held: this is the loop', () => {
  const { p, memory } = soak();
  assert.match(holdReason(p), /chasing 8 tiles/);
  assert.deepEqual(planTurn(p, memory, { now: NOW }), { kind: 'hold', why: holdReason(p) });
});

test('handed back: the model gets a turn with the escape menu, and the policy and the running job do not end it', () => {
  const { p, memory } = soak({ res: { seq: 31, status: 'running', verb: 'ENTER', why: '', target: '4031' } });
  const plan = planTurn(p, memory, { now: NOW, handBack: BACK });
  assert.equal(plan.kind, 'ask');
  assert.deepEqual(plan.handBack, { why: BACK.why, ms: 60_000 });
  assert.equal(plan.force, true);
  assert.match(plan.why, /hand-back/);
  assert.deepEqual(ids(plan.options), ['b1', 'b2', 'away']);
  assert.match(plan.user, /60 seconds/);
  assert.match(plan.user, /Pick one id: b1, b2, away/);
  assert.match(plan.user, /OPTIONS:\nb1: walk into/);
});

test('the escape menu: the nearest houses first, a walk away, each told to avoid fights', () => {
  const { p, memory } = soak();
  const opts = escapeOptions(p, memory, { now: NOW });
  const [b1, b2, away] = opts;
  assert.deepEqual([b1.verb, b1.target, b1.posture], ['ENTER', '4031', 'avoid']);
  assert.deepEqual([b2.verb, b2.target, b2.posture], ['ENTER', '4021', 'avoid']);
  assert.match(b1.label, /walk into house 12 tiles N and shut the door behind you/);
  assert.equal(away.verb, 'GOTO');
  assert.equal(away.posture, 'avoid');
  assert.ok(away.a < p.x, 'walks west, away from the zombie in the east');
  assert.match(away.label, /out of sight of the zombie that will not give up/);
  // The 4033 door is past the zombie: not offered.
  assert.ok(!opts.some((o) => o.target === '4033'));
  assert.ok(opts.length <= MAX_ESCAPE);
  assert.ok(!ids(opts).includes('keep'));
  assert.ok(!ids(opts).includes('wait'));
});

test('the usual menu is not the escape menu: it has needs, explore and wait', () => {
  const { p, memory } = soak();
  const usual = buildOptions(p, memory, { now: NOW });
  assert.ok(ids(usual).includes('wait') || ids(usual).includes('keep'));
});

test('fighting back is only offered with a weapon and the health and breath for it, and sets the clear posture', () => {
  const armed = { weapon: 'Baseball Bat', endurance: 0.9, weight: 2, moodle: { endurance: 0, heavy: 0, panic: 0 } };
  const { p, memory } = soak(armed);
  const fight = byId(escapeOptions(p, memory, { now: NOW }), 'fight');
  assert.deepEqual([fight.verb, fight.posture, fight.key], ['WAIT', 'clear', 'STAND']);
  assert.match(fight.label, /Baseball Bat/);
  for (const worse of [{ weapon: 'none' }, { endurance: 0.1 }, { hp: 40 }, { bleeding: 1 }, { panic01: 0.5 }]) {
    const w = soak({ ...armed, ...worse });
    assert.ok(!byId(escapeOptions(w.p, w.memory, { now: NOW }), 'fight'), JSON.stringify(worse));
  }
  // Three chasing is a pack: not a fight to pick.
  const pack = soak({ ...armed, zList: [1, 2, 3].map((i) => ({ chase: true, d: 6 + i, dx: 6 + i, dy: 0, down: false, crawl: false })) });
  assert.ok(!byId(escapeOptions(pack.p, pack.memory, { now: NOW }), 'fight'));
});

test('inside, the first way out is to shut the doors, once', () => {
  const inside = { outside: false, inBldg: { id: '4030', rooms: 3, roomsLeft: 2 } };
  const { p, memory } = soak(inside);
  const opts = escapeOptions(p, memory, { now: NOW });
  assert.equal(opts[0].id, 'secure');
  assert.equal(opts[0].verb, 'SECURE');
  assert.match(opts[0].label, /a door between you and it/);
  // Shut this visit: the map memory says so, and the option is not offered again.
  const shut = soak(inside, (m) => {
    m.buildings['4030'] = { firstSeen: 0, lastSeen: 0, lastVisit: 0, took: [], zombies: 0, enteredAt: 1, securedAt: 2 };
  });
  assert.ok(!ids(escapeOptions(shut.p, shut.memory, { now: NOW })).includes('secure'));
});

test('with nothing else to offer the menu is a wait, never empty', () => {
  const { p, memory } = soak({ buildings: [], zList: [{ chase: true, d: 8.4, down: false, crawl: false, dx: 8, dy: 3 }] },
    (m) => { m.fails.AWAY = { why: 'tried', at: NOW }; });
  assert.deepEqual(ids(escapeOptions(p, memory, { now: NOW })), ['wait']);
});

test('a hand-back only means something while the reflex holds it, and a pending order still waits', () => {
  const far = soak({ zChasing: 1, zList: [{ chase: true, d: 14, down: false, crawl: false, dx: 14, dy: 0 }], zClose: 0, zDist: 14 });
  const plan = planTurn(far.p, far.memory, { now: NOW, handBack: BACK });
  assert.equal(plan.handBack, undefined, 'nothing holds her, so this is an ordinary turn');
  assert.ok(!plan.force);
  const near = soak();
  const pending = planTurn(near.p, near.memory, { now: NOW, handBack: BACK, pending: { seq: 99, at: NOW - 1000 } });
  assert.equal(pending.kind, 'pending');
});

test('asleep still wins: a hand-back does not wake her into the dark', () => {
  const { p, memory } = soak({ asleep: true });
  assert.equal(planTurn(p, memory, { now: NOW, handBack: BACK }).kind, 'asleep');
});

test('a pick that matches the running job is sent again when the turn was handed back', () => {
  const { p, memory } = soak({ res: { seq: 31, status: 'running', verb: 'ENTER', why: '', target: '4031' } });
  const plan = planTurn(p, memory, { now: NOW, handBack: BACK });
  const b1 = byId(plan.options, 'b1');
  assert.equal(b1.target, '4031');
  assert.equal(resolveChoice(p, memory, plan.options, 'b1'), null, 'the usual rule: it is already running, so keep');
  assert.equal(resolveChoice(p, memory, plan.options, 'b1', plan.force), b1, 'forced: the walk restarts');
  assert.equal(resolveChoice(p, memory, plan.options, 'nope', true), null);
});

test('the order carries the posture to the mod, and a plain one carries none', () => {
  const { p, memory } = soak();
  const [b1] = escapeOptions(p, memory, { now: NOW });
  assert.match(orderLine(7, b1, 'a door'), /^7\|ENTER\|0\|0\|\|a door\|.+\|4031\|avoid$/);
  const armed = soak({ weapon: 'Baseball Bat', endurance: 0.9, weight: 2, moodle: { endurance: 0 } });
  const fight = byId(escapeOptions(armed.p, armed.memory, { now: NOW }), 'fight');
  assert.match(orderLine(8, fight, 'stand'), /^8\|WAIT\|.*\|clear$/);
  const wait = { id: 'wait', verb: 'WAIT', a: 0, b: 0, target: '', key: 'WAIT', label: 'wait' };
  assert.ok(!orderLine(9, wait, 'x').endsWith('|avoid'));
});

test('the decision line says it was handed back, and only then', () => {
  const lines = [];
  const tracker = createTracker({ write: (l) => lines.push(l) });
  const { p, memory } = soak();
  const plan = planTurn(p, memory, { now: NOW, handBack: BACK });
  const option = byId(plan.options, 'b1');
  const id = tracker.decide({ percept: p, run: 'r', menu: plan.options, option, seq: 40, by: 'model', choice: 'b1', thought: 'inside', handback: plan.handBack }, NOW);
  tracker.decide({ percept: p, run: 'r', menu: plan.options, option, seq: 41, by: 'model', choice: 'b1', thought: 'again' }, NOW + 1000);
  const [back, plain] = lines.filter((l) => l.t === 'decision');
  assert.deepEqual(back.handback, { why: BACK.why, ms: 60_000 });
  assert.equal('handback' in plain, false);
  const recs = joinRecords(lines);
  assert.equal(recs.find((r) => r.id === id).handback.ms, 60_000);
});
