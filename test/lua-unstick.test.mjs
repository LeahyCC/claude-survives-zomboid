// Reflex.releaseDoor, the helper that gets him off a door a walk is stuck on. It must only act on
// a stuck walk, never cut a long action done in place, and never unlock anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function world(setup = '') {
  const lua = createHarness();
  lua.autoload();
  lua.run(`
    for x = 8, 14 do
      for y = 8, 14 do __makeSquare({ x = x, y = y }) end
    end
    __players[0] = __makePlayer({ x = 10.5, y = 10.5, live = true })
    P = __players[0]
    ${setup}
  `);
  return lua;
}

// One call per tick, the way the entry file makes it.
const run = (lua, n) =>
  lua.run(`for i = 1, ${n} do LocalSurvivor.tick = LocalSurvivor.tick + 1; LocalSurvivor.Reflex.releaseDoor(P) end`);
const queue = (lua) => lua.run('return __queueTypes(P)');
const fires = (lua) => lua.get('LocalSurvivor.reflexState.unstickUntil') > 0;

for (const action of ['ISInventoryTransferAction', 'ISEatFoodAction', 'ISSmashWindow', 'ISApplyBandage']) {
  test(`a long ${action} in place is not cleared after 90 ticks`, () => {
    const lua = world(`ISTimedActionQueue.add(${action}:new(P))`);
    run(lua, 600);
    assert.deepEqual(queue(lua), [action]);
    assert.equal(fires(lua), false);
  });
}

test('a long action queued behind nothing but itself stays, even with a walk after it', () => {
  const lua = world('ISTimedActionQueue.add(ISEatFoodAction:new(P)); ISTimedActionQueue.add(ISWalkToTimedAction:new(P, __squares["12,10,0"]))');
  run(lua, 300);
  assert.deepEqual(queue(lua), ['ISEatFoodAction', 'ISWalkToTimedAction']);
  assert.equal(fires(lua), false);
});

test('a stuck walk is released after 90 ticks of standing still', () => {
  const lua = world('ISTimedActionQueue.add(ISWalkToTimedAction:new(P, __squares["13,10,0"]))');
  run(lua, 90);
  assert.equal(fires(lua), false);
  run(lua, 2);
  assert.equal(fires(lua), true);
  // The stuck walk is replaced by a one-tile step.
  assert.deepEqual(queue(lua), ['ISWalkToTimedAction']);
  assert.equal(lua.run('local a = ISTimedActionQueue.getTimedActionQueue(P).queue[1] return a.args[2] == __squares["13,10,0"]'), false);
});

test('a stuck pathfind is released too', () => {
  const lua = world('ISTimedActionQueue.add(ISPathFindAction:pathToNearest(P, { 20.5, 10.5, 0 }))');
  run(lua, 92);
  assert.equal(fires(lua), true);
});

test('a walk that is moving is left alone', () => {
  const lua = world('ISTimedActionQueue.add(ISWalkToTimedAction:new(P, __squares["13,10,0"]))');
  for (let i = 0; i < 6; i++) {
    lua.run(`P.x = P.x + 0.5`);
    run(lua, 30);
  }
  assert.equal(fires(lua), false);
});

test('the stuck clock restarts when a walk follows a long action', () => {
  const lua = world('ISTimedActionQueue.add(ISEatFoodAction:new(P))');
  run(lua, 300);
  lua.run('ISTimedActionQueue.clear(P); ISTimedActionQueue.add(ISWalkToTimedAction:new(P, __squares["13,10,0"]))');
  run(lua, 60);
  assert.equal(fires(lua), false);
  run(lua, 40);
  assert.equal(fires(lua), true);
});

// Every neighbour is blocked, so the helper falls back to touching the doors around him.
const BOXED = `
  for _, d in ipairs({ { 11, 10 }, { 9, 10 }, { 10, 11 }, { 10, 9 } }) do __squares[d[1] .. "," .. d[2] .. ",0"].opts.blocked = true end
  CALLS = {}
  local function door(name, locked, open)
    return {
      __class = "IsoDoor",
      isLocked = function() return locked end, isLockedByKey = function() return false end,
      IsOpen = function() return open end,
      setLocked = function(_, v) table.insert(CALLS, name .. ":setLocked") end,
      setLockedByKey = function(_, v) table.insert(CALLS, name .. ":setLockedByKey") end,
      ToggleDoor = function() table.insert(CALLS, name .. ":toggle") end,
    }
  end
  __squares["11,10,0"].objects = { door("locked", true, false) }
  __squares["9,10,0"].objects = { door("shut", false, false) }
  ISTimedActionQueue.add(ISWalkToTimedAction:new(P, __squares["13,10,0"]))
`;

test('no door is ever unlocked by the unstick, and a shut unlocked one is opened', () => {
  const lua = world(BOXED);
  run(lua, 92);
  assert.equal(fires(lua), true);
  const calls = lua.run('return CALLS');
  assert.deepEqual(calls, ['shut:toggle']);
});
