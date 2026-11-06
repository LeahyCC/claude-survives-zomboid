-- The needs that end a run: water, food, sleep, wounds, a bag, a shut house, a breather.
-- Each verb starts a job. A job is a small state machine that LocalSurvivor.onTick steps every
-- 5 ticks. A step reads the world again, queues one vanilla action and waits for the queue to
-- empty, so a job that was paused can pick up where it stopped. See docs/needs.md.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
require "LocalSurvivor/Move"
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
  BACK_R = 4,           -- out of the house by more than this many tiles: SECURE does not walk back
  BACKS_MAX = 2,        -- walks back in during one SECURE before it fails "not inside"
  LEGS_MAX = 20,        -- legs of an inside walk to one target
  WATER_SCAN = 8,
  SLEEP_MIN = 0.3,      -- vanilla's "not tired enough" line
  REST_DONE = 0.8,
  REST_MAX = 7200,
  CLEAR_MAX = 3600,     -- ticks one CLEAR may take, the fight included (a minute)
  CLEAR_HIT = 1.5,      -- tiles: close enough to swing, the reflex's own bite line (Stance.N.BITE)
  CLEAR_LEG = 600,      -- a leg of the walk still going after this many ticks is cut
  CLEAR_CHASE_R = 15,   -- a chaser outside the house counts as woken this close (REACH_CHASE_R in senses.mjs)
  STASH_BOXES = 2,      -- containers one stash may fill
  STASH_ROOM = 0.6,     -- share of the carry limit she sheds past the search line, so there is room to search
  STASH_FOOD = 2,       -- hunger she keeps food for. A day is about 1, a guide number: 3 meals of about 0.3
  STASH_TRIES = 2,      -- transfers of one item before it is left on her
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

-- One wound, one next step. kit: { bandage, disinfect, rip, strip } as booleans. strip means the
-- only cloth is worn, so it comes off first and is ripped on the next pass.
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
  if kit.strip then return "strip" end
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

-- rows: { {d, inside, level, chase, current} }, the zombies in the house and any chaser near. level
-- is on her floor, current is the one the order is after. Returns "woke", "floor", "none", or "go"
-- and the index to go for. The one she is after may turn on her: that is the reflex's fight and the
-- order carries on. Anyone else after her is the order's end, however it stands.
function Needs.clearPick(rows)
  local cur, best, upstairs, chasers = nil, nil, false, 0
  for i, z in ipairs(rows or {}) do
    if z.current and z.inside and z.level then cur = i end
  end
  for i, z in ipairs(rows or {}) do
    if z.chase and i ~= cur then chasers = chasers + 1 end
    if z.inside and not z.level then
      upstairs = true
    elseif z.inside then
      local b = best and rows[best]
      local zc, bc = z.chase and 1 or 0, b and b.chase and 1 or 0
      if not b or zc > bc or (zc == bc and z.d < b.d) then best = i end
    end
  end
  if chasers > (cur and 0 or 1) then return "woke" end
  if cur or best then return "go", cur or best end
  if upstairs then return "floor" end
  return "none"
end

-- How far round the back of a zombie a square is: -1 dead behind, 1 dead in front, 0 when it is not
-- known which way it faces. ox, oy is the square from the zombie, fx, fy the way it faces.
function Needs.behindRank(ox, oy, fx, fy)
  local ol = math.sqrt(ox * ox + oy * oy)
  local fl = math.sqrt(fx * fx + fy * fy)
  if ol < 0.01 or fl < 0.01 then return 0 end
  return (ox * fx + oy * fy) / (ol * fl)
end

