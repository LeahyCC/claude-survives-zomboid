// STASH puts what she does not need on her into a container in her base. Soak 3: 9 of 32 unsearched
// houses ended on "full" and DROP failed "nothing to drop" 5 of 13 times, because what she carried
// was all worth keeping. A walk arrives at once and a transfer finishes at once here. What the real
// ones do with a world container is a live check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const HOUSE = `
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
  function __furniture(x, y, c)
    local sq = __squares[x .. "," .. y .. ",0"]
    sq.opts.blocked = true
    c:getParent().getSquare = function() return sq end
    local obj = __makeObject({ containers = { c } })
    obj.square = sq
    table.insert(sq.objects, obj)
  end
  __players[0] = __makePlayer({ x = 10.5, y = 10.5, live = true, maxWeight = 10 })
  P = __players[0]
  B = __makeBuilding({ id = "B1", x = 10, y = 10, x2 = 14, y2 = 14, res = true })
  ROOM = __makeRoom({ name = "bedroom", x = 10, y = 10, x2 = 14, y2 = 14 })
  B.def.getRooms = function() return __javaList({ ROOM.def }) end
  __floor(10, 10, 14, 14, { building = B, room = ROOM })
  local sqs = {}
  for x = 10, 14 do for y = 10, 14 do sqs[#sqs + 1] = __squares[x .. "," .. y .. ",0"] end end
  ROOM.getSquares = function() return __javaList(sqs) end

  CRATE = __makeContainer({ type = "crate" })
  WARDROBE = __makeContainer({ type = "wardrobe" })
  FRIDGE = __makeContainer({ type = "fridge" })
  __furniture(11, 10, FRIDGE)
  __furniture(13, 10, WARDROBE)
  __furniture(10, 14, CRATE)

  CROWBAR = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, crit = 20, range = 1.25,
    swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
  BAT = __makeItem({ type = "Base.BaseballBat", name = "Bat", melee = true, dmg = 1.1, crit = 40, range = 1.25,
    swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 1.5 })
  WRENCH = __makeItem({ type = "Base.Wrench", name = "Wrench", melee = true, dmg = 0.8, crit = 10, range = 1.1,
    swing = 3, cls = { "BLUNT" }, weight = 1 })
  HAMMER = __makeItem({ type = "Base.Hammer", name = "Hammer", tags = { HAMMER = true }, weight = 1 })
  DUMBBELL = __makeItem({ type = "Base.DumbBell", name = "Dumb Bell", weight = 3 })
  SPIFFO = __makeItem({ type = "Base.Spiffo", name = "Spiffo", weight = 0.4 })
  WATER = __makeItem({ type = "Base.WaterBottle", name = "Water Bottle", fluid = { water = 0.8, capacity = 1 }, weight = 0.9 })
  BREAD = __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -0.4, weight = 0.3 })
  SOUP = __makeItem({ type = "Base.Soup", name = "Soup", food = true, hung = -0.4, weight = 0.5 })
  BANDAGE = __makeItem({ type = "Base.Bandage", name = "Bandage", bandage = true, weight = 0.1 })
  SHIRT = __makeItem({ type = "Base.Tshirt", name = "T-Shirt", clothing = true, worn = true, weight = 0.2 })
  PACK = __makeItem({ type = "Base.Bag_Schoolbag", name = "School Bag", items = {}, back = true, worn = true, weight = 1 })
  P.back = PACK
  P.primary = CROWBAR
  P.weight = 10
  P.__items.items = { CROWBAR, SHIRT, BREAD, WATER, BANDAGE, PACK }
