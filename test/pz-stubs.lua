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
for _, name in ipairs({ "drawText", "drawTextRight", "drawRect", "drawRectBorder" }) do
  ISUIElement[name] = function() end
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
  "ISOpenCloseCurtain",
}) do actionClass(name) end

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

luautils = { walkAdj = function() end }
function instanceof() return false end

-- ---------- world ----------
__zombies = {}
__squares = {}
__players = {}
__files = {}
__speed = 1
__time = { hour = 12, nights = 0 }

function getCell()
  return {
    getZombieList = function() return __javaList(__zombies) end,
    getGridSquare = function(self, x, y, z) return __squares[x .. "," .. y .. "," .. z] end,
  }
end
function getSpecificPlayer(i) return __players[i] end
function getGameTime()
  return { getHour = function() return __time.hour end, getNightsSurvived = function() return __time.nights end }
end
function getGameSpeed() return __speed end
function setGameSpeed(v) __speed = v end

function getFileWriter(name)
  local w = { buf = "" }
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

-- A bare player. opts: x, y, z, dead, items (list of item stubs).
function __makePlayer(opts)
  opts = opts or {}
  local p = { x = opts.x or 0, y = opts.y or 0, z = opts.z or 0, said = {}, dead = opts.dead or false }
  p.__items = __javaList(opts.items or {})
  function p:getX() return self.x end
  function p:getY() return self.y end
  function p:getZ() return self.z end
  function p:isDead() return self.dead end
  function p:Say(text) table.insert(self.said, text) end
  function p:getInventory() return { getItems = function() return self.__items end } end
  function p:setSneaking(v) self.sneaking = v end
  function p:isOutside() return true end
  function p:getSquare() return nil end
  function p:getStats() return { get = function(_, stat) return (opts.stats or {})[stat] or 0 end } end
  function p:getBodyDamage() return { getOverallBodyHealth = function() return opts.hp or 100 end } end
  function p:getPrimaryHandItem() return nil end
  function p:getUseHandWeapon() return nil end
  function p:isMeleeWeaponEquipped() return false end
  function p:faceLocation() end
  function p:faceThisObject() end
  return p
end
