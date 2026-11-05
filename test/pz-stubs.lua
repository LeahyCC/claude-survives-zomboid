-- Stand-ins for the Project Zomboid globals the mod touches, for the fengari harness.
-- They only exist to let the mod load and to let tests call pure Lua. They are not the game.
-- Extend them as a card needs more. A missing method fails loudly here, so a test can tell
-- "the stub lacks it" from "the mod is wrong".

__printed = {}
function print(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
  table.insert(__printed, table.concat(parts, "\t"))
end

-- Kahlua is Lua 5.1 and fengari is 5.3. Smooth over the differences the mod can hit.
unpack = unpack or table.unpack
loadstring = loadstring or load
local rawtostring = tostring
function tostring(v)
  -- 5.1 prints a whole-number float as "3", 5.3 prints "3.0".
  if math.type(v) == "float" and v == math.floor(v) and v > -1e15 and v < 1e15 then
    return string.format("%d", v)
  end
  return rawtostring(v)
end

-- Java-style list: size() and a 0-based get(i), called with a colon.
function __javaList(items)
  local list = { items = items or {} }
  function list:size() return #self.items end
  function list:get(i) return self.items[i + 1] end
  function list:add(v) table.insert(self.items, v) end
  return list
end

-- ---------- events ----------
-- Events.OnTick.Add(fn) records fn. The harness fires them with fireEvent.
__events = {}
Events = setmetatable({}, {
  __index = function(t, name)
    __events[name] = __events[name] or {}
    local ev = {
      Add = function(fn) table.insert(__events[name], fn) end,
      Remove = function(fn)
        for i, f in ipairs(__events[name]) do
          if f == fn then table.remove(__events[name], i); return end
        end
      end,
    }
    rawset(t, name, ev)
    return ev
  end,
})

-- ---------- keyboard and fonts ----------
local keyCode = 0
Keyboard = setmetatable({}, {
  __index = function(t, name)
    if type(name) == "string" and name:sub(1, 4) == "KEY_" then
      keyCode = keyCode + 1
      rawset(t, name, keyCode)
      return keyCode
    end
    return nil
  end,
})
local function nameTable()
  return setmetatable({}, { __index = function(t, name) rawset(t, name, name); return name end })
end
UIFont = nameTable()
CharacterStat = nameTable()
Fluid = nameTable()
IsoFlagType = nameTable()
IsoDirections = nameTable()
MoodleType = nameTable()
ItemBodyLocation = nameTable()
ItemTag = nameTable()
WeaponCategory = nameTable()
FluidCategory = nameTable()
BodyPartType = { ToString = function(t) return tostring(t) end }

-- ---------- UI classes ----------
ISUIElement = {}
ISUIElement.__index = ISUIElement
function ISUIElement:derive(name)
  local class = { Type = name }
  class.__index = class
  setmetatable(class, self)
  return class
end
function ISUIElement:new(x, y, w, h)
  local o = { x = x, y = y, width = w, height = h }
  setmetatable(o, self)
  self.__index = self
  return o
end
function ISUIElement:initialise() end
function ISUIElement:addToUIManager() self.added = true end
function ISUIElement:setX(v) self.x = v end
function ISUIElement:setWidth(v) self.width = v end
function ISUIElement:setHeight(v) self.height = v end
for _, name in ipairs({ "drawText", "drawTextRight", "drawRect", "drawRectBorder" }) do
  ISUIElement[name] = function() end
end

-- Text is 9 pixels a character at any size, so a test can predict where a line wraps.
function getTextManager()
  return { MeasureStringX = function(_, _, s) return #s * 9 end, getFontHeight = function() return 20 end }
end

function getCore()
  return { getScreenHeight = function() return 1080 end, getScreenWidth = function() return 1920 end }
end

-- ---------- timed actions ----------
local function actionClass(name)
  local class = { Type = name }
  class.__index = class
  function class:new(...)
    local o = { Type = name, args = { ... } }
    return setmetatable(o, class)
  end
  _G[name] = class
end
for _, name in ipairs({
  "ISWalkToTimedAction", "ISEatFoodAction", "ISDrinkFluidAction", "ISEquipWeaponAction",
  "ISInventoryTransferAction", "ISOpenCloseDoor", "ISSmashWindow", "ISClimbThroughWindow",
  "ISOpenCloseCurtain", "ISRemoveBrokenGlass", "ISOpenCloseWindow", "ISWearClothing",
  "ISTakeWaterAction", "ISApplyBandage", "ISDisinfect", "ISUnequipAction", "ISRemoveGlass", "ISSitOnGround",
  "ISLockDoor", "ISToggleLightAction", "ISClimbOverFence",
}) do actionClass(name) end
-- The vanilla pathfind action is built by named constructors, not new().
ISPathFindAction = { Type = "ISPathFindAction" }
function ISPathFindAction:pathToNearest(character, locations)
  return { Type = "ISPathFindAction", args = { character, locations } }
end

ISTimedActionQueue = {}
function ISTimedActionQueue.getTimedActionQueue(p)
  p.__queue = p.__queue or { queue = {} }
  return p.__queue
end
function ISTimedActionQueue.add(action)
  -- The mod always adds for the one player; tests read the queue back from that player.
  local p = action.args and action.args[1]
  if type(p) == "table" then table.insert(ISTimedActionQueue.getTimedActionQueue(p).queue, action) end
  return action
end
function ISTimedActionQueue.clear(p)
  ISTimedActionQueue.getTimedActionQueue(p).queue = {}
end

luautils = { walkAdj = function() return true end }
-- A stub object says what it is with __class. Anything else is no Java class.
function instanceof(o, name) return type(o) == "table" and o.__class == name end

-- Free square next to one. A test sets __adjacent(sq, p) to pick; by default the first loaded
-- neighbour west, east, north, south that is free.
__adjacent = nil
local function firstFreeNeighbour(sq)
  for _, d in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do
    local n = __squares[(sq:getX() + d[1]) .. "," .. (sq:getY() + d[2]) .. "," .. sq:getZ()]
    if n and n:isFree(true) then return n end
  end
  return nil
end
AdjacentFreeTileFinder = {
  Find = function(sq, p) if __adjacent then return __adjacent(sq, p) end return firstFreeNeighbour(sq) end,
  FindWindowOrDoor = function(sq, obj, p) if __adjacent then return __adjacent(sq, p) end return firstFreeNeighbour(sq) end,
  isTileOrAdjacent = function(a, b)
    if not a or not b then return false end
    return math.abs(a:getX() - b:getX()) <= 1 and math.abs(a:getY() - b:getY()) <= 1 and a:getZ() == b:getZ()
  end,
}

-- Vanilla menu handlers. Each records the call in __menuCalls and queues a stand-in action, the
-- way the real ones walk there and queue the action. A test object with a field the handler
-- changes (open, curtainOpen, on, lockedKey) is changed at once, as if the action had run.
__menuCalls = {}
local function menuCall(name, pn, ...)
  table.insert(__menuCalls, { name = name, args = { ... } })
  local p = getSpecificPlayer(pn)
  if p then ISTimedActionQueue.add({ Type = "Menu:" .. name, args = { p } }) end
end
ISWorldObjectContextMenu = {
  onDrink = function(_, obj, pn) menuCall("onDrink", pn, obj) end,
  onTakeWater = function(_, obj, list, _, pn) menuCall("onTakeWater", pn, obj, list) end,
  onOpenCloseDoor = function(_, door, pn) door.open = false; menuCall("onOpenCloseDoor", pn, door) end,
  onOpenCloseCurtain = function(_, c, pn) c.open = false; c.curtainOpen = false; menuCall("onOpenCloseCurtain", pn, c) end,
  onOpenCloseWindow = function(_, w, pn) w.open = false; menuCall("onOpenCloseWindow", pn, w) end,
  onLockDoor = function(_, pn, door) door.lockedKey = true; menuCall("onLockDoor", pn, door) end,
  onToggleLight = function(_, l, pn) l.on = false; menuCall("onToggleLight", pn, l) end,
  onSleepWalkToComplete = function(pn, bed)
    table.insert(__menuCalls, { name = "onSleepWalkToComplete", args = { bed } })
    local p = getSpecificPlayer(pn)
    if p and __sleepAllowed then p.asleep = true end
  end,
}
ISInventoryPaneContextMenu = {
  eatItem = function(item, pct, pn, recipe, eatPct) menuCall("eatItem", pn, item, pct, recipe, eatPct) end,
  wearItem = function(item, pn) menuCall("wearItem", pn, item) end,
  OnNewCraft = function(item, recipe, pn, all) menuCall("OnNewCraft", pn, item, recipe) end,
  getEatingMask = function() return false end,
  transferIfNeeded = function() end,
  getContainers = function() return {} end,
  dropItem = function(item, pn) menuCall("dropItem", pn, item) end,
}

-- Craft recipes by name, and which ones the game would let him do now.
__recipes = {}
__canCraft = {}
function getScriptManager()
  return { getCraftRecipe = function(_, name) return __recipes[name] end }
end
HandcraftLogic = {
  new = function()
    local logic = {}
    function logic:setContainers() return true end
    function logic:setRecipeFromContextClick(r) self.recipe = r end
    function logic:canPerformCurrentRecipe() return self.recipe ~= nil and __canCraft[self.recipe.name] == true end
    return logic
  end,
}

-- ---------- world ----------
__zombies = {}
__squares = {}
__buildings = {}
__players = {}
__files = {}
__speed = 1
__time = { hour = 12, nights = 0 }

function getCell()
  return {
    getZombieList = function() return __javaList(__zombies) end,
    getGridSquare = function(self, x, y, z) return __squares[x .. "," .. y .. "," .. z] end,
    getBuildingList = function() return __javaList(__buildings) end,
  }
end
function getSpecificPlayer(i) return __players[i] end
function getGameTime()
  return {
    getHour = function() return __time.hour end,
    getNightsSurvived = function() return __time.nights end,
    isNight = function() return __time.night or false end,
    getDeathString = function() return "You died: stub" end,
    setMultiplier = function(_, m) __time.mult = m end,
  }
end
function getGameSpeed() return __speed end
function setGameSpeed(v) __speed = v end

-- append: the game's third argument. True keeps what the file held.
function getFileWriter(name, create, append)
  local w = { buf = append and (__files[name] or "") or "" }
  function w:write(s) self.buf = self.buf .. s end
  function w:close() __files[name] = self.buf end
  return w
end
function getFileReader(name)
  local text = __files[name]
  if text == nil then return nil end
  local r = { lines = {} }
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do table.insert(r.lines, line) end
  function r:readLine() return table.remove(self.lines, 1) end
  function r:close() end
  return r
end

-- A bare player. opts: x, y, z, dead, items (list of item stubs), stats, hp, square, parts (body
-- part stubs), moodles (MoodleType name -> level), visible, kills, hours, weight, maxWeight, back.
function __makePlayer(opts)
  opts = opts or {}
  local p = { x = opts.x or 0, y = opts.y or 0, z = opts.z or 0, said = {}, dead = opts.dead or false }
  p.__items = __javaList(opts.items or {})
  function p:getX() return self.x end
  function p:getY() return self.y end
  function p:getZ() return self.z end
  function p:isDead() return self.dead end
  function p:Say(text) table.insert(self.said, text) end
  function p:getInventory()
    -- self.keys: key ids he carries (a loose key or one on a ring), id -> true.
    return {
      getItems = function() return self.__items end,
      haveThisKeyId = function(_, id) return (self.keys or {})[id] and {} or nil end,
    }
  end
  function p:setSneaking(v) self.sneaking = v end
  function p:isOutside() return true end
  -- opts.live: the square under the player follows x, y, z through __squares.
  function p:getSquare()
    if self.sq then return self.sq end
    if opts.square then return opts.square end
    if opts.live then return __squares[math.floor(self.x) .. "," .. math.floor(self.y) .. "," .. math.floor(self.z)] end
    return nil
  end
  function p:getCurrentSquare() return self:getSquare() end
  function p:getStats()
    return {
      get = function(_, stat) return (opts.stats or {})[stat] or 0 end,
      getNumVisibleZombies = function() return opts.visible or 0 end,
      getNumChasingZombies = function() return opts.chasing or 0 end,
      getNumVeryCloseZombies = function() return 0 end,
    }
  end
  function p:getBodyDamage()
    return {
      -- A test sets p.hp to take damage, and p.bleeding to open a wound.
      getOverallBodyHealth = function() return self.hp or opts.hp or 100 end,
      getNumPartsBleeding = function() return self.bleeding or 0 end,
      -- p.infected: the zombie infection flag.
      IsInfected = function() return self.infected or false end,
      getBodyParts = function() return __javaList(opts.parts or {}) end,
    }
  end
  function p:getMoodles()
    return { getMoodleLevel = function(_, t) return (opts.moodles or {})[t] or 0 end }
  end
  function p:getZombieKills() return opts.kills or 0 end
  function p:getHoursSurvived() return opts.hours or 0 end
  function p:getInventoryWeight() return self.weight or opts.weight or 0 end
  function p:getMaxWeight() return opts.maxWeight or 8 end
  function p:getClothingItem_Back() return self.back or opts.back end
  function p:getPlayerNum() return 0 end
  function p:isKnownPoison() return false end
  -- opts.primary / self.primary: the item in the main hand.
  function p:getPrimaryHandItem() return self.primary or opts.primary end
  function p:getSecondaryHandItem() return nil end
  function p:isHandItem(it) return it ~= nil and it == (self.primary or opts.primary) end
  function p:getUseHandWeapon() return nil end
  function p:isMeleeWeaponEquipped() return false end
  function p:faceLocation() end
  function p:faceThisObject() end
  function p:isAsleep() return self.asleep or false end
  function p:setVariable() end
  function p:getLastHourSleeped() return opts.lastSlept or -100 end
  function p:isSitOnGround() return self.sitting or false end
  function p:isEquippedClothing() return false end
  return p
end

-- An item. opts: type (full type), name, food, hung, cantEat, opening, rotten, burnt, poison,
-- melee, dmg, crit, range, swing, cond, condMax, tags (ItemTag name -> true), bandage, drainable, alcoholPower,
-- fluid = { water, tainted, alcohol, locked }, items (contents when it is a bag).
function __makeItem(opts)
  opts = opts or {}
  local it = { opts = opts }
  function it:getFullType() return opts.type or ("Base." .. (opts.name or "Thing")) end
  function it:getDisplayName() return opts.name or "Thing" end
  function it:IsFood() return opts.food or false end
  function it:getCategory() return opts.food and "Food" or "Item" end
  function it:getHungChange() return opts.hung or 0 end
  function it:getScriptItem()
    return {
      isCantEat = function() return opts.cantEat or false end,
      containsWeaponCategory = function(_, c)
        for _, name in ipairs(opts.cls or {}) do if name == c then return true end end
        return false
      end,
    }
  end
  function it:getActualWeight() return opts.weight or 0 end
  function it:isBroken() return opts.broken or false end
  function it:IsClothing() return opts.clothing or false end
  function it:isTwoHandWeapon() return opts.twoHand or false end
  function it:getOpeningRecipe() return opts.opening end
  function it:isRotten() return opts.rotten or false end
  function it:isBurnt() return opts.burnt or false end
  function it:isbDangerousUncooked() return false end
  function it:isCooked() return false end
  function it:getPoisonPower() return opts.poison or 0 end
  -- opts.gun = { ammo, mag, box, loaded, max, chambered }: a firearm. Its ammo keys are full types.
  local gun = opts.gun
  function it:IsWeapon() return opts.melee or gun ~= nil or false end
  function it:isBareHands() return false end
  function it:isRanged() return gun ~= nil end
  function it:isAimedFirearm() return gun ~= nil end
  function it:getAmmoType()
    local key = (gun and gun.ammo) or opts.ammoKey
    if not key then return nil end
    return { getItemKey = function() return key end }
  end
  function it:getMagazineType() return gun and gun.mag or nil end
  function it:getAmmoBox() return gun and gun.box or nil end
  function it:getCurrentAmmoCount() return (gun and gun.loaded) or opts.rounds or 0 end
  function it:isRoundChambered() return gun and gun.chambered or false end
  function it:getMaxAmmo() return (gun and gun.max) or opts.maxAmmo or 0 end
  function it:getCount() return opts.count or 1 end
  function it:getDisplayCategory() return opts.displayCategory or "Item" end
  function it:getMaxDamage() return opts.dmg or 0 end
  function it:getMaxRange() return opts.range or 0 end
  function it:getCriticalChance() return opts.crit or 0 end
  function it:getSwingTime() return opts.swing or 3 end
  function it:getCondition() return opts.cond or 10 end
  function it:getConditionMax() return opts.condMax or 10 end
  function it:hasTag(tag) return (opts.tags or {})[tag] == true end
  function it:isCanBandage() return opts.bandage or false end
  function it:IsDrainable() return opts.drainable or false end
  function it:getAlcoholPower() return opts.alcoholPower or 0 end
  function it:IsInventoryContainer() return opts.items ~= nil end
  function it:getInventory() return { getItems = function() return __javaList(opts.items or {}) end } end
  function it:getType() return (it:getFullType():gsub("^.-%.", "")) end
  function it:getID() return opts.id or 0 end
  function it:getBandagePower() return opts.power or 0 end
  function it:isWorn() return opts.worn or false end
  function it:getCapacity() return opts.capacity or opts.cap or 0 end
  function it:getWeightReduction() return opts.red or 0 end
  function it:canBeEquipped() return opts.back and ItemBodyLocation.BACK or nil end
  function it:getOffAgeMax() return opts.offMax or 1000000000 end
  function it:getAge() return opts.age or 0 end
  function it:isFrozen() return opts.frozen or false end
  it.__fluid = opts.fluid
  function it:getFluidContainer()
    local f = opts.fluid
    if not f then return nil end
    -- f.other: litres of some other fluid, and f.beverage says whether it is one you drink.
    local amount = (f.water or 0) + (f.alcohol or 0) + (f.other or 0)
    return {
      isCategory = function(_, c) return c == "Beverage" and (f.beverage or false) end,
      isEmpty = function() return amount <= 0 end,
      isInputLocked = function() return f.locked or false end,
      isFull = function() return amount >= (f.cap or 1) end,
      canAddFluid = function() return not f.locked end,
      contains = function(_, fluid)
        if fluid == "Water" then return (f.water or 0) > 0 and not f.tainted end
        if fluid == "TaintedWater" then return f.tainted or false end
        return false
      end,
      isPoisonous = function() return false end,
      getSpecificFluidAmount = function(_, fluid) return fluid == "Water" and (f.water or 0) or 0 end,
      getAmount = function() return amount end,
      getCapacity = function() return f.capacity or 1 end,
      getProperties = function() return { getAlcohol = function() return f.alcohol or 0 end } end,
    }
  end
  return it
end

-- A zombie. opts: x, y, dead, target (what getTarget returns), floor, knocked, crawling.
function __makeZombie(opts)
  opts = opts or {}
  local z = {}
  function z:getX() return opts.x or 0 end
  function z:getY() return opts.y or 0 end
  function z:isDead() return opts.dead or false end
  function z:getTarget() return opts.target end
  function z:isOnFloor() return opts.floor or false end
  function z:isKnockedDown() return opts.knocked or false end
  function z:isCrawling() return opts.crawling or false end
  return z
end

-- A body part. opts: type, and any of bleeding scratched cut bitten deep glass bandaged dirty.
function __makeBodyPart(opts)
  opts = opts or {}
  local b = {}
  function b:getType() return opts.type or "Hand_L" end
  function b:bleeding() return opts.bleeding or false end
  function b:scratched() return opts.scratched or false end
  function b:isCut() return opts.cut or false end
  function b:bitten() return opts.bitten or false end
  function b:deepWounded() return opts.deep or false end
  function b:haveGlass() return opts.glass or false end
  function b:bandaged() return opts.bandaged or false end
  function b:isBandageDirty() return opts.dirty or false end
  function b:getAlcoholLevel() return opts.alcohol or 0 end
  return b
end

-- A world object on a square. opts: bed, water (fluid amount), tainted, container.
function __makeObject(opts)
  opts = opts or {}
  local o = {}
  function o:getProperties() return { has = function(_, flag) return flag == "bed" and opts.bed or false end } end
  function o:hasWater() return (opts.water or 0) > 0 end
  function o:getFluidAmount() return opts.water or 0 end
  function o:isTaintedWater() return opts.tainted or false end
  function o:getSquare() return o.square end
  -- opts.containers: several containers on one object, like a fridge with a freezer.
  local list = opts.containers or (opts.container and { opts.container } or {})
  function o:getContainer() return list[1] end
  function o:getContainerCount() return #list end
  function o:getContainerByIndex(i) return list[i + 1] end
  return o
end

-- A square, registered in __squares. opts: x, y, z, building, room, door ("exterior" or
-- "interior"), objects, light.
function __makeSquare(opts)
  local sq = { opts = opts, objects = opts.objects or {} }
  for _, o in ipairs(sq.objects) do o.square = sq end
  function sq:getX() return opts.x end
  function sq:getY() return opts.y end
  function sq:getZ() return opts.z or 0 end
  function sq:getBuilding() return opts.building end
  function sq:getRoom() return opts.room end
  function sq:getObjects() return __javaList(self.objects) end
  -- opts.world: item stubs lying on the floor of this square.
  function sq:getWorldObjects()
    local list = {}
    for i, item in ipairs(opts.world or {}) do list[i] = { getItem = function() return item end } end
    return __javaList(list)
  end
  function sq:getLightLevel() return opts.light or 1 end
  function sq:isFree() return not opts.blocked end
  function sq:canStand() return not opts.blocked end
  function sq:canReachTo() return true end
  -- opts.flags: set of IsoFlagType names the square has, like exterior.
  function sq:has(flag) return (opts.flags or {})[flag] == true end
  -- opts.around: direction name ("N" or "W") -> the square next to this one that way.
  function sq:getAdjacentSquare(dir) return (opts.around or {})[dir] end
  -- opts.walls: set of "x,y" neighbours a wall separates this square from.
  function sq:isBlockedTo(other)
    local w = opts.walls or {}
    local o = other.opts or {}
    return w[other:getX() .. "," .. other:getY()] or (o.walls or {})[opts.x .. "," .. opts.y] or false
  end
  function sq:getWindow() return opts.window end
  function sq:getIsoDoor()
    if not opts.door then return nil end
    if type(opts.door) == "table" then return opts.door end
    return { isExterior = function() return opts.door == "exterior" end }
  end
  __squares[opts.x .. "," .. opts.y .. "," .. (opts.z or 0)] = sq
  return sq
end

-- A building with its BuildingDef, added to __buildings. opts: id, x, y, x2, y2, res, shop,
-- rooms (room stubs from __makeRoom), water, explored.
function __makeBuilding(opts)
  local def = {}
  function def:getIDString() return opts.id end
  function def:getX() return opts.x end
  function def:getY() return opts.y end
  function def:getX2() return opts.x2 end
  function def:getY2() return opts.y2 end
  function def:isResidential() return opts.res or false end
  function def:isShop() return opts.shop or false end
  function def:getRoomsNumber() return #(opts.rooms or {}) end
  function def:isAllExplored() return opts.explored or false end
  function def:getRooms()
    local defs = {}
    for _, r in ipairs(opts.rooms or {}) do
      table.insert(defs, r.def or { getIsoRoom = function() return r end, getZ = function() return 0 end })
    end
    return __javaList(defs)
  end
  local b = { def = def }
  function b:getDef() return def end
  function b:hasWater() return opts.water or false end
  table.insert(__buildings, b)
  return b
end

-- A room. opts: name, squares (square stubs), waters (water objects getWaterSources returns).
function __makeRoom(opts)
  local r = {}
  function r:getName() return opts.name or "room" end
  function r:getSquares() return __javaList(opts.squares or {}) end
  function r:getWaterSources() return __javaList(opts.waters or {}) end
  function r:getContainer() return __javaList(opts.containers or {}) end
  r.def = {
    getIsoRoom = function() return r end,
    getName = function() return opts.name or "room" end,
    getX = function() return opts.x or 0 end, getY = function() return opts.y or 0 end,
    getX2 = function() return opts.x2 or 0 end, getY2 = function() return opts.y2 or 0 end,
    getZ = function() return opts.z or 0 end,
  }
  function r:getRoomDef() return r.def end
  return r
end

-- A container on a square. opts: items (item stubs), square. Tests move items out to fake a
-- finished transfer with __take(container). opts.loot: the items the game rolls the first time
-- the container is looked at (ItemPicker.fillContainer). Until then it is not explored and empty.
function __makeContainer(opts)
  local c = { items = opts.items or {}, loot = opts.loot, explored = opts.loot == nil }
  local parent = { getSquare = function() return opts.square end }
  function c:getItems() return __javaList(self.items) end
  function c:contains(it)
    for _, x in ipairs(self.items) do if x == it then return true end end
    return false
  end
  function c:getParent() return parent end
  function c:getType() return opts.type or "crate" end
  function c:isExplored() return self.explored end
  function c:setExplored(v) self.explored = v end
  function c:AddItem(it) table.insert(self.items, it); return it end
  function c:DoRemoveItem(it)
    for i, x in ipairs(self.items) do if x == it then table.remove(self.items, i); return end end
  end
  return c
end

-- The game rolls loot into a container the first time it comes into view.
ItemPicker = {
  fillContainer = function(c, p)
    for _, it in ipairs(c.loot or {}) do table.insert(c.items, it) end
    c.loot = nil
  end,
}
-- The floor container the loot window builds: a plain container of type "floor".
ItemContainer = {
  new = function(kind) local c = __makeContainer({ type = kind }); return c end,
}

-- Finish every queued transfer out of container c: the item leaves c, the queue empties.
function __take(p, c)
  local q = ISTimedActionQueue.getTimedActionQueue(p).queue
  for _, a in ipairs(q) do
    if a.Type == "ISInventoryTransferAction" and a.args[3] == c then
      for i, x in ipairs(c.items) do if x == a.args[2] then table.remove(c.items, i); break end end
    end
  end
  ISTimedActionQueue.clear(p)
end

-- Finish every queued transfer wherever it comes from: the item leaves its container (and the
-- square, for the floor) and lands in the player's items. Returns the names taken.
function __finishTransfers(p)
  local names = {}
  for _, a in ipairs(ISTimedActionQueue.getTimedActionQueue(p).queue) do
    if a.Type == "ISInventoryTransferAction" then
      local item, src = a.args[2], a.args[3]
      src:DoRemoveItem(item)
      if src:getType() == "floor" then
        for _, sq in pairs(__squares) do
          local world = sq.opts.world or {}
          for i, x in ipairs(world) do if x == item then table.remove(world, i); break end end
        end
      end
      table.insert(p.__items.items, item)
      table.insert(names, item:getDisplayName())
    end
  end
  ISTimedActionQueue.clear(p)
  return names
end

-- Finish every queued pick-up from the floor: the item leaves the square it lay on, as the
-- game removes its world object, and the queue empties.
function __takeFloor(p)
  local q = ISTimedActionQueue.getTimedActionQueue(p).queue
  for _, a in ipairs(q) do
    if a.Type == "ISInventoryTransferAction" and a.args[3]:getType() == "floor" then
      a.args[3]:DoRemoveItem(a.args[2])
      for _, sq in pairs(__squares) do
        local world = sq.opts.world or {}
        for i, x in ipairs(world) do if x == a.args[2] then table.remove(world, i); break end end
      end
    end
  end
  ISTimedActionQueue.clear(p)
end

-- Finish every queued drop: the item leaves the player's list, the queue empties.
function __finishDrops(p)
  for _, c in ipairs(__menuCalls) do
    if c.name == "dropItem" then
      for i, x in ipairs(p.__items.items) do if x == c.args[1] then table.remove(p.__items.items, i); break end end
    end
  end
  __menuCalls = {}
  ISTimedActionQueue.clear(p)
end

-- Finish the queued walks the way a real one would: the player ends on the square it goes to
-- (the last walk wins), then the queue empties.
function __arrive(p)
  for _, a in ipairs(ISTimedActionQueue.getTimedActionQueue(p).queue) do
    -- A finished drink takes water out, as in the game. fluid.dry = true models a drink that
    -- takes nothing out.
    if a.Type == "ISDrinkFluidAction" and type(a.args[2]) == "table" and a.args[2].__fluid then
      local f = a.args[2].__fluid
      if not f.dry then f.water = math.max(0, (f.water or 0) - (tonumber(a.args[3]) or 1) * (f.water or 0)) end
    end
    if a.Type == "ISWalkToTimedAction" and type(a.args[2]) == "table" then
      local sq = a.args[2]
      p.x, p.y, p.z, p.sq = sq:getX() + 0.5, sq:getY() + 0.5, sq:getZ(), sq
    end
  end
  ISTimedActionQueue.clear(p)
end

-- Types of the queued actions, in order.
function __queueTypes(p)
  local out = {}
  for i, a in ipairs(ISTimedActionQueue.getTimedActionQueue(p).queue) do out[i] = a.Type end
  return out
end
