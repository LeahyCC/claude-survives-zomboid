// The house job, stage by stage. Each test walks one percept after another through updateMemory,
// the way the bridge does, and reads the menu and the policy from what comes out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, merge } from './eval/scenarios.mjs';
import { buildOptions, setSearchLog } from './options.mjs';
import { decidePolicy } from './policy.mjs';
import { planTurn } from './brain.mjs';
import { updateMemory, recordOrder, loadMemory, memorySlice } from './memory.mjs';
import { drainJobEvents, jobLimit, doneWith, clearBlock, jobLine, MAX_LIMIT, MIN_LIMIT, MAX_REENTRIES, LOOK_MIN, LOOK_MAX, STALL_MAX, LEAVE_MAX, REVISIT_HOURS, CLEAR_MAX, CLEAR_MIN_HP } from './housejob.mjs';
import { holdReason, running } from './senses.mjs';
import { orderLine } from './brain.mjs';

setSearchLog(() => {});
const NOW = 1_000_000;
const MIN = 1 / 60;
const NEXT = { d: 12, door: { x: 10662, y: 9830 }, dx: 12, dy: 0, id: 'next', res: true, shop: false, visited: false };
const HOME = { d: 0, door: { x: 10648, y: 9830 }, dx: 0, dy: 0, id: 'h1', res: true, shop: false, visited: true };

const IN_HOUSE = {
  outside: false, room: 'kitchen', hour: 11, hoursAlive: 40, x: 10650, y: 9830, zList: [], zChasing: 0, zDist: -1, zVisible: 0,
  thirst: 0, hunger: 0, fatigue: 0, endurance: 1, bleeding: 0, wounds: [], weight: 1, maxWeight: 20, items: '', moodle: {},
  inv: { bandages: 1, waterL: 0.5, foodReady: 2, cans: 0, emptyBottles: 0 },
  inBldg: { id: 'h1', room: 'kitchen', rooms: 4, roomsLeft: 4, water: false },
  buildings: [HOME, NEXT],
};
const OUTSIDE = { outside: true, inBldg: null, room: '' };

// A moment outside, about to walk in. Every look() after it is one percept.
function scene(patch = {}, memory = {}) {
  const m = buildScenario({ patch: { ...IN_HOUSE, ...OUTSIDE, ...patch }, memory });
  m.at = NOW;
  m.seq = 0;
  return m;
}
function look(m, patch = {}, minutes = 0) {
  m.percept = { ...merge(m.percept, patch), hoursAlive: m.percept.hoursAlive + minutes * MIN };
  m.at += 1000;
  updateMemory(m.memory, m.percept, m.at);
  return m;
}
const menu = (m) => buildOptions(m.percept, m.memory, { now: m.at });
const ids = (m) => menu(m).map((o) => o.id);
const policy = (m) => decidePolicy(m.percept, m.memory, menu(m));
const stage = (m) => (m.memory.job ? m.memory.job.stage : null);
const inHouse = (patch = {}) => ({ ...IN_HOUSE, ...patch });

// The policy's order goes out. It runs to the end when told how.
function send(m, option) {
  m.seq += 1;
  recordOrder(m.memory, m.seq, option, m.percept, m.at);
  return m.seq;
}
function sendPolicy(m) {
  const got = policy(m);
  assert.ok(got, 'the policy has an order');
  return { seq: send(m, got.option), got };
}
const done = (m, seq, verb, why = '', extra = {}, minutes = 1) => look(m, { res: { seq, verb, status: 'done', why, target: 'h1' }, ...extra }, minutes);
const failed = (m, seq, verb, why, minutes = 1) => look(m, { res: { seq, verb, status: 'failed', why, target: 'h1' } }, minutes);

// In the house, past SHUT and LOOK, with SEARCH next.
function searching(patch = {}, memory = {}) {
  const m = scene({}, memory);
  look(m, inHouse(patch));
  const secure = sendPolicy(m);
  done(m, secure.seq, 'SECURE', 'closed 1 door');
  look(m, { res: null }, 3);
  assert.equal(stage(m), 'SEARCH');
  return m;
}
// Past SEARCH, with LEAVE next.
function leaving(memory = {}) {
  const m = searching({}, memory);
  const s = sendPolicy(m);
  done(m, s.seq, 'SEARCH', 'took 1: Bandage', { inBldg: { roomsLeft: 0 } });
  assert.equal(stage(m), 'LEAVE');
  return m;
}

test('coming into a house she has not searched opens a job, whichever way she got in', () => {
  const m = scene();
  assert.equal(stage(m), null);
  look(m, inHouse());
  assert.equal(stage(m), 'SHUT');
  assert.equal(m.memory.job.id, 'h1');
  assert.deepEqual(drainJobEvents(m.memory).map((e) => e.kind), ['open']);
  assert.deepEqual(drainJobEvents(m.memory), [], 'each event goes to the log once');
});

test('no job for a house already searched, or with no rooms left', () => {
  const searched = scene({}, { buildings: { h1: { searched: true, res: true } } });
  look(searched, inHouse());
  assert.equal(stage(searched), null);
  const empty = scene();
  look(empty, inHouse({ inBldg: { id: 'h1', rooms: 4, roomsLeft: 0 } }));
  assert.equal(stage(empty), null);
});

