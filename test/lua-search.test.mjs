// SEARCH walks a room and opens every container in it: the ones on the room's own list, a
// fridge's second door, a counter nobody has looked at yet, and the floor. The run that started
// this card walked past a pistol and took dye and ice cream. The pathfinder and the transfer
// actions are stood in for here (a walk arrives at once, a transfer finishes at once); what the
// real ones do is a live check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const KITCHEN = `
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
  -- Furniture on a square holding one or more containers, like a fridge with a freezer.
  function __furniture(x, y, ...)
    local sq = __squares[x .. "," .. y .. ",0"]
    sq.opts.blocked = true
    local cs = { ... }
    for _, c in ipairs(cs) do c:getParent().getSquare = function() return sq end end
    local obj = __makeObject({ containers = cs })
    obj.square = sq
    table.insert(sq.objects, obj)
    return obj
  end
  __players[0] = __makePlayer({ x = 10.5, y = 10.5, live = true, maxWeight = 8 })
  P = __players[0]
  B = __makeBuilding({ id = "B1", x = 10, y = 10, x2 = 14, y2 = 14, res = true })
  ROOM = __makeRoom({ name = "kitchen", x = 10, y = 10, x2 = 14, y2 = 14 })
  B.def.getRooms = function() return __javaList({ ROOM.def }) end
  __floor(10, 10, 14, 14, { building = B, room = ROOM })
  local sqs = {}
  for x = 10, 14 do for y = 10, 14 do sqs[#sqs + 1] = __squares[x .. "," .. y .. ",0"] end end
  ROOM.getSquares = function() return __javaList(sqs) end

  BREAD = __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -30, weight = 0.3 })
  BANDAGE = __makeItem({ type = "Base.Bandage", name = "Bandage", bandage = true, weight = 0.1 })
  CROWBAR = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, crit = 20, range = 1.25,
    swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
  PISTOL = __makeItem({ type = "Base.Pistol", name = "Pistol", weight = 1.5,
    gun = { ammo = "Base.Bullets9mm", mag = "Base.9mmClip", box = "Base.Bullets9mmBox", loaded = 0, max = 15 } })
  ROUNDS = __makeItem({ type = "Base.Bullets9mm", name = "9mm Bullets", weight = 0.02, tags = { AMMO = true }, count = 5 })
  SHIRT = __makeItem({ type = "Base.Tshirt", name = "T-Shirt", clothing = true, weight = 0.2 })
  SPIFFO = __makeItem({ type = "Base.Spiffo", name = "Spiffo", weight = 0.4 })

  -- A fridge with a freezer, and the room's own list holds the first door only.
  FRIDGE = __makeContainer({ items = { BREAD }, type = "fridge" })
  FREEZER = __makeContainer({ items = { BANDAGE }, type = "freezer" })
  __furniture(11, 10, FRIDGE, FREEZER)
  ROOM.getContainer = function() return __javaList({ FRIDGE }) end
  -- A counter nobody has looked at: it is empty until the game rolls its loot.
  COUNTER = __makeContainer({ loot = { CROWBAR }, type = "counter" })
  __furniture(13, 10, COUNTER)
  -- A wardrobe of clothes.
  WARDROBE = __makeContainer({ items = { SHIRT }, type = "wardrobe" })
  __furniture(10, 14, WARDROBE)
  -- A pistol and its rounds on the floor, and something useless beside them.
  __squares["12,13,0"].opts.world = { PISTOL, ROUNDS, SPIFFO }
