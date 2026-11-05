-- The real survival engine: local and fast, no brain round-trip. Fight one armed, flee a pack,
-- get off a stuck door, and slow or speed the game clock.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
require "LocalSurvivor/Move"
local LS = LocalSurvivor
LS.Reflex = LS.Reflex or {}
local Reflex = LS.Reflex
local Core = LS.Core
local Move = LS.Move

-- Reflex-only state. On the namespace so a second run of this file keeps it.
if LS.reflexState == nil then
  LS.reflexState = {
    -- True while the walk queued in engage is still the one bringing him in. A brain walk or a
    -- flee has travel.active set, so those are not kept.
    closingIn = false,
    -- Pathfinding will stand on one tile and try the same door forever. Hold the fight off while we step aside.
    unstickUntil = 0,
    stuckX = nil, stuckY = nil, stuckSince = 0,
    triedStep = {},
  }
end
local R = LS.reflexState

-- Sum a repulsion vector AWAY from every zombie within range (closer = stronger), so we flee
-- along the safest heading instead of blindly away from just the nearest one (which could be
-- straight into two others). This is what keeps him alive between slow LLM decisions.
function Reflex.fleeVector(px, py)
  local fx, fy, nearestD, danger = 0, 0, 9999, 0
  pcall(function()
    local zl = getCell():getZombieList()
    if not zl then return end
    for i = 0, zl:size() - 1 do
      local z = zl:get(i)
      if Core.zombieAlive(z) then
        local dx, dy = px - z:getX(), py - z:getY()   -- points AWAY from the zombie
        local d = math.sqrt(dx * dx + dy * dy)
        if d < nearestD then nearestD = d end
        if d <= 22 and d > 0.1 then
          local w = (22 - d) / 22                       -- 0..1, nearer pushes harder
          fx = fx + (dx / d) * w
          fy = fy + (dy / d) * w
          if d <= Core.FLEE_TRIGGER then danger = danger + 1 end
        end
      end
    end
  end)
  return fx, fy, nearestD, danger
end

-- nearest zombie + how many are within a radius
function Reflex.nearestZombie(px, py, r)
  local best, bd, cnt = nil, 9999, 0
  pcall(function()
    local zl = getCell():getZombieList()
    if not zl then return end
    for i = 0, zl:size() - 1 do
      local z = zl:get(i)
      if Core.zombieAlive(z) then
        local d = math.sqrt((z:getX() - px) ^ 2 + (z:getY() - py) ^ 2)
        if d <= r then cnt = cnt + 1 end
        if d < bd then bd, best = d, z end
      end
    end
  end)
  return best, bd, cnt
end

-- Same test CombatManager uses: distance against maxRange * rangeMod, same floor.
-- A fixed 1.8 tile swing misses a short weapon (knives are 0.9).
function Reflex.inMeleeReach(p, z, d)
  local ok, result = pcall(function()
    if math.abs(z:getZ() - p:getZ()) >= 0.5 then return false end
    local weapon = p:getPrimaryHandItem()
    local using = p:getUseHandWeapon()
    if using and not using:isRanged() then weapon = using end
    if not weapon or not weapon:IsWeapon() or weapon:isRanged() or weapon:isBareHands() then return false end
    local range = weapon:getMaxRange(p) * weapon:getRangeMod(p)
    return (d * d) < (range * range)
  end)
  if not ok then
    LS.lastError = "fight:" .. tostring(result)
    return false
  end
  return result and true or false
end

-- A scalpel only connects inside 0.8 tiles. A zombie bites from farther than that, so the
-- range check said "not yet" while he was already being hit, and he kept walking.
function Reflex.zombieOnHim(d)
  return d <= 1.5
end
function Reflex.shortBlade(p)
  local short = false
  pcall(function()
    local w = p:getUseHandWeapon() or p:getPrimaryHandItem()
    if w and w:IsWeapon() and not w:isRanged() and not w:isBareHands() then
      short = (w:getMaxRange(p) * w:getRangeMod(p)) < 1.0
    end
  end)
  return short