test('a scene that begins inside opens no job, so a menu rebuilt for the eval is the menu it was', () => {
  const m = buildScenario({ patch: inHouse(), memory: { current: 'h1' } });
  assert.equal(m.memory.job, null);
});

test('IN: an ENTER order opens the job, and the walk has no other house on its menu', () => {
  const m = scene({ buildings: [{ ...NEXT, id: 'other', dx: 20, door: { x: 10670, y: 9830 } }, NEXT] });
  const b1 = menu(m).find((o) => o.verb === 'ENTER' && o.target === 'next');
  send(m, b1);
  assert.equal(stage(m), 'IN');
  look(m, { res: { seq: 1, verb: 'ENTER', status: 'running', why: '', target: 'next' } });
  assert.deepEqual(ids(m).filter((id) => /^b\d/.test(id)), [], 'no other house, and not the one she is walking to');
  assert.equal(ids(m).includes('explore'), false);
});

test('IN: a failed ENTER ends the job and gives her the other houses back', () => {
  const m = scene({ buildings: [{ ...NEXT, id: 'other', dx: 20, door: { x: 10670, y: 9830 } }, NEXT] });
  const seq = send(m, menu(m).find((o) => o.target === 'next'));
  look(m, { res: { seq, verb: 'ENTER', status: 'failed', why: 'locked', target: 'next' } });
  assert.equal(stage(m), null);
  assert.deepEqual(menu(m).filter((o) => o.verb === 'ENTER').map((o) => o.target), ['other']);
});

test('IN: inside the house the job goes to SHUT and remembers the way she came', () => {
  const m = scene();
  const seq = send(m, { id: 'b1', verb: 'ENTER', target: 'h1', key: 'ENTER:h1', label: 'walk into house' });
  look(m, inHouse({ res: { seq, verb: 'ENTER', status: 'done', why: 'in by a door', target: 'h1' } }));
  assert.equal(stage(m), 'SHUT');
  assert.deepEqual(m.memory.job.entry, { x: 10650, y: 9830, how: 'door' });
  assert.equal(m.memory.job.leftStart, 4);
});

test('SHUT: the menu has no ENTER elsewhere and no walk, and the policy sends SECURE', () => {
  const m = scene();
  look(m, inHouse({ zList: [{ d: 11, dx: 11, dy: 0, chase: false }] }));
  assert.equal(menu(m).some((o) => o.verb === 'ENTER' || o.verb === 'GOTO'), false);
  const got = policy(m);
  assert.equal(got.rule, 'house-job');
  assert.equal(got.option.verb, 'SECURE');
});

test('SHUT: done or failed, the job goes on to LOOK', () => {
  const m = scene();
  look(m, inHouse());
  const { seq } = sendPolicy(m);
  done(m, seq, 'SECURE', 'closed 1 door');
  assert.equal(stage(m), 'LOOK');
  const n = scene();
  look(n, inHouse());
  const again = sendPolicy(n);
  failed(n, again.seq, 'SECURE', 'stuck');
  assert.equal(stage(n), 'LOOK');
});

test('LOOK: a short wait, then on to SEARCH when nothing is in the house', () => {
  const m = scene();
  look(m, inHouse());
  const { seq } = sendPolicy(m);
  done(m, seq, 'SECURE', 'closed 1 door');
  assert.equal(policy(m).option.verb, 'WAIT');
  look(m, { res: null }, LOOK_MIN / MIN / 2);
  assert.equal(stage(m), 'LOOK');
  look(m, {}, LOOK_MIN / MIN);
  assert.equal(stage(m), 'SEARCH');
});

test('LOOK: a zombie she cannot take on holds her a while, then she goes. With a pack the house is over', () => {
  const one = [{ d: 9, dx: 9, dy: 0, inside: true, wall: true }];
  const m = scene();
  look(m, inHouse({ weapon: 'none', weaponScore: 0, weapons: [] }));
  const first = sendPolicy(m);
  done(m, first.seq, 'SECURE', 'closed 1 door', { zList: one });
  look(m, { res: null }, 3);
  assert.equal(stage(m), 'LOOK');
  look(m, {}, LOOK_MAX / MIN);
  assert.equal(stage(m), 'LEAVE');
  const pack = [...one, { d: 10, dx: 10, dy: 0, inside: true, wall: true, down: true }, { d: 8, dx: 8, dy: 0, inside: true, wall: true }, { d: 7, dx: 7, dy: 0, inside: true, wall: true }];
  const n = scene();
  look(n, inHouse());
  const second = sendPolicy(n);
  done(n, second.seq, 'SECURE', 'closed 1 door');
  look(n, { res: null, zList: pack });
  assert.equal(stage(n), 'LEAVE');
  assert.equal(n.memory.job.paused, 'pack');
  assert.notEqual(policy(n)?.rule, 'house-job', 'the menu is hers while they are there');
  assert.ok(menu(n).some((o) => o.verb === 'ENTER' || o.verb === 'GOTO'), 'a way out is on it');
  look(n, { zList: [] });
  assert.equal(policy(n).rule, 'house-job');
  assert.equal(policy(n).option.target, 'next');
});

