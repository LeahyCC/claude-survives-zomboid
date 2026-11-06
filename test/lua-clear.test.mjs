// CLEAR: walk next to the zombie in this house and kill it. Driven step by step with stub squares
// and stub zombies. The pathfinder and the swing never run here: a test moves her and ends a walk,
// and counts the attacks. Whether a real idle zombie stays put for it is a live-game check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

// A long room from x 5 to 20 on row 10 and 11, with her at (x, 10) holding a crowbar.
function house(setup = '', x = 6.5) {
  const lua = createHarness();
  lua.autoload();
  lua.run(`
    HOUSE = __makeBuilding({ id = "h1", x = 5, y = 10, x2 = 20, y2 = 11 })
    ROOM = __makeRoom({ name = "hall", squares = {} })
    for sx = 5, 20 do
      for sy = 10, 11 do
        __makeSquare({ x = sx, y = sy, building = HOUSE, room = ROOM })
      end
    end
    __players[0] = __makePlayer({ x = ${x}, y = 10.5, live = true })
    P = __players[0]
    P.primary = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, crit = 20, range = 1.25,
      swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
    ATTACKS, SHOVES = 0, 0
    P.DoAttack = function() ATTACKS = ATTACKS + 1 end
    P.setDoShove = function(_, on) if on then SHOVES = SHOVES + 1 end end
    function ZOMBIE(o) o.building = o.building or HOUSE; local z = __makeZombie(o); table.insert(__zombies, z); return z end
    ${setup}
  `);
  return lua;
}
const order = (lua) => lua.run('LocalSurvivor.Act.execIntent(P, "1|CLEAR|0|0|||")');
const step = (lua, acted = false) => lua.run('LocalSurvivor.tick = LocalSurvivor.tick + 5; LocalSurvivor.Needs.update(P, ...)', acted);
const res = (lua) => {
  const { status, why } = lua.get('LocalSurvivor.result');
  return { status, why };
};
const walkTarget = (lua) => lua.run(`
  local a = ISTimedActionQueue.getTimedActionQueue(P).queue[1]
  local sq = a and a.args[2]
  return sq and (sq:getX() .. "," .. sq:getY()) or nil
`);
// The walk ends where it was going, and the next step reads the world again.
const arrive = (lua) => {
  lua.run('__arrive(P)');
  step(lua);
};

const pick = (rows) => {
  const lua = createHarness();
  lua.requireModule('LocalSurvivor/Needs');
  return lua.callMulti('LocalSurvivor.Needs.clearPick', rows);
};
const row = (o) => ({ d: 5, inside: true, level: true, chase: false, ...o });

test('CLEAR is registered, and a running one counts as a long verb', () => {
  const lua = house();
  assert.equal(lua.run('return type(LocalSurvivor.verbs.CLEAR)'), 'function');
});

test('clearPick: the nearest on her floor, and a chaser before an idle one', () => {
  assert.deepEqual(pick([row({ d: 9 }), row({ d: 4 })]), ['go', 2]);
  assert.deepEqual(pick([row({ d: 4 }), row({ d: 9, chase: true })]), ['go', 2]);
});

test('clearPick: she stays with the one she is after, even when it turns on her', () => {
  assert.deepEqual(pick([row({ d: 2 }), row({ d: 8, current: true })]), ['go', 2]);
  assert.deepEqual(pick([row({ d: 2, current: true, chase: true })]), ['go', 1]);
});

test('clearPick: anyone else after her ends it, and so does an empty floor with one upstairs', () => {
  assert.deepEqual(pick([row({ current: true }), row({ chase: true })]), ['woke']);
  assert.deepEqual(pick([row({ current: true }), row({ inside: false, chase: true })]), ['woke']);
  assert.deepEqual(pick([row({ chase: true }), row({ chase: true })]), ['woke']);
  assert.deepEqual(pick([row({ level: false })]), ['floor']);
  assert.deepEqual(pick([row({ level: false, current: true })]), ['floor']);
  assert.deepEqual(pick([]), ['none']);
  assert.deepEqual(pick([row({ inside: false, chase: true })]), ['none']);
});