-- Pure. Which items STASH leaves on her, as a set of indexes: the weapon in hand and the best spare
-- (the two best with empty hands), one gun with the ammo that fits it, and food for STASH_FOOD, what
-- rots soonest first, since a stash is the place for what keeps.
function Needs.stashKeeps(descs)
  local keep, melee, gun, gunRounds = {}, {}, nil, -1
  local heldMelee = false
  local rounds = {}
  for _, d in ipairs(descs) do
    if d.ammo then rounds[d.ammo] = (rounds[d.ammo] or 0) + (tonumber(d.count) or 1) end
  end
  for i, d in ipairs(descs) do
    if Core.isRealWeapon(d.weapon) and not d.broken then
      if d.held then
        keep[i], heldMelee = true, true
      else
        table.insert(melee, { i = i, score = tonumber(d.weapon.score) or Core.weaponScore(d.weapon) })
      end
    end
    if type(d.gun) == "table" and not d.broken then
      local n = d.held and 100000 or (tonumber(d.gun.loaded) or 0) + (rounds[d.gun.ammoKey] or 0)
      if n > gunRounds then gun, gunRounds = i, n end
    end
  end
  table.sort(melee, function(a, b) return a.score > b.score end)
  for k = 1, math.min(#melee, heldMelee and 1 or 2) do keep[melee[k].i] = true end
  if gun then
    keep[gun] = true
    local g = descs[gun].gun
    for i, d in ipairs(descs) do
      if (d.ammo and d.ammo == g.ammoKey) or (type(d.mag) == "table" and d.mag.key == g.magKey) or (d.box and d.box == g.boxKey) then keep[i] = true end
    end
  end
  local foods = {}
  for i, d in ipairs(descs) do
    if d.edible or d.sealed then
      table.insert(foods, { i = i, sealed = d.sealed and true or false, shelf = tonumber(d.shelf) or 99999, hunger = tonumber(d.hunger) or 0 })
    end
  end
  table.sort(foods, function(a, b)
    if a.sealed ~= b.sealed then return b.sealed end
    if a.shelf ~= b.shelf then return a.shelf < b.shelf end
    return a.i < b.i
  end)
  local kept = 0
  for _, f in ipairs(foods) do
    if kept >= Needs.N.STASH_FOOD then break end
    keep[f.i] = true
    -- A sealed can reads no hunger on some items. Count it as a small meal, not as nothing.
    kept = kept + (f.hunger > 0 and f.hunger or 0.25)
  end
  return keep
end

-- Pure. How much she needs a described item on her: higher goes into the stash later, and nil means
-- it never goes. The scale is DROP's (keep in Act.LOOT), with food on it, since a stash does not lose
-- the food the way a floor does.
function Needs.stashValue(d)
  if type(d) ~= "table" or d.held or d.worn then return nil end
  if d.container and not d.empty then return nil end
  if (tonumber(d.waterL) or 0) > 0 or d.bandage or d.sheet or d.cloth then return nil end
  -- A key opens a door she may need on the way back in. "Key" with a capital: not a turkey.
  if string.find(tostring(d.type), "Key", 1, true) then return nil end
  if d.container then return 5 end
  if Core.isRealWeapon(d.weapon) then return 25 + math.min(tonumber(d.weapon.score) or Core.weaponScore(d.weapon), 100) / 10 end
  local Act = LS.Act
  for _, row in ipairs(Act.LOOT) do
    if row.key ~= "weapon" and row.key ~= "bag" and Act.IS[row.key](d) then return row.keep end
  end
  return 0
end

-- Pure. descs: described items. over: the weight to shed. Returns { index } in the order they go,
-- least needed first and the heaviest first among equals, and stops once enough has gone.
function Needs.planStash(descs, over)
  over = tonumber(over) or 0
  local keep = Needs.stashKeeps(descs or {})
  local cands = {}
  -- She keeps her bandages, but not all of them now the haul has no cap: what is past a body's kit goes in.
  local wraps, wrapsMax = 0, LS.Act.MAX.bandage
  for i, d in ipairs(descs or {}) do
    local value, w = Needs.stashValue(d), tonumber(d.weight) or 0
    if value == nil and (d.bandage or d.sheet) and not d.held and not d.worn then
      wraps = wraps + 1
      if wraps > wrapsMax then value = d.sheet and 40 or 45 end
    end
    if value ~= nil and not keep[i] and w > 0 then table.insert(cands, { i = i, value = value, w = w }) end
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

-- Pure. How good a container is for a stash, 1 best, from the game's name for it. nil: not one for
-- gear. A fridge, a stove or a bin is somewhere food rots, gear burns or nobody looks. A crate, a
-- shelf and a wardrobe are what the guides mean.
function Needs.stashRank(kind)
  local s = string.lower(tostring(kind or ""))
  for rank, words in ipairs({ { "crate", "storage" }, { "shelves", "shelf", "wardrobe", "dresser", "locker", "cabinet", "drawer" }, { "counter", "sidetable", "desk" } }) do
    for _, w in ipairs(words) do
      if string.find(s, w, 1, true) then return rank end
    end
  end
  return nil
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

-- Name what the job works on. It shows in res.target, and a repeated order for the same job
-- puts it back (Needs.start).
local function aim(job, text)
  job.what = text
  LS.aim(job.seq, text)
end

-- "water 10,12" for a fixture the job walks to.
local function spotText(kind, obj)
  local text = kind
  pcall(function() local sq = obj:getSquare(); text = kind .. " " .. sq:getX() .. "," .. sq:getY() end)
  return text
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
    LS.aim(job.seq, job.what)
    return
  end
  job = { verb = verb, seq = args.seq, base = args.target, startTick = LS.tick, lastUpdate = LS.tick, lastActed = -99999,
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
    if tick - job.pausedAt > (job.pauseMax or Needs.N.PAUSE_MAX) then return Needs.fail(job, "zombie") end
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

-- Pure. Which worn piece to sacrifice first; lower goes first. Things that keep nothing out
-- (a scarf, a hat, socks) before a shirt, a shirt before the warm layers, trousers and
-- underwear last. The body location name is the game's, so match on a fragment of it.
function Needs.stripRank(location)
  local s = string.lower(tostring(location or ""))
  if s:find("scarf", 1, true) or s:find("neck", 1, true) or s:find("hat", 1, true) or s:find("glove", 1, true) then return 1 end
  if s:find("sock", 1, true) then return 2 end
  if s:find("under", 1, true) or s:find("pants", 1, true) or s:find("trouser", 1, true) or s:find("shoe", 1, true) then return 5 end
  if s:find("sweater", 1, true) or s:find("jumper", 1, true) or s:find("jacket", 1, true) or s:find("hoodie", 1, true) then return 4 end
  return 3
end

-- A piece of cotton clothing she is wearing and could take off to rip. The recipe refuses a worn
-- item (IsNotWorn), so the caller strips it first and rips it on the next pass. Never a bag.
local function wornRipSource(p, items)
  local best, bestRank = nil, nil
  for _, it in ipairs(items) do
    if hasTag(it, "RIP_CLOTHING_COTTON") and isWorn(p, it) then
      local isBag = false
      pcall(function() isBag = it:IsInventoryContainer() == true end)
      if not isBag then
        local loc = ""
        pcall(function() loc = tostring(it:getBodyLocation()) end)
        local rank = Needs.stripRank(loc)
        if not best or rank < bestRank then best, bestRank = it, rank end
      end
    end
  end
  return best
end

-- Something he could rip into a bandage: a sheet, or cotton clothing that is not worn, and the
-- craft recipe the game would let him do on it now. { item, recipe } or nil. With none of that,
-- cotton clothing he has on: { item, worn = true }, to be taken off and then ripped.
function Needs.ripSource(p)
  local items = Sense.carriedItems(p)
  for _, it in ipairs(items) do
    local recipeName = nil
    if hasTag(it, "SHEET") then recipeName = "RipSheets"
    elseif hasTag(it, "RIP_CLOTHING_COTTON") and not isWorn(p, it) then recipeName = "RipClothing" end
    if recipeName then
      local r = Needs.craftRecipe(p, recipeName, it)
      if r then return { item = it, recipe = r } end
    end
  end
  local worn = wornRipSource(p, items)
  if worn then return { item = worn, worn = true } end
  return nil
end

-- For inv.canRip in the percept: would BANDAGE find something to rip. The same check as
-- kit.rip, kept for RIP_CACHE ticks because the percept asks once a second and the recipe
-- check is the slow part.
Needs.RIP_CACHE = 300
if LS.ripCache == nil then LS.ripCache = false end
function Needs.canRip(p)
  local cache = LS.ripCache
  if cache and LS.tick - cache.tick < Needs.RIP_CACHE then return cache.value end
  local value = Needs.ripSource(p) ~= nil
  LS.ripCache = { tick = LS.tick, value = value }
  return value
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
  if not kit.bandage then kit.rip = Needs.ripSource(p) end
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
  local sec = { counts = {}, skipped = 0, targets = {}, seen = {}, i = 1, backs = 0 }
  sec.squares, sec.scope = Needs.secureSquares(p, scope)
  pcall(function() sec.building = p:getSquare():getBuilding() end)
  return sec
end

-- A square of the building he is sweeping, with a roof and walls around it. The squares next
-- to a door or window on the outer wall are outside, and these are the ones to stay off.
local function insideSquare(sq, building)
  return LS.Move.insideSquare(sq, building)
end

local function onSquare(p, sq)
  local same = false
  pcall(function()
    same = math.floor(p:getX()) == sq:getX() and math.floor(p:getY()) == sq:getY() and math.floor(p:getZ()) == sq:getZ()
  end)
  return same
end

-- Where to stand to work a target: the square on its inside side, or nil when only the outside
-- side is open to him. Vanilla's own walk (luautils.walkAdjWindowOrDoor) takes the nearer side
-- unless he already stands in the room of the inside one, so a door in a south or east wall,
-- which sits on the outside square, sent him out. Standing here first makes the vanilla handler
-- keep to this side. need is what the target still needs (a door can need its curtain shut).
function Needs.standSquare(p, t, need, building)
  local o = t.obj
  local own = nil
  pcall(function() own = o:getSquare() end)
  local cands = {}
  if t.kind == "door" and need == "curtain" then
    -- The sheet hangs on one side of the door, and vanilla walks to that side.
    pcall(function() table.insert(cands, o:getSheetSquare()) end)
  elseif t.kind == "window" or t.kind == "door" then
    table.insert(cands, own)
    pcall(function()
      local north = o:getNorth()
      table.insert(cands, own:getAdjacentSquare(north and IsoDirections.N or IsoDirections.W))
    end)
  else
    -- A curtain hangs inside and vanilla walks onto its square. A light is worked from its own.
    table.insert(cands, own)
  end
  local best, bestD = nil, nil
  for _, sq in ipairs(cands) do
    local standable = false
    pcall(function() standable = sq:canStand() end)
    if standable and insideSquare(sq, building) then
      local d = distTo(p, sq:getX() + 0.5, sq:getY() + 0.5, sq:getZ())
      if not bestD or d < bestD then best, bestD = sq, d end
    end
  end
  return best
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

-- One step of a sweep. Returns "scan" (more to do next step), "busy" (an action is queued),
-- "done", or "outside" (he is no longer in the building).
function Needs.secureStep(p, job, sec)
  -- A walk that stepped out of a door (15 of 38 SECUREs in the 2026-11-05 soak ended here) goes back
  -- to the last square inside and carries on. Pushed well out of the building (a flee, a long
  -- detour) the sweep is over: it never goes looking for a way back in.
  local here = p:getSquare()
  if sec.building and not insideSquare(here, sec.building) then
    local near = false
    pcall(function()
      near = math.abs(here:getX() - sec.lastIn:getX()) + math.abs(here:getY() - sec.lastIn:getY()) <= Needs.N.BACK_R
    end)
    if not near or sec.backs >= Needs.N.BACKS_MAX then return "outside" end
    sec.backs = sec.backs + 1
    ISTimedActionQueue.clear(p)
    ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sec.lastIn))
    if Needs.queued(p, job) then return "busy" end
    return "outside"
  end
  sec.lastIn = here
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
  -- Stay with the target once chosen. A walk changes which one is nearest, and picking again
  -- after every walk could send him back and forth between two.
  local t, need = nil, nil
  if sec.cur and not sec.cur.skip then
    t, need = sec.cur, Needs.targetNeed(p, sec.cur)
  end
  if not need then
    t = nil
    local i = Needs.pickTarget(rows)
    if not i then return "done" end
    t, need = pick[i].t, pick[i].need
  end
  sec.cur = t
  local function giveUp()
    t.skip, sec.cur = true, nil
    sec.skipped = sec.skipped + 1
    return "scan"
  end
  local stand = Needs.standSquare(p, t, need, sec.building)
  if not stand then return giveUp() end
  if not onSquare(p, stand) then
    local leg, partWay = LS.Move.insideLeg(p, stand, sec.building)
    -- A leg of a long way inside is not a try at the target. Its count only stops a leg that never lands.
    if partWay then t.legs = (t.legs or 0) + 1 else t.walks = (t.walks or 0) + 1 end
    if (t.walks or 0) > 2 or (t.legs or 0) > Needs.N.LEGS_MAX then return giveUp() end
    ISTimedActionQueue.clear(p)
    ISTimedActionQueue.add(ISWalkToTimedAction:new(p, leg))
    pcall(function()
      Core.trace("secure-walk", t.kind .. "/" .. need .. " to " .. stand:getX() .. "," .. stand:getY()
        .. " exterior=" .. tostring(stand:has(IsoFlagType.exterior)) .. " from " .. math.floor(p:getX()) .. "," .. math.floor(p:getY()))
    end)
    if Needs.queued(p, job) then return "busy" end
    return giveUp()
  end
  ISTimedActionQueue.clear(p)
  Needs.doTarget(p, t, need)
  if Needs.queued(p, job) then
    sec.last = { t = t, need = need }
    sec.cur = nil
    return "busy"
  end
  return giveUp()
