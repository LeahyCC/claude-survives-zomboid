// The long orders (GOTO, ENTER, SEARCH, LOOT), the MOVE fallbacks, and how they yield to the
// reflex, driven tick by tick with stub squares. The pathfinder never runs here: a test moves the
// player and empties the queue to stand for a walk that finished. Real paths, doors and
// containers are live-game checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

// A body at (x, y) whose square follows it, plus any Lua setup.
function world(setup = '', x = 10.5, y = 10.5) {
  const lua = createHarness();
  lua.autoload();
  lua.run(`
    function __floor(x0, y0, x1, y1, opts)
      for x = x0, x1 do
        for y = y0, y1 do
          local o = {}
          for k, v in pairs(opts or {}) do o[k] = v end
          o.x, o.y = x, y
          __makeSquare(o)
        end
      end
    end
    __players[0] = __makePlayer({ x = ${x}, y = ${y}, live = true })
    P = __players[0]
    ${setup}
  `);
  return lua;
}

const order = (lua, line) => lua.run(`LocalSurvivor.Act.execIntent(P, "${line}")`);
const tick = (lua, n = 1, acted = false) =>
  lua.run(`for i = 1, ${n} do LocalSurvivor.tick = LocalSurvivor.tick + 1; LocalSurvivor.Act.update(P, ${acted}) end`);
// The record without res.target. Targets have their own tests.
const result = (lua) => {
  const { target, ...rest } = lua.get('LocalSurvivor.result');
  return rest;
};
const targetOf = (lua) => lua.get('LocalSurvivor.result.target');
const queue = (lua) => lua.run('return __queueTypes(P)');
const moveTo = (lua, x, y) => lua.run(`P.x, P.y = ${x}, ${y}`);
const walkTarget = (lua) => lua.run(`
  local a = ISTimedActionQueue.getTimedActionQueue(P).queue[1]
  local sq = a and a.args[2]
  return sq and (sq:getX() .. "," .. sq:getY()) or nil
`);

test('the new verbs are registered', () => {
  const lua = world();
  for (const verb of ['GOTO', 'ENTER', 'SEARCH', 'LOOT']) {
    assert.equal(lua.run(`return type(LocalSurvivor.verbs.${verb})`), 'function', verb);
  }
});

// ---------- GOTO ----------
test('GOTO walks to the square and is done within 1.5 tiles', () => {
  const lua = world('__floor(8, 8, 22, 12)');
  order(lua, '1|GOTO|20|10|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'GOTO', status: 'running', why: '' });
  tick(lua);
  assert.deepEqual(queue(lua), ['ISWalkToTimedAction']);
  assert.equal(walkTarget(lua), '20,10');
  moveTo(lua, 19.4, 10.5);
  tick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'GOTO', status: 'done', why: 'arrived' });
  assert.equal(lua.get('LocalSurvivor.skill'), undefined);
});

test('GOTO to furniture walks to a free square next to it', () => {
  const lua = world('__floor(8, 8, 22, 12); __squares["20,10,0"].opts.blocked = true');
  order(lua, '1|GOTO|20|10|||');
  tick(lua);
  assert.equal(walkTarget(lua), '19,10');
  moveTo(lua, 19.5, 10.5);
  tick(lua);
  assert.equal(result(lua).status, 'done');
});

test('GOTO fails unreachable when the walk keeps ending where it started', () => {
  const lua = world('__floor(8, 8, 22, 12)');
  order(lua, '1|GOTO|20|10|||');
  for (let i = 0; i < 3; i++) {
    tick(lua);
    lua.run('ISTimedActionQueue.clear(P)');
  }
  tick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'GOTO', status: 'failed', why: 'unreachable' });
  assert.equal(lua.get('LocalSurvivor.lastError'), 'goto: unreachable');
});

