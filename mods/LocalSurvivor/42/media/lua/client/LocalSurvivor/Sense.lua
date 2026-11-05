-- What the body perceives: zombie scan, building scan, and the percept JSON written for the bridge.
-- Field meanings and the game call behind each one are in docs/percept.md.

require "LocalSurvivor/Core"
local LS = LocalSurvivor
LS.Sense = LS.Sense or {}
local Sense = LS.Sense
local Core = LS.Core

if LS.bldgDir == nil then LS.bldgDir = "none" end
if LS.bldgDist == nil then LS.bldgDist = -1 end
-- Building facts that do not change (bounds, doors, beds) keyed by BuildingDef id.
if LS.bldgMemo == nil then LS.bldgMemo = {} end
if LS.bldgMemoCount == nil then LS.bldgMemoCount = 0 end
-- Buildings the survivor has stood inside. Kept apart from the memo so trimming it keeps them.
if LS.visited == nil then LS.visited = {} end
-- What the last finished scan found: the nearest buildings, and water and a bed in the current one.
if LS.seen == nil then LS.seen = { near = {}, homeId = nil, water = nil, bed = nil } end
-- The scan in progress. It does a slice of work each tick so the game thread never stalls.
if LS.senseScan == nil then LS.senseScan = { phase = "idle", startTick = -99999, ox = -99999, oy = -99999 } end

Sense.SCAN_EVERY = 120          -- ticks between scans (~2s)
Sense.SCAN_MOVED = 4            -- tiles moved that start a scan early
Sense.BLDG_RADIUS = 40
Sense.BLDG_LIMIT = 6
Sense.DEFS_PER_TICK = 30
Sense.SQUARES_PER_TICK = 200    -- door search budget
Sense.MEMO_MAX = 400
Sense.DARK_LIGHT = 0.43         -- vanilla's "too dark to read" line
Sense.ITEM_MAX = 200

local function round(x) return math.floor((tonumber(x) or 0) + 0.5) end
local function round1(x) return math.floor((tonumber(x) or 0) * 10 + 0.5) / 10 end

-- ---------- zombie awareness ----------
function Sense.zombieScan(px, py)
  local zTotal, zNear, zClose, nearestD, ndx, ndy = 0, 0, 0, 9999, 0, 0
  pcall(function()
    local zl = getCell():getZombieList()
    if zl then
      for i = 0, zl:size() - 1 do
        local z = zl:get(i)
        if Core.zombieAlive(z) then
          zTotal = zTotal + 1
          local dx, dy = z:getX() - px, z:getY() - py
          local d = math.sqrt(dx * dx + dy * dy)
          if d < nearestD then nearestD, ndx, ndy = d, dx, dy end
          if d <= 30 then zNear = zNear + 1 end
          if d <= 10 then zClose = zClose + 1 end
        end
      end
    end
  end)
  local dir = "-"
  if zTotal > 0 then
    local ew = ndx > 3 and "E" or (ndx < -3 and "W" or "")
    local ns = ndy > 3 and "S" or (ndy < -3 and "N" or "")
    dir = (ns .. ew ~= "") and (ns .. ew) or "HERE"
  else nearestD = -1 end
  return zTotal, zNear, zClose, nearestD, dir, ndx, ndy
end

-- Living zombies within 40 tiles as plain tables. Only those pay for the extra Java calls.
function Sense.zombieFacts(p, px, py)
  local out = {}
  pcall(function()
    local zl = getCell():getZombieList()
    for i = 0, zl:size() - 1 do
      local z = zl:get(i)
      local dx, dy = z:getX() - px, z:getY() - py
      if dx * dx + dy * dy <= 1600 and Core.zombieAlive(z) then
        local f = { dx = dx, dy = dy, chase = false, down = false, crawl = false }
        pcall(function() f.chase = z:getTarget() == p end)
        pcall(function() f.down = z:isOnFloor() or z:isKnockedDown() end)
        pcall(function() f.crawl = z:isCrawling() end)
        table.insert(out, f)
      end
    end
  end)
  return out
end

