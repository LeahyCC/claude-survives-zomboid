// Night fast forward (Reflex.manageSpeed and friends). The clock goes to speed 3 only while she
// waits safely indoors at night, and anything that could queue a walk slows it first, because
// the vanilla walk action is invalid above speed 2. Whether the game really honours speed 3
// is a live check, see docs/playtest.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

// Night, inside a building, a WAIT order running, nothing near. Every test starts from here and
// breaks one thing.
function house(setup = '') {
  const lua = createHarness();
  lua.autoload();
  lua.run(`
    for x = 8, 14 do
      for y = 8, 14 do __makeSquare({ x = x, y = y, building = {} }) end
    end
    __players[0] = __makePlayer({ x = 10.5, y = 10.5, live = true, opts = nil })
    P = __players[0]
    function P:isOutside() return false end
    __time.hour = 23
    __speed = 1
    LocalSurvivor.tick = 1000
    LocalSurvivor.lastSeq = 0
    LocalSurvivor.setResult(1, "WAIT", "running", "")
    ${setup}
  `);
  return lua;
}

const manage = (lua) => lua.run('LocalSurvivor.Reflex.manageSpeed(P)');
const speed = (lua) => lua.run('return getGameSpeed()');
const order = (lua, line) => lua.run(`LocalSurvivor.Act.execIntent(P, "${line}")`);
const zombieAt = (x, y, extra = '') => `table.insert(__zombies, __makeZombie({ x = ${x}, y = ${y}${extra} }))`;

test('night, indoors, waiting, nothing near: speed 3', () => {
  const lua = house();
  manage(lua);
  assert.equal(speed(lua), 3);
  assert.equal(lua.run('return __time.mult'), 20);
});

test('REST and SLEEP orders count as calm too', () => {
  for (const verb of ['REST', 'SLEEP']) {
    const lua = house(`LocalSurvivor.setResult(2, "${verb}", "running", "")`);
    manage(lua);
    assert.equal(speed(lua), 3, verb);
  }
});

test('a REST sitting in place keeps the fast clock', () => {
  const lua = house(`LocalSurvivor.setResult(2, "REST", "running", ""); ISTimedActionQueue.add(ISSitOnGround:new(P))`);
  manage(lua);
  assert.equal(speed(lua), 3);
});

test('asleep counts as calm whatever the last order was', () => {
  const lua = house(`LocalSurvivor.setResult(2, "EAT", "done", ""); P.asleep = true`);
  manage(lua);
  assert.equal(speed(lua), 3);
});

test('asleep outside is not fast forwarded by the mod', () => {
  const lua = house('P.asleep = true; function P:isOutside() return true end');
  manage(lua);
  assert.equal(speed(lua), 2);
});

test('daylight keeps today\'s rule: speed 2 with room, 1 near a zombie', () => {
  const lua = house('__time.hour = 12');
  manage(lua);
  assert.equal(speed(lua), 2);
  lua.run(zombieAt(30, 10));
  manage(lua);
  assert.equal(speed(lua), 1);
});

test('the night hours match the bridge: 21:00 up to 06:00', () => {
  const at = (hour) => {
    const lua = house(`__time.hour = ${hour}`);
    manage(lua);
    return speed(lua);
  };
  assert.equal(at(20), 2);
  assert.equal(at(21), 3);
  assert.equal(at(3), 3);
  assert.equal(at(5), 3);
  assert.equal(at(6), 2);
});

// One condition broken each time. None may reach speed 3, and each falls back to today's rule.
const BROKEN = {
  outside: ['function P:isOutside() return true end', 2],
  'no building under her': ['__squares["10,10,0"].opts.building = nil', 2],
  'a zombie 6 tiles away': [zombieAt(16, 10), 1],
  'a zombie 8 tiles away': [zombieAt(18, 10), 1],
  'a zombie in sight': ['P.getStats = function() return { get = function() return 0 end, getNumChasingZombies = function() return 0 end, getNumVisibleZombies = function() return 1 end } end', 2],
  'a chaser far away': ['P.getStats = function() return { get = function() return 0 end, getNumChasingZombies = function() return 1 end } end', 2],
  bleeding: ['P.bleeding = 1', 2],
  'last order was MOVE': ['LocalSurvivor.setResult(2, "MOVE", "running", "")', 2],
  'last order was GOTO': ['LocalSurvivor.setResult(2, "GOTO", "running", "")', 2],
  'a skill running': ['LocalSurvivor.skill = { verb = "SEARCH" }', 2],
  'a walk queued': ['ISTimedActionQueue.add(ISWalkToTimedAction:new(P, __squares["12,10,0"]))', 2],
  'momentum walking': ['LocalSurvivor.travel.active = true', 2],
  'a needs job walking': ['LocalSurvivor.needsJob = { verb = "SECURE" }', 2],
  'a SLEEP job not asleep yet': ['LocalSurvivor.needsJob = { verb = "SLEEP", phase = "walk" }', 2],
  'manual mode': ['LocalSurvivor.manualMode = true', 1],
  'the switch off': ['LocalSurvivor.nightFast = false', 2],
};
for (const [name, [setup, expected]] of Object.entries(BROKEN)) {
  test(`no fast forward with ${name}`, () => {
    const lua = house(setup);
    manage(lua);
    assert.equal(speed(lua), expected);
  });
}

