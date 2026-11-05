// The loot priority table and its pure scoring, on plain item descriptions. Which items a real
// container holds, and what they weigh, is a live-game check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();

const pick = (d, have = {}) => lua.callMulti('LocalSurvivor.Act.lootPick', d, have)[0] ?? null;
const score = (w) => lua.call('LocalSurvivor.Core.weaponScore', w);
const plan = (descs, have, budget, total) => lua.callMulti('LocalSurvivor.Act.planTake', descs, have, budget, total);

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

test('the kinds she picks up, one by one', () => {
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

// ---------- the loot value ----------
// Plain item facts in, a number out. Which of them she may still take is Act's job.
const value = (d, ctx = {}) => lua.call('LocalSurvivor.Core.lootValue', d, ctx);
const kinds = (d, ctx = {}) => lua.call('LocalSurvivor.Core.lootKinds', d, ctx).map((k) => k.kind);

const NINE_MM = { n: 'Pistol', ammoKey: 'Base.Bullets9mm', magKey: 'Base.9mmClip', boxKey: 'Base.Bullets9mmBox', loaded: 0, max: 15 };
const pistol = { name: 'Pistol', weight: 1.5, gun: NINE_MM };
const rounds = { name: '9mm Bullets', weight: 0.02, ammo: 'Base.Bullets9mm', count: 5 };
const clip = { name: '9mm Magazine', weight: 0.2, mag: { key: 'Base.9mmClip', ammoKey: 'Base.Bullets9mm', rounds: 15, max: 15 } };
const gunCtx = { ammoOf: { 'Base.Bullets9mm': true }, magOf: { 'Base.9mmClip': true } };
const pack = { name: 'School Bag', weight: 1, bag: { capacity: 15 } };
const bandage = { name: 'Bandage', weight: 0.1, bandage: true };
const milk = { name: 'Milk Carton', weight: 0.5, edible: true, shelf: 4 };
const frozen = { name: 'Ice Cream Sandwich', weight: 0.2, edible: true, frozen: true, shelf: 6 };
const dry = { name: 'Pasta', weight: 0.4, edible: true };
const canned = { name: 'Beans', weight: 0.8, sealed: true };
const plunger = item('Plunger', 0.5, { cls: 'smallblunt', imp: true, dmg: 0.5, crit: 5, reach: 1.1, wt: 0.5, swing: 4, cond: 1 });
const saucepan = item('Saucepan', 0.7, { cls: 'smallblunt', imp: true, dmg: 0.7, crit: 30, reach: 1, wt: 0.7, swing: 2, cond: 0.7 });

test('junk is worth nothing: dye, perfume, a plunger, a decoration, a shirt', () => {
  // Dye and perfume are fluids but not drinks, so they carry neither a drink nor a water flag.
  for (const d of [
    { name: 'Industrial Dye', weight: 0.3 },
    { name: 'Perfume', weight: 0.1 },
    plunger,
    { name: 'Spiffo', weight: 0.4 },
    { name: 'Vase', weight: 1 },
    shirt,
    { name: 'Fork', weight: 0.25, weapon: W.fork },
  ]) {
    assert.equal(value(d, gunCtx), 0, d.name);
    assert.equal(pick(d), null, d.name);
  }
});

test('a plunger scores a weapon but is not worth carrying, a saucepan is', () => {
  assert.ok(score(plunger.weapon) >= 5, 'the plunger is a weapon to the reflex');
  assert.ok(score(plunger.weapon) < 8, 'and under the loot floor');
  assert.equal(pick(plunger), null);
  assert.ok(score(saucepan.weapon) >= 8);
  assert.equal(pick(saucepan), 'weapon');
});

test('a bag beats food when she has none, and is left when she wears a good one', () => {
  assert.ok(value(pack) > value(dry));
  assert.ok(value(pack) > value(crowbar));
  assert.equal(pick(pack), 'bag');
  assert.equal(pick(pack, { bagWorn: true, bagCapacity: 15 }), null);
  assert.equal(pick({ ...pack, bag: { capacity: 40 } }, { bagWorn: true, bagCapacity: 15 }), 'bag', 'a much bigger bag replaces a small one');
  assert.equal(pick({ ...pack, bag: { capacity: 20 } }, { bagWorn: true, bagCapacity: 15 }), null, 'a little bigger is no reason');
  const [picks] = plan([dry, bread, pack], {}, 20);
  assert.equal(picks[0].key, 'bag');
});

test('a gun is gear: taken with its ammo, and ammo is taken for a gun she has', () => {
  assert.equal(pick(pistol, gunCtx), 'gun', 'a gun with ammo is taken');
  assert.equal(pick(pistol, { ammoOf: {} }), 'gun', 'a gun with no ammo anywhere is still carried');
  assert.ok(value(pistol, gunCtx) > value(pistol), 'but worth more with ammo');
  assert.equal(pick({ ...pistol, gun: { ...NINE_MM, loaded: 7 } }), 'gun');
  assert.equal(pick(rounds, gunCtx), 'ammo');
  assert.equal(pick(clip, gunCtx), 'mag');
  assert.equal(pick(rounds), null, 'rounds for no gun she has are left');
  assert.equal(pick({ ...rounds, ammo: 'Base.ShotgunShells' }, gunCtx), null, 'the wrong calibre is left');
  assert.equal(pick({ name: 'Box', weight: 0.8, box: 'Base.Bullets9mmBox' }, { boxOf: { 'Base.Bullets9mmBox': true } }), 'box');
  assert.equal(pick({ ...pistol, broken: true }, gunCtx), null);
  assert.equal(pick(pistol, { ...gunCtx, gun: 2 }), null, 'two guns are enough');
});

test('a gun in the same container makes its ammo worth taking', () => {
  const [picks] = plan([rounds, pistol, clip], {}, 20);
  assert.deepEqual(picks.map((p) => p.key).sort(), ['ammo', 'gun', 'mag']);
  const [alone] = plan([rounds, clip], {}, 20);
  assert.deepEqual(alone, [], 'no gun, no ammo');
});

test('a melee weapon beats a gun, a gun beats medicine, medicine beats water, water beats food', () => {
  const ctx = { ...gunCtx, hunger: 0.5 };
  const order = [pack, crowbar, pistol, rounds, bandage, water, dry, milk, { name: 'Screwdriver', weight: 0.3, screwdriver: true }];
  const values = order.map((d) => value(d, ctx));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i - 1] > values[i], `${order[i - 1].name} ${values[i - 1]} over ${order[i].name} ${values[i]}`);
  }
});

