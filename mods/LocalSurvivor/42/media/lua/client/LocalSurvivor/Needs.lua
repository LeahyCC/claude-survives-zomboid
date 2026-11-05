-- The needs that end a run: water, food, sleep, wounds, a bag, a shut house, a breather.
-- Each verb starts a job. A job is a small state machine that LocalSurvivor.onTick steps every
-- 5 ticks. A step reads the world again, queues one vanilla action and waits for the queue to
-- empty, so a job that was paused can pick up where it stopped. See docs/needs.md.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
local LS = LocalSurvivor
LS.Needs = LS.Needs or {}
local Needs = LS.Needs
local Core = LS.Core
local Sense = LS.Sense

-- The running job, or nil. On the namespace so a reload keeps it.
if LS.needsJob == nil then LS.needsJob = false end
-- Switches. lock = true also locks exterior doors during SECURE. Off by default: zombies
-- cannot open doors anyway, and the pathfinder may not walk back out through a locked one.
if LS.needsOpts == nil then LS.needsOpts = { lock = false } end

Needs.N = {
  PAUSE_CLEAR = 30,     -- ticks without a reflex action before a paused job goes on
  PAUSE_MAX = 1200,     -- a pause longer than this fails the job with "zombie"
  BUSY_MAX = 1500,      -- a queued action still running after this is cut off
  STALE = 600,          -- no update for this long (manual mode): the job is dropped
  QUEUED_MAX = 80,      -- actions one job may queue
  SKIPS_MAX = 5,
  SCAN_PER_STEP = 120,  -- squares SECURE reads per step
  SQUARES_MAX = 1500,
  ROOMS_MAX = 10,       -- more rooms than this on the floor: SECURE does the room only
  WATER_SCAN = 8,
  SLEEP_MIN = 0.3,      -- vanilla's "not tired enough" line
  REST_DONE = 0.8,
  REST_MAX = 7200,
}

-- ---------- pure choices ----------
-- These take plain tables, so the tests can drive them without the game.

-- Treatment order from the card: what kills fastest first. Glass alone comes last.
Needs.WOUND_ORDER = { "bleed", "deep", "bite", "lac", "scratch" }

function Needs.woundRank(f)
  for i, k in ipairs(Needs.WOUND_ORDER) do
    if f[k] then return i end
  end
  if f.glass then return #Needs.WOUND_ORDER + 1 end
  return nil
end

-- A clean bandage over a wound is done. Glass and a dirty bandage still need hands on.
function Needs.needsCare(f)
  return f.glass or not f.bandaged or f.dirty
end

-- parts: { {part, bleed, deep, bite, lac, scratch, glass, bandaged, dirty} }. skip: set of part
-- names to leave alone. Returns the index of the worst part that still needs care, or nil.
function Needs.worstWound(parts, skip)
  local best, bestRank, bestName = nil, nil, nil
  for i, f in ipairs(parts or {}) do
    local rank = Needs.woundRank(f)
    local name = tostring(f.part or "?")
    if rank and Needs.needsCare(f) and not (skip and skip[name]) then
      if not best or rank < bestRank or (rank == bestRank and name < bestName) then
        best, bestRank, bestName = i, rank, name
      end
    end
  end
  return best
end

-- One wound, one next step. kit: { bandage, disinfect, rip } as booleans.
-- "keep" means a dirty bandage with nothing clean to swap in: better than an open wound.
function Needs.treatStep(f, kit)
  kit = kit or {}
  if f.glass then return "glass" end
  if f.bandaged then
    if f.dirty and kit.bandage then return "unwrap" end
    return "keep"
  end
  if kit.disinfect and not f.alcohol then return "disinfect" end
  if kit.bandage then return "bandage" end
  if kit.rip then return "rip" end
  return "none"
end

-- items: { {power, dirty, alcohol} }. The strongest clean one, an alcohol one on a tie.
function Needs.bestBandage(items)
  local best, bestPower, bestAlcohol = nil, 0, false
  for i, b in ipairs(items or {}) do
    local power = tonumber(b.power) or 0
    if power > 0 and not b.dirty then
      if not best or power > bestPower or (power == bestPower and b.alcohol and not bestAlcohol) then
        best, bestPower, bestAlcohol = i, power, b.alcohol and true or false
      end
    end
  end
  return best
end

-- foods: { {ready, sealed, canOpen, perishable, left, frozen} }. Ready food first, the one that
-- rots soonest before anything packaged, frozen last. A can only when nothing is ready.
-- Returns index and "ready" or "can", or nil and the reason.
function Needs.chooseFood(foods)
  local best, bestKey, openable, sealed = nil, nil, nil, false
  for i, f in ipairs(foods or {}) do
    if f.ready then
      local group = f.frozen and 3 or (f.perishable and 1 or 2)
      local key = group * 10000000 + (f.perishable and math.max(0, tonumber(f.left) or 0) or 0)
      if not bestKey or key < bestKey then best, bestKey = i, key end
    elseif f.sealed then
      sealed = true
      if f.canOpen and not openable then openable = i end
    end
  end
  if best then return best, "ready" end
  if openable then return openable, "can" end
  if sealed then return nil, "need can opener" end
  return nil, "no food"
end

