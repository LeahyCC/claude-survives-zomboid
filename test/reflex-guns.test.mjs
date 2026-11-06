// Guns as a last resort: the fire rule (Stance.fireRule) on plain snapshots, what she does while it
// holds, holstering when it does not, and the shot line. Whether a shot really fires, aims and
// draws zombies is a live-game check, see docs/combat.md. The bridge side is in
// bridge/reflexlog.test.mjs, bridge/crowd.test.mjs and bridge/choices.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();

// A zombie at distance d at this many degrees (0 is east, 90 south), chasing unless told otherwise.
const zed = (d, deg = 0, extra = {}) => {
  const a = (deg * Math.PI) / 180;
  return { d, dx: d * Math.cos(a), dy: d * Math.sin(a), down: false, crawl: false, chase: true, outside: false, ...extra };
};
const line = (deg, extra = {}) => {
  const a = (deg * Math.PI) / 180;
  return { dx: Math.round(Math.cos(a)), dy: Math.round(Math.sin(a)), ...extra };
};
const PISTOL = { n: 'Pistol', held: true, loaded: 8, ammo: 12, canLoad: true, ready: true, rack: false, minR: 0, maxR: 20 };
const fit = { armed: false, reach: 0, hp: 100, endurance: 1, panic: 0, heavy: 0, tired: 0, inside: false, bleeding: 0, gun: PISTOL, heldGun: true };
const rule = (snap) => lua.call('LocalSurvivor.Stance.fireRule', { ...fit, ...snap });
const decide = (snap) => lua.call('LocalSurvivor.Reflex.decide', { ...fit, ...snap });

// Three on her, all in reach, hp falling, nothing to break to.
const THREE = { zombies: [zed(1.1, 0), zed(1.4, 120), zed(2.2, 240)], hpFalling: true };
// A corridor: the two ways along it, each with one on it.
const CORRIDOR = { zombies: [zed(4, 0), zed(5, 180)], lines: [line(0), line(180)] };

// ---------- the fire rule: yes ----------

test('fire rule: three standing in reach, nowhere to go, hp falling: cornered', () => {
  assert.deepEqual(rule(THREE), { yes: true, why: 'cornered' });
});

test('fire rule: grabbed with a second one about: cornered', () => {
  const r = rule({ zombies: [zed(1, 0, { grab: true }), zed(5, 90)], hpFalling: true });
  assert.deepEqual(r, { yes: true, why: 'cornered' });
});

test('fire rule: 2 to 4 on the only ways out: blocked', () => {
  assert.deepEqual(rule(CORRIDOR), { yes: true, why: 'blocked' });
  const four = { zombies: [zed(4, 0), zed(5, 180), zed(6, 5), zed(6, 175)], lines: CORRIDOR.lines };
  assert.deepEqual(rule(four), { yes: true, why: 'blocked' });
});

test('fire rule: a door with one of them at it, and no other way, is blocked', () => {
  const r = rule({ zombies: [zed(3.5, 0), zed(5, 180)], lines: [], doors: [{ dx: 4, dy: 0, d: 4 }] });
  assert.deepEqual(r, { yes: true, why: 'blocked' });
});

test('fire rule: an empty gun with ammo to load it counts, and so does one with rounds and none spare', () => {
  assert.equal(rule({ ...THREE, gun: { ...PISTOL, loaded: 0, ammo: 12, ready: false } }).yes, true);
  assert.equal(rule({ ...THREE, gun: { ...PISTOL, loaded: 3, ammo: 0 } }).yes, true);
});

test('fire rule: one still in the bag counts: she can draw it', () => {
  assert.equal(rule({ ...THREE, heldGun: false, gun: { ...PISTOL, held: false } }).yes, true);
});

// ---------- the fire rule: no ----------

test('fire rule: never for one zombie, even grabbed and bleeding with nowhere to go', () => {
  assert.deepEqual(rule({ zombies: [zed(1, 0, { grab: true })], hpFalling: true, bleeding: 2, hp: 10 }), { yes: false, why: 'one' });
  assert.deepEqual(rule({ zombies: [zed(4, 0)], lines: [line(0)] }), { yes: false, why: 'one' });
  // A second one outside the group is still one.
  assert.equal(rule({ zombies: [zed(1, 0, { grab: true }), zed(10, 90)], hpFalling: true }).yes, false);
  // A downed one is not a second.
  assert.equal(rule({ zombies: [zed(1, 0, { grab: true }), zed(1, 90, { down: true })], hpFalling: true }).yes, false);
  // Nor one across a fence.
  assert.equal(rule({ zombies: [zed(1, 0, { grab: true }), zed(3, 90, { across: true })], hpFalling: true }).yes, false);
});

