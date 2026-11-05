-- Actions the brain can order: the verb registry, the dispatcher, and every verb that exists today.
-- A new verb is one assignment, LocalSurvivor.verbs.NAME = function(p, args) ... end, from any file.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
require "LocalSurvivor/Move"
local LS = LocalSurvivor
LS.Act = LS.Act or {}
local Act = LS.Act
local Core = LS.Core
local Move = LS.Move

-- ---------- weapons: which to wield ----------
-- Pure. cands: { { score } } for the weapons he carries. heldScore: the score of what is in hand
-- (0 for nothing, or a pen). Returns the index to wield, or nil to leave things as they are.
-- Which weapon to take up is a game rule, so it lives here and not in Core. A swap needs a
-- clear gain (Core.WEAPON.SWAP): two close weapons would otherwise trade places as wear moves
-- their scores.
function Act.chooseWeapon(cands, heldScore)
  local N = Core.WEAPON
  heldScore = tonumber(heldScore) or 0
  local best, bestScore = nil, 0
  for i, c in ipairs(cands or {}) do
    local s = tonumber(c.score) or 0
    if s >= N.MIN_SCORE and s > bestScore then best, bestScore = i, s end
  end
  if not best then return nil end
  if heldScore >= N.MIN_SCORE and bestScore < heldScore * N.SWAP then return nil end
  return best
end

-- The melee weapons he carries, one level into bags: { it, score, name, two }.
function Act.weaponsCarried(p)
  local out = {}
  for _, it in ipairs(LS.Sense.carriedItems(p)) do
    local t = LS.Sense.itemType(it)
    if t.melee then
      local ok, w = pcall(Core.weaponFacts, it, t)
      if ok and w then table.insert(out, { it = it, score = w.score, name = w.n, two = w.two }) end
    end
  end
  return out
end

-- Score of the melee weapon in the main hand, 0 for empty hands or anything that is not a weapon.
function Act.heldScore(p)
  local held = 0
  pcall(function()
    local it = p:getPrimaryHandItem()
    if Core.isMeleeWeapon(it) then held = Core.weaponFacts(it, LS.Sense.itemType(it)).score end
  end)
  return held
end

-- The weapon worth taking up now, or nil. Second value: every weapon carried.
function Act.equipPlan(p)
  local cands = Act.weaponsCarried(p)
  local i = Act.chooseWeapon(cands, Act.heldScore(p))
  return i and cands[i] or nil, cands
end

-- A weapon in a bag has to come out to the main inventory first, as vanilla's equip does.
function Act.queueEquip(p, c)
  pcall(function() ISInventoryPaneContextMenu.transferIfNeeded(p, c.it) end)
  ISTimedActionQueue.add(ISEquipWeaponAction:new(p, c.it, 50, true, c.two))
  LS.hudData.thought = "Taking up the " .. tostring(c.name) .. "."
end

-- Returns "held" when nothing needed doing because the right weapon is already in hand.
function Act.doEquip(p)
  local c, cands = Act.equipPlan(p)
  if c then Act.queueEquip(p, c); return "queued" end
  for _, x in ipairs(cands) do
    if x.score >= Core.WEAPON.MIN_SCORE then return "held" end
  end
  LS.lastError = "equip: no weapon"
end

-- ---------- other actions ----------
-- close the nearest open door (buys time when fleeing indoors, zombies must thump through)
function Act.doCloseDoor(p)
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  local door = nil
  for dx = -2, 2 do
    for dy = -2, 2 do
      local sq = getCell():getGridSquare(px + dx, py + dy, pz)
      if sq then
        local objs = sq:getObjects()
        for i = 0, objs:size() - 1 do
          local o = objs:get(i)
          local open = false
          pcall(function() if instanceof(o, "IsoDoor") and o:IsOpen() then open = true end end)
          if open then door = o; break end
        end
      end
      if door then break end
    end
    if door then break end
  end
  if door then ISTimedActionQueue.add(ISOpenCloseDoor:new(p, door)) else LS.lastError = "closedoor: no open door within 2 tiles" end
end

function Act.roomOf(sq)
  if not sq then return nil end
  local room = nil
  pcall(function() room = sq:getRoom() end)
  return room
end

-- A way in: intact, exterior, and the room behind it is not the one he is already in.
-- isSmashed() and isDestroyed() read the same flag on this build, so a broken window is not a door.
-- IsoWindow has no getOppositeSquare in 42.21. getIndoorSquare is the room side.
function Act.isEntranceWindow(p, win)
  local destroyed = true
  local ok = pcall(function() destroyed = win:isDestroyed() end)
  if not ok or destroyed then return false end
  local exterior = false
  ok = pcall(function() exterior = win:isExterior() end)
  if not ok or not exterior then return false end
  local here = Act.roomOf(p:getSquare())
  local intoRoom = nil
  pcall(function() intoRoom = Act.roomOf(win:getIndoorSquare()) end)
  if here and intoRoom and here == intoRoom then return false end
  return true
end

-- break into a locked building: smash the nearest outside window and climb through.
function Act.doBreakin(p)
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  local win, bestD = nil, 99999
  for dx = -8, 8 do
    for dy = -8, 8 do
      local sq = getCell():getGridSquare(px + dx, py + dy, pz)
      if sq then
        local objs = sq:getObjects()
        for i = 0, objs:size() - 1 do
          local o = objs:get(i)
          local isWin = false
          pcall(function() if instanceof(o, "IsoWindow") then isWin = true end end)
          if isWin and Act.isEntranceWindow(p, o) then
            local d = math.abs(dx) + math.abs(dy)
            if d < bestD then bestD, win = d, o end
          end
        end
      end
    end
  end
  if not win then LS.lastError = "breakin: no entrance window within 8 tiles"; return end
  ISTimedActionQueue.clear(p)
  pcall(function() luautils.walkAdj(p, win:getSquare()) end)
  local climb = false
  pcall(function() climb = win:canClimbThrough(p) end)
  if not climb then pcall(function() ISTimedActionQueue.add(ISSmashWindow:new(p, win)) end) end
  pcall(function() ISTimedActionQueue.add(ISClimbThroughWindow:new(p, win, 0)) end)
end

-- CONCEAL: hunker down. Close every open door and window curtain nearby so he can't be seen
-- from outside. The core "hide inside" behavior.
function Act.doConceal(p)
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  local did = false
  for dx = -2, 2 do
    for dy = -2, 2 do
      local sq = getCell():getGridSquare(px + dx, py + dy, pz)
      if sq then
        local objs = sq:getObjects()
        for i = 0, objs:size() - 1 do
          local o = objs:get(i)
          pcall(function()
            if instanceof(o, "IsoDoor") and o:IsOpen() then ISTimedActionQueue.add(ISOpenCloseDoor:new(p, o)); did = true end
          end)
          -- The curtain is its own object (IsoCurtain). IsoWindow has no isCurtainOpen in 42.21.
          pcall(function()
            local curtain = instanceof(o, "IsoWindow") and o:HasCurtains() or nil
            if curtain and curtain:IsOpen() then
              ISTimedActionQueue.add(ISOpenCloseCurtain:new(p, curtain)); did = true
            end
          end)
        end
      end
    end
  end
  if not did then LS.lastError = "conceal: nothing open to close nearby" end
end