test('canned and dry food beat fresh food when she is not hungry, and fresh is left when it spoils soon', () => {
  const full = { hunger: 0.02, foodReady: 0 };
  assert.equal(pick(dry, full), 'food');
  assert.equal(pick(canned, full), 'can');
  assert.equal(pick(milk, full), null, 'milk that turns in four days, with no hunger, is left');
  assert.equal(pick(frozen, full), null, 'frozen food melts the hour it leaves the freezer');
  assert.ok(value(canned, full) > value(milk, { hunger: 0.15 }));
  assert.ok(value(dry, full) > value(milk, { hunger: 0.5 }), 'even a hungry one prefers food that keeps');
});

test('fresh food is taken when she is hungry now or will be within the day', () => {
  assert.equal(pick(milk, { hunger: 0.4 }), 'fresh');
  assert.equal(pick(milk, { hunger: 0.15 }), 'fresh', 'hungry within the day');
  assert.equal(pick(milk, { hunger: 0.15, food: 4 }), null, 'but not with a pack of food already');
  assert.equal(pick(frozen, { hunger: 0.5 }), null, 'frozen food cannot be eaten at once');
  assert.equal(pick({ ...milk, shelf: 0.5 }, { hunger: 0.15 }), null, 'a day left is too little to plan on');
});

test('medicine, water and tools all have a place', () => {
  assert.equal(pick({ name: 'Antibiotics', weight: 0.1, antibiotic: true }), 'antibiotic');
  assert.equal(pick({ name: 'Splint', weight: 1, splint: true }), 'splint');
  assert.equal(pick({ name: 'Disinfectant', weight: 0.5, disinfect: true }), 'disinfectant');
  assert.equal(pick({ name: 'Pills', weight: 0.1, painkiller: true }), 'painkiller');
  assert.equal(pick({ name: 'Battery', weight: 0.1, battery: true }), 'battery');
  assert.equal(pick({ name: 'Soda', weight: 0.4, drink: true }), 'drink');
  assert.ok(value({ name: 'Water', waterL: 1 }) > value({ name: 'Empty Bottle', emptyBottle: true }));
  assert.ok(value({ name: 'Empty Bottle', emptyBottle: true }) > value({ name: 'Soda', drink: true }));
  assert.ok(value({ name: 'Can Opener', opener: true }) > value({ name: 'Hammer', hammer: true }));
});

test('value per weight: a full pack takes bandages and rounds and leaves a saw', () => {
  const worth = (v, w, room) => lua.call('LocalSurvivor.Core.lootWorth', v, w, room);
  assert.equal(worth(45, 3, 1), true, 'anything goes into an empty pack');
  assert.equal(worth(45, 3, 0.25), false, 'a 3 kg saw does not go into a nearly full one');
  assert.equal(worth(78, 0.1, 0.05), true, 'a bandage does');
  assert.equal(worth(84, 0.02, 0.05), true, 'so do rounds');
  assert.equal(worth(68, 1, 0.25), true, 'and a litre of water');
  const saw = { name: 'Saw', weight: 3, saw: true };
  const [early] = plan([saw], {}, 20, 20);
  assert.equal(early.length, 1);
  const [late] = plan([saw], {}, 3.5, 20);
  assert.equal(late.length, 0, 'with 17% of the room left the saw stays');
});

