// The loot priority table and its pure scoring, on plain item descriptions. Which items a real
// container holds, and what they weigh, is a live-game check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();

const pick = (d, have = {}) => lua.callMulti('LocalSurvivor.Act.lootPick', d, have)[0] ?? null;
const score = (w) => lua.call('LocalSurvivor.Core.weaponScore', w);
const plan = (descs, have, budget) => lua.callMulti('LocalSurvivor.Act.planTake', descs, have, budget);

// Stats are the 42.21 item scripts: MaxDamage, CriticalChance, MaxRange, Weight, Swingtime.
const W = {
  crowbar: { cls: 'blunt', dmg: 1.15, crit: 20, reach: 1.25, two: true, wt: 2, swing: 3, cond: 1 },
  bat: { cls: 'blunt', dmg: 1.1, crit: 40, reach: 1.25, two: true, wt: 2, swing: 3, cond: 1 },
  axe: { cls: 'axe', dmg: 2, crit: 20, reach: 1.2, two: true, wt: 3, swing: 3, cond: 1 },
  machete: { cls: 'longblade', dmg: 3, crit: 20, reach: 1.23, wt: 2, swing: 4, cond: 1 },
  hammer: { cls: 'smallblunt', dmg: 1, crit: 20, reach: 1.1, wt: 1.5, swing: 3, cond: 1 },
  knife: { cls: 'smallblade', dmg: 0.7, crit: 25, reach: 0.9, wt: 0.7, swing: 2, cond: 1 },
  pen: { cls: 'other', imp: true, dmg: 0.1, crit: 0, reach: 0.8, wt: 0.1, swing: 2, cond: 1 },
  pencil: { cls: 'other', imp: true, dmg: 0.1, crit: 0, reach: 0.8, wt: 0.1, swing: 2, cond: 1 },
  fork: { cls: 'smallblade', dmg: 0.1, crit: 5, reach: 0.8, wt: 0.25, swing: 2, cond: 1 },
  spoon: { cls: 'smallblade', dmg: 0.1, crit: 0, reach: 0.8, wt: 0.25, swing: 2, cond: 1 },
};
const item = (name, weight, weapon) => ({ name, weight, weapon });
const crowbar = item('Crowbar', 2, W.crowbar);
const bat = item('Baseball Bat', 2, W.bat);
const axe = item('Axe', 3, W.axe);
const knife = item('Kitchen Knife', 0.7, W.knife);
const hammer = { ...item('Hammer', 1.5, W.hammer), hammer: true };
const pen = item('Pen', 0.1, W.pen);
const bread = { name: 'Bread', weight: 0.3, edible: true };
const beans = { name: 'Beans', weight: 0.8, sealed: true };
const water = { name: 'Water Bottle', weight: 1.1, waterL: 1 };
const shirt = { name: 'Shirt', weight: 0.2, clothing: true };

test('a pen, pencil, fork or spoon is never a weapon', () => {
  for (const name of ['pen', 'pencil', 'fork', 'spoon']) assert.equal(score(W[name]), 0, name);
  assert.equal(lua.call('LocalSurvivor.Core.isRealWeapon', W.pen), false);
  assert.equal(lua.call('LocalSurvivor.Core.isRealWeapon', W.knife), true);
});

test('a broken or worn-out weapon scores 0', () => {
  assert.equal(score({ ...W.crowbar, broken: true }), 0);
  assert.equal(score({ ...W.crowbar, cond: 0 }), 0);
  assert.ok(score({ ...W.crowbar, cond: 0.1 }) < score(W.crowbar) / 1.5, 'worn out counts for much less');
});

test('crowbar, bat, axe and long blades beat a hammer and a kitchen knife', () => {
  for (const good of ['crowbar', 'bat', 'axe', 'machete']) {
    assert.ok(score(W[good]) > score(W.hammer), good + ' over hammer');
    assert.ok(score(W[good]) > score(W.knife), good + ' over knife');
  }
  assert.ok(score(W.hammer) > score(W.knife));
  assert.ok(score(W.axe) > score(W.crowbar));
  assert.ok(score(W.knife) >= 5, 'a kitchen knife is still a weapon when nothing else is there');
});

