// The fight brain (Reflex.decide, which is Stance.choose) on plain snapshots, and a few ticks of
// the game-facing side with stub zombies. Whether a stomp, a climb or a sprint really happens is
// a live-game check, see docs/combat.md.
//
// decide now also names the stance, the threat ratio and the level, so the old exact matches
// compare only the fields they were about (pick below).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();

// A zombie at distance d straight east, chasing unless told otherwise.
const zed = (d, extra = {}) => ({ d, dx: d, dy: 0, down: false, crawl: false, chase: true, outside: false, ...extra });
// A zombie at distance d straight west.
const west = (d, extra = {}) => zed(d, { dx: -d, ...extra });
const fit = { armed: true, reach: 1.5, shortBlade: false, hp: 100, endurance: 1, panic: 0, heavy: 0, tired: 0, inside: false };
const decide = (snap) => lua.call('LocalSurvivor.Reflex.decide', { ...fit, ...snap });
const pick = (a, keys = ['kind', 'index', 'why']) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

// ---------- the old rules, still holding ----------

test('one standing zombie in reach: swing', () => {
  const a = decide({ zombies: [zed(1.2)] });
  assert.deepEqual(pick(a), { kind: 'swing', index: 1 });
  assert.equal(a.stance, 'FIGHT');
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
  assert.deepEqual(pick(decide({ zombies: [zed(3, { down: true })] })), { kind: 'close', index: 1, why: 'down' });
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
  assert.equal(a.stance, 'SHOVE');
  assert.ok(a.dx < 0 && a.dy < 0);
});

test('two standing within 2 and one right on him: shove it first', () => {
  assert.equal(decide({ zombies: [zed(0.9), zed(1.8)] }).kind, 'shove');
});

// Was a flee: a fit survivor now tries to sprint out of sight (BREAK), and a winded one runs.
test('three within 7: break contact, away from them', () => {
  const a = decide({ zombies: [zed(3), zed(5), zed(6.5)] });
  assert.equal(a.kind, 'break');
  assert.equal(a.why, 'pack');
  assert.equal(a.stance, 'BREAK');
  assert.ok(a.dx < 0);
  assert.equal(decide({ endurance: 0.4, zombies: [zed(3), zed(5), zed(6.5)] }).kind, 'flee');
});

// Was none: the reflex now crouches for her while one that has not seen her is about.
test('an unaware zombie at 9 tiles: no fight, she sneaks', () => {
  const a = decide({ zombies: [zed(9, { chase: false })] });
  assert.equal(a.kind, 'sneak');
  assert.equal(a.dx, undefined, 'no walk of its own: the order goes on');
});

test('an unaware zombie close by is still dealt with', () => {
  assert.equal(decide({ zombies: [zed(1.4, { chase: false })] }).kind, 'swing');
});

test('an unaware zombie nearer than a chasing one does not hide the chaser', () => {
  assert.deepEqual(pick(decide({ zombies: [zed(3, { chase: false }), zed(5)] })), { kind: 'close', index: 2 });
});

test('an unaware zombie in the way of the walk is dealt with', () => {
  assert.equal(decide({ heading: { dx: 8, dy: 0 }, zombies: [zed(3.5, { chase: false })] }).kind, 'close');
  assert.equal(decide({ heading: { dx: -8, dy: 0 }, zombies: [zed(3.5, { chase: false })] }).kind, 'sneak');
});

test('endurance under 0.3 with one chasing: back off', () => {
  const a = decide({ endurance: 0.25, zombies: [zed(3)] });
  assert.equal(a.kind, 'backoff');
  assert.equal(a.why, 'winded');
  assert.equal(a.dx, -1);
  assert.equal(Math.abs(a.dy), 0);
});

test('every gate backs off, and a cornered gate shoves', () => {
  for (const [field, value, why] of [['panic', 3, 'panic'], ['heavy', 2, 'heavy'], ['tired', 3, 'tired'], ['bleeding', 1, 'bleeding'], ['hp', 45, 'hurt']]) {
    const a = decide({ [field]: value, zombies: [zed(1.4)] });
    assert.equal(a.kind, 'backoff', field);
    assert.equal(a.why, why);
  }
  assert.equal(decide({ panic: 4, zombies: [zed(1.0)] }).kind, 'shove');
  assert.equal(decide({ panic: 2, heavy: 1, tired: 2, endurance: 0.31, zombies: [zed(1.4)] }).kind, 'swing');
});