test('the guard snaps back to 1 when a zombie comes within 8 tiles', () => {
  const lua = house();
  manage(lua);
  assert.equal(speed(lua), 3);
  lua.run(zombieAt(16, 10));
  lua.run('LocalSurvivor.Reflex.guardSpeed(P)');
  assert.equal(speed(lua), 1);
});

test('a zombie 25 tiles off does not stop the fast forward', () => {
  const lua = house(zombieAt(35, 10));
  manage(lua);
  assert.equal(speed(lua), 3);
});

test('a chaser snaps the clock back', () => {
  const lua = house();
  manage(lua);
  lua.run('P.getStats = function() return { get = function() return 0 end, getNumChasingZombies = function() return 1 end } end');
  lua.run('LocalSurvivor.Reflex.guardSpeed(P)');
  assert.equal(speed(lua), 2);
});

test('opening a wound snaps the clock back', () => {
  const lua = house();
  manage(lua);
  lua.run('P.bleeding = 1; LocalSurvivor.Reflex.guardSpeed(P)');
  assert.equal(speed(lua), 2);
});

test('the fast forward waits out a cool down after a snap back', () => {
  const lua = house(zombieAt(16, 10));
  lua.run('__speed = 3');
  lua.run('LocalSurvivor.Reflex.guardSpeed(P)');
  assert.equal(speed(lua), 1);
  // The zombie leaves, but the fast forward waits out its cool down before coming back.
  lua.run('__zombies = {}');
  manage(lua);
  assert.equal(speed(lua), 2);
  lua.run('LocalSurvivor.tick = LocalSurvivor.tick + LocalSurvivor.Core.FAST_COOL + 1');
  manage(lua);
  assert.equal(speed(lua), 3);
});

test('the guard does nothing at normal speed and never raises it', () => {
  const lua = house();
  lua.run('LocalSurvivor.Reflex.guardSpeed(P)');
  assert.equal(speed(lua), 1);
});

test('a hit snaps back to 1 on the same tick', () => {
  const lua = house();
  manage(lua);
  assert.equal(speed(lua), 3);
  lua.run('LocalSurvivor.Reflex.watchHealth(P)');
  assert.equal(speed(lua), 3);
  lua.run('P.hp = 90; LocalSurvivor.Reflex.watchHealth(P)');
  assert.equal(speed(lua), 1);
});

test('a slow loss of health is not a hit', () => {
  const lua = house();
  manage(lua);
  lua.run('LocalSurvivor.Reflex.watchHealth(P); P.hp = 99.9; LocalSurvivor.Reflex.watchHealth(P)');
  assert.equal(speed(lua), 3);
});

test('a new order that is not WAIT, REST or SLEEP snaps back before it runs', () => {
  for (const verb of ['MOVE|5|5', 'GOTO|0|0', 'ENTER|0|0', 'SEARCH|0|0', 'EAT|0|0', 'LOOT|0|0', 'STOP|0|0', 'SECURE|0|0']) {
    const lua = house();
    manage(lua);
    assert.equal(speed(lua), 3);
    // The walk a verb queues has to see a speed it is valid at.
    lua.run(`
      seen = nil
      local walk = ISWalkToTimedAction.new
      ISWalkToTimedAction.new = function(...) seen = seen or getGameSpeed(); return walk(...) end
    `);
    order(lua, `5|${verb}|||`);
    assert.ok(speed(lua) <= 2, verb);
    const seen = lua.run('return seen');
    assert.ok(seen == null || seen <= 2, `${verb} queued a walk at speed ${seen}`);
  }
});