test('fire rule: no gun, or a gun with no way to load it', () => {
  assert.equal(rule({ ...THREE, gun: undefined, heldGun: false }).why, 'no gun');
  assert.equal(rule({ ...THREE, gun: { ...PISTOL, loaded: 0, ammo: 0, ready: false } }).why, 'no gun');
  // Loose rounds and no magazine anywhere: a magazine gun cannot take them.
  assert.equal(rule({ ...THREE, gun: { ...PISTOL, loaded: 0, ammo: 12, canLoad: false, ready: false } }).why, 'no gun');
});

test('fire rule: never in the building she sleeps in', () => {
  assert.deepEqual(rule({ ...THREE, inBase: true }), { yes: false, why: 'base' });
  assert.deepEqual(rule({ ...CORRIDOR, inBase: true }), { yes: false, why: 'base' });
});

test('fire rule: at night in town only when cornered and under 50 hp', () => {
  const night = { night: true, town: true };
  assert.deepEqual(rule({ ...CORRIDOR, ...night }), { yes: false, why: 'night' }, 'not for a blocked way');
  assert.deepEqual(rule({ ...THREE, ...night, hp: 60 }), { yes: false, why: 'night' }, 'not cornered at 60');
  assert.deepEqual(rule({ ...THREE, ...night, hp: 50 }), { yes: false, why: 'night' }, 'not at exactly 50');
  assert.deepEqual(rule({ ...THREE, ...night, hp: 49 }), { yes: true, why: 'cornered' });
  // Night in the country, or day in town: the plain rule.
  assert.equal(rule({ ...CORRIDOR, night: true, town: false }).yes, true);
  assert.equal(rule({ ...CORRIDOR, night: false, town: true }).yes, true);
  assert.equal(rule({ ...THREE, night: true, town: false, hp: 90 }).yes, true);
});

test('fire rule: cornered needs hp falling', () => {
  assert.deepEqual(rule({ ...THREE, hpFalling: false }), { yes: false, why: 'no need' });
});

test('fire rule: cornered needs three in reach', () => {
  const two = { zombies: [zed(1.1, 0), zed(1.4, 120), zed(3, 240)], hpFalling: true };
  assert.equal(rule(two).yes, false);
  // An unaware one past the close line does not press her.
  assert.equal(rule({ zombies: [zed(1.1, 0), zed(1.4, 120), zed(2.2, 240, { chase: false })], hpFalling: true }).yes, false);
});

test('fire rule: a free door, fence or window is a way out, so she takes it instead', () => {
  const door = { dx: -3, dy: 0, d: 3 };
  assert.equal(rule({ zombies: [zed(1.1, 20), zed(1.4, 60), zed(2.2, -30)], hpFalling: true, doors: [door] }).yes, false, 'a door behind her');
  const fence = { kind: 'fence', d: 3, dx: -3, dy: 0, nx: -1, ny: 0, key: 'k' };
  assert.equal(rule({ zombies: [zed(1.1, 20), zed(1.4, 60), zed(2.2, -30)], hpFalling: true, barriers: [fence] }).yes, false, 'a fence behind her');
  assert.equal(rule({ ...CORRIDOR, doors: [{ dx: 0, dy: 3, d: 3 }] }).yes, false, 'a side door out of the corridor');
  // A door with one standing at it is no way out.
  assert.equal(rule({ zombies: [zed(1.1, 0), zed(1.4, 120), zed(2.2, 240)], hpFalling: true, doors: [{ dx: 1.5, dy: 0, d: 1.5 }] }).yes, true);
});