// One on her used to be a flee at hp under 30. Turning away from one in reach gets her bitten,
// so that is a shove now, and only one farther off is run from.
test('hp under 30: run from it, but shove one that is on her', () => {
  const a = decide({ hp: 25, zombies: [zed(3)] });
  assert.ok(['break', 'flee'].includes(a.kind), a.kind);
  assert.equal(a.why, 'hurt');
  assert.equal(decide({ hp: 25, zombies: [zed(1.2)] }).kind, 'shove');
  assert.equal(decide({ hp: 25, zombies: [zed(9)] }).kind, 'none');
});

test('a chasing zombie more than 6 tiles off is not chased', () => {
  assert.equal(decide({ zombies: [zed(8)] }).kind, 'none');
  assert.equal(decide({ zombies: [zed(5.5)] }).kind, 'close');
});

test('nothing within 11 tiles: nothing', () => {
  assert.equal(decide({ zombies: [zed(12), zed(15)] }).kind, 'none');
  const empty = decide({ zombies: [] });
  assert.equal(empty.kind, 'none');
  assert.equal(empty.stance, 'NONE');
  assert.equal(empty.level, 0);
});

// The unarmed run is a break when she has the breath for it.
test('unarmed: run from one that is coming, shove one that is on him', () => {
  assert.equal(decide({ armed: false, reach: 0, zombies: [zed(4)] }).kind, 'break');
  assert.equal(decide({ armed: false, reach: 0, endurance: 0.4, zombies: [zed(4)] }).kind, 'flee');
  assert.equal(decide({ armed: false, reach: 0, zombies: [zed(1.0)] }).kind, 'shove');
  const s = decide({ armed: false, reach: 0, zombies: [zed(0.8, { down: true })] });
  assert.equal(s.kind, 'stomp');
  assert.equal(s.stance, 'SHOVE', 'a stomp without a weapon is the shove loop');
});

// Was a 16 tile flee. Running from a walking zombie drags in more, so she stands and lets it come.
test('a short blade stands and lets the zombie come into reach', () => {
  const a = decide({ reach: 0.9, shortBlade: true, zombies: [zed(3)] });
  assert.deepEqual(pick(a, ['kind', 'why', 'dx', 'dy']), { kind: 'hold', why: 'short', dx: 0, dy: 0 });
  assert.equal(decide({ reach: 0.9, shortBlade: true, zombies: [zed(1.3)] }).kind, 'swing');
});

test('inside with a chaser outside: hold the spot instead of walking out', () => {
  const hold = { dx: -1.5, dy: 0.5 };
  const a = decide({ inside: true, hold, zombies: [zed(5, { outside: true })] });
  assert.deepEqual(pick(a, ['kind', 'index', 'dx', 'dy', 'why', 'stance']), { kind: 'hold', index: 1, dx: -1.5, dy: 0.5, why: 'door', stance: 'HOLD' });
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
  const flags = (off) => ({ stomp: true, spacing: true, gates: true, doorHold: true, climb: true, hide: true, sprint: true, ...off });
  assert.equal(decide({ flags: flags({ stomp: false }), zombies: [zed(0.8, { down: true })] }).kind, 'swing');
  assert.equal(decide({ flags: flags({ gates: false }), endurance: 0.1, zombies: [zed(1.2)] }).kind, 'swing');
  assert.equal(decide({ flags: flags({ doorHold: false }), inside: true, hold: { dx: 1, dy: 0 }, zombies: [zed(5, { outside: true })] }).kind, 'close');
  // Spacing off is the old rule: two close and one within 4 means run.
  assert.equal(decide({ flags: flags({ spacing: false }), zombies: [zed(1.4), zed(1.9)] }).kind, 'flee');
});

