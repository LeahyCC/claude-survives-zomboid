// The base: one building for her gear, how it is picked and how it moves, and what being too full
// does to the menu. The STASH skill's own tests are in test/lua-stash.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, merge } from './eval/scenarios.mjs';
import { buildOptions, setSearchLog } from './options.mjs';
import { decidePolicy } from './policy.mjs';
import { updateMemory, recordOrder, blockedWhy, loadMemory, memoryStats, memorySlice, pickBase, baseBuilding, BASE_MOVE, MAX_BASE_WALK } from './memory.mjs';
import { doneWith, drainJobEvents, REVISIT_HOURS } from './housejob.mjs';
import { digest } from './digest.mjs';
import { orderLine } from './brain.mjs';
import { knownBuildings } from './planner.mjs';
import { LONG_VERBS } from './senses.mjs';

setSearchLog(() => {});
const NOW = 1_000_000;
const MIN = 1 / 60;

const AT = { x: 10650, y: 9830 };
const NEAR_DOOR = { x: 10650, y: 9820 };
const listed = (id, extra = {}) => ({ d: 10, door: NEAR_DOOR, dx: 0, dy: -10, id, res: true, shop: false, visited: true, ...extra });
const house = (extra = {}) => ({ visited: true, res: true, door: NEAR_DOOR, x: NEAR_DOOR.x, y: NEAR_DOOR.y, ...extra });

const OUT = { ...AT, outside: true, inBldg: null, room: '', zList: [], zChasing: 0, zDist: -1, zVisible: 0, hoursAlive: 40, hour: 11, weight: 1, maxWeight: 20, bag: 'School Bag', moodle: {}, res: null, buildings: [] };
const inHouse = (id, extra = {}) => ({ ...OUT, outside: false, room: 'kitchen', inBldg: { id, room: 'kitchen', rooms: 4, roomsLeft: 4, water: false }, buildings: [listed(id, { d: 0, dx: 0, dy: 0 })], ...extra });

function moment(patch = {}, memory = {}, plan = null) {
  const m = buildScenario({ patch: { ...OUT, ...patch }, memory, plan });
  m.at = NOW;
  m.seq = 0;
  return m;
}
const look = (m, patch = {}, minutes = 0, home) => {
  m.percept = { ...merge(m.percept, patch), hoursAlive: m.percept.hoursAlive + minutes * MIN };
  m.at += 1000;
  updateMemory(m.memory, m.percept, m.at, { home });
  return m;
};
const menu = (m) => buildOptions(m.percept, m.memory, { now: m.at ?? NOW, plan: m.plan });
const ids = (m) => menu(m).map((o) => o.id);
const byId = (m, id) => menu(m).find((o) => o.id === id);
const policy = (m) => decidePolicy(m.percept, m.memory, menu(m));
const baseId = (m) => (m.memory.base ? m.memory.base.id : null);
function send(m, option) {
  m.seq += 1;
  recordOrder(m.memory, m.seq, option, m.percept, m.at);
  return m.seq;
}

// ---------- picking the base ----------
test('the best house she has been in is the base', () => {
  const m = moment({}, { buildings: { a: house(), b: house({ water: true, bed: true }), c: house({ visited: false, water: true, bed: true, searched: true }) } });
  assert.equal(baseId(m), 'b', 'c scores higher but she has never been in it');
});

test('no base from a shop, or a house full of zombies', () => {
  assert.equal(baseId(moment({}, { buildings: { a: house({ res: false, shop: true }), b: house({ zombies: 2 }) } })), null);
  assert.equal(baseId(moment()), null, 'and none with nothing visited');
});