-- night vision is bad in Zomboid, so keep a light source lit after dark so he can see (and act).
function Act.manageLight(p)
  local hour = 12
  pcall(function() hour = getGameTime():getHour() end)
  local _, _, _, nd = LS.Sense.zombieScan(p:getX(), p:getY())
  local night = (hour < 7 or hour >= 20) and (nd < 0 or nd > 25)
  pcall(function()
    local items = p:getInventory():getItems()
    for i = 0, items:size() - 1 do
      local it = items:get(i)
      local strength = 0
      pcall(function() strength = it:getLightStrength() end)
      if strength and strength > 0 then pcall(function() it:setActivated(night) end) end
    end
  end)
end

-- ---------- loot priorities ----------
-- What a search takes, best first. max caps how many a body carries, counting what it already
-- has. Anything that matches no row (clothes, junk) is left where it is.
Act.LOOT = {
  { key = "weapon", score = 100 },
  { key = "bag", score = 90, max = 1 },
  { key = "water", score = 80, max = 4 },
  { key = "bottle", score = 70, max = 2 },
  { key = "food", score = 60, max = 12 },
  { key = "can", score = 55, max = 12 },
  { key = "opener", score = 50, max = 1 },
  { key = "bandage", score = 45, max = 6 },
  { key = "sheet", score = 40, max = 6 },
  { key = "disinfectant", score = 35, max = 2 },
  { key = "painkiller", score = 30, max = 2 },
  { key = "hammer", score = 20, max = 1 },
  { key = "saw", score = 19, max = 1 },
  { key = "screwdriver", score = 18, max = 1 },
  { key = "lighter", score = 17, max = 1 },
  { key = "flashlight", score = 16, max = 1 },
}

-- What kind of thing a described item is, ignoring what is carried.
Act.IS = {
  weapon = function(d) return Core.isRealWeapon(d.weapon) end,
  bag = function(d) return d.bag ~= nil end,
  water = function(d) return (tonumber(d.waterL) or 0) > 0 end,
  bottle = function(d) return (d.emptyBottle or d.drink) and true or false end,
  food = function(d) return d.edible == true end,
  can = function(d) return d.sealed == true end,
  opener = function(d) return d.opener == true end,
  bandage = function(d) return d.bandage == true and not d.sheet end,
  sheet = function(d) return d.sheet == true end,
  disinfectant = function(d) return d.disinfect == true end,
  painkiller = function(d) return d.painkiller == true end,
  hammer = function(d) return d.hammer == true end,
  saw = function(d) return d.saw == true end,
  screwdriver = function(d) return d.screwdriver == true end,
  lighter = function(d) return d.lighter == true end,
  flashlight = function(d) return d.flashlight == true end,
}

-- Pure. The score of a described item's weapon facts, 0 when it has none.
local function weaponScoreOf(d)
  if type(d) ~= "table" or d.broken or type(d.weapon) ~= "table" then return 0 end
  return tonumber(d.weapon.score) or Core.weaponScore(d.weapon)
end

-- Pure. Add one described item to a have table (counts per key, best weapon score, bag worn).
function Act.countInto(have, d)
  for _, row in ipairs(Act.LOOT) do
    if row.key ~= "weapon" and Act.IS[row.key](d) then have[row.key] = (have[row.key] or 0) + 1 end
  end
  have.weaponValue = math.max(tonumber(have.weaponValue) or 0, weaponScoreOf(d))
  return have
end

-- Pure. Why to take d given what is carried: the first row it matches that is not full yet.
-- Returns the key and a score, or nil to leave it.
function Act.lootPick(d, have)
  if type(d) ~= "table" or d.broken then return nil end
  if d.clothing and not d.bag then return nil end
  have = have or {}
  local best = tonumber(have.weaponValue) or 0
  for _, row in ipairs(Act.LOOT) do
    local key = row.key
    if Act.IS[key](d) and (tonumber(have[key]) or 0) < (row.max or 99) then
      local ok, bonus = true, -(tonumber(d.weight) or 0) / 100
      if key == "weapon" then
        -- A real weapon when he has none, or one clearly better than the best he carries. The
        -- same swap margin as EQUIP, so he never picks up what he would not wield.
        local v = weaponScoreOf(d)
        ok = v >= Core.WEAPON.MIN_SCORE and (best <= 0 or v > best * Core.WEAPON.SWAP)
        bonus = math.min(v, 100) / 200
      elseif key == "bag" then
        ok = not have.bagWorn
        bonus = (tonumber(d.bag.capacity) or 0) / 100
      end
      if ok then return key, row.score + bonus end
    end
  end
  return nil
end

-- Pure. descs: described items in one container. Returns { {index, key} } best first, inside
-- the weight budget, and the budget left. have is updated as if every pick was taken, so a
-- second crowbar or a second can opener is left behind.
function Act.planTake(descs, have, budget)
  budget = tonumber(budget) or 0
  local cands = {}
  for i, d in ipairs(descs or {}) do
    local key, score = Act.lootPick(d, have)
    if key then table.insert(cands, { i = i, score = score }) end
  end
  table.sort(cands, function(a, b)
    if a.score ~= b.score then return a.score > b.score end
    return a.i < b.i
  end)
  local picks = {}
  for _, c in ipairs(cands) do
    local d = descs[c.i]
    local key = Act.lootPick(d, have)
    local w = tonumber(d.weight) or 0
    if key and w <= budget then
      table.insert(picks, { index = c.i, key = key })
      budget = budget - w
      Act.countInto(have, d)
    end
  end
  return picks, budget
end

-- Pure. "took 3: Crowbar, Beans, Bandage", capped so the percept stays small.
local function listText(verb, names)
  local n = #(names or {})
  if n == 0 then return verb .. " nothing" end
  local shown = {}
  for i = 1, math.min(8, n) do shown[i] = names[i] end
  local text = verb .. " " .. n .. ": " .. table.concat(shown, ", ")
  if n > 8 then text = text .. " and " .. (n - 8) .. " more" end
  return text
end
function Act.tookText(names) return listText("took", names) end
function Act.droppedText(names) return listText("dropped", names) end

-- ---------- describing items ----------
if LS.lootTypes == nil then LS.lootTypes = {} end

-- Facts per item type that Sense.itemType does not keep.
local function lootType(it)
  local full = ""
  pcall(function() full = it:getFullType() end)
  local t = LS.lootTypes[full]
  if t then return t end
  t = { back = Core.isBackBag(it), flashlight = false }
  pcall(function() t.flashlight = it:hasTag(ItemTag.FLASHLIGHT) == true end)
  if full ~= "" then LS.lootTypes[full] = t end
  return t
end

