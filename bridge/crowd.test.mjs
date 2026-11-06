// The crowd map (crowd.mjs): zombie counts by building and by area from every percept, fading over
// 12 game hours, and what it does to the ENTER menu, the next house and the retry timer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, merge } from './eval/scenarios.mjs';
import { buildOptions, setSearchLog } from './options.mjs';
import { updateMemory, recordOrder, loadMemory, memorySlice, blockedWhy, emptyMemory, ENTER_ZOMBIE_MS, ENTER_ZOMBIE_MAX_MS, STRIKE_MEMORY_MS } from './memory.mjs';
import { nextHouse } from './housejob.mjs';
import { buildingCrowd, areaCrowd, areaKey, loadCrowd, markShot, crowdFor, crowdText, areaCrowded, FADE_HOURS, FAR_JUMP, CROWD_BUILDING, CROWD_AREA, SHOT_AREA } from './crowd.mjs';
import { createReflexFollower } from './reflexlog.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

setSearchLog(() => {});
const NOW = 1_000_000;
const MIN = 60_000;

const NEXT = { d: 12, door: { x: 10662, y: 9830 }, dx: 12, dy: 0, id: 'next', res: true, shop: false, visited: false };
const FAR = { d: 30, door: { x: 10650, y: 9860 }, dx: 0, dy: 30, id: 'far', res: true, shop: false, visited: false };
const OUT = {
  outside: true, inBldg: null, room: '', hour: 11, hoursAlive: 40, x: 10650, y: 9830, zList: [], zChasing: 0, zDist: -1, zVisible: 0,
  thirst: 0, hunger: 0, fatigue: 0, endurance: 1, bleeding: 0, wounds: [], weight: 1, maxWeight: 20, items: '', moodle: {},
  inv: { bandages: 1, waterL: 0.5, foodReady: 0, cans: 0, emptyBottles: 0 }, weapon: 'Baseball Bat', weaponScore: 30,
  buildings: [NEXT, FAR],
};
const zed = (dx, dy, extra = {}) => ({ dx, dy, d: Math.hypot(dx, dy), chase: false, down: false, crawl: false, wall: false, inside: false, ...extra });

function scene(patch = {}) {
  const m = buildScenario({ patch: { ...OUT, ...patch } });
  m.at = NOW;
  return m;
}
function look(m, patch = {}, hours = 0) {
  const alive = patch.hoursAlive ?? m.percept.hoursAlive + hours;
  m.percept = { ...merge(m.percept, patch), hoursAlive: alive };
  m.at += 1000;
  updateMemory(m.memory, m.percept, m.at);
  return m;
}
const menu = (m) => buildOptions(m.percept, m.memory, { now: m.at });
// Her position and a percept that lists no buildings, so only what the map already knows is left.
const away = (x, y = 9830) => ({ x, y, buildings: [], zList: [] });

test('zombies are counted by building and by area from a percept that has no one inside', () => {
  const m = scene({ zList: [zed(11, 1), zed(13, -1), zed(12, 2), zed(-24, 0)] });
  look(m);
  assert.equal(buildingCrowd(m.memory, 'next'), 3, 'three stand at the next house');
  assert.equal(buildingCrowd(m.memory, 'far'), 0);
  assert.equal(areaCrowd(m.memory, 10662, 9831), 3, 'and in its 20 by 20 area');
  assert.equal(areaCrowd(m.memory, 10626, 9830), 1, 'the one far to the west is in another area');
  const before = JSON.stringify(m.memory.crowd);
  look(m);
  assert.equal(JSON.stringify(m.memory.crowd), before, 'the same percept twice changes nothing');
});

test('a zombie in her own building is counted there, however far from its wall point', () => {
  const m = scene({
    outside: false, inBldg: { id: 'h1', rooms: 4, roomsLeft: 4, water: false },
    buildings: [{ d: 0, door: { x: 10640, y: 9830 }, dx: 0, dy: 0, id: 'h1', res: true, shop: false, visited: true }, NEXT],
    zList: [zed(-3, 2, { inside: true }), zed(2, 2, { inside: true })],
  });
  look(m);
  assert.equal(buildingCrowd(m.memory, 'h1'), 2);
});