-- bags: { {cap, red} }, worn: the same for the bag on the back, or nil. Capacity first, then
-- weight reduction. Returns the index of the best bag that beats the worn one, or nil.
function Needs.bestBag(bags, worn)
  local function better(a, b)
    if not b then return true end
    local ac, bc = tonumber(a.cap) or 0, tonumber(b.cap) or 0
    if ac ~= bc then return ac > bc end
    return (tonumber(a.red) or 0) > (tonumber(b.red) or 0)
  end
  local best = nil
  for i, b in ipairs(bags or {}) do
    if better(b, best and bags[best] or worn) then best = i end
  end
  return best
end

-- Distance plus a cost per kind, so a sweep takes what is near but a door beats a lamp.
Needs.NEED_COST = { door = 0, lock = 0, window = 4, curtain = 4, light = 8 }

-- rows: { {need, d} }. Returns the index to do next, or nil.
function Needs.pickTarget(rows)
  local best, bestScore = nil, nil
  for i, r in ipairs(rows or {}) do
    local score = (tonumber(r.d) or 0) + (Needs.NEED_COST[r.need] or 10)
    if not bestScore or score < bestScore then best, bestScore = i, score end
  end
  return best
end

function Needs.secureSummary(counts, skipped)
  counts = counts or {}
  local function n(k) return counts[k] or 0 end
  local function plural(c, word) return c .. " " .. word .. (c == 1 and "" or "s") end
  local closed, parts = {}, {}
  for _, k in ipairs({ "door", "window", "curtain" }) do
    if n(k) > 0 then table.insert(closed, plural(n(k), k)) end
  end
  if #closed > 0 then table.insert(parts, "closed " .. table.concat(closed, ", ")) end
  if n("lock") > 0 then table.insert(parts, "locked " .. plural(n("lock"), "door")) end
  if n("light") > 0 then table.insert(parts, plural(n("light"), "light") .. " off") end
  if #parts == 0 then table.insert(parts, "nothing open") end
  if (skipped or 0) > 0 then table.insert(parts, skipped .. " out of reach") end
  return table.concat(parts, "; ")
end

-- Vanilla's drink-for-thirst amount (thirst x 2 litres), rounded up to the menu's
-- all, half and quarter choices.
function Needs.drinkPercent(thirst, amount)
  amount = tonumber(amount) or 0
  if amount <= 0 then return 1 end
  local want = (tonumber(thirst) or 0) * 2 / amount
  if want > 0.5 then return 1 end
  if want > 0.25 then return 0.5 end
  return 0.25
end

-- Returns "fail", "done" or "sit", and a why.
function Needs.restCheck(endurance, chasing, sat)
  if chasing then return sat and "done" or "fail", "zombie" end
  if (tonumber(endurance) or 0) >= Needs.N.REST_DONE then
    return sat and "done" or "fail", sat and "rested" or "not tired"
  end
  return "sit", ""
end

-- ---------- job engine ----------
local function playerNum(p)
  local n = 0
  pcall(function() n = p:getPlayerNum() end)
  return n
end

local function stat(p, name)
  local v = 0
  pcall(function() v = p:getStats():get(CharacterStat[name]) or 0 end)
  return v
end

local function moodle(p, name)
  local v = 0
  pcall(function() v = p:getMoodles():getMoodleLevel(MoodleType[name]) or 0 end)
  return v
end

local function itemName(it)
  local n = "it"
  pcall(function() n = it:getDisplayName() end)
  return n
end

-- The brain's own thought for an order goes on the HUD first, so a job only speaks after that.
local function think(job, text)
  if job and LS.tick ~= job.startTick and text and text ~= "" then LS.hudData.thought = text end
end

function Needs.done(job, why)
  LS.setResult(job.seq, job.verb, "done", why or "")
  if LS.needsJob == job then LS.needsJob = false end
  think(job, why)
end

function Needs.fail(job, why)
  LS.setResult(job.seq, job.verb, "failed", why or "")
  LS.lastError = why or ""
  if LS.needsJob == job then LS.needsJob = false end
end

-- Call right after queueing. A vanilla helper that found no way there queues nothing, and
-- that has to read as a failure, not as a finished action. onDone runs only when the queue
-- empties on its own, so an action the reflex cut off is done again instead of counted.
function Needs.queued(p, job, maxTicks, onDone)
  if Core.queueLength(p) == 0 then return false end
  job.busy, job.busySince, job.busyMax = true, LS.tick, maxTicks or Needs.N.BUSY_MAX
  job.onDone, job.cut = onDone, false
  job.queuedCount = job.queuedCount + 1
  if job.queuedCount > Needs.N.QUEUED_MAX then
    Needs.fail(job, "stuck")
    return true
  end
  return true
end

function Needs.step(p, job)
  local skill = Needs.skills[job.verb]
  local ok, err = pcall(skill, p, job)
  if not ok and LS.needsJob == job then Needs.fail(job, "error: " .. tostring(err)) end
end

-- Start a job from a verb. The bridge may repeat an order while it still wants it, so the same
-- verb again keeps the job going under the new seq instead of starting over.
function Needs.start(p, args, verb)
  LS.travel.active = false
  local job = LS.needsJob
  if job and job.verb == verb then
    job.seq = args.seq
    job.lastUpdate = LS.tick
    return
  end
  job = { verb = verb, seq = args.seq, startTick = LS.tick, lastUpdate = LS.tick, lastActed = -99999,
    queuedCount = 0, busy = false }
  LS.needsJob = job
  LS.hudData.action = verb
  Needs.step(p, job)