-- One game item as the plain table lootPick reads. Every call guarded on its own.
function Act.describeLoot(it, p)
  local t = LS.Sense.itemType(it)
  local lt = lootType(it)
  local d = { name = "?", type = "", weight = 0 }
  pcall(function() d.name = it:getDisplayName() end)
  pcall(function() d.type = it:getFullType() end)
  pcall(function() d.weight = it:getActualWeight() end)
  pcall(function() d.broken = it:isBroken() == true end)
  pcall(function() d.clothing = it:IsClothing() == true end)
  if t.melee then d.weapon = Core.weaponFacts(it, t) end
  if t.bag and lt.back then
    d.bag = { capacity = 0 }
    pcall(function() d.bag.capacity = it:getCapacity() end)
  end
  if t.fluid then
    pcall(function()
      local fc = it:getFluidContainer()
      local amount = fc:getAmount() or 0
      if fc:isEmpty() or amount <= 0 then
        local cap = 0
        pcall(function() cap = fc:getCapacity() end)
        d.emptyBottle = (not fc:isInputLocked()) and cap > 0 and cap <= 2
      elseif not fc:contains(Fluid.TaintedWater) and not fc:isPoisonous() then
        local water = fc:getSpecificFluidAmount(Fluid.Water) or 0
        if water > 0 then d.waterL = water end
        -- Vanilla's health panel line for disinfectant: at least 40% alcohol and over 0.15 L.
        if amount > 0.15 and fc:getProperties():getAlcohol() / amount + 0.001 >= 0.4 then d.disinfect = true
        elseif water <= 0 then d.drink = true end
      end
    end)
  end
  if t.food then
    d.edible = Core.isEdible(it, p)
    if not d.edible then d.sealed = Core.isSealedFood(it) end
  end
  d.opener, d.hammer, d.saw, d.screwdriver, d.lighter = t.opener, t.hammer, t.saw, t.screwdriver, t.lighter
  d.painkiller, d.bandage, d.flashlight = t.painkiller, t.bandage, lt.flashlight
  d.sheet = t.bandage and d.type == "Base.RippedSheets" or false
  if t.wipe then d.disinfect = true end
  return d
end

-- What the body carries, as a have table for lootPick.
function Act.carried(p)
  local have = { weaponValue = 0, bagWorn = false }
  pcall(function() have.bagWorn = p:getClothingItem_Back() ~= nil end)
  for _, it in ipairs(LS.Sense.carriedItems(p)) do
    local ok, d = pcall(Act.describeLoot, it, p)
    if ok and d then Act.countInto(have, d) end
  end
  return have
end

-- ---------- skills ----------
-- A skill is an order that takes many ticks: GOTO, ENTER, SEARCH, LOOT. LS.skill holds the one
-- running. Act.update moves it on every tick. It reports through LS.setResult: running at the
-- start, then done or failed with a short why.
-- Searched rooms, by building id then room key. A second SEARCH picks up where one stopped.
if LS.searched == nil then LS.searched = {} end

Act.SKILL = Act.SKILL or {}
Act.YIELD_TICKS = 30        -- quiet ticks after the reflex acted before a skill moves again
Act.PAUSE_MAX = 1800        -- a fight this long and the target is not worth it
Act.UNSAFE_R = 4            -- a living zombie this close to the target on resume: give up
Act.LOOT_ZOMBIE_R = 8
Act.WEIGHT_CAP = 0.85
Act.LOOT_RADIUS = 10

function Act.startSkill(p, verb, args, def)
  local s = { verb = verb, seq = args.seq, args = args, def = def, startTick = LS.tick, lastTick = LS.tick,
    prog = {}, phase = "start" }
  LS.skill = s
  LS.travel.active = false
  LS.hudData.action = verb
  LS.aim(s.seq, Act.skillTarget(s))
  local ok, err = pcall(def.start, p, s)
  if not ok then Act.finish(s, "failed", "error " .. tostring(err)) end
  -- SEARCH and LOOT only know their building once start has run.
  if not s.over then LS.aim(s.seq, Act.skillTarget(s)) end
  return s
end

-- What the skill works on, for res.target: the building id for ENTER, SEARCH and LOOT, and
-- x,y for GOTO.
function Act.skillTarget(s)
  if s.verb == "ENTER" then return s.args.target end
  if s.verb == "GOTO" then
    local x, y = tonumber(s.args.a), tonumber(s.args.b)
    if x and y then return math.floor(x) .. "," .. math.floor(y) end
    return nil
  end
  return s.bid
end

-- Report and drop the skill. A failure also sets lastError ("enter: locked") so the v1 bridge,
-- which only reads err, sees it.
function Act.finish(s, status, why)
  if LS.skill == s then LS.skill = nil end
  if s.over then return end
  s.over = true
  LS.setResult(s.seq, s.verb, status, why)
  if status == "failed" then
    LS.lastError = string.lower(s.verb) .. ": " .. why
    LS.hudData.thought = s.verb .. " failed: " .. why
  else
    LS.hudData.thought = s.verb .. " done: " .. why
  end
end

-- A new order replaces the skill. It reports nothing: the new order's result takes the record.
function Act.cancelSkill(p)
  local s = LS.skill
  if not s then return end
  s.over = true
  LS.skill = nil
  pcall(function() ISTimedActionQueue.clear(p) end)
end

-- A MOVE in the middle of a grab waits, the way it always did: transfers still queued and no
-- zombie close. Anything else replaces the skill.
function Act.keepsSkill(p, action)
  local s = LS.skill
  if not s or action ~= "MOVE" then return false end
  if s.verb ~= "SEARCH" and s.verb ~= "LOOT" then return false end
  if LS.tick - LS.lastLootTick >= 400 or Core.queueLength(p) == 0 then return false end
  local _, _, _, nd = LS.Sense.zombieScan(p:getX(), p:getY())
  return not (nd >= 0 and nd < Act.LOOT_ZOMBIE_R)
end

function Act.zombieNear(x, y, r)
  local near = false
  pcall(function()
    local zl = getCell():getZombieList()
    for i = 0, zl:size() - 1 do
      local z = zl:get(i)
      local dx, dy = z:getX() - x, z:getY() - y
      if dx * dx + dy * dy <= r * r and Core.zombieAlive(z) then near = true; return end
    end
  end)
  return near
end

-- A brain MOVE has no skill state, but it can still fail: the unstick helper keeps firing on one
-- tile, or the pathfinder keeps giving up (Move.momentum sets travel.failed).
function Act.watchMove(p, fired)
  local r = LS.result
  if r.verb ~= "MOVE" or r.status ~= "running" or r.seq ~= LS.lastSeq then return end
  local travel = LS.travel
  local why = nil
  if fired and Move.stuckHere(0) then why = "stuck"
  elseif travel.failed and travel.seq == r.seq then why = travel.failed end
  if not why then return end
  travel.active, travel.failed = false, nil
  LS.setResult(r.seq, "MOVE", "failed", why)
  LS.lastError = "move: " .. why
  LS.hudData.thought = "Can't get through this way."
end

-- Called every tick from the entry file, after the reflex. acted is true on a tick the reflex
-- fought, backed off or fled. While it is busy the skill does nothing, and above all does not
-- touch the queue the reflex just filled.
function Act.update(p, acted)
  local fired = Move.watchUnstick(p)
  local s = LS.skill
  if not s then Act.watchMove(p, fired); return end
  local tick = LS.tick
  -- A gap means the update was skipped (manual mode): whatever was queued is gone.
  if tick - s.lastTick > 30 then s.resume = true end
  s.lastTick = tick
  if acted then
    s.pausedUntil = tick + Act.YIELD_TICKS
    s.pauseStart = s.pauseStart or tick
  end
  if s.pauseStart then
    if tick - s.pauseStart > Act.PAUSE_MAX then Act.finish(s, "failed", "zombie"); return end
    if tick < (s.pausedUntil or 0) then return end
    s.pauseStart = nil
    if s.tx and Act.zombieNear(s.tx, s.ty, Act.UNSAFE_R) then
      ISTimedActionQueue.clear(p)
      Act.finish(s, "failed", "zombie")
      return
    end
    s.resume = true
  end
  if fired and Move.stuckHere(s.startTick) then
    ISTimedActionQueue.clear(p)
    Act.finish(s, "failed", "stuck")
    return
  end
  if s.resume then
    s.resume = false
    s.issued = false
    LS.travel.active = false
    Move.resetProgress(s.prog)
  end
  local ok, err = pcall(s.def.step, p, s)
  if not ok then Act.finish(s, "failed", "error " .. tostring(err)) end