end

-- One walk in, then swing. Clearing the queue on every close tick restarts the path and
-- StopAllActionQueue cuts off a swing that already started.
function Reflex.engage(p, z, d)
  local hud = LS.hudData
  pcall(function() p:faceThisObject(z) end)
  if Reflex.inMeleeReach(p, z, d) or (Reflex.zombieOnHim(d) and Core.holdingMelee(p)) then
    R.closingIn = false
    local started = false
    pcall(function() started = p:isAttackStarted() end)
    if not started then
      ISTimedActionQueue.clear(p)
      LS.travel.active = false
      local ok, err = pcall(function() p:DoAttack(0) end)
      if not ok then LS.lastError = "fight:" .. tostring(err) end
    end
    hud.action = "FIGHT"
    hud.thought = "On it. Swing and drop this one."
    return
  end
  if R.closingIn and not LS.travel.active and Move.queuedWalkOnly(p) then
    hud.action = "ENGAGING"
    hud.thought = "One ahead. Closing in to take it down."
    return
  end
  local dx, dy = z:getX() - p:getX(), z:getY() - p:getY()
  local len = math.max(1, math.sqrt(dx * dx + dy * dy))
  ISTimedActionQueue.clear(p)
  LS.travel.active = false
  local stepped = Move.stepWalk(p, math.floor(dx / len * math.min(d, 6) + 0.5), math.floor(dy / len * math.min(d, 6) + 0.5))
  R.closingIn = stepped and true or false
  hud.action = "ENGAGING"
  hud.thought = "One ahead. Closing in to take it down."
end

-- FLEE reflex: repulsion-vector escape. Proactive, starts spacing out before contact.
function Reflex.reflex(p)
  local hud = LS.hudData
  local px, py = p:getX(), p:getY()
  local fx, fy, nearestD, danger = Reflex.fleeVector(px, py)
  if danger == 0 then return end
  local qlen = Core.queueLength(p)
  local emergency = nearestD <= Core.FLEE_INTERRUPT
  if qlen > 0 and not emergency then return end
  if LS.tick - LS.reflexTick < 45 and not emergency then return end
  local len = math.sqrt(fx * fx + fy * fy)
  if len < 0.01 then return end
  LS.reflexTick = LS.tick
  if emergency then pcall(function() p:Say("!") end) end
  hud.action = "FLEE (reflex)"
  hud.thought = "Too close, breaking away to open the gap."
  Move.doMove(p, math.floor(fx / len * 16 + 0.5), math.floor(fy / len * 16 + 0.5))  -- short, controlled break
end

-- Fight-or-flee: FIGHT when armed, not swarmed, and healthy enough. Only FLEE when he'd actually
-- lose: unarmed, outnumbered (3+ close), or badly hurt. Returns true if it took over.
function Reflex.survive(p)
  local hud = LS.hudData
  local px, py = p:getX(), p:getY()
  local z, nd = Reflex.nearestZombie(px, py, 11)             -- only engage/flee range; farther = brain's job
  -- The door escape must not hold the fight off while a zombie is already on him.
  if LS.tick < R.unstickUntil and (not z or nd > 2) then return false end
  if not z or nd > 11 then R.closingIn = false; return false end
  local _, _, swarm = Reflex.nearestZombie(px, py, 7)
  local armed, hp = false, 100
  armed = Core.holdingMelee(p)
  pcall(function() hp = p:getBodyDamage():getOverallBodyHealth() end)
  local cornered = nd <= Core.FLEE_INTERRUPT and (swarm >= 2 or not armed)
  -- A knife does not win a chase. Run until the zombie is close enough to hit, then swing.
  if armed and Reflex.shortBlade(p) and not Reflex.zombieOnHim(nd) then
    R.closingIn = false
    local dx, dy = px - z:getX(), py - z:getY()
    local len = math.max(1, math.sqrt(dx * dx + dy * dy))
    Move.doMove(p, math.floor(dx / len * 16 + 0.5), math.floor(dy / len * 16 + 0.5))
    hud.action = "FLEE (reflex)"
    hud.thought = "Knife is too short. Opening the gap."
    return true
  end
  if armed and hp >= 30 and swarm <= 2 and not cornered then
    Reflex.engage(p, z, nd)
    return true
  end
  R.closingIn = false
  -- FLEE only when he'd actually lose: unarmed & close, swarmed, badly hurt, or cornered.
  if (not armed and nd <= Core.FLEE_TRIGGER) or swarm >= 3 or (hp < 30 and nd <= Core.FLEE_TRIGGER) or cornered then
    Reflex.reflex(p)
    return true
  end
  return false                                        -- otherwise keep pursuing the objective
