// The needs verbs in Needs.lua: the pure choices with plain tables, then each verb driven through
// the stub player. What the vanilla actions do once queued can only be seen in a live game.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function body(setup = '') {
  const lua = createHarness();
  lua.autoload();
  lua.run(`__players[0] = __makePlayer({ x = 10, y = 10, ${setup} })`);
  return lua;
}
const order = (lua, line) => lua.run('LocalSurvivor.Act.execIntent(__players[0], ...)', line);
// One Needs step, five ticks on, the way onTick calls it.
const step = (lua, acted = false) =>
  lua.run('LocalSurvivor.tick = LocalSurvivor.tick + 5; LocalSurvivor.Needs.update(__players[0], ...)', acted);
const queue = (lua) =>
  lua.run('local out = {} for i, a in ipairs(ISTimedActionQueue.getTimedActionQueue(__players[0]).queue) do out[i] = a.Type end return out');
// Whatever was queued ends: walks put the player on their square, then the queue empties.
const finish = (lua) => lua.run('__arrive(__players[0])');
const calls = (lua) => lua.run('local out = {} for i, c in ipairs(__menuCalls) do out[i] = c.name end return out');
// The record without res.target. Targets have their own tests.
const result = (lua) => {
  const { target, ...rest } = lua.get('LocalSurvivor.result');
  return rest;
};
const targetOf = (lua) => lua.get('LocalSurvivor.result.target');
const pure = (fn, ...args) => {
  const lua = createHarness();
  lua.requireModule('LocalSurvivor/Needs');
  return lua.callMulti(`LocalSurvivor.Needs.${fn}`, ...args);
};

// ---------- pure choices ----------

test('every needs verb is registered', () => {
  const lua = body();
  for (const verb of ['DRINK', 'FILL', 'EAT', 'SLEEP', 'BANDAGE', 'WEARBAG', 'SECURE', 'REST']) {
    assert.equal(lua.run(`return type(LocalSurvivor.verbs.${verb})`), 'function', verb);
  }
});

test('worstWound takes bleeding, then deep, bite, laceration, scratch', () => {
  const parts = [
    { part: 'Hand_L', scratch: true },
    { part: 'ForeArm_R', bite: true },
    { part: 'Torso', lac: true },
    { part: 'Head', deep: true },
    { part: 'Foot_L', bleed: true, scratch: true },
  ];
  assert.deepEqual(pure('worstWound', parts), [5]);
  assert.deepEqual(pure('worstWound', parts.slice(0, 4)), [4]);
  assert.deepEqual(pure('worstWound', parts.slice(0, 3)), [2]);
  assert.deepEqual(pure('worstWound', parts.slice(0, 1)), [1]);
});

test('worstWound skips a clean bandage but not a dirty one or glass', () => {
  assert.deepEqual(pure('worstWound', [{ part: 'Hand_L', bleed: true, bandaged: true }]), [undefined]);
  assert.deepEqual(pure('worstWound', [{ part: 'Hand_L', scratch: true, bandaged: true, dirty: true }]), [1]);
  assert.deepEqual(pure('worstWound', [{ part: 'Hand_L', lac: true, bandaged: true, glass: true }]), [1]);
  assert.deepEqual(pure('worstWound', [{ part: 'Hand_L' }]), [undefined]);
  assert.deepEqual(pure('worstWound', [{ part: 'Hand_L', bleed: true }], { Hand_L: true }), [undefined]);
});

test('treatStep: glass, then disinfect, then bandage, then rip', () => {
  assert.deepEqual(pure('treatStep', { glass: true, bleed: true }, { bandage: true }), ['glass']);
  assert.deepEqual(pure('treatStep', { bleed: true }, { bandage: true, disinfect: true }), ['disinfect']);
  assert.deepEqual(pure('treatStep', { bleed: true, alcohol: true }, { bandage: true, disinfect: true }), ['bandage']);
  assert.deepEqual(pure('treatStep', { bleed: true }, { rip: true }), ['rip']);
  assert.deepEqual(pure('treatStep', { bleed: true }, {}), ['none']);
  assert.deepEqual(pure('treatStep', { scratch: true, bandaged: true, dirty: true }, { bandage: true }), ['unwrap']);
  assert.deepEqual(pure('treatStep', { scratch: true, bandaged: true, dirty: true }, {}), ['keep']);
});