-- Pure. zs: { {dx, dy, chase, down, crawl} }. Counts chasers within 40, downed within 3, and lists
-- the nearest few within 25.
function Sense.summarizeZombies(zs, limit)
  limit = limit or 6
  local chasing, downed, near = 0, 0, {}
  for _, z in ipairs(zs or {}) do
    local d = math.sqrt(z.dx * z.dx + z.dy * z.dy)
    if d <= 40 and z.chase then chasing = chasing + 1 end
    if d <= 3 and z.down then downed = downed + 1 end
    if d <= 25 then
      table.insert(near, { dx = round(z.dx), dy = round(z.dy), d = round1(d), chase = z.chase and true or false,
        down = z.down and true or false, crawl = z.crawl and true or false, sort = d })
    end
  end
  table.sort(near, function(a, b) return a.sort < b.sort end)
  local list = {}
  for i = 1, math.min(limit, #near) do
    near[i].sort = nil
    list[i] = near[i]
  end
  return { zChasing = chasing, zDowned = downed, zList = list }
end

-- ---------- body ----------
function Sense.bodyFacts(p)
  local out = {}
  pcall(function()
    local parts = p:getBodyDamage():getBodyParts()
    for i = 0, parts:size() - 1 do
      local bp = parts:get(i)
      local f = { part = "?" }
      pcall(function() f.part = BodyPartType.ToString(bp:getType()) end)
      pcall(function() f.bleed = bp:bleeding() end)
      pcall(function() f.scratch = bp:scratched() end)
      pcall(function() f.lac = bp:isCut() end)
      pcall(function() f.bite = bp:bitten() end)
      pcall(function() f.deep = bp:deepWounded() end)
      pcall(function() f.glass = bp:haveGlass() end)
      pcall(function() f.bandaged = bp:bandaged() end)
      pcall(function() f.dirty = bp:isBandageDirty() end)
      table.insert(out, f)
    end
  end)
  return out
end

local WOUND_FLAGS = { "bleed", "scratch", "lac", "bite", "deep", "glass", "bandaged", "dirty" }

-- Pure. parts: { {part, bleed, scratch, lac, bite, deep, glass, bandaged, dirty} }. Keeps the
-- injured parts only, worst first, so a cap never hides a bite behind a scratch. Only true flags
-- are kept: eight false flags on every part would double the size of the percept.
function Sense.summarizeWounds(parts, limit)
  limit = limit or 8
  local hurt, bleeding = {}, 0
  for _, f in ipairs(parts or {}) do
    if f.bleed then bleeding = bleeding + 1 end
    local any = f.bleed or f.scratch or f.lac or f.bite or f.deep or f.glass or f.bandaged
    if any then
      local w = { part = tostring(f.part or "?") }
      for _, k in ipairs(WOUND_FLAGS) do if f[k] then w[k] = true end end
      local score = (f.bite and 16 or 0) + (f.bleed and 8 or 0) + (f.deep and 4 or 0) + (f.glass and 2 or 0)
        + ((f.lac or f.scratch) and 1 or 0)
      table.insert(hurt, { w = w, score = score })
    end
  end
  table.sort(hurt, function(a, b)
    if a.score ~= b.score then return a.score > b.score end
    return a.w.part < b.w.part
  end)
  local list = {}
  for i = 1, math.min(limit, #hurt) do list[i] = hurt[i].w end
  return { wounds = list, bleeding = bleeding }
end

function Sense.moodles(p)
  local out = { endurance = 0, tired = 0, panic = 0, pain = 0, heavy = 0, hungry = 0, thirsty = 0 }
  local types = {
    endurance = "ENDURANCE", tired = "TIRED", panic = "PANIC", pain = "PAIN",
    heavy = "HEAVY_LOAD", hungry = "HUNGRY", thirsty = "THIRST",
  }
  pcall(function()
    local m = p:getMoodles()
    for key, name in pairs(types) do
      pcall(function() out[key] = m:getMoodleLevel(MoodleType[name]) or 0 end)
    end
  end)
  return out
end

-- ---------- inventory ----------
-- Facts about an item type that never change, cached by full type so each item costs one call
-- once its type has been seen.
if LS.itemTypes == nil then LS.itemTypes = {} end

local function hasTag(it, name)
  local yes = false
  pcall(function() yes = it:hasTag(ItemTag[name]) == true end)
  return yes
end

function Sense.itemType(it)
  local full = ""
  pcall(function() full = it:getFullType() end)
  local known = LS.itemTypes[full]
  if known then return known end
  local t = { food = Core.isFoodItem(it), melee = Core.isMeleeWeapon(it) }
  t.opener = hasTag(it, "CAN_OPENER")
  t.hammer = hasTag(it, "HAMMER")
  t.saw = hasTag(it, "SAW")
  t.screwdriver = hasTag(it, "SCREWDRIVER")
  t.lighter = hasTag(it, "START_FIRE")
  t.painkiller = full == "Base.Pills"
  if t.melee then
    t.wcls, t.wimp = Core.weaponClass(it)
    t.wtwo = false
    pcall(function() t.wtwo = it:isTwoHandWeapon() == true end)
  end
  pcall(function() t.bandage = it:isCanBandage() == true and not hasTag(it, "CAN_BE_WASHED") end)
  pcall(function() t.wipe = it:IsDrainable() and it:getAlcoholPower() == 4 end)
  pcall(function() t.fluid = it:getFluidContainer() ~= nil end)
  pcall(function() t.bag = it:IsInventoryContainer() == true end)
  if full ~= "" then LS.itemTypes[full] = t end
  return t
end

-- One item as a plain table for summarizeInventory.
function Sense.describeItem(it, p)
  local t = Sense.itemType(it)
  local d = { opener = t.opener, hammer = t.hammer, saw = t.saw, screwdriver = t.screwdriver,
    lighter = t.lighter, painkiller = t.painkiller, bandage = t.bandage, disinfect = t.wipe }
  if t.food then
    d.edible = Core.isEdible(it, p)
    if not d.edible then d.sealed = Core.isSealedFood(it) end
  end
  if t.fluid then
    pcall(function()
      local fc = it:getFluidContainer()
      if fc:isEmpty() then
        d.emptyBottle = not fc:isInputLocked()
      else
        if not fc:contains(Fluid.TaintedWater) and not fc:isPoisonous() then
          d.waterL = fc:getSpecificFluidAmount(Fluid.Water) or 0
        end
        -- Vanilla's health panel line: at least 40% alcohol and more than 0.15 L.
        local amount = fc:getAmount()
        if amount > 0.15 and fc:getProperties():getAlcohol() / amount + 0.001 >= 0.4 then d.disinfect = true end
      end
    end)
  end
  if t.melee then d.melee = Core.weaponFacts(it, t) end
  return d
end

-- Everything carried, one level into bags, so a weapon in a backpack still counts.
function Sense.carriedItems(p)
  local out = {}
  local function walk(list, depth)
    for i = 0, list:size() - 1 do
      if #out >= Sense.ITEM_MAX then return end
      local it = list:get(i)
      table.insert(out, it)
      if depth == 0 and Sense.itemType(it).bag then
        pcall(function() walk(it:getInventory():getItems(), 1) end)
      end
    end
  end
  pcall(function() walk(p:getInventory():getItems(), 0) end)
  return out
end

-- Pure. descs: the tables describeItem makes. Weapons are the best four by score. An item that
-- scores under the floor (a pen, a fork, a broken bat) is left out: it is not a weapon.
function Sense.summarizeInventory(descs, limit)
  limit = limit or 4
  local inv = { foodReady = 0, cans = 0, canOpener = false, waterL = 0, emptyBottles = 0, bandages = 0,
    disinfectant = 0, painkillers = 0, hammer = false, saw = false, screwdriver = false, lighter = false }
  local weapons = {}
  for _, d in ipairs(descs or {}) do
    if d.edible then inv.foodReady = inv.foodReady + 1 end
    if d.sealed then inv.cans = inv.cans + 1 end
    if d.opener then inv.canOpener = true end
    if d.waterL then inv.waterL = inv.waterL + d.waterL end
    if d.emptyBottle then inv.emptyBottles = inv.emptyBottles + 1 end
    if d.bandage then inv.bandages = inv.bandages + 1 end
    if d.disinfect then inv.disinfectant = inv.disinfectant + 1 end
    if d.painkiller then inv.painkillers = inv.painkillers + 1 end
    if d.hammer then inv.hammer = true end
    if d.saw then inv.saw = true end
    if d.screwdriver then inv.screwdriver = true end
    if d.lighter then inv.lighter = true end
    if d.melee then
      d.melee.score = d.melee.score or Core.weaponScore(d.melee)
      if Core.isRealWeapon(d.melee) then table.insert(weapons, d.melee) end
    end
  end
  inv.waterL = math.floor(inv.waterL * 100 + 0.5) / 100
  table.sort(weapons, function(a, b) return a.score > b.score end)
  local list = {}
  for i = 1, math.min(limit, #weapons) do
    local w = weapons[i]
    list[i] = { n = tostring(w.n), dmg = math.floor((w.dmg or 0) * 100 + 0.5) / 100,
      cond = math.floor((w.cond or 0) * 100 + 0.5) / 100, reach = math.floor((w.reach or 0) * 100 + 0.5) / 100,
      score = w.score }
  end
  return { inv = inv, weapons = list }
end

-- ---------- places ----------
-- "where's civilization" sense so he heads toward buildings instead of wandering into open
-- forest. DENSE grid scan (every 3 tiles out to ~20) so it doesn't miss buildings he's next to.
function Sense.scanBuildings(px, py, pz)
  local bestD, bx, by = 99999, nil, nil
  for dx = -20, 20, 3 do
    for dy = -20, 20, 3 do
      local sq = getCell():getGridSquare(px + dx, py + dy, pz)
      if sq then
        local b = nil
        pcall(function() b = sq:getBuilding() end)
        if b then
          local d = math.abs(dx) + math.abs(dy)
          if d < bestD then bestD, bx, by = d, dx, dy end
        end
      end
    end
  end
  if not bx then LS.bldgDir, LS.bldgDist = "none", -1; return end
  local ew = bx > 3 and "E" or (bx < -3 and "W" or "")
  local ns = by > 3 and "S" or (by < -3 and "N" or "")
  LS.bldgDir = (ns .. ew ~= "") and (ns .. ew) or "HERE"
  LS.bldgDist = bestD
end

-- getID() is a Java long, which Kahlua turns into a double. The string form is exact.
function Sense.defId(def)
  local id = nil
  pcall(function() id = def:getIDString() end)
  if id == nil or id == "" then pcall(function() id = tostring(def:getID()) end) end
  return id
end

-- Memo entry for an IsoBuilding, created on first sight with its fixed facts.
function Sense.memoFor(b)
  local def = nil
  pcall(function() def = b:getDef() end)
  if not def then return nil end
  local id = Sense.defId(def)
  if not id then return nil end
  local m = LS.bldgMemo[id]
  if m then return m end
  m = { id = id, def = def, x = 0, y = 0, x2 = 0, y2 = 0, res = false, shop = false }
  pcall(function() m.x, m.y, m.x2, m.y2 = def:getX(), def:getY(), def:getX2(), def:getY2() end)
  pcall(function() m.res = def:isResidential() end)
  pcall(function() m.shop = def:isShop() end)
  LS.bldgMemo[id] = m
  LS.bldgMemoCount = LS.bldgMemoCount + 1
  return m
end

-- Pure. Offset from (px, py) to the nearest point of the rectangle, and its length.
function Sense.rectOffset(px, py, r)
  local nx = math.max(r.x, math.min(px, r.x2))
  local ny = math.max(r.y, math.min(py, r.y2))
  local dx, dy = nx - px, ny - py
  return dx, dy, math.sqrt(dx * dx + dy * dy)
end

-- Pure. Nearest of a list of {x, y, z} spots, as {x, y, z, d} or nil.
function Sense.nearestSpot(spots, px, py)
  local best, bestD = nil, nil
  for _, s in ipairs(spots or {}) do
    local dx, dy = s.x - px, s.y - py
    local d = math.sqrt(dx * dx + dy * dy)
    if not bestD or d < bestD then best, bestD = s, d end
  end
  if not best then return nil end
  return { x = round(best.x), y = round(best.y), z = round(best.z or 0), d = round1(bestD) }
end

-- Pure. bldgs: memo-like tables {id, x, y, x2, y2, res, shop, doors}. visited: set of ids.
-- Returns the nearest few within the radius, each with its nearest door or Core.NULL.
function Sense.summarizeBuildings(bldgs, px, py, visited, limit, radius)
  limit = limit or Sense.BLDG_LIMIT
  radius = radius or Sense.BLDG_RADIUS
  local rows = {}
  for _, b in ipairs(bldgs or {}) do
    local dx, dy, d = Sense.rectOffset(px, py, b)
    if d <= radius then
      local door = Sense.nearestSpot(b.doors, px, py)
      table.insert(rows, {
        id = tostring(b.id), dx = round(dx), dy = round(dy), d = round(d),
        res = b.res and true or false, shop = b.shop and true or false,
        door = door and { x = door.x, y = door.y } or Core.NULL,
        visited = (visited and visited[b.id]) and true or false, sort = d,
      })
    end
  end
  table.sort(rows, function(a, b)
    if a.sort ~= b.sort then return a.sort < b.sort end
    return a.id < b.id
  end)
  local list = {}
  for i = 1, math.min(limit, #rows) do
    rows[i].sort = nil
    list[i] = rows[i]
  end
  return list
end

-- Exterior doors on the ground floor of a building, a slice of squares per call. Returns true when
-- the whole footprint has been read. A wall sits on the north or west edge of a square, so a door
-- in the east or south wall belongs to the square one past the footprint. Hence x2 + 1 and y2 + 1.
function Sense.doorSlice(m, budget)
  local cur = m.doorCursor
  if not cur then
    cur = { x = m.x, y = m.y, found = {}, missing = false }
    m.doorCursor = cur
  end
  local cell = getCell()
  while budget > 0 do
    if cur.y > m.y2 + 1 then
      m.doorCursor = nil
      if #cur.found == 0 and cur.missing then
        -- Part of it was not loaded yet. Try again on a later scan.
        m.doorRetry = LS.tick + 600
      else
        m.doors = cur.found
      end
      return true
    end
    local sq = cell:getGridSquare(cur.x, cur.y, 0)
    if sq then
      pcall(function()
        local door = sq:getIsoDoor()
        if door and door:isExterior() and #cur.found < 8 then
          table.insert(cur.found, { x = cur.x, y = cur.y, z = 0 })
        end
      end)
    else
      cur.missing = true
    end
    cur.x = cur.x + 1
    if cur.x > m.x2 + 1 then cur.x, cur.y = m.x, cur.y + 1 end
    budget = budget - 1
  end
  return false
end

-- Beds and water objects of one room, added to the memo.
function Sense.roomSlice(m, roomDef)
  pcall(function()
    local room = roomDef:getIsoRoom()
    if not room then m.roomsMissing = true; return end
    pcall(function()
      local ws = room:getWaterSources()
      for i = 0, ws:size() - 1 do table.insert(m.waterObjs, ws:get(i)) end
    end)
    local squares = room:getSquares()
    if squares:size() == 0 then m.roomsMissing = true end
    for i = 0, squares:size() - 1 do
      local sq = squares:get(i)
      local objs = sq:getObjects()
      for j = 0, objs:size() - 1 do
        local obj = objs:get(j)
        pcall(function()
          local props = obj:getProperties()
          if props and props:has(IsoFlagType.bed) and #m.beds < 8 then
            table.insert(m.beds, { x = sq:getX(), y = sq:getY(), z = sq:getZ() })
          end
        end)
        -- getWaterSources can miss a fixture. Anything holding water now is worth a look later.
        pcall(function() if obj:hasWater() and #m.waterObjs < 16 then table.insert(m.waterObjs, obj) end end)
      end
    end
  end)
end

-- Water objects in the memo that still hold clean water, as {x, y, z} spots.
function Sense.cleanWater(m)
  local spots, seen = {}, {}
  for _, obj in ipairs(m.waterObjs or {}) do
    pcall(function()
      if obj:getFluidAmount() >= 1 and not obj:isTaintedWater() then
        local sq = obj:getSquare()
        local x, y, z = sq:getX(), sq:getY(), sq:getZ()
        local key = x .. "," .. y .. "," .. z
        if not seen[key] then
          seen[key] = true
          table.insert(spots, { x = x, y = y, z = z })
        end
      end
    end)
  end
  return spots
end

function Sense.currentBuilding(p)
  local b, m = nil, nil
  pcall(function() b = p:getSquare():getBuilding() end)
  if b then m = Sense.memoFor(b) end
  if m then LS.visited[m.id] = true end
  return b, m
end

-- Drop memo entries that are not near and not home, so a long run does not grow it forever.
function Sense.trimMemo(keep)
  if LS.bldgMemoCount <= Sense.MEMO_MAX then return end
  local fresh, n = {}, 0
  for id in pairs(keep) do
    if LS.bldgMemo[id] then fresh[id] = LS.bldgMemo[id]; n = n + 1 end
  end
  LS.bldgMemo, LS.bldgMemoCount = fresh, n
end

-- Ask for a scan on the next tick, for example after walking into a different building.
function Sense.requestScan()
  LS.senseScan.force = true
end

-- One slice of the place scan. Called every tick from the entry file. Idle ticks cost a few
-- comparisons. A full scan is: list buildings, read their bounds, find doors of the nearest few,
-- then read the rooms of the one the survivor is in.
function Sense.step(p)
  local s = LS.senseScan
  local px, py = p:getX(), p:getY()
  if s.phase == "idle" then
    local moved = math.abs(px - s.ox) + math.abs(py - s.oy)
    if not s.force and LS.tick - s.startTick < Sense.SCAN_EVERY and moved < Sense.SCAN_MOVED then return end
    s.force = false
    s.startTick, s.ox, s.oy = LS.tick, px, py
    s.found, s.foundIds, s.i, s.list, s.n = {}, {}, 0, nil, 0
    s.phase = "list"
  end

  if s.phase == "list" then
    pcall(function()
      s.list = getCell():getBuildingList()
      s.n = s.list:size()
    end)
    if s.n > 0 then s.phase = "defs" else s.phase, s.row = "grid", -Sense.BLDG_RADIUS end
    return
  end

  local function consider(b)
    local m = Sense.memoFor(b)
    if m and not s.foundIds[m.id] then
      local _, _, d = Sense.rectOffset(s.ox, s.oy, m)
      if d <= Sense.BLDG_RADIUS then
        s.foundIds[m.id] = true
        table.insert(s.found, { id = m.id, d = d })
      end
    end
  end

  if s.phase == "defs" then
    local last = math.min(s.n, s.i + Sense.DEFS_PER_TICK)
    for i = s.i, last - 1 do
      pcall(function() consider(s.list:get(i)) end)
    end
    s.i = last
    if s.i >= s.n then s.phase = "rank" end
    return
  end

  if s.phase == "grid" then
    -- Fallback when the cell gives no building list: sample one row of squares per tick.
    local cell = getCell()
    local ox, oy = math.floor(s.ox), math.floor(s.oy)
    for dx = -Sense.BLDG_RADIUS, Sense.BLDG_RADIUS, 4 do
      pcall(function()
        local sq = cell:getGridSquare(ox + dx, oy + s.row, 0)
        local b = sq and sq:getBuilding()
        if b then consider(b) end
      end)
    end
    s.row = s.row + 4
    if s.row > Sense.BLDG_RADIUS then s.phase = "rank" end
    return
  end

  if s.phase == "rank" then
    table.sort(s.found, function(a, b) return a.d < b.d end)
    s.near = {}
    for i = 1, math.min(Sense.BLDG_LIMIT, #s.found) do s.near[i] = s.found[i].id end
    s.list = nil
    local _, home = Sense.currentBuilding(p)
    s.homeId = home and home.id or nil
    -- Water objects are held by reference, and a chunk that unloaded and came back has new ones.
    -- Read the rooms again on every new entry.
    if home and home.id ~= LS.seen.homeId then home.roomsDone, home.roomList = false, nil end
    s.phase = "doors"
    return
  end

  if s.phase == "doors" then
    local budget = Sense.SQUARES_PER_TICK
    for _, id in ipairs(s.near) do
      local m = LS.bldgMemo[id]
      if m and not m.doors and (m.doorRetry or 0) <= LS.tick then
        Sense.doorSlice(m, budget)
        return
      end
    end
    s.phase = "rooms"
    return
  end

  if s.phase == "rooms" then
    local m = s.homeId and LS.bldgMemo[s.homeId]
    if m and not m.roomsDone and (m.roomRetry or 0) <= LS.tick then
      if not m.roomList then
        m.beds, m.waterObjs, m.roomIndex, m.roomsMissing = {}, {}, 0, false
        pcall(function() m.roomList = m.def:getRooms() end)
        if not m.roomList then m.roomRetry = LS.tick + 600; return end
      end
      local count = 0
      pcall(function() count = m.roomList:size() end)
      if m.roomIndex < count then
        local rd = nil
        pcall(function() rd = m.roomList:get(m.roomIndex) end)
        if rd then Sense.roomSlice(m, rd) end
        m.roomIndex = m.roomIndex + 1
        return
      end
      m.roomList = nil
      if m.roomsMissing then m.roomRetry = LS.tick + 600 else m.roomsDone = true end
    end
    s.phase = "publish"
    return
  end

  if s.phase == "publish" then
    local seen = LS.seen
    seen.near = s.near or {}
    seen.homeId = s.homeId
    seen.waterSpots, seen.bedSpots = nil, nil
    local m = s.homeId and LS.bldgMemo[s.homeId]
    if m then
      seen.waterSpots = Sense.cleanWater(m)
      seen.bedSpots = m.beds
    end
    local keep = {}
    for _, id in ipairs(seen.near) do keep[id] = true end
    if s.homeId then keep[s.homeId] = true end
    Sense.trimMemo(keep)
    s.phase = "idle"
  end
end

-- inBldg for the percept, or nil outside.
function Sense.inBuilding(p, roomName)
  local b, m = Sense.currentBuilding(p)
  if not m then return nil end
  local out = { id = m.id, rooms = 0, roomsLeft = 0, explored = false, water = false, room = roomName or "" }
  pcall(function() out.rooms = m.def:getRoomsNumber() end)
  -- Rooms SEARCH has not finished. All of them until it has been through the building.
  out.roomsLeft = out.rooms
  pcall(function() out.roomsLeft = LS.Act.roomsLeft(m) end)
  pcall(function() out.explored = m.def:isAllExplored() end)
  pcall(function() out.water = b:hasWater() end)
  return out
end

-- ---------- perception ----------
function Sense.buildPercept(p)
  local esc, n2 = Core.esc, Core.n2
  local hud = LS.hudData
  local px, py, pz = p:getX(), p:getY(), p:getZ()
  local st = p:getStats()
  local hp = 0
  pcall(function() hp = p:getBodyDamage():getOverallBodyHealth() end)

  local zTotal, zNear, zClose, nearestD, nearestDir, zdx, zdy = Sense.zombieScan(px, py)

  local room = "outside"
  pcall(function()
    local sq = p:getSquare(); local r = sq and sq:getRoom()
    if r and r:getName() then room = r:getName() end
  end)

  local foods, waters, names = 0, 0, {}
  pcall(function()
    local items = p:getInventory():getItems()
    for i = 0, items:size() - 1 do
      local it = items:get(i)
      if Core.isEdible(it, p) then foods = foods + 1 end
      if Core.isWaterItem(it) then waters = waters + 1 end
      if i < 12 then table.insert(names, esc(it:getDisplayName())) end
    end
  end)

  -- A pen in hand reads as "none": the brain should go and find a weapon, not trust the pen.
  local weapon, weaponScore = "none", 0
  pcall(function()
    local w = p:getPrimaryHandItem()
    if not Core.isMeleeWeapon(w) then return end
    local facts = Core.weaponFacts(w, Sense.itemType(w))
    if Core.isRealWeapon(facts) then weapon, weaponScore = esc(facts.n), facts.score end
  end)

  local qlen = Core.queueLength(p)

  local hour, day = 0, 0
  pcall(function() hour = getGameTime():getHour() end)
  pcall(function() day = getGameTime():getNightsSurvived() end)

  local hunger = st:get(CharacterStat.HUNGER)
  local thirst = st:get(CharacterStat.THIRST)
  local fatigue = st:get(CharacterStat.FATIGUE)
  local endurance = st:get(CharacterStat.ENDURANCE)
  local panic = st:get(CharacterStat.PANIC)

  -- feed the HUD (visual transparency)
  hud.hp, hud.hunger, hud.thirst, hud.fatigue, hud.panic = hp, hunger, thirst, fatigue, panic
  hud.zNear, hud.zClose, hud.zDist, hud.zDir = zNear, zClose, nearestD, nearestDir
  hud.foods, hud.waters, hud.weapon, hud.room = foods, waters, weapon, room
  hud.qlen, hud.day, hud.hour = qlen, day, hour

  local j = '{"v":2'
  j = j .. ',"dead":' .. tostring(p:isDead())
  j = j .. ',"x":' .. math.floor(px) .. ',"y":' .. math.floor(py) .. ',"z":' .. math.floor(pz)
  j = j .. ',"hour":' .. hour .. ',"day":' .. day
  j = j .. ',"outside":' .. tostring(p:isOutside())
  j = j .. ',"room":"' .. esc(room) .. '"'
  j = j .. ',"hp":' .. n2(hp)
  j = j .. ',"hunger":' .. n2(hunger) .. ',"thirst":' .. n2(thirst) .. ',"fatigue":' .. n2(fatigue)
  -- PANIC is 0 to 100 while the other stats are 0 to 1. panic stays raw for the current bridge.
  j = j .. ',"endurance":' .. n2(endurance) .. ',"panic":' .. n2(panic)
  j = j .. ',"panic01":' .. n2(math.max(0, math.min(1, (tonumber(panic) or 0) / 100)))
  j = j .. ',"zTotal":' .. zTotal .. ',"zNear":' .. zNear .. ',"zClose":' .. zClose
  j = j .. ',"zDist":' .. n2(nearestD) .. ',"zDir":"' .. nearestDir .. '"'
  j = j .. ',"zdx":' .. math.floor(zdx or 0) .. ',"zdy":' .. math.floor(zdy or 0)
  j = j .. ',"foods":' .. foods .. ',"waters":' .. waters
  j = j .. ',"bldgDir":"' .. LS.bldgDir .. '","bldgDist":' .. LS.bldgDist
  j = j .. ',"weapon":"' .. weapon .. '"'
  j = j .. ',"items":"' .. table.concat(names, ", ") .. '"'
  j = j .. ',"qlen":' .. qlen
  j = j .. ',"reflexed":' .. tostring(LS.tick - LS.reflexTick < 600)
  j = j .. ',"lastSeq":' .. LS.lastSeq
  j = j .. ',"err":"' .. esc(LS.lastError) .. '"'
  j = j .. Sense.perceptV2(p, px, py, room, weaponScore)
  -- The last seconds before death, only on the dead percept (docs/percept.md).
  if LS.deathRecord and p:isDead() then j = j .. ',"death":' .. Core.json(LS.deathRecord) end
  return j .. '}'
end

-- The v2 fields, each part guarded on its own so one bad call only blanks its own field.
function Sense.perceptV2(p, px, py, room, weaponScore)
  local json = Core.json
  local parts = {}
  local function add(key, value) table.insert(parts, ',"' .. key .. '":' .. json(value)) end
  local function try(fn, fallback)
    local ok, value = pcall(fn)
    if ok and value ~= nil then return value end
    return fallback
  end

  add("asleep", try(function() return p:isAsleep() == true end, false))
  -- The game speed button: 0 paused, 1 normal, 2 to 4 fast forward. The soak test reads it.
  add("speed", try(function() return getGameSpeed() end, 1))
  add("kills", try(function() return p:getZombieKills() end, 0))
  add("hoursAlive", try(function() return math.floor(p:getHoursSurvived() * 100 + 0.5) / 100 end, 0))
  add("moodle", Sense.moodles(p))
  add("weight", try(function() return math.floor(p:getInventoryWeight() * 100 + 0.5) / 100 end, 0))
  add("maxWeight", try(function() return p:getMaxWeight() end, 0))
  add("bag", try(function()
    local back = p:getClothingItem_Back()
    return back and back:getDisplayName() or "none"
  end, "none"))

  local descs = {}
  for _, it in ipairs(Sense.carriedItems(p)) do
    local ok, d = pcall(Sense.describeItem, it, p)
    if ok and d then table.insert(descs, d) end
  end
  local carried = Sense.summarizeInventory(descs)
  -- Only worth asking with no bandage in hand, as Needs.medKit does. The recipe check is slow,
  -- so the answer is kept for a few seconds.
  carried.inv.canRip = carried.inv.bandages == 0 and try(function() return LS.Needs.canRip(p) end, false) or false
  add("weapons", carried.weapons)
  add("weaponScore", weaponScore)
  add("inv", carried.inv)

  local body = Sense.summarizeWounds(Sense.bodyFacts(p))
  add("wounds", body.wounds)
  add("bleeding", body.bleeding)

  local zs = Sense.summarizeZombies(Sense.zombieFacts(p, px, py))
  add("zChasing", zs.zChasing)
  add("zVisible", try(function() return p:getStats():getNumVisibleZombies() end, 0))
  add("zDowned", zs.zDowned)
  add("zList", zs.zList)

  local inB = try(function() return Sense.inBuilding(p, room) end, nil)
  add("inBldg", inB)
  local seen = LS.seen
  local water, bed = nil, nil
  if inB and seen.homeId == inB.id then
    water = Sense.nearestSpot(seen.waterSpots, px, py)
    bed = Sense.nearestSpot(seen.bedSpots, px, py)
  elseif (inB and inB.id or nil) ~= seen.homeId then
    Sense.requestScan()
  end
  add("water", water)
  add("bed", bed)

  local near = {}
  for _, id in ipairs(seen.near or {}) do
    if LS.bldgMemo[id] then table.insert(near, LS.bldgMemo[id]) end
  end
  add("buildings", Sense.summarizeBuildings(near, px, py, LS.visited))

  add("dark", try(function()
    if getGameTime():isNight() then return true end
    local light = p:getSquare():getLightLevel(p:getPlayerNum())
    return light < Sense.DARK_LIGHT
  end, false))

  -- What the reflex has been doing: last stance, how many calls and escapes, hits lately.
  add("reflex", try(function() return LS.ReflexLog.summary(LS.reflexLog, LS.tick) end, nil))

  local r = LS.result or {}
  add("res", { seq = r.seq or 0, verb = r.verb or "", status = r.status or "idle", why = r.why or "",
    target = r.target or "" })
  return table.concat(parts)
end

function Sense.writePercept(p)
  -- One sample a second goes into the death ring while she lives.
  if LS.Death and not p:isDead() then LS.Death.sample(p) end
  local ok, err = pcall(function()
    local w = getFileWriter("local_percept.txt", true, false)
    if not w then error("writer nil") end
    w:write(Sense.buildPercept(p)); w:close()
  end)
  if not ok then LS.lastError = "percept:" .. tostring(err) end
end
