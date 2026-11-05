// Percept v2: the pure summarisers on plain tables, the item checks, the place scan, and the
// whole percept line, driven through the harness with stub players and buildings.
// What the real game returns for each call can only be checked live (docs/percept.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function body() {
  const lua = createHarness();
  lua.autoload();
  return lua;
}

function percept(lua) {
  return JSON.parse(lua.run('return LocalSurvivor.Sense.buildPercept(__players[0])'));
}

test('Core.json prints lists, sorted objects, null and safe strings', () => {
  const lua = body();
  assert.equal(lua.run('return LocalSurvivor.Core.json({ b = 1, a = { 1, 2 }, c = {} })'), '{"a":[1,2],"b":1,"c":[]}');
  assert.equal(lua.run('return LocalSurvivor.Core.json({ x = LocalSurvivor.Core.NULL, y = true })'), '{"x":null,"y":true}');
  assert.equal(lua.run('return LocalSurvivor.Core.json(0.125)'), '0.13');
  assert.equal(lua.run('return LocalSurvivor.Core.json(3.0)'), '3');
  assert.deepEqual(JSON.parse(lua.run('return LocalSurvivor.Core.json("tab\\there \\"q\\" back\\\\")')), 'tab here "q" back\\');
});

test('a sealed can is not edible, but it is still food to pick up', () => {
  const lua = body();
  const check = (opts) => lua.run(`
    local it = __makeItem(${opts})
    local C = LocalSurvivor.Core
    return { C.isEdible(it), C.isSealedFood(it), C.isFoodSupply(it) }`);
  assert.deepEqual(check('{ food = true, hung = -0.2, cantEat = true, opening = "OpenCannedFood" }'), [false, true, true]);
  assert.deepEqual(check('{ food = true, hung = -0.1 }'), [true, false, true]);
  assert.deepEqual(check('{ food = true, hung = -0.1, rotten = true }'), [false, false, false]);
  assert.deepEqual(check('{ food = true, hung = 0 }'), [false, false, false]);
  assert.deepEqual(check('{ food = true, hung = -0.1, poison = 5 }'), [false, false, false]);
  assert.deepEqual(check('{ name = "Hammer" }'), [false, false, false]);
});

test('summarizeWounds keeps injured parts, worst first, and counts bleeding', () => {
  const lua = body();
  const out = lua.call('LocalSurvivor.Sense.summarizeWounds', [
    { part: 'Hand_L', scratch: true },
    { part: 'Head' },
    { part: 'ForeArm_R', bite: true, bleed: true },
    { part: 'Foot_L', glass: true, bleed: true },
    { part: 'Torso_Upper', bandaged: true, dirty: true },
  ]);
  assert.equal(out.bleeding, 2);
  assert.deepEqual(out.wounds.map((w) => w.part), ['ForeArm_R', 'Foot_L', 'Hand_L', 'Torso_Upper']);
  assert.deepEqual(out.wounds[0], {
    part: 'ForeArm_R', bleed: true, bite: true,
  });
  assert.deepEqual(out.wounds[3], { part: 'Torso_Upper', bandaged: true, dirty: true });
  assert.deepEqual(lua.call('LocalSurvivor.Sense.summarizeWounds', []), { wounds: [], bleeding: 0 });
});

test('summarizeZombies counts chasers and downed, lists the nearest six within 25', () => {
  const lua = body();
  const zs = [
    { dx: 30, dy: 20, chase: true },          // 36 away: chasing, not listed
    { dx: 2, dy: 0, down: true, crawl: true }, // downed and close
    { dx: 5, dy: 0, down: true },              // downed but not within 3
    { dx: 0, dy: -8, chase: true },
    { dx: 24, dy: 0 }, { dx: 0, dy: 10 }, { dx: 12, dy: 0 }, { dx: 15, dy: 0 }, { dx: 9, dy: 9 },
  ];
  const out = lua.call('LocalSurvivor.Sense.summarizeZombies', zs);
  assert.equal(out.zChasing, 2);
  assert.equal(out.zDowned, 1);
  assert.equal(out.zList.length, 6);
  assert.deepEqual(out.zList[0], { dx: 2, dy: 0, d: 2, chase: false, down: true, crawl: true });
  assert.deepEqual(out.zList.map((z) => z.d), [2, 5, 8, 10, 12, 12.7]);
  assert.deepEqual(lua.call('LocalSurvivor.Sense.summarizeZombies', []), { zChasing: 0, zDowned: 0, zList: [] });
});