test('the crowd fades in a straight line and is gone after 12 game hours', () => {
  const m = scene({ zList: [zed(11, 1), zed(13, -1), zed(12, 2), zed(12, 0), zed(10, 0), zed(14, 1)] });
  look(m);
  assert.equal(buildingCrowd(m.memory, 'next'), 6);
  // She walks off. The list is complete but the house is out of view, so nothing clears it but time.
  look(m, away(10750), FADE_HOURS / 2);
  assert.equal(buildingCrowd(m.memory, 'next'), 3, 'half gone at six hours');
  look(m, away(10750), FADE_HOURS / 2 - 0.01);
  assert.ok(buildingCrowd(m.memory, 'next') <= 1);
  look(m, away(10750), 0.02);
  assert.equal(buildingCrowd(m.memory, 'next'), 0);
  assert.equal(m.memory.crowd.buildings.next, undefined, 'and the entry is dropped');
});

test('a full list only raises the count; a short list in view clears an emptied house', () => {
  const six = [zed(11, 1), zed(13, -1), zed(12, 2), zed(12, 0), zed(10, 0), zed(14, 1)];
  const m = scene({ zList: six });
  look(m);
  // Six is the most the list shows. One zombie of six near the house says nothing about the other five.
  look(m, { zList: [zed(12, 1), zed(-20, 0), zed(-21, 0), zed(-22, 0), zed(-20, 5), zed(-22, 5)] });
  assert.equal(buildingCrowd(m.memory, 'next'), 6, 'a full list may be hiding the rest');
  // Five listed: that is all of them within 25 tiles, and the house is 12 away. Nobody is in it.
  look(m, { zList: [zed(-20, 0), zed(-21, 0), zed(-22, 0), zed(-20, 5), zed(-22, 5)] });
  assert.equal(buildingCrowd(m.memory, 'next'), 0, 'she can see it is empty');
  assert.equal(areaCrowd(m.memory, 10662, 9830), 6, 'its area reaches 31 tiles off, past the list: that stays');
});

test('an area wholly inside the 25 tiles she can list is cleared when it empties', () => {
  const m = scene({ zList: [zed(-3, 0), zed(-4, 1)] });
  look(m);
  assert.equal(areaCrowd(m.memory, 10647, 9830), 2);
  look(m, { zList: [] });
  assert.equal(areaCrowd(m.memory, 10647, 9830), 0);
});

test('a house out of view keeps its crowd even when the list is short', () => {
  const m = scene({ zList: [zed(11, 1), zed(13, -1), zed(12, 2)] });
  look(m);
  look(m, away(10700));
  assert.equal(buildingCrowd(m.memory, 'next'), 3, '38 tiles off: she cannot say it emptied');
});

test('the map is saved with the rest of the memory and read back, and a bad one is ignored', () => {
  const m = scene({ zList: [zed(11, 1), zed(13, -1), zed(12, 2)] });
  look(m);
  const back = loadMemory(JSON.parse(JSON.stringify(m.memory)));
  assert.equal(buildingCrowd(back, 'next'), 3);
  assert.equal(areaCrowd(back, 10662, 9830), 3);
  assert.deepEqual(back.crowd, m.memory.crowd);
  assert.deepEqual(loadMemory({ crowd: 'no' }).crowd, emptyMemory().crowd);
  const junk = loadCrowd({ clock: 'x', last: { hours: 'a' }, buildings: { a: { n: 'z', at: 1 }, b: { n: 2, at: 0 }, c: null }, areas: [] });
  assert.deepEqual(Object.keys(junk.buildings), ['b']);
  assert.equal(junk.last, null);
  // The slice an eval keeps carries what the labels read.
  const slice = memorySlice(m.memory, m.percept);
  assert.equal(slice.crowd.buildings.next.n, 3);
  assert.equal(slice.crowd.areas[areaKey(10662, 9830)].n, 3);
});