test('the flags default on and live on the namespace', () => {
  assert.deepEqual(lua.get('LocalSurvivor.combat'), { stomp: true, spacing: true, gates: true, doorHold: true, climb: true, hide: true, sprint: true });
  lua.set('LocalSurvivor.combat.stomp', false);
  assert.equal(lua.call('LocalSurvivor.Reflex.decide', { ...fit, zombies: [zed(0.8, { down: true })] }).kind, 'swing');
  lua.set('LocalSurvivor.combat.stomp', true);
});

// ---------- the scenarios from the card ----------

const fence = (d, extra = {}) => ({ kind: 'fence', dx: d, dy: 0, d, nx: 1, ny: 0, ...extra });

test('scenario: one zombie, armed and fit: fight it', () => {
  const far = decide({ weaponScore: 34, zombies: [zed(4)] });
  assert.deepEqual(pick(far, ['kind', 'stance']), { kind: 'close', stance: 'FIGHT' });
  assert.equal(decide({ weaponScore: 34, zombies: [zed(1.3)] }).kind, 'swing');
  assert.ok(far.level <= 2, `one zombie is a low threat to an armed fit survivor, got ${far.level}`);
});

test('scenario: two at a doorway: hold the door', () => {
  const a = decide({ inside: true, hold: { dx: 1, dy: 0 }, weaponScore: 19, zombies: [zed(4, { outside: true }), zed(6, { outside: true, dy: 1 })] });
  assert.equal(a.stance, 'HOLD');
  assert.equal(a.why, 'door');
});

test('scenario: a pack in the open: break contact along the best open line', () => {
  const pack = [zed(3), zed(4, { dy: 1 }), zed(5, { dy: -1 }), zed(6)];
  const lines = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: 1 }];
  const a = decide({ zombies: pack, lines });
  assert.equal(a.stance, 'BREAK');
  assert.deepEqual([a.dx, a.dy], [-1, 0], 'straight away from them');
  // A line that went nowhere last time is skipped.
  const b = decide({ zombies: pack, lines: lines.map((l) => (l.dx === -1 && l.dy === 0 ? { ...l, blocked: true } : l)) });
  assert.ok(b.dx < 0 && b.dy > 0, `takes the next best way, got ${b.dx},${b.dy}`);
  assert.ok(a.level >= 3, `a pack is a high threat, got ${a.level}`);
});

test('scenario: winded with one close: shove, then step back, never walk in', () => {
  assert.deepEqual(pick(decide({ endurance: 0.2, zombies: [zed(1.0)] }), ['kind', 'stance']), { kind: 'shove', stance: 'SHOVE' });
  assert.deepEqual(pick(decide({ endurance: 0.2, zombies: [zed(2.5)] }), ['kind', 'why']), { kind: 'backoff', why: 'winded' });
  // Farther off she just goes. No breath for a sprint, so a plain run.
  assert.deepEqual(pick(decide({ endurance: 0.2, zombies: [zed(6)] }), ['kind', 'why']), { kind: 'flee', why: 'winded' });
});

test('scenario: unaware zombies by the route: sneak past, or creep away from a group', () => {
  const by = decide({ heading: { dx: 0, dy: -8 }, zombies: [zed(5, { chase: false }), zed(8, { chase: false, dy: 3 })] });
  assert.equal(by.kind, 'sneak');
  assert.equal(by.dx, undefined);
  const group = decide({ zombies: [zed(4, { chase: false }), zed(5, { chase: false }), zed(6, { chase: false })] });
  assert.equal(group.kind, 'sneak');
  assert.equal(group.why, 'pack');
  // One coming from far off rules crouching out: sneaking is slow.
  assert.equal(decide({ zombies: [zed(9, { chase: false }), zed(13)] }).kind, 'none');
  assert.ok(group.dx < 0, 'creeps away from them');
});

