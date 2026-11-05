// The fight brain (Reflex.decide) on plain snapshots, and a few ticks of the game-facing side
// with stub zombies. Whether a stomp really lands is a live-game check, see docs/combat.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();

// A zombie at distance d straight east, chasing unless told otherwise.
const zed = (d, extra = {}) => ({ d, dx: d, dy: 0, down: false, crawl: false, chase: true, outside: false, ...extra });
const fit = { armed: true, reach: 1.5, shortBlade: false, hp: 100, endurance: 1, panic: 0, heavy: 0, tired: 0, inside: false };
const decide = (snap) => lua.call('LocalSurvivor.Reflex.decide', { ...fit, ...snap });

test('one standing zombie in reach: swing', () => {
  assert.deepEqual(decide({ zombies: [zed(1.2)] }), { kind: 'swing', index: 1 });
});

test('a downed zombie next to him and nothing standing within 2.5: stomp', () => {
  const a = decide({ zombies: [zed(0.8, { down: true }), zed(4)] });
  assert.equal(a.kind, 'stomp');
  assert.equal(a.index, 1);
});

test('a crawler counts as down', () => {
  assert.equal(decide({ zombies: [zed(0.9, { crawl: true })] }).kind, 'stomp');
});

test('a downed zombie with a standing one close: fight the standing one', () => {
  const a = decide({ zombies: [zed(0.8, { down: true }), zed(1.3)] });
  assert.equal(a.kind, 'swing');
  assert.equal(a.index, 2);
});

test('a downed zombie a few tiles off: walk over to it', () => {
  assert.deepEqual(decide({ zombies: [zed(3, { down: true })] }), { kind: 'close', index: 1, why: 'down' });
});

test('two standing within 2 tiles and low endurance: back off, away from them', () => {
  const a = decide({ endurance: 0.2, zombies: [zed(1.5), zed(1.8, { dx: 1.2, dy: 1.34 })] });
  assert.ok(['backoff', 'flee'].includes(a.kind), a.kind);
  assert.ok(a.dx < 0, 'heads west, away from both');
});

test('two standing within 2 tiles at full strength: step back first', () => {
  const a = decide({ zombies: [zed(1.4), zed(1.9, { dx: 0, dy: 1.9 })] });
  assert.equal(a.kind, 'backoff');
  assert.equal(a.why, 'spacing');
  assert.ok(a.dx < 0 && a.dy < 0);
});

test('two standing within 2 and one right on him: shove it first', () => {
  assert.equal(decide({ zombies: [zed(0.9), zed(1.8)] }).kind, 'shove');
});

test('three within 7: flee', () => {
  const a = decide({ zombies: [zed(3), zed(5), zed(6.5)] });
  assert.equal(a.kind, 'flee');
  assert.equal(a.why, 'pack');
  assert.ok(a.dx < 0);
});

test('an unaware zombie at 9 tiles: nothing, sneaking handles it', () => {
  assert.deepEqual(decide({ zombies: [zed(9, { chase: false })] }), { kind: 'none' });
});

test('an unaware zombie close by is still dealt with', () => {
  assert.equal(decide({ zombies: [zed(1.4, { chase: false })] }).kind, 'swing');
});

test('an unaware zombie nearer than a chasing one does not hide the chaser', () => {
  assert.deepEqual(decide({ zombies: [zed(3, { chase: false }), zed(5)] }), { kind: 'close', index: 2 });
});

test('an unaware zombie in the way of the walk is dealt with', () => {
  assert.equal(decide({ heading: { dx: 8, dy: 0 }, zombies: [zed(3.5, { chase: false })] }).kind, 'close');
  assert.equal(decide({ heading: { dx: -8, dy: 0 }, zombies: [zed(3.5, { chase: false })] }).kind, 'none');
});

