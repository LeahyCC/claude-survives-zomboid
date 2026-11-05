// The soak of 2026-11-05 had her with no weapon in 57 percent of her decisions. These tests pin the
// body side of the fix: common improvised weapons count as armed, she holds a weapon she carries
// without waiting for a brain turn, a pack with nothing in it takes a worn pan, and SEARCH looks in
// the kitchen and garage first while she has no real weapon. The bridge side (the find-weapon
// policy rule) is in bridge/choices.test.mjs. What the real equip action does is a live check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function world(setup = '') {
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
    __players[0] = __makePlayer({ x = 10.5, y = 10.5, live = true, maxWeight = 8 })
    P = __players[0]
    CROWBAR = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, crit = 20, range = 1.25,
      swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
    BAT = __makeItem({ type = "Base.BaseballBat", name = "Baseball Bat", melee = true, dmg = 1.1, crit = 40, range = 1.25,
      swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
    AXE = __makeItem({ type = "Base.Axe", name = "Axe", melee = true, dmg = 2, crit = 20, range = 1.2,
      swing = 3, twoHand = true, cls = { "AXE" }, weight = 3 })
    KNIFE = __makeItem({ type = "Base.KitchenKnife", name = "Kitchen Knife", melee = true, dmg = 0.7, crit = 25,
      range = 0.9, swing = 2, cls = { "SMALL_BLADE" }, weight = 0.7 })
    PEN = __makeItem({ type = "Base.Pen", name = "Pen", melee = true, dmg = 0.1, range = 0.8, swing = 2, cond = 2,
      condMax = 2, cls = { "IMPROVISED" }, weight = 0.1 })
    FORK = __makeItem({ type = "Base.Fork", name = "Fork", melee = true, dmg = 0.1, crit = 5, range = 0.8, swing = 2,
      cond = 3, condMax = 3, cls = { "SMALL_BLADE" }, weight = 0.25 })
    PISTOL = __makeItem({ type = "Base.Pistol", name = "Pistol", weight = 1.5,
      gun = { ammo = "Base.Bullets9mm", mag = "Base.9mmClip", box = "Base.Bullets9mmBox", loaded = 8, max = 15 } })
    APPLE = __makeItem({ type = "Base.Apple", name = "Apple", food = true, hung = -10, weight = 0.2 })
    ${setup}
  `);
  return lua;
}

const order = (lua, line) => lua.run(`LocalSurvivor.Act.execIntent(P, "${line}")`);
const queue = (lua) => lua.run('return __queueTypes(P)');
const queuedName = (lua) => lua.run('local a = ISTimedActionQueue.getTimedActionQueue(P).queue[1]; return a and a.args[2]:getDisplayName() or nil');
const idle = (lua, n = 60) => lua.run(`for i = 1, ${n} do LocalSurvivor.tick = LocalSurvivor.tick + 1; LocalSurvivor.Act.update(P, false) end`);

// ---------- common improvised weapons are weapons, not bare hands ----------
// The stats are the 42.21 item scripts (MaxDamage, CriticalChance, MaxRange, Weight, Swingtime),
// all at full condition. Every one of these counts as armed for the reflex, and a pen, fork or
// spoon does not.
const IMPROVISED = {
  Saucepan: 'dmg = 0.7, crit = 30, range = 1, swing = 2, cls = { "SMALL_BLUNT", "IMPROVISED" }, weight = 0.7',
  'Frying Pan': 'dmg = 0.5, crit = 30, range = 1.1, swing = 3, cls = { "SMALL_BLUNT", "IMPROVISED" }, weight = 1.5',
  'Rolling Pin': 'dmg = 0.5, crit = 15, range = 1.1, swing = 3, cls = { "SMALL_BLUNT" }, weight = 1.5',
  'Kitchen Knife': 'dmg = 0.7, crit = 25, range = 0.9, swing = 2, cls = { "SMALL_BLADE" }, weight = 0.7',
  Hammer: 'dmg = 1, crit = 20, range = 1.1, swing = 3, cls = { "SMALL_BLUNT" }, weight = 1.5',
  Plank: 'dmg = 1, crit = 5, range = 1.2, swing = 3, cls = { "BLUNT", "IMPROVISED" }, weight = 2, twoHand = true',
  Crowbar: 'dmg = 1.15, crit = 20, range = 1.25, swing = 3, cls = { "BLUNT" }, weight = 2, twoHand = true',
  'Baseball Bat': 'dmg = 1.1, crit = 40, range = 1.25, swing = 3, cls = { "BLUNT" }, weight = 2, twoHand = true',
};

test('a saucepan, frying pan, rolling pin, kitchen knife, hammer, plank, crowbar or bat in hand is armed', () => {
  const lua = world();
  for (const [name, facts] of Object.entries(IMPROVISED)) {
    lua.run(`W = __makeItem({ type = "Base.X", name = "${name}", melee = true, ${facts} }); P.primary = W`);
    assert.equal(lua.run('return LocalSurvivor.Core.holdingMelee(P)'), true, name);
    assert.ok(lua.run('return LocalSurvivor.Act.heldScore(P)') >= 5, `${name} scores over the floor`);
  }
  for (const [name, facts] of Object.entries({
    Pen: 'dmg = 0.1, range = 0.8, swing = 2',
    Fork: 'dmg = 0.1, crit = 5, range = 0.8, swing = 2',
    Spoon: 'dmg = 0.1, range = 0.8, swing = 2',
  })) {
    lua.run(`W = __makeItem({ type = "Base.X", name = "${name}", melee = true, ${facts} }); P.primary = W`);
    assert.equal(lua.run('return LocalSurvivor.Core.holdingMelee(P)'), false, name);
  }
});

test('a half-worn pan is still a weapon to hold', () => {
  const lua = world();
  lua.run(`W = __makeItem({ type = "Base.Pan", name = "Frying Pan", melee = true, ${IMPROVISED['Frying Pan']}, cond = 5, condMax = 10 }); P.primary = W`);
  assert.equal(lua.run('return LocalSurvivor.Core.holdingMelee(P)'), true);
});

// ---------- a pack with no weapon in it takes a worn one ----------
const facts = (cond, extra = {}) => ({ cls: 'smallblunt', imp: true, dmg: 0.5, crit: 30, reach: 1.1, wt: 1.5, swing: 3, cond, ...extra });
const worth = (lua, weapon, best) => lua.call('LocalSurvivor.Core.lootKinds', { name: 'W', weight: 1, weapon }, { weaponBest: best }).map((k) => k.kind);

test('with no weapon at all, a pan worn to 60 percent is taken; with one already, it is not', () => {
  const lua = world();
  const worn = facts(0.6);
  const s = lua.call('LocalSurvivor.Core.weaponScore', worn);
  assert.ok(s >= 6.5 && s < 8, `a 60 percent pan scores ${s}, between the bare floor and the normal one`);
  assert.deepEqual(worth(lua, worn, 0), ['weapon']);
  assert.deepEqual(worth(lua, worn, 3), ['weapon'], 'a pen or a nearly broken knife does not count as a weapon');
  assert.deepEqual(worth(lua, worn, 12), [], 'with a saucepan already, the normal floor holds');
});

test('a plunger or a screwdriver is still left, armed or not', () => {
  const lua = world();
  const plunger = { cls: 'smallblunt', imp: true, dmg: 0.5, crit: 5, reach: 1.1, wt: 0.5, swing: 4, cond: 1 };
  assert.deepEqual(worth(lua, plunger, 0), []);
});

// ---------- she holds a weapon she carries, without a brain turn ----------
// A job can run for minutes and the brain only gets a turn between jobs, so she walked past a
// crowbar in her own pack. Act.autoEquip fills empty hands once a second when nothing else is going on.
test('empty hands and a crowbar in the pack: she takes it up on her own', () => {
  const lua = world('P.__items.items = { CROWBAR }; P.primary = nil');
  idle(lua);
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction']);
  assert.equal(queuedName(lua), 'Crowbar');
});

test('a pen in hand does not stop it, and the best weapon wins', () => {
  const lua = world('P.__items.items = { PEN, KNIFE, CROWBAR }; P.primary = PEN');
  idle(lua);
  assert.equal(queuedName(lua), 'Crowbar');
});

test('a kitchen knife is enough to fill empty hands', () => {
  const lua = world('P.__items.items = { KNIFE, FORK }; P.primary = nil');
  idle(lua);
  assert.equal(queuedName(lua), 'Kitchen Knife');
});

test('nothing real in the pack: nothing is queued', () => {
  const lua = world('P.__items.items = { PEN, FORK }; P.primary = nil');
  idle(lua, 200);
  assert.deepEqual(queue(lua), []);
});

test('it waits for a quiet moment: reflex acting, a need job running, asleep', () => {
  const lua = world('P.__items.items = { CROWBAR }; P.primary = nil');
  lua.run('for i = 1, 120 do LocalSurvivor.tick = LocalSurvivor.tick + 1; LocalSurvivor.Act.update(P, true) end');
  assert.deepEqual(queue(lua), [], 'the reflex was acting');
  lua.run('LocalSurvivor.needsJob = { verb = "EAT" }');
  idle(lua, 120);
  assert.deepEqual(queue(lua), [], 'she is eating');
  lua.run('LocalSurvivor.needsJob = false; P.asleep = true');
  idle(lua, 120);
  assert.deepEqual(queue(lua), [], 'she is asleep');
  lua.run('P.asleep = false');
  idle(lua, 60);
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction'], 'and it goes ahead once it is quiet');
});

test('a weapon already in hand is left alone, even when a better one is carried (that is EQUIP)', () => {
  const lua = world('P.__items.items = { KNIFE, AXE }; P.primary = KNIFE');
  idle(lua, 200);
  assert.deepEqual(queue(lua), []);
});

test('a gun in hand is never swapped for a melee weapon', () => {
  const lua = world('P.__items.items = { PISTOL, CROWBAR }; P.primary = PISTOL');
  idle(lua, 200);
  assert.deepEqual(queue(lua), []);
});

test('the weapon Colin chose is never swapped away, and is put back (not the best) when her hands are free', () => {
  const lua = world('P.__items.items = { CROWBAR, BAT, AXE, APPLE }; P.primary = CROWBAR');
  idle(lua, 1);
  lua.run('P.primary = BAT'); // Colin equips it
  idle(lua, 70);
  assert.deepEqual(queue(lua), [], 'in hand: untouched, though the axe is better');
  lua.run('P.primary = APPLE'); // she eats
  idle(lua, 1);
  lua.run('P.primary = nil');
  idle(lua, 600);
  assert.equal(queuedName(lua), 'Baseball Bat');
});

test('an equip that never lands is retried every ten seconds, not every second', () => {
  const lua = world('P.__items.items = { CROWBAR }; P.primary = nil');
  idle(lua);
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction']);
  lua.run('ISTimedActionQueue.clear(P)'); // cut off, the crowbar is not in hand
  idle(lua, 300);
  assert.deepEqual(queue(lua), [], 'backing off');
  idle(lua, 360);
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction'], 'tried again');
});

test('the mod\'s own auto equip is not taken for Colin\'s pick', () => {
  const lua = world('P.__items.items = { CROWBAR }; P.primary = nil');
  idle(lua);
  lua.run('P.primary = CROWBAR; ISTimedActionQueue.clear(P)');
  idle(lua, 1);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), false);
});

// ---------- SEARCH looks in the kitchen and garage first while she has no weapon ----------
test('the room rank puts kitchens, garages and sheds first, closets next, the rest last', () => {
  const lua = world();
  const rank = (key) => lua.call('LocalSurvivor.Act.weaponRoomRank', key);
  for (const name of ['kitchen', 'garage', 'garagestorage', 'shed', 'storageunit', 'toolstorage', 'barn', 'mechanic']) {
    assert.equal(rank(`${name}@10,10,0`), 1, name);
  }
  assert.equal(rank('closet@10,10,0'), 2);
  for (const name of ['bedroom', 'bathroom', 'livingroom', 'hall', 'laundry', 'basement', '?']) {
    assert.equal(rank(`${name}@10,10,0`), 3, name);
  }
});

// A bedroom right where she stands and a kitchen two tiles off. Each room has one container.
const TWO_ROOMS = `
  B = __makeBuilding({ id = "B1", x = 10, y = 10, x2 = 18, y2 = 14, res = true })
  KITCH = __makeRoom({ name = "kitchen", x = 10, y = 10, x2 = 14, y2 = 14 })
  BEDR = __makeRoom({ name = "bedroom", x = 16, y = 10, x2 = 18, y2 = 14 })
  B.def.getRooms = function() return __javaList({ BEDR.def, KITCH.def }) end
  __floor(10, 10, 14, 14, { building = B, room = KITCH })
  __floor(16, 10, 18, 14, { building = B, room = BEDR })
  PAN = __makeItem({ type = "Base.Pan", name = "Frying Pan", melee = true, dmg = 0.5, crit = 30, range = 1.1, swing = 3,
    cls = { "SMALL_BLUNT", "IMPROVISED" }, weight = 1.5 })
  BREAD = __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -30, weight = 0.3 })
  DRAWER = __makeContainer({ items = { PAN }, square = __squares["12,10,0"] })
  KITCH.getContainer = function() return __javaList({ DRAWER }) end
  DRESSER = __makeContainer({ items = { BREAD }, square = __squares["17,10,0"] })
  BEDR.getContainer = function() return __javaList({ DRESSER }) end
  P.x, P.y = 17.5, 10.5