test('GOTO fails stuck when a walk is queued and the body does not move', () => {
  const lua = world('__floor(8, 8, 22, 12)');
  order(lua, '1|GOTO|20|10|||');
  tick(lua, 300);
  assert.equal(result(lua).status, 'running');
  tick(lua, 3);
  assert.deepEqual(result(lua), { seq: 1, verb: 'GOTO', status: 'failed', why: 'stuck' });
});

test('GOTO without numbers fails at once with its own reason', () => {
  const lua = world();
  order(lua, '1|GOTO|x|y|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'GOTO', status: 'failed', why: 'no target' });
});

// ---------- yielding to the reflex ----------
test('a skill leaves the reflex queue alone while it acts, then picks up again', () => {
  const lua = world('__floor(8, 8, 22, 12)');
  order(lua, '1|GOTO|20|10|||');
  tick(lua);
  // The reflex clears the queue and swings.
  lua.run('ISTimedActionQueue.clear(P); ISTimedActionQueue.add({ Type = "Swing", args = { P } })');
  tick(lua, 1, true);
  tick(lua, 29);
  assert.deepEqual(queue(lua), ['Swing']);
  assert.equal(result(lua).status, 'running');
  tick(lua, 2);
  assert.deepEqual(queue(lua), ['ISWalkToTimedAction']);
});

test('a skill whose target is now next to a zombie fails with zombie', () => {
  const lua = world('__floor(8, 8, 22, 12)');
  order(lua, '1|GOTO|20|10|||');
  tick(lua);
  tick(lua, 1, true);
  lua.run('__zombies[1] = __makeZombie({ x = 21, y = 10 })');
  tick(lua, 31);
  assert.deepEqual(result(lua), { seq: 1, verb: 'GOTO', status: 'failed', why: 'zombie' });
});

test('WAIT lets a skill run on and STOP cancels it', () => {
  const lua = world('__floor(8, 8, 22, 12)');
  order(lua, '1|GOTO|20|10|||');
  tick(lua);
  order(lua, '2|WAIT|0|0||still working|');
  assert.equal(lua.run('return LocalSurvivor.skill and LocalSurvivor.skill.verb'), 'GOTO');
  assert.equal(result(lua).seq, 1);
  assert.equal(lua.get('LocalSurvivor.observing'), false);
  order(lua, '3|STOP|0|0|||');
  assert.equal(lua.get('LocalSurvivor.skill'), undefined);
  assert.deepEqual(result(lua), { seq: 3, verb: 'STOP', status: 'running', why: '' });
});

// ---------- MOVE ----------
test('MOVE walks straight when the line is clear', () => {
  const lua = world('__floor(8, 8, 30, 12)');
  order(lua, '1|MOVE|16|0|||');
  assert.deepEqual(queue(lua), ['ISWalkToTimedAction']);
  assert.equal(walkTarget(lua), '26,10');
});

test('MOVE into a wall asks the pathfinder for the nearest square around the heading', () => {
  const lua = world('__floor(8, 2, 30, 18); __squares["11,10,0"].opts.walls = { ["12,10"] = true }');
  order(lua, '1|MOVE|16|0|||');
  assert.deepEqual(queue(lua), ['ISPathFindAction']);
  const spots = lua.run('return ISTimedActionQueue.getTimedActionQueue(P).queue[1].args[2]');
  assert.equal(spots.length % 3, 0);
  assert.deepEqual(spots.slice(0, 3), [26.5, 10.5, 0]);
});

function fireUnstick(lua, x = 10, y = 10) {
  lua.run(`
    LocalSurvivor.tick = LocalSurvivor.tick + 200
    LocalSurvivor.reflexState.unstickUntil = LocalSurvivor.tick + 150
    LocalSurvivor.reflexState.stuckX, LocalSurvivor.reflexState.stuckY = ${x}, ${y}
    ISTimedActionQueue.clear(P)
    LocalSurvivor.Act.update(P, false)
    ISTimedActionQueue.add(ISWalkToTimedAction:new(P, __squares["26,10,0"]))
    LocalSurvivor.tick = LocalSurvivor.tick + 1
    LocalSurvivor.Act.update(P, false)
  `);
}

test('MOVE fails stuck when the unstick helper fires three times on one tile', () => {
  const lua = world('__floor(8, 8, 30, 12)');
  order(lua, '1|MOVE|16|0|||');
  tick(lua);
  fireUnstick(lua);
  fireUnstick(lua);
  assert.equal(result(lua).status, 'running');
  fireUnstick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'MOVE', status: 'failed', why: 'stuck' });
  assert.equal(lua.get('LocalSurvivor.lastError'), 'move: stuck');
  assert.equal(lua.get('LocalSurvivor.travel.active'), false);
});