`;

function world(extra = '') {
  const lua = createHarness();
  lua.autoload();
  lua.run(KITCHEN + extra);
  return lua;
}

const order = (lua, line) => lua.run(`LocalSurvivor.Act.execIntent(P, "${line}")`);
const result = (lua) => lua.get('LocalSurvivor.result');

// Run the skill to its end: a walk arrives at once, a transfer finishes at once.
function runSearch(lua, limit = 600) {
  for (let i = 0; i < limit; i++) {
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
    if (result(lua).status !== 'running') return i;
  }
  throw new Error('the search did not end: ' + JSON.stringify(result(lua)));
}

const taken = (why) => why.replace(/^took \d+: /, '').split(', ').sort();

test('SEARCH opens every container in the room: the list, a second door, a cold counter and the floor', () => {
  const lua = world();
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  const r = result(lua);
  assert.equal(r.status, 'done', JSON.stringify(r));
  // Bread from the fridge, the bandage from the freezer the room list does not know, the crowbar
  // that only exists once the counter is opened, the pistol and its rounds from the floor.
  assert.deepEqual(taken(r.why), ['9mm Bullets', 'Bandage', 'Bread', 'Crowbar', 'Pistol']);
  assert.equal(lua.run('return #FREEZER.items + #COUNTER.items + #FRIDGE.items'), 0);
  assert.equal(lua.run('return COUNTER.explored'), true, 'the counter was rolled before it was read');
  assert.equal(lua.run('return WARDROBE.explored'), true, 'the wardrobe was opened too');
  assert.equal(lua.run('return #WARDROBE.items'), 1, 'and its shirt left alone');
  assert.deepEqual(lua.run('local out = {} for i, w in ipairs(__squares["12,13,0"].opts.world) do out[i] = w:getDisplayName() end return out'), ['Spiffo']);
  assert.equal(lua.get('LocalSurvivor.searched.B1')['kitchen@10,10,0'], true);
});

test('a room with a container the room list leaves out is not finished early', () => {
  // The old walk read only the room list when it had anything on it. With the freezer and the
  // counter missing from it, the search ended after the fridge.
  const lua = world();
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  assert.ok(taken(result(lua).why).includes('Bandage'));
  assert.ok(taken(result(lua).why).includes('Crowbar'));
});

test('an unexplored container is rolled once and read', () => {
  const lua = world();
  assert.equal(lua.run('return #COUNTER.items'), 0, 'empty until it is looked at');
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  assert.equal(lua.run('return COUNTER.loot'), undefined, 'rolled exactly once');
});

test('SEARCH takes the junk list nowhere: dye, perfume, a plunger, ice cream', () => {
  const lua = world(`
    DYE = __makeItem({ type = "Base.Dye", name = "Industrial Dye", fluid = { other = 0.5, capacity = 1 }, weight = 0.5 })
    PERFUME = __makeItem({ type = "Base.Perfume", name = "Perfume", fluid = { other = 0.1, capacity = 0.1 }, weight = 0.1 })
    PLUNGER = __makeItem({ type = "Base.Plunger", name = "Plunger", melee = true, dmg = 0.5, crit = 5, range = 1.1,
      swing = 4, cls = { "SMALL_BLUNT", "IMPROVISED" }, weight = 0.5 })
    ICE = __makeItem({ type = "Base.IceCream", name = "Ice Cream", food = true, hung = -20, offMax = 5, frozen = true, weight = 0.2 })
    DINNER = __makeItem({ type = "Base.TVDinner", name = "TV Dinner", food = true, hung = -40, offMax = 5, age = 1, weight = 0.4 })
    FRIDGE.items = { DYE, PERFUME, PLUNGER, ICE, DINNER }
    FREEZER.items = {}
    COUNTER.loot = nil
    COUNTER.explored = true
    __squares["12,13,0"].opts.world = {}
    P.hunger = 0
  `);
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'SEARCH', status: 'done', why: 'took nothing', target: 'B1' });
});

test('a pistol and its rounds are taken from a counter in the same visit', () => {
  const lua = world('FRIDGE.items = { PISTOL, ROUNDS }; FREEZER.items = {}; COUNTER.loot = nil; COUNTER.explored = true; __squares["12,13,0"].opts.world = {}');
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  assert.deepEqual(taken(result(lua).why), ['9mm Bullets', 'Pistol']);
});

test('a container she cannot reach leaves the room open for one more try', () => {
  const lua = world(`
    __adjacent = function(sq, p)
      if sq:getX() == 13 then return nil end
      for _, d in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do
        local n = __squares[(sq:getX() + d[1]) .. "," .. (sq:getY() + d[2]) .. "," .. sq:getZ()]
        if n and n:isFree(true) then return n end
      end
    end
  `);
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  assert.equal(result(lua).status, 'done');
  assert.ok(!taken(result(lua).why).includes('Crowbar'), 'the counter was never reached');
  assert.equal(lua.get('LocalSurvivor.searched.B1'), undefined, 'so the room is not finished');
  const left = () => lua.run('local _, m = LocalSurvivor.Sense.currentBuilding(P); return LocalSurvivor.Act.roomsLeft(m)');
  assert.equal(left(), 1);
  // The second visit tries it again, and that is the last: a container that never opens does not
  // keep the building from being searched forever.
  order(lua, '2|SEARCH|0|0|||');
  runSearch(lua);
  assert.equal(left(), 0);
});

test('what she dropped herself is not picked up again from the floor', () => {
  const lua = world('LocalSurvivor.Act.noteDropped(PISTOL)');
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  assert.ok(!taken(result(lua).why).includes('Pistol'));
  assert.ok(!taken(result(lua).why).includes('9mm Bullets'), 'and the rounds are no use without the gun');
  assert.ok(taken(result(lua).why).includes('Bread'), 'the rest of the room is still searched');
});

test('SEARCH stops at 85% of the limit, with a bag or without', () => {
  // maxWeight 8: the line is 6.8. 5 kg with no bag used to be "full" at the old 60% line.
  const none = world('P.weight = 5');
  order(none, '1|SEARCH|0|0|||');
  assert.equal(result(none).status, 'running');
  const full = world('P.weight = 7');
  order(full, '1|SEARCH|0|0|||');
  assert.equal(result(full).status, 'failed');
  assert.equal(result(full).why, 'full');
  const bag = world('P.weight = 5; P.back = __makeItem({ name = "School Bag", items = {}, back = true, capacity = 15 })');
  order(bag, '1|SEARCH|0|0|||');
  assert.equal(result(bag).status, 'running');
});

test('LOOT reads the same containers: the room it stands in, freezer and floor included', () => {
  const lua = world();
  order(lua, '1|LOOT|0|0|||');
  runSearch(lua);
  assert.equal(result(lua).verb, 'LOOT');
  assert.deepEqual(taken(result(lua).why), ['9mm Bullets', 'Bandage', 'Bread', 'Crowbar', 'Pistol']);
});

// ---------- too full for all of it ----------
const HEAVY_ROOM = `
  BEANS1 = __makeItem({ type = "Base.Beans", name = "Beans", food = true, canned = true, hung = -30, weight = 2 })
  BEANS2 = __makeItem({ type = "Base.Bread", name = "Loaf", food = true, hung = -30, weight = 2 })
  BEANS3 = __makeItem({ type = "Base.Bread", name = "Loaf", food = true, hung = -30, weight = 2 })
  BEANS4 = __makeItem({ type = "Base.Bread", name = "Loaf", food = true, hung = -30, weight = 2 })
  FRIDGE.items = { BEANS2, BEANS3, BEANS4 }
  FREEZER.items = {}
  COUNTER.loot = {}
  __squares["12,13,0"].opts.world = {}
  P.weight = 3
  -- Her real weight follows what she takes.
  P.getInventoryWeight = function(self) return self.weight + #self.__items.items * 2 end