test('summarizeBuildings sorts by distance to the walls and picks the nearest door', () => {
  const lua = body();
  lua.run('LocalSurvivor.visited.B2 = true');
  const list = lua.run(`
    local bs = {
      { id = "B1", x = 30, y = 0, x2 = 40, y2 = 10, res = true, shop = false, doors = { { x = 30, y = 5 }, { x = 35, y = 11 } } },
      { id = "B2", x = -5, y = -5, x2 = 5, y2 = 5, res = false, shop = true },
      { id = "FAR", x = 100, y = 100, x2 = 110, y2 = 110 },
    }
    return LocalSurvivor.Core.json(LocalSurvivor.Sense.summarizeBuildings(bs, 0, 0, LocalSurvivor.visited))`);
  assert.deepEqual(JSON.parse(list), [
    { id: 'B2', dx: 0, dy: 0, d: 0, res: false, shop: true, door: null, visited: true },
    { id: 'B1', dx: 30, dy: 0, d: 30, res: true, shop: false, door: { x: 30, y: 5 }, visited: false },
  ]);
});

test('summarizeInventory counts supplies and keeps the four best weapons', () => {
  const lua = body();
  const out = lua.call('LocalSurvivor.Sense.summarizeInventory', [
    { edible: true }, { edible: true }, { sealed: true }, { opener: true },
    { waterL: 0.8 }, { waterL: 0.25 }, { emptyBottle: true }, { bandage: true }, { disinfect: true },
    { painkiller: true }, { hammer: true }, { lighter: true },
    { melee: { n: 'Knife', dmg: 0.6, cond: 1, reach: 0.9 } },
    { melee: { n: 'Bat', dmg: 1.3, cond: 0.5, reach: 1.25 } },
    { melee: { n: 'Pan', dmg: 0.8, cond: 1, reach: 1 } },
    { melee: { n: 'Pipe', dmg: 1.1, cond: 1, reach: 1.2 } },
    { melee: { n: 'Spoon', dmg: 0.1, cond: 1, reach: 0.5 } },
  ]);
  assert.deepEqual(out.inv, {
    foodReady: 2, cans: 1, canOpener: true, waterL: 1.05, emptyBottles: 1, bandages: 1, disinfectant: 1,
    painkillers: 1, hammer: true, saw: false, screwdriver: false, lighter: true,
  });
  assert.deepEqual(out.weapons.map((w) => w.n), ['Bat', 'Pipe', 'Pan', 'Knife']);
});

test('a bare player still gives a percept that parses, with v2 defaults', () => {
  const lua = body();
  lua.run('__players[0] = __makePlayer({ x = 10, y = 10, stats = { PANIC = 23.46 } })');
  const p = percept(lua);
  assert.equal(p.v, 2);
  assert.equal(p.panic, 23.46);
  assert.equal(p.panic01, 0.23);
  assert.equal(p.inBldg, null);
  assert.equal(p.water, null);
  assert.equal(p.bed, null);
  assert.deepEqual(p.buildings, []);
  assert.deepEqual(p.res, { seq: 0, verb: '', status: 'idle', why: '' });
  assert.equal(p.bag, 'none');
  assert.equal(p.dark, false);
});