test('fires on different tiles do not count as stuck', () => {
  const lua = world('__floor(8, 8, 30, 12)');
  order(lua, '1|MOVE|16|0|||');
  tick(lua);
  fireUnstick(lua, 10, 10);
  fireUnstick(lua, 11, 10);
  fireUnstick(lua, 12, 10);
  assert.equal(result(lua).status, 'running');
});

test('MOVE fails unreachable when three steps in a row go nowhere', () => {
  const lua = world('__floor(8, 8, 30, 12)');
  order(lua, '1|MOVE|16|0|||');
  for (let i = 0; i < 3; i++) {
    lua.run('ISTimedActionQueue.clear(P); LocalSurvivor.Move.momentum(P)');
  }
  tick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'MOVE', status: 'failed', why: 'unreachable' });
});

test('a reflex flee still walks the old way and never reports', () => {
  const lua = world('__floor(8, 2, 30, 18); __squares["11,10,0"].opts.walls = { ["12,10"] = true }');
  lua.run('LocalSurvivor.Move.doMove(P, 16, 0)');
  assert.deepEqual(queue(lua), ['ISWalkToTimedAction']);
  assert.equal(lua.get('LocalSurvivor.travel.seq'), undefined);
});

// ---------- SEARCH and LOOT ----------
const HOUSE = `
  B = __makeBuilding({ id = "B1", x = 10, y = 10, x2 = 24, y2 = 14, res = true })
  KITCHEN = __makeRoom({ name = "kitchen", x = 10, y = 10, x2 = 14, y2 = 14 })
  BEDROOM = __makeRoom({ name = "bedroom", x = 20, y = 10, x2 = 24, y2 = 14 })
  B.def.getRooms = function() return __javaList({ KITCHEN.def, BEDROOM.def }) end
  __floor(10, 10, 14, 14, { building = B, room = KITCHEN })
  __floor(20, 10, 24, 14, { building = B, room = BEDROOM })
  __floor(15, 10, 19, 14, {})
  __squares["12,10,0"].opts.blocked = true
  __squares["22,10,0"].opts.blocked = true
  CROWBAR = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, range = 1.25,
    twoHand = true, cls = { "BLUNT" }, weight = 2 })
  SHIRT = __makeItem({ type = "Base.Tshirt", name = "T-Shirt", clothing = true, weight = 0.2 })
  BREAD = __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -30, weight = 0.3 })
  BEANS = __makeItem({ type = "Base.TinnedBeans", name = "Beans", food = true, cantEat = true,
    opening = "OpenCannedFood", weight = 0.8 })
  SPIFFO = __makeItem({ type = "Base.Spiffo", name = "Spiffo", weight = 0.4 })
  COUNTER = __makeContainer({ items = { SHIRT, BREAD, CROWBAR, SPIFFO, BEANS }, square = __squares["12,10,0"] })
  BANDAGE = __makeItem({ type = "Base.Bandage", name = "Bandage", bandage = true, weight = 0.1 })
  WARDROBE = __makeContainer({ items = { BANDAGE }, square = __squares["22,10,0"] })
  KITCHEN.__containers = { COUNTER }
  KITCHEN.getContainer = function() return __javaList({ COUNTER }) end
  BEDROOM.getContainer = function() return __javaList({ WARDROBE }) end
`;