test('bestBandage takes the strongest clean one, alcohol on a tie', () => {
  assert.deepEqual(pure('bestBandage', [{ power: 0.5, dirty: true }, { power: 1.5 }, { power: 4 }]), [3]);
  assert.deepEqual(pure('bestBandage', [{ power: 4 }, { power: 4, alcohol: true }]), [2]);
  assert.deepEqual(pure('bestBandage', [{ power: 4, dirty: true }, { power: 0 }]), [undefined]);
});

test('chooseFood: soonest to rot first, packaged next, frozen last, cans only when nothing is ready', () => {
  const foods = [
    { ready: true },                                   // packaged
    { ready: true, perishable: true, left: 5 },
    { ready: true, perishable: true, left: 2 },
    { ready: true, frozen: true, perishable: true, left: 0 },
    { sealed: true, canOpen: true },
  ];
  assert.deepEqual(pure('chooseFood', foods), [3, 'ready']);
  assert.deepEqual(pure('chooseFood', [foods[0], foods[3]]), [1, 'ready']);
  assert.deepEqual(pure('chooseFood', [foods[3]]), [1, 'ready']);
  assert.deepEqual(pure('chooseFood', [{ sealed: true }, foods[4]]), [2, 'can']);
  assert.deepEqual(pure('chooseFood', [{ sealed: true }]), [undefined, 'need can opener']);
  assert.deepEqual(pure('chooseFood', [{}]), [undefined, 'no food']);
  assert.deepEqual(pure('chooseFood', []), [undefined, 'no food']);
});

test('bestBag beats the worn bag on capacity, then weight reduction', () => {
  const bags = [{ cap: 10, red: 50 }, { cap: 18, red: 60 }, { cap: 18, red: 75 }];
  assert.deepEqual(pure('bestBag', bags), [3]);
  assert.deepEqual(pure('bestBag', bags, { cap: 18, red: 75 }), [undefined]);
  assert.deepEqual(pure('bestBag', bags.slice(0, 1), { cap: 5, red: 0 }), [1]);
  assert.deepEqual(pure('bestBag', []), [undefined]);
});

test('pickTarget weighs distance against the kind', () => {
  assert.deepEqual(pure('pickTarget', [{ need: 'light', d: 1 }, { need: 'door', d: 6 }]), [2]);
  assert.deepEqual(pure('pickTarget', [{ need: 'curtain', d: 1 }, { need: 'door', d: 6 }]), [1]);
  assert.deepEqual(pure('pickTarget', []), [undefined]);
});

test('secureSummary says what was closed', () => {
  assert.deepEqual(pure('secureSummary', { door: 2, window: 1, lock: 1, light: 1 }, 0),
    ['closed 2 doors, 1 window; locked 1 door; 1 light off']);
  assert.deepEqual(pure('secureSummary', {}, 2), ['nothing open; 2 out of reach']);
});

test('drinkPercent rounds vanilla thirst x 2 up to a quarter, half or all', () => {
  assert.deepEqual(pure('drinkPercent', 0.5, 1), [1]);
  assert.deepEqual(pure('drinkPercent', 0.2, 1), [0.5]);
  assert.deepEqual(pure('drinkPercent', 0.05, 1), [0.25]);
  assert.deepEqual(pure('drinkPercent', 0.5, 0), [1]);
});

test('restCheck', () => {
  assert.deepEqual(pure('restCheck', 0.3, true, false), ['fail', 'zombie']);
  assert.deepEqual(pure('restCheck', 0.3, true, true), ['done', 'zombie']);
  assert.deepEqual(pure('restCheck', 0.9, false, false), ['fail', 'not tired']);
  assert.deepEqual(pure('restCheck', 0.9, false, true), ['done', 'rested']);
  assert.deepEqual(pure('restCheck', 0.3, false, true), ['sit', '']);
});

// ---------- verbs ----------