test('an improvised weapon scores below the real one of the same stats', () => {
  assert.ok(score({ ...W.bat, imp: true }) < score(W.bat));
});

test('a heavy weapon, a short one and a slow one each cost something', () => {
  assert.ok(score({ ...W.axe, wt: 6 }) < score(W.axe));
  assert.ok(score({ ...W.crowbar, reach: 0.9 }) < score(W.crowbar));
  assert.ok(score({ ...W.crowbar, swing: 4 }) < score(W.crowbar));
  assert.ok(score({ ...W.crowbar, crit: 50 }) > score(W.crowbar));
});

test('a damage figure far off the scale does not run away', () => {
  assert.ok(score({ ...W.axe, dmg: 8 }) === score({ ...W.axe, dmg: 3 }));
});

test('a weapon is taken when he has none or when it is clearly better', () => {
  assert.equal(pick(crowbar), 'weapon');
  assert.equal(pick(crowbar, { weaponValue: score(W.knife) }), 'weapon');
  assert.equal(pick(axe, { weaponValue: score(W.crowbar) }), 'weapon');
  assert.equal(pick(bat, { weaponValue: score(W.crowbar) }), null, 'a bat is no clear gain over a crowbar');
});

test('a pen, fork or spoon is left, with or without a weapon', () => {
  assert.equal(pick(pen), null);
  assert.equal(pick(item('Fork', 0.25, W.fork)), null);
  assert.equal(pick(item('Spoon', 0.25, W.spoon), { weaponValue: score(W.knife) }), null);
});

test('a broken weapon is left', () => {
  assert.equal(pick({ ...crowbar, broken: true }), null);
  assert.equal(pick(item('Bat', 2, { ...W.bat, broken: true })), null);
});

test('a kitchen knife only when nothing better is carried', () => {
  assert.equal(pick(knife), 'weapon');
  assert.equal(pick(knife, { weaponValue: score(W.hammer) }), null);
});

test('a hammer that is not a better weapon is still taken as a tool, once', () => {
  const have = { weaponValue: score(W.crowbar) };
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

test('planTake takes the best weapon and leaves a second one that is no clear gain', () => {
  const [picks] = plan([crowbar, bat, knife], {}, 20);
  assert.deepEqual(picks, [{ index: 2, key: 'weapon' }]);
});

test('a real weapon he does not have ranks above water and food', () => {
  const [picks] = plan([bread, water, beans, crowbar], {}, 20);
  assert.equal(picks[0].index, 4);
  assert.equal(picks[0].key, 'weapon');
  assert.deepEqual(picks.map((p) => p.key), ['weapon', 'water', 'food', 'can']);
});

test('with room for one thing, the weapon wins over the water bottle', () => {
  const [picks] = plan([water, crowbar], {}, 2.2);
  assert.deepEqual(picks, [{ index: 2, key: 'weapon' }]);
});

test('a better weapon than the one in hand is taken even with a full set of supplies', () => {
  const have = { weaponValue: score(W.crowbar), water: 4, food: 12, can: 12, bandage: 6 };
  const [picks] = plan([water, bread, axe], have, 20);
  assert.deepEqual(picks, [{ index: 3, key: 'weapon' }]);
});

test('a pen in a drawer is left behind with the shirt', () => {
  const [picks] = plan([pen, shirt, bread], {}, 20);
  assert.deepEqual(picks, [{ index: 3, key: 'food' }]);
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
    local it = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, crit = 20,
      range = 1.25, swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
    return LocalSurvivor.Act.describeLoot(it, __makePlayer({}))
  `);
  assert.equal(d.weight, 2);
  assert.equal(d.weapon.cls, 'blunt');
  assert.equal(d.weapon.two, true);
  assert.equal(d.weapon.crit, 20);
  assert.equal(d.weapon.score, score(W.crowbar), 'the score is read from the same facts the pure test uses');
  const pen = fresh.run(`
    return LocalSurvivor.Act.describeLoot(__makeItem({ type = "Base.Pen", name = "Pen", melee = true, dmg = 0.1,
      range = 0.8, swing = 2, cond = 2, condMax = 2, cls = { "IMPROVISED" }, weight = 0.1 }), __makePlayer({}))
  `);
  assert.equal(pen.weapon.score, 0);
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