test('fire rule: blocked needs every way shut, a small group, and one of them awake to her', () => {
  assert.equal(rule({ ...CORRIDOR, lines: [line(0), line(180), line(90)] }).yes, false, 'a free line');
  assert.equal(rule({ ...CORRIDOR, lines: [line(0), line(180), line(90, { blocked: true })] }).yes, true, 'a line a run went nowhere on is no way');
  assert.equal(rule({ ...CORRIDOR, zombies: [zed(4, 0), zed(5, 180), zed(5, 10), zed(6, 170), zed(6, 5)] }).yes, false, 'five is a pack, not a small group');
  assert.equal(rule({ ...CORRIDOR, zombies: [zed(4, 0, { chase: false }), zed(5, 180, { chase: false })] }).yes, false, 'none has seen her: no reason to wake them');
  // Unknown ground is not a blocked way.
  assert.equal(rule({ zombies: CORRIDOR.zombies }).yes, false, 'no lines read');
  assert.equal(rule({ zombies: CORRIDOR.zombies, lines: [] }).yes, false, 'no line and no door');
});

test('fire rule: the guns flag turns it all off', () => {
  assert.deepEqual(rule({ ...THREE, flags: { guns: false } }), { yes: false, why: 'off' });
  assert.equal(decide({ ...THREE, flags: { guns: false } }).stance === 'SHOOT', false);
  assert.notEqual(decide({ zombies: [], flags: { guns: false } }).kind, 'holster');
});

// ---------- while the rule holds ----------

test('in the bag: draw it', () => {
  const a = decide({ ...THREE, heldGun: false, gun: { ...PISTOL, held: false } });
  assert.equal(a.kind, 'draw');
  assert.equal(a.stance, 'SHOOT');
  assert.equal(a.why, 'cornered');
});

test('shoots the nearest standing zombie in range', () => {
  const a = decide({ zombies: [zed(2.2, 240), zed(1.1, 0), zed(1.4, 120)], hpFalling: true });
  assert.equal(a.kind, 'shoot');
  assert.equal(a.index, 2);
  assert.equal(a.stance, 'SHOOT');
  // Not a downed one, not one behind a wall, not inside the gun's minimum.
  assert.equal(decide({ zombies: [zed(1, 0, { down: true }), zed(1.1, 90), zed(1.4, 180), zed(2.2, 270)], hpFalling: true }).index, 2);
  assert.equal(decide({ zombies: [zed(1.1, 0, { wall: true }), zed(1.4, 120), zed(2.2, 240)], hpFalling: true }).index, 2);
  const a2 = decide({ ...THREE, gun: { ...PISTOL, minR: 1.3 } });
  assert.equal(a2.kind, 'shoot');
  assert.equal(a2.index, 2);
});

test('all too close for the gun: shove. All too far: hold the aim', () => {
  assert.equal(decide({ ...THREE, gun: { ...PISTOL, minR: 5 } }).kind, 'shove');
  assert.equal(decide({ ...CORRIDOR, gun: { ...PISTOL, maxR: 3 } }).kind, 'aim');
});

test('rack before shooting when the chamber wants it', () => {
  assert.equal(decide({ ...THREE, gun: { ...PISTOL, ready: false, rack: true } }).kind, 'rack');
});

test('reload waits while a zombie is within 2 tiles: shove instead', () => {
  const empty = { ...PISTOL, loaded: 0, ammo: 12, ready: false };
  const close = decide({ ...THREE, gun: empty });
  assert.equal(close.kind, 'shove');
  assert.equal(close.why, 'reload');
  assert.equal(close.index, 1);
  // Exactly 2 tiles still counts as close.
  assert.equal(decide({ zombies: [zed(2, 0), zed(2.2, 120), zed(2.3, 240)], hpFalling: true, gun: empty }).kind, 'shove');
  // Over 2: there is time.
  assert.equal(decide({ zombies: [zed(2.1, 0), zed(2.2, 120), zed(2.3, 240)], hpFalling: true, gun: empty }).kind, 'reload');
  assert.equal(decide({ ...CORRIDOR, gun: empty }).kind, 'reload');
});

// ---------- holster, and leaving ----------

test('a gun in hand with no fire rule goes away, with nothing near as well as with one close', () => {
  const quiet = decide({ zombies: [] });
  assert.equal(quiet.kind, 'holster');
  assert.equal(quiet.stance, 'HOLSTER');
  assert.equal(quiet.urgent, false, 'nothing near: it waits behind the job she is on');
  const near = decide({ zombies: [zed(6, 0)] });
  assert.equal(near.kind, 'holster');
  assert.equal(near.urgent, true, 'one near: now');
  assert.equal(near.why, 'one');
  assert.equal(decide({ zombies: [zed(15, 0)] }).kind, 'holster');
});