`;

test('a room with wanted things left for weight stays open and the result says (full)', () => {
  const lua = world(HEAVY_ROOM);
  order(lua, '1|SEARCH|0|0||||BASE');
  runSearch(lua);
  const r = result(lua);
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.match(r.why, /^took 1: Loaf \(full\)$/);
  assert.notEqual(lua.get('LocalSurvivor.searched.B1')?.['kitchen@10,10,0'], true, 'she comes back for the rest');
  assert.deepEqual(lua.get('LocalSurvivor.searchStat.left'), 2);
});

test('after enough visits the room counts as done, so it cannot hold a house for ever', () => {
  const lua = world(HEAVY_ROOM + 'LocalSurvivor.fullTries = { ["B1/kitchen@10,10,0"] = 3 }');
  order(lua, '1|SEARCH|0|0||||BASE');
  runSearch(lua);
  assert.doesNotMatch(result(lua).why, /\(full\)/);
  assert.equal(lua.get('LocalSurvivor.searched.B1')['kitchen@10,10,0'], true);
});

test('in her own base, and with no base, nothing is kept open for weight', () => {
  for (const line of ['1|SEARCH|0|0||||B1', '1|SEARCH|0|0|||']) {
    const lua = world(HEAVY_ROOM);
    order(lua, line);
    runSearch(lua);
    assert.doesNotMatch(result(lua).why, /\(full\)/, line);
    assert.equal(lua.get('LocalSurvivor.searched.B1')['kitchen@10,10,0'], true, line);
  }
});

test('hauling, she takes past the food cap until the weight stops her', () => {
  const foods = Array.from({ length: 14 }, (_, i) => `__makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -30, weight = 0.1 })`).join(',');
  const stock = `
    FRIDGE.items = { ${foods} }
    for i = 1, 12 do table.insert(P.__items.items, __makeItem({ type = "Base.Bread", name = "Old", food = true, hung = -30, weight = 0.1 })) end
  `;
  const home = world(stock);
  order(home, '1|SEARCH|0|0|||');
  runSearch(home);
  assert.doesNotMatch(result(home).why, /Bread/, 'with no base the cap stands');
  const haul = world(stock);
  order(haul, '1|SEARCH|0|0||||BASE');
  runSearch(haul);
  assert.match(result(haul).why, /^took \d+: Bread/);
  assert.equal(haul.run('return #FRIDGE.items'), 0);
});

test('a bag found goes on, and what she carries goes in it', () => {
  const lua = world(`
    LOOSE = __makeItem({ type = "Base.Spiffo", name = "Spiffo", weight = 2 })
    table.insert(P.__items.items, LOOSE)
    SCHOOLBAG = __makeItem({ type = "Base.Bag_Schoolbag", name = "School Bag", items = {}, back = true, capacity = 15, weight = 1 })
    BAGINV = { getItems = function() return __javaList({}) end, hasRoomFor = function() return true end }
    SCHOOLBAG.getInventory = function() return BAGINV end
    WARDROBE.items = { SCHOOLBAG }
    P.weight = 6
  `);
  order(lua, '1|SEARCH|0|0|||');
  // Wearing and packing are stood in for: run until the wear action is queued, then put it on.
  for (let i = 0; i < 400 && result(lua).status === 'running'; i++) {
    lua.run(`
      LocalSurvivor.tick = LocalSurvivor.tick + 1
      LocalSurvivor.Act.update(P, false)
      local q = __queueTypes(P)
      for _, a in ipairs(ISTimedActionQueue.getTimedActionQueue(P).queue) do
        if a.Type == "ISInventoryTransferAction" and a.args[2] == LOOSE and P.back and a.args[4] == P.back:getInventory() then PACKED = true end
        -- The stub's transfer empties the queue, so the wear behind it is done here.
        if a.Type == "ISWearClothing" then P.back = SCHOOLBAG end
      end
      if PACKED then ISTimedActionQueue.clear(P)
      elseif q[1] == "ISWalkToTimedAction" then __arrive(P)
      elseif q[1] == "ISInventoryTransferAction" then __finishTransfers(P)
      elseif q[1] == "ISWearClothing" then
        P.back = SCHOOLBAG
        table.remove(ISTimedActionQueue.getTimedActionQueue(P).queue, 1)
      elseif q[1] then ISTimedActionQueue.clear(P) end
    `);
  }
  assert.match(result(lua).why, /School Bag/);
  assert.equal(lua.get('LocalSurvivor.searchStat.bags'), 1);
  assert.equal(lua.get('PACKED'), true, 'what was loose went into the bag');
});

test('a better jacket goes on and the old one stays behind', () => {
  const lua = world(`
    function __coat(name, scratch)
      local c = __makeItem({ type = "Base." .. name, name = name, clothing = true, weight = 1 })
      c.getBodyLocation = function() return "jacket" end
      c.getScratchDefense = function() return scratch end
      c.getBiteDefense = function() return 0 end
      return c
    end
    OLD = __coat("Old", 10)
    NEW = __coat("New", 40)
    WARDROBE.items = { NEW }
    P.getWornItems = function()
      return { size = function() return 1 end, getItemByIndex = function() return OLD end }
    end
    P.getWornItem = function(_, loc) return loc == "jacket" and OLD or nil end
  `);
  order(lua, '1|SEARCH|0|0|||');
  const seen = new Set();
  for (let i = 0; i < 400 && result(lua).status === 'running'; i++) {
    lua.run(`
      LocalSurvivor.tick = LocalSurvivor.tick + 1
      LocalSurvivor.Act.update(P, false)
    `);
    const q = lua.run('return __queueTypes(P)') || [];
    for (const t of q) seen.add(t);
    lua.run(`
      local q = __queueTypes(P)
      if q[1] == "ISWalkToTimedAction" then __arrive(P)
      elseif q[1] == "ISInventoryTransferAction" then __finishTransfers(P)
      elseif q[1] then ISTimedActionQueue.clear(P) end
    `);
  }
  assert.match(result(lua).why, /New/);
  assert.ok(seen.has('ISWearClothing'));
  assert.ok(seen.has('Menu:dropItem'), [...seen].join());
});

test('a coat no better than hers stays in the wardrobe', () => {
  const lua = world(`
    SAME = __makeItem({ type = "Base.Same", name = "Same", clothing = true, weight = 1 })
    SAME.getBodyLocation = function() return "jacket" end
    SAME.getScratchDefense = function() return 12 end
    WARDROBE.items = { SAME }
    WORN = __makeItem({ type = "Base.Worn", name = "Worn", clothing = true, weight = 1 })
    WORN.getBodyLocation = function() return "jacket" end
    WORN.getScratchDefense = function() return 10 end
    P.getWornItems = function()
      return { size = function() return 1 end, getItemByIndex = function() return WORN end }
    end
  `);
  order(lua, '1|SEARCH|0|0|||');
  runSearch(lua);
  assert.doesNotMatch(result(lua).why, /Same/);
});

test('with no bag, closets and bedrooms come before the rest once she has a weapon', () => {
  const lua = world();
  assert.equal(lua.call('LocalSurvivor.Act.bagRoomRank', 'bedroom@1,1,0'), 1);
  assert.equal(lua.call('LocalSurvivor.Act.bagRoomRank', 'closet@1,1,0'), 1);
  assert.equal(lua.call('LocalSurvivor.Act.bagRoomRank', 'bathroom@1,1,0'), 3);
});

test('a restock SEARCH opens her own stash and stops at the kit', () => {
  const lua = world(`
    local foods = {}
    for i = 1, 10 do
      local f = __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -30, weight = 0.1 })
      f.getModData = function() return { lsStash = "B1" } end
      foods[i] = f
    end
    FRIDGE.items = foods
    LocalSurvivor.searched.B1 = { ["kitchen@10,10,0"] = true }
    LocalSurvivor.stashRooms = { B1 = { ["kitchen@10,10,0"] = true } }
  `);
  order(lua, '1|SEARCH|0|0||||restock');
  runSearch(lua);
  assert.match(result(lua).why, /^took \d+/);
  assert.equal(lua.run('return #FRIDGE.items'), 4, 'six out, four stay');
});