end

-- One leg of walking for a skill. issue() queues the walk and returns false if it cannot.
-- Returns "arrived", "walking", "unreachable" (the walk keeps ending short) or "stuck" (a walk
-- is queued but the body has not got closer for NO_PROGRESS ticks).
function Act.walkLeg(p, s, x, y, near, issue)
  local d, stall = Move.progress(s.prog, p, x, y)
  if d <= near then return "arrived" end
  if not s.issued then
    ISTimedActionQueue.clear(p)
    if not issue() then return "unreachable" end
    s.issued, s.issueD, s.issueTick = true, d, LS.tick
    Move.resetProgress(s.prog)
    return "walking"
  end
  if Core.queueLength(p) == 0 then
    -- The walk ended short: the pathfinder gave up, or it went to the last loaded square.
    if d < (s.issueD or d) - 1 then
      s.ends, s.issued = 0, false
      return "walking"
    end
    s.ends = (s.ends or 0) + 1
    if s.ends >= 2 then return "unreachable" end
    s.issued = false
    return "walking"
  end
  if stall > Move.NO_PROGRESS then return "stuck" end
  return "walking"
end

-- A leg that has to end on one exact square: the one in front of a window or a container.
-- Arrived means standing on it. Measured from the square's corner, "close enough" was also true
-- on the diagonal neighbour, where opening a window works but climbing through it is refused, so
-- ENTER opened windows it could not use and then smashed one.
function Act.walkToSquare(p, s, sq)
  local here = nil
  pcall(function() here = p:getCurrentSquare() end)
  if here and here == sq then return "arrived" end
  return Act.walkLeg(p, s, sq:getX() + 0.5, sq:getY() + 0.5, 0.3, function() Move.walkTo(p, sq); return true end)
end

-- Start a fresh leg: the next walkLeg call issues the walk.
function Act.newLeg(s)
  s.issued, s.ends = false, 0
  Move.resetProgress(s.prog)
end

-- ---------- GOTO ----------
Act.GOTO_NEAR = 1.5

Act.SKILL.GOTO = {
  start = function(p, s)
    local x, y = tonumber(s.args.a), tonumber(s.args.b)
    if not x or not y then return Act.finish(s, "failed", "no target") end
    s.x, s.y = math.floor(x), math.floor(y)
    s.tx, s.ty = s.x + 0.5, s.y + 0.5
    LS.hudData.action = "GOTO " .. s.x .. "," .. s.y
    Act.newLeg(s)
  end,
  step = function(p, s)
    local r = Act.walkLeg(p, s, s.x, s.y, Act.GOTO_NEAR, function() return Act.issueGoto(p, s) end)
    if r == "arrived" then
      if Move.queuedWalkOnly(p) then ISTimedActionQueue.clear(p) end
      Act.finish(s, "done", "arrived")
    elseif r ~= "walking" then
      ISTimedActionQueue.clear(p)
      Act.finish(s, "failed", r)
    end
  end,
}

-- The square itself, or a free square next to it when it holds furniture. A square that is not
-- loaded yet gets a step along the heading; it loads as the body gets closer.
function Act.issueGoto(p, s)
  local z = math.floor(p:getZ())
  local sq = Move.square(s.x, s.y, z)
  if not sq and z ~= 0 then sq = Move.square(s.x, s.y, 0) end
  if not sq then
    return Move.stepWalk(p, s.x - math.floor(p:getX()), s.y - math.floor(p:getY()), true)
  end
  local dest = sq
  if not Move.canStand(sq) then dest = Move.adjacent(p, sq) end
  if not dest then return false end
  Move.walkTo(p, dest)
  return true
end

-- ---------- rooms and containers ----------
function Act.roomKey(rd)
  local key = "?"
  pcall(function() key = rd:getName() .. "@" .. rd:getX() .. "," .. rd:getY() .. "," .. rd:getZ() end)
  return key
end

-- Rooms of a building as plain rows: { key, def, x, y, x2, y2, z }.
function Act.buildingRooms(m)
  local rows = {}
  pcall(function()
    local list = m.def:getRooms()
    for i = 0, list:size() - 1 do
      local rd = list:get(i)
      local row = { key = Act.roomKey(rd), def = rd, x = 0, y = 0, x2 = 0, y2 = 0, z = 0 }
      pcall(function() row.x, row.y, row.x2, row.y2 = rd:getX(), rd:getY(), rd:getX2(), rd:getY2() end)
      pcall(function() row.z = rd:getZ() end)
      table.insert(rows, row)
    end
  end)
  return rows
end

-- How many rooms of the building SEARCH has not finished. The room keys of a building do not
-- change, so they are read once and kept in its memo.
function Act.roomsLeft(m)
  if not m.roomKeys then
    local keys = {}
    for _, row in ipairs(Act.buildingRooms(m)) do table.insert(keys, row.key) end
    if #keys == 0 then return 0 end
    m.roomKeys = keys
  end
  local done = LS.searched[m.id] or {}
  local left = 0
  for _, key in ipairs(m.roomKeys) do
    if not done[key] then left = left + 1 end
  end
  return left
end

-- Containers in a room as { c, sq }. IsoRoom:getContainer() is the room's own list. When it is
-- empty the room squares are read, the way the loot window finds them.
function Act.roomContainers(room)
  local out = {}
  local function add(c, sq)
    if c and sq then table.insert(out, { c = c, sq = sq }) end
  end
  pcall(function()
    local list = room:getContainer()
    for i = 0, list:size() - 1 do
      local c = list:get(i)
      local sq = nil
      pcall(function() sq = c:getParent():getSquare() end)
      if not sq then pcall(function() sq = c:getSourceGrid() end) end
      add(c, sq)
    end
  end)
  if #out > 0 then return out end
  pcall(function()
    local squares = room:getSquares()
    for i = 0, squares:size() - 1 do
      local sq = squares:get(i)
      local objs = sq:getObjects()
      for j = 0, objs:size() - 1 do
        local o = objs:get(j)
        local n = 0
        pcall(function() n = o:getContainerCount() end)
        for k = 0, n - 1 do
          pcall(function() add(o:getContainerByIndex(k), sq) end)
        end
      end
    end
  end)
  return out
end

-- Nearest container within the loot radius on this floor, for a LOOT ordered from outside.
function Act.nearestContainer(p)
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  local best, bestD = nil, 99999
  local cell = getCell()
  for dx = -Act.LOOT_RADIUS, Act.LOOT_RADIUS do
    for dy = -Act.LOOT_RADIUS, Act.LOOT_RADIUS do
      local d = math.abs(dx) + math.abs(dy)
      if d < bestD then
        pcall(function()
          local sq = cell:getGridSquare(px + dx, py + dy, pz)
          local objs = sq and sq:getObjects()
          if not objs then return end
          for i = 0, objs:size() - 1 do
            local c = objs:get(i):getContainer()
            if c then best, bestD = { c = c, sq = sq }, d; return end
          end
        end)
      end
    end
  end
  return best
end

function Act.weightLeft(p)
  local cap, now = 0, 0
  pcall(function() cap = p:getMaxWeight() * Act.WEIGHT_CAP end)
  pcall(function() now = p:getInventoryWeight() end)
  return cap - now
end

