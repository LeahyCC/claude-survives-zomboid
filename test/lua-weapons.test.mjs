// Which weapon to wield (EQUIP, and a SEARCH that took a better one) and the DROP verb. The score
// itself is tested in lua-loot.test.mjs. What the real equip and drop actions do in the game is a
// live check: here a test finishes them by hand.

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
    ${setup}
  `);
  return lua;
}

const order = (lua, line) => lua.run(`LocalSurvivor.Act.execIntent(P, "${line}")`);
const tick = (lua, n = 1) => lua.run(`for i = 1, ${n} do LocalSurvivor.tick = LocalSurvivor.tick + 1; LocalSurvivor.Act.update(P, false) end`);
const result = (lua) => lua.get('LocalSurvivor.result');
const queue = (lua) => lua.run('return __queueTypes(P)');
const choose = (lua, cands, held) => lua.call('LocalSurvivor.Act.chooseWeapon', cands.map((score) => ({ score })), held) ?? null;

// ---------- chooseWeapon ----------
test('chooseWeapon takes the best score when his hands are empty or hold a pen', () => {
  const lua = world();
  assert.equal(choose(lua, [20, 34, 30], 0), 2);
  assert.equal(choose(lua, [8.7], 0), 1, 'a kitchen knife beats bare hands');
});

test('chooseWeapon ignores everything under the weapon floor', () => {
  const lua = world();
  assert.equal(choose(lua, [0, 0], 0), null);
  assert.equal(choose(lua, [3.9], 0), null);
  assert.equal(choose(lua, [], 0), null);
});

test('chooseWeapon only swaps for a clear gain, so two close weapons never flap', () => {
  const lua = world();
  // A crowbar in hand (30.2), a bat in the bag (33.7): not enough to swap.
  assert.equal(choose(lua, [30.2, 33.7], 30.2), null);
  // The bat is in hand now. The crowbar is worse, so nothing swaps back.
  assert.equal(choose(lua, [30.2, 33.7], 33.7), null);
  // An axe (51.3) is a clear gain over either.
  assert.equal(choose(lua, [30.2, 33.7, 51.3], 33.7), 3);
});

test('chooseWeapon swaps once wear makes the one in hand clearly worse', () => {
  const lua = world();
  assert.equal(choose(lua, [33.7, 21.1], 21.1), 1);
  assert.equal(choose(lua, [33.7, 28], 28), null, 'a bat over a half-worn crowbar is still under 25 percent better');
});

// ---------- EQUIP ----------
test('EQUIP wields the best weapon, not the first one, when a pen is in hand', () => {
  const lua = world('P.__items.items = { PEN, KNIFE, CROWBAR, FORK }; P.primary = PEN');
  order(lua, '1|EQUIP|0|0|||');
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction']);
  const act = lua.run('local a = ISTimedActionQueue.getTimedActionQueue(P).queue[1]; return { a.args[2]:getDisplayName(), a.args[4], a.args[5] }');
  assert.deepEqual(act, ['Crowbar', true, true], 'primary hand, both hands for a two-hander');
  assert.equal(result(lua).status, 'running');
});

test('EQUIP picks an axe over a crowbar, and a weapon in a bag counts', () => {
  const lua = world('BAG = __makeItem({ type = "Base.Bag_Schoolbag", name = "School Bag", items = { AXE }, back = true }); P.__items.items = { CROWBAR, BAG }; P.primary = CROWBAR');
  order(lua, '1|EQUIP|0|0|||');
  const name = lua.run('return ISTimedActionQueue.getTimedActionQueue(P).queue[1].args[2]:getDisplayName()');
  assert.equal(name, 'Axe');
});

test('EQUIP with the best weapon already in hand does nothing and is done', () => {
  const lua = world('P.__items.items = { CROWBAR, BAT, KNIFE }; P.primary = CROWBAR');
  order(lua, '1|EQUIP|0|0|||');
  assert.deepEqual(queue(lua), []);
  assert.deepEqual(result(lua), { seq: 1, verb: 'EQUIP', status: 'done', why: 'already holding the best' });
});

test('EQUIP does not swap a crowbar for a bat that is only a little better', () => {
  const lua = world('P.__items.items = { CROWBAR, BAT }; P.primary = CROWBAR');
  order(lua, '1|EQUIP|0|0|||');
  assert.deepEqual(queue(lua), []);
  assert.equal(result(lua).status, 'done');
});

test('EQUIP fails with no weapon when he carries only a pen and a fork', () => {
  const lua = world('P.__items.items = { PEN, FORK }; P.primary = PEN');
  order(lua, '1|EQUIP|0|0|||');
  assert.deepEqual(queue(lua), []);
  assert.deepEqual(result(lua), { seq: 1, verb: 'EQUIP', status: 'failed', why: 'equip: no weapon' });
});

test('EQUIP ignores a broken weapon', () => {
  const lua = world('BROKEN = __makeItem({ type = "Base.Axe", name = "Axe", melee = true, dmg = 2, range = 1.2, broken = true, cls = { "AXE" } }); P.__items.items = { BROKEN, KNIFE }');
  order(lua, '1|EQUIP|0|0|||');
  assert.equal(lua.run('return ISTimedActionQueue.getTimedActionQueue(P).queue[1].args[2]:getDisplayName()'), 'Kitchen Knife');
});

// ---------- SEARCH takes up a better weapon ----------
const KITCHEN = `
  B = __makeBuilding({ id = "B1", x = 10, y = 10, x2 = 14, y2 = 14, res = true })
  ROOM = __makeRoom({ name = "kitchen", x = 10, y = 10, x2 = 14, y2 = 14 })
  B.def.getRooms = function() return __javaList({ ROOM.def }) end
  __floor(10, 10, 14, 14, { building = B, room = ROOM })
  __squares["12,10,0"].opts.blocked = true
  BREAD = __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -30, weight = 0.3 })