end

-- Every 5 ticks from onTick, with what the reflex did on this tick. The reflex owns the queue
-- while it acts, so a paused job never touches it.
function Needs.update(p, acted)
  local job = LS.needsJob
  if not job then return end
  local tick = LS.tick
  local r = LS.result
  if r.seq ~= job.seq or r.status ~= "running" then
    LS.needsJob = false
    return
  end
  if tick - job.lastUpdate > Needs.N.STALE then return Needs.fail(job, "interrupted") end
  job.lastUpdate = tick
  if acted then
    job.lastActed = tick
    job.pausedAt = job.pausedAt or tick
    if job.busy then job.cut = true end
    return
  end
  if job.pausedAt then
    if tick - job.pausedAt > Needs.N.PAUSE_MAX then return Needs.fail(job, "zombie") end
    if tick - job.lastActed < Needs.N.PAUSE_CLEAR then return end
    job.pausedAt = nil
    -- The reflex left the action queued, so it was not cut off after all.
    if job.busy and Core.queueLength(p) > 0 then job.cut = false end
  end
  if job.busy then
    local q = Core.queueLength(p)
    if q > 0 and tick - job.busySince < job.busyMax then return end
    if q > 0 then ISTimedActionQueue.clear(p) end
    job.busy = false
    local onDone = job.onDone
    job.onDone = nil
    if onDone and q == 0 and not job.cut then onDone() end
    job.cut = false
  end
  Needs.step(p, job)
end

-- True while a job's action is running in place. Reflex.releaseDoor reads a body that stands
-- still with a queue as stuck on a door, and would cut off eating or bandaging.
function Needs.holdsSpot(p)
  local job = LS.needsJob
  if not job or not job.busy then return false end
  local inPlace = false
  pcall(function()
    local q = ISTimedActionQueue.getTimedActionQueue(p)
    local head = q and q.queue and q.queue[1]
    if head then
      local t = head.Type
      inPlace = t ~= "ISWalkToTimedAction" and t ~= "ISPathFindAction"
    end
  end)
  return inPlace
end

-- ---------- world readers ----------
local function squareKey(sq)
  local key = nil
  pcall(function() key = sq:getX() .. "," .. sq:getY() .. "," .. sq:getZ() end)
  return key
end

local function distTo(p, x, y, z)
  local dx, dy = x - p:getX(), y - p:getY()
  local dz = math.abs((z or 0) - math.floor(p:getZ()))
  return math.sqrt(dx * dx + dy * dy) + dz * 10
end

-- Clean water objects in the building he is in, nearest first: { {obj, d} }. The place scan
-- keeps them in the building memo. Before it reaches this building, look at nearby squares.
function Needs.waterSources(p)
  local objs = {}
  local _, m = Sense.currentBuilding(p)
  if m and m.waterObjs then
    for _, o in ipairs(m.waterObjs) do table.insert(objs, o) end
  end
  if #objs == 0 and m then
    pcall(function()
      local home = p:getSquare():getBuilding()
      local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
      local r = Needs.N.WATER_SCAN
      for dx = -r, r do
        for dy = -r, r do
          local sq = getCell():getGridSquare(px + dx, py + dy, pz)
          if sq and sq:getBuilding() == home then
            local list = sq:getObjects()
            for i = 0, list:size() - 1 do
              local o = list:get(i)
              pcall(function() if o:hasWater() then table.insert(objs, o) end end)
            end
          end
        end
      end
    end)
  end
  local out, seen = {}, {}
  for _, o in ipairs(objs) do
    pcall(function()
      if o:getFluidAmount() >= 1 and not o:isTaintedWater() then
        local sq = o:getSquare()
        local key = squareKey(sq)
        if key and not seen[key] then
          seen[key] = true
          table.insert(out, { obj = o, d = distTo(p, sq:getX(), sq:getY(), sq:getZ()) })
        end
      end
    end)
  end
  table.sort(out, function(a, b) return a.d < b.d end)
  return out
end

function Needs.waterBottle(p)
  for _, it in ipairs(Sense.carriedItems(p)) do
    local ok = false
    pcall(function() ok = Core.isWaterItem(it) and not it:getFluidContainer():isPoisonous() end)
    if ok then return it end
  end
  return nil
end

-- Containers that can take clean water: empty, or holding only water and not full.
function Needs.fillable(p)
  local out = {}
  for _, it in ipairs(Sense.carriedItems(p)) do
    pcall(function()
      local fc = it:getFluidContainer()
      if not fc or fc:isInputLocked() or fc:isFull() then return end
      if not fc:canAddFluid(Fluid.Water) then return end
      if fc:isEmpty() or fc:getSpecificFluidAmount(Fluid.Water) + 0.001 >= fc:getAmount() then
        table.insert(out, it)
      end
    end)
  end
  return out
end