test('with one right on her there is no time: it is the usual shove', () => {
  const a = decide({ zombies: [zed(1, 0)] });
  assert.equal(a.kind, 'shove');
  assert.equal(a.why, 'unarmed');
  // Exactly 2 tiles has no time either. Over it she has.
  assert.notEqual(decide({ zombies: [zed(2, 0)] }).kind, 'holster');
  assert.equal(decide({ zombies: [zed(2.1, 0)] }).kind, 'holster');
});

test('no gun in hand means no holster and none of these rules: the old stances are untouched', () => {
  const plain = { armed: true, weaponScore: 34, reach: 1.5, gun: undefined, heldGun: false };
  assert.equal(decide({ ...plain, zombies: [] }).kind, 'none');
  assert.equal(decide({ ...plain, zombies: [zed(1.2)] }).kind, 'swing');
  // A gun in the bag changes nothing while the rule says no.
  assert.equal(decide({ ...plain, gun: { ...PISTOL, held: false }, zombies: [zed(1.2)] }).kind, 'swing');
});

test('after a shot she leaves: the usual getting away, why shot', () => {
  const shot = { shot: { dx: 1, dy: 0, d: 1 }, heldGun: false, gun: { ...PISTOL, held: false } };
  const a = decide({ ...shot, zombies: [zed(5, 0)] });
  assert.equal(a.kind, 'break');
  assert.equal(a.why, 'shot');
  assert.ok(a.dx < 0, 'away from it');
  assert.equal(decide({ ...shot, endurance: 0.2, zombies: [zed(5, 0)] }).kind, 'flee');
  // One right on her is still shoved first.
  assert.equal(decide({ ...shot, zombies: [zed(1, 0)] }).kind, 'shove');
});

test('after a shot with nothing near she still walks off, along a line away from the spot', () => {
  const shot = { shot: { dx: 3, dy: 0, d: 3 }, heldGun: false, gun: undefined, lines: [line(0), line(180), line(90)] };
  const a = decide({ ...shot, zombies: [] });
  assert.equal(a.kind, 'break');
  assert.equal(a.why, 'shot');
  assert.ok(a.dx < 0, 'west, away from the spot to the east');
  // Standing on the spot: any open line will do.
  const there = decide({ ...shot, shot: { dx: 0, dy: 0, d: 0 }, zombies: [] });
  assert.equal(there.kind, 'break');
  // No ground read, no heading: she does not walk.
  assert.equal(decide({ ...shot, lines: undefined, shot: { dx: 0, dy: 0, d: 0 }, zombies: [] }).kind, 'none');
});

// ---------- the game-facing side, with stubs ----------

const WORLD = `
  PISTOL = __makeItem({ type = "Base.Pistol", name = "Pistol", weight = 1.5, range = 20, attachment = "Holster",
    gun = { ammo = "Base.Bullets9mm", mag = "Base.9mmClip", box = "Base.Bullets9mmBox", loaded = 7, max = 15,
      chambered = true, chamber = true, clip = true, noise = 100 } })
  EMPTY = __makeItem({ type = "Base.Pistol", name = "Pistol", weight = 1.5, range = 20,
    gun = { ammo = "Base.Bullets9mm", mag = "Base.9mmClip", box = "Base.Bullets9mmBox", loaded = 0, max = 15,
      chambered = false, chamber = true, clip = true, noise = 100 } })
  BARE_GUN = __makeItem({ type = "Base.Pistol", name = "Pistol", weight = 1.5, range = 20,
    gun = { ammo = "Base.Bullets9mm", mag = "Base.9mmClip", box = "Base.Bullets9mmBox", loaded = 0, max = 15,
      chambered = false, chamber = true, clip = false, noise = 100 } })
  ROUNDS = __makeItem({ type = "Base.Bullets9mm", name = "9mm Bullets", tags = { [ItemTag.AMMO] = true }, count = 12 })
  BAT = __makeItem({ type = "Base.BaseballBat", name = "Baseball Bat", melee = true, dmg = 1.1, crit = 40, range = 1.25,
    swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
`;
function world(setup = '') {
  const h = createHarness();
  h.autoload();
  h.run(`
    ${WORLD}
    P = __makePlayer({ x = 10, y = 10, stats = { ENDURANCE = 1 } })
    P.calls = {}
    function P:isAttackStarted() return false end
    function P:isAuthorizeShoveStomp() return true end
    function P:isAuthorizeMeleeAction() return true end
    function P:setDoShove(v) table.insert(self.calls, "shove=" .. tostring(v)) end
    function P:DoAttack(c) table.insert(self.calls, "attack") end
    function P:setIsAiming(v) table.insert(self.calls, "aim=" .. tostring(v)) end
    function P:isDoShove() return self.shoving == true end
    function P:isSneaking() return false end
    __players[0] = P
    function addZ(x, y)
      table.insert(__zombies, {
        getX = function() return x end, getY = function() return y end, getZ = function() return 0 end,
        isDead = function() return false end, isOnFloor = function() return false end,
        isKnockedDown = function() return false end, isFakeDead = function() return false end,
        isCrawling = function() return false end, isOutside = function() return true end,
        getTarget = function() return P end, isTargetVisible = function() return true end,
      })
    end
    ${setup}
  `);
  return h;
}
const survive = (h) => h.run('return LocalSurvivor.Reflex.survive(P)');
const queue = (h) => h.run('return __queueTypes(P)');
const headName = (h) => h.run('local a = P.__queue and P.__queue.queue[1]; return a and a.args[2]:getDisplayName() or nil');
// Three in reach, and a hit just now.
const CORNERED = 'addZ(11.2, 10); addZ(10, 11.3); addZ(8.5, 8.5); LocalSurvivor.reflexState.hitTick = LocalSurvivor.tick';