test('scenario: a fence between her and the pack: get away, the fence slows them', () => {
  const pack = [zed(3, { across: true }), zed(4, { across: true }), zed(5, { across: true })];
  // The fence is east of her and they are past it: across is east, toward them.
  const a = decide({ zombies: pack, barriers: [fence(1.5)] });
  assert.equal(a.stance, 'BREAK', 'no climb back over to them');
  // Two across a fence and she can fight: hold it.
  const two = decide({ weaponScore: 34, zombies: [zed(3, { across: true }), zed(4, { across: true })] });
  assert.deepEqual(pick(two, ['kind', 'why', 'stance']), { kind: 'hold', why: 'fence', stance: 'HOLD' });
  assert.equal(decide({ zombies: [zed(1.4, { across: true })] }).why, 'fence', 'one climbing over in reach is hit');
  // With one on her side it is not a fence fight.
  assert.notEqual(decide({ weaponScore: 34, zombies: [zed(3, { across: true }), zed(4)] }).why, 'fence');
});

test('scenario: bleeding and chased: never start the fight', () => {
  assert.equal(decide({ bleeding: 1, zombies: [zed(1.0)] }).kind, 'shove');
  assert.deepEqual(pick(decide({ bleeding: 1, zombies: [zed(3)] }), ['kind', 'why']), { kind: 'backoff', why: 'bleeding' });
  assert.deepEqual(pick(decide({ bleeding: 1, zombies: [zed(6)] }), ['kind', 'why', 'stance']), { kind: 'break', why: 'bleeding', stance: 'BREAK' });
});

test('scenario: a pack behind her and a fence ahead: climb it', () => {
  const pack = [west(3), west(4, { dy: 1 }), west(5)];
  const a = decide({ zombies: pack, barriers: [fence(2)] });
  assert.deepEqual(pick(a, ['kind', 'stance', 'target']), { kind: 'climb', stance: 'CLIMB', target: 1 });
  // A fence that leads back toward them is no use.
  assert.equal(decide({ zombies: pack, barriers: [fence(2, { nx: -1, dx: -2 })] }).kind, 'break');
  // One waiting on the far side.
  assert.equal(decide({ zombies: [...pack, zed(4)], barriers: [fence(2)] }).kind, 'break');
  // Too far, or tried lately.
  assert.equal(decide({ zombies: pack, barriers: [fence(5)] }).kind, 'break');
  assert.equal(decide({ zombies: pack, barriers: [fence(2, { failed: true })] }).kind, 'break');
  // Switched off.
  assert.equal(decide({ zombies: pack, barriers: [fence(2)], flags: { climb: false } }).kind, 'break');
  // Nearest of two.
  assert.equal(decide({ zombies: pack, barriers: [fence(3), fence(1.5)] }).target, 2);
});

test('mid climb: wait for the animation, touch nothing', () => {
  assert.deepEqual(pick(decide({ climbing: true, zombies: [west(2)] }), ['kind', 'stance']), { kind: 'wait', stance: 'CLIMB' });
});

test('they lost sight of her: hide still, or creep away while one is still near', () => {
  const lost = (d) => west(d, { sees: false });
  const still = decide({ prev: 'BREAK', zombies: [lost(8), lost(9)] });
  assert.deepEqual(pick(still, ['kind', 'stance', 'dx', 'dy']), { kind: 'hide', stance: 'HIDE', dx: 0, dy: 0 });
  const slip = decide({ prev: 'BREAK', zombies: [lost(5)] });
  assert.equal(slip.kind, 'hide');
  assert.ok(slip.dx > 0, 'creeps away from it');
  // One still sees her, and there are more than she takes on: keep running.
  assert.equal(decide({ prev: 'BREAK', zombies: [lost(8), lost(8.5), west(8)] }).kind, 'break');
  // The same three strung out, but she was not running from them: no reason to start.
  assert.equal(decide({ zombies: [lost(8), lost(8.5), west(8)] }).kind, 'none');
  // Too close to hide from.
  assert.equal(decide({ prev: 'BREAK', zombies: [lost(3)] }).kind, 'close');
  // Armed and fit and never running from it: it is still a fight.
  assert.equal(decide({ zombies: [lost(5)] }).kind, 'close');
  // Unknown sight counts as seeing her.
  assert.equal(decide({ prev: 'BREAK', zombies: [west(5, { sees: undefined }), west(6), west(6.5)] }).kind, 'break');
});