test('endurance under 0.3 with one chasing: back off', () => {
  const a = decide({ endurance: 0.25, zombies: [zed(3)] });
  assert.equal(a.kind, 'backoff');
  assert.equal(a.why, 'winded');
  assert.equal(a.dx, -1);
  assert.equal(Math.abs(a.dy), 0);
});

test('every gate backs off, and a cornered gate shoves', () => {
  for (const [field, value, why] of [['panic', 3, 'panic'], ['heavy', 2, 'heavy'], ['tired', 3, 'tired']]) {
    const a = decide({ [field]: value, zombies: [zed(1.4)] });
    assert.equal(a.kind, 'backoff', field);
    assert.equal(a.why, why);
  }
  assert.equal(decide({ panic: 4, zombies: [zed(1.0)] }).kind, 'shove');
  assert.equal(decide({ panic: 2, heavy: 1, tired: 2, endurance: 0.31, zombies: [zed(1.4)] }).kind, 'swing');
});

test('hp under 30: flee', () => {
  const a = decide({ hp: 25, zombies: [zed(1.2)] });
  assert.equal(a.kind, 'flee');
  assert.equal(a.why, 'hurt');
});

test('a chasing zombie more than 6 tiles off is not chased', () => {
  assert.deepEqual(decide({ zombies: [zed(8)] }), { kind: 'none' });
  assert.equal(decide({ zombies: [zed(5.5)] }).kind, 'close');
});

test('nothing within 11 tiles: nothing', () => {
  assert.deepEqual(decide({ zombies: [zed(12), zed(15)] }), { kind: 'none' });
  assert.deepEqual(decide({ zombies: [] }), { kind: 'none' });
});

test('unarmed: flee one that is coming, shove one that is on him alone', () => {
  assert.equal(decide({ armed: false, reach: 0, zombies: [zed(4)] }).kind, 'flee');
  assert.equal(decide({ armed: false, reach: 0, zombies: [zed(1.0)] }).kind, 'shove');
  assert.equal(decide({ armed: false, reach: 0, zombies: [zed(0.8, { down: true })] }).kind, 'stomp');
});

test('a short blade opens the gap until the zombie is on him', () => {
  const a = decide({ reach: 0.9, shortBlade: true, zombies: [zed(3)] });
  assert.equal(a.kind, 'flee');
  assert.equal(a.why, 'short');
  assert.equal(decide({ reach: 0.9, shortBlade: true, zombies: [zed(1.3)] }).kind, 'swing');
});

test('inside with a chaser outside: hold the spot instead of walking out', () => {
  const hold = { dx: -1.5, dy: 0.5 };
  const a = decide({ inside: true, hold, zombies: [zed(5, { outside: true })] });
  assert.deepEqual(a, { kind: 'hold', index: 1, dx: -1.5, dy: 0.5 });
  // It climbed in and fell: stomp it.
  assert.equal(decide({ inside: true, hold, zombies: [zed(0.9, { down: true })] }).kind, 'stomp');
  // In reach at the opening: hit it as it climbs.
  assert.equal(decide({ inside: true, hold, zombies: [zed(1.3, { outside: true })] }).kind, 'swing');
  // One already inside and close is a normal fight.
  assert.equal(decide({ inside: true, hold, zombies: [zed(5, { outside: true }), zed(2, { dx: -2 })] }).kind, 'close');
  // One lying outside cannot be stomped through the wall.
  assert.equal(decide({ inside: true, hold, zombies: [zed(0.9, { down: true, outside: true }), zed(5, { outside: true })] }).kind, 'hold');
  // No spot found: the old behaviour.
  assert.equal(decide({ inside: true, zombies: [zed(5, { outside: true })] }).kind, 'close');
});