`;

// Step the SEARCH until the first room is finished, and say which one.
function firstRoom(lua) {
  order(lua, '1|SEARCH|0|0|||');
  for (let i = 0; i < 400; i++) {
    lua.run(`
      LocalSurvivor.tick = LocalSurvivor.tick + 1
      LocalSurvivor.Act.update(P, false)
      local q = __queueTypes(P)
      if q[1] == "ISWalkToTimedAction" then __arrive(P)
      elseif q[1] == "ISInventoryTransferAction" then __finishTransfers(P)
      elseif q[1] == "ISEquipWeaponAction" then
        P.primary = ISTimedActionQueue.getTimedActionQueue(P).queue[1].args[2]
        ISTimedActionQueue.clear(P)
      end
    `);
    const done = lua.run('local out = {} for k in pairs(LocalSurvivor.searched.B1 or {}) do out[#out + 1] = k end return out');
    if (done.length > 0) return done;
  }
  throw new Error('no room was finished');
}

test('with no weapon, SEARCH walks past the nearer bedroom to the kitchen first', () => {
  const lua = world(TWO_ROOMS + 'P.__items.items = { }; P.primary = nil');
  const done = firstRoom(lua);
  assert.deepEqual(done, ['kitchen@10,10,0']);
});

test('with a good weapon, SEARCH goes nearest room first as it always did', () => {
  const lua = world(TWO_ROOMS + 'P.__items.items = { AXE }; P.primary = AXE');
  const done = firstRoom(lua);
  assert.deepEqual(done, ['bedroom@16,10,0']);
});

test('a weak weapon in the pack (a saucepan) keeps the hunt on, a crowbar ends it', () => {
  const saucepan = 'SAUCE = __makeItem({ type = "Base.Saucepan", name = "Saucepan", melee = true, dmg = 0.7, crit = 30, range = 1, swing = 2, cls = { "SMALL_BLUNT", "IMPROVISED" }, weight = 0.7 })';
  const weak = world(TWO_ROOMS + saucepan + '; P.__items.items = { SAUCE }; P.primary = SAUCE');
  assert.deepEqual(firstRoom(weak), ['kitchen@10,10,0'], 'a saucepan scores 12, under the line that stops the hunt');
  const strong = world(TWO_ROOMS + 'P.__items.items = { CROWBAR }; P.primary = CROWBAR');
  assert.deepEqual(firstRoom(strong), ['bedroom@16,10,0'], 'a crowbar scores 30');
});