end

-- auto game-speed: fast-forward the boring safe stretches, snap to normal near danger so the
-- reflex keeps full fidelity. Toggle with G. The user's manual pause (speed 0) always wins.
function Reflex.manageSpeed(p)
  if not LS.autoSpeed then return end
  local ok, cur = pcall(function() return getGameSpeed() end)
  if not ok or cur == 0 then return end          -- paused by user -> leave it
  local _, nd = Reflex.nearestZombie(p:getX(), p:getY(), 70)
  local want = 1
  if not LS.manualMode and nd > 60 then want = 2 end  -- safe and clear -> gentle fast-forward
  if cur ~= want then pcall(function() setGameSpeed(want) end) end
end

-- A pathfind that is stuck plays the open-door animation and never ends. Step to a
-- neighbour that is not across a door. If every neighbour failed, open the door directly.
function Reflex.releaseDoor(p)
  if LS.tick < R.unstickUntil then return end
  local z, nd = Reflex.nearestZombie(p:getX(), p:getY(), 3)
  if z and nd <= 2 then return end
  local x, y = math.floor(p:getX()), math.floor(p:getY())
  if x ~= R.stuckX or y ~= R.stuckY then
    R.stuckX, R.stuckY, R.stuckSince = x, y, LS.tick
    return
  end
  if (LS.tick - R.stuckSince) < 90 then return end
  if Core.queueLength(p) == 0 then return end
  pcall(function() p:getPathFindBehavior2():cancel(); p:setPath2(nil) end)
  ISTimedActionQueue.clear(p)
  R.closingIn = false
  LS.travel.active = false
  local pz = math.floor(p:getZ())
  local here = getCell():getGridSquare(x, y, pz)
  local stepped = false
  for _, d in ipairs({ {1, 0}, {-1, 0}, {0, 1}, {0, -1} }) do
    local key = (x + d[1]) .. "," .. (y + d[2])
    local sq = getCell():getGridSquare(x + d[1], y + d[2], pz)
    local blocked = false
    if here and sq then pcall(function() blocked = here:isDoorTo(sq) or here:isDoorBlockedTo(sq) end) end
    if not R.triedStep[key] and Move.canStand(sq) and not blocked then
      R.triedStep[key] = true
      ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sq))
      stepped = true
      break
    end
  end
  if not stepped then
    for dx = -1, 1 do
      for dy = -1, 1 do
        local sq = getCell():getGridSquare(x + dx, y + dy, pz)
        if sq then
          local objs = sq:getObjects()
          if objs then
            for i = 0, objs:size() - 1 do
              local o = objs:get(i)
              if instanceof(o, "IsoDoor") then
                pcall(function() if o.isLocked and o:isLocked() then o:setLocked(false) end end)
                pcall(function() if not o:IsOpen() then o:ToggleDoor(p) end end)
              end
            end
          end
        end
      end
    end
    R.triedStep = {}
  end
  R.unstickUntil = LS.tick + 150
  R.stuckSince = LS.tick
  LS.hudData.thought = "Off this door."
  print("LocalSurvivor unstick " .. x .. "," .. y)
end