-- Into the worn bag while it has room, otherwise the main inventory.
function Act.destFor(p, it)
  local dest = p:getInventory()
  pcall(function()
    local back = p:getClothingItem_Back()
    if back and back:IsInventoryContainer() then
      local inv = back:getInventory()
      if inv:hasRoomFor(p, it) then dest = inv end
    end
  end)
  return dest
end

function Act.canReach(p, sq)
  local ok = false
  pcall(function()
    local here = p:getSquare()
    ok = here == sq or here:canReachTo(sq)
  end)
  return ok
end

-- ---------- SEARCH and LOOT ----------
-- Both walk container to container and take what Act.LOOT wants. SEARCH covers the building
-- room by room, nearest room first, and remembers the rooms it finished. LOOT covers the room
-- the body is in.
local searchStep

local function startSearch(p, s, rooms, bid)
  s.bid = bid
  s.phase = "room"
  s.rooms = rooms
  s.names = {}
  s.have = Act.carried(p)
  s.phase = "room"
  s.skipRoom = {}
end

Act.SKILL.SEARCH = {
  start = function(p, s)
    local _, _, _, nd = LS.Sense.zombieScan(p:getX(), p:getY())
    if nd >= 0 and nd < Act.LOOT_ZOMBIE_R then return Act.finish(s, "failed", "zombie") end
    if Act.weightLeft(p) <= 0 then return Act.finish(s, "failed", "full") end
    local _, m = LS.Sense.currentBuilding(p)
    if not m then return Act.finish(s, "failed", "not inside") end
    local rooms = Act.buildingRooms(m)
    local done = LS.searched[m.id] or {}
    local left = 0
    for _, r in ipairs(rooms) do if not done[r.key] then left = left + 1 end end
    if left == 0 then return Act.finish(s, "failed", "nothing left") end
    LS.hudData.action = "SEARCH"
    startSearch(p, s, rooms, m.id)
  end,
  step = function(p, s) searchStep(p, s) end,
}

Act.SKILL.LOOT = {
  start = function(p, s)
    local _, _, _, nd = LS.Sense.zombieScan(p:getX(), p:getY())
    if nd >= 0 and nd < Act.LOOT_ZOMBIE_R then return Act.finish(s, "failed", "zombie") end
    if Act.weightLeft(p) <= 0 then return Act.finish(s, "failed", "full") end
    LS.hudData.action = "LOOT"
    -- LOOT always looks again, even in a room a SEARCH finished.
    s.ignoreDone = true
    local room, bid = nil, nil
    pcall(function() room = p:getSquare():getRoom() end)
    pcall(function()
      local _, m = LS.Sense.currentBuilding(p)
      bid = m and m.id
    end)
    if room and #Act.roomContainers(room) > 0 then
      local rd = nil
      pcall(function() rd = room:getRoomDef() end)
      startSearch(p, s, { { key = rd and Act.roomKey(rd) or "here", def = rd, room = room } }, bid)
      return
    end
    -- Outside, or a room with nothing to open: the nearest container within reach, as LOOT always did.
    local near = Act.nearestContainer(p)
    if not near then return Act.finish(s, "failed", "nothing left") end
    local nroom, nbid = nil, nil
    pcall(function() nroom = near.sq:getRoom() end)
    pcall(function()
      local b = near.sq:getBuilding()
      local m = b and LS.Sense.memoFor(b)
      nbid = m and m.id
    end)
    if nroom then
      local rd = nil
      pcall(function() rd = nroom:getRoomDef() end)
      startSearch(p, s, { { key = rd and Act.roomKey(rd) or "near", def = rd, room = nroom } }, nbid)
    else
      startSearch(p, s, { { key = "loose", room = nil, containers = { near } } }, nil)
    end
  end,
  step = function(p, s) searchStep(p, s) end,
}

local function endSearch(s, full)
  local why = Act.tookText(s.names)
  if full then why = why .. " (full)" end
  Act.finish(s, "done", why)
end

-- A search that took a better weapon takes it up before it reports, so the next order does not
-- find the old one still in hand. The result text stays "took N: ..." because the bridge reads it.
local function finishSearch(p, s, full)
  if s.tookWeapon and not s.equipTried then
    local c = Act.equipPlan(p)
    if c then
      s.equipTried, s.equipItem, s.full = true, c, full
      Act.queueEquip(p, c)
      -- A MOVE ordered meanwhile waits for it, as it does for item transfers.
      LS.lastLootTick = LS.tick
      s.waitTick = LS.tick
      s.phase = "equip"
      return
    end
  end
  endSearch(s, full)
end

local function roomDistance(p, r)
  local dz = math.abs((r.z or 0) - math.floor(p:getZ()))
  if not r.x then return dz * 4 end
  local _, _, d = LS.Sense.rectOffset(p:getX(), p:getY(), r)
  return d + dz * 4
end

-- Pick the next thing to do. Each phase reads the world again, so a resume after the reflex can
-- simply run the phase again.
searchStep = function(p, s)
  local done = (s.bid and not s.ignoreDone) and (LS.searched[s.bid] or {}) or {}

  if s.phase == "equip" then
    if Core.queueLength(p) > 0 and LS.tick - s.waitTick < 600 then return end
    local held = false
    pcall(function() held = p:getPrimaryHandItem() == s.equipItem.it end)
    -- The reflex clears the queue when it fights, so a cut equip gets one more try.
    if not held and not s.equipRetried then
      s.equipRetried = true
      Act.queueEquip(p, s.equipItem)
      s.waitTick = LS.tick
      return
    end
    return endSearch(s, s.full)
  end

  if s.phase == "room" then
    if Act.weightLeft(p) <= 0 then return finishSearch(p, s, true) end
    local best, bestD = nil, 99999
    for _, r in ipairs(s.rooms) do
      if not done[r.key] and not s.skipRoom[r.key] then
        local d = roomDistance(p, r)
        if d < bestD then best, bestD = r, d end
      end
    end
    if not best then return finishSearch(p, s, false) end
    local room = best.room
    if not room and best.def then pcall(function() room = best.def:getIsoRoom() end) end
    if not room and not best.containers then
      -- Not loaded. Leave it unsearched for a later SEARCH.
      s.skipRoom[best.key] = true
      return
    end
    s.room = best
    s.cons = best.containers or Act.roomContainers(room)
    LS.hudData.action = s.verb .. " " .. (string.match(best.key, "^[^@]*") or "")
    s.phase = "next"
    return
  end

  if s.phase == "next" then
    local best, bestD = nil, 99999
    for _, c in ipairs(s.cons) do
      if not c.done then
        local d = 99999
        pcall(function() d = Move.distTo(p, c.sq:getX(), c.sq:getY()) + math.abs(c.sq:getZ() - p:getZ()) * 4 end)
        if d < bestD then best, bestD = c, d end
      end
    end
    if not best then
      s.skipRoom[s.room.key] = true
      if s.bid and s.room.def then
        LS.searched[s.bid] = LS.searched[s.bid] or {}
        LS.searched[s.bid][s.room.key] = true
      end
      s.phase = "room"
      return
    end
    if Act.weightLeft(p) <= 0 then return finishSearch(p, s, true) end
    s.cur = best
    pcall(function() s.tx, s.ty = best.sq:getX() + 0.5, best.sq:getY() + 0.5 end)
    s.dest = nil
    Act.newLeg(s)
    s.phase = "walk"
    return
  end

  if s.phase == "walk" then
    local c = s.cur
    local near = false
    pcall(function() near = Move.distTo(p, c.sq:getX(), c.sq:getY()) <= 1.6 and c.sq:getZ() == math.floor(p:getZ()) and Act.canReach(p, c.sq) end)
    if near then s.phase = "take"; return end
    if not s.dest then s.dest = Move.adjacent(p, c.sq) end
    if not s.dest then c.done = true; s.phase = "next"; return end
    local r = Act.walkToSquare(p, s, s.dest)
    if r == "arrived" then s.phase = "take"
    elseif r ~= "walking" then c.done = true; s.phase = "next" end
    return
  end

  if s.phase == "take" then
    local c = s.cur
    local items, descs = {}, {}
    pcall(function()
      local list = c.c:getItems()
      for i = 0, list:size() - 1 do
        local it = list:get(i)
        local ok, d = pcall(Act.describeLoot, it, p)
        if ok and d then
          table.insert(items, it)
          table.insert(descs, d)
        end
      end
    end)
    local have = {}
    for k, v in pairs(s.have) do have[k] = v end
    local picks = Act.planTake(descs, have, Act.weightLeft(p))
    s.pending = {}
    ISTimedActionQueue.clear(p)
    for _, pick in ipairs(picks) do
      local it = items[pick.index]
      local dest = pick.key == "bag" and p:getInventory() or Act.destFor(p, it)
      ISTimedActionQueue.add(ISInventoryTransferAction:new(p, it, c.c, dest, 10))
      if pick.key == "bag" and not s.have.bagWorn then
        pcall(function() ISTimedActionQueue.add(ISWearClothing:new(p, it)) end)
        s.have.bagWorn = true
      end
      table.insert(s.pending, { it = it, name = descs[pick.index].name, weapon = pick.key == "weapon" })
    end
    if #s.pending == 0 then c.done = true; s.phase = "next"; return end
    LS.lastLootTick = LS.tick
    s.waitTick = LS.tick
    s.phase = "wait"
    return
  end

  if s.phase == "wait" then
    if Core.queueLength(p) > 0 and LS.tick - s.waitTick < 1200 then return end
    local c = s.cur
    local left = 0
    for _, e in ipairs(s.pending) do
      local still = false
      pcall(function() still = c.c:contains(e.it) end)
      if still then left = left + 1 elseif not e.counted then
        e.counted = true
        if e.weapon then s.tookWeapon = true end
        table.insert(s.names, e.name)
      end
    end
    -- A transfer that was cut (the reflex clears the queue when it fights or flees) gets one more go.
    if left > 0 and not c.retried then
      c.retried = true
      s.dest = nil
      Act.newLeg(s)
      s.phase = "walk"
      return
    end
    c.done = true
    s.have = Act.carried(p)
    s.phase = "next"
  end