test('each flag switches its part off', () => {
  const flags = (off) => ({ stomp: true, spacing: true, gates: true, doorHold: true, ...off });
  assert.equal(decide({ flags: flags({ stomp: false }), zombies: [zed(0.8, { down: true })] }).kind, 'swing');
  assert.equal(decide({ flags: flags({ gates: false }), endurance: 0.1, zombies: [zed(1.2)] }).kind, 'swing');
  assert.equal(decide({ flags: flags({ doorHold: false }), inside: true, hold: { dx: 1, dy: 0 }, zombies: [zed(5, { outside: true })] }).kind, 'close');
  // Spacing off is the old rule: two close and one within 4 means run.
  assert.equal(decide({ flags: flags({ spacing: false }), zombies: [zed(1.4), zed(1.9)] }).kind, 'flee');
});

test('the flags default on and live on the namespace', () => {
  assert.deepEqual(lua.get('LocalSurvivor.combat'), { stomp: true, spacing: true, gates: true, doorHold: true });
  lua.set('LocalSurvivor.combat.stomp', false);
  assert.equal(lua.call('LocalSurvivor.Reflex.decide', { ...fit, zombies: [zed(0.8, { down: true })] }).kind, 'swing');
  lua.set('LocalSurvivor.combat.stomp', true);
});

// ---------- the game-facing side, with stubs ----------

function body(stats = { ENDURANCE: 1 }) {
  const h = createHarness();
  h.autoload();
  h.run(`
    local p = __makePlayer({ x = 10, y = 10, stats = ... })
    p.calls = {}
    function p:isMeleeWeaponEquipped() return true end
    function p:isAttackStarted() return false end
    function p:isAuthorizeShoveStomp() return true end
    function p:setDoShove(v) table.insert(self.calls, "shove=" .. tostring(v)) end
    function p:DoAttack(c) table.insert(self.calls, "attack") end
    __players[0] = p
    __squares["7,10,0"] = { isFree = function() return true end }
  `, stats);
  return h;
}
function addZombie(h, x, y, down) {
  h.run(`
    local x, y, down = ...
    table.insert(__zombies, {
      getX = function() return x end, getY = function() return y end, getZ = function() return 0 end,
      isDead = function() return false end, isOnFloor = function() return down end,
      isKnockedDown = function() return false end, isFakeDead = function() return false end,
      isCrawling = function() return false end, isOutside = function() return true end,
      getTarget = function() return __players[0] end,
    })
  `, x, y, down);
}

test('a stomp is a shove next to the downed zombie', () => {
  const h = body();
  addZombie(h, 10.7, 10, true);
  assert.equal(h.run('return LocalSurvivor.Reflex.survive(__players[0])'), true);
  assert.deepEqual(h.run('return __players[0].calls'), ['shove=true', 'attack']);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'STOMP (reflex)');
});

test('a swing clears a leftover shove first', () => {
  const h = body();
  addZombie(h, 11.2, 10, false);
  h.run('LocalSurvivor.Reflex.survive(__players[0])');
  assert.deepEqual(h.run('return __players[0].calls'), ['shove=false', 'attack']);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'FIGHT');
});

test('winded with one coming: one short walk away, not a new one every tick', () => {
  const h = body({ ENDURANCE: 0.1 });
  addZombie(h, 13, 10, false);
  h.run('LocalSurvivor.Reflex.survive(__players[0])');
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'BACK OFF (reflex)');
  const queue = () => h.run('return #__players[0].__queue.queue');
  assert.equal(queue(), 1);
  const target = h.run('return __players[0].__queue.queue[1].args[2]');
  assert.ok(target, 'walks to the square 3 tiles west');
  h.run('LocalSurvivor.Reflex.survive(__players[0])');
  assert.equal(queue(), 1);
  assert.deepEqual(h.run('return __players[0].calls'), []);
});

test('the shove call missing falls back to a plain attack', () => {
  const h = body();
  h.run('__players[0].setDoShove = nil');
  addZombie(h, 10.7, 10, true);
  h.run('LocalSurvivor.Reflex.survive(__players[0])');
  assert.deepEqual(h.run('return __players[0].calls'), ['attack']);
  assert.match(h.get('LocalSurvivor.hudData.thought'), /Hitting it/);
});