test('a weak weapon takes on one chaser, a strong one two', () => {
  const two = [zed(3), zed(5, { dy: 1 })];
  assert.deepEqual(pick(decide({ weaponScore: 9, zombies: two }), ['kind', 'why']), { kind: 'break', why: 'outnumbered' });
  assert.equal(decide({ weaponScore: 34, zombies: two }).kind, 'close');
});

test('posture: avoid stays out of fights, clear goes looking for them', () => {
  assert.deepEqual(pick(decide({ posture: 'avoid', zombies: [zed(4)] }), ['kind', 'why']), { kind: 'break', why: 'avoid' });
  assert.equal(decide({ posture: 'avoid', zombies: [zed(1.3)] }).kind, 'swing', 'one on her is still fought');
  assert.equal(decide({ posture: 'avoid', weaponScore: 51, zombies: [zed(3), zed(5)] }).why, 'outnumbered');
  assert.equal(decide({ posture: 'avoid', heading: { dx: 8, dy: 0 }, zombies: [zed(3.5, { chase: false })] }).kind, 'sneak');
  assert.equal(decide({ posture: 'clear', zombies: [zed(7.5)] }).kind, 'close');
  assert.equal(decide({ posture: 'clear', zombies: [zed(3.5, { chase: false })] }).kind, 'close');
  // Missing or unknown is the normal posture.
  assert.equal(decide({ posture: 'dance', zombies: [zed(7.5)] }).kind, 'none');
  assert.equal(decide({ zombies: [zed(4)] }).kind, 'close');
  // Clear holds a fence against three where normal runs.
  const three = [zed(3, { across: true }), zed(4, { across: true }), zed(5, { across: true })];
  assert.equal(decide({ posture: 'clear', weaponScore: 51, zombies: three }).stance, 'HOLD');
  assert.equal(decide({ weaponScore: 51, zombies: three }).stance, 'BREAK');
});

test('overloaded or hurt: no sprint and no fight', () => {
  assert.deepEqual(pick(decide({ heavy: 2, zombies: [zed(6)] }), ['kind', 'why']), { kind: 'flee', why: 'heavy' });
  assert.deepEqual(pick(decide({ hp: 45, zombies: [zed(6)] }), ['kind', 'why']), { kind: 'break', why: 'hurt' });
});

// ---------- the pure pieces ----------

test('assess: the threat grows with numbers and nearness, and a weapon and fitness shrink it', () => {
  const assess = (snap) => lua.call('LocalSurvivor.Stance.assess', { ...fit, ...snap });
  const one = assess({ weaponScore: 34, zombies: [zed(5)] });
  const three = assess({ weaponScore: 34, zombies: [zed(2), zed(3), zed(5)] });
  const bare = assess({ armed: false, zombies: [zed(5)] });
  const tired = assess({ weaponScore: 34, endurance: 0.2, zombies: [zed(5)] });
  assert.ok(three.ratio > one.ratio);
  assert.ok(bare.ratio > one.ratio);
  assert.ok(tired.ratio > one.ratio);
  assert.equal(one.chasers, 1);
  assert.equal(three.pack, 3);
  assert.equal(assess({ zombies: [] }).level, 0);
  assert.equal(assess({ zombies: [zed(5, { sees: false })] }).seers, 0);
  assert.equal(assess({ zombies: [zed(5, { across: true }), zed(4)] }).across, 1);
});

test('posture names are cleaned and the overrides apply', () => {
  const p = (s) => lua.call('LocalSurvivor.Stance.posture', s);
  assert.equal(p('avoid'), 'avoid');
  assert.equal(p('AVOID FIGHTS'), 'avoid');
  assert.equal(p('clear\r'), 'clear');
  assert.equal(p(''), 'normal');
  assert.equal(p(null), 'normal');
  assert.equal(p('dance'), 'normal');
  assert.equal(lua.call('LocalSurvivor.Stance.params', 'avoid').CHASE_MAX, 2);
  assert.equal(lua.call('LocalSurvivor.Stance.params', 'normal').CHASE_MAX, 6);
});

test('wantSneak: crouched only while hiding or sneaking past, and only while fresh', () => {
  const w = (s, age) => lua.call('LocalSurvivor.Stance.wantSneak', s, age);
  assert.equal(w('HIDE', 10), true);
  assert.equal(w('SNEAK', 10), true);
  assert.equal(w('SNEAK', 200), false);
  assert.equal(w('FIGHT', 0), false);
  assert.equal(w('BREAK', 0), false);
  assert.equal(w(null, 0), false);
});