test('DRINK from a bottle, then done when the queue is empty', () => {
  const lua = body('items = { __makeItem({ type = "Base.WaterBottle", name = "Water Bottle", fluid = { water = 1 } }) }');
  order(lua, '1|DRINK|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'DRINK', status: 'running', why: '' });
  assert.deepEqual(queue(lua), ['ISDrinkFluidAction']);
  step(lua);
  assert.equal(result(lua).status, 'running');
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DRINK', status: 'done', why: 'drank from Water Bottle' });
});

test('DRINK with nothing fails with "no water"', () => {
  const lua = body();
  order(lua, '1|DRINK|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'DRINK', status: 'failed', why: 'no water' });
  assert.equal(lua.get('LocalSurvivor.lastError'), 'no water');
});

function sinkHouse(lua, tainted) {
  lua.run(`
    local b = __makeBuilding({ id = "b1", x = 0, y = 0, x2 = 20, y2 = 20 })
    local sink = __makeObject({ water = 10, tainted = ${tainted} })
    __makeSquare({ x = 12, y = 10, building = b, objects = { sink } })
    local floor = __makeSquare({ x = 10, y = 10, building = b })
    __players[0] = __makePlayer({ x = 10, y = 10, square = floor })
    local _, m = LocalSurvivor.Sense.currentBuilding(__players[0])
    m.waterObjs = { sink }
    __sink = sink
  `);
}

test('DRINK walks to a clean tap in the building when there is no bottle', () => {
  const lua = createHarness();
  lua.autoload();
  sinkHouse(lua, false);
  order(lua, '1|DRINK|0|0|||');
  assert.deepEqual(calls(lua), ['onDrink']);
  assert.equal(lua.run('return __menuCalls[1].args[1] == __sink'), true);
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DRINK', status: 'done', why: 'drank from the tap' });
});

test('DRINK never uses tainted water', () => {
  const lua = createHarness();
  lua.autoload();
  sinkHouse(lua, true);
  order(lua, '1|DRINK|0|0|||');
  assert.deepEqual(calls(lua), []);
  assert.equal(result(lua).why, 'no water');
});

test('FILL fills empty bottles at the tap', () => {
  const lua = createHarness();
  lua.autoload();
  sinkHouse(lua, false);
  lua.run('__players[0].__items = __javaList({ __makeItem({ type = "Base.WaterBottle", fluid = { water = 0 } }) })');
  order(lua, '1|FILL|0|0|||');
  assert.deepEqual(calls(lua), ['onTakeWater']);
  // The stub does not pour, so the bottle is still empty. A real tap that ran dry reads the same.
  lua.run('__sink.square.objects[1] = __makeObject({ water = 0 }); LocalSurvivor.bldgMemo["b1"].waterObjs = {}');
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'FILL', status: 'done', why: 'filled 1, source dry' });
});

test('FILL with no bottle fails', () => {
  const lua = body();
  order(lua, '1|FILL|0|0|||');
  assert.equal(result(lua).why, 'no empty bottle');
});

test('EAT with nothing fails with "no food"', () => {
  const lua = body();
  order(lua, '1|EAT|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'EAT', status: 'failed', why: 'no food' });
});

test('EAT takes the food that rots first through vanilla eatItem', () => {
  const lua = body(`items = {
    __makeItem({ type = "Base.Crisps", name = "Chips", food = true, hung = -0.1 }),
    __makeItem({ type = "Base.Bread", name = "Bread", food = true, hung = -0.2, offMax = 6, age = 1 }),
  }`);
  order(lua, '1|EAT|0|0|||');
  assert.deepEqual(calls(lua), ['eatItem']);
  assert.equal(lua.run('return __menuCalls[1].args[1]:getDisplayName()'), 'Bread');
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'EAT', status: 'done', why: 'ate Bread' });
});

test('EAT opens a can with the opening recipe when the game allows it', () => {
  const lua = body('items = { __makeItem({ type = "Base.TinnedBeans", name = "Beans", food = true, hung = -0.3, cantEat = true, opening = "OpenCannedFood" }) }');
  lua.run('__recipes.OpenCannedFood = { name = "OpenCannedFood" }');
  order(lua, '1|EAT|0|0|||');
  assert.equal(result(lua).why, 'need can opener');
  lua.run('__canCraft.OpenCannedFood = true');
  order(lua, '2|EAT|0|0|||');
  assert.deepEqual(calls(lua), ['eatItem']);
  assert.equal(lua.run('return __menuCalls[1].args[3].name'), 'OpenCannedFood');
  assert.equal(lua.run('return __menuCalls[1].args[4]'), 100);
});