test('the planner\'s home is the base when it has one, even a house she has not stood in', () => {
  const buildings = { a: house({ water: true }), p: house({ visited: false }) };
  const m = moment({}, { buildings }, { goal: 'x', steps: [], home: 'p' });
  assert.equal(baseId(m), 'p');
  // A plan with no home leaves it alone, and so does a home the map does not know.
  m.memory.buildings.a.water = false;
  look(m, {}, 1, '');
  assert.equal(baseId(m), 'p');
  look(m, {}, 1, 'nowhere');
  assert.equal(baseId(m), 'p');
  // A clearly better house she has been in beats it, as any other. And it stays beaten.
  m.memory.buildings.a.water = true;
  look(m, {}, 1, 'p');
  assert.equal(baseId(m), 'a');
  look(m, {}, 1, 'p');
  assert.equal(baseId(m), 'a');
});

test('it moves for a house 2 points better, not 1', () => {
  const m = moment({}, { buildings: { a: house() } });
  assert.equal(baseId(m), 'a');
  m.memory.buildings.b = { ...house({ bed: true }), id: 'b' };
  m.memory.buildings.b.searched = false;
  look(m);
  assert.equal(BASE_MOVE, 2);
  assert.equal(baseId(m), 'b', 'a bed is 2 points');
  m.memory.buildings.c = { ...house({ bed: true, searched: true }), id: 'c' };
  look(m);
  assert.equal(baseId(m), 'b', 'one point better is not clearly better');
});

test('zombies seen at the base bring its score down, and then it moves', () => {
  const m = moment({}, { buildings: { a: house({ water: true }), b: house() } });
  assert.equal(baseId(m), 'a');
  m.memory.buildings.a.zombies = 2;
  look(m);
  assert.equal(baseId(m), 'a', 'level now, and level is not clearly better');
  m.memory.buildings.a.zombies = 4;
  look(m);
  assert.equal(baseId(m), 'b');
});

test('a base with gear in it does not follow every new plan', () => {
  const m = moment({}, { buildings: { a: house({ water: true }), p: house({ water: true }) }, stashes: { a: { n: 3, at: 30 } } });
  assert.equal(baseId(m), 'a');
  look(m, {}, 1, 'p');
  assert.equal(baseId(m), 'a', 'level scores, and the stash decides');
  m.memory.buildings.p.bed = true;
  look(m, {}, 1, 'p');
  assert.equal(baseId(m), 'p', '2 better, so it goes');
});

test('with nothing stashed it follows the plan, and does not flip back and forth', () => {
  const m = moment({}, { buildings: { a: house({ water: true, bed: true }), p: house() } });
  assert.equal(baseId(m), 'a');
  look(m, {}, 1, 'p');
  assert.equal(baseId(m), 'a', 'the plan is 4 worse: the better house holds');
  m.memory.buildings.p.bed = true;
  m.memory.buildings.p.searched = true;
  look(m, {}, 1, 'p');
  assert.equal(baseId(m), 'p', 'only 1 worse now, and nothing is lost by following it');
  for (let i = 0; i < 3; i++) {
    look(m, {}, 1, 'p');
    assert.equal(baseId(m), 'p');
  }
});

test('a base out of walking reach gives way to one in reach, whatever the score', () => {
  const far = { door: { x: AT.x + MAX_BASE_WALK + 50, y: AT.y }, x: AT.x + MAX_BASE_WALK + 50, y: AT.y };
  const m = moment({}, { base: { id: 'a', at: 1 }, buildings: { a: house({ ...far, water: true, bed: true }) } });
  assert.equal(baseId(m), 'a', 'all she knows');
  assert.equal(byId(look(m, { weight: 19 }), 'haul'), undefined, 'but it is no walk to offer');
  assert.ok(byId(m, 'drop'), 'so the load goes on the floor');
  m.memory.buildings.b = { ...house(), id: 'b' };
  look(m);
  assert.equal(baseId(m), 'b');
});

test('pickBase is plain: it reads the map and says an id', () => {
  const mem = loadMemory({ buildings: { a: { id: 'a', visited: true, res: true } } });
  assert.equal(pickBase(mem, AT), 'a');
  assert.equal(baseBuilding(mem), null, 'and it changes nothing itself');
});

