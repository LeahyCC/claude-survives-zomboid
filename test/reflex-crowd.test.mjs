// The crowd test (Stance.choose, before any swing): with two or more standing zombies within
// reach a weak weapon shoves the nearest and leaves, a strong one takes two but never three, and
// a winded survivor leaves without the shove. Also the count line in ReflexLog. docs/combat.md,
// "The crowd test". The shove itself is a live-game check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();

// A zombie at distance d, d' tiles east and north of her, chasing unless told otherwise.
const zed = (d, extra = {}) => ({ d, dx: d, dy: 0, down: false, crawl: false, chase: true, outside: false, ...extra });
const north = (d, extra = {}) => zed(d, { dx: 0, dy: d, ...extra });
const fit = { armed: true, reach: 1.5, shortBlade: false, hp: 100, endurance: 1, panic: 0, heavy: 0, tired: 0, inside: false };
const WEAK = 9;
const STRONG = 34;
const decide = (snap) => lua.call('LocalSurvivor.Reflex.decide', { ...fit, ...snap });
const leaves = (a) => ['break', 'flee', 'climb', 'hide'].includes(a.kind);

test('one standing zombie in reach is fought, weak weapon or strong', () => {
  for (const weaponScore of [WEAK, STRONG]) {
    const a = decide({ weaponScore, zombies: [zed(1.1)] });
    assert.equal(a.kind, 'swing', `score ${weaponScore}`);
    assert.equal(a.stance, 'FIGHT');
  }
});

test('two standing, weak weapon: shove the nearest, then leave on the next look', () => {
  const first = decide({ weaponScore: WEAK, zombies: [zed(1.1), north(2.2)] });
  assert.equal(first.kind, 'shove');
  assert.equal(first.why, 'crowd');
  assert.equal(first.index, 1, 'the nearest');
  assert.equal(first.stance, 'SHOVE');
  // The next look: the shoved one is down, the other is still standing and not on her.
  const next = decide({ weaponScore: WEAK, crowdShoved: true, zombies: [zed(1.1, { down: true }), north(2.2)] });
  assert.ok(leaves(next), next.kind);
  assert.equal(next.why, 'crowd');
});

test('two standing, weak weapon, neither in shove reach: leave without shoving', () => {
  const a = decide({ weaponScore: WEAK, zombies: [zed(1.8), north(2.3)] });
  assert.ok(leaves(a), a.kind);
  assert.equal(a.why, 'crowd');
});

test('bare hands count as a weak weapon', () => {
  const a = decide({ armed: false, zombies: [zed(1.1), north(2.2)] });
  assert.equal(a.kind, 'shove');
  assert.equal(a.why, 'crowd');
});

test('two standing, strong weapon: still a fight', () => {
  const a = decide({ weaponScore: STRONG, zombies: [zed(1.1), north(2.3)] });
  assert.equal(a.kind, 'swing');
  assert.equal(a.stance, 'FIGHT');
});

test('three standing: never a swing, whatever the weapon', () => {
  for (const weaponScore of [WEAK, STRONG, 60]) {
    const close = decide({ weaponScore, zombies: [zed(1.1), north(2.0), zed(2.4, { dy: 0.5 })] });
    assert.equal(close.kind, 'shove', `score ${weaponScore}`);
    assert.equal(close.why, 'crowd');
    const apart = decide({ weaponScore, zombies: [zed(1.8), north(2.1), zed(2.4, { dy: 0.5 })] });
    assert.ok(leaves(apart), `score ${weaponScore}: ${apart.kind}`);
    assert.equal(apart.why, 'crowd');
    // After the shove, the ones left standing are not fought either.
    const after = decide({ weaponScore, crowdShoved: true, zombies: [zed(1.1, { down: true }), north(2.0), zed(2.4, { dy: 0.5 })] });
    assert.ok(leaves(after), `score ${weaponScore} after the shove: ${after.kind}`);
  }
});

