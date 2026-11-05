-- What the body perceives: zombie scan, building scan, and the percept JSON written for the bridge.

require "LocalSurvivor/Core"
local LS = LocalSurvivor
LS.Sense = LS.Sense or {}
local Sense = LS.Sense
local Core = LS.Core

if LS.bldgDir == nil then LS.bldgDir = "none" end
if LS.bldgDist == nil then LS.bldgDist = -1 end

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
      if Core.isEdible(it) then foods = foods + 1 end
      if Core.isWaterItem(it) then waters = waters + 1 end
      if i < 12 then table.insert(names, esc(it:getDisplayName())) end
    end
  end)

  local weapon = "none"
  pcall(function()
    local w = p:getPrimaryHandItem()
    if Core.isMeleeWeapon(w) then weapon = esc(w:getDisplayName()) end
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

  local j = '{'
  j = j .. '"dead":' .. tostring(p:isDead())
  j = j .. ',"x":' .. math.floor(px) .. ',"y":' .. math.floor(py) .. ',"z":' .. math.floor(pz)
  j = j .. ',"hour":' .. hour .. ',"day":' .. day
  j = j .. ',"outside":' .. tostring(p:isOutside())
  j = j .. ',"room":"' .. esc(room) .. '"'
  j = j .. ',"hp":' .. n2(hp)
  j = j .. ',"hunger":' .. n2(hunger) .. ',"thirst":' .. n2(thirst) .. ',"fatigue":' .. n2(fatigue)
  j = j .. ',"endurance":' .. n2(endurance) .. ',"panic":' .. n2(panic)
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
  j = j .. '}'
  return j
end

function Sense.writePercept(p)
  local ok, err = pcall(function()
    local w = getFileWriter("local_percept.txt", true, false)
    if not w then error("writer nil") end
    w:write(Sense.buildPercept(p)); w:close()
  end)
  if not ok then LS.lastError = "percept:" .. tostring(err) end
end