test('the base and the stashes last a save, and bad ones are dropped', () => {
  const mem = loadMemory({ base: { id: 'a', at: 3 }, stashes: { a: { n: 4, at: 3 }, bad: { n: 'x' }, none: null }, haul: { from: 'z', at: 1 } });
  assert.deepEqual(mem.base, { id: 'a', at: 3 });
  assert.deepEqual(mem.stashes, { a: { n: 4, at: 3 } });
  assert.deepEqual(mem.haul, { from: 'z', at: 1 });
  assert.equal(loadMemory({ base: { id: 5 } }).base, null);
  assert.deepEqual(loadMemory({}).stashes, {});
});

// ---------- the digest ----------
test('the digest gives the base one line, wherever she is', () => {
  const m = moment({}, { buildings: { a: house() } });
  const line = (mm) => digest(mm.percept, memoryStats(mm.memory)).split('\n').filter((l) => l.startsWith('Base:'));
  assert.deepEqual(line(m), ['Base: house 10 tiles N, nothing stashed yet.']);
  m.memory.stashes.a = { n: 6, at: 1 };
  m.memory.stashes.old = { n: 2, at: 1 };
  assert.deepEqual(line(m), ['Base: house 10 tiles N, 6 things stashed there, 2 more at an old base.']);
  look(m, inHouse('a'));
  assert.deepEqual(line(m), ['Base: this building, 6 things stashed there, 2 more at an old base.']);
  assert.deepEqual(line(moment()), [], 'no base, no line');
});

test('the planner sees which one is the base', () => {
  const m = moment({}, { buildings: { a: house() }, stashes: { a: { n: 1, at: 1 } } });
  assert.match(knownBuildings(m.memory, m.percept)[0].text, /your base, 1 thing stashed/);
});

// ---------- the option order ----------
test('too full with a base: take the load home is on the menu and DROP is not', () => {
  const buildings = { a: house() };
  const m = moment({ weight: 19, buildings: [listed('a')] }, { buildings });
  const haul = byId(m, 'haul');
  assert.equal(haul.verb, 'ENTER');
  assert.equal(haul.target, 'a');
  assert.match(haul.label, /take the load home: walk 10 tiles N to your base/);
  assert.equal(byId(m, 'drop'), undefined);
  assert.equal(menu(m).filter((o) => o.target === 'a').length, 1, 'not a second line for the same house');
  assert.equal(policy(m).option.id, 'haul');
  assert.equal(policy(m).rule, 'house-job', 'ahead of the overloaded rule');
});

test('a base the percept no longer lists is a walk to its door, then ENTER', () => {
  const m = moment({ weight: 19, buildings: [] }, { buildings: { a: house({ door: { x: AT.x + 60, y: AT.y }, x: AT.x + 60, y: AT.y }) } });
  const walk = byId(m, 'haul');
  assert.deepEqual([walk.verb, walk.a, walk.b, walk.key], ['GOTO', AT.x + 60, AT.y, 'HAUL:a']);
  assert.equal(policy(m).option.id, 'haul');
});

test('no base: DROP, as before', () => {
  const m = moment({ weight: 7.5, maxWeight: 8 });
  assert.equal(byId(m, 'haul'), undefined);
  assert.equal(policy(m).rule, 'overloaded');
  assert.equal(policy(m).option.verb, 'DROP');
});

test('not too full: no load option, whatever the base', () => {
  const m = moment({ weight: 5, buildings: [listed('a')] }, { buildings: { a: house() } });
  assert.equal(byId(m, 'haul'), undefined);
  assert.equal(byId(m, 'stash'), undefined);
});

test('chased: no walk home and no stash. DROP keeps its own gate, which is shut for a chaser', () => {
  const chaser = [{ dx: 30, dy: 0, d: 30, chase: true }];
  const m = moment({ weight: 19, zChasing: 1, zList: chaser, buildings: [listed('a')] }, { buildings: { a: house() } });
  assert.equal(byId(m, 'haul'), undefined);
  assert.equal(byId(m, 'drop'), undefined);
  const home = moment({ ...inHouse('a'), weight: 19, zChasing: 1, zList: chaser }, { buildings: { a: house() } });
  assert.equal(byId(home, 'stash'), undefined);
});