test('holster: a gun in hand with nothing near goes in the pack and the best melee weapon comes out', () => {
  const h = world('P.__items.items = { PISTOL, BAT }; P.primary = PISTOL');
  assert.equal(survive(h), false, 'the job she is on keeps the tick');
  assert.deepEqual(queue(h), ['ISUnequipAction', 'ISEquipWeaponAction']);
  assert.equal(h.run('return P.__queue.queue[1].args[2]:getDisplayName()'), 'Pistol');
  assert.equal(h.run('return P.__queue.queue[2].args[2]:getDisplayName()'), 'Baseball Bat');
  survive(h);
  assert.equal(queue(h).length, 2, 'not queued again while it runs');
});

test('holster: this includes a gun put there by hand, and no melee weapon means just the unequip', () => {
  const h = world('P.__items.items = { PISTOL, BAT }; P.primary = BAT');
  h.run('LocalSurvivor.Act.watchHand(P); P.primary = PISTOL; LocalSurvivor.Act.watchHand(P)');
  survive(h);
  assert.deepEqual(queue(h), ['ISUnequipAction', 'ISEquipWeaponAction']);
  const none = world('P.__items.items = { PISTOL }; P.primary = PISTOL');
  survive(none);
  assert.deepEqual(queue(none), ['ISUnequipAction']);
});

test('holster: waits behind a walk when nothing is near, and clears it when one is', () => {
  const quiet = world('P.__items.items = { PISTOL }; P.primary = PISTOL; ISTimedActionQueue.add(ISWalkToTimedAction:new(P, {}))');
  survive(quiet);
  assert.deepEqual(queue(quiet), ['ISWalkToTimedAction', 'ISUnequipAction']);
  const near = world('P.__items.items = { PISTOL }; P.primary = PISTOL; ISTimedActionQueue.add(ISWalkToTimedAction:new(P, {})); addZ(15, 10)');
  assert.equal(survive(near), true, 'the reflex took this one');
  assert.deepEqual(queue(near), ['ISUnequipAction']);
});

test('holster: a free holster or back slot takes it instead of the pack', () => {
  const h = world(`
    P.__items.items = { PISTOL, BAT }; P.primary = PISTOL
    BAR = {
      availableSlot = { { def = { attachments = { Holster = "Holster Right" }, name = "Holster" } } },
      attachedItems = {},
      isInHotbar = function() return false end,
      canBeAttached = function(_, slot, item) return slot.def.attachments[item:getAttachmentType()] ~= nil end,
      attachItem = function(_, item, slot, index) ATTACHED = { item:getDisplayName(), slot, index } end,
    }
    function getPlayerHotbar() return BAR end
  `);
  survive(h);
  assert.deepEqual(h.run('return ATTACHED'), ['Pistol', 'Holster Right', 1]);
  assert.deepEqual(queue(h), ['ISEquipWeaponAction'], 'then the melee weapon, no unequip');
});