`;

function world(extra = '') {
  const lua = createHarness();
  lua.autoload();
  lua.run(HOUSE + extra);
  return lua;
}

const order = (lua, line) => lua.run(`LocalSurvivor.Act.execIntent(P, "${line}")`);
const result = (lua) => lua.get('LocalSurvivor.result');
const names = (lua, list) => lua.run(`local out = {} for i, it in ipairs(${list}) do out[i] = it:getDisplayName() end return out`);

// Run the job to its end, every 5 ticks as onTick does: a walk arrives, a transfer finishes.
function run(lua, limit = 400) {
  for (let i = 0; i < limit; i++) {
    lua.run(`
      LocalSurvivor.tick = LocalSurvivor.tick + 5
      local q = __queueTypes(P)
      if q[1] == "ISWalkToTimedAction" then __arrive(P)
      elseif q[1] == "ISInventoryTransferAction" then __finishStash(P)
      elseif q[1] == "Menu:dropItem" then
        for _, c in ipairs(__menuCalls) do
          if c.name == "dropItem" then P.weight = P.weight - c.args[1]:getActualWeight() end
        end
        __finishDrops(P)
      end
      LocalSurvivor.Needs.update(P, false)
    `);
    if (result(lua).status !== 'running') return i;
  }
  throw new Error('the stash did not end: ' + JSON.stringify(result(lua)));
}

const stashLine = '1|STASH|0|0||||B1';

// ---------- the keep list ----------
const plan = (lua, descs, over) => lua.callMulti('LocalSurvivor.Needs.planStash', descs, over);
const crowbar = { name: 'Crowbar', weight: 2, weapon: { cls: 'blunt', dmg: 1.15, crit: 20, reach: 1.25, two: true, wt: 2, swing: 3, cond: 1 } };
const bat = { name: 'Bat', weight: 2, weapon: { cls: 'blunt', dmg: 1.1, crit: 40, reach: 1.25, two: true, wt: 2, swing: 3, cond: 1 } };
const wrench = { name: 'Wrench', weight: 1, weapon: { cls: 'blunt', dmg: 0.8, crit: 10, reach: 1.1, wt: 1, swing: 3, cond: 1 } };
const dumbbell = { name: 'Dumb Bell', weight: 3 };
const hammer = { name: 'Hammer', weight: 1, hammer: true };

test('she keeps the weapon in hand and the best spare, and a third goes in', () => {
  const lua = world();
  const [picks] = plan(lua, [{ ...crowbar, held: true }, bat, wrench], 100);
  assert.deepEqual(picks, [3]);
});

test('with empty hands the two best weapons stay on her', () => {
  const lua = world();
  const [picks] = plan(lua, [wrench, crowbar, bat], 100);
  assert.deepEqual(picks, [1]);
});

test('worn clothes, the worn bag, water, bandages, rags and a key never go in', () => {
  const lua = world();
  const [picks] = plan(lua, [
    { name: 'Jeans', weight: 1, clothing: true, worn: true },
    { name: 'School Bag', weight: 1, container: true, worn: true, empty: true },
    { name: 'Water Bottle', weight: 1, waterL: 0.8 },
    { name: 'Bandage', weight: 0.1, bandage: true },
    { name: 'Ripped Sheets', weight: 0.1, bandage: true, sheet: true },
    { name: 'Dirty Rag', weight: 0.1, cloth: true },
    { name: 'House Key', weight: 0.1, type: 'Base.Key1' },
  ], 100);
  assert.deepEqual(picks, []);
});

test('a carried bag only goes in once it is empty, and early', () => {
  const lua = world();
  const full = { name: 'Duffel', weight: 2, container: true };
  assert.deepEqual(plan(lua, [full], 100)[0], []);
  assert.deepEqual(plan(lua, [{ ...full, empty: true }, hammer], 100)[0], [1, 2]);
});

test('food for 2 days stays, what rots soonest first, and the sealed cans go in before it', () => {
  const lua = world();
  const milk = { name: 'Milk', weight: 1, edible: true, hunger: 0.8, shelf: 2 };
  const stew = { name: 'Stew', weight: 1, edible: true, hunger: 0.8, shelf: 4 };
  const jerky = { name: 'Jerky', weight: 1, edible: true, hunger: 0.8 };
  const beans = { name: 'Beans', weight: 1, sealed: true, hunger: 0.8 };
  // 0.8 + 0.8 + 0.8 passes 2. The can is left over and goes in.
  assert.deepEqual(plan(lua, [beans, jerky, stew, milk], 100)[0], [1]);
  // No hunger figure on a can: it still counts as a small meal, so 8 of them hold 2 days.
  const cans = Array.from({ length: 10 }, () => ({ name: 'Beans', weight: 1, sealed: true }));
  assert.equal(plan(lua, cans, 100)[0].length, 2);
});

test('she keeps one gun with the ammo that fits it, and a second gun and its rounds go in', () => {
  const lua = world();
  const pistol = { name: 'Pistol', weight: 1, gun: { ammoKey: 'Base.9mm', magKey: 'Base.9mmClip', boxKey: 'Base.9mmBox', loaded: 3 } };
  const rifle = { name: 'Rifle', weight: 3, gun: { ammoKey: 'Base.308', magKey: '', boxKey: 'Base.308Box', loaded: 0 } };
  const rounds = { name: '9mm', weight: 0.5, ammo: 'Base.9mm', count: 5 };
  const clip = { name: 'Clip', weight: 0.5, mag: { key: 'Base.9mmClip', ammoKey: 'Base.9mm' } };
  const box = { name: '9mm Box', weight: 0.5, box: 'Base.9mmBox' };
  const other = { name: '308', weight: 0.5, ammo: 'Base.308', count: 5 };
  const [picks] = plan(lua, [pistol, rifle, rounds, clip, box, other], 100);
  assert.deepEqual(picks.sort(), [2, 6]);
});

test('least needed first, heaviest first among equals, and it stops once enough is shed', () => {
  const lua = world();
  const spiffo = { name: 'Spiffo', weight: 0.4 };
  const [picks, shed] = plan(lua, [hammer, spiffo, dumbbell, wrench, crowbar, { ...bat, held: true }], 3.2);
  assert.deepEqual(picks, [3, 2], 'the dumb bell, then the toy tips it over');
  assert.ok(Math.abs(shed - 3.4) < 1e-9, String(shed));
});

test('a crate first, a shelf or wardrobe next, a counter after that, and never a fridge, stove or bin', () => {
  const lua = world();
  const rank = (kind) => lua.call('LocalSurvivor.Needs.stashRank', kind) ?? null;
  assert.equal(rank('crate'), 1);
  assert.equal(rank('metal_shelves'), 2);
  assert.equal(rank('wardrobe'), 2);
  assert.equal(rank('counter'), 3);
  for (const no of ['fridge', 'freezer', 'stove', 'bin', 'floor', 'Bag_Schoolbag', 'postbox']) assert.equal(rank(no), null, no);
});

// ---------- the skill ----------
test('STASH walks to the crate, puts the junk in and says how many', () => {
  const lua = world('table.insert(P.__items.items, DUMBBELL); table.insert(P.__items.items, SPIFFO); P.weight = 9');
  order(lua, stashLine);
  assert.equal(result(lua).status, 'running');
  assert.equal(result(lua).target, 'B1');
  assert.deepEqual(lua.run('return __queueTypes(P)'), ['ISWalkToTimedAction']);
  run(lua);
  assert.deepEqual(names(lua, 'CRATE.items'), ['Dumb Bell']);
  assert.deepEqual(result(lua), { seq: 1, verb: 'STASH', status: 'done', why: 'stashed 1', target: 'B1' });
  assert.equal(lua.run('return FRIDGE.items[1]'), undefined, 'the crate wins, nothing near the fridge');
});

test('STASH sheds past the search line, so there is room to search', () => {
  // 85% of 10 with a bag is 8.5. A room of 20% takes it to 6.5, which needs both, not just the dumb bell.
  const lua = world('table.insert(P.__items.items, DUMBBELL); table.insert(P.__items.items, HAMMER); P.weight = 10.6');
  order(lua, stashLine);
  run(lua);
  assert.equal(result(lua).why, 'stashed 2');
  assert.ok(lua.run('return P.weight') <= 6.6);
});

test('STASH tells when she is still over the line with nothing more to put in', () => {
  const lua = world('table.insert(P.__items.items, SPIFFO); P.weight = 20');
  order(lua, stashLine);
  run(lua);
  assert.equal(result(lua).why, 'stashed 1 (still heavy)');
});

test('STASH fails "not at base" in another building, and outside', () => {
  const other = world();
  order(other, '1|STASH|0|0||||B2');
  assert.deepEqual(result(other), { seq: 1, verb: 'STASH', status: 'failed', why: 'not at base' });
  const out = world('P.sq = __makeSquare({ x = 50, y = 50 })');
  order(out, stashLine);
  assert.equal(result(out).why, 'not at base');
  const none = world();
  order(none, '1|STASH|0|0|||');
  assert.equal(result(none).why, 'not at base');
});

test('STASH fails "nothing to stash" when all she carries is on the keep list', () => {
  const lua = world();
  order(lua, stashLine);
  run(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'STASH', status: 'failed', why: 'nothing to stash', target: 'B1' });
  assert.deepEqual(names(lua, 'CRATE.items'), []);
});

test('STASH with nothing over the line has nothing to do', () => {
  const lua = world('table.insert(P.__items.items, SPIFFO); P.weight = 3');
  order(lua, stashLine);
  run(lua);
  assert.equal(result(lua).why, 'nothing to stash');
  assert.deepEqual(names(lua, 'CRATE.items'), []);
});

test('with no container fit for gear it goes on the floor of the room', () => {
  const lua = world('CRATE.getType = function() return "bin" end; WARDROBE.getType = function() return "stove" end; table.insert(P.__items.items, DUMBBELL)');
  order(lua, stashLine);
  assert.deepEqual(lua.run('return __queueTypes(P)'), ['Menu:dropItem']);
  run(lua);
  assert.equal(result(lua).why, 'stashed 1');
  assert.deepEqual(lua.get('LocalSurvivor.stashRooms.B1'), { 'bedroom@10,10,0': true });
});

test('a full crate moves on to one more container, and two is the limit', () => {
  const lua = world('CRATE.full = true; table.insert(P.__items.items, DUMBBELL)');
  order(lua, stashLine);
  run(lua);
  assert.deepEqual(names(lua, 'WARDROBE.items'), ['Dumb Bell']);
  assert.equal(result(lua).why, 'stashed 1');
  const both = world(`
    CRATE.full = true; WARDROBE.full = true
    SHELF = __makeContainer({ type = "shelves" })
    __furniture(14, 14, SHELF)
    table.insert(P.__items.items, DUMBBELL)
  `);
  order(both, stashLine);
  run(both);
  assert.equal(both.run('return #SHELF.items'), 0, 'not a third');
  assert.equal(result(both).why, 'nothing to stash');
});

test('the next STASH goes to the same containers, not a nearer one', () => {
  const lua = world('table.insert(P.__items.items, DUMBBELL)');
  order(lua, stashLine);
  run(lua);
  assert.deepEqual(names(lua, 'CRATE.items'), ['Dumb Bell']);
  lua.run(`
    NEAR = __makeContainer({ type = "crate" })
    __furniture(12, 14, NEAR)
    table.insert(P.__items.items, HAMMER)
    P.weight = 10
  `);
  order(lua, '2|STASH|0|0||||B1');
  run(lua);
  assert.deepEqual(names(lua, 'CRATE.items'), ['Dumb Bell', 'Hammer']);
});

test('an item the game will not move stays on her and is not counted', () => {
  const lua = world('table.insert(P.__items.items, DUMBBELL)');
  order(lua, stashLine);
  for (let i = 0; i < 40 && result(lua).status === 'running'; i++) {
    lua.run(`
      LocalSurvivor.tick = LocalSurvivor.tick + 5
      local q = __queueTypes(P)
      if q[1] == "ISWalkToTimedAction" then __arrive(P)
      elseif q[1] == "ISInventoryTransferAction" then ISTimedActionQueue.clear(P) end
      LocalSurvivor.Needs.update(P, false)
    `);
  }
  assert.equal(result(lua).why, 'nothing to stash');
  assert.equal(lua.run('return DUMBBELL:getModData().lsStash'), undefined, 'and it is not marked as stashed');
});

test('a walk that took her out of the base ends the job', () => {
  const lua = world('table.insert(P.__items.items, DUMBBELL)');
  order(lua, stashLine);
  lua.run(`
    ISTimedActionQueue.clear(P)
    P.sq = __makeSquare({ x = 50, y = 50 })
    LocalSurvivor.tick = LocalSurvivor.tick + 5
    LocalSurvivor.Needs.update(P, false)
  `);
  assert.equal(result(lua).why, 'not at base');
});

test('the reflex pauses it, and it picks up after', () => {
  const lua = world('table.insert(P.__items.items, DUMBBELL)');
  order(lua, stashLine);
  lua.run('__arrive(P); LocalSurvivor.tick = LocalSurvivor.tick + 5; LocalSurvivor.Needs.update(P, true)');
  assert.equal(result(lua).status, 'running');
  lua.run('LocalSurvivor.tick = LocalSurvivor.tick + 60');
  run(lua);
  assert.equal(result(lua).why, 'stashed 1');
});

// ---------- SEARCH and the stash ----------
function runSearch(lua, limit = 600) {
  for (let i = 0; i < limit; i++) {
    lua.run(`
      LocalSurvivor.tick = LocalSurvivor.tick + 1
      LocalSurvivor.Act.update(P, false)
      local q = __queueTypes(P)
      if q[1] == "ISWalkToTimedAction" then __arrive(P)
      elseif q[1] == "ISInventoryTransferAction" then __finishTransfers(P) end
    `);
    if (result(lua).status !== 'running') return;
  }
  throw new Error('the search did not end: ' + JSON.stringify(result(lua)));
}

function stashed() {
  const lua = world('table.insert(P.__items.items, HAMMER); P.weight = 10');
  order(lua, stashLine);
  run(lua);
  assert.deepEqual(names(lua, 'CRATE.items'), ['Hammer']);
  lua.run('P.weight = 1');
  return lua;
}

test('a later SEARCH of her own base leaves the stash where it is', () => {
  const lua = stashed();
  lua.run('LocalSurvivor.searched.B1 = nil');
  order(lua, '2|SEARCH|0|0||||B1');
  runSearch(lua);
  assert.deepEqual(names(lua, 'CRATE.items'), ['Hammer']);
  assert.equal(result(lua).why, 'took nothing');
});

test('SEARCH still takes what else is in a container she stashed in', () => {
  const lua = stashed();
  lua.run('table.insert(CRATE.items, BREAD); P.__items.items = {}');
  order(lua, '2|SEARCH|0|0||||B1');
  runSearch(lua);
  assert.deepEqual(names(lua, 'CRATE.items'), ['Hammer']);
  assert.equal(result(lua).why, 'took 1: Bread');
});

test('the mark is on the item, so it lasts when the item object does not', () => {
  const lua = stashed();
  assert.equal(lua.run('return HAMMER:getModData().lsStash'), 'B1');
  // A fresh copy of the item, as a chunk that unloaded and came back gives her: same mod data, new object.
  assert.equal(lua.run('local copy = __makeItem({}); copy:getModData().lsStash = "B1"; return LocalSurvivor.Act.ownStash(copy, "B1")'), true);
  assert.equal(lua.run('return LocalSurvivor.Act.ownStash(HAMMER, "B9")'), false);
  assert.equal(lua.run('return LocalSurvivor.Act.ownStash(HAMMER, "")'), false, 'and with no base known it is free to take');
});

test('with the base moved, a SEARCH back at the old one opens the stash room and takes from it', () => {
  const lua = stashed();
  lua.run('P.__items.items = {}; LocalSurvivor.searched.B1 = { ["bedroom@10,10,0"] = true }');
  order(lua, '2|SEARCH|0|0||||B9');
  assert.equal(result(lua).status, 'running', JSON.stringify(result(lua)));
  runSearch(lua);
  assert.deepEqual(names(lua, 'CRATE.items'), []);
  assert.equal(result(lua).why, 'took 1: Hammer');
});

test('at her own base the stash room stays searched', () => {
  const lua = stashed();
  lua.run('LocalSurvivor.searched.B1 = { ["bedroom@10,10,0"] = true }');
  order(lua, '2|SEARCH|0|0||||B1');
  assert.deepEqual(result(lua), { seq: 2, verb: 'SEARCH', status: 'failed', why: 'nothing left' });
});
