// The loot priority table and its pure scoring, on plain item descriptions. Which items a real
// container holds, and what they weigh, is a live-game check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();

const pick = (d, have = {}) => lua.callMulti('LocalSurvivor.Act.lootPick', d, have)[0] ?? null;
const value = (w) => lua.call('LocalSurvivor.Act.weaponValue', w);
const plan = (descs, have, budget) => lua.callMulti('LocalSurvivor.Act.planTake', descs, have, budget);

const crowbar = { name: 'Crowbar', weight: 2, weapon: { cls: 'blunt', long: true, dmg: 1.15, cond: 1 } };
const bat = { name: 'Baseball Bat', weight: 2, weapon: { cls: 'blunt', long: true, dmg: 1.1, cond: 1 } };
const axe = { name: 'Axe', weight: 3, weapon: { cls: 'axe', long: true, dmg: 2, cond: 1 } };
const knife = { name: 'Kitchen Knife', weight: 0.7, weapon: { cls: 'smallblade', dmg: 0.7, cond: 1 } };
const hammer = { name: 'Hammer', weight: 1.5, hammer: true, weapon: { cls: 'smallblunt', dmg: 1, cond: 1 } };
const bread = { name: 'Bread', weight: 0.3, edible: true };
const beans = { name: 'Beans', weight: 0.8, sealed: true };
const shirt = { name: 'Shirt', weight: 0.2, clothing: true };

test('real weapons rank above a hammer and a knife', () => {
  assert.ok(value(axe.weapon) > value(knife.weapon));
  assert.ok(value(crowbar.weapon) > value(hammer.weapon));
  assert.ok(value(hammer.weapon) > value(knife.weapon));
  assert.ok(value({ cls: 'blunt', long: true, dmg: 1.15, cond: 0.1 }) < value(crowbar.weapon), 'worn out counts for less');
  assert.ok(value({ cls: 'blunt', improvised: true, long: true, dmg: 0.6 }) < value(bat.weapon), 'a plank is worse than a bat');
});

test('a weapon is taken only when it beats the best carried', () => {
  assert.equal(pick(crowbar), 'weapon');
  assert.equal(pick(crowbar, { weaponValue: value(knife.weapon) }), 'weapon');
  assert.equal(pick(bat, { weaponValue: value(crowbar.weapon) }), null);
});

test('a kitchen knife only when nothing else is carried', () => {
  assert.equal(pick(knife), 'weapon');
  assert.equal(pick(knife, { weaponValue: value(hammer.weapon) }), null);
});

test('a hammer that is not a better weapon is still taken as a tool, once', () => {
  const have = { weaponValue: value(crowbar.weapon) };
  assert.equal(pick(hammer, have), 'hammer');
  assert.equal(pick(hammer, { ...have, hammer: 1 }), null);
});

test('a bag only when none is worn', () => {
  const pack = { name: 'School Bag', weight: 1, bag: { capacity: 15 } };
  assert.equal(pick(pack), 'bag');
  assert.equal(pick(pack, { bagWorn: true }), null);
});

test('a can opener only when none is carried', () => {
  const opener = { name: 'Can Opener', weight: 0.6, opener: true };
  assert.equal(pick(opener), 'opener');
  assert.equal(pick(opener, { opener: 1 }), null);
});

test('clothes, junk and broken things are left', () => {
  assert.equal(pick(shirt), null);
  assert.equal(pick({ name: 'Spiffo', weight: 0.4 }), null);
  assert.equal(pick({ ...crowbar, broken: true }), null);
});

test('the priority order from the card', () => {
  const order = lua.run('local out = {} for i, r in ipairs(LocalSurvivor.Act.LOOT) do out[i] = r.key end return out');
  assert.deepEqual(order, [
    'weapon', 'bag', 'water', 'bottle', 'food', 'can', 'opener', 'bandage', 'sheet', 'disinfectant',
    'painkiller', 'hammer', 'saw', 'screwdriver', 'lighter', 'flashlight',
  ]);
  assert.equal(pick({ name: 'Water Bottle', weight: 1.1, waterL: 1 }), 'water');
  assert.equal(pick({ name: 'Empty Bottle', weight: 0.1, emptyBottle: true }), 'bottle');
  assert.equal(pick({ name: 'Ripped Sheets', weight: 0.1, bandage: true, sheet: true }), 'sheet');
  assert.equal(pick({ name: 'Bandage', weight: 0.1, bandage: true }), 'bandage');
  assert.equal(pick({ name: 'Matches', weight: 0.1, lighter: true }), 'lighter');
  assert.equal(pick({ name: 'Flashlight', weight: 0.5, flashlight: true }), 'flashlight');
});

test('planTake takes the best first and stays inside the weight budget', () => {
  const descs = [shirt, bread, axe, crowbar, beans];
  const [picks, left] = plan(descs, {}, 2.5);
  // The axe is better but does not fit. The crowbar does, then bread. Beans would go over.
  assert.deepEqual(picks, [{ index: 4, key: 'weapon' }, { index: 2, key: 'food' }]);
  assert.ok(Math.abs(left - 0.2) < 1e-9, String(left));
});

test('planTake leaves a second weapon that is no better than the first pick', () => {
  const [picks] = plan([crowbar, bat, knife], {}, 20);
  assert.deepEqual(picks, [{ index: 1, key: 'weapon' }]);
});

test('planTake respects the carry limits', () => {
  const opener = { name: 'Can Opener', weight: 0.6, opener: true };
  const [picks] = plan([opener, opener, opener], {}, 20);
  assert.equal(picks.length, 1);
});

test('tookText lists what was taken', () => {
  assert.equal(lua.call('LocalSurvivor.Act.tookText', ['Crowbar', 'Water Bottle', 'Beans', 'Bandage']), 'took 4: Crowbar, Water Bottle, Beans, Bandage');
  assert.equal(lua.call('LocalSurvivor.Act.tookText', []), 'took nothing');
  const many = Array.from({ length: 10 }, (_, i) => `Item${i}`);
  assert.match(lua.call('LocalSurvivor.Act.tookText', many), /^took 10: Item0, .*Item7 and 2 more$/);
});

test('describeLoot reads a game item into the plain table', () => {
  const fresh = createHarness();
  fresh.autoload();
  const d = fresh.run(`
    local it = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, range = 1.25,
      twoHand = true, cls = { "BLUNT" }, weight = 2 })
    return LocalSurvivor.Act.describeLoot(it, __makePlayer({}))
  `);
  assert.equal(d.weight, 2);
  assert.equal(d.weapon.cls, 'blunt');
  assert.equal(d.weapon.long, true);
  const bag = fresh.run(`
    return LocalSurvivor.Act.describeLoot(__makeItem({ type = "Base.Bag_Schoolbag", name = "School Bag",
      items = {}, back = true, capacity = 15, weight = 1 }), __makePlayer({}))
  `);
  assert.deepEqual(bag.bag, { capacity: 15 });
  const bottle = fresh.run(`
    return LocalSurvivor.Act.describeLoot(__makeItem({ type = "Base.WaterBottle", name = "Water Bottle",
      fluid = { water = 0.8, capacity = 1 }, weight = 0.9 }), __makePlayer({}))
  `);
  assert.equal(bottle.waterL, 0.8);
  const sheet = fresh.run(`
    return LocalSurvivor.Act.describeLoot(__makeItem({ type = "Base.RippedSheets", name = "Ripped Sheets",
      bandage = true, weight = 0.1 }), __makePlayer({}))
  `);
  assert.equal(sheet.sheet, true);
});