test('behindRank: a square behind a zombie ranks below one in front of it, and no facing is even', () => {
  const lua = createHarness();
  lua.requireModule('LocalSurvivor/Needs');
  assert.equal(lua.call('LocalSurvivor.Needs.behindRank', -1, 0, 1, 0), -1);
  assert.equal(lua.call('LocalSurvivor.Needs.behindRank', 1, 0, 1, 0), 1);
  assert.equal(lua.call('LocalSurvivor.Needs.behindRank', -1, 0, 0, 0), 0);
});

test('she walks to the square behind it, whichever way it faces, and the near side when that is not known', () => {
  const west = house('ZOMBIE({ x = 12.5, y = 10.5, fx = -1, fy = 0 })', 9.5);
  order(west);
  assert.equal(walkTarget(west), '13,10', 'it faces her, so behind is the far side');
  assert.equal(res(west).status, 'running');
  const east = house('ZOMBIE({ x = 12.5, y = 10.5, fx = 1, fy = 0 })', 9.5);
  order(east);
  assert.equal(walkTarget(east), '11,10', 'it faces away, so behind is this side');
  const unknown = house('ZOMBIE({ x = 12.5, y = 10.5 })', 9.5);
  order(unknown);
  assert.equal(walkTarget(unknown), '11,10');
});

test('a long walk goes in legs and stops to look again', () => {
  const lua = house('ZOMBIE({ x = 19.5, y = 10.5 })');
  order(lua);
  const first = walkTarget(lua);
  assert.equal(first, '12,10', 'one leg along the way');
  arrive(lua);
  assert.equal(walkTarget(lua), '18,10');
  assert.equal(res(lua).status, 'running');
});

test('next to it she swings, and it being on the floor makes the swing a stomp', () => {
  const lua = house('O = { x = 8, y = 10.5 }; ZOMBIE(O)');
  order(lua);
  assert.equal(lua.get('ATTACKS'), 1);
  assert.equal(lua.get('SHOVES'), 0);
  assert.deepEqual(lua.run('return #ISTimedActionQueue.getTimedActionQueue(P).queue'), 0);
  lua.run('O.floor = true');
  step(lua);
  assert.equal(lua.get('ATTACKS'), 2);
  assert.equal(lua.get('SHOVES'), 1);
});

test('with it dead she is done, cleared', () => {
  const lua = house('O = { x = 8, y = 10.5 }; ZOMBIE(O)');
  order(lua);
  lua.run('O.dead = true');
  step(lua);
  assert.deepEqual(res(lua), { status: 'done', why: 'cleared' });
  assert.equal(lua.get('LocalSurvivor.result.target'), 'h1');
  assert.equal(lua.run('return LocalSurvivor.needsJob'), false);
});

test('nobody in the house is done at once, and says so', () => {
  const lua = house('ZOMBIE({ x = 8, y = 10.5, building = {} })');
  order(lua);
  assert.deepEqual(res(lua), { status: 'done', why: 'nobody inside' });
});

test('the reflex acting pauses the walk, and a long fight is not a failure', () => {
  const lua = house('ZOMBIE({ x = 12.5, y = 10.5, target = P })');
  order(lua);
  assert.equal(walkTarget(lua), undefined, 'it is coming to her: she does not walk into it');
  for (let i = 0; i < 300; i++) step(lua, true);
  step(lua);
  assert.equal(res(lua).status, 'running', '25 seconds of fighting, past the usual 20 second pause limit');
  for (let i = 0; i < 500; i++) step(lua, true);
  step(lua);
  assert.deepEqual(res(lua), { status: 'failed', why: 'zombie' });
});

test('fails: on another floor', () => {
  const lua = house('ZOMBIE({ x = 12.5, y = 10.5, z = 1 })');
  order(lua);
  assert.deepEqual(res(lua), { status: 'failed', why: 'another floor' });
});