test('a rich player fills every v2 field from the game calls', () => {
  const lua = body();
  lua.run(`
    local can = __makeItem({ name = "Beans", food = true, hung = -0.3, cantEat = true, opening = "OpenCannedFood" })
    local apple = __makeItem({ name = "Apple", food = true, hung = -0.1 })
    local opener = __makeItem({ name = "Can Opener", tags = { CAN_OPENER = true } })
    local bottle = __makeItem({ name = "Water Bottle", fluid = { water = 0.8 } })
    local dirtyBottle = __makeItem({ name = "Pond Bottle", fluid = { water = 1, tainted = true } })
    local empty = __makeItem({ name = "Pop Bottle", fluid = {} })
    local bandage = __makeItem({ name = "Bandage", bandage = true })
    local dirty = __makeItem({ type = "Base.BandageDirty", name = "Dirty Bandage", bandage = true, tags = { CAN_BE_WASHED = true } })
    local rag = __makeItem({ type = "Base.RippedSheets", name = "Ripped Sheets", bandage = true })
    local wipes = __makeItem({ name = "Alcohol Wipes", drainable = true, alcoholPower = 4 })
    local booze = __makeItem({ name = "Disinfectant", fluid = { alcohol = 0.5 } })
    local pills = __makeItem({ type = "Base.Pills", name = "Painkillers" })
    local hammer = __makeItem({ name = "Hammer", melee = true, dmg = 1, range = 1.1, cond = 8, condMax = 10, tags = { HAMMER = true } })
    local axe = __makeItem({ name = "Axe", melee = true, dmg = 2, range = 1.2 })
    local bag = __makeItem({ name = "School Bag", items = { axe, can } })
    local zombie = function(o) table.insert(__zombies, __makeZombie(o)) end
    local p = __makePlayer({
      x = 10, y = 10, kills = 3, hours = 5.5, weight = 7.25, maxWeight = 8, back = bag, visible = 2,
      items = { apple, opener, bottle, dirtyBottle, empty, bandage, dirty, rag, wipes, booze, pills, hammer, bag },
      moodles = { THIRST = 2, TIRED = 1, PANIC = 3, HEAVY_LOAD = 1 },
      parts = { __makeBodyPart({ type = "Hand_R", scratched = true, bleeding = true }), __makeBodyPart({ type = "Head" }) },
    })
    __players[0] = p
    zombie({ x = 22, y = 10, target = p })
    zombie({ x = 10, y = 26, target = p })
    zombie({ x = 12, y = 10, floor = true })
    zombie({ x = 11, y = 11, dead = true })
  `);
  const p = percept(lua);
  assert.equal(p.kills, 3);
  assert.equal(p.hoursAlive, 5.5);
  assert.deepEqual(p.moodle, { endurance: 0, tired: 1, panic: 3, pain: 0, heavy: 1, hungry: 0, thirsty: 2 });
  assert.equal(p.weight, 7.25);
  assert.equal(p.maxWeight, 8);
  assert.equal(p.bag, 'School Bag');
  assert.deepEqual(p.inv, {
    foodReady: 1, cans: 1, canOpener: true, waterL: 0.8, emptyBottles: 1, bandages: 2, disinfectant: 2,
    painkillers: 1, hammer: true, saw: false, screwdriver: false, lighter: false,
  });
  assert.equal(p.foods, 1, 'the old field no longer counts the can');
  assert.deepEqual(p.weapons, [
    { n: 'Axe', dmg: 2, cond: 1, reach: 1.2 },
    { n: 'Hammer', dmg: 1, cond: 0.8, reach: 1.1 },
  ]);
  assert.equal(p.bleeding, 1);
  assert.deepEqual(p.wounds.map((w) => w.part), ['Hand_R']);
  assert.equal(p.zChasing, 2);
  assert.equal(p.zVisible, 2);
  assert.equal(p.zDowned, 1);
  assert.equal(p.zList.length, 3);
  assert.deepEqual(p.zList[0], { dx: 2, dy: 0, d: 2, chase: false, down: true, crawl: false });
});

// A house the player stands in, with a kitchen sink, a bed and two doors, and a shop nearby.
function town(lua, { sinkWater = 100 } = {}) {
  lua.run(`
    local sink = __makeObject({ water = ${sinkWater} })
    local kitchen = __makeRoom({ name = "kitchen", waters = { sink } })
    local bedroom = __makeRoom({ name = "bedroom" })
    local house = __makeBuilding({ id = "H1", x = 0, y = 0, x2 = 9, y2 = 7, res = true, rooms = { kitchen, bedroom }, water = true })
    local shop = __makeBuilding({ id = "S1", x = 30, y = 0, x2 = 45, y2 = 12, shop = true })
    __makeBuilding({ id = "FAR", x = 200, y = 200, x2 = 210, y2 = 210 })
    for x = 0, 10 do
      for y = 0, 8 do
        local o = { x = x, y = y, building = house }
        if x == 0 and y == 4 then o.door = "exterior" end
        if x == 5 and y == 8 then o.door = "exterior" end
        if x == 4 and y == 4 then o.door = "interior" end
        if x == 2 and y == 2 then o.objects = { sink }; o.room = kitchen end
        if x == 3 and y == 3 then o.room = kitchen end
        if x == 7 and y == 6 then o.objects = { __makeObject({ bed = true }) }; o.room = bedroom end
        local sq = __makeSquare(o)
        if o.room == kitchen then kitchen.sq = sq end
      end
    end
    for x = 30, 46 do
      for y = 0, 13 do
        local o = { x = x, y = y, building = shop }
        if x == 30 and y == 6 then o.door = "exterior" end
        __makeSquare(o)
      end
    end
    local function roomSquares(room, xs)
      local list = {}
      for _, xy in ipairs(xs) do table.insert(list, __squares[xy]) end
      room.getSquares = function() return __javaList(list) end
    end
    roomSquares(kitchen, { "2,2,0", "3,2,0" })
    roomSquares(bedroom, { "7,6,0", "6,6,0" })
    local p = __makePlayer({ x = 3, y = 3, square = __squares["3,3,0"] })
    __players[0] = p
  `);
}