test('a shot marks its 20 by 20 area crowded, and only that one', () => {
  const m = scene({ zList: [] });
  look(m);
  markShot(m.memory, 10662, 9831);
  assert.equal(areaCrowd(m.memory, 10662, 9831), SHOT_AREA);
  assert.equal(areaCrowd(m.memory, 10679, 9839), SHOT_AREA, 'the same cell');
  assert.equal(areaCrowd(m.memory, 10681, 9831), 0, 'the next cell');
  const cr = crowdFor(m.memory, 'nobody', 10662, 9831);
  assert.equal(areaCrowded(cr), true);
  assert.equal(crowdText(cr), 'a gunshot in this area lately', 'nobody counted those zombies, so the label does not claim to');
});

test('a shot is not wiped by the next look, even a complete one with few zombies in view', () => {
  // A complete list sets an area to what she can see. That must not clear the noise.
  const m = scene({ x: 10670, y: 9830, zList: [zed(2, 1)] });
  look(m);
  markShot(m.memory, 10670, 9830);
  look(m);
  look(m, { zList: [] });
  assert.equal(areaCrowd(m.memory, 10670, 9830), SHOT_AREA);
});

test('a shot fades like the rest of the map, stays through a save, and goes with a far respawn', () => {
  const m = scene({ zList: [] });
  look(m);
  markShot(m.memory, 10662, 9831);
  const back = loadMemory(JSON.parse(JSON.stringify(m.memory)));
  assert.equal(areaCrowd(back, 10662, 9831), SHOT_AREA);
  look(m, { hoursAlive: 40 + 6 });
  assert.equal(areaCrowd(m.memory, 10662, 9831), SHOT_AREA / 2);
  assert.equal(areaCrowded(crowdFor(m.memory, 'x', 10662, 9831)), true, 'crowded for hours');
  look(m, { hoursAlive: 40 + FADE_HOURS * 0.75 });
  assert.equal(areaCrowd(m.memory, 10662, 9831) < CROWD_AREA, true, 'then not');
  look(m, { hoursAlive: 40 + FADE_HOURS + 1 });
  assert.equal(areaCrowd(m.memory, 10662, 9831), 0);
  assert.deepEqual(m.memory.crowd.shots, {}, 'and the entry is gone');

  const far = scene({ zList: [] });
  look(far);
  markShot(far.memory, 10662, 9831);
  look(far, { hoursAlive: 0, x: 10650 + FAR_JUMP + 10 });
  assert.deepEqual(far.memory.crowd.shots, {});
});

test('a bad shot line does nothing, and an old save with no shots still reads', () => {
  const m = scene({ zList: [] });
  look(m);
  markShot(m.memory, 'x', undefined);
  assert.deepEqual(m.memory.crowd.shots, {});
  const old = { crowd: { clock: 1, buildings: {}, areas: {} } };
  assert.deepEqual(loadMemory(old).crowd.shots, {});
  assert.equal(areaCrowd({ crowd: { clock: 1, buildings: {}, areas: {} } }, 0, 0), 0, 'a map with no shots list at all');
});

test('the bridge marks the area when the reflex log says a gun went off', () => {
  const m = scene({ zList: [] });
  look(m);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crowdshot-')), 'local_reflex.txt');
  fs.writeFileSync(file, JSON.stringify({ t: 'shot', tick: 5, gun: 'Shotgun', noiseR: 200, x: 10700, y: 9800 }) + '\n');
  const lines = [];
  const poll = createReflexFollower({ file, write: (l) => lines.push(l), readFrom: 'start', onShot: (l) => markShot(m.memory, l.x, l.y) });
  assert.equal(poll(), 1);
  assert.equal(lines[0].kind, 'shot');
  assert.equal(areaCrowd(m.memory, 10700, 9800), SHOT_AREA);
});