test('a job pauses while the reflex acts, keeps its queue, and redoes what was cut off', () => {
  const lua = body('items = { __makeItem({ type = "Base.WaterBottle", fluid = { water = 1 } }) }');
  order(lua, '1|DRINK|0|0|||');
  finish(lua);
  lua.run('ISTimedActionQueue.add(ISWalkToTimedAction:new(__players[0]))'); // the reflex's flee
  step(lua, true);
  assert.deepEqual(queue(lua), ['ISWalkToTimedAction']);
  assert.equal(result(lua).status, 'running');
  finish(lua);
  step(lua);            // too soon after the reflex
  assert.deepEqual(queue(lua), []);
  for (let i = 0; i < 6; i++) step(lua);
  // The drink was cut off, so it is not "drank". It is queued again.
  assert.equal(result(lua).status, 'running');
  assert.deepEqual(queue(lua), ['ISDrinkFluidAction']);
  finish(lua);
  step(lua);
  assert.equal(result(lua).status, 'done');
});

test('an action the reflex left queued still counts after the pause', () => {
  const lua = body('items = { __makeItem({ type = "Base.WaterBottle", name = "Water Bottle", fluid = { water = 1 } }) }');
  order(lua, '1|DRINK|0|0|||');
  step(lua, true);
  for (let i = 0; i < 7; i++) step(lua);
  assert.deepEqual(queue(lua), ['ISDrinkFluidAction']);
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DRINK', status: 'done', why: 'drank from Water Bottle' });
});

test('a job paused too long fails with "zombie"', () => {
  const lua = body('items = { __makeItem({ type = "Base.WaterBottle", fluid = { water = 1 } }) }');
  order(lua, '1|DRINK|0|0|||');
  for (let i = 0; i < 245; i++) step(lua, true);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'DRINK', status: 'failed', why: 'zombie' });
});

test('a new order drops the job, and the same verb again keeps it', () => {
  const lua = body('items = { __makeItem({ type = "Base.WaterBottle", fluid = { water = 1 } }) }');
  order(lua, '1|DRINK|0|0|||');
  order(lua, '2|DRINK|0|0|||');
  assert.equal(lua.get('LocalSurvivor.needsJob.seq'), 2);
  assert.deepEqual(queue(lua), ['ISDrinkFluidAction']);
  order(lua, '3|WAIT|0|0|||');
  step(lua);
  assert.equal(lua.get('LocalSurvivor.needsJob'), false);
  assert.equal(result(lua).verb, 'WAIT');
});

test('the unstick helper leaves a drink alone however long it takes', () => {
  const lua = body('items = { __makeItem({ type = "Base.WaterBottle", fluid = { water = 1 } }) }');
  order(lua, '1|DRINK|0|0|||');
  for (let i = 0; i < 300; i++) lua.run('LocalSurvivor.tick = LocalSurvivor.tick + 1; LocalSurvivor.Reflex.releaseDoor(__players[0])');
  assert.deepEqual(queue(lua), ['ISDrinkFluidAction']);
});

test('BANDAGE disinfects first, then bandages the bleeding part', () => {
  const lua = body(`
    parts = { __makeBodyPart({ type = "Hand_L", scratched = true }), __makeBodyPart({ type = "Foot_R", bleeding = true }) },
    items = {
      __makeItem({ type = "Base.Bandage", name = "Bandage", bandage = true, power = 4 }),
      __makeItem({ type = "Base.AlcoholWipes", drainable = true, alcoholPower = 4 }),
    }`);
  order(lua, '1|BANDAGE|0|0|||');
  assert.deepEqual(queue(lua), ['ISDisinfect']);
  assert.equal(lua.run('return ISTimedActionQueue.getTimedActionQueue(__players[0]).queue[1].args[4]:getType()'), 'Foot_R');
  // The stub part cannot change, so mark it disinfected by hand.
  lua.run(`
    local part = __makeBodyPart({ type = "Foot_R", bleeding = true, alcohol = 1 })
    __players[0].getBodyDamage = function() return { getBodyParts = function() return __javaList({ part }) end } end
  `);
  finish(lua);
  step(lua);
  assert.deepEqual(queue(lua), ['ISApplyBandage']);
  lua.run(`
    local part = __makeBodyPart({ type = "Foot_R", bleeding = true, bandaged = true })
    __players[0].getBodyDamage = function() return { getBodyParts = function() return __javaList({ part }) end } end
  `);
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'BANDAGE', status: 'done', why: 'treated 1' });
});