test('holster: a full slot, or a gun that already has a slot, goes through the unequip', () => {
  const full = world(`
    P.__items.items = { PISTOL }; P.primary = PISTOL
    BAR = { availableSlot = { { def = { attachments = { Holster = "H" } } } }, attachedItems = { {} },
      isInHotbar = function() return false end, canBeAttached = function() return true end,
      attachItem = function() ATTACHED = true end }
    function getPlayerHotbar() return BAR end
  `);
  survive(full);
  assert.equal(full.run('return ATTACHED'), undefined);
  assert.deepEqual(queue(full), ['ISUnequipAction']);
  const slotted = world(`
    P.__items.items = { PISTOL }; P.primary = PISTOL
    BAR = { availableSlot = {}, attachedItems = {}, isInHotbar = function() return true end }
    function getPlayerHotbar() return BAR end
  `);
  survive(slotted);
  assert.deepEqual(queue(slotted), ['ISUnequipAction']);
});

test('holster: a game that keeps refusing does not freeze her with a zombie walking up', () => {
  const h = world('P.__items.items = { PISTOL }; P.primary = PISTOL; addZ(15, 10)');
  const tries = () => {
    for (let i = 0; i < 3; i++) {
      survive(h);
      h.run('ISTimedActionQueue.clear(P); LocalSurvivor.tick = LocalSurvivor.tick + 130');
    }
  };
  tries();
  assert.equal(h.get('LocalSurvivor.reflexState.holsterTries'), 3);
  survive(h); // the fourth gives up
  assert.ok(h.get('LocalSurvivor.reflexState.holsterOff') > h.get('LocalSurvivor.tick'));
  h.run('LocalSurvivor.tick = LocalSurvivor.tick + 130; P.calls = {}');
  assert.notEqual(h.run('return LocalSurvivor.Reflex.decide((LocalSurvivor.Reflex.snapshot(P))).kind'), 'holster', 'the usual rules have her');
  h.run('LocalSurvivor.tick = LocalSurvivor.tick + 600');
  assert.equal(h.run('return LocalSurvivor.Reflex.decide((LocalSurvivor.Reflex.snapshot(P))).kind'), 'holster', 'and later she tries again');
  // Once the gun has left her hand the count starts over.
  h.run('LocalSurvivor.reflexState.holsterTries = 2; P.primary = nil; LocalSurvivor.Reflex.snapshot(P)');
  assert.equal(h.get('LocalSurvivor.reflexState.holsterTries'), 0);
});

test('the fire rule draws a gun from the pack, clearing what she was at', () => {
  const h = world(`P.__items.items = { PISTOL, BAT, ROUNDS }; P.primary = BAT; ISTimedActionQueue.add(ISWalkToTimedAction:new(P, {})); ${CORNERED}`);
  assert.equal(survive(h), true);
  assert.deepEqual(queue(h), ['ISEquipWeaponAction']);
  assert.equal(headName(h), 'Pistol');
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'DRAW (reflex)');
  survive(h);
  assert.equal(queue(h).length, 1, 'the draw runs, it is not started again');
});

test('a gun in a hotbar slot is drawn the way the hotbar key does it', () => {
  const h = world(`
    P.__items.items = { PISTOL, ROUNDS }
    BAR = { isInHotbar = function() return true end, equipItem = function(_, item) DRAWN = item:getDisplayName() end }
    function getPlayerHotbar() return BAR end
    ${CORNERED}
  `);
  survive(h);
  assert.equal(h.run('return DRAWN'), 'Pistol');
});

test('with it in hand she aims and fires through the game\'s attack hook, not a silent DoAttack', () => {
  const h = world(`P.__items.items = { PISTOL, ROUNDS }; P.primary = PISTOL; ${CORNERED}`);
  assert.equal(survive(h), true);
  assert.equal(h.run('return P.hooked'), 1);
  assert.deepEqual(h.run('return P.calls'), ['aim=true', 'shove=false', 'attack']);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'SHOOT (reflex)');
  // An attack already running is not started over.
  h.run('function P:isAttackStarted() return true end; P.calls = {}');
  survive(h);
  assert.equal(h.run('return P.hooked'), 1);
  assert.deepEqual(h.run('return P.calls'), ['aim=true']);
});

test('aiming comes off with the next thing she does', () => {
  const h = world(`P.__items.items = { PISTOL, ROUNDS }; P.primary = PISTOL; ${CORNERED}`);
  survive(h);
  h.run('P.calls = {}; __zombies = {}; LocalSurvivor.reflexState.shot = nil');
  survive(h);
  assert.ok(h.run('return P.calls').includes('aim=false'));
});