end

-- ---------- DROP ----------
-- Shed weight. The least valuable things go first, until he is back under the line SEARCH stops
-- at. Never the weapon in hand, the best weapon he carries, clothes he wears, a bag, water, food
-- he can eat now or a bandage. It uses the game's own drop (ISInventoryPaneContextMenu.dropItem),
-- so a held item is unequipped first and one in a bag comes out of the bag.
Act.DROP_PASSES = 3

-- Pure. How much a described item is worth keeping; higher stays longer. nil means never drop it.
-- Which things he keeps is a game rule, so it lives here and not in Core.
function Act.keepValue(d)
  if type(d) ~= "table" then return nil end
  if d.held or d.worn or d.container then return nil end
  if (tonumber(d.waterL) or 0) > 0 or d.edible or d.bandage or d.sheet then return nil end
  -- A spare weapon outranks the tools but not the food and medicine, and a better one outranks a worse.
  if Core.isRealWeapon(d.weapon) then return 25 + math.min(weaponScoreOf(d), 100) / 10 end
  for _, row in ipairs(Act.LOOT) do
    if row.key ~= "weapon" and row.key ~= "bag" and Act.IS[row.key](d) then return row.score end
  end
  return 0
end

-- Pure. descs: described items. over: the weight to shed. Returns { index } in the order to drop
-- them, lowest value first and the heaviest first among equals, and stops once enough goes.
function Act.planDrop(descs, over)
  over = tonumber(over) or 0
  local best, bestScore = nil, 0
  for i, d in ipairs(descs or {}) do
    local sc = weaponScoreOf(d)
    if Core.isRealWeapon(d.weapon) and sc > bestScore then best, bestScore = i, sc end
  end
  local cands = {}
  for i, d in ipairs(descs or {}) do
    local value, w = Act.keepValue(d), tonumber(d.weight) or 0
    if value ~= nil and i ~= best and w > 0 then table.insert(cands, { i = i, value = value, w = w }) end
  end
  table.sort(cands, function(a, b)
    if a.value ~= b.value then return a.value < b.value end
    if a.w ~= b.w then return a.w > b.w end
    return a.i < b.i
  end)
  local picks, shed = {}, 0
  for _, c in ipairs(cands) do
    if shed >= over then break end
    table.insert(picks, c.i)
    shed = shed + c.w
  end
  return picks, shed
end

-- What he carries as described items, with the flags planDrop needs, and the game items beside them.
local function dropFacts(p)
  local descs, items = {}, {}
  for _, it in ipairs(LS.Sense.carriedItems(p)) do
    local ok, d = pcall(Act.describeLoot, it, p)
    if ok and d then
      pcall(function() d.held = p:isHandItem(it) == true end)
      pcall(function() d.worn = it:isWorn() == true or p:isEquippedClothing(it) == true end)
      d.container = LS.Sense.itemType(it).bag == true
      table.insert(descs, d)
      table.insert(items, it)
    end
  end
  return descs, items
end

local function endDrop(s, still)
  if #s.names == 0 then return Act.finish(s, "failed", "nothing to drop") end
  local why = Act.droppedText(s.names)
  if still then why = why .. " (still heavy)" end
  Act.finish(s, "done", why)
end

-- Queue one pass of drops. Each pass reads the world again, so a resume after the reflex, or a
-- pass that left him heavy because a bag softened the weight, simply plans the rest.
local function dropPass(p, s)
  local over = -Act.weightLeft(p)
  if over <= 0 then return endDrop(s, false) end
  if s.passes >= Act.DROP_PASSES then return endDrop(s, true) end
  local descs, items = dropFacts(p)
  local picks = Act.planDrop(descs, over)
  if #picks == 0 then return endDrop(s, true) end
  s.passes = s.passes + 1
  s.pending = {}
  ISTimedActionQueue.clear(p)
  local num = 0
  pcall(function() num = p:getPlayerNum() end)
  for _, i in ipairs(picks) do
    ISInventoryPaneContextMenu.dropItem(items[i], num)
    table.insert(s.pending, { it = items[i], name = descs[i].name })
  end
  s.waitTick = LS.tick
  s.phase = "wait"
end

Act.SKILL.DROP = {
  start = function(p, s)
    if Act.weightLeft(p) >= 0 then return Act.finish(s, "failed", "not heavy") end
    LS.hudData.action = "DROP"
    s.names, s.passes = {}, 0
    dropPass(p, s)
  end,
  step = function(p, s)
    if s.phase ~= "wait" then return end
    if Core.queueLength(p) > 0 and LS.tick - s.waitTick < 1800 then return end
    local now = {}
    for _, it in ipairs(LS.Sense.carriedItems(p)) do now[it] = true end
    local gone = 0
    for _, e in ipairs(s.pending) do
      if not now[e.it] then
        gone = gone + 1
        table.insert(s.names, e.name)
      end
    end
    -- Nothing left his hands (a drop the game refused): another pass would plan the same again.
    if gone == 0 then return endDrop(s, true) end
    dropPass(p, s)
  end,
}