test('BANDAGE with no bandage and nothing to rip fails with "no bandage"', () => {
  const lua = body('parts = { __makeBodyPart({ type = "Hand_L", cut = true }) }');
  order(lua, '1|BANDAGE|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'BANDAGE', status: 'failed', why: 'no bandage' });
});

test('BANDAGE rips a shirt when the recipe allows it', () => {
  const lua = body(`
    parts = { __makeBodyPart({ type = "Hand_L", cut = true }) },
    items = { __makeItem({ type = "Base.Tshirt", tags = { RIP_CLOTHING_COTTON = true } }) }`);
  lua.run('__recipes.RipClothing = { name = "RipClothing" }; __canCraft.RipClothing = true');
  order(lua, '1|BANDAGE|0|0|||');
  assert.deepEqual(calls(lua), ['OnNewCraft']);
  assert.equal(result(lua).status, 'running');
});

test('BANDAGE takes glass out by hand when there are no tweezers', () => {
  const lua = body('parts = { __makeBodyPart({ type = "Hand_L", cut = true, glass = true }) }');
  order(lua, '1|BANDAGE|0|0|||');
  assert.deepEqual(queue(lua), ['ISRemoveGlass']);
  assert.equal(lua.run('return ISTimedActionQueue.getTimedActionQueue(__players[0]).queue[1].args[4]'), true);
});

test('BANDAGE with no wounds is done', () => {
  const lua = body();
  order(lua, '1|BANDAGE|0|0|||');
  assert.deepEqual(result(lua), { seq: 1, verb: 'BANDAGE', status: 'done', why: 'no wounds' });
});

test('WEARBAG wears the biggest bag and is done once it is on the back', () => {
  const lua = body(`items = {
    __makeItem({ type = "Base.Bag_Schoolbag", name = "School Bag", id = 1, back = true, cap = 10, red = 50, items = {} }),
    __makeItem({ type = "Base.Bag_HikingBag", name = "Hiking Bag", id = 2, back = true, cap = 18, red = 70, items = {} }),
  }`);
  order(lua, '1|WEARBAG|0|0|||');
  assert.deepEqual(calls(lua), ['wearItem']);
  assert.equal(lua.run('return __menuCalls[1].args[1]:getDisplayName()'), 'Hiking Bag');
  lua.run('local bag = __menuCalls[1].args[1]; __players[0].getClothingItem_Back = function() return bag end');
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'WEARBAG', status: 'done', why: 'wearing Hiking Bag' });
});

test('WEARBAG with no bag fails', () => {
  const lua = body();
  order(lua, '1|WEARBAG|0|0|||');
  assert.equal(result(lua).why, 'no bag');
});

function openHouse(lua) {
  lua.run(`
    __door = { __class = "IsoDoor", open = true, lockedKey = false }
    function __door:IsOpen() return self.open end
    function __door:HasCurtains() return nil end
    function __door:isExterior() return true end
    function __door:isLocked() return false end
    function __door:isLockedByKey() return self.lockedKey end
    function __door:getModData() return {} end
    function __door:checkKeyId() return 1 end
    function __door:getSquare() return self.square end
    function __door:getNorth() return true end
    __curtain = { __class = "IsoCurtain", open = true }
    function __curtain:IsOpen() return self.open end
    function __curtain:getSquare() return self.square end
    function __curtain:getNorth() return true end
    __lamp = { __class = "IsoLightSwitch", on = true }
    function __lamp:isActivated() return self.on end
    function __lamp:canSwitchLight() return true end
    function __lamp:getSquare() return self.square end
    local a = __makeSquare({ x = 10, y = 10, objects = { __lamp } })
    local b = __makeSquare({ x = 11, y = 10, objects = { __curtain } })
    local c = __makeSquare({ x = 12, y = 10, objects = { __door } })
    local room = __makeRoom({ name = "bedroom", squares = { a, b } })
    local house = __makeBuilding({ id = "h1", x = 10, y = 10, x2 = 11, y2 = 10, rooms = { room } })
    for _, sq in ipairs({ a, b, c }) do sq.opts.room = room; sq.opts.building = house end
    __players[0] = __makePlayer({ x = 10, y = 10, square = a, stats = { FATIGUE = 0.9 } })
  `);
}