test('LOOK: a downed zombie in the house does not hold her, and with no weapon she goes on to SEARCH', () => {
  const m = scene();
  look(m, inHouse({ weapon: 'none', weaponScore: 0, weapons: [] }));
  const { seq } = sendPolicy(m);
  done(m, seq, 'SECURE', 'closed 1 door', { zList: [{ d: 9, dx: 9, dy: 0, inside: true, wall: true, down: true }] });
  look(m, { res: null }, 3);
  assert.equal(stage(m), 'SEARCH');
});

test('LOOK: a downed zombie holds SEARCH all the same, so with a weapon she goes and finishes it', () => {
  const m = scene();
  look(m, inHouse());
  const { seq } = sendPolicy(m);
  done(m, seq, 'SECURE', 'closed 1 door', { zList: [{ d: 9, dx: 9, dy: 0, inside: true, wall: true, down: true }] });
  look(m, { res: null }, 3);
  const moves = drainJobEvents(m.memory).filter((e) => e.kind === 'stage').map((e) => [e.from, e.stage, e.why]);
  assert.deepEqual(moves.slice(-2), [['LOOK', 'SEARCH', 'quiet'], ['SEARCH', 'CLEAR', 'idle zombie inside']]);
});

test('SEARCH: the policy sends SEARCH, and again while rooms are left and it got further', () => {
  const m = searching();
  const first = sendPolicy(m);
  assert.equal(first.got.rule, 'house-job');
  assert.equal(first.got.option.verb, 'SEARCH');
  done(m, first.seq, 'SEARCH', 'took 1: Bandage', { inBldg: { roomsLeft: 1 } });
  assert.equal(stage(m), 'SEARCH', 'a room was not loaded, so she goes on');
  assert.equal(m.memory.buildings.h1.searched, false);
  const second = sendPolicy(m);
  assert.equal(second.got.option.verb, 'SEARCH');
  // Got no further: that is the end of the house, or she would loop.
  done(m, second.seq, 'SEARCH', 'took nothing', { inBldg: { roomsLeft: 1 } });
  assert.equal(m.memory.buildings.h1.searched, true);
  assert.equal(stage(m), 'LEAVE');
});

test('SEARCH: all rooms done goes to LEAVE, "nothing left" does too', () => {
  assert.equal(stage(leaving()), 'LEAVE');
  const m = searching();
  const { seq } = sendPolicy(m);
  failed(m, seq, 'SEARCH', 'nothing left');
  assert.equal(stage(m), 'LEAVE');
});

test('SEARCH: too heavy leaves the turn to the drop rule, and with nothing to drop she leaves', () => {
  const heavy = { weight: 15, bag: 'none' };
  const m = searching();
  look(m, heavy);
  const drop = policy(m);
  assert.equal(drop.rule, 'overloaded');
  const seq = send(m, drop.option);
  failed(m, seq, 'DROP', 'nothing to drop');
  assert.equal(stage(m), 'LEAVE');
});

test('SEARCH: a zombie that holds the search off ends the house after a while, not after 22 minutes', () => {
  const m = searching();
  look(m, { zList: [{ d: 6, dx: 6, dy: 0, chase: false, wall: false }] });
  assert.equal(ids(m).includes('search'), false);
  assert.equal(stage(m), 'SEARCH');
  for (let i = 0; i < 4; i++) look(m, {}, STALL_MAX / MIN / 4);
  look(m, {}, 1);
  assert.equal(stage(m), 'LEAVE');
  assert.equal(drainJobEvents(m.memory).at(-1).why, 'blocked');
});

test('a chase, a pack or a wound hands the menu back, and the job picks up after', () => {
  const threats = [
    ['chased', { zList: [{ d: 12, dx: 12, dy: 0, chase: true }] }],
    ['pack', { zList: [1, 2, 3].map((i) => ({ d: 5 + i, dx: 5 + i, dy: 0, chase: false, wall: false })) }],
    ['bleeding', { bleeding: 1, wounds: [{ part: 'Hand_L', bleed: true }] }],
  ];
  for (const [why, patch] of threats) {
    const m = searching();
    look(m, patch);
    assert.equal(m.memory.job.paused, why);
    assert.notEqual(policy(m)?.rule, 'house-job', why);
    if (why !== 'bleeding') assert.ok(menu(m).some((o) => o.verb === 'ENTER' || o.verb === 'GOTO'), `${why}: a way out is back on the menu`);
    look(m, { zList: [], bleeding: 0, wounds: [] }, 1);
    assert.equal(m.memory.job.paused, '');
    assert.equal(stage(m), 'SEARCH');
    assert.equal(policy(m).rule, 'house-job');
  }
});

test('a chaser she has already shaken, far off, does not stop the job', () => {
  const m = searching();
  look(m, { zList: [{ d: 22, dx: 22, dy: 0, chase: true }], zChasing: 1 });
  assert.equal(m.memory.job.paused, '');
  assert.equal(policy(m).rule, 'house-job');
});

test('driven out of the house by a threat, the job is over', () => {
  const m = searching();
  look(m, { zList: [{ d: 5, dx: 5, dy: 0, chase: true }] });
  look(m, { ...OUTSIDE, zList: [] });
  assert.equal(stage(m), null);
  assert.equal(drainJobEvents(m.memory).at(-1).why, 'threat');
  assert.equal(m.memory.buildings.h1.leftAt, m.percept.hoursAlive);
});