end

-- ---------- CLEAR engine ----------
-- The zombies in the building, and any chaser near it, as Needs.clearPick wants them. ref is the
-- zombie itself.
local function clearRows(p, building, current)
  local rows = {}
  pcall(function()
    local px, py, pz = p:getX(), p:getY(), math.floor(p:getZ())
    local zl = getCell():getZombieList()
    for i = 0, zl:size() - 1 do
      local z = zl:get(i)
      if Core.zombieAlive(z) then
        local dx, dy = z:getX() - px, z:getY() - py
        local d = math.sqrt(dx * dx + dy * dy)
        local inBuilding = Sense.sameBuilding(building, z)
        local chase = false
        pcall(function() chase = z:getTarget() == p end)
        if inBuilding or (chase and d <= Needs.N.CLEAR_CHASE_R) then
          local level, down = true, false
          pcall(function() level = math.floor(z:getZ()) == pz end)
          pcall(function() down = z:isOnFloor() or z:isKnockedDown() or z:isCrawling() end)
          table.insert(rows, { ref = z, d = d, inside = inBuilding, level = level, chase = chase,
            down = down and true or false, current = z == current })
        end
      end
    end
  end)
  return rows
end

-- The squares next to the zombie she could hit it from, with no wall or shut door between, the
-- ones behind it first. { {sq, rank, d} }.
function Needs.clearSpots(p, z, building)
  local spots = {}
  pcall(function()
    local zx, zy, zz = math.floor(z:getX()), math.floor(z:getY()), math.floor(z:getZ())
    local own = LS.Move.square(zx, zy, zz)
    if not own then return end
    local fx, fy = 0, 0
    pcall(function() fx, fy = z:getForwardDirectionX(), z:getForwardDirectionY() end)
    for dx = -1, 1 do
      for dy = -1, 1 do
        local sq = (dx ~= 0 or dy ~= 0) and LS.Move.square(zx + dx, zy + dy, zz) or nil
        if sq and LS.Move.insideSquare(sq, building) and LS.Move.canStand(sq) then
          local blocked = true
          pcall(function() blocked = sq:isBlockedTo(own) end)
          if not blocked then
            table.insert(spots, { sq = sq, rank = Needs.behindRank(dx, dy, fx, fy), d = distTo(p, zx + dx, zy + dy, zz) })
          end
        end
      end
    end
  end)
  table.sort(spots, function(a, b)
    if a.rank ~= b.rank then return a.rank < b.rank end
    return a.d < b.d
  end)
  return spots