test('little endurance: leave at once, no shove', () => {
  for (const endurance of [0, 0.2, 0.29]) {
    const a = decide({ weaponScore: WEAK, endurance, zombies: [zed(1.0), north(1.4)] });
    assert.ok(leaves(a), `endurance ${endurance}: ${a.kind}`);
    assert.equal(a.why, 'crowd');
    assert.notEqual(a.kind, 'shove');
  }
  // With the breath for it she shoves.
  assert.equal(decide({ weaponScore: WEAK, endurance: 0.3, zombies: [zed(1.0), north(1.4)] }).kind, 'shove');
  // Three on a strong weapon, winded: leave as well.
  assert.ok(leaves(decide({ weaponScore: STRONG, endurance: 0.1, zombies: [zed(1.0), north(1.4), west(2)] })));
});
const west = (d, extra = {}) => zed(d, { dx: -d, ...extra });

test('downed zombies do not count as standing', () => {
  // A weak weapon with one standing and two on the ground is a one on one fight.
  const a = decide({ weaponScore: WEAK, zombies: [zed(1.1), north(1.6, { down: true }), west(2, { crawl: true })] });
  assert.equal(a.kind, 'swing');
  // Three at reach where only two are standing: a strong weapon fights.
  const b = decide({ weaponScore: STRONG, zombies: [zed(1.1), north(2.3), west(1.8, { down: true })] });
  assert.equal(b.kind, 'swing');
});

test('only the ones that can get at her count', () => {
  // Past 2.5 tiles, behind a fence, or unaware and not close: not part of the crowd.
  assert.equal(decide({ weaponScore: WEAK, zombies: [zed(1.1), north(3)] }).kind, 'swing');
  assert.equal(decide({ weaponScore: WEAK, zombies: [zed(1.1), north(2.4, { across: true })] }).kind, 'swing');
  assert.equal(decide({ weaponScore: WEAK, zombies: [zed(1.1), north(2.4, { chase: false })] }).kind, 'swing');
  // An unaware one right beside her does count.
  assert.equal(decide({ weaponScore: WEAK, zombies: [zed(1.1), north(1.8, { chase: false })] }).why, 'crowd');
});

test('a posture does not widen the crowd', () => {
  const two = [zed(1.1), north(2.2)];
  assert.equal(decide({ posture: 'clear', weaponScore: WEAK, zombies: two }).why, 'crowd');
  assert.equal(decide({ posture: 'avoid', weaponScore: STRONG, zombies: two }).why, 'crowd');
});

// ---------- the count line ----------
// The harness copies tables in and out of Lua, so the state lives in the mod's own session
// table and the lines are read back from the file, the way the bridge reads them.

function logger() {
  const h = createHarness();
  h.autoload();
  const z = (d) => ({ d, dx: d, dy: 0, chase: true });
  const look = (stance, n, tick, hp = 100) => h.call('LocalSurvivor.ReflexLog.note', { kind: 'swing', stance },
    { zombies: Array.from({ length: n }, (_, i) => z(1.5 + i)), hp }, tick, 0);
  const counts = () => {
    h.call('LocalSurvivor.ReflexLog.flush', 9999);
    return String(h.run('return __files["local_reflex.txt"] or ""')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === 'count');
  };
  return { look, counts };
}

test('a count line when the standing count rises during a fight', () => {
  const { look, counts } = logger();
  look('FIGHT', 2, 100);
  look('FIGHT', 2, 110);
  assert.equal(counts().length, 0, 'the first look sets the count, no change is no line');
  look('FIGHT', 3, 200, 60);
  look('FIGHT', 2, 210);
  const got = counts();
  assert.equal(got.length, 1, 'a fall is not logged');
  assert.equal(got[0].from, 2);
  assert.equal(got[0].to, 3);
  assert.equal(got[0].stance, 'FIGHT');
  assert.equal(got[0].f.hp, 60, 'carries the facts');
});

test('no count line outside a fight, and not more than one a second', () => {
  const quiet = logger();
  quiet.look('NONE', 1, 0);
  quiet.look('NONE', 3, 10);
  assert.equal(quiet.counts().length, 0, 'a crowd walking up while she does nothing');

  const { look, counts } = logger();
  look('SHOVE', 1, 0);
  look('SHOVE', 2, 10);
  look('SHOVE', 3, 20);
  assert.equal(counts().length, 1, 'the second rise came too soon');
  look('SHOVE', 3, 80);
  assert.equal(counts().length, 2, 'the rise that held is logged once the gap is over');
  look('SHOVE', 4, 160);
  assert.equal(counts().length, 3);

  const old = logger();
  old.look('FIGHT', 1, 0);
  old.look('BREAK', 4, 900);
  assert.equal(old.counts().length, 0, 'a fight that ended a while ago no longer counts');
});

