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

-- ---------- other actions ----------
function Act.doEat(p)
  local items = p:getInventory():getItems()
  for i = 0, items:size() - 1 do
    local it = items:get(i)
    if Core.isEdible(it, p) then ISTimedActionQueue.add(ISEatFoodAction:new(p, it, 1)); return end
  end
  LS.lastError = "eat: no food"
end
function Act.doDrink(p)
  local items = p:getInventory():getItems()
  for i = 0, items:size() - 1 do
    local it = items:get(i)
    if Core.isWaterItem(it) then ISTimedActionQueue.add(ISDrinkFluidAction:new(p, it, 1)); return end
  end
  LS.lastError = "drink: no water"
end
function Act.doEquip(p)
  local w = nil
  pcall(function()
    local items = p:getInventory():getItems()
    local best, bestD = nil, -1
    for i = 0, items:size() - 1 do
      local it = items:get(i)
      if Core.isMeleeWeapon(it) then
        local dmg = 0
        pcall(function() dmg = it:getMaxDamage() end)
        if dmg > bestD then best, bestD = it, dmg end
      end
    end
    w = best
  end)
  if w then ISTimedActionQueue.add(ISEquipWeaponAction:new(p, w, 25, true)) else LS.lastError = "equip: no weapon" end
end
function Act.containerValue(c)
  local food, weapon, n = 0, 0, 0
  pcall(function()
    local items = c:getItems()
    n = items:size()
    for i = 0, n - 1 do
      local it = items:get(i)
      if Core.isFoodSupply(it) or Core.isWaterItem(it) then food = food + 1 end
      if Core.isMeleeWeapon(it) then weapon = weapon + 1 end
    end
  end)
  return food * 20 + weapon * 15 + math.min(n, 5)
end
function Act.doLoot(p)
  local hud = LS.hudData
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  local _, _, _, nd = LS.Sense.zombieScan(px, py)
  if nd >= 0 and nd < 8 then LS.lastError = "loot: zombie too close"; return end
  local best, bestSq, bestD, bestV = nil, nil, 99999, -1
  for dx = -10, 10 do
    for dy = -10, 10 do
      local sq = getCell():getGridSquare(px + dx, py + dy, pz)
      if sq then
        local objs = sq:getObjects()
        if objs then
          for i = 0, objs:size() - 1 do
            local c = nil
            pcall(function() c = objs:get(i):getContainer() end)
            if c then
              local value = Act.containerValue(c)
              local d = math.abs(dx) + math.abs(dy)
              if value > 0 and (value > bestV or (value == bestV and d < bestD)) then
                bestV, bestD, best, bestSq = value, d, c, sq
              end
            end
          end
        end
      end
    end
  end
  if not best then LS.lastError = "loot: no stocked container within 10 tiles"; return end
  LS.lastLootTick = LS.tick                       -- protect this loot from interruption (see MOVE verb)
  ISTimedActionQueue.clear(p)
  if not pcall(function() luautils.walkAdj(p, bestSq) end) then ISTimedActionQueue.add(ISWalkToTimedAction:new(p, bestSq)) end
  local taken, citems, names = 0, best:getItems(), {}
  for pass = 1, 2 do
    for i = 0, citems:size() - 1 do
      if taken >= 6 then break end
      local it = citems:get(i)
      local want = (pass == 1) and (Core.isFoodSupply(it) or Core.isWaterItem(it) or Core.isMeleeWeapon(it)) or (pass == 2 and taken < 3)
      if want then
        ISTimedActionQueue.add(ISInventoryTransferAction:new(p, it, best, p:getInventory(), 10))
        taken = taken + 1
        local nm = ""
        pcall(function() nm = it:getDisplayName() end)
        if nm ~= "" then table.insert(names, nm) end
      end
    end
  end
  if taken == 0 then
    LS.lastError = "loot: nothing takeable"
  else
    -- honest wording: he's IN THE ACT of taking these (transfers are queued and protected from
    -- interruption), so say "Grabbing" not "Grabbed". The words match what's actually happening.
    local summary = table.concat(names, ", ")
    hud.action = "LOOT"
    hud.thought = "Grabbing: " .. summary
    pcall(function() p:Say("Grabbing " .. summary) end)
  end
end

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

-- A way in: intact, room on one side only, and that room is not the one he is already in.
-- isSmashed() and isDestroyed() read the same flag on this build, so a broken window is not a door.
function Act.isEntranceWindow(p, win)
  local destroyed = true
  local ok = pcall(function() destroyed = win:isDestroyed() end)
  if not ok or destroyed then return false end
  local exterior = false
  ok = pcall(function() exterior = win:isExterior() end)
  if not ok or not exterior then return false end
  local here = Act.roomOf(p:getSquare())
  local intoRoom = nil
  pcall(function()
    local a = Act.roomOf(win:getSquare())
    local b = Act.roomOf(win:getOppositeSquare())
    if a and not b then intoRoom = a
    elseif b and not a then intoRoom = b end
  end)
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
          pcall(function()
            if instanceof(o, "IsoWindow") and o:HasCurtains() and o:isCurtainOpen() then
              ISTimedActionQueue.add(ISOpenCloseCurtain:new(p, o, o:getOtherSideWindow())); did = true
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
    Move.doMove(p, dx, dy)
  end
end
-- EAT and DRINK are registered in Needs.lua.
verbs.LOOT = function(p) LS.travel.active = false; Act.doLoot(p) end
verbs.EQUIP = function(p) LS.travel.active = false; Act.doEquip(p) end
verbs.CLOSEDOOR = function(p) LS.travel.active = false; Act.doCloseDoor(p) end
verbs.CONCEAL = function(p) LS.travel.active = false; Act.doConceal(p) end
verbs.BREAKIN = function(p) LS.travel.active = false; Act.doBreakin(p) end
verbs.STOP = function(p) LS.travel.active = false; ISTimedActionQueue.clear(p) end
verbs.WAIT = function() LS.travel.active = false; LS.observing = true end -- hold and visibly scan

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

  LS.setResult(seq, action, "running", "")
  -- An unknown verb is a WAIT, as it always was.
  local verb = LS.verbs[action] or LS.verbs.WAIT
  local ok, err = pcall(verb, p, args)
  if not ok then LS.lastError = "poll:" .. tostring(err) end
  if LS.lastError ~= "" then LS.setResult(seq, action, "failed", LS.lastError) end
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