end

-- True when a shut door on the way is locked or boarded. Move.insideRoute counts every door as a
-- way, since the walk opens them, and it cannot open these. A key she holds does not help here:
-- only ENTER unlocks.
function Needs.lockedOnRoute(p, route)
  local cur = nil
  pcall(function() cur = p:getSquare() end)
  for _, sq in ipairs(route) do
    local shut = false
    pcall(function()
      if cur:isDoorTo(sq) then
        local door = cur:getDoorTo(sq)
        shut = door:isBarricaded() or (not door:IsOpen() and (door:isLocked() or door:isLockedByKey()))
      end
    end)
    if shut then return true end
    cur = sq
  end
  return false
end

-- ---------- STASH engine ----------
if LS.stashSpots == nil then LS.stashSpots = {} end   -- building id -> spots of the containers in use
if LS.stashRooms == nil then LS.stashRooms = {} end   -- building id -> room keys holding a stash

local function spotKey(sq, kind)
  local key = ""
  pcall(function() key = sq:getX() .. "," .. sq:getY() .. "," .. sq:getZ() .. "|" .. tostring(kind) end)
  return key
end

-- Containers fit for a stash on her floor of the building, best first: the ones she already uses,
-- then by Needs.stashRank, then nearest.
function Needs.stashContainers(p, m)
  local Act, out = LS.Act, {}
  local pz = math.floor(p:getZ())
  local spots = LS.stashSpots[m.id] or {}
  for _, row in ipairs(Act.buildingRooms(m)) do
    local room = nil
    pcall(function() room = row.def:getIsoRoom() end)
    if room and row.z == pz then
      for _, c in ipairs(Act.roomContainers(room)) do
        local kind = nil
        pcall(function() kind = c.c:getType() end)
        local rank = Needs.stashRank(kind)
        if rank and not c.floor then
          local key = spotKey(c.sq, kind)
          table.insert(out, { c = c.c, sq = c.sq, key = key, room = row.key, rank = spots[key] and 0 or rank,
            d = distTo(p, c.sq:getX() + 0.5, c.sq:getY() + 0.5, c.sq:getZ()) })
        end
      end
    end
  end
  table.sort(out, function(a, b)
    if a.rank ~= b.rank then return a.rank < b.rank end
    return a.d < b.d
  end)
  return out