test('edgeFacts: which side she is on decides the way across', () => {
  const e = (b, px, py) => lua.call('LocalSurvivor.Reflex.edgeFacts', b, px, py);
  const west = e({ kind: 'fence', x: 12, y: 10, north: false }, 10.5, 10.5);
  assert.deepEqual([west.nx, west.ny, west.dx, west.dy], [1, 0, 1.5, 0]);
  assert.equal(e({ kind: 'fence', x: 12, y: 10, north: false }, 13.5, 10.5).nx, -1);
  const north = e({ kind: 'window', x: 10, y: 12, north: true }, 10.5, 10.5);
  assert.deepEqual([north.nx, north.ny], [0, 1]);
  assert.equal(e({ kind: 'window', x: 10, y: 12, north: true }, 10.5, 13.5).ny, -1);
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
function addZombie(h, x, y, down, extra = {}) {
  h.run(`
    local x, y, down, extra = ...
    local z = {
      getX = function() return x end, getY = function() return y end, getZ = function() return 0 end,
      isDead = function() return false end, isOnFloor = function() return down end,
      isKnockedDown = function() return false end, isFakeDead = function() return false end,
      isCrawling = function() return false end, isOutside = function() return true end,
      getTarget = function() if extra.unaware then return nil end return __players[0] end,
    }
    if extra.lost then z.isTargetVisible = function() return false end end
    table.insert(__zombies, z)
  `, x, y, down, extra);
}
const survive = (h) => h.run('return LocalSurvivor.Reflex.survive(__players[0])');
const queue = (h) => h.run('return __queueTypes(__players[0])');

test('a stomp is a shove next to the downed zombie', () => {
  const h = body();
  addZombie(h, 10.7, 10, true);
  assert.equal(survive(h), true);
  assert.deepEqual(h.run('return __players[0].calls'), ['shove=true', 'attack']);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'STOMP (reflex)');
});

test('a swing clears a leftover shove first', () => {
  const h = body();
  addZombie(h, 11.2, 10, false);
  survive(h);
  assert.deepEqual(h.run('return __players[0].calls'), ['shove=false', 'attack']);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'FIGHT');
});

test('winded with one coming: one short walk away, not a new one every tick', () => {
  const h = body({ ENDURANCE: 0.1 });
  addZombie(h, 13, 10, false);
  survive(h);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'BACK OFF (reflex)');
  assert.equal(queue(h).length, 1);
  const target = h.run('return __players[0].__queue.queue[1].args[2]');
  assert.ok(target, 'walks to the square 3 tiles west');
  survive(h);
  assert.equal(queue(h).length, 1);
  assert.deepEqual(h.run('return __players[0].calls'), []);
});

test('the shove call missing falls back to a plain attack', () => {
  const h = body();
  h.run('__players[0].setDoShove = nil');
  addZombie(h, 10.7, 10, true);
  survive(h);
  assert.deepEqual(h.run('return __players[0].calls'), ['attack']);
  assert.match(h.get('LocalSurvivor.hudData.thought'), /Hitting it/);
});

test('break contact: one walk away, sprint on, sprint off when the stance changes', () => {
  const h = body();
  h.run('__squares["0,10,0"] = { isFree = function() return true end }');
  for (const x of [13, 14, 15]) addZombie(h, x, 10, false);
  survive(h);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'BREAK CONTACT (reflex)');
  assert.deepEqual(queue(h), ['ISWalkToTimedAction']);
  assert.equal(h.run('return __players[0].sprint'), true);
  assert.equal(h.get('LocalSurvivor.reflexState.stance'), 'BREAK');
  assert.notEqual(h.run('return __players[0].sneaking'), true, 'standing to run');
  // The same heading next time keeps the walk.
  survive(h);
  assert.deepEqual(queue(h), ['ISWalkToTimedAction']);
  // Gone: the sprint is let go.
  h.run('__zombies = {}');
  h.run('LocalSurvivor.Reflex.perform(__players[0], { kind = "swing", stance = "FIGHT" }, { zombies = {} }, {})');
  assert.equal(h.run('return __players[0].sprint'), false);
});