test('SEARCH walks to the nearest container and takes only what the table wants', () => {
  const lua = world(HOUSE);
  order(lua, '1|SEARCH|0|0|||');
  assert.equal(result(lua).status, 'running');
  tick(lua, 3); // room, next container, walk
  assert.equal(walkTarget(lua), '11,10');
  moveTo(lua, 11.5, 10.5);
  tick(lua, 2); // arrive, take
  const taken = lua.run(`
    local out = {}
    for i, a in ipairs(ISTimedActionQueue.getTimedActionQueue(P).queue) do out[i] = a.args[2]:getDisplayName() end
    return out
  `);
  assert.deepEqual(taken, ['Crowbar', 'Bread', 'Beans']);
  assert.ok(lua.get('LocalSurvivor.lastLootTick') > 0);
  lua.run('__take(P, COUNTER)');
  tick(lua, 3); // wait, next (none: kitchen done), room (bedroom)
  assert.equal(lua.get('LocalSurvivor.searched.B1')['kitchen@10,10,0'], true);
  tick(lua, 2); // next container, walk
  assert.equal(walkTarget(lua), '21,10');
  moveTo(lua, 21.5, 10.5);
  tick(lua, 2);
  lua.run('__take(P, WARDROBE)');
  tick(lua, 4);
  assert.deepEqual(result(lua), { seq: 1, verb: 'SEARCH', status: 'done', why: 'took 4: Crowbar, Bread, Beans, Bandage' });
  assert.deepEqual(lua.run('local out = {} for i, it in ipairs(COUNTER.items) do out[i] = it:getDisplayName() end return out'), ['T-Shirt', 'Spiffo']);
  order(lua, '2|SEARCH|0|0|||');
  assert.deepEqual(result(lua), { seq: 2, verb: 'SEARCH', status: 'failed', why: 'nothing left' });
});

test('SEARCH stops when the bag is full and the next one picks up the rooms left', () => {
  const lua = world(HOUSE);
  order(lua, '1|SEARCH|0|0|||');
  tick(lua, 3);
  moveTo(lua, 11.5, 10.5);
  tick(lua, 2);
  lua.run('__take(P, COUNTER); P.weight = 7');
  tick(lua, 4);
  assert.deepEqual(result(lua), { seq: 1, verb: 'SEARCH', status: 'done', why: 'took 3: Crowbar, Bread, Beans (full)' });
  lua.run('P.weight = 0');
  order(lua, '2|SEARCH|0|0|||');
  tick(lua, 3);
  assert.equal(walkTarget(lua), '21,10');
});

test('skills name their target in res: x,y for GOTO, the building for ENTER and SEARCH', () => {
  const go = world('__floor(8, 8, 22, 12)');
  order(go, '1|GOTO|20.7|10|||');
  assert.equal(targetOf(go), '20,10');
  moveTo(go, 19.4, 10.5);
  tick(go);
  assert.equal(result(go).status, 'done');
  assert.equal(targetOf(go), '20,10', 'done keeps the target');
  order(go, '2|GOTO|x|y|||');
  assert.equal(targetOf(go), undefined, 'no target, no field');

  const enter = enterWorld();
  order(enter, '1|ENTER|0|0||||B2');
  assert.equal(targetOf(enter), 'B2');

  const search = world(HOUSE);
  order(search, '1|SEARCH|0|0|||');
  assert.equal(targetOf(search), 'B1');
  search.run('LocalSurvivor.Act.finish(LocalSurvivor.skill, "done", "took nothing")');
  assert.equal(targetOf(search), 'B1');
  order(search, '2|WAIT|0|0|||');
  assert.equal(targetOf(search), undefined, 'a new order clears it');
});