end

-- What she carries as STASH reads it. A worn bag is worn whatever the item says about it, and a
-- carried one only goes in once it is empty, or its contents would go with it unseen.
local function stashFacts(p, skip)
  local all, things = LS.Act.dropFacts(p)
  local back = nil
  pcall(function() back = p:getClothingItem_Back() end)
  local descs, items = {}, {}
  for i, it in ipairs(things) do
    if not skip[it] then
      local d = all[i]
      if it == back then d.worn = true end
      pcall(function() d.hunger = math.abs(it:getHungChange()) end)
      if d.container then pcall(function() d.empty = it:getInventory():isEmpty() == true end) end
      table.insert(descs, d)
      table.insert(items, it)
    end
  end
  return descs, items
end

local function stashEnd(p, job)
  if job.count == 0 then return Needs.fail(job, "nothing to stash") end
  local why = "stashed " .. job.count
  if LS.Act.searchLeft(p) <= 0 then why = why .. " (still heavy)" end
  Needs.done(job, why)
end

-- The container to use now, or nil with no more to use. With none in the building at all she falls
-- back on the floor of the room she stands in.
local function stashBox(p, job)
  if job.box or job.floor then return job.box end
  if not job.cands then
    job.cands = Needs.stashContainers(p, job.memo)
    if #job.cands == 0 then
      job.floor = true
      return nil
    end
  end
  if (job.boxes or 0) >= Needs.N.STASH_BOXES then return nil end
  local box = table.remove(job.cands, 1)
  if box then
    job.box = box
    job.boxes = (job.boxes or 0) + 1
  end
  return box