test('a night outside does not hold her to the job', () => {
  const m = scene({ hour: 22 });
  send(m, { id: 'b1', verb: 'ENTER', target: 'next', key: 'ENTER:next', label: 'walk into house' });
  look(m);
  assert.equal(m.memory.job.paused, 'night outside');
  assert.equal(policy(m).rule, 'night-outside');
});

test('a walk that drifted out goes back in, to the stage it left, and only so many times', () => {
  const m = searching();
  look(m, OUTSIDE);
  assert.equal(stage(m), 'IN');
  assert.equal(m.memory.job.reentries, 1);
  assert.equal(policy(m).option.verb, 'ENTER');
  assert.equal(policy(m).option.target, 'h1');
  look(m, inHouse({ inBldg: { id: 'h1', rooms: 4, roomsLeft: 3 } }));
  assert.equal(stage(m), 'SEARCH', 'she does not shut the house again');
  for (let i = 1; i < MAX_REENTRIES; i++) {
    look(m, OUTSIDE);
    assert.equal(stage(m), 'IN');
    look(m, inHouse());
    assert.equal(stage(m), 'SEARCH');
  }
  look(m, OUTSIDE);
  assert.equal(stage(m), null);
  assert.equal(drainJobEvents(m.memory).at(-1).reentries, MAX_REENTRIES);
});

test('a SEARCH on its way back in from a step outside is left to it', () => {
  const m = searching();
  const { seq } = sendPolicy(m);
  look(m, { ...OUTSIDE, res: { seq, verb: 'SEARCH', status: 'running', why: '', target: 'h1' } });
  assert.equal(stage(m), 'SEARCH');
  assert.equal(m.memory.job.reentries, 0);
});

test('the time limit: 30 game minutes a room, within limits, and then she leaves', () => {
  assert.equal(jobLimit(4), 120 * MIN);
  assert.equal(jobLimit(1), MIN_LIMIT);
  assert.equal(jobLimit(50), MAX_LIMIT);
  const m = searching();
  const { seq } = sendPolicy(m);
  const busy = { res: { seq, verb: 'SEARCH', status: 'running', why: '', target: 'h1' } };
  // Looks half an hour apart: the limit for this house is 120 game minutes.
  for (let i = 0; i < 3; i++) {
    look(m, busy, 30);
    assert.equal(stage(m), 'SEARCH');
  }
  look(m, busy, 30);
  assert.equal(stage(m), 'LEAVE');
  assert.equal(drainJobEvents(m.memory).at(-1).why, 'time');
});

test('asleep, and a gap in the clock, do not use up the time', () => {
  const m = searching();
  const before = m.memory.job.spent;
  look(m, { asleep: true }, 25);
  look(m, { asleep: false }, 0);
  assert.equal(m.memory.job.spent, before);
  look(m, {}, 200);
  assert.equal(m.memory.job.spent, before, 'the game was closed');
  assert.equal(stage(m), 'SEARCH');
});

test('a small need comes first while it is quiet, and a bag she carries gets worn', () => {
  const m = searching({ thirst: 0.3, items: 'School Bag', bag: 'none' });
  assert.equal(policy(m).option.id, 'drink');
  look(m, { thirst: 0 });
  assert.equal(policy(m).option.id, 'wearbag');
  look(m, { items: '' });
  assert.equal(policy(m).option.id, 'search');
});

test('a running job is never cut for the stage order', () => {
  const m = searching({ thirst: 0.3 });
  const { seq } = sendPolicy(m);
  look(m, { res: { seq, verb: 'DRINK', status: 'running', why: '', target: '' } });
  assert.notEqual(policy(m)?.rule, 'house-job');
});

test('LEAVE: she walks to the door she came in by, then goes on to the next house', () => {
  const m = scene({ x: 10640, y: 9830 });
  const seq0 = send(m, { id: 'b1', verb: 'ENTER', target: 'h1', key: 'ENTER:h1', label: 'walk into house' });
  look(m, inHouse({ x: 10644, y: 9830, res: { seq: seq0, verb: 'ENTER', status: 'done', why: 'in by a door', target: 'h1' } }));
  const secure = sendPolicy(m);
  done(m, secure.seq, 'SECURE', 'closed 1 door', { x: 10655 });
  look(m, { res: null }, 3);
  const search = sendPolicy(m);
  done(m, search.seq, 'SEARCH', 'took 1: Bandage', { inBldg: { roomsLeft: 0 } });
  assert.equal(stage(m), 'LEAVE');
  const walk = policy(m);
  assert.equal(walk.rule, 'house-job');
  assert.equal(walk.option.id, 'leave');
  assert.deepEqual([walk.option.a, walk.option.b], [10644, 9830]);
  assert.match(walk.option.label, /door you came in by/);
  const seq = send(m, walk.option);
  assert.equal(stage(m), 'LEAVE', 'the walk does not end the job');
  look(m, { x: 10645, y: 9830, res: { seq, verb: 'GOTO', status: 'done', why: 'arrived', target: '10644,9830' } });
  const next = policy(m);
  assert.equal(next.option.target, 'next');
  assert.equal(next.rule, 'house-job');
  drainJobEvents(m.memory);
  send(m, next.option);
  const events = drainJobEvents(m.memory);
  assert.deepEqual(events.map((e) => e.kind), ['end', 'open']);
  assert.equal(events[0].finished, true);
  assert.equal(events[0].why, 'next house');
  assert.equal(events[0].roomsSearched, 4);
  assert.equal(stage(m), 'IN');
  assert.equal(m.memory.job.id, 'next');
});