function scan(lua, ticks = 60) {
  for (let i = 0; i < ticks; i++) {
    lua.run('LocalSurvivor.tick = LocalSurvivor.tick + 1; LocalSurvivor.Sense.step(__players[0])');
  }
}

test('the place scan finds buildings, doors, water and a bed over a few ticks', () => {
  const lua = body();
  town(lua);
  scan(lua);
  assert.equal(lua.get('LocalSurvivor.senseScan.phase'), 'idle');
  const p = percept(lua);
  assert.deepEqual(p.inBldg, { id: 'H1', rooms: 2, explored: false, water: true, room: 'kitchen' });
  assert.deepEqual(p.water, { x: 2, y: 2, z: 0, d: 1.4 });
  assert.deepEqual(p.bed, { x: 7, y: 6, z: 0, d: 5 });
  assert.deepEqual(p.buildings, [
    { id: 'H1', dx: 0, dy: 0, d: 0, res: true, shop: false, door: { x: 0, y: 4 }, visited: true },
    { id: 'S1', dx: 27, dy: 0, d: 27, res: false, shop: true, door: { x: 30, y: 6 }, visited: false },
  ]);
});

test('a sink with no water left is not offered', () => {
  const lua = body();
  town(lua, { sinkWater: 0 });
  scan(lua);
  assert.equal(percept(lua).water, null);
});

test('walking out of the building drops water and bed and asks for a new scan', () => {
  const lua = body();
  town(lua);
  scan(lua);
  lua.run('__players[0].x = 20; __players[0].y = 3; __players[0].getSquare = function() return nil end');
  const p = percept(lua);
  assert.equal(p.inBldg, null);
  assert.equal(p.water, null);
  assert.equal(lua.get('LocalSurvivor.senseScan.force'), true);
  scan(lua);
  assert.equal(lua.get('LocalSurvivor.seen.homeId'), undefined);
  const after = percept(lua).buildings;
  assert.equal(after.find((b) => b.id === 'H1').visited, true);
  assert.equal(after.find((b) => b.id === 'S1').visited, false);
});

test('night makes it dark', () => {
  const lua = body();
  lua.run('__players[0] = __makePlayer({}); __time.night = true');
  assert.equal(percept(lua).dark, true);
});

test('a busy worst case stays under about 3 KB', () => {
  const lua = body();
  lua.run(`
    local items, parts = {}, {}
    for i = 1, 20 do
      table.insert(items, __makeItem({ name = "Very Long Item Name Number " .. i, melee = i <= 6, dmg = i / 10, range = 1.15 }))
    end
    for i = 1, 17 do
      table.insert(parts, __makeBodyPart({ type = "BodyPart_" .. i, scratched = true, bleeding = i % 2 == 0, glass = true }))
    end
    local p = __makePlayer({ x = 50, y = 50, items = items, parts = parts, back = __makeItem({ name = "Big Hiking Bag" }) })
    __players[0] = p
    for i = 1, 40 do table.insert(__zombies, __makeZombie({ x = 50 + (i % 20) - 10, y = 50 + i % 7, target = p })) end
    for i = 1, 10 do
      __makeBuilding({ id = "123456789" .. i, x = 50 + i * 3, y = 50, x2 = 52 + i * 3, y2 = 52, res = true })
    end
  `);
  lua.set('LocalSurvivor.lastError', 'loot: no stocked container within 10 tiles');
  lua.call('LocalSurvivor.setResult', 12, 'LOOT', 'failed', 'loot: no stocked container within 10 tiles');
  scan(lua);
  const line = lua.run('return LocalSurvivor.Sense.buildPercept(__players[0])');
  const p = JSON.parse(line);
  assert.equal(p.zList.length, 6);
  assert.equal(p.wounds.length, 8);
  assert.equal(p.buildings.length, 6);
  assert.equal(p.weapons.length, 4);
  assert.ok(line.length < 3100, `percept is ${line.length} bytes`);
});