end

local function noteStashSpot(p, job, it)
  pcall(function() it:getModData().lsStash = job.memo.id end)
  local rooms = LS.stashRooms[job.memo.id] or {}
  LS.stashRooms[job.memo.id] = rooms
  if job.box then
    rooms[job.box.room] = true
    local spots = LS.stashSpots[job.memo.id] or {}
    LS.stashSpots[job.memo.id] = spots
    spots[job.box.key] = true
  else
    pcall(function() rooms[LS.Act.roomKey(p:getSquare():getRoom():getRoomDef())] = true end)
  end
end

-- Whether the last item left her. One that did not, twice, stays on her: the game will not have it.
-- A full box is the likely reason, so she moves on to the next one first.
local function stashCheck(p, job)
  local it = job.pending
  if not it then return end
  job.pending = nil
  for _, x in ipairs(Sense.carriedItems(p)) do
    if x == it then
      job.tries[it] = (job.tries[it] or 0) + 1
      if job.tries[it] >= Needs.N.STASH_TRIES then
        job.skip[it] = true
        pcall(function() it:getModData().lsStash = nil end)
      end
      return
    end
  end
  job.count = job.count + 1
end

-- ---------- skills ----------
-- Each is function(p, job). It reads the world, then either queues one thing (Needs.queued),
-- finishes the job (Needs.done / Needs.fail), or returns to be stepped again.
Needs.skills = Needs.skills or {}
local skills = Needs.skills