-- ---------- ENTER ----------
-- Get into a building by its id from the percept. Doors first (a locked one is unlocked when he
-- carries its key), then a window that opens, and only then a smashed window. A locked door is
-- only found by walking up and trying it.
Act.QUIET_TRIES = 4

function Act.inBuilding(p, id)
  local inside = false
  pcall(function()
    local b = p:getSquare():getBuilding()
    local m = b and LS.Sense.memoFor(b)
    inside = m ~= nil and m.id == id
  end)
  return inside
end

function Act.squareIn(sq, id)
  local yes = false
  pcall(function()
    local b = sq:getBuilding()
    local m = b and LS.Sense.memoFor(b)
    yes = m ~= nil and m.id == id
  end)
  return yes
end

-- Exterior doors (from the place scan) and exterior ground-floor windows of a building.
function Act.buildingWays(m)
  local ways, seen = {}, {}
  local function add(kind, x, y, z)
    local key = kind .. ":" .. x .. "," .. y .. "," .. z
    if seen[key] then return end
    seen[key] = true
    table.insert(ways, { kind = kind, x = x, y = y, z = z })
  end
  if m.doors == nil and (m.doorRetry or 0) <= LS.tick then
    pcall(function()
      local guard = 0
      while not LS.Sense.doorSlice(m, 5000) and guard < 20 do guard = guard + 1 end
    end)
  end
  for _, d in ipairs(m.doors or {}) do add("door", d.x, d.y, d.z or 0) end
  -- A window in the east or south wall belongs to the square past the footprint, as doors do.
  pcall(function()
    local cell = getCell()
    for y = m.y, m.y2 + 1 do
      for x = m.x, m.x2 + 1 do
        local sq = cell:getGridSquare(x, y, 0)
        if sq then
          pcall(function()
            local w = sq:getWindow()
            if w and w:isExterior() then add("window", x, y, 0) end
          end)
        end
      end
    end
  end)
  return ways
end

function Act.wayObject(w)
  local sq = Move.square(w.x, w.y, w.z)
  if not sq then return nil, nil end
  local obj = nil
  pcall(function()
    if w.kind == "door" then obj = sq:getIsoDoor() else obj = sq:getWindow() end
  end)
  return obj, sq
end

-- The square on the building side of a door. A north door sits between y and y - 1, a west
-- one between x and x - 1.
function Act.doorInside(sq, door, id)
  local north = false
  pcall(function() north = door:getNorth() end)
  local x, y, z = sq:getX(), sq:getY(), sq:getZ()
  local other = north and Move.square(x, y - 1, z) or Move.square(x - 1, y, z)
  if Act.squareIn(sq, id) then return sq end
  if other and Act.squareIn(other, id) then return other end
  return nil
end

-- True when the door is shut by a key and he carries the one that fits. This is the test the
-- vanilla unlock action makes (ISLockDoor:isValid): the door's key id against his inventory.
function Act.haveKeyFor(p, door)
  local fits = false
  pcall(function()
    local id = door:checkKeyId()
    fits = id ~= nil and id ~= -1 and p:getInventory():haveThisKeyId(id) ~= nil
  end)
  return fits
end

local function chooseWay(p, s)
  local smashable = false
  for _, w in ipairs(s.ways) do if w.smashable and not w.smashTried then smashable = true end end
  local best, bestD = nil, 99999
  for _, w in ipairs(s.ways) do
    if not w.tried then
      local d = Move.distTo(p, w.x, w.y) - (w.kind == "door" and 2 or 0)
      -- A door he holds the key to beats any window, however far it is.
      if w.kind == "door" then
        local door = Act.wayObject(w)
        if door and Act.haveKeyFor(p, door) then d = d - 1000 end
      end
      if d < bestD then best, bestD = w, d end
    end
  end
  if best and (s.quiet < Act.QUIET_TRIES or not smashable) then
    s.quiet = s.quiet + 1
    s.way, s.smashing = best, nil
  else
    best, bestD = nil, 99999
    for _, w in ipairs(s.ways) do
      if w.smashable and not w.smashTried then
        local d = Move.distTo(p, w.x, w.y)
        if d < bestD then best, bestD = w, d end
      end
    end
    if not best then
      local locked = false
      for _, w in ipairs(s.ways) do if w.tried == "locked" then locked = true end end
      return Act.finish(s, "failed", locked and "locked" or "unreachable")
    end
    best.smashTried = true
    s.way, s.smashing = best, best
  end
  s.tx, s.ty = s.way.x + 0.5, s.way.y + 0.5
  s.dest = nil
  Act.newLeg(s)
  s.phase = "approach"
end

local function tryNext(p, s, why)
  s.way.tried = s.way.tried or why
  chooseWay(p, s)
end