test('a new character in the same place keeps the map, one far away starts clean', () => {
  const m = scene({ zList: [zed(11, 1), zed(13, -1), zed(12, 2)] });
  look(m);
  // hoursAlive back to nearly 0: a new character. She spawns 40 tiles off, the same town.
  look(m, { hoursAlive: 0.1, x: 10690, buildings: [], zList: [] });
  assert.equal(buildingCrowd(m.memory, 'next'), 3);
  look(m, { hoursAlive: 5 });
  look(m, { hoursAlive: 0.1, x: 10650 + FAR_JUMP + 50, buildings: [], zList: [] });
  assert.deepEqual(m.memory.crowd.buildings, {});
  assert.deepEqual(m.memory.crowd.areas, {});
});

test('a crowded building is not offered, and the label on the others says what was seen', () => {
  const m = scene({ buildings: [NEXT, FAR] });
  const a = menu(m).filter((o) => o.verb === 'ENTER').map((o) => o.target);
  assert.deepEqual(a, ['next', 'far'], 'nearest first before any crowd');
  m.memory.crowd.buildings.next = { n: 4, at: m.memory.crowd.clock };
  assert.deepEqual(menu(m).filter((o) => o.verb === 'ENTER').map((o) => o.target), ['far'], '4 seen: left off');
  m.memory.crowd.buildings.next = { n: 2, at: m.memory.crowd.clock };
  const two = menu(m).find((o) => o.target === 'next');
  assert.match(two.label, /2 zombies seen here lately/);
  m.memory.crowd.buildings.next = { n: 1, at: m.memory.crowd.clock };
  assert.match(menu(m).find((o) => o.target === 'next').label, /1 zombie seen here lately/);
  m.memory.crowd.buildings.next = { n: CROWD_BUILDING, at: m.memory.crowd.clock - FADE_HOURS };
  assert.equal(menu(m).find((o) => o.target === 'next').label.includes('seen here lately'), false, 'faded away');
});

test('a crowded area ranks after the rest, with its own words', () => {
  const m = scene({ buildings: [NEXT, FAR] });
  m.memory.crowd.areas[areaKey(NEXT.door.x, NEXT.door.y)] = { n: 5, at: m.memory.crowd.clock };
  const enters = menu(m).filter((o) => o.verb === 'ENTER');
  assert.deepEqual(enters.map((o) => o.target), ['far', 'next'], 'the nearer house is in the crowded area');
  assert.match(enters[1].label, /5 zombies seen in this area lately/);
  assert.equal(enters[0].label.includes('seen in this area'), false);
});

test('the planned home is not walked back to while a crowd holds it', () => {
  const home = { door: { x: 10600, y: 9830 } };
  const m = scene({ buildings: [], hour: 18 });
  m.memory.buildings.home = { id: 'home', visited: true, searched: true, res: true, water: true, bed: true, ...home };
  const plan = { goal: 'home', steps: [], home: 'home' };
  assert.ok(buildOptions(m.percept, m.memory, { now: m.at, plan }).some((o) => o.id === 'home'));
  m.memory.crowd.buildings.home = { n: 3, at: m.memory.crowd.clock };
  assert.equal(buildOptions(m.percept, m.memory, { now: m.at, plan }).some((o) => o.id === 'home'), false);
});

test('the next house of a house job skips a crowded house and a crowded area', () => {
  const mem = emptyMemory();
  for (const [id, x] of [['crowd', 100], ['area', 300], ['clear', 500]]) mem.buildings[id] = { id, door: { x, y: 100 } };
  mem.buildings.cur = { id: 'cur', door: { x: 700, y: 100 } };
  mem.crowd.buildings.crowd = { n: 3, at: 0 };
  mem.crowd.areas[areaKey(300, 100)] = { n: 5, at: 0 };
  const enter = (target) => ({ verb: 'ENTER', target, label: 'walk into house 10 tiles east, not visited' });
  const opts = [enter('crowd'), enter('area'), enter('clear')];
  assert.equal(nextHouse(opts, mem, { id: 'cur' }, 0).target, 'clear');
  assert.equal(nextHouse(opts.slice(0, 2), mem, { id: 'cur' }, 0), null, 'with none left she explores');
  mem.crowd.clock = FADE_HOURS;
  assert.equal(nextHouse(opts, mem, { id: 'cur' }, 0).target, 'crowd', 'twelve hours on, the nearest again');
});