-- Put what she does not need on her into a container in her base, one item a step, reading the
-- weight again each time because a bag softens what is in it. It sheds past the search line by
-- STASH_ROOM: stopping on the line leaves her a few hundred grams, and a SEARCH with that much room
-- takes nothing and marks every room done. Her base comes with the order, and the mod has no other
-- idea which building that is.
skills.STASH = function(p, job)
  local here = nil
  pcall(function() here = p:getSquare() end)
  if not job.building then
    local b, m = Sense.currentBuilding(p)
    if not b or not m or job.base == nil or job.base == "" or m.id ~= job.base then return Needs.fail(job, "not at base") end
    job.building, job.memo = b, m
    job.count, job.tries, job.skip = 0, {}, {}
    aim(job, m.id)
    think(job, "Home. Putting the spare gear away.")
  end
  local stillIn = false
  pcall(function() stillIn = here:getBuilding() == job.building end)
  if not stillIn then return Needs.fail(job, "not at base") end
  stashCheck(p, job)
  local Act = LS.Act
  local max = 0
  pcall(function() max = p:getMaxWeight() end)
  local over = Needs.N.STASH_ROOM * max - Act.searchLeft(p)
  if over <= 0 then return stashEnd(p, job) end
  local descs, items = stashFacts(p, job.skip)
  local picks = Needs.planStash(descs, over)
  if #picks == 0 then return stashEnd(p, job) end
  local it = items[picks[1]]
  local box = stashBox(p, job)
  if not box and not job.floor then return stashEnd(p, job) end
  if box then
    local near = false
    pcall(function() near = LS.Move.distTo(p, box.sq:getX(), box.sq:getY()) <= 1.6 and box.sq:getZ() == math.floor(p:getZ()) and Act.canReach(p, box.sq) end)
    if not near then
      local dest = LS.Move.adjacent(p, box.sq)
      local leg, partWay = nil, false
      if dest then leg, partWay = LS.Move.insideLeg(p, dest, job.building) end
      if partWay then box.legs = (box.legs or 0) + 1 else box.walks = (box.walks or 0) + 1 end
      if not leg or (box.walks or 0) > 2 or (box.legs or 0) > Needs.N.LEGS_MAX then
        -- It cannot be reached, so it does not count as one of the two.
        job.box, job.boxes = nil, job.boxes - 1
        return
      end
      ISTimedActionQueue.clear(p)
      ISTimedActionQueue.add(ISWalkToTimedAction:new(p, leg))
      if not Needs.queued(p, job) then
        job.box, job.boxes = nil, job.boxes - 1
      end
      return
    end
    -- The game rolls a container's loot the first time it is opened. Better now than on top of the stash.
    Act.explore(box.c)
    local room = false
    pcall(function() room = box.c:hasRoomFor(p, it) == true end)
    if not room then
      job.box = nil
      return
    end
    local src = nil
    pcall(function() src = it:getContainer() end)
    if not src then
      job.skip[it] = true
      return
    end
    ISTimedActionQueue.clear(p)
    ISTimedActionQueue.add(ISInventoryTransferAction:new(p, it, src, box.c, 10))
  else
    ISTimedActionQueue.clear(p)
    ISInventoryPaneContextMenu.dropItem(it, playerNum(p))
  end
  noteStashSpot(p, job, it)
  job.pending = it
  if not Needs.queued(p, job) then job.pending = nil; job.skip[it] = true end
end

skills.DRINK = function(p, job)
  if job.drank then return Needs.done(job, job.drank) end
  -- The drink ended but nothing left the container: say so, so the brain stops sending DRINK.
  if job.dry then return Needs.fail(job, job.dry) end
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
    aim(job, itemName(bottle))
    local function finished()
      local after = amount
      pcall(function() after = bottle:getFluidContainer():getAmount() end)
      if after < amount - 0.001 then job.drank = label else job.dry = "nothing came out of " .. itemName(bottle) end
    end
    if Needs.queued(p, job, nil, finished) then
      think(job, "Water. Drinking.")
      return
    end
  end
  local src = Needs.waterSources(p)[1]
  if not src then return Needs.fail(job, "no water") end
  ISTimedActionQueue.clear(p)
  ISWorldObjectContextMenu.onDrink(nil, src.obj, pn)
  aim(job, spotText("water", src.obj))
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
  aim(job, spotText("water", src.obj))
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
  aim(job, itemName(it))
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
    aim(job, job.bed and spotText("bed", job.bed) or "floor")
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
    local state = Needs.secureStep(p, job, job.sec)
    if state == "outside" then return Needs.fail(job, "not inside") end
    if state ~= "done" then return end
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
  local stepName = Needs.treatStep(f, { bandage = kit.bandage ~= nil, disinfect = kit.disinfect ~= nil,
    rip = kit.rip ~= nil and not kit.rip.worn, strip = kit.rip ~= nil and kit.rip.worn == true })
  if stepName == "keep" then job.skipParts[f.part] = true; return end
  if stepName == "none" then return Needs.fail(job, why("no bandage")) end
  aim(job, f.part)
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
  elseif stepName == "strip" then
    -- The rip recipe will not take a worn item. Off with it now; the next pass rips it.
    ISTimedActionQueue.add(ISUnequipAction:new(p, kit.rip.item, 50))
  end
  local thought = "Treating " .. f.part .. "."
  if stepName == "rip" then thought = "No bandage. Ripping cloth."
  elseif stepName == "strip" then thought = "No bandage. Taking off a shirt to rip it." end
  think(job, thought)
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
    if worn and id(worn) == id(job.target) then
      pcall(function() LS.Act.packBag(p) end)
      return Needs.done(job, "wearing " .. itemName(worn))
    end
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
  aim(job, itemName(bag))
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
    local _, m = Sense.currentBuilding(p)
    aim(job, m and m.id or "")
    think(job, "Shutting the place up.")
  end
  local state = Needs.secureStep(p, job, job.sec)
  if state == "outside" then return Needs.fail(job, "not inside") end
  if state == "done" then
    Needs.done(job, Needs.secureSummary(job.sec.counts, job.sec.skipped))
  end