-- The craft recipe when the game says he can do it on this item now, else nil. The same test
-- vanilla runs before it offers "Open and eat", so a missing can opener shows up here.
function Needs.craftRecipe(p, name, it)
  local recipe = nil
  pcall(function()
    local r = getScriptManager():getCraftRecipe(name)
    if not r then return end
    local logic = HandcraftLogic.new(p, nil, nil)
    logic:setContainers(ISInventoryPaneContextMenu.getContainers(p))
    logic:setRecipeFromContextClick(r, it)
    if logic:canPerformCurrentRecipe() then recipe = r end
  end)
  return recipe
end

function Needs.openingRecipe(p, it)
  local name = nil
  pcall(function() name = it:getOpeningRecipe() end)
  if not name or name == "" then return nil end
  return Needs.craftRecipe(p, name, it)
end

function Needs.describeFood(it, p)
  local f = { ready = Core.isEdible(it, p), sealed = false, perishable = false, left = 0, frozen = false }
  if not f.ready then f.sealed = Core.isSealedFood(it) end
  pcall(function()
    local max = it:getOffAgeMax()
    -- Food that never rots has an off age of a billion days.
    if max and max < 1000000 then f.perishable, f.left = true, max - it:getAge() end
  end)
  pcall(function() f.frozen = it:isFrozen() == true end)
  return f
end

function Needs.woundFacts(p)
  local out = {}
  pcall(function()
    local parts = p:getBodyDamage():getBodyParts()
    for i = 0, parts:size() - 1 do
      local bp = parts:get(i)
      local f = { bp = bp, part = "?" }
      pcall(function() f.part = BodyPartType.ToString(bp:getType()) end)
      pcall(function() f.bleed = bp:bleeding() end)
      pcall(function() f.deep = bp:deepWounded() end)
      pcall(function() f.bite = bp:bitten() end)
      pcall(function() f.lac = bp:isCut() end)
      pcall(function() f.scratch = bp:scratched() end)
      pcall(function() f.glass = bp:haveGlass() end)
      pcall(function() f.bandaged = bp:bandaged() end)
      pcall(function() f.dirty = bp:isBandageDirty() end)
      pcall(function() f.alcohol = bp:getAlcoholLevel() > 0 end)
      table.insert(out, f)
    end
  end)
  return out
end

local function hasTag(it, name)
  local yes = false
  pcall(function() yes = it:hasTag(ItemTag[name]) == true end)
  return yes
end

local function isWorn(p, it)
  local worn = false
  pcall(function() worn = it:isWorn() or p:isEquippedClothing(it) end)
  return worn
end

-- What he carries for wounds. Ripping is only looked for when there is no bandage, because
-- the recipe check is the slow part.
function Needs.medKit(p)
  local kit = {}
  local bandages, refs = {}, {}
  for _, it in ipairs(Sense.carriedItems(p)) do
    local power = 0
    pcall(function() power = it:getBandagePower() or 0 end)
    if power > 0 then
      local full = ""
      pcall(function() full = it:getFullType() end)
      table.insert(bandages, { power = power, dirty = hasTag(it, "CAN_BE_WASHED"), alcohol = full:find("Alcohol", 1, true) ~= nil })
      table.insert(refs, it)
    end
    if not kit.disinfect then
      local ok, d = pcall(Sense.describeItem, it, p)
      if ok and d and d.disinfect then kit.disinfect = it end
    end
    if not kit.tweezers then
      local t = ""
      pcall(function() t = it:getType() end)
      if hasTag(it, "REMOVE_GLASS") or t == "Tweezers" or t == "SutureNeedleHolder" then kit.tweezers = it end
    end
  end
  local i = Needs.bestBandage(bandages)
  if i then kit.bandage = refs[i] end
  if not kit.bandage then
    for _, it in ipairs(Sense.carriedItems(p)) do
      local recipeName = nil
      if hasTag(it, "SHEET") then recipeName = "RipSheets"
      elseif hasTag(it, "RIP_CLOTHING_COTTON") and not isWorn(p, it) then recipeName = "RipClothing" end
      if recipeName then
        local r = Needs.craftRecipe(p, recipeName, it)
        if r then kit.rip = { item = it, recipe = r }; break end
      end
    end
  end
  return kit
end

-- The nearest bed object in the building, or nil for the floor.
function Needs.findBed(p)
  local spots = {}
  local _, m = Sense.currentBuilding(p)
  if m and m.beds then
    for _, s in ipairs(m.beds) do table.insert(spots, s) end
  end
  if #spots == 0 then
    pcall(function()
      local squares = p:getSquare():getRoom():getSquares()
      for i = 0, squares:size() - 1 do
        local sq = squares:get(i)
        local objs = sq:getObjects()
        for j = 0, objs:size() - 1 do
          local ok, isBed = pcall(function() return objs:get(j):getProperties():has(IsoFlagType.bed) end)
          if ok and isBed then table.insert(spots, { x = sq:getX(), y = sq:getY(), z = sq:getZ() }) end
        end
      end
    end)
  end
  table.sort(spots, function(a, b) return distTo(p, a.x, a.y, a.z) < distTo(p, b.x, b.y, b.z) end)
  for _, s in ipairs(spots) do
    local bed = nil
    pcall(function()
      local objs = getCell():getGridSquare(s.x, s.y, s.z):getObjects()
      for j = 0, objs:size() - 1 do
        local o = objs:get(j)
        if not bed and o:getProperties():has(IsoFlagType.bed) then bed = o end
      end
    end)
    if bed then return bed end
  end
  return nil