test('LEAVE: came by a window, she goes to the door the map knows. Fills and rests before she goes', () => {
  const m = scene({ x: 10640, y: 9830 });
  const seq0 = send(m, { id: 'b1', verb: 'ENTER', target: 'h1', key: 'ENTER:h1', label: 'walk into house' });
  look(m, inHouse({ x: 10655, y: 9830, water: { d: 2 }, inv: { emptyBottles: 1 }, res: { seq: seq0, verb: 'ENTER', status: 'done', why: 'in through a window', target: 'h1' } }));
  const secure = sendPolicy(m);
  done(m, secure.seq, 'SECURE', 'closed 1 door');
  look(m, { res: null }, 3);
  const search = sendPolicy(m);
  done(m, search.seq, 'SEARCH', 'took 1: Bandage', { inBldg: { roomsLeft: 0 } });
  assert.equal(stage(m), 'LEAVE');
  assert.equal(policy(m).option.id, 'fill');
  look(m, { water: null, endurance: 0.5 });
  assert.equal(policy(m).option.id, 'rest');
  look(m, { endurance: 1 });
  const walk = policy(m);
  assert.equal(walk.option.id, 'leave');
  assert.deepEqual([walk.option.a, walk.option.b], [10648, 9830]);
  assert.match(walk.option.label, /nearest door/);
});

test('LEAVE: a door with a zombie by it is no way out, so she goes straight on', () => {
  const m = leaving();
  m.memory.job.entry = { x: 10640, y: 9830, how: 'door' };
  look(m, { zList: [{ d: 8, dx: -8, dy: 0, chase: false, wall: true }] });
  assert.equal(ids(m).includes('leave'), false);
  assert.equal(policy(m).option.target, 'next');
});

test('LEAVE: no house to go on to, so she walks out to look for one, and the job ends outside', () => {
  const m = leaving();
  look(m, { buildings: [HOME] });
  const walk = policy(m);
  assert.equal(walk.option.id, 'explore');
  send(m, walk.option);
  assert.equal(stage(m), 'LEAVE');
  look(m, OUTSIDE);
  assert.equal(stage(m), null);
  assert.equal(drainJobEvents(m.memory).at(-1).why, 'left the house');
});

test('LEAVE: no walk at dusk or at night. The job ends and she stays', () => {
  for (const [hour, why] of [[18, 'dusk'], [22, 'night']]) {
    const m = leaving();
    look(m, { hour });
    assert.equal(stage(m), null);
    const last = drainJobEvents(m.memory).at(-1);
    assert.equal(last.why, why);
    assert.equal(last.finished, true);
  }
});

test('LEAVE that cannot get anywhere ends on its own', () => {
  const m = leaving();
  m.memory.fails.EXPLORE = { why: 'stuck', at: m.at };
  m.memory.job.entry = null;
  look(m, { buildings: [{ ...HOME, door: null }] }, 1);
  look(m, {}, LEAVE_MAX / MIN + 1);
  assert.equal(stage(m), null);
  assert.equal(drainJobEvents(m.memory).at(-1).why, 'time');
});

function nextFrom(buildings, memory = {}) {
  const m = leaving({ buildings: { h1: { res: true, door: HOME.door }, ...memory } });
  look(m, { buildings: [HOME, ...buildings] });
  return policy(m).option;
}
const house = (id, d, extra = {}) => ({ d, door: { x: 10650 + d, y: 9830 }, dx: d, dy: 0, id, res: true, shop: false, visited: false, ...extra });

test('the next house: nearest not searched, not crowded, not given up on, and a house before a shop', () => {
  assert.equal(nextFrom([house('far', 25), house('near', 10)]).target, 'near');
  assert.equal(nextFrom([house('near', 10), house('far', 25)], { near: { searched: true, visited: true, res: true } }).target, 'far');
  assert.equal(nextFrom([house('near', 10), house('far', 25)], { near: { zombies: 3, res: true } }).target, 'far');
  assert.equal(nextFrom([house('shop', 10, { res: false, shop: true }), house('far', 25)]).target, 'far');
  assert.equal(nextFrom([house('shop', 10, { res: false, shop: true })]).target, 'shop');
  // Every one of them spoken for: she explores.
  assert.equal(nextFrom([house('near', 10)], { near: { searched: true, res: true } }).id, 'explore');
});

test('a house she left with rooms in it is not the next house, for a while', () => {
  const m = searching();
  look(m, { zList: [{ d: 5, dx: 5, dy: 0, chase: true }] });
  look(m, { ...OUTSIDE, zList: [] });
  const left = m.memory.buildings.h1;
  assert.equal(doneWith(left, left.leftAt + 1), true);
  assert.equal(doneWith(left, left.leftAt + REVISIT_HOURS), false);
  assert.equal(doneWith(left, left.leftAt - 5), false, 'a new character, the clock went back');
  const order = menu(m).filter((o) => o.verb === 'ENTER').map((o) => o.target);
  assert.deepEqual(order, ['next', 'h1'], 'the fresh house leads the menu');
});