test('rich loot: the run that started this takes the pistol and the medicine, and leaves the dye and the dinners', () => {
  // From the live run: a counter holding the junk she took, with a pistol, rounds and a bandage added.
  const tvDinner = { name: 'TV Dinner', weight: 0.4, edible: true, shelf: 4 };
  const pickle = { name: 'Pickle', weight: 0.2, edible: true, shelf: 3 };
  const descs = [
    { name: 'Industrial Dye', weight: 0.3 }, tvDinner, milk, pickle, frozen, frozen, plunger, pistol, rounds, bandage, perfume(),
  ];
  const [picks] = plan(descs, { hunger: 0.02, foodReady: 0, weaponValue: score(W.knife) }, 20);
  assert.deepEqual(picks.map((p) => descs[p.index - 1].name), ['Pistol', '9mm Bullets', 'Bandage']);
});
function perfume() { return { name: 'Perfume', weight: 0.1 }; }

test('describeLoot reads a pistol, its rounds, a magazine and a box', () => {
  const fresh = createHarness();
  fresh.autoload();
  const d = fresh.run(`
    local gun = __makeItem({ type = "Base.Pistol", name = "Pistol", weight = 1.5, gun = { ammo = "Base.Bullets9mm",
      mag = "Base.9mmClip", box = "Base.Bullets9mmBox", loaded = 3, max = 15, chambered = true } })
    return LocalSurvivor.Act.describeLoot(gun, __makePlayer({}))
  `);
  assert.equal(d.weapon, undefined, 'a pistol is not a melee weapon');
  assert.deepEqual(d.gun, { n: 'Pistol', ammoKey: 'Base.Bullets9mm', magKey: 'Base.9mmClip', boxKey: 'Base.Bullets9mmBox', loaded: 4, max: 15, broken: false });
  const bullets = fresh.run(`
    return LocalSurvivor.Act.describeLoot(__makeItem({ type = "Base.Bullets9mm", name = "9mm Bullets", weight = 0.02,
      tags = { AMMO = true }, count = 5 }), __makePlayer({}))
  `);
  assert.equal(bullets.ammo, 'Base.Bullets9mm');
  assert.equal(bullets.count, 5);
  const mag = fresh.run(`
    return LocalSurvivor.Act.describeLoot(__makeItem({ type = "Base.9mmClip", name = "9mm Magazine", weight = 0.2,
      ammoKey = "Base.Bullets9mm", maxAmmo = 15, rounds = 9 }), __makePlayer({}))
  `);
  assert.deepEqual(mag.mag, { key: 'Base.9mmClip', ammoKey: 'Base.Bullets9mm', rounds: 9, max: 15 });
  const box = fresh.run(`
    return LocalSurvivor.Act.describeLoot(__makeItem({ type = "Base.Bullets9mmBox", name = "Box of 9mm", weight = 0.8,
      displayCategory = "Ammo" }), __makePlayer({}))
  `);
  assert.equal(box.box, 'Base.Bullets9mmBox');
});

test('describeLoot reads dye and perfume as junk, a soda as a drink, and when food goes off', () => {
  const fresh = createHarness();
  fresh.autoload();
  const read = (opts) => fresh.run(`return LocalSurvivor.Act.describeLoot(__makeItem(${opts}), __makePlayer({}))`);
  const dye = read('{ type = "Base.Dye", name = "Industrial Dye", fluid = { other = 0.5, capacity = 1 }, weight = 0.5 }');
  assert.equal(dye.drink, false);
  assert.equal(dye.waterL, undefined);
  assert.deepEqual(kinds(dye), []);
  const flask = read('{ type = "Base.Perfume", name = "Perfume", fluid = { other = 0.1, capacity = 0.1 }, weight = 0.1 }');
  assert.deepEqual(kinds(flask), []);
  const emptyFlask = read('{ type = "Base.Perfume", name = "Perfume", fluid = { capacity = 0.1 }, weight = 0.1 }');
  assert.equal(emptyFlask.emptyBottle, false, 'a 0.1 L flask is not a bottle to fill at a tap');
  const emptyBottle = read('{ type = "Base.WaterBottle", name = "Water Bottle", fluid = { capacity = 1 }, weight = 0.1 }');
  assert.equal(emptyBottle.emptyBottle, true);
  const soda = read('{ type = "Base.Pop", name = "Pop", fluid = { other = 0.4, beverage = true, capacity = 0.5 }, weight = 0.5 }');
  assert.equal(soda.drink, true);
  const bread = read('{ type = "Base.Bread", name = "Bread", food = true, hung = -30, offMax = 6, age = 2, weight = 0.3 }');
  assert.equal(bread.shelf, 4);
  assert.equal(bread.frozen, false);
  const rice = read('{ type = "Base.Pasta", name = "Pasta", food = true, hung = -20, weight = 0.4 }');
  assert.equal(rice.shelf, undefined, 'a figure in the millions means it never goes off');
  const ice = read('{ type = "Base.IceCream", name = "Ice Cream", food = true, hung = -20, offMax = 5, frozen = true, weight = 0.4 }');
  assert.equal(ice.frozen, true);
  const abx = read('{ type = "Base.Antibiotics", name = "Antibiotics", weight = 0.1 }');
  assert.equal(abx.antibiotic, true);
});