test('SECURE leaves exterior doors unlocked by default', () => {
  const lua = createHarness();
  lua.autoload();
  openHouse(lua);
  order(lua, '1|SECURE|0|0|||');
  for (let i = 0; i < 12 && result(lua).status === 'running'; i++) {
    finish(lua);
    step(lua);
  }
  assert.deepEqual(calls(lua), ['onOpenCloseDoor', 'onOpenCloseCurtain', 'onToggleLight']);
  assert.equal(result(lua).why, 'closed 1 door, 1 curtain; 1 light off');
});

test('SECURE closes, locks and switches off when locking is on', () => {
  const lua = createHarness();
  lua.autoload();
  openHouse(lua);
  lua.run('LocalSurvivor.needsOpts.lock = true');
  order(lua, '1|SECURE|0|0|||');
  for (let i = 0; i < 12 && result(lua).status === 'running'; i++) {
    finish(lua);
    step(lua);
  }
  assert.deepEqual(calls(lua), ['onOpenCloseDoor', 'onLockDoor', 'onOpenCloseCurtain', 'onToggleLight']);
  assert.deepEqual(result(lua), {
    seq: 1, verb: 'SECURE', status: 'done', why: 'closed 1 door, 1 curtain; locked 1 door; 1 light off',
  });
});

// A kitchen and a hall in one house. The player stands in the hall. The kitchen has one open
// object on its outer wall. On a south or east wall it sits on an outside square, as the game
// stores it. kind: door | window | lamp. wall: south, east, or north (on the inside square).
function wallHouse(lua, { kind = 'door', wall = 'south' } = {}) {
  lua.run(`
    local kind, wall = "${kind}", "${wall}"
    local obj
    if kind == "door" then
      obj = { __class = "IsoDoor", open = true }
      function obj:IsOpen() return self.open end
      function obj:HasCurtains() return nil end
      function obj:isExterior() return true end
      function obj:isLocked() return false end
      function obj:isLockedByKey() return false end
      function obj:getModData() return {} end
      function obj:checkKeyId() return 1 end
    elseif kind == "window" then
      obj = { __class = "IsoWindow", open = true }
      function obj:IsOpen() return self.open end
      function obj:HasCurtains() return nil end
      function obj:isSmashed() return false end
      function obj:isDestroyed() return false end
      function obj:isBarricaded() return false end
    else
      obj = { __class = "IsoLightSwitch", on = true }
      function obj:isActivated() return self.on end
      function obj:canSwitchLight() return true end
    end
    function obj:getSquare() return self.square end
    function obj:getNorth() return wall ~= "east" end

    -- The inside square is (10,10). Its south and east neighbours are outside.
    local inside = __makeSquare({ x = 10, y = 10 })
    local hallSq = __makeSquare({ x = 8, y = 10 })
    local objSq
    if wall == "south" then
      objSq = __makeSquare({ x = 10, y = 11, objects = { obj }, around = { N = inside } })
    elseif wall == "east" then
      objSq = __makeSquare({ x = 11, y = 10, objects = { obj }, around = { W = inside } })
    else
      objSq = inside
      inside.objects = { obj }
      obj.square = inside
    end
    local kitchen = __makeRoom({ name = "kitchen", squares = { inside } })
    local hall = __makeRoom({ name = "hall", squares = { hallSq } })
    local house = __makeBuilding({ id = "h2", x = 8, y = 10, x2 = 10, y2 = 10, rooms = { kitchen, hall } })
    inside.opts.room, inside.opts.building = kitchen, house
    hallSq.opts.room, hallSq.opts.building = hall, house
    __players[0] = __makePlayer({ x = 8.5, y = 10.5, square = hallSq, stats = { FATIGUE = 0.9 } })
    __outside, __inside, __hall, __obj = objSq, inside, hallSq, obj
  `);
}
const onOutside = (lua) => lua.run('return __players[0].sq == __outside and __outside ~= __inside');
// Runs SECURE to the end and says whether he ever stood on the outside square.
function sweep(lua) {
  order(lua, '1|SECURE|0|0|||');
  let outside = false;
  for (let i = 0; i < 20 && result(lua).status === 'running'; i++) {
    finish(lua);
    outside = outside || onOutside(lua);
    step(lua);
  }
  return outside;
}