`;

function searchKitchen(lua) {
  order(lua, '1|SEARCH|0|0|||');
  tick(lua, 3);
  lua.run('P.x, P.y = 11.5, 10.5');
  tick(lua, 2);
}

test('a SEARCH that took a better weapon wields it before it reports', () => {
  const lua = world(KITCHEN + `
    P.__items.items = { PEN }; P.primary = PEN
    COUNTER = __makeContainer({ items = { CROWBAR }, square = __squares["12,10,0"] })
    ROOM.getContainer = function() return __javaList({ COUNTER }) end
  `);
  searchKitchen(lua);
  lua.run('__take(P, COUNTER); table.insert(P.__items.items, CROWBAR)');
  tick(lua, 8);
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction'], 'the equip is queued as part of the skill');
  assert.equal(result(lua).status, 'running', 'not reported until the equip is done');
  assert.ok(lua.get('LocalSurvivor.lastLootTick') > 0, 'a MOVE ordered now waits for it');
  lua.run('P.primary = CROWBAR; ISTimedActionQueue.clear(P)');
  tick(lua, 2);
  assert.deepEqual(result(lua), { seq: 1, verb: 'SEARCH', status: 'done', why: 'took 1: Crowbar', target: 'B1' });
});

test('a SEARCH retries an equip the reflex cut off, once', () => {
  const lua = world(KITCHEN + `
    P.__items.items = { PEN }; P.primary = PEN
    COUNTER = __makeContainer({ items = { CROWBAR }, square = __squares["12,10,0"] })
    ROOM.getContainer = function() return __javaList({ COUNTER }) end
  `);
  searchKitchen(lua);
  lua.run('__take(P, COUNTER); table.insert(P.__items.items, CROWBAR)');
  tick(lua, 8);
  lua.run('ISTimedActionQueue.clear(P)'); // cut, and the crowbar is not in hand
  tick(lua, 2);
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction'], 'tried again');
  assert.equal(result(lua).status, 'running');
  lua.run('ISTimedActionQueue.clear(P)');
  tick(lua, 2);
  assert.equal(result(lua).status, 'done', 'it does not loop on a weapon that will not equip');
});

test('a SEARCH that took no weapon does not touch his hands', () => {
  const lua = world(KITCHEN + `
    P.__items.items = { PEN, CROWBAR }; P.primary = PEN
    COUNTER = __makeContainer({ items = { BREAD }, square = __squares["12,10,0"] })
    ROOM.getContainer = function() return __javaList({ COUNTER }) end
  `);
  searchKitchen(lua);
  lua.run('__take(P, COUNTER); table.insert(P.__items.items, BREAD)');
  tick(lua, 8);
  assert.deepEqual(queue(lua), []);
  assert.equal(result(lua).status, 'done');
});

test('a SEARCH that took a weapon no better than the one in hand does not swap', () => {
  const lua = world(KITCHEN + `
    P.__items.items = { AXE }; P.primary = AXE
    COUNTER = __makeContainer({ items = { BAT }, square = __squares["12,10,0"] })
    ROOM.getContainer = function() return __javaList({ COUNTER }) end
  `);
  searchKitchen(lua);
  // The axe in hand is better than a bat, so the bat is not even picked up.
  assert.deepEqual(queue(lua), []);
});

// ---------- DROP ----------
test('DROP is registered like the other skills', () => {
  const lua = world();
  assert.equal(lua.run('return type(LocalSurvivor.verbs.DROP)'), 'function');
  assert.equal(lua.run('return type(LocalSurvivor.Act.SKILL.DROP.step)'), 'function');
});

const keep = (lua, d) => lua.call('LocalSurvivor.Act.keepValue', d) ?? null;

test('keepValue never lets go of the weapon in hand, worn clothes, a bag, water, food or a bandage', () => {
  const lua = world();
  for (const d of [
    { name: 'Crowbar', held: true, weapon: { cls: 'blunt', dmg: 1.15 } },
    { name: 'Jeans', clothing: true, worn: true },
    { name: 'School Bag', container: true, bag: { capacity: 15 } },
    { name: 'Fanny Pack', container: true },
    { name: 'Water Bottle', waterL: 0.8 },
    { name: 'Bread', edible: true },
    { name: 'Bandage', bandage: true },
    { name: 'Ripped Sheets', bandage: true, sheet: true },
  ]) {
    assert.equal(keep(lua, d), null, d.name);
  }
});

test('keepValue ranks junk under tools under a spare weapon under sealed food', () => {
  const lua = world();
  const junk = keep(lua, { name: 'Spiffo' });
  const pen = keep(lua, { name: 'Pen', weapon: { cls: 'other', dmg: 0.1, reach: 0.8, wt: 0.1 } });
  const shirt = keep(lua, { name: 'Shirt', clothing: true });
  const hammerTool = keep(lua, { name: 'Wrench', screwdriver: true });
  const can = keep(lua, { name: 'Beans', sealed: true });
  const spare = keep(lua, { name: 'Bat', weapon: { cls: 'blunt', dmg: 1.1, crit: 40, reach: 1.25, two: true, wt: 2, swing: 3, cond: 1 } });
  assert.equal(junk, 0);
  assert.equal(pen, 0, 'a pen is junk');
  assert.equal(shirt, 0);
  assert.ok(hammerTool > 0 && hammerTool < spare && spare < can, [hammerTool, spare, can].join(' '));
});

const bat = { name: 'Bat', weight: 2, weapon: { cls: 'blunt', dmg: 1.1, crit: 40, reach: 1.25, two: true, wt: 2, swing: 3, cond: 1 } };
const crowbar = { name: 'Crowbar', weight: 2, weapon: { cls: 'blunt', dmg: 1.15, crit: 20, reach: 1.25, two: true, wt: 2, swing: 3, cond: 1 } };
const dumbbell = { name: 'Dumb Bell', weight: 5 };
const spiffo = { name: 'Spiffo', weight: 0.4 };
const shirt = { name: 'Shirt', weight: 0.2, clothing: true };
const hammer = { name: 'Hammer', weight: 1.5, hammer: true };
const beans = { name: 'Beans', weight: 0.8, sealed: true };
const bread = { name: 'Bread', weight: 0.3, edible: true };
const water = { name: 'Water Bottle', weight: 1.1, waterL: 1 };
const plan = (lua, descs, over) => lua.callMulti('LocalSurvivor.Act.planDrop', descs, over);

test('planDrop drops junk first, heaviest first, and stops once enough is shed', () => {
  const lua = world();
  const [picks, shed] = plan(lua, [shirt, spiffo, dumbbell, hammer, beans, bread, water], 6);
  // Dumb Bell (5), Spiffo (0.4), Shirt (0.2) are junk, then the hammer tips it over 6.
  assert.deepEqual(picks, [3, 2, 1, 4]);
  assert.ok(Math.abs(shed - 7.1) < 1e-9, String(shed));
});

test('planDrop stops at the first item that is enough', () => {
  const lua = world();
  const [picks] = plan(lua, [shirt, spiffo, dumbbell], 3);
  assert.deepEqual(picks, [3]);
});

test('planDrop keeps the best weapon he carries but lets a spare one go, after the tools and before the cans', () => {
  const lua = world();
  const [picks] = plan(lua, [crowbar, bat, hammer, beans], 100);
  // The bat scores higher, so the bat is kept and the crowbar is the spare.
  assert.deepEqual(picks, [3, 1, 4]);
});

test('planDrop never picks anything protected, however much is asked', () => {
  const lua = world();
  const [picks] = plan(lua, [{ ...crowbar, held: true }, water, bread, { name: 'Bandage', weight: 0.1, bandage: true }, { name: 'Pack', weight: 1, container: true }], 100);
  assert.deepEqual(picks, []);
});

test('planDrop leaves weightless things alone', () => {
  const lua = world();
  const [picks] = plan(lua, [{ name: 'Note', weight: 0 }], 5);
  assert.deepEqual(picks, []);
});

const DROP_KIT = `
  SHIRT = __makeItem({ type = "Base.Tshirt", name = "T-Shirt", clothing = true, worn = true, weight = 0.2 })
  BREAD = __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -30, weight = 0.3 })
  WATER = __makeItem({ type = "Base.WaterBottle", name = "Water Bottle", fluid = { water = 0.8, capacity = 1 }, weight = 0.9 })
  BANDAGE = __makeItem({ type = "Base.Bandage", name = "Bandage", bandage = true, weight = 0.1 })
  SPIFFO = __makeItem({ type = "Base.Spiffo", name = "Spiffo", weight = 0.4 })
  DUMBBELL = __makeItem({ type = "Base.DumbBell", name = "Dumb Bell", weight = 5 })
  PACK = __makeItem({ type = "Base.Bag_Schoolbag", name = "School Bag", items = {}, back = true, worn = true, weight = 1 })
  P.back = PACK
  P.primary = CROWBAR
  P.weight = 10