test('a way home past a zombie is not offered, and then DROP stays', () => {
  const m = moment({ weight: 19, buildings: [listed('a')], zList: [{ dx: 0, dy: -8, d: 8, wall: true }] }, { buildings: { a: house() } });
  assert.equal(byId(m, 'haul'), undefined);
  assert.ok(byId(m, 'drop'));
});

test('a crowded base is not walked to', () => {
  // 20 tiles off, past the 15 she can vouch for: a look with nobody in it does not clear the entry.
  const door = { x: AT.x, y: AT.y - 20 };
  const m = moment({ weight: 19, buildings: [listed('a', { d: 20, dy: -20, door })] }, {
    buildings: { a: house({ door, x: door.x, y: door.y }) }, crowd: { clock: 40, buildings: { a: { n: 4, at: 40 } }, areas: {} },
  });
  assert.equal(baseId(m), 'a');
  assert.equal(byId(m, 'haul'), undefined);
  assert.ok(byId(m, 'drop'));
});

test('at night inside another house she waits for morning, and keeps her gear', () => {
  const m = moment({ ...inHouse('other'), hour: 23, weight: 19 }, { buildings: { a: house({ water: true, bed: true }), other: house() } });
  assert.equal(baseId(m), 'a');
  assert.equal(byId(m, 'haul'), undefined);
  assert.equal(byId(m, 'drop'), undefined);
});

test('inside the base: STASH, not DROP, and the order line carries the base', () => {
  const m = moment({ ...inHouse('a'), weight: 19 }, { current: 'a', buildings: { a: house({ securedAt: 40, enteredAt: 39 }) } });
  const stash = byId(m, 'stash');
  assert.equal(stash.verb, 'STASH');
  assert.equal(byId(m, 'drop'), undefined);
  assert.equal(policy(m).option.id, 'stash');
  assert.equal(orderLine(5, stash, 'x').split('|')[1], 'STASH');
  assert.equal(orderLine(5, stash, 'x').split('|')[7], 'a');
  assert.ok(LONG_VERBS.has('STASH'));
});

test('a zombie that can reach her holds the stash, as it does a search', () => {
  const m = moment({ ...inHouse('a'), weight: 19, zList: [{ dx: 3, dy: 0, d: 4, inside: true }] }, { buildings: { a: house() } });
  assert.equal(byId(m, 'stash'), undefined);
});

test('STASH done lands on the map and lifts a search that stopped on full', () => {
  const m = moment({ ...inHouse('a'), weight: 19 }, { buildings: { a: house() } });
  const seq = send(m, byId(m, 'stash'));
  m.memory.fails['SEARCH:far'] = { why: 'full', at: m.at };
  m.memory.haul = { from: 'far', at: 40 };
  look(m, { res: { seq, verb: 'STASH', status: 'done', why: 'stashed 6', target: 'a' }, weight: 5 }, 1);
  assert.equal(m.memory.stashes.a.n, 6);
  assert.equal(m.memory.fails['SEARCH:far'], undefined);
  assert.equal(m.memory.haul, null);
  // And counts up, with or without the still heavy tail.
  const again = send(m, { verb: 'STASH', key: 'STASH:a' });
  look(m, { res: { seq: again, verb: 'STASH', status: 'done', why: 'stashed 2 (still heavy)', target: 'a' } }, 1);
  assert.equal(m.memory.stashes.a.n, 8);
});