test('a WAIT while a skill runs leaves the skill target in res', () => {
  const lua = world(HOUSE);
  order(lua, '1|SEARCH|0|0|||');
  order(lua, '2|WAIT|0|0|||');
  assert.equal(result(lua).seq, 1);
  assert.equal(targetOf(lua), 'B1');
});

test('roomsLeft counts the rooms SEARCH has not finished', () => {
  const lua = world(HOUSE);
  const left = () => lua.run('local _, m = LocalSurvivor.Sense.currentBuilding(P); return LocalSurvivor.Act.roomsLeft(m)');
  lua.run('P.getSquare = function() return __squares["11,11,0"] end');
  assert.equal(left(), 2);
  lua.run('LocalSurvivor.searched.B1 = { ["kitchen@10,10,0"] = true }');
  assert.equal(left(), 1);
  lua.run('LocalSurvivor.searched.B1["bedroom@20,10,0"] = true');
  assert.equal(left(), 0);
});

test('SEARCH outside a building fails at once', () => {
  const lua = world('__floor(8, 8, 12, 12)');
  order(lua, '1|SEARCH|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'SEARCH', status: 'failed', why: 'not inside' });
});

test('SEARCH with a zombie close fails with zombie', () => {
  const lua = world(HOUSE + '__zombies[1] = __makeZombie({ x = 14, y = 10 })');
  order(lua, '1|SEARCH|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'SEARCH', status: 'failed', why: 'zombie' });
});

test('LOOT searches only the room the body is in', () => {
  const lua = world(HOUSE);
  order(lua, '1|LOOT|0|0|||');
  tick(lua, 3);
  moveTo(lua, 11.5, 10.5);
  tick(lua, 2);
  lua.run('__take(P, COUNTER)');
  tick(lua, 4);
  assert.deepEqual(result(lua), { seq: 1, verb: 'LOOT', status: 'done', why: 'took 3: Crowbar, Bread, Beans' });
  assert.equal(lua.run('return #WARDROBE.items'), 1);
});

test('LOOT with no container in reach fails with nothing left, which the old bridge reads as err', () => {
  const lua = world('__floor(8, 8, 12, 12)');
  order(lua, '1|LOOT|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'LOOT', status: 'failed', why: 'nothing left' });
  assert.equal(lua.get('LocalSurvivor.lastError'), 'loot: nothing left');
});

test('a MOVE in the middle of a grab waits for the transfers', () => {
  const lua = world(HOUSE);
  order(lua, '1|LOOT|0|0|||');
  tick(lua, 3);
  moveTo(lua, 11.5, 10.5);
  tick(lua, 2);
  order(lua, '2|MOVE|16|0|||');
  assert.equal(lua.run('return LocalSurvivor.skill and LocalSurvivor.skill.verb'), 'LOOT');
  assert.equal(lua.get('LocalSurvivor.hudData.thought'), 'Finishing the grab first.');
});

// ---------- ENTER ----------
// A building at x 30..34, y 10..14. The door is in the west wall at (30, 12): the square
// outside is (29, 12). A window in the north wall at (32, 10): outside is (32, 9).
function enterWorld(door = {}, win = null, at = [25.5, 12.5], keys = []) {
  return world(`
    P.keys = { ${keys.map((k) => `[${k}] = true`).join(', ')} }
    B = __makeBuilding({ id = "B2", x = 30, y = 10, x2 = 34, y2 = 14 })
    ROOM = __makeRoom({ name = "hall", x = 30, y = 10, x2 = 34, y2 = 14 })
    __floor(30, 10, 34, 14, { building = B, room = ROOM })
    __floor(24, 8, 29, 16, {})
    __floor(30, 8, 36, 9, {})
    __floor(35, 10, 36, 16, {})
    __floor(30, 15, 34, 16, {})
    local d = ${luaTable(door)}
    DOOR = {
      isExterior = function() return true end, getNorth = function() return false end,
      IsOpen = function() return d.open or false end, isLocked = function() return d.locked or false end,
      isLockedByKey = function() return d.locked or false end, isBarricaded = function() return d.barricaded or false end,
      checkKeyId = function() return d.keyId or -1 end,
    }
    __squares["30,12,0"].opts.door = DOOR
    ${win ? `
    local w = ${luaTable(win)}
    WIN = {
      isExterior = function() return true end, getNorth = function() return true end,
      IsOpen = function() return w.open or false end, isLocked = function() return w.locked or false end,
      isPermaLocked = function() return false end, isSmashed = function() return w.smashed or false end,
      isGlassRemoved = function() return false end, isBarricaded = function() return w.barricaded or false end,
    }
    __squares["32,10,0"].opts.window = WIN` : ''}
    __adjacent = function(sq)
      if sq:getX() == 30 and sq:getY() == 12 then return __squares["29,12,0"] end
      if sq:getX() == 32 and sq:getY() == 10 then return __squares["32,9,0"] end
      return nil
    end
    LocalSurvivor.Sense.memoFor(B)
  `, at[0], at[1]);
}
function luaTable(obj) {
  return '{ ' + Object.entries(obj).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ') + ' }';
}

test('ENTER walks to the door, opens it and walks in', () => {
  const lua = enterWorld();
  order(lua, '1|ENTER|0|0||||B2');
  tick(lua);
  assert.equal(walkTarget(lua), '29,12');
  moveTo(lua, 29.5, 12.5);
  tick(lua, 2);
  assert.deepEqual(queue(lua), ['ISOpenCloseDoor', 'ISWalkToTimedAction']);
  moveTo(lua, 30.5, 12.5);
  tick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'ENTER', status: 'done', why: 'in by a door' });
});

