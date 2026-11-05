// The death record: the ring of the last 10 seconds, the record written when player 0 dies, and the
// final percept that carries it. What the game returns for the stat reads can only be checked live
// (docs/percept.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function body() {
  const lua = createHarness();
  lua.autoload();
  return lua;
}

// A living player with a zombie close by. Everything but the position is the default stub.
function player(lua, extra = '') {
  lua.run(`
    __zombies = { __makeZombie({ x = 12, y = 10, target = nil }) }
    __players[0] = __makePlayer({ x = 10, y = 10, hours = 40.5, kills = 7,
      stats = { HUNGER = 0.31, THIRST = 0.97, SICKNESS = 0.2, TEMPERATURE = 36.6 },
      parts = { __makeBodyPart({ type = "Hand_L", bitten = true, bleeding = true }) } })
    local p = __players[0]
    p.hp = 63.5
    p.bleeding = 1
    ${extra}
  `);
}

test('reflexMode groups the fight and the flight, and forgets an old action', () => {
  const lua = body();
  const mode = (kind, age) => lua.call('LocalSurvivor.Death.reflexMode', kind, age);
  assert.equal(mode('swing', 10), 'fight');
  assert.equal(mode('stomp', 10), 'fight');
  assert.equal(mode('flee', 10), 'flee');
  assert.equal(mode('backoff', 10), 'flee');
  assert.equal(mode('hold', 10), 'hold');
  // The stances added with the threat assessment (docs/combat.md).
  assert.equal(mode('break', 10), 'flee');
  assert.equal(mode('climb', 10), 'flee');
  assert.equal(mode('wait', 10), 'flee');
  assert.equal(mode('hide', 10), 'hide');
  assert.equal(mode('sneak', 10), 'hide');
  assert.equal(mode('swing', 500), 'none');
  assert.equal(mode(null, 0), 'none');
});

test('the ring keeps the newest 10 samples', () => {
  const lua = body();
  const ring = lua.run(`
    local D = LocalSurvivor.Death
    local ring = {}
    for i = 1, 14 do D.push(ring, D.makeSample({ hp = i })) end
    return ring`);
  assert.equal(ring.length, 10);
  assert.equal(ring[0].hp, 5);
  assert.equal(ring[9].hp, 14);
});

test('makeSample drops what the game did not give', () => {
  const lua = body();
  const s = lua.call('LocalSurvivor.Death.makeSample', { hp: 41.26, bleeding: 2, bite: false, job: 'ENTER' });
  assert.deepEqual(s, { hp: 41.3, bleeding: 2, bite: false, job: 'ENTER' });
});

test('gather reads vitals, wounds, zombies, job and reflex from the live game', () => {
  const lua = body();
  player(lua);
  lua.run(`
    LocalSurvivor.tick = 1000
    LocalSurvivor.skill = { verb = "ENTER" }
    LocalSurvivor.setResult(9, "ENTER", "running", "", "B7")
    LocalSurvivor.reflexKind, LocalSurvivor.reflexKindTick = "flee", 990
    LocalSurvivor.reflexStance, LocalSurvivor.reflexStanceTick = "BREAK", 990
    __players[0].infected = true`);
  const s = lua.run('return LocalSurvivor.Death.gather(__players[0])');
  assert.equal(s.hp, 63.5);
  assert.equal(s.thirst, 0.97);
  assert.equal(s.hunger, 0.31);
  assert.equal(s.sick, 0.2);
  assert.equal(s.temp, 36.6);
  assert.equal(s.infected, true);
  assert.equal(s.bleeding, 1);
  assert.equal(s.bite, true);
  assert.equal(s.wounds, 1);
  assert.equal(s.zClose, 1);
  assert.equal(s.zAdj, 1);
  assert.equal(s.nearest, 2);
  assert.equal(s.job, 'ENTER');
  assert.equal(s.order, 'ENTER');
  assert.equal(s.status, 'running');
  assert.equal(s.reflex, 'flee');
  assert.equal(s.stance, 'BREAK');
  lua.run('LocalSurvivor.tick = 1500');
  assert.equal(lua.run('return LocalSurvivor.Death.gather(__players[0])').stance, undefined, 'an old stance is left out');
});