`;
const kit = (extra) => world(DROP_KIT + `P.__items.items = { CROWBAR, SHIRT, BREAD, WATER, BANDAGE, ${extra ? extra + ', ' : ''}PACK }`);
const dropped = (lua) => lua.run('local out = {} for i, c in ipairs(__menuCalls) do if c.name == "dropItem" then out[#out + 1] = c.args[1]:getDisplayName() end end return out');

test('DROP sheds the least valuable item with the game drop and reports what went', () => {
  const lua = kit('SPIFFO, DUMBBELL');
  order(lua, '1|DROP|0|0|||');
  assert.equal(result(lua).status, 'running');
  assert.deepEqual(dropped(lua), ['Dumb Bell'], 'the heavy junk goes first and one is enough');
  assert.deepEqual(queue(lua), ['Menu:dropItem']);
  lua.run('P.weight = 6; __finishDrops(P)');
  tick(lua, 2);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DROP', status: 'done', why: 'dropped 1: Dumb Bell' });
});

test('DROP never drops the weapon in hand, water, food, a bandage, worn clothes or the worn bag', () => {
  const lua = kit('SPIFFO, DUMBBELL');
  lua.run('P.weight = 500');
  order(lua, '1|DROP|0|0|||');
  assert.deepEqual(dropped(lua).sort(), ['Dumb Bell', 'Spiffo']);
});

test('DROP says so when he is not heavy', () => {
  const lua = kit('SPIFFO');
  lua.run('P.weight = 3');
  order(lua, '1|DROP|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'DROP', status: 'failed', why: 'not heavy' });
  assert.deepEqual(queue(lua), []);
});

test('DROP fails when everything he carries is something he needs', () => {
  const lua = kit('');
  order(lua, '1|DROP|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'DROP', status: 'failed', why: 'nothing to drop' });
});

test('DROP reports what it dropped and that he is still heavy when nothing more can go', () => {
  const lua = kit('SPIFFO');
  order(lua, '1|DROP|0|0|||');
  lua.run('P.weight = 11; __finishDrops(P)');
  tick(lua, 2);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DROP', status: 'done', why: 'dropped 1: Spiffo (still heavy)' });
});

test('DROP plans another pass when the first was not enough', () => {
  const lua = kit('SPIFFO, DUMBBELL');
  order(lua, '1|DROP|0|0|||');
  assert.deepEqual(dropped(lua), ['Dumb Bell']);
  lua.run('P.weight = 9; __finishDrops(P)'); // a bag softened the weight: still over 6.8
  tick(lua, 2);
  assert.deepEqual(dropped(lua), ['Spiffo'], 'the second pass takes what is left');
  lua.run('P.weight = 6; __finishDrops(P)');
  tick(lua, 2);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DROP', status: 'done', why: 'dropped 2: Dumb Bell, Spiffo' });
});

test('DROP gives up when the game refuses the drop, instead of asking again forever', () => {
  const lua = kit('DUMBBELL');
  order(lua, '1|DROP|0|0|||');
  lua.run('__menuCalls = {}; ISTimedActionQueue.clear(P)'); // the queue emptied but the item is still here
  tick(lua, 2);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DROP', status: 'failed', why: 'nothing to drop' });
});

test('DROP waits while the drops run', () => {
  const lua = kit('DUMBBELL');
  order(lua, '1|DROP|0|0|||');
  tick(lua, 30);
  assert.equal(result(lua).status, 'running');
  assert.deepEqual(queue(lua), ['Menu:dropItem']);
});

test('the reflex counts a pen in hand as bare hands, and a crowbar as armed', () => {
  const lua = world('P.__items.items = { PEN, CROWBAR }; P.primary = PEN');
  assert.equal(lua.run('return LocalSurvivor.Core.holdingMelee(P)'), false);
  lua.run('P.primary = CROWBAR');
  assert.equal(lua.run('return LocalSurvivor.Core.holdingMelee(P)'), true);
  lua.run('P.primary = nil');
  assert.equal(lua.run('return LocalSurvivor.Core.holdingMelee(P)'), false);
});

// ---------- guns are gear, not the melee weapon ----------
const GUNS = `
  PISTOL = __makeItem({ type = "Base.Pistol", name = "Pistol", weight = 1.5,
    gun = { ammo = "Base.Bullets9mm", mag = "Base.9mmClip", box = "Base.Bullets9mmBox", loaded = 8, max = 15 } })
  SAUCEPAN = __makeItem({ type = "Base.Saucepan", name = "Saucepan", melee = true, dmg = 0.7, crit = 30, range = 1,
    swing = 2, cond = 7, condMax = 10, cls = { "SMALL_BLUNT", "IMPROVISED" }, weight = 0.7 })
  APPLE = __makeItem({ type = "Base.Apple", name = "Apple", food = true, hung = -10, weight = 0.2 })