test('a MOVE order is never left above speed 2, even with the player\'s speed at 4', () => {
  const lua = house('__speed = 4');
  order(lua, '5|MOVE|6|0||');
  assert.ok(speed(lua) <= 2);
});

test('WAIT and REST orders keep the fast clock', () => {
  for (const verb of ['WAIT', 'REST']) {
    const lua = house();
    manage(lua);
    order(lua, `5|${verb}|0|0||`);
    assert.equal(speed(lua), 3, verb);
  }
});

test('a SLEEP order keeps the clock only once she is asleep', () => {
  const lua = house('P.asleep = true');
  manage(lua);
  order(lua, '5|SLEEP|0|0||');
  assert.equal(speed(lua), 3);
  const awake = house();
  manage(awake);
  order(awake, '5|SLEEP|0|0||');
  assert.ok(speed(awake) <= 2);
});

test('a reflex action slows the clock', () => {
  const lua = house();
  manage(lua);
  lua.run(`
    local a = { kind = "backoff", why = "spacing", dx = 1, dy = 0 }
    LocalSurvivor.Reflex.perform(P, a, { zombies = {} }, {})
  `);
  assert.ok(speed(lua) <= 2);
});

test('a walk started by the mod slows the clock', () => {
  const lua = house();
  manage(lua);
  lua.run('LocalSurvivor.Move.doMove(P, 4, 0)');
  assert.ok(speed(lua) <= 2);
});

test('a movement key (manual mode) slows the clock', () => {
  const lua = house();
  manage(lua);
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_W)');
  assert.ok(speed(lua) <= 2);
  assert.equal(lua.get('LocalSurvivor.manualMode'), true);
});

test('K flips the switch, and turning it off slows a fast clock', () => {
  const lua = house();
  manage(lua);
  assert.equal(lua.get('LocalSurvivor.nightFast'), true);
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_K)');
  assert.equal(lua.get('LocalSurvivor.nightFast'), false);
  assert.ok(speed(lua) <= 2);
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_K)');
  assert.equal(lua.get('LocalSurvivor.nightFast'), true);
});

test('a manual pause always wins', () => {
  const lua = house('__speed = 0');
  manage(lua);
  assert.equal(speed(lua), 0);
  lua.run('LocalSurvivor.Reflex.guardSpeed(P); LocalSurvivor.Reflex.watchHealth(P); P.hp = 50; LocalSurvivor.Reflex.watchHealth(P)');
  assert.equal(speed(lua), 0);
  order(lua, '5|MOVE|6|0||');
  assert.equal(speed(lua), 0);
});

test('the G toggle wins: with auto speed off nothing touches the clock', () => {
  const lua = house('LocalSurvivor.autoSpeed = false; __speed = 4');
  manage(lua);
  assert.equal(speed(lua), 4);
  lua.run('P.hp = 50; LocalSurvivor.Reflex.watchHealth(P)');
  order(lua, '5|MOVE|6|0||');
  assert.equal(speed(lua), 4);
  // G itself still resets to normal when it turns auto speed off.
  lua.run('LocalSurvivor.autoSpeed = true; LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_G)');
  assert.equal(speed(lua), 1);
});

test('the percept reports the speed', () => {
  const lua = house();
  manage(lua);
  const percept = JSON.parse(lua.run('return LocalSurvivor.Sense.buildPercept(P)'));
  assert.equal(percept.speed, 3);
  lua.run('__speed = 1');
  assert.equal(JSON.parse(lua.run('return LocalSurvivor.Sense.buildPercept(P)')).speed, 1);
});

test('pickSpeed is pure: the same facts give the same answer', () => {
  const facts = { nightFast: true, night: true, inside: true, calm: true, nd: 9999 };
  assert.equal(lua().call('LocalSurvivor.Reflex.pickSpeed', facts), 3);
  assert.equal(lua().call('LocalSurvivor.Reflex.pickSpeed', { ...facts, nd: 8 }), 1);
  assert.equal(lua().call('LocalSurvivor.Reflex.pickSpeed', { ...facts, nd: 9 }), 3);
  assert.equal(lua().call('LocalSurvivor.Reflex.pickSpeed', { ...facts, seen: true }), 2);
  assert.equal(lua().call('LocalSurvivor.Reflex.pickSpeed', { ...facts, manual: true }), 1);
});

function lua() {
  const l = createHarness();
  l.autoload();
  return l;
}

test('a zombie 15 tiles off outside the house no longer stops the night fast forward', () => {
  const lua = house(zombieAt(25, 10));
  manage(lua);
  assert.equal(speed(lua), 3);
});