test('writePercept adds one sample a second while she lives, and none once she is dead', () => {
  const lua = body();
  player(lua);
  for (let i = 0; i < 13; i++) lua.run('LocalSurvivor.Sense.writePercept(__players[0])');
  assert.equal(lua.run('return #LocalSurvivor.deathRing'), 10);
  lua.run('__players[0].dead = true; LocalSurvivor.Sense.writePercept(__players[0])');
  assert.equal(lua.run('return #LocalSurvivor.deathRing'), 10);
});

test('the Reflex records what it did, for the fight or flight reading', () => {
  const lua = body();
  player(lua);
  lua.run(`
    LocalSurvivor.tick = 500
    LocalSurvivor.Reflex.perform(__players[0], { kind = "none" }, { zombies = {} }, {})`);
  assert.equal(lua.run('return LocalSurvivor.reflexKind') ?? null, null);
  lua.run(`
    pcall(LocalSurvivor.Reflex.perform, __players[0], { kind = "backoff", why = "x" }, { zombies = {} }, {})`);
  assert.equal(lua.get('LocalSurvivor.reflexKind'), 'backoff');
  assert.equal(lua.get('LocalSurvivor.reflexKindTick'), 500);
});

test('death writes the record file and a final percept that carries it', () => {
  const lua = body();
  player(lua);
  lua.run(`
    LocalSurvivor.skill = { verb = "SEARCH" }
    LocalSurvivor.tick = 2000
    LocalSurvivor.Sense.writePercept(__players[0])
    LocalSurvivor.Sense.writePercept(__players[0])
    __players[0].hp = 0
    __players[0].dead = true
    LocalSurvivor.Death.onEvent(__players[0])`);
  const file = JSON.parse(lua.run('return __files["local_death.txt"]'));
  assert.equal(file.hours, 40.5);
  assert.equal(file.kills, 7);
  assert.equal(file.text, 'You died: stub');
  assert.equal(file.ring.length, 2);
  assert.equal(file.ring[0].job, 'SEARCH');
  assert.equal(file.final.hp, 0);
  assert.equal(file.final.zAdj, 1);
  const percept = JSON.parse(lua.run('return __files["local_percept.txt"]'));
  assert.equal(percept.dead, true);
  assert.deepEqual(percept.death, file);
});

test('a second death call changes nothing, and a new character resets the ring', () => {
  const lua = body();
  player(lua);
  lua.run(`
    LocalSurvivor.Sense.writePercept(__players[0])
    __players[0].dead = true
    LocalSurvivor.Death.onDeath(__players[0])`);
  const first = lua.run('return __files["local_death.txt"]');
  lua.run('LocalSurvivor.tick = LocalSurvivor.tick + 5; LocalSurvivor.Death.onDeath(__players[0])');
  assert.equal(lua.run('return __files["local_death.txt"]'), first);
  // The tick loop sees a living player 0 a few seconds later.
  lua.run('__players[0].dead = false; LocalSurvivor.tick = LocalSurvivor.tick + 400');
  lua.fireEvent('OnTick');
  assert.equal(lua.get('LocalSurvivor.deathDone'), false);
  assert.equal(lua.run('return #LocalSurvivor.deathRing'), 0);
  assert.equal(lua.run('return LocalSurvivor.deathRecord') ?? null, null);
});

test('the tick loop writes the record when the death event never came', () => {
  const lua = body();
  player(lua);
  lua.run('__players[0].dead = true');
  lua.fireEvent('OnTick');
  assert.ok(lua.run('return __files["local_death.txt"]'));
  assert.equal(JSON.parse(lua.run('return __files["local_percept.txt"]')).dead, true);
});

test('only player 0 counts for the death event', () => {
  const lua = body();
  player(lua);
  lua.run(`
    local other = __makePlayer({})
    function other:getPlayerNum() return 1 end
    other.dead = true
    LocalSurvivor.Death.onEvent(other)`);
  assert.equal(lua.get('LocalSurvivor.deathDone'), false);
  assert.equal(lua.eventCount('OnPlayerDeath'), 1);
});

test('the dead percept stays small', () => {
  const lua = body();
  player(lua);
  for (let i = 0; i < 12; i++) lua.run('LocalSurvivor.Sense.writePercept(__players[0])');
  lua.run('__players[0].dead = true; LocalSurvivor.Death.onDeath(__players[0])');
  const size = lua.run('return #__files["local_death.txt"]');
  assert.ok(size < 4500, `death record is ${size} bytes`);
});