test('going home to a searched house opens no job, and ends the one she was in', () => {
  const m = scene({}, { buildings: { home: { searched: true, res: true } } });
  look(m, inHouse());
  send(m, { id: 'b1', verb: 'ENTER', target: 'home', key: 'ENTER:home', label: 'walk into house' });
  assert.equal(stage(m), null);
  assert.equal(drainJobEvents(m.memory).at(-1).why, 'another house');
});

test('a walk away in the IN stage ends the job', () => {
  const m = scene();
  send(m, { id: 'b1', verb: 'ENTER', target: 'next', key: 'ENTER:next', label: 'walk into house' });
  send(m, { id: 'away', verb: 'GOTO', a: 1, b: 2, key: 'AWAY', label: 'walk' });
  assert.equal(stage(m), null);
});

test('a job is saved, a bad one is dropped, and a new character ends it', () => {
  const m = searching();
  const saved = JSON.parse(JSON.stringify(m.memory));
  assert.equal(loadMemory(saved).job.stage, 'SEARCH');
  assert.equal(memorySlice(m.memory, m.percept).job.stage, 'SEARCH');
  assert.equal(loadMemory({ job: { id: 'h1', stage: 'NOPE' } }).job, null);
  assert.equal(loadMemory({ job: 'SEARCH' }).job, null);
  look(m, { hoursAlive: 1 });
  m.percept.hoursAlive = 1;
  updateMemory(m.memory, m.percept, m.at);
  assert.equal(m.memory.job, null);
});

test('updating twice on one percept changes nothing', () => {
  const m = searching();
  const before = JSON.stringify(m.memory.job);
  updateMemory(m.memory, m.percept, m.at);
  assert.equal(JSON.stringify(m.memory.job), before);
});

test('the prompt says there is a job when the model is asked in the middle of one', () => {
  const m = searching({ zList: [{ d: 6, dx: 6, dy: 0, chase: false, wall: false }] });
  const plan = planTurn(m.percept, m.memory, { now: m.at });
  assert.equal(plan.kind, 'ask');
  assert.match(plan.user, /HOUSE JOB: searching this house, 4 rooms left/);
  assert.equal(plan.options.some((o) => o.verb === 'ENTER' || o.verb === 'GOTO'), false);
});

// ---------- CLEAR ----------
const IDLE = { d: 7, dx: 7, dy: 0, chase: false, inside: true };
const ARMED = { hp: 100, weapon: 'Baseball Bat', weaponScore: 34, weapons: [{ n: 'Baseball Bat', reach: 1.25, score: 34 }] };
const WEAK = { hp: 100, weapon: 'Rolling Pin', weaponScore: 12, weapons: [{ n: 'Rolling Pin', reach: 1.1, score: 12 }] };
const fit = (patch = {}) => ({ ...ARMED, zList: [IDLE], moodle: {}, endurance: 1, bleeding: 0, zChasing: 0, ...patch });

test('clearBlock: one idle zombie, a melee weapon, 70 hp, not bleeding and nothing after her is a yes', () => {
  assert.equal(clearBlock(fit()), '');
  assert.equal(clearBlock(fit(WEAK)), '', 'any melee weapon takes on one');
  assert.equal(clearBlock(fit({ hp: CLEAR_MIN_HP })), '');
  assert.equal(clearBlock(fit({ moodle: { tired: 3 } })), '', 'tired does not stop her from taking on one, as in the reflex');
});

test('clearBlock: two take a weapon at the strong line. Three are too many for anything', () => {
  assert.equal(clearBlock(fit({ zList: [IDLE, IDLE] })), '');
  assert.equal(clearBlock(fit({ weaponScore: 30, zList: [IDLE, IDLE] })), '');
  assert.equal(clearBlock(fit({ weaponScore: 29, zList: [IDLE, IDLE] })), 'too many inside');
  assert.equal(clearBlock(fit({ zList: [IDLE, IDLE, IDLE] })), 'too many inside');
  assert.equal(clearBlock(fit({ zList: [IDLE, { ...IDLE, crawl: true }], ...WEAK })), 'too many inside', 'a crawler is in the house too');
});

test('clearBlock: each no', () => {
  assert.equal(clearBlock(fit({ zList: [] })), 'nobody inside');
  assert.equal(clearBlock(fit({ zList: [{ ...IDLE, inside: false }] })), 'nobody inside', 'one outside is not hers to clear');
  assert.equal(clearBlock(fit({ zList: [{ ...IDLE, chase: true }] })), 'chased');
  assert.equal(clearBlock(fit({ zChasing: 1 })), 'chased');
  assert.equal(clearBlock(fit({ zList: [IDLE, { d: 20, dx: 20, dy: 0, chase: true, inside: false }] })), 'chased');
  assert.equal(clearBlock(fit({ weapon: 'none', weaponScore: 0, weapons: [] })), 'no melee weapon');
  assert.equal(clearBlock(fit({ weapon: 'none', weaponScore: 0, weapons: [], heldGun: 'Pistol' })), 'no melee weapon');
  assert.equal(clearBlock(fit({ hp: CLEAR_MIN_HP - 1 })), 'hurt');
  assert.equal(clearBlock(fit({ bleeding: 1 })), 'bleeding');
});