Act.SKILL.ENTER = {
  start = function(p, s)
    local id = s.args.target or ""
    if id == "" then return Act.finish(s, "failed", "no target") end
    s.id = id
    LS.hudData.action = "ENTER " .. id
    if Act.inBuilding(p, id) then return Act.finish(s, "done", "already inside") end
    local m = LS.bldgMemo[id]
    if not m then return Act.finish(s, "failed", "unknown building") end
    s.ways = Act.buildingWays(m)
    if #s.ways == 0 then return Act.finish(s, "failed", "unreachable") end
    s.quiet = 0
    chooseWay(p, s)
  end,
  step = function(p, s)
    if Act.inBuilding(p, s.id) then
      local why = "in by a door"
      if s.how == "window" then why = "in through a window"
      elseif s.how == "smash" then why = "in through a smashed window (loud)" end
      return Act.finish(s, "done", why)
    end
    local w = s.way
    if s.phase == "approach" then
      local obj, sq = Act.wayObject(w)
      if not obj then return tryNext(p, s, "gone") end
      if not s.dest then pcall(function() s.dest = AdjacentFreeTileFinder.FindWindowOrDoor(sq, obj, p) end) end
      if not s.dest then return tryNext(p, s, "unreachable") end
      local r = Act.walkToSquare(p, s, s.dest)
      if r == "arrived" then s.phase = "use"
      elseif r ~= "walking" then tryNext(p, s, r) end
      return
    end
    if s.phase == "use" then
      local obj, sq = Act.wayObject(w)
      if not obj then return tryNext(p, s, "gone") end
      local barricaded = false
      pcall(function() barricaded = obj:isBarricaded() end)
      if barricaded then return tryNext(p, s, "locked") end
      ISTimedActionQueue.clear(p)
      if w.kind == "door" then
        local open, locked = false, false
        pcall(function() open = obj:IsOpen() end)
        pcall(function() locked = obj:isLocked() or obj:isLockedByKey() end)
        local unlock = not open and locked and Act.haveKeyFor(p, obj)
        if not open and locked and not unlock then return tryNext(p, s, "locked") end
        local inside = Act.doorInside(sq, obj, s.id)
        if not inside then return tryNext(p, s, "unreachable") end
        -- The vanilla unlock action, then the door opens like any other. If the key did not
        -- free it, the walk in fails and the next way is tried.
        if unlock then ISTimedActionQueue.add(ISLockDoor:new(p, obj, false)) end
        if not open then ISTimedActionQueue.add(ISOpenCloseDoor:new(p, obj)) end
        Move.walkTo(p, inside)
        s.how = "door"
      else
        local smashed, glassGone, open, locked = false, false, false, false
        pcall(function() smashed = obj:isSmashed() end)
        pcall(function() glassGone = obj:isGlassRemoved() end)
        pcall(function() open = obj:IsOpen() end)
        pcall(function() locked = obj:isLocked() or obj:isPermaLocked() end)
        if s.smashing == w and not smashed then
          ISTimedActionQueue.add(ISSmashWindow:new(p, obj))
          ISTimedActionQueue.add(ISRemoveBrokenGlass:new(p, obj))
          s.how = "smash"
          pcall(function() p:Say("No quiet way in. Breaking the window.") end)
        elseif smashed then
          if not glassGone then ISTimedActionQueue.add(ISRemoveBrokenGlass:new(p, obj)) end
          s.how = s.how == "smash" and "smash" or "window"
        elseif not open then
          if locked then
            w.smashable = true
            return tryNext(p, s, "locked")
          end
          ISTimedActionQueue.add(ISOpenCloseWindow:new(p, obj))
          s.how = "window"
        else
          s.how = "window"
        end
        ISTimedActionQueue.add(ISClimbThroughWindow:new(p, obj, 0))
      end
      s.throughTick = LS.tick
      s.phase = "through"
      Core.trace("enter-use", w.kind .. " " .. tostring(s.how) .. " head=" .. tostring(Move.headType(p))
        .. " at " .. math.floor(p:getX()) .. "," .. math.floor(p:getY()))
      return
    end
    if s.phase == "through" then
      local busy = Core.queueLength(p) > 0
      if busy and LS.tick - s.throughTick < 1200 then return end
      if LS.tick - s.throughTick < 30 then return end
      -- The way did not take him in (the climb was refused, or the walk failed). Next one.
      if s.smashing == w and s.how == "smash" then
        -- Already broken now, so trying it again is the cheapest way in.
        w.smashTried = false
        w.smashable = false
        w.tried = nil
        s.smashing = nil
        s.way = w
        s.dest = nil
        Act.newLeg(s)
        s.phase = "approach"
        return
      end
      local obj = Act.wayObject(w)
      local st = ""
      pcall(function() st = "open=" .. tostring(obj:IsOpen()) .. " smashed=" .. tostring(obj:isSmashed()) end)
      pcall(function() st = st .. " canClimb=" .. tostring(obj:canClimbThrough(p)) end)
      Core.trace("enter-fail", w.kind .. " " .. st .. " busy=" .. tostring(busy) .. " at " .. math.floor(p:getX()) .. "," .. math.floor(p:getY()))
      tryNext(p, s, "failed")
    end
  end,
}

-- ---------- verbs ----------
-- Each verb is function(p, args). args = { seq, action, a, b, say, thought, goal, target }, every
-- field a string ("" when the line left it out). A verb sets LocalSurvivor.lastError to fail.
local verbs = LS.verbs

verbs.MOVE = function(p, args)
  local hud = LS.hudData
  hud.action = "MOVE " .. tostring(args.a) .. "," .. tostring(args.b)
  local px2, py2 = p:getX(), p:getY()
  local qlen = Core.queueLength(p)
  local _, _, _, nd, _, ndx, ndy = LS.Sense.zombieScan(px2, py2)
  -- don't interrupt an in-progress loot: let the item transfers finish so he actually gets what
  -- he said he's grabbing (unless a zombie is right on him, survival wins).
  if (LS.tick - LS.lastLootTick < 400) and qlen > 0 and not (nd >= 0 and nd < 8) then
    hud.thought = "Finishing the grab first."
  else
    local dx, dy = tonumber(args.a) or 0, tonumber(args.b) or 0
    -- A local model will walk back into the zombie it just fled. Point the step away.
    if nd >= 0 and nd < 12 and (dx * ndx + dy * ndy) > 0 then
      local tlen = math.sqrt(ndx * ndx + ndy * ndy)
      if tlen > 0.1 then
        dx = math.floor(-ndx / tlen * 16 + 0.5)
        dy = math.floor(-ndy / tlen * 16 + 0.5)
      else
        dx, dy = -dx, -dy
      end
      hud.thought = "Not that way. That's toward them."
    end
    Move.doMove(p, dx, dy, args.seq)
  end
end
-- EAT and DRINK are registered in Needs.lua.
verbs.EQUIP = function(p, args)
  LS.travel.active = false
  -- Nothing to do is a finished order, not a running one, so the brain can move on.
  if Act.doEquip(p) == "held" then LS.setResult(args.seq, "EQUIP", "done", "already holding the best") end
end
verbs.CLOSEDOOR = function(p) LS.travel.active = false; Act.doCloseDoor(p) end
verbs.CONCEAL = function(p) LS.travel.active = false; Act.doConceal(p) end
verbs.BREAKIN = function(p) LS.travel.active = false; Act.doBreakin(p) end
verbs.STOP = function(p) LS.travel.active = false; ISTimedActionQueue.clear(p) end
-- hold and visibly scan. A running skill keeps going: the current bridge sends WAIT while busy.
verbs.WAIT = function()
  LS.travel.active = false
  if not LS.skill then LS.observing = true end
end
for _, name in ipairs({ "GOTO", "ENTER", "SEARCH", "LOOT", "DROP" }) do
  verbs[name] = function(p, args) Act.startSkill(p, name, args, Act.SKILL[name]) end
end

-- ---------- dispatcher ----------
-- Line format: SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET
function Act.execIntent(p, line)
  local hud = LS.hudData
  local parts = Core.split(line, "|")
  local seq = tonumber(parts[1])
  if not seq or seq <= LS.lastSeq then return end
  LS.lastSeq = seq
  LS.lastError = ""
  local action = parts[2] or "WAIT"
  local args = {
    seq = seq, action = action, a = parts[3], b = parts[4],
    say = parts[5] or "", thought = parts[6] or "", goal = parts[7] or "", target = parts[8] or "",
  }
  if #args.say > 0 then pcall(function() p:Say(args.say) end) end

  -- HUD update (transparency)
  hud.action = action
  hud.say = args.say
  if #args.thought > 0 then hud.thought = args.thought end
  if #args.goal > 0 then hud.goal = args.goal end
  hud.lastIntentTick = LS.tick
  hud.seq = seq

  -- A skill keeps the result record while it runs through a WAIT (or a MOVE mid-grab).
  local keeps = LS.skill ~= nil and (action == "WAIT" or Act.keepsSkill(p, action))
  if LS.skill and not keeps then Act.cancelSkill(p) end
  if not keeps then LS.setResult(seq, action, "running", "") end
  -- An unknown verb is a WAIT, as it always was.
  local verb = LS.verbs[action] or LS.verbs.WAIT
  local ok, err = pcall(verb, p, args)
  if not ok then LS.lastError = "poll:" .. tostring(err) end
  -- A skill that failed at once has already written its own short why.
  local r = LS.result
  if LS.lastError ~= "" and r.seq == seq and r.status == "running" then LS.setResult(seq, action, "failed", LS.lastError) end
  if action ~= "WAIT" then LS.observing = false end
end

function Act.pollIntent(p)
  local ok, err = pcall(function()
    local r = getFileReader("local_intent.txt", false)
    if not r then return end
    local line = r:readLine(); r:close()
    if line and #tostring(line) > 0 then Act.execIntent(p, tostring(line)) end
  end)
  if not ok then LS.lastError = "poll:" .. tostring(err) end
end