end

-- Walk to a square next to a zombie in this building, from behind when there is a way, and kill it.
-- From two tiles in the reflex takes the swing and the stomp itself, and this job pauses while it
-- does (it also has the fight if the zombie turns). The job's own hit is for when the reflex stands
-- aside. Once a leg ends it looks again, since an idle zombie wanders. The order is done when nobody
-- is left in the house on her floor.
skills.CLEAR = function(p, job)
  local here = nil
  pcall(function() here = p:getSquare() end)
  if not job.building then
    pcall(function() job.building = here:getBuilding() end)
    if not job.building then return Needs.fail(job, "not inside") end
    -- The fight is the point of this order, so a long one is not a failure.
    job.pauseMax = Needs.N.CLEAR_MAX
    local _, m = Sense.currentBuilding(p)
    aim(job, m and m.id or "")
    think(job, "One in here. Getting behind it.")
  end
  local stillIn = false
  pcall(function() stillIn = here:getBuilding() == job.building end)
  if not stillIn then return Needs.fail(job, "not inside") end
  if LS.tick - job.startTick > Needs.N.CLEAR_MAX then return Needs.fail(job, "took too long") end
  if not Core.holdingMelee(p) then return Needs.fail(job, "no weapon") end
  local rows = clearRows(p, job.building, job.target)
  local verdict, i = Needs.clearPick(rows)
  if verdict == "woke" then return Needs.fail(job, "a second one woke") end
  if verdict == "floor" then return Needs.fail(job, "another floor") end
  if verdict == "none" then return Needs.done(job, job.target and "cleared" or "nobody inside") end
  local t = rows[i]
  job.target = t.ref
  local function hit()
    pcall(function() LS.Reflex.attack(p, t.ref, t.down) end)
  end
  if t.d <= Needs.N.CLEAR_HIT and not Sense.wallBetween(p, t.ref) then return hit() end
  -- It is coming to her, and she does not walk into it.
  if t.chase then return end
  local locked = false
  for _, spot in ipairs(Needs.clearSpots(p, t.ref, job.building)) do
    local route = LS.Move.insideRoute(p, spot.sq, job.building)
    if route and Needs.lockedOnRoute(p, route) then
      locked = true
    elseif route then
      if #route == 0 then return hit() end
      job.legs = (job.legs or 0) + 1
      if job.legs > Needs.N.LEGS_MAX then return Needs.fail(job, "stuck") end
      ISTimedActionQueue.clear(p)
      ISTimedActionQueue.add(ISWalkToTimedAction:new(p, route[math.min(#route, LS.Move.ROUTE_LEG)]))
      if not Needs.queued(p, job, Needs.N.CLEAR_LEG) then Needs.fail(job, "stuck") end
      return
    end
  end
  Needs.fail(job, locked and "locked door" or "out of reach")
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
for _, verb in ipairs({ "DRINK", "FILL", "EAT", "SLEEP", "BANDAGE", "WEARBAG", "SECURE", "REST", "CLEAR", "STASH" }) do
  LS.verbs[verb] = function(p, args) Needs.start(p, args, verb) end
end