test('a failed STASH stays off for a while, and DROP comes back in its place', () => {
  const m = moment({ ...inHouse('a'), weight: 19 }, { buildings: { a: house() } });
  const seq = send(m, byId(m, 'stash'));
  look(m, { res: { seq, verb: 'STASH', status: 'failed', why: 'nothing to stash', target: 'a' } }, 1);
  assert.equal(blockedWhy(m.memory, 'STASH:a', m.at), 'nothing to stash');
  assert.equal(byId(m, 'stash'), undefined);
  assert.ok(byId(m, 'drop'));
  // The same fail keeps her from walking home for nothing, from anywhere else.
  look(m, { ...OUT, weight: 19, buildings: [listed('a')] });
  assert.equal(byId(m, 'haul'), undefined);
});

test('a walk to the base that failed stays off, and DROP stands in', () => {
  const m = moment({ weight: 19, buildings: [] }, { buildings: { a: house({ door: { x: AT.x + 60, y: AT.y } }) } });
  m.memory.fails['HAUL:a'] = { why: 'unreachable', at: NOW };
  assert.equal(byId(m, 'haul'), undefined);
  assert.ok(byId(m, 'drop'));
});

test('SEARCH carries the base, so the mod can tell her stash from the rest', () => {
  const m = moment(inHouse('h'), { buildings: { h: house(), a: house({ water: true, bed: true }) } });
  assert.equal(byId(m, 'search').target, 'a');
  assert.equal(orderLine(5, byId(m, 'search'), 'x').split('|')[7], 'a');
});

// ---------- the house job ----------
// In house h, her base a is 2 points or more better, and SEARCH is next.
function searching(buildings) {
  const m = moment({ ...OUT, buildings: [listed('h', { d: 3 }), listed('a', { d: 20, dx: 20, dy: 0, door: { x: AT.x + 20, y: AT.y } })] }, { buildings });
  look(m, { ...inHouse('h'), buildings: [listed('h', { d: 0 }), listed('a', { d: 20, dx: 20, dy: 0, door: { x: AT.x + 20, y: AT.y } })] });
  const secure = policy(m);
  assert.equal(secure.option.verb, 'SECURE');
  const seq = send(m, secure.option);
  look(m, { res: { seq, verb: 'SECURE', status: 'done', why: 'closed 1 door', target: 'h' } }, 1);
  look(m, { res: null }, 3);
  assert.equal(m.memory.job.stage, 'SEARCH');
  return m;
}
// The base is searched already, so going there opens no job of its own.
const TWO = () => ({ h: house(), a: house({ water: true, bed: true, searched: true, door: { x: AT.x + 20, y: AT.y } }) });

test('a house left full with a base known: the load goes home and the house waits for her', () => {
  const m = searching(TWO());
  look(m, { weight: 19 });
  assert.equal(m.memory.job.stage, 'LEAVE');
  assert.equal(drainJobEvents(m.memory).at(-1).why, 'full');
  const haul = policy(m);
  assert.equal(haul.rule, 'house-job');
  assert.equal(haul.option.id, 'haul');
  assert.equal(haul.option.target, 'a');
  // She goes. The job ends on the ENTER, and the house she left is not given up on.
  send(m, haul.option);
  assert.equal(m.memory.buildings.h.searched, false);
  assert.ok(m.memory.buildings.h.fullAt != null);
  assert.equal(m.memory.buildings.h.leftAt, undefined);
  assert.equal(doneWith(m.memory.buildings.h, m.percept.hoursAlive), false);
});

test('a SEARCH that stops on "(full)" leaves the house unsearched, and marks it to come back to', () => {
  const m = searching(TWO());
  const seq = send(m, byId(m, 'search'));
  look(m, { res: { seq, verb: 'SEARCH', status: 'done', why: 'took 2: Beans, Saw (full)', target: 'h' }, weight: 19 }, 1);
  assert.equal(m.memory.buildings.h.searched, false);
  assert.equal(m.memory.job.stage, 'LEAVE');
});