for (const wall of ['south', 'east']) {
  test(`SECURE works a ${wall}-wall door from the inside square, never from outside`, () => {
    const lua = createHarness();
    lua.autoload();
    wallHouse(lua, { kind: 'door', wall });
    assert.equal(sweep(lua), false, 'stepped outside');
    assert.deepEqual(calls(lua), ['onOpenCloseDoor']);
    assert.equal(lua.run('return __menuCalls[1].args[1] == __obj'), true);
    assert.deepEqual(result(lua), { seq: 1, verb: 'SECURE', status: 'done', why: 'closed 1 door' });
    assert.equal(lua.run('return __players[0].sq == __inside'), true, 'worked it from the inside square');
  });
}

test('SECURE does not walk for a door on the square he already stands on', () => {
  const lua = createHarness();
  lua.autoload();
  wallHouse(lua, { kind: 'door', wall: 'north' });
  lua.run('__players[0].sq = __inside; __players[0].x = 10.5; __players[0].y = 10.5');
  order(lua, '1|SECURE|0|0|||');
  for (let i = 0; i < 6 && result(lua).status === 'running'; i++) {
    assert.equal(queue(lua).includes('ISWalkToTimedAction'), false);
    finish(lua);
    step(lua);
  }
  assert.equal(result(lua).why, 'closed 1 door');
});

test('SECURE counts a window only reachable from outside as out of reach, and does not walk', () => {
  const lua = createHarness();
  lua.autoload();
  wallHouse(lua, { kind: 'window', wall: 'south' });
  // The inside square is blocked (a counter, say), so only the outside is left.
  lua.run('__inside.opts.blocked = true');
  assert.equal(sweep(lua), false);
  assert.deepEqual(calls(lua), []);
  assert.deepEqual(result(lua), { seq: 1, verb: 'SECURE', status: 'done', why: 'nothing open; 1 out of reach' });
});

test('SECURE leaves a porch light on an outside square alone', () => {
  const lua = createHarness();
  lua.autoload();
  wallHouse(lua, { kind: 'lamp', wall: 'south' });
  assert.equal(sweep(lua), false);
  assert.deepEqual(calls(lua), []);
  assert.equal(result(lua).why, 'nothing open; 1 out of reach');
});

test('SECURE fails "not inside" when he ends up outside the building', () => {
  const lua = createHarness();
  lua.autoload();
  wallHouse(lua, { kind: 'door', wall: 'south' });
  order(lua, '1|SECURE|0|0|||');
  lua.run('__players[0].sq = __outside');
  finish(lua);
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'SECURE', status: 'failed', why: 'not inside' });
});

test('SECURE names the building as its target, and done keeps it', () => {
  const lua = createHarness();
  lua.autoload();
  wallHouse(lua, { kind: 'door', wall: 'north' });
  order(lua, '1|SECURE|0|0|||');
  assert.equal(targetOf(lua), 'h2');
  for (let i = 0; i < 8 && result(lua).status === 'running'; i++) {
    finish(lua);
    step(lua);
  }
  assert.equal(result(lua).status, 'done');
  assert.equal(targetOf(lua), 'h2');
  order(lua, '2|REST|0|0|||');
  assert.equal(targetOf(lua), undefined, 'a new order clears it');
});

test('needs jobs name the item or fixture they work on', () => {
  const bottle = body('items = { __makeItem({ name = "Water Bottle", fluid = { water = 1 } }) }');
  order(bottle, '1|DRINK|0|0|||');
  assert.equal(targetOf(bottle), 'Water Bottle');

  const apple = body('items = { __makeItem({ name = "Apple", food = true, hung = -0.1 }) }');
  order(apple, '1|EAT|0|0|||');
  assert.equal(targetOf(apple), 'Apple');

  const wound = body(`parts = { __makeBodyPart({ type = "Hand_L", bleeding = true }) },
    items = { __makeItem({ name = "Bandage", bandage = true, power = 5 }) }`);
  order(wound, '1|BANDAGE|0|0|||');
  assert.equal(targetOf(wound), 'Hand_L');

  const bag = body('items = { __makeItem({ type = "Base.Bag_Schoolbag", name = "School Bag", id = 1, back = true, cap = 10, items = {} }) }');
  order(bag, '1|WEARBAG|0|0|||');
  assert.equal(targetOf(bag), 'School Bag');
});