test('a run that goes nowhere marks its line and gives the queue back', () => {
  const h = body();
  h.run('__squares["0,10,0"] = { isFree = function() return true end }');
  h.run('LocalSurvivor.tick = 100; LocalSurvivor.Reflex.runAlong(__players[0], { dx = -1, dy = 0 }, 10)');
  assert.deepEqual(queue(h), ['ISWalkToTimedAction']);
  h.run('LocalSurvivor.tick = 130; LocalSurvivor.Reflex.runAlong(__players[0], { dx = -1, dy = 0 }, 10)');
  assert.deepEqual(queue(h), ['ISWalkToTimedAction'], 'not stuck yet');
  h.run('LocalSurvivor.tick = 170; LocalSurvivor.Reflex.runAlong(__players[0], { dx = -1, dy = 0 }, 10)');
  assert.deepEqual(queue(h), []);
  assert.equal(h.run('return LocalSurvivor.reflexState.badLine[5]'), 170, 'west is direction 5');
});

test('hide: crouch, drop the walk, keep the tick so no order walks her out', () => {
  const h = body();
  h.run('LocalSurvivor.reflexState.stance = "BREAK"');
  addZombie(h, 2, 10, false, { lost: true });
  h.run('ISTimedActionQueue.add(ISWalkToTimedAction:new(__players[0], {}))');
  assert.equal(survive(h), true);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'HIDE (reflex)');
  assert.equal(h.run('return __players[0].sneaking'), true);
  assert.deepEqual(queue(h), []);
});

test('sneak past: crouch and let the order walk on', () => {
  const h = body();
  addZombie(h, 19, 10, false, { unaware: true });
  h.run('ISTimedActionQueue.add(ISWalkToTimedAction:new(__players[0], {}))');
  assert.equal(survive(h), false, 'the order keeps the tick');
  assert.equal(h.run('return __players[0].sneaking'), true);
  assert.deepEqual(queue(h), ['ISWalkToTimedAction']);
  // A while later with nothing about, manageSneak stands her up.
  h.run('__zombies = {}; LocalSurvivor.tick = LocalSurvivor.tick + 200; LocalSurvivor.Reflex.manageSneak(__players[0])');
  assert.equal(h.run('return __players[0].sneaking'), false);
});

test('climb: walk to the fence, climb with the game action, then wait out the animation', () => {
  const h = body();
  h.run(`
    -- A low fence on the west edge of 12,10: between 11,10 and 12,10, east of her.
    local fenceSq = { isFree = function() return true end, getX = function() return 12 end, getY = function() return 10 end,
      getZ = function() return 0 end, has = function() return false end }
    local fence = { isHoppable = function() return true end, isTallHoppable = function() return false end,
      getSquare = function() return fenceSq end }
    fenceSq.getObjects = function() return __javaList({ fence }) end
    __squares["12,10,0"] = fenceSq
    __squares["11,10,0"] = { isFree = function() return true end, getX = function() return 11 end, getY = function() return 10 end,
      getZ = function() return 0 end, getObjects = function() return __javaList({}) end }
  `);
  for (const x of [7, 6, 5]) addZombie(h, x, 10, false);
  assert.equal(survive(h), true);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'CLIMB (reflex)');
  assert.deepEqual(queue(h), ['ISWalkToTimedAction', 'ISClimbOverFence']);
  // The climb action left the queue; the body goes over in the animation.
  h.run('ISTimedActionQueue.clear(__players[0])');
  survive(h);
  assert.ok(h.get('LocalSurvivor.reflexState.climbUntil') > h.get('LocalSurvivor.tick'));
  h.run('ISTimedActionQueue.add(ISWalkToTimedAction:new(__players[0], {}))');
  survive(h);
  assert.deepEqual(queue(h), ['ISWalkToTimedAction'], 'the queue is left alone while she climbs');
  assert.equal(h.get('LocalSurvivor.reflexState.stance'), 'CLIMB');
});