test('with the load home, the house left full is first on the menu and says why', () => {
  const m = searching(TWO());
  look(m, { weight: 19 });
  send(m, policy(m).option);
  const nearby = [listed('new', { d: 5, dx: 0, dy: -5, door: { x: AT.x, y: AT.y - 5 }, visited: false }), listed('h', { d: 15, dx: 15, dy: 0, door: { x: AT.x + 15, y: AT.y } })];
  look(m, { ...inHouse('a', { buildings: [listed('a', { d: 0, dx: 0, dy: 0 }), ...nearby] }), weight: 5 }, 5);
  const first = menu(m).find((o) => o.verb === 'ENTER');
  assert.equal(first.target, 'h', 'ahead of a house she has never seen');
  assert.match(first.label, /you left it full, more to take/);
  assert.equal(doneWith(m.memory.buildings.h, m.percept.hoursAlive + REVISIT_HOURS / 2), false);
});

test('walking back into it clears the mark, and the job takes up the search', () => {
  const m = searching(TWO());
  look(m, { weight: 19 });
  send(m, policy(m).option);
  look(m, { ...OUT, weight: 5 }, 2);
  assert.ok(m.memory.buildings.h.fullAt != null);
  look(m, { ...inHouse('h'), weight: 5 }, 2);
  assert.equal(m.memory.buildings.h.fullAt, undefined);
  assert.equal(m.memory.job.id, 'h');
});

test('a house given up on for another reason still waits out its 12 hours', () => {
  const m = searching(TWO());
  // A zombie holds the search off until it stalls, and she leaves for that.
  for (let i = 0; i < 12; i++) look(m, { zList: [{ d: 6, dx: 6, dy: 0, wall: false }] }, 1);
  assert.equal(m.memory.job.stage, 'LEAVE');
  look(m, { ...OUT, zList: [] }, 1);
  assert.ok(m.memory.buildings.h.leftAt != null);
  assert.equal(m.memory.buildings.h.fullAt, undefined);
});

test('too full in the base itself: STASH on the spot, and the search goes on', () => {
  const m = moment({ ...OUT, buildings: [listed('a', { d: 3 })] }, { buildings: { a: house({ water: true }) } });
  look(m, inHouse('a'));
  const secure = policy(m);
  const seq = send(m, secure.option);
  look(m, { res: { seq, verb: 'SECURE', status: 'done', why: 'closed 1 door', target: 'a' } }, 1);
  look(m, { res: null }, 3);
  assert.equal(m.memory.job.stage, 'SEARCH');
  look(m, { weight: 19 });
  assert.equal(m.memory.job.stage, 'SEARCH', 'no reason to go anywhere');
  const stash = policy(m);
  assert.equal(stash.option.id, 'stash');
  const s2 = send(m, stash.option);
  look(m, { res: { seq: s2, verb: 'STASH', status: 'done', why: 'stashed 4', target: 'a' }, weight: 5 }, 1);
  assert.equal(policy(m).option.id, 'search');
});

test('a SEARCH that failed full in the base goes on after the stash', () => {
  const m = moment({ ...OUT, buildings: [listed('a', { d: 3 })] }, { buildings: { a: house({ water: true }) } });
  look(m, inHouse('a'));
  const seq = send(m, policy(m).option);
  look(m, { res: { seq, verb: 'SECURE', status: 'done', why: 'closed 1 door', target: 'a' } }, 1);
  look(m, { res: null }, 3);
  const s2 = send(m, byId(m, 'search'));
  look(m, { res: { seq: s2, verb: 'SEARCH', status: 'failed', why: 'full', target: 'a' }, weight: 19 }, 1);
  assert.equal(m.memory.job.stage, 'SEARCH', 'she does not walk out of her own base for being full');
  assert.equal(policy(m).option.id, 'stash');
});