test('clearBlock: no with what the reflex would not fight with or through', () => {
  assert.equal(clearBlock(fit({ weapon: 'Kitchen Knife', weaponScore: 9, weapons: [{ n: 'Kitchen Knife', reach: 0.9, score: 9 }] })), 'weapon too short');
  assert.equal(clearBlock(fit({ endurance: 0.29 })), 'not fit to fight');
  assert.equal(clearBlock(fit({ moodle: { panic: 3 } })), 'not fit to fight');
  assert.equal(clearBlock(fit({ moodle: { heavy: 2 } })), 'not fit to fight');
  assert.equal(clearBlock(fit({ moodle: { tired: 3 }, zList: [IDLE, IDLE] })), 'not fit to fight');
});

// In the house at LOOK, with nothing in it yet.
function looking(patch = {}) {
  const m = scene();
  look(m, inHouse({ ...ARMED, ...patch }));
  const secure = sendPolicy(m);
  done(m, secure.seq, 'SECURE', 'closed 1 door', { res: { seq: secure.seq, verb: 'SECURE', status: 'done', why: 'closed 1 door', target: 'h1' } });
  assert.equal(stage(m), 'LOOK');
  drainJobEvents(m.memory);
  return m;
}
const clearing = () => {
  const m = looking();
  look(m, { zList: [IDLE], res: null });
  assert.equal(stage(m), 'CLEAR');
  return m;
};
const lastStage = (m) => drainJobEvents(m.memory).filter((e) => e.kind === 'stage').pop();

test('LOOK: one idle zombie inside goes to CLEAR at once, and the house line says so', () => {
  const m = looking();
  look(m, { zList: [IDLE], res: null });
  assert.equal(stage(m), 'CLEAR');
  const e = lastStage(m);
  assert.equal(e.from, 'LOOK');
  assert.equal(e.stage, 'CLEAR');
  assert.equal(e.why, 'idle zombie inside');
});

test('LOOK: when the gate says no it waits and then leaves, as before', () => {
  for (const patch of [{ hp: 60 }, { weapon: 'none', weaponScore: 0, weapons: [] }, { ...WEAK, zList: [IDLE, IDLE] }]) {
    const m = looking();
    look(m, { zList: [IDLE], res: null, ...patch });
    assert.equal(stage(m), 'LOOK', JSON.stringify(patch));
    look(m, {}, LOOK_MAX / MIN + 1);
    assert.equal(stage(m), 'LEAVE');
  }
});

test('LOOK: a gate that opens while she waits goes to CLEAR', () => {
  const m = looking();
  look(m, { zList: [IDLE], res: null, hp: 60 });
  assert.equal(stage(m), 'LOOK');
  look(m, { hp: 80 }, 1);
  assert.equal(stage(m), 'CLEAR');
});

test('SEARCH: an idle zombie that holds it goes to CLEAR, and a running SEARCH is left to run', () => {
  const m = searching(ARMED);
  look(m, { zList: [IDLE], res: { seq: 9, verb: 'SEARCH', status: 'running', why: '', target: 'h1' } }, 1);
  assert.equal(stage(m), 'SEARCH');
  look(m, { res: { seq: 9, verb: 'SEARCH', status: 'failed', why: 'zombie', target: 'h1' } }, 1);
  assert.equal(stage(m), 'CLEAR');
  assert.equal(menu(m).some((o) => o.id === 'search'), false);
});

test('SEARCH: with the gate shut it stalls out and leaves, as before', () => {
  const m = searching({ hp: 60 });
  look(m, { zList: [IDLE], res: null }, 1);
  assert.equal(stage(m), 'SEARCH');
  look(m, {}, STALL_MAX / MIN / 2);
  look(m, {}, STALL_MAX / MIN / 2 + 1);
  assert.equal(stage(m), 'LEAVE');
});

test('CLEAR: the policy sends it with nothing walking on the menu, ahead of the small things', () => {
  const m = clearing();
  look(m, { thirst: 0.3, inv: { waterL: 0.5 } });
  const got = policy(m);
  assert.equal(got.rule, 'house-job');
  assert.equal(got.option.verb, 'CLEAR');
  assert.equal(got.option.key, 'CLEAR:h1');
  assert.equal(menu(m).some((o) => o.verb === 'ENTER' || o.verb === 'GOTO'), false);
  assert.match(orderLine(1, got.option, 't'), /^1\|CLEAR\|/);
  assert.match(jobLine(m.memory, m.percept), /killing the zombie/);
});

test('CLEAR: while it runs the bridge counts it as busy and sends nothing', () => {
  const m = clearing();
  const { seq } = sendPolicy(m);
  look(m, { res: { seq, verb: 'CLEAR', status: 'running', why: '', target: 'h1' } }, 1);
  assert.deepEqual(running(m.percept), { seq, verb: 'CLEAR' });
  assert.notEqual(policy(m)?.rule, 'house-job');
  assert.equal(stage(m), 'CLEAR');
});