test('the same verb again puts the job target back under the new seq', () => {
  const lua = body('items = { __makeItem({ name = "Apple", food = true, hung = -0.1 }) }');
  order(lua, '1|EAT|0|0|||');
  order(lua, '2|EAT|0|0|||');
  assert.equal(result(lua).seq, 2);
  assert.equal(targetOf(lua), 'Apple');
});

test('SECURE outside fails', () => {
  const lua = body();
  order(lua, '1|SECURE|0|0|||');
  assert.equal(result(lua).why, 'not inside');
});

test('SLEEP shuts the room, then sleeps on the floor when there is no bed', () => {
  const lua = createHarness();
  lua.autoload();
  openHouse(lua);
  lua.run('__sleepAllowed = true');
  order(lua, '1|SLEEP|0|0|||');
  for (let i = 0; i < 12 && result(lua).status === 'running'; i++) {
    finish(lua);
    step(lua);
  }
  assert.equal(calls(lua).at(-1), 'onSleepWalkToComplete');
  assert.ok(calls(lua).includes('onOpenCloseDoor'));
  assert.deepEqual(result(lua), { seq: 1, verb: 'SLEEP', status: 'done', why: 'asleep on the floor' });
});

test('SLEEP uses the nearest bed the place scan found', () => {
  const lua = createHarness();
  lua.autoload();
  openHouse(lua);
  lua.run(`
    __sleepAllowed = true
    __bed = __makeObject({ bed = true })
    __makeSquare({ x = 11, y = 11, objects = { __bed } })
    local _, m = LocalSurvivor.Sense.currentBuilding(__players[0])
    m.beds = { { x = 11, y = 11, z = 0 } }
  `);
  order(lua, '1|SLEEP|0|0|||');
  for (let i = 0; i < 12 && result(lua).status === 'running'; i++) {
    finish(lua);
    step(lua);
  }
  assert.equal(lua.run('return __menuCalls[#__menuCalls].args[1] == __bed'), true);
  assert.deepEqual(result(lua), { seq: 1, verb: 'SLEEP', status: 'done', why: 'asleep in bed' });
});

test('SLEEP fails "unsafe" when the game would not let him sleep', () => {
  const lua = createHarness();
  lua.autoload();
  openHouse(lua);
  lua.run('__players[0] = __makePlayer({ x = 10, y = 10, square = __squares["10,10,0"], stats = { FATIGUE = 0.9 }, visible = 1 })');
  order(lua, '1|SLEEP|0|0|||');
  for (let i = 0; i < 12 && result(lua).status === 'running'; i++) {
    finish(lua);
    step(lua);
  }
  assert.deepEqual(result(lua), { seq: 1, verb: 'SLEEP', status: 'failed', why: 'unsafe: zombies' });
});

test('SLEEP when not tired fails', () => {
  const lua = body('stats = { FATIGUE = 0.1 }');
  order(lua, '1|SLEEP|0|0|||');
  assert.equal(result(lua).why, 'not tired');
});

test('REST sits down and is done once endurance is back', () => {
  const lua = body('stats = { ENDURANCE = 0.3 }');
  order(lua, '1|REST|0|0|||');
  assert.deepEqual(queue(lua), ['ISSitOnGround']);
  lua.run('__players[0].sitting = true');
  finish(lua);
  step(lua);
  assert.equal(result(lua).status, 'running');
  lua.run('__players[0].getStats = function() return { get = function() return 0.9 end, getNumChasingZombies = function() return 0 end } end');
  step(lua);
  assert.deepEqual(result(lua), { seq: 1, verb: 'REST', status: 'done', why: 'rested' });
});

test('REST with a zombie chasing fails', () => {
  const lua = body('stats = { ENDURANCE = 0.3 }, chasing = 1');
  order(lua, '1|REST|0|0|||');
  assert.equal(result(lua).why, 'zombie');
});