test('no base and nothing left to shed: she still leaves, as before', () => {
  const m = moment({ ...OUT, buildings: [listed('s', { d: 3, res: false, shop: true })] }, { buildings: { s: { visited: true, shop: true, door: NEAR_DOOR } } });
  look(m, { ...inHouse('s'), buildings: [listed('s', { d: 0, res: false, shop: true })] });
  assert.equal(baseId(m), null);
  const seq = send(m, policy(m).option);
  look(m, { res: { seq, verb: 'SECURE', status: 'done', why: 'closed 1 door', target: 's' } }, 1);
  look(m, { res: null }, 3);
  look(m, { weight: 19 });
  const drop = policy(m);
  assert.equal(drop.rule, 'overloaded');
  const s2 = send(m, drop.option);
  look(m, { res: { seq: s2, verb: 'DROP', status: 'failed', why: 'nothing to drop', target: '' } }, 1);
  assert.equal(m.memory.job.stage, 'LEAVE');
});

// ---------- the old base ----------
test('when the base moves the old stash stays on the map, and she can walk back for it', () => {
  const door = { x: AT.x + 60, y: AT.y };
  const m = moment({ buildings: [] }, { buildings: { old: house({ door, x: door.x, y: door.y }) }, stashes: { old: { n: 5, at: 30 } } });
  assert.equal(baseId(m), 'old');
  m.memory.buildings.new = { ...house({ water: true, bed: true }), id: 'new' };
  look(m);
  assert.equal(baseId(m), 'new');
  assert.equal(m.memory.stashes.old.n, 5);
  const back = byId(m, 'oldbase');
  assert.deepEqual([back.verb, back.a, back.b], ['GOTO', door.x, door.y]);
  assert.match(back.label, /your old base 60 tiles E, 5 things stashed there/);
  assert.equal(policy(m), null, 'the model\'s call, not a rule');
  // Not with her arms full or at night.
  assert.equal(byId(look(m, { weight: 19 }), 'oldbase'), undefined);
  assert.equal(byId(look(m, { weight: 1, hour: 23 }), 'oldbase'), undefined);
});

test('in sight it is an ENTER that says so, and inside it a search that takes things back', () => {
  const door = { x: AT.x + 10, y: AT.y };
  const m = moment({ buildings: [listed('old', { door, dx: 10, dy: 0 })] }, { base: { id: 'new', at: 1 }, buildings: { old: house({ door, searched: true }), new: house({ water: true, bed: true }) }, stashes: { old: { n: 5, at: 30 } } });
  assert.equal(baseId(m), 'new');
  const back = byId(m, 'oldbase');
  assert.equal(back.verb, 'ENTER');
  assert.equal(menu(m).filter((o) => o.target === 'old').length, 1);
  look(m, { ...inHouse('old', { buildings: [listed('old', { d: 0, door })] }), inBldg: { id: 'old', room: 'kitchen', rooms: 4, roomsLeft: 0, water: false } });
  const search = byId(m, 'search');
  assert.ok(search, 'though every room reads as done');
  assert.equal(search.target, 'new');
  assert.match(search.label, /your old base.*5 things stashed here/);
  const seq = send(m, search);
  look(m, { res: { seq, verb: 'SEARCH', status: 'done', why: 'took 2: Beans, Saw', target: 'old' } }, 1);
  assert.equal(m.memory.stashes.old, undefined, 'done with it');
});

test('her own base is not an old one: no such search and no such walk', () => {
  const m = moment({ ...inHouse('a'), inBldg: { id: 'a', room: 'kitchen', rooms: 4, roomsLeft: 0 } }, { buildings: { a: house({ searched: true }) }, stashes: { a: { n: 5, at: 30 } } });
  assert.equal(byId(m, 'search'), undefined);
  assert.equal(byId(m, 'oldbase'), undefined);
  const outside = moment({ buildings: [listed('a')] }, { buildings: { a: house({ searched: true }) }, stashes: { a: { n: 5, at: 30 } } });
  assert.equal(byId(outside, 'oldbase'), undefined);
  assert.match(byId(outside, 'b1').label, /your base, 5 things stashed/);
});