test('ENTER tries a window that opens when the door is locked', () => {
  const lua = enterWorld({ locked: true }, {});
  order(lua, '1|ENTER|0|0||||B2');
  tick(lua);
  moveTo(lua, 29.5, 12.5);
  tick(lua, 2); // arrive, try the door: locked, choose the window
  tick(lua);
  assert.equal(walkTarget(lua), '32,9');
  moveTo(lua, 32.5, 9.5);
  tick(lua, 2);
  assert.deepEqual(queue(lua), ['ISOpenCloseWindow', 'ISClimbThroughWindow']);
  moveTo(lua, 32.5, 10.5);
  tick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'ENTER', status: 'done', why: 'in through a window' });
});

test('ENTER unlocks a locked door with the key that fits, then walks in', () => {
  const lua = enterWorld({ locked: true, keyId: 7 }, {}, [25.5, 12.5], [7]);
  order(lua, '1|ENTER|0|0||||B2');
  tick(lua);
  moveTo(lua, 29.5, 12.5);
  tick(lua, 2);
  assert.deepEqual(queue(lua), ['ISLockDoor', 'ISOpenCloseDoor', 'ISWalkToTimedAction']);
  const unlock = lua.run('local a = ISTimedActionQueue.getTimedActionQueue(P).queue[1] return { door = a.args[2] == DOOR, lock = a.args[3] }');
  assert.deepEqual(unlock, { door: true, lock: false });
  moveTo(lua, 30.5, 12.5);
  tick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'ENTER', status: 'done', why: 'in by a door' });
});

test('ENTER goes for the door it has the key to even when a window is nearer', () => {
  const noKey = enterWorld({ locked: true, keyId: 7 }, {}, [32.5, 8.5]);
  order(noKey, '1|ENTER|0|0||||B2');
  tick(noKey);
  assert.equal(walkTarget(noKey), '32,9');
  const withKey = enterWorld({ locked: true, keyId: 7 }, {}, [32.5, 8.5], [7]);
  order(withKey, '1|ENTER|0|0||||B2');
  tick(withKey);
  assert.equal(walkTarget(withKey), '29,12');
});