end

function Needs.nextTo(p, obj)
  local near = false
  pcall(function() near = AdjacentFreeTileFinder.isTileOrAdjacent(p:getCurrentSquare(), obj:getSquare()) end)
  return near
end

function Needs.chasing(p)
  local n = 0
  pcall(function() n = p:getStats():getNumChasingZombies() end)
  if n > 0 then return true end
  for _, z in ipairs(Sense.zombieFacts(p, p:getX(), p:getY())) do
    if z.chase and z.dx * z.dx + z.dy * z.dy <= 400 then return true end
  end
  return false
end

-- The same tests vanilla runs in onSleepWalkToComplete, so a failed sleep can say why.
function Needs.sleepBlock(p)
  local zombies = false
  pcall(function()
    local st = p:getStats()
    zombies = st:getNumVisibleZombies() > 0 or st:getNumChasingZombies() > 0 or st:getNumVeryCloseZombies() > 0
  end)
  if zombies then return "unsafe: zombies" end
  if moodle(p, "PANIC") >= 1 then return "unsafe: panic" end
  if moodle(p, "PAIN") >= 2 and stat(p, "FATIGUE") <= 0.85 then return "unsafe: pain" end
  return "unsafe"
end

-- ---------- SECURE engine ----------
-- Squares of the room, or of every room on his floor when the building is small. A wall sits
-- on the north or west edge of a square, so the squares one east and one south are read too.
function Needs.secureSquares(p, scope)
  local rooms = {}
  local pz = math.floor(p:getZ())
  local here = nil
  pcall(function() here = p:getSquare():getRoom() end)
  if not here then return {}, "none" end
  if scope ~= "room" then
    pcall(function()
      local list = p:getSquare():getBuilding():getDef():getRooms()
      for i = 0, list:size() - 1 do
        local rd = list:get(i)
        if rd:getZ() == pz then
          local room = rd:getIsoRoom()
          if room then table.insert(rooms, room) end
        end
      end
    end)
    if #rooms == 0 or #rooms > Needs.N.ROOMS_MAX then rooms = {} end
  end
  if #rooms == 0 then rooms, scope = { here }, "room" else scope = "building" end
  local out, seen = {}, {}
  local cell = getCell()
  local function add(sq)
    if not sq or #out >= Needs.N.SQUARES_MAX then return end
    local key = squareKey(sq)
    if key and not seen[key] then seen[key] = true; table.insert(out, sq) end
  end
  for _, room in ipairs(rooms) do
    pcall(function()
      local squares = room:getSquares()
      for i = 0, squares:size() - 1 do
        local sq = squares:get(i)
        add(sq)
        pcall(function() add(cell:getGridSquare(sq:getX() + 1, sq:getY(), sq:getZ())) end)
        pcall(function() add(cell:getGridSquare(sq:getX(), sq:getY() + 1, sq:getZ())) end)
      end
    end)
  end
  return out, scope
end

function Needs.secureBegin(p, scope)
  local sec = { counts = {}, skipped = 0, targets = {}, seen = {}, i = 1 }
  sec.squares, sec.scope = Needs.secureSquares(p, scope)
  return sec
end

local function addTarget(sec, kind, o)
  local key = kind .. tostring(o)
  if sec.seen[key] then return end
  sec.seen[key] = true
  local x, y, z = 0, 0, 0
  pcall(function() local sq = o:getSquare(); x, y, z = sq:getX(), sq:getY(), sq:getZ() end)
  table.insert(sec.targets, { kind = kind, obj = o, x = x, y = y, z = z, tries = 0 })
end

function Needs.collectTargets(sq, sec)
  pcall(function()
    local objs = sq:getObjects()
    for i = 0, objs:size() - 1 do
      local o = objs:get(i)
      if instanceof(o, "IsoDoor") then addTarget(sec, "door", o)
      elseif instanceof(o, "IsoWindow") then
        addTarget(sec, "window", o)
        pcall(function()
          local c = o:HasCurtains()
          if c then addTarget(sec, "curtain", c) end
        end)
      elseif instanceof(o, "IsoCurtain") then addTarget(sec, "curtain", o)
      elseif instanceof(o, "IsoLightSwitch") then addTarget(sec, "light", o) end
    end
  end)
end

-- ISLockDoor:isValid: his key, or standing indoors, and no custom lock.
function Needs.canLock(p, door)
  local ok = false
  pcall(function()
    local md = door:getModData()
    if md and md.CustomLock then return end
    if p:getInventory():haveThisKeyId(door:checkKeyId()) then ok = true; return end
    ok = not p:getCurrentSquare():has(IsoFlagType.exterior)
  end)
  return ok
end

-- What a target still needs, or nil.
function Needs.targetNeed(p, t)
  local o, need = t.obj, nil
  pcall(function()
    if t.kind == "door" then
      if o:IsOpen() then need = "door"; return end
      local curtain = false
      pcall(function() curtain = o:HasCurtains() ~= nil and o:isCurtainOpen() end)
      if curtain then need = "curtain"; return end
      if LS.needsOpts.lock and o:isExterior() and not o:isLocked() and not o:isLockedByKey() and Needs.canLock(p, o) then
        need = "lock"
      end
    elseif t.kind == "window" then
      if o:IsOpen() and not o:isSmashed() and not o:isDestroyed() and not o:isBarricaded() then need = "window" end
    elseif t.kind == "curtain" then
      if o:IsOpen() then need = "curtain" end
    elseif t.kind == "light" then
      if o:isActivated() and o:canSwitchLight() then need = "light" end
    end
  end)
  return need