test('the memory slice carries the base, so the eval can rebuild the same menu', () => {
  const m = moment({ weight: 19, buildings: [listed('a')] }, { buildings: { a: house() } });
  const slice = memorySlice(m.memory, m.percept);
  assert.equal(slice.base.id, 'a');
  const again = buildScenario({ patch: { ...OUT, weight: 19, buildings: [listed('a')] }, memory: slice });
  assert.equal(buildOptions(again.percept, again.memory, { now: NOW }).find((o) => o.id === 'haul').target, 'a');
});

// ---------- taking it back out ----------
const baseHere = (inv, patch = {}) => {
  const m = {
    percept: { outside: false, room: 'kitchen', hour: 11, hoursAlive: 40, x: 1, y: 1, zList: [], zChasing: 0, zDist: -1, zVisible: 0, hp: 100, thirst: 0, hunger: 0, fatigue: 0,
      endurance: 1, bleeding: 0, wounds: [], weight: 1, maxWeight: 12, moodle: {}, inv, inBldg: { id: 'b', room: 'kitchen', rooms: 2, roomsLeft: 0 }, buildings: [], ...patch },
    memory: loadMemory({ base: { id: 'b', at: 1 }, stashes: { b: { n: 9, at: 1 } }, buildings: { b: { id: 'b', visited: true, res: true, searched: true } } }),
  };
  return m;
};

test('low on food at her base with a stash: she takes a kit out', () => {
  const m = baseHere({ bandages: 3, foodReady: 1, cans: 0 });
  const opts = buildOptions(m.percept, m.memory, { now: 1000 });
  const got = decidePolicy(m.percept, m.memory, opts);
  assert.equal(got.rule, 'restock');
  assert.equal(got.option.verb, 'SEARCH');
  assert.equal(got.option.target, 'restock');
  assert.equal(got.option.key, 'RESTOCK:b');
});

test('stocked, or nothing stashed: no trip', () => {
  const full = baseHere({ bandages: 3, foodReady: 5, cans: 1 });
  assert.ok(!buildOptions(full.percept, full.memory, { now: 1000 }).some((o) => o.id === 'restock'));
  const none = baseHere({ bandages: 0, foodReady: 0, cans: 0 });
  none.memory.stashes = {};
  assert.ok(!buildOptions(none.percept, none.memory, { now: 1000 }).some((o) => o.id === 'restock'));
});

test('a restock counts down the stash, and an empty one stops the trips', () => {
  const m = baseHere({ bandages: 0, foodReady: 0, cans: 0 });
  recordOrder(m.memory, 5, { verb: 'SEARCH', key: 'RESTOCK:b', target: 'restock' }, m.percept, 1000);
  updateMemory(m.memory, { ...m.percept, res: { seq: 5, verb: 'SEARCH', status: 'done', why: 'took 4: A, B, C, D' } }, 2000);
  assert.equal(m.memory.stashes.b.n, 5);
  assert.equal((m.memory.buildings.b.took || []).length, 0, 'it is not a search of the house');
  recordOrder(m.memory, 6, { verb: 'SEARCH', key: 'RESTOCK:b', target: 'restock' }, m.percept, 3000);
  updateMemory(m.memory, { ...m.percept, res: { seq: 6, verb: 'SEARCH', status: 'done', why: 'took nothing' } }, 4000);
  assert.equal(m.memory.fails['RESTOCK:b'].why, 'nothing left');
  assert.ok(!buildOptions(m.percept, m.memory, { now: 5000 }).some((o) => o.id === 'restock'));
});

test('low and away from home: the walk is on the menu', () => {
  const m = baseHere({ bandages: 0, foodReady: 0, cans: 0 }, { inBldg: null, outside: true, room: '', x: 10, y: 10 });
  m.memory.buildings.b.door = { x: 20, y: 10 };
  const opts = buildOptions(m.percept, m.memory, { now: 1000 });
  const walk = opts.find((o) => o.id === 'restockwalk');
  assert.ok(walk, opts.map((o) => o.id).join());
  assert.equal(walk.verb, 'GOTO');
});