test('ENTER with no key, or the wrong one, leaves a locked door and falls back to the window', () => {
  for (const keys of [[], [8]]) {
    const lua = enterWorld({ locked: true, keyId: 7 }, {}, [25.5, 12.5], keys);
    order(lua, '1|ENTER|0|0||||B2');
    tick(lua);
    moveTo(lua, 29.5, 12.5);
    tick(lua, 3);
    assert.equal(walkTarget(lua), '32,9');
    assert.equal(lua.run('return LocalSurvivor.skill.way.kind'), 'window');
    moveTo(lua, 32.5, 9.5);
    tick(lua, 2);
    assert.deepEqual(queue(lua), ['ISOpenCloseWindow', 'ISClimbThroughWindow']);
  }
});

test('ENTER smashes a window only when every quiet way is locked, and says it was loud', () => {
  const lua = enterWorld({ locked: true }, { locked: true });
  order(lua, '1|ENTER|0|0||||B2');
  tick(lua);
  moveTo(lua, 29.5, 12.5);
  tick(lua, 3);
  moveTo(lua, 32.5, 9.5);
  tick(lua, 2); // arrive at the window: locked, nothing quiet left, smash it
  tick(lua, 2);
  assert.deepEqual(queue(lua), ['ISSmashWindow', 'ISRemoveBrokenGlass', 'ISClimbThroughWindow']);
  moveTo(lua, 32.5, 10.5);
  tick(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'ENTER', status: 'done', why: 'in through a smashed window (loud)' });
});

test('ENTER fails locked when every way is locked or boarded', () => {
  const lua = enterWorld({ locked: true }, { barricaded: true });
  order(lua, '1|ENTER|0|0||||B2');
  tick(lua);
  moveTo(lua, 29.5, 12.5);
  tick(lua, 3);
  moveTo(lua, 32.5, 9.5);
  tick(lua, 3);
  assert.deepEqual(result(lua), { seq: 1, verb: 'ENTER', status: 'failed', why: 'locked' });
});

test('ENTER needs a building the percept listed', () => {
  const lua = enterWorld();
  order(lua, '1|ENTER|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'ENTER', status: 'failed', why: 'no target' });
  order(lua, '2|ENTER|0|0||||nope');
  assert.deepEqual(result(lua), { seq: 2, verb: 'ENTER', status: 'failed', why: 'unknown building' });
});

test('the tick loop drives a skill', () => {
  const lua = world('__floor(8, 8, 22, 12)');
  lua.run('__files["local_intent.txt"] = "1|GOTO|20|10|||"');
  for (let i = 0; i < 46; i++) lua.fireEvent('OnTick');
  assert.equal(result(lua).verb, 'GOTO');
  assert.deepEqual(queue(lua), ['ISWalkToTimedAction']);
  moveTo(lua, 19.5, 10.5);
  lua.fireEvent('OnTick');
  assert.deepEqual(result(lua), { seq: 1, verb: 'GOTO', status: 'done', why: 'arrived' });
});

test('a walk to the square by a window only arrives on that square, not the diagonal one', () => {
  const lua = createHarness();
  lua.autoload();
  lua.run(`
    for x = 8, 14 do for y = 8, 14 do __makeSquare({ x = x, y = y }) end end
    -- On square 10,10, a hair from the corner it shares with 11,11.
    __players[0] = __makePlayer({ x = 10.95, y = 10.95, live = true })
    S = { prog = {} }
  `);
  assert.equal(lua.run('return LocalSurvivor.Act.walkToSquare(__players[0], S, __squares["11,11,0"])'), 'walking');
  lua.run('__players[0].x, __players[0].y = 11.5, 11.5');
  assert.equal(lua.run('return LocalSurvivor.Act.walkToSquare(__players[0], S, __squares["11,11,0"])'), 'arrived');
});