test('CLEAR done goes back to LOOK, listens again, then SEARCH', () => {
  const m = clearing();
  const { seq } = sendPolicy(m);
  done(m, seq, 'CLEAR', 'cleared', { zList: [] });
  assert.equal(stage(m), 'LOOK');
  const e = lastStage(m);
  assert.equal(e.from, 'CLEAR');
  assert.equal(e.why, 'cleared');
  assert.equal(policy(m).option.verb, 'WAIT');
  look(m, {}, LOOK_MIN / MIN + 1);
  assert.equal(stage(m), 'SEARCH');
  assert.equal(policy(m).option.verb, 'SEARCH');
});

test('CLEAR failed goes to LEAVE with the why in the house line', () => {
  for (const why of ['another floor', 'locked door', 'out of reach', 'a second one woke']) {
    const m = clearing();
    const { seq } = sendPolicy(m);
    failed(m, seq, 'CLEAR', why);
    assert.equal(stage(m), 'LEAVE');
    const e = lastStage(m);
    assert.equal(e.from, 'CLEAR');
    assert.equal(e.why, `clear failed: ${why}`);
  }
});

test('CLEAR: the zombie turning on her pauses the job, and the result still counts when it ends', () => {
  const m = clearing();
  const { seq } = sendPolicy(m);
  look(m, { zList: [{ ...IDLE, d: 2, chase: true }], zChasing: 1, res: { seq, verb: 'CLEAR', status: 'running', why: '', target: 'h1' } }, 1);
  assert.equal(m.memory.job.paused, 'chased');
  assert.equal(stage(m), 'CLEAR');
  look(m, { zList: [], zChasing: 0, res: { seq, verb: 'CLEAR', status: 'done', why: 'cleared', target: 'h1' } }, 1);
  assert.equal(stage(m), 'LOOK');
});

test('CLEAR: a result left from an earlier CLEAR does not count for the next one', () => {
  const m = clearing();
  const first = sendPolicy(m);
  done(m, first.seq, 'CLEAR', 'cleared', { zList: [] });
  assert.equal(stage(m), 'LOOK');
  look(m, { zList: [IDLE] }, 1);
  assert.equal(stage(m), 'CLEAR', 'another one came in, with the old done still in the percept');
  look(m, {}, 1);
  assert.equal(stage(m), 'CLEAR');
});

test('CLEAR not yet sent: the zombie gone goes to LOOK, the gate shut or too long goes to LEAVE', () => {
  const gone = clearing();
  look(gone, { zList: [] }, 1);
  assert.equal(stage(gone), 'LOOK');
  assert.equal(lastStage(gone).why, 'zombie gone');

  const hurt = clearing();
  look(hurt, { hp: 60 }, 1);
  assert.equal(stage(hurt), 'LEAVE');
  assert.equal(lastStage(hurt).why, 'clear called off: hurt');

  const held = clearing();
  held.memory.fails['CLEAR:h1'] = { why: 'stuck', at: held.at };
  assert.equal(menu(held).some((o) => o.id === 'clear'), false);
  look(held, {}, CLEAR_MAX / MIN + 1);
  assert.equal(stage(held), 'LEAVE');
  assert.equal(lastStage(held).why, 'clear called off: time');
});

test('a CLEAR that failed a moment ago keeps her from going straight back to it', () => {
  const m = looking();
  m.memory.fails['CLEAR:h1'] = { why: 'stuck', at: m.at };
  look(m, { zList: [IDLE], res: null });
  assert.equal(stage(m), 'LOOK');
});

test('CLEAR: out of the house with nothing after her goes back in to LOOK, not to the order', () => {
  const m = clearing();
  look(m, { ...OUTSIDE, zList: [] }, 1);
  assert.equal(stage(m), 'IN');
  look(m, inHouse({ ...ARMED, zList: [] }), 1);
  assert.equal(stage(m), 'LOOK');
});

test('holdReason: an idle one in the house past the reflex line lets the order out', () => {
  const p = { zVisible: 1, zDist: 2.5, zList: [{ d: 2.5, dx: 2, dy: 1, chase: false, inside: true }] };
  assert.equal(holdReason(p), '', 'the reflex leaves it alone at 2.5, so nobody would own it');
  assert.match(holdReason({ ...p, zDist: 1.9, zList: [{ ...p.zList[0], d: 1.9 }] }), /inside 3/, 'inside the line it is the reflex fight');
  assert.match(holdReason({ ...p, zList: [{ ...p.zList[0], inside: false }] }), /inside 3/, 'one outside stays as it was');
  assert.match(holdReason({ ...p, zList: [{ ...p.zList[0], down: true }] }), /inside 3/, 'a downed one is the reflex stomp');
  assert.match(holdReason({ ...p, zList: [{ ...p.zList[0], chase: true }] }), /chasing/);
  assert.match(holdReason({ ...p, zList: [p.zList[0], { d: 1, dx: 1, dy: 0, chase: false, inside: true }] }), /inside 3/);
  assert.match(holdReason({ zVisible: 1, zDist: 2.5 }), /inside 3/, 'with no list, distance alone');
});