// A failed ENTER, as the body reports it.
function failEnter(m, seq, why = 'zombie') {
  recordOrder(m.memory, seq, { verb: 'ENTER', key: 'ENTER:next', target: 'next' }, m.percept, m.at);
  look(m, { res: { seq, verb: 'ENTER', status: 'failed', why, target: 'next' } });
}

test('a failed ENTER with zombies stays off for 5 minutes, then 10, 20 and at most 30', () => {
  const m = scene();
  const key = 'ENTER:next';
  failEnter(m, 1);
  const at = m.at;
  assert.ok(blockedWhy(m.memory, key, at + 4 * MIN), 'still off at 4 minutes');
  assert.equal(blockedWhy(m.memory, key, at + ENTER_ZOMBIE_MS + 1000), '', 'back after 5');
  failEnter(m, 2);
  assert.ok(blockedWhy(m.memory, key, m.at + 9 * MIN), 'the second time it is 10');
  assert.equal(blockedWhy(m.memory, key, m.at + 10 * MIN + 1000), '');
  failEnter(m, 3);
  assert.ok(blockedWhy(m.memory, key, m.at + 19 * MIN));
  failEnter(m, 4);
  failEnter(m, 5);
  assert.ok(blockedWhy(m.memory, key, m.at + 29 * MIN), 'capped at half an hour, not longer');
  assert.equal(blockedWhy(m.memory, key, m.at + ENTER_ZOMBIE_MAX_MS + 1000), '');
  assert.equal(m.memory.strikes[key].n, 5);
});

// Live 2026-11-06: a house with no door she could reach, retried every 90 s.
test('an unreachable house waits longer each time, like a zombie at the door', () => {
  const m = scene();
  const key = 'ENTER:next';
  failEnter(m, 1, 'unreachable');
  assert.ok(blockedWhy(m.memory, key, m.at + 4 * MIN), 'off for 5 minutes, not 90 s');
  failEnter(m, 2, 'unreachable');
  assert.ok(blockedWhy(m.memory, key, m.at + 9 * MIN), 'then 10');
  assert.equal(m.memory.strikes[key].n, 2);
});

test('the strikes are saved, forgotten after an hour, and cleared by getting in', () => {
  const m = scene();
  failEnter(m, 1);
  assert.equal(loadMemory(JSON.parse(JSON.stringify(m.memory))).strikes['ENTER:next'].n, 1);
  m.at += STRIKE_MEMORY_MS + MIN;
  failEnter(m, 2);
  assert.equal(m.memory.strikes['ENTER:next'].n, 1, 'an hour of quiet: the first strike again');
  failEnter(m, 3);
  assert.equal(m.memory.strikes['ENTER:next'].n, 2);
  recordOrder(m.memory, 4, { verb: 'ENTER', key: 'ENTER:next', target: 'next' }, m.percept, m.at);
  look(m, { res: { seq: 4, verb: 'ENTER', status: 'done', why: 'in by a door', target: 'next' } });
  assert.equal(m.memory.strikes['ENTER:next'], undefined);
});

test('other failures keep their own timers: a locked door 20 minutes, a zombie on a search 30 seconds', () => {
  const m = scene();
  failEnter(m, 1, 'locked');
  assert.ok(blockedWhy(m.memory, 'ENTER:next', m.at + 19 * MIN));
  assert.equal(m.memory.strikes['ENTER:next'], undefined, 'a locked door is not a strike');
  m.memory.fails['SEARCH:h1'] = { why: 'zombie', at: m.at };
  assert.ok(blockedWhy(m.memory, 'SEARCH:h1', m.at + 20_000));
  assert.equal(blockedWhy(m.memory, 'SEARCH:h1', m.at + 31_000), '');
});