test('fails: a second one wakes while she is after the first', () => {
  const lua = house('ZOMBIE({ x = 12.5, y = 10.5 }); O = { x = 15.5, y = 10.5 }; ZOMBIE(O)');
  order(lua);
  assert.equal(res(lua).status, 'running');
  lua.run('O.target = P');
  arrive(lua);
  assert.deepEqual(res(lua), { status: 'failed', why: 'a second one woke' });
});

test('fails: one from outside comes for her, but not one far off', () => {
  const lua = house('ZOMBIE({ x = 12.5, y = 10.5 }); O = { x = 16.5, y = 10.5, building = {} }; ZOMBIE(O)');
  order(lua);
  lua.run('O.target = P; O.x = 200');
  arrive(lua);
  assert.equal(res(lua).status, 'running');
  lua.run('O.x = 16.5');
  arrive(lua);
  assert.deepEqual(res(lua), { status: 'failed', why: 'a second one woke' });
});

// A wall across the room at x 10, whole or with a door in it on row 10. She is west of it.
const WALLED = (door) => `
  for _, y in ipairs({ 10, 11 }) do
    local sq = __squares["10," .. y .. ",0"]
    if ${door ? 'y == 10' : 'false'} then
      sq.opts.doorsTo = { ["11," .. y] = true }
      sq.opts.doorObjs = { ["11," .. y] = DOOR }
    else
      sq.opts.walls = { ["11," .. y] = true }
    end
  end
  ZOMBIE({ x = 14.5, y = 10.5 })
`;
const door = (locked) => `DOOR = {
  isBarricaded = function() return false end, IsOpen = function() return false end,
  isLocked = function() return ${locked} end, isLockedByKey = function() return false end,
};`;

test('fails: behind a wall with no way round', () => {
  const lua = house(WALLED(false));
  order(lua);
  assert.deepEqual(res(lua), { status: 'failed', why: 'out of reach' });
});

test('fails: behind a locked door. An unlocked one is walked through', () => {
  const locked = house(door(true) + WALLED(true));
  order(locked);
  assert.deepEqual(res(locked), { status: 'failed', why: 'locked door' });
  const open = house(door(false) + WALLED(true));
  order(open);
  assert.equal(res(open).status, 'running');
  assert.ok(walkTarget(open));
});

test('fails: out of the house, and with no weapon in her hand', () => {
  const out = house('ZOMBIE({ x = 12.5, y = 10.5 })');
  order(out);
  out.run('__makeSquare({ x = 4, y = 10 }); P.x = 4.5; ISTimedActionQueue.clear(P)');
  step(out);
  assert.deepEqual(res(out), { status: 'failed', why: 'not inside' });

  const outdoors = house('__makeSquare({ x = 2, y = 10 }); P.x = 2.5');
  order(outdoors);
  assert.deepEqual(res(outdoors), { status: 'failed', why: 'not inside' });

  const bare = house('P.primary = nil; ZOMBIE({ x = 12.5, y = 10.5 })');
  order(bare);
  assert.deepEqual(res(bare), { status: 'failed', why: 'no weapon' });
});

test('fails: a walk that never lands, and an order that runs too long', () => {
  const lua = house('ZOMBIE({ x = 12.5, y = 10.5 })');
  order(lua);
  for (let i = 0; i < 40 && res(lua).status === 'running'; i++) {
    lua.run('ISTimedActionQueue.clear(P)');
    step(lua);
  }
  assert.deepEqual(res(lua), { status: 'failed', why: 'stuck' });

  const slow = house('ZOMBIE({ x = 12.5, y = 10.5 })');
  order(slow);
  slow.run('LocalSurvivor.needsJob.startTick = LocalSurvivor.tick - LocalSurvivor.Needs.N.CLEAR_MAX - 1; ISTimedActionQueue.clear(P)');
  step(slow);
  assert.deepEqual(res(slow), { status: 'failed', why: 'took too long' });
});