test('the rack is queued once', () => {
  const h = world(`
    PISTOL = __makeItem({ type = "Base.Pistol", name = "Pistol", range = 20,
      gun = { ammo = "Base.Bullets9mm", mag = "Base.9mmClip", loaded = 5, max = 15, chambered = false, chamber = true, clip = true } })
    P.__items.items = { PISTOL }; P.primary = PISTOL; ${CORNERED}
  `);
  survive(h);
  assert.deepEqual(queue(h), ['ISRackFirearm']);
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'RACK (reflex)');
  survive(h);
  assert.deepEqual(queue(h), ['ISRackFirearm']);
});

test('reload: with room it starts once, and one stepping close gets a shove, which cuts it', () => {
  const h = world(`P.__items.items = { EMPTY, ROUNDS }; P.primary = EMPTY; addZ(12.2, 10); addZ(10, 12.3); addZ(8.4, 8.4); LocalSurvivor.reflexState.hitTick = LocalSurvivor.tick`);
  survive(h);
  assert.deepEqual(queue(h), ['ISReloadWeaponAction'], 'none within 2');
  assert.equal(h.get('LocalSurvivor.hudData.action'), 'RELOAD (reflex)');
  survive(h);
  assert.deepEqual(queue(h), ['ISReloadWeaponAction'], 'not started again');
  h.run('addZ(11, 10)');
  survive(h);
  assert.deepEqual(h.run('return P.calls').slice(-2), ['shove=true', 'attack']);
  assert.deepEqual(queue(h), []);
  assert.equal(h.run('return P.hooked'), undefined, 'and no shot');
});

test('a magazine gun with loose rounds and no magazine anywhere is not a usable gun', () => {
  const h = world(`P.__items.items = { BARE_GUN, ROUNDS, BAT }; P.primary = BAT; ${CORNERED}`);
  survive(h);
  assert.equal(h.get('LocalSurvivor.hudData.action') === 'DRAW (reflex)', false);
});

test('a shot writes the log line at once, and the area counts as just fired in', () => {
  const h = world('P.__items.items = { PISTOL }; P.primary = PISTOL; P.x = 10662.7; P.y = 9831.2');
  h.run('LocalSurvivor.tick = 900; LocalSurvivor.Reflex.onShot(P, PISTOL)');
  const lines = String(h.run('return __files["local_reflex.txt"] or ""')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ t: 'shot', tick: 900, gun: 'Pistol', noiseR: 100, x: 10662, y: 9831 }]);
  const shot = h.run('local s = LocalSurvivor.Reflex.snapshot(P); return s.shot');
  assert.deepEqual(shot, { dx: 0, dy: 0, d: 0 });
});

test('the event is hooked up, and a shove or a swing with a bat is not a shot', () => {
  const h = world('P.__items.items = { PISTOL, BAT }; P.primary = PISTOL');
  const none = () => h.run('return __files["local_reflex.txt"]');
  assert.ok(h.run('return #__events.OnWeaponSwingHitPoint') >= 1);
  h.run('__events.OnWeaponSwingHitPoint[1](P, BAT)');
  assert.equal(none(), undefined, 'a bat');
  h.run('P.shoving = true; __events.OnWeaponSwingHitPoint[1](P, PISTOL)');
  assert.equal(none(), undefined, 'a shove with a gun in hand');
  h.run('P.shoving = false; __events.OnWeaponSwingHitPoint[1](P, PISTOL)');
  assert.match(none(), /"t":"shot"/);
});

test('she walks off until she is clear of the shot, or the time runs out', () => {
  const h = world('P.__items.items = {}');
  h.run('LocalSurvivor.tick = 100; LocalSurvivor.reflexState.shot = { x = 10, y = 10, tick = 100 }');
  assert.ok(h.run('return LocalSurvivor.Reflex.snapshot(P).shot'));
  h.run('P.x = 30');
  assert.equal(h.run('return LocalSurvivor.Reflex.snapshot(P).shot'), undefined, '20 tiles off');
  h.run('P.x = 10; LocalSurvivor.reflexState.shot = { x = 10, y = 10, tick = 100 }; LocalSurvivor.tick = 1899');
  assert.ok(h.run('return LocalSurvivor.Reflex.snapshot(P).shot'));
  h.run('LocalSurvivor.tick = 1900');
  assert.equal(h.run('return LocalSurvivor.Reflex.snapshot(P).shot'), undefined, '30 seconds on');
});