`;
const queuedName = (lua) => lua.run('local a = ISTimedActionQueue.getTimedActionQueue(P).queue[1]; return a and a.args[2]:getDisplayName() or nil');

test('EQUIP never picks a gun as the melee weapon', () => {
  const lua = world(GUNS + 'P.__items.items = { PISTOL, KNIFE }');
  order(lua, '1|EQUIP|0|0|||');
  assert.equal(queuedName(lua), 'Kitchen Knife');
  const gunOnly = world(GUNS + 'P.__items.items = { PISTOL }');
  order(gunOnly, '1|EQUIP|0|0|||');
  assert.deepEqual(queue(gunOnly), []);
  assert.deepEqual(result(gunOnly), { seq: 1, verb: 'EQUIP', status: 'failed', why: 'equip: no weapon' });
});

test('EQUIP does not swap a gun in hand for a saucepan, a crowbar or an axe', () => {
  for (const carried of ['SAUCEPAN', 'CROWBAR', 'AXE']) {
    const lua = world(GUNS + `P.__items.items = { PISTOL, ${carried} }; P.primary = PISTOL`);
    order(lua, '1|EQUIP|0|0|||');
    assert.deepEqual(queue(lua), [], carried);
    assert.deepEqual(result(lua), { seq: 1, verb: 'EQUIP', status: 'done', why: 'holding the one you picked' }, carried);
  }
});

test('a gun in hand counts as picked by hand even before anyone has looked', () => {
  const lua = world(GUNS + 'P.__items.items = { PISTOL, SAUCEPAN }; P.primary = PISTOL');
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), true);
  assert.equal(lua.run('return LocalSurvivor.Act.equipPlan(P)'), undefined);
});

// ---------- the weapon Colin picked by hand ----------
test('a weapon put in her hand while the mod queued nothing is Colin\'s, and is never swapped away', () => {
  const lua = world('P.__items.items = { CROWBAR, BAT, AXE }; P.primary = CROWBAR');
  tick(lua); // the first look sets the baseline
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), false);
  lua.run('P.primary = BAT'); // Colin equips it
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), true);
  order(lua, '1|EQUIP|0|0|||');
  assert.deepEqual(queue(lua), [], 'the axe in the bag is better, and still not wielded');
  assert.deepEqual(result(lua), { seq: 1, verb: 'EQUIP', status: 'done', why: 'holding the one you picked' });
});

test('a weapon the mod equipped itself is not Colin\'s pick', () => {
  const lua = world('P.__items.items = { PEN, KNIFE, CROWBAR }; P.primary = PEN');
  tick(lua);
  order(lua, '1|EQUIP|0|0|||');
  assert.deepEqual(queue(lua), ['ISEquipWeaponAction']);
  lua.run('P.primary = CROWBAR; ISTimedActionQueue.clear(P)'); // the equip finishes
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), false);
  // So a better weapon is still taken up later.
  lua.run('table.insert(P.__items.items, AXE)');
  order(lua, '2|EQUIP|0|0|||');
  assert.equal(queuedName(lua), 'Axe');
});

test('the lock ends when the weapon breaks, is dropped, or Colin picks another', () => {
  const lua = world('P.__items.items = { CROWBAR, BAT, AXE }; P.primary = CROWBAR');
  tick(lua);
  lua.run('P.primary = BAT');
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), true);
  // Broken.
  lua.run('BAT.opts.broken = true');
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), false);
  lua.run('BAT.opts.broken = false');
  // Picked another by hand.
  lua.run('P.primary = CROWBAR');
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), true);
  lua.run('P.primary = AXE');
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.hand.locked == AXE'), true, 'the new pick is the lock');
  // Dropped: out of her hands and out of the pack. It is noticed on the next look.
  lua.run('P.primary = nil; P.__items.items = { CROWBAR, BAT }');
  tick(lua, 40);
  assert.equal(lua.run('return LocalSurvivor.hand.locked'), undefined);
  order(lua, '1|EQUIP|0|0|||');
  assert.equal(queue(lua)[0], 'ISEquipWeaponAction', 'free to wield the best again');
});

test('the lock ends with the character', () => {
  const lua = world('P.__items.items = { CROWBAR, BAT }; P.primary = CROWBAR');
  tick(lua);
  lua.run('P.primary = BAT');
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), true);
  // A new character is a new player object. Its first look is a baseline, not a pick.
  lua.run('__players[0] = __makePlayer({ x = 10.5, y = 10.5, live = true }); P = __players[0]; P.__items.items = { CROWBAR }; P.primary = CROWBAR');
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), false);
});

test('food in her hand while she eats is not a pick, and does not end one', () => {
  const lua = world(GUNS + 'P.__items.items = { CROWBAR, BAT, APPLE }; P.primary = CROWBAR');
  tick(lua);
  lua.run('P.primary = BAT');
  tick(lua);
  lua.run('P.primary = APPLE'); // she eats
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.hand.locked == BAT'), true, 'his pick is remembered');
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), false, 'but it is not in her hand');
  // Hands are free again: EQUIP puts back the one Colin chose, not the best.
  lua.run('P.primary = nil; table.insert(P.__items.items, AXE)');
  order(lua, '1|EQUIP|0|0|||');
  assert.equal(queuedName(lua), 'Baseball Bat');
  lua.run('P.primary = BAT; ISTimedActionQueue.clear(P)');
  tick(lua);
  assert.equal(lua.run('return LocalSurvivor.Act.handChosen(P)'), true, 'putting it back keeps it his');
});

test('a SEARCH that finds a better weapon leaves the one Colin chose in her hand', () => {
  const lua = world(KITCHEN + `
    P.__items.items = { CROWBAR }; P.primary = CROWBAR
    COUNTER = __makeContainer({ items = { AXE }, square = __squares["12,10,0"] })
    ROOM.getContainer = function() return __javaList({ COUNTER }) end
  `);
  tick(lua);
  lua.run('P.__items.items = { CROWBAR, BAT }; P.primary = BAT');
  tick(lua);
  searchKitchen(lua);
  lua.run('__take(P, COUNTER); table.insert(P.__items.items, AXE)');
  tick(lua, 8);
  assert.deepEqual(queue(lua), [], 'no equip is queued');
  assert.equal(result(lua).status, 'done');
  assert.equal(result(lua).why, 'took 1: Axe');
});

test('DROP sheds down to the line SEARCH stops at: 60% of the limit with no bag', () => {
  // 6 of 8 kg with no bag is too full to search (4.8), so DROP must not call it "not heavy".
  const lua = kit('SPIFFO');
  lua.run('P.back = nil; P.weight = 6');
  order(lua, '1|DROP|0|0|||');
  assert.notEqual(result(lua).why, 'not heavy');
  assert.ok(queue(lua).length > 0, 'it queues a drop');
});