test('the count line is written to the log file with the others', () => {
  const h = createHarness();
  h.autoload();
  const z = (d) => ({ d, dx: d, dy: 0, chase: true });
  const call = (snap, tick) => h.call('LocalSurvivor.ReflexLog.note', { kind: 'swing', stance: 'FIGHT' }, snap, tick, 0);
  call({ zombies: [z(1.2), z(2)], hp: 100 }, 100);
  call({ zombies: [z(1.2), z(2), z(5)], hp: 90 }, 130);
  h.call('LocalSurvivor.ReflexLog.flush', 200);
  const lines = String(h.run('return __files["local_reflex.txt"] or ""')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const count = lines.filter((l) => l.t === 'count');
  assert.equal(count.length, 1);
  assert.equal(count[0].from, 2);
  assert.equal(count[0].to, 3);
  assert.equal(count[0].f.reach, 2, 'two within reach');
});

// ---------- the game-facing side, with stubs ----------

function body(stats = { ENDURANCE: 1 }) {
  const h = createHarness();
  h.autoload();
  h.run(`
    local p = __makePlayer({ x = 10, y = 10, stats = ... })
    p.calls = {}
    function p:isMeleeWeaponEquipped() return true end
    p.primary = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, crit = 20, range = 1.25,
      swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
    function p:isAttackStarted() return false end
    function p:isAuthorizeShoveStomp() return true end
    function p:setDoShove(v) table.insert(self.calls, "shove=" .. tostring(v)) end
    function p:DoAttack(c) table.insert(self.calls, "attack") end
    function p:isSneaking() return self.sneaking == true end
    function p:setSprinting(v) self.sprint = v; table.insert(self.calls, "sprint=" .. tostring(v)) end
    function p:isSprinting() return self.sprint == true end
    __players[0] = p
    __squares["7,10,0"] = { isFree = function() return true end }
  `, stats);
  return h;
}
function addZombie(h, x, y) {
  h.run(`
    local x, y = ...
    table.insert(__zombies, {
      getX = function() return x end, getY = function() return y end, getZ = function() return 0 end,
      isDead = function() return false end, isOnFloor = function() return false end,
      isKnockedDown = function() return false end, isFakeDead = function() return false end,
      isCrawling = function() return false end, isOutside = function() return true end,
      getTarget = function() return __players[0] end,
    })
  `, x, y);
}
const survive = (h) => h.run('return LocalSurvivor.Reflex.survive(__players[0])');

test('three on her with a crowbar: shove, and the next look does not swing', () => {
  const h = body();
  h.run('__squares["0,10,0"] = { isFree = function() return true end }');
  addZombie(h, 11.1, 10);
  addZombie(h, 10, 12);
  addZombie(h, 8.2, 10.4);
  h.run('LocalSurvivor.tick = 100');
  assert.equal(survive(h), true);
  assert.deepEqual(h.run('return __players[0].calls'), ['shove=true', 'attack']);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'SHOVE (reflex)');
  assert.match(h.get('LocalSurvivor.hudData.thought'), /Too many/);
  assert.equal(h.get('LocalSurvivor.reflexState.crowdShoveTick'), 100);
  // The next look: it walks away, it does not swing.
  h.run('__players[0].calls = {}; LocalSurvivor.tick = 105');
  h.run('__zombies[1].isOnFloor = function() return true end');
  survive(h);
  assert.deepEqual(h.run('return __players[0].calls').filter((c) => c === 'attack'), [], 'no swing or shove');
  assert.notEqual(h.get('LocalSurvivor.hudData.action'), 'FIGHT');
});

test('the shove memory runs out', () => {
  const h = body();
  h.run('LocalSurvivor.reflexState.crowdShoveTick = 100; LocalSurvivor.tick = 100 + LocalSurvivor.Reflex.CROWD_TICKS + 1');
  const snap = h.run('return (LocalSurvivor.Reflex.snapshot(__players[0]))');
  assert.equal(snap.crowdShoved, false);
  h.run('LocalSurvivor.tick = 110');
  assert.equal(h.run('return (LocalSurvivor.Reflex.snapshot(__players[0])).crowdShoved'), true);
});