test('the snapshot reads the gun only when it matters, and reads night, town and hits for the rule', () => {
  const h = world(`P.__items.items = { PISTOL, ROUNDS }; __time.hour = 23`);
  assert.equal(h.run('return LocalSurvivor.Reflex.snapshot(P).gun'), undefined, 'nothing near and none in hand');
  h.run('addZ(14, 10); LocalSurvivor.reflexState.hitTick = LocalSurvivor.tick');
  const s = h.run('return LocalSurvivor.Reflex.snapshot(P)');
  assert.equal(s.gun.n, 'Pistol');
  assert.equal(s.gun.held, false);
  assert.equal(s.gun.ammo, 12);
  assert.equal(s.gun.loaded, 8, 'seven and one chambered');
  assert.equal(s.gun.ready, true);
  assert.equal(s.gun.rack, false);
  assert.equal(s.gun.canLoad, true);
  assert.equal(s.night, true);
  assert.equal(s.hpFalling, true);
  assert.equal(s.heldGun, false);
});

test('a gun on Safe comes off it when she holds it, instead of reading as empty', () => {
  const h = world(`
    SAFE = __makeItem({ type = "Base.AssaultRifle", name = "M16", range = 20,
      gun = { ammo = "Base.556", mag = "Base.556Clip", loaded = 20, max = 30, chambered = true, chamber = true, clip = true, selectFire = "Safe" } })
    P.__items.items = { SAFE }; P.primary = SAFE
  `);
  const s = h.run('return LocalSurvivor.Reflex.gunInfo(P)');
  assert.equal(s.ready, true);
  assert.equal(h.run('return SAFE:getFireMode()'), 'Semi');
});

test('the building she sleeps in becomes her base, per character', () => {
  const h = world(`
    HOUSE = { getDef = function() return { getIDString = function() return "house-1" end } end }
    OTHER = { getDef = function() return { getIDString = function() return "house-2" end } end }
    P.sq = { getBuilding = function() return HOUSE end }
    P.mod = {}
    function P:getModData() return self.mod end
  `);
  assert.equal(h.run('return LocalSurvivor.Reflex.inBase(P)'), false, 'awake in a house she has never slept in');
  h.run('P.asleep = true');
  assert.equal(h.run('return LocalSurvivor.Reflex.inBase(P)'), true);
  h.run('P.asleep = false');
  assert.equal(h.run('return LocalSurvivor.Reflex.inBase(P)'), true, 'and it stays her base when she wakes');
  h.run('P.sq = { getBuilding = function() return OTHER end }');
  assert.equal(h.run('return LocalSurvivor.Reflex.inBase(P)'), false, 'next door is not');
  h.run('P.sq = { getBuilding = function() return nil end }');
  assert.equal(h.run('return LocalSurvivor.Reflex.inBase(P)'), false, 'nor outside');
});

test('town is the zone under her, or a few houses near', () => {
  const h = world('P.sq = { getZoneType = function() return ZONE end }');
  const town = () => h.run('return LocalSurvivor.Reflex.inTown(P)');
  h.run('ZONE = "TownZone"');
  assert.equal(town(), true);
  h.run('ZONE = "Forest"; LocalSurvivor.seen.near = { "a", "b" }');
  assert.equal(town(), false, 'two buildings out in the woods');
  h.run('LocalSurvivor.seen.near = { "a", "b", "c" }');
  assert.equal(town(), true);
});

test('a SHOOT stance goes in the log, and the standing count is watched during it', () => {
  const h = createHarness();
  h.autoload();
  const note = (a, snap, tick) => h.call('LocalSurvivor.ReflexLog.note', a, snap, tick, 0);
  const z = (d) => ({ d, dx: d, dy: 0, chase: true });
  note({ kind: 'shoot', stance: 'SHOOT', why: 'cornered' }, { zombies: [z(2), z(2), z(2)] }, 10);
  note({ kind: 'shoot', stance: 'SHOOT', why: 'cornered' }, { zombies: [z(2), z(2), z(2), z(3)] }, 100);
  h.run('LocalSurvivor.ReflexLog.flush(100)');
  const lines = String(h.run('return __files["local_reflex.txt"]')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].stance, 'SHOOT');
  assert.equal(lines[0].why, 'cornered');
  assert.ok(lines.some((l) => l.t === 'count' && l.to === 4));
});