end

-- The vanilla menu handlers walk to the object and queue the action.
function Needs.doTarget(p, t, need)
  local pn, o = playerNum(p), t.obj
  if need == "door" then ISWorldObjectContextMenu.onOpenCloseDoor(nil, o, pn)
  elseif need == "lock" then ISWorldObjectContextMenu.onLockDoor(nil, pn, o)
  elseif need == "curtain" then ISWorldObjectContextMenu.onOpenCloseCurtain(nil, o, pn)
  elseif need == "window" then ISWorldObjectContextMenu.onOpenCloseWindow(nil, o, pn)
  elseif need == "light" then ISWorldObjectContextMenu.onToggleLight(nil, o, pn) end
end

-- One step of a sweep. Returns "scan" (more to do next step), "busy" (an action is queued)
-- or "done".
function Needs.secureStep(p, job, sec)
  if sec.i <= #sec.squares then
    local last = math.min(#sec.squares, sec.i + Needs.N.SCAN_PER_STEP - 1)
    for k = sec.i, last do Needs.collectTargets(sec.squares[k], sec) end
    sec.i = last + 1
    return "scan"
  end
  if sec.last then
    local t, need = sec.last.t, sec.last.need
    if Needs.targetNeed(p, t) ~= need then
      sec.counts[need] = (sec.counts[need] or 0) + 1
    else
      t.tries = t.tries + 1
      if t.tries >= 2 then t.skip = true; sec.skipped = sec.skipped + 1 end
    end
    sec.last = nil
  end
  local rows, pick = {}, {}
  local pz = math.floor(p:getZ())
  for _, t in ipairs(sec.targets) do
    if not t.skip and t.z == pz then
      local need = Needs.targetNeed(p, t)
      if need then
        table.insert(rows, { need = need, d = distTo(p, t.x + 0.5, t.y + 0.5, t.z) })
        table.insert(pick, { t = t, need = need })
      end
    end
  end
  local i = Needs.pickTarget(rows)
  if not i then return "done" end
  local t, need = pick[i].t, pick[i].need
  ISTimedActionQueue.clear(p)
  Needs.doTarget(p, t, need)
  if Needs.queued(p, job) then
    sec.last = { t = t, need = need }
    return "busy"
  end
  t.skip = true
  sec.skipped = sec.skipped + 1
  return "scan"
end

-- ---------- skills ----------
-- Each is function(p, job). It reads the world, then either queues one thing (Needs.queued),
-- finishes the job (Needs.done / Needs.fail), or returns to be stepped again.
Needs.skills = Needs.skills or {}
local skills = Needs.skills

skills.DRINK = function(p, job)
  if job.drank then return Needs.done(job, job.drank) end
  local pn = playerNum(p)
  local bottle = Needs.waterBottle(p)
  if bottle then
    ISTimedActionQueue.clear(p)
    ISInventoryPaneContextMenu.transferIfNeeded(p, bottle)
    local amount = 1
    pcall(function() amount = bottle:getFluidContainer():getAmount() end)
    local mask = ISInventoryPaneContextMenu.getEatingMask(p, true)
    ISTimedActionQueue.add(ISDrinkFluidAction:new(p, bottle, Needs.drinkPercent(stat(p, "THIRST"), amount)))
    if mask then ISTimedActionQueue.add(ISWearClothing:new(p, mask, 50)) end
    local label = "drank from " .. itemName(bottle)
    if Needs.queued(p, job, nil, function() job.drank = label end) then
      think(job, "Water. Drinking.")
      return
    end
  end
  local src = Needs.waterSources(p)[1]
  if not src then return Needs.fail(job, "no water") end
  ISTimedActionQueue.clear(p)
  ISWorldObjectContextMenu.onDrink(nil, src.obj, pn)
  if Needs.queued(p, job, nil, function() job.drank = "drank from the tap" end) then
    think(job, "Tap still runs. Drinking.")
    return
  end
  Needs.fail(job, "cannot reach water")
end

skills.FILL = function(p, job)
  job.filled = job.filled or {}
  local count = 0
  for _ in pairs(job.filled) do count = count + 1 end
  local empties = Needs.fillable(p)
  if #empties == 0 then
    if count > 0 then return Needs.done(job, "filled " .. count) end
    return Needs.fail(job, "no empty bottle")
  end
  local src = Needs.waterSources(p)[1]
  if not src then
    if count > 0 then return Needs.done(job, "filled " .. count .. ", source dry") end
    return Needs.fail(job, "no water")
  end
  if (job.rounds or 0) >= 3 then return Needs.done(job, "filled " .. count) end
  ISTimedActionQueue.clear(p)
  ISWorldObjectContextMenu.onTakeWater(nil, src.obj, empties, nil, playerNum(p))
  job.rounds = (job.rounds or 0) + 1
  if Needs.queued(p, job, nil, function() for _, it in ipairs(empties) do job.filled[tostring(it)] = true end end) then
    think(job, "Filling bottles while the water runs.")
    return
  end
  Needs.fail(job, "cannot reach water")
end

skills.EAT = function(p, job)
  if job.ate then return Needs.done(job, job.ate) end
  if moodle(p, "FOOD_EATEN") >= 3 then return Needs.fail(job, "too full") end
  job.skip = job.skip or {}
  local foods, refs = {}, {}
  for _, it in ipairs(Sense.carriedItems(p)) do
    if Core.isFoodItem(it) and not job.skip[tostring(it)] then
      table.insert(foods, Needs.describeFood(it, p))
      table.insert(refs, it)
    end
  end
  local i, kind = Needs.chooseFood(foods)
  if not i then
    -- The recipe check is slow. Only cans that would be eaten pay for it.
    local opened = 0
    for k, f in ipairs(foods) do
      if f.sealed and opened < 5 then
        opened = opened + 1
        f.recipe = Needs.openingRecipe(p, refs[k])
        f.canOpen = f.recipe ~= nil
      end
    end
    i, kind = Needs.chooseFood(foods)
  end
  if not i then return Needs.fail(job, kind) end
  local it = refs[i]
  ISTimedActionQueue.clear(p)
  if kind == "can" then
    ISInventoryPaneContextMenu.eatItem(it, 1, playerNum(p), foods[i].recipe, 100)
  else
    ISInventoryPaneContextMenu.eatItem(it, 1, playerNum(p))
  end
  local label = (kind == "can" and "opened and ate " or "ate ") .. itemName(it)
  if Needs.queued(p, job, nil, function() job.ate = label end) then
    think(job, "Eating " .. itemName(it) .. ".")
    return
  end
  -- Vanilla refused this one (it needs something he lacks). Try the next on the next step.
  job.skip[tostring(it)] = true
  job.skips = (job.skips or 0) + 1
  if job.skips >= Needs.N.SKIPS_MAX then Needs.fail(job, "cannot eat") end
end

skills.SLEEP = function(p, job)
  local asleep = false
  pcall(function() asleep = p:isAsleep() end)
  if asleep then return Needs.done(job, "asleep") end
  local pn = playerNum(p)
  if not job.phase then
    if stat(p, "FATIGUE") <= Needs.N.SLEEP_MIN then return Needs.fail(job, "not tired") end
    local soon = false
    pcall(function() soon = p:getHoursSurvived() - p:getLastHourSleeped() <= 1 end)
    if soon then return Needs.fail(job, "too soon") end
    local block = Needs.sleepBlock(p)
    if block == "unsafe: panic" or block == "unsafe: pain" then return Needs.fail(job, block) end
    job.bed = Needs.findBed(p)
    job.phase, job.walks = "walk", 0
    think(job, job.bed and "Bed. Shut the room first." or "No bed. The floor will do.")
  end
  if job.phase == "walk" then
    if job.bed and not Needs.nextTo(p, job.bed) and job.walks < 3 then
      job.walks = job.walks + 1
      ISTimedActionQueue.clear(p)
      local ok = false
      pcall(function() ok = luautils.walkAdj(p, job.bed:getSquare(), true) end)
      if ok and Needs.queued(p, job) then return end
      if not ok then job.bed = nil end
    end
    job.phase, job.sec = "secure", Needs.secureBegin(p, "room")
  end
  if job.phase == "secure" then
    if Needs.secureStep(p, job, job.sec) ~= "done" then return end
    job.phase, job.walks = "lie", 0
  end
  if job.bed and not Needs.nextTo(p, job.bed) and job.walks < 2 then
    job.walks = job.walks + 1
    ISTimedActionQueue.clear(p)
    local ok = false
    pcall(function() ok = luautils.walkAdj(p, job.bed:getSquare(), true) end)
    if ok and Needs.queued(p, job) then return end
    -- walkAdj also counts a diagonal across the bed as close enough, as vanilla does. Only no
    -- way there at all means the floor.
    if not ok then job.bed = nil end
  end
  -- onConfirmSleep sets these before it calls onSleepWalkToComplete, which returns early
  -- while ExerciseEnded is false.
  pcall(function() p:setVariable("ExerciseStarted", false); p:setVariable("ExerciseEnded", true) end)
  ISWorldObjectContextMenu.onSleepWalkToComplete(pn, job.bed)
  pcall(function() asleep = p:isAsleep() end)
  if asleep then return Needs.done(job, job.bed and "asleep in bed" or "asleep on the floor") end
  Needs.fail(job, Needs.sleepBlock(p))
end

skills.BANDAGE = function(p, job)
  job.treated, job.tries, job.skipParts, job.notes = job.treated or 0, job.tries or {}, job.skipParts or {}, job.notes or {}
  local function why(base)
    local parts = { base }
    if job.treated > 0 and base ~= "treated " .. job.treated then table.insert(parts, "treated " .. job.treated) end
    for _, n in ipairs(job.notes) do table.insert(parts, n) end
    return table.concat(parts, ", ")
  end
  local parts = Needs.woundFacts(p)
  local i = Needs.worstWound(parts, job.skipParts)
  if not i then
    if job.treated > 0 or #job.notes > 0 then return Needs.done(job, why("treated " .. job.treated)) end
    return Needs.done(job, "no wounds")
  end
  local f = parts[i]
  local kit = Needs.medKit(p)
  local stepName = Needs.treatStep(f, { bandage = kit.bandage ~= nil, disinfect = kit.disinfect ~= nil, rip = kit.rip ~= nil })
  if stepName == "keep" then job.skipParts[f.part] = true; return end
  if stepName == "none" then return Needs.fail(job, why("no bandage")) end
  local key = f.part .. ":" .. stepName
  job.tries[key] = (job.tries[key] or 0) + 1
  if job.tries[key] > 2 then
    job.skipParts[f.part] = true
    table.insert(job.notes, f.part .. " " .. stepName .. " did not take")
    return
  end
  ISTimedActionQueue.clear(p)
  if stepName == "glass" then
    if kit.tweezers then ISInventoryPaneContextMenu.transferIfNeeded(p, kit.tweezers) end
    ISTimedActionQueue.add(ISRemoveGlass:new(p, p, f.bp, kit.tweezers == nil))
    if not kit.tweezers and job.tries[key] == 1 then table.insert(job.notes, "glass out by hand") end
  elseif stepName == "unwrap" then
    ISTimedActionQueue.add(ISApplyBandage:new(p, p, nil, f.bp, false))
  elseif stepName == "disinfect" then
    ISInventoryPaneContextMenu.transferIfNeeded(p, kit.disinfect)
    ISTimedActionQueue.add(ISDisinfect:new(p, p, kit.disinfect, f.bp))
  elseif stepName == "bandage" then
    ISInventoryPaneContextMenu.transferIfNeeded(p, kit.bandage)
    ISTimedActionQueue.add(ISApplyBandage:new(p, p, kit.bandage, f.bp, true))
  elseif stepName == "rip" then
    ISInventoryPaneContextMenu.OnNewCraft(kit.rip.item, kit.rip.recipe, playerNum(p), false)
  end
  think(job, stepName == "rip" and "No bandage. Ripping cloth." or ("Treating " .. f.part .. "."))
  local onDone = nil
  if stepName == "bandage" then onDone = function() job.treated = job.treated + 1 end end
  if not Needs.queued(p, job, nil, onDone) then
    job.skipParts[f.part] = true
    table.insert(job.notes, f.part .. " " .. stepName .. " refused")
  end
end

skills.WEARBAG = function(p, job)
  local worn = nil
  pcall(function() worn = p:getClothingItem_Back() end)
  local function id(it)
    local v = nil
    if it then pcall(function() v = it:getID() end) end
    return v
  end
  if job.target then
    if worn and id(worn) == id(job.target) then return Needs.done(job, "wearing " .. itemName(worn)) end
    return Needs.fail(job, "could not wear it")
  end
  local function describe(it)
    local d = { cap = 0, red = 0 }
    pcall(function() d.cap = it:getCapacity() end)
    pcall(function() d.red = it:getWeightReduction() end)
    return d
  end
  local bags, refs = {}, {}
  for _, it in ipairs(Sense.carriedItems(p)) do
    local back = false
    pcall(function() back = it:IsInventoryContainer() and it:canBeEquipped() == ItemBodyLocation.BACK end)
    if back and id(it) ~= id(worn) then
      table.insert(bags, describe(it))
      table.insert(refs, it)
    end
  end
  local i = Needs.bestBag(bags, worn and describe(worn) or nil)
  if not i then
    if worn then return Needs.done(job, "already wearing " .. itemName(worn)) end
    return Needs.fail(job, "no bag")
  end
  ISTimedActionQueue.clear(p)
  ISInventoryPaneContextMenu.wearItem(refs[i], playerNum(p))
  local bag = refs[i]
  if Needs.queued(p, job, nil, function() job.target = bag end) then
    think(job, "Bag on. Hands free.")
    return
  end
  Needs.fail(job, "could not wear it")
end

skills.SECURE = function(p, job)
  if not job.sec then
    job.sec = Needs.secureBegin(p, "building")
    if #job.sec.squares == 0 then return Needs.fail(job, "not inside") end
    think(job, "Shutting the place up.")
  end
  if Needs.secureStep(p, job, job.sec) == "done" then
    Needs.done(job, Needs.secureSummary(job.sec.counts, job.sec.skipped))
  end
end

skills.REST = function(p, job)
  local status, why = Needs.restCheck(stat(p, "ENDURANCE"), Needs.chasing(p), job.sat)
  if status == "fail" then return Needs.fail(job, why) end
  if status == "done" then return Needs.done(job, why) end
  if LS.tick - job.startTick > Needs.N.REST_MAX then return Needs.done(job, "rested a while") end
  local sitting = false
  pcall(function() sitting = p:isSitOnGround() end)
  if sitting then return end
  job.sits = (job.sits or 0) + 1
  if job.sits > 3 then return Needs.fail(job, "cannot sit") end
  ISTimedActionQueue.clear(p)
  ISTimedActionQueue.add(ISSitOnGround:new(p))
  Needs.queued(p, job, 300)
  job.sat = true
  think(job, "Catching my breath.")
end

-- ---------- verbs ----------
for _, verb in ipairs({ "DRINK", "FILL", "EAT", "SLEEP", "BANDAGE", "WEARBAG", "SECURE", "REST" }) do
  LS.verbs[verb] = function(p, args) Needs.start(p, args, verb) end
end
