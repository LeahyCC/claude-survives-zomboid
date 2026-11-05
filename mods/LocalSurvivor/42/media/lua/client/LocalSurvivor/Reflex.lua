-- The real survival engine: local and fast, no brain round-trip. Fight like a good player
-- (one standing zombie at a time, stomp what is down, step back from a second one, stop when
-- winded), flee a pack, get off a stuck door, and slow or speed the game clock.
-- Reflex.decide is pure: a plain snapshot in, a plain action out. See docs/combat.md.

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

-- Each part of the fight can be switched off at run time. A key left nil counts as on.
if LS.combat == nil then
  LS.combat = { stomp = true, spacing = true, gates = true, doorHold = true }
end

-- Distances are in tiles. Safe to overwrite on a second run.
Reflex.N = {
  RANGE = 11,          -- the reflex only looks this far; farther is the brain's job
  SWARM_R = 7,         -- this many living zombies inside SWARM_R is a pack: run
  SWARM_N = 3,
  HP_FLEE = 30,
  STOMP_REACH = 1.0,
  STOMP_CLEAR = 2.5,   -- no standing zombie this close before looking down to stomp
  DOWN_CLOSE = 4,      -- walk over to a downed zombie this close
  SPACING_R = 2,       -- a second standing zombie this close: step back first
  ON_HIM = 1.2,        -- too close to turn away: shove instead
  BITE = 1.5,          -- a zombie bites from here, so swing even if the weapon is shorter
  CHASE_MAX = 6,
  UNAWARE_R = 2,       -- a zombie that is not chasing is left alone unless this close
  BLOCK_R = 4,         -- or this close and in the way of the walk
  BACKOFF = 3,
  HOLD_R = 12,
  HOLD_SCAN = 6,
  HOLD_MAX = 1800,     -- ticks of holding with nothing coming before giving the spot up
  END_LOW = 0.3,
  PANIC_MAX = 3,
  HEAVY_MAX = 2,
  TIRED_MAX = 3,
}

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

-- Same weapon pick and range as inMeleeReach. 0 when bare handed or holding a gun.
function Reflex.weaponReach(p)
  local reach = 0
  pcall(function()
    local weapon = p:getPrimaryHandItem()
    local using = p:getUseHandWeapon()
    if using and not using:isRanged() then weapon = using end
    if not weapon or not weapon:IsWeapon() or weapon:isRanged() or weapon:isBareHands() then return end
    reach = weapon:getMaxRange(p) * weapon:getRangeMod(p)
  end)
  return tonumber(reach) or 0
end

-- One attack, started the way the game's own keys start it. The game reads doShove when the
-- attack starts: the shove key sets it true (IsoPlayer.updateInternal2), and the attack turns
-- into a stomp by itself when the best target is on the floor (CombatManager.calculateAttackVars,
-- isDoStomp is doShove and aimAtFloor). So a stomp is a shove next to a downed zombie.
-- Set it false before a swing: a leftover true would turn the swing into a shove.
-- StopAllActionQueue cuts off a swing that already started, so never start over one.
function Reflex.attack(p, z, shove)
  if z then pcall(function() p:faceThisObject(z) end) end
  local started = false
  pcall(function() started = p:isAttackStarted() end)
  if started then return true end
  ISTimedActionQueue.clear(p)
  LS.travel.active = false
  local shoving = false
  if shove then
    local allowed = true
    pcall(function() allowed = p:isAuthorizeShoveStomp() end)
    if allowed ~= false then
      shoving = pcall(function() p:setDoShove(true) end)
    end
  end
  if not shoving then pcall(function() p:setDoShove(false) end) end
  local ok, err = pcall(function() p:DoAttack(0) end)
  if not ok then LS.lastError = "fight:" .. tostring(err) end
  return shoving
end

-- One walk in. Clearing the queue on every close tick restarts the path.
function Reflex.closeIn(p, z, d, thought)
  local hud = LS.hudData
  hud.action = "ENGAGING"
  hud.thought = thought or "One ahead. Closing in to take it down."
  pcall(function() p:faceThisObject(z) end)
  if R.closingIn and not LS.travel.active and Move.queuedWalkOnly(p) then return end
  local dx, dy = z:getX() - p:getX(), z:getY() - p:getY()
  local len = math.max(1, math.sqrt(dx * dx + dy * dy))
  local step = math.min(d, Reflex.N.CHASE_MAX)
  ISTimedActionQueue.clear(p)
  LS.travel.active = false
  local stepped = Move.stepWalk(p, math.floor(dx / len * step + 0.5), math.floor(dy / len * step + 0.5))
  R.closingIn = stepped and true or false
end

-- Swing if it is in reach, otherwise walk in.
function Reflex.engage(p, z, d)
  if Reflex.inMeleeReach(p, z, d) or (Reflex.zombieOnHim(d) and Core.holdingMelee(p)) then
    R.closingIn = false
    Reflex.attack(p, z, false)
    LS.hudData.action = "FIGHT"
    LS.hudData.thought = "On it. Swing and drop this one."
    return
  end
  Reflex.closeIn(p, z, d)
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

-- Unit vector away from the given zombies, nearer ones pushing harder. Falls back to straight
-- away from the nearest so a perfectly balanced pair still gives a heading.
local function awayFrom(zs, radius, standingOnly, nearestIdx)
  local fx, fy = 0, 0
  for _, z in ipairs(zs) do
    local d = tonumber(z.d) or 9999
    if d <= radius and d > 0.1 and not (standingOnly and z.isDown) then
      local w = (radius - d) / radius
      fx = fx - (z.dx / d) * w
      fy = fy - (z.dy / d) * w
    end
  end
  local len = math.sqrt(fx * fx + fy * fy)
  if len < 0.01 and nearestIdx then
    local z = zs[nearestIdx]
    fx, fy = -z.dx, -z.dy
    len = math.sqrt(fx * fx + fy * fy)
  end
  if len < 0.01 then return 0, 0 end
  return fx / len, fy / len
end

local function gateReason(snap)
  local N = Reflex.N
  if (tonumber(snap.endurance) or 1) < N.END_LOW then return "winded" end
  if (tonumber(snap.panic) or 0) >= N.PANIC_MAX then return "panic" end
  if (tonumber(snap.heavy) or 0) >= N.HEAVY_MAX then return "heavy" end
  if (tonumber(snap.tired) or 0) >= N.TIRED_MAX then return "tired" end
  return nil
end

-- The fight brain. Pure: reads only snap and the flags, touches no game object.
-- snap.zombies: list of { d, dx, dy, down, crawl, chase, outside }, dx,dy from player to zombie.
-- snap also has armed, reach, shortBlade, hp, endurance (0..1), panic, heavy, tired (moodle
-- levels), inside, hold ({dx, dy} to a spot inside a door or window, or nil), heading ({dx, dy}
-- of the current walk, or nil), flags (defaults to LocalSurvivor.combat).
-- Returns { kind, index, dx, dy, why }. kind is stomp, swing, shove, backoff, flee, hold, close
-- or none. index points into snap.zombies.
function Reflex.decide(snap)
  snap = snap or {}
  local N = Reflex.N
  local flags = snap.flags or LS.combat or {}
  local function on(key) return flags[key] ~= false end
  local zs = {}
  for _, z in ipairs(snap.zombies or {}) do
    local d = tonumber(z.d) or 9999
    local entry = { d = d, dx = tonumber(z.dx) or 0, dy = tonumber(z.dy) or 0, chase = z.chase, outside = z.outside }
    -- Stomping off means downed zombies are fought like any other, the way it was before.
    -- One lying outside while he is inside cannot be reached through the wall.
    entry.isDown = on("stomp") and (z.down or z.crawl) and true or false
    entry.canStomp = entry.isDown and not (snap.inside and z.outside)
    table.insert(zs, entry)
  end

  local near, nearD = nil, 9999
  local stand, standD = nil, 9999
  local standIn, standInD = nil, 9999
  local down, downD = nil, 9999
  local swarm, close2 = 0, 0
  for i, z in ipairs(zs) do
    if z.d < nearD then near, nearD = i, z.d end
    if z.d <= N.SWARM_R then swarm = swarm + 1 end
    if z.isDown then
      if z.canStomp and z.d < downD then down, downD = i, z.d end
    else
      if z.d < standD then stand, standD = i, z.d end
      if not z.outside and z.d < standInD then standIn, standInD = i, z.d end
      if z.d <= N.SPACING_R then close2 = close2 + 1 end
    end
  end
  local NONE = { kind = "none" }
  if not near or nearD > N.RANGE then return NONE end

  local function act(kind, index, why, dx, dy)
    return { kind = kind, index = index, why = why, dx = dx, dy = dy }
  end
  local function flee(why)
    local fx, fy = awayFrom(zs, 22, false, near)
    return act("flee", near, why, fx, fy)
  end
  local function backoff(why)
    local fx, fy = awayFrom(zs, N.SWARM_R, true, stand or near)
    return act("backoff", stand or near, why, fx, fy)
  end

  if (tonumber(snap.hp) or 100) < N.HP_FLEE then
    if nearD <= Core.FLEE_TRIGGER then return flee("hurt") end
    return NONE
  end
  if swarm >= N.SWARM_N then return flee("pack") end
  if not on("spacing") and nearD <= Core.FLEE_INTERRUPT and swarm >= 2 then return flee("cornered") end

  -- Stomp: no weapon wear, no swing. Only while nothing standing is close enough to grab him.
  if down and standD > N.STOMP_CLEAR then
    if downD <= N.STOMP_REACH then return act("stomp", down) end
    if downD <= N.DOWN_CLOSE then return act("close", down, "down") end
  end

  -- Inside with one coming from outside: let it come through the opening and fall.
  -- Hit it as it climbs if it is already in reach. One standing inside is a normal fight.
  if on("doorHold") and snap.inside and snap.hold and standInD > N.STOMP_CLEAR then
    local comer = nil
    for i, z in ipairs(zs) do
      if z.chase and z.outside and z.d <= N.HOLD_R and (not comer or z.d < zs[comer].d) then comer = i end
    end
    local inReach = stand and snap.armed and (standD < (tonumber(snap.reach) or 0) or standD <= N.BITE)
    if comer and not inReach then
      return act("hold", comer, nil, tonumber(snap.hold.dx) or 0, tonumber(snap.hold.dy) or 0)
    end
  end

  -- An unaware zombie is sneaked past, not fought, unless it is close or in the way.
  local hx, hy, hl = 0, 0, 0
  if snap.heading then
    hx, hy = tonumber(snap.heading.dx) or 0, tonumber(snap.heading.dy) or 0
    hl = math.sqrt(hx * hx + hy * hy)
  end
  local function worthFighting(z)
    if z.chase ~= false or z.d <= N.UNAWARE_R then return true end
    return hl > 0.01 and z.d <= N.BLOCK_R and (hx * z.dx + hy * z.dy) / (hl * z.d) > 0.7
  end
  stand, standD = nil, 9999
  for i, z in ipairs(zs) do
    if not z.isDown and z.d < standD and worthFighting(z) then stand, standD = i, z.d end
  end
  if not stand then return NONE end

  -- Bare hands lose a trade of blows. One on him alone can still be shoved down and stomped.
  if not snap.armed then
    if standD <= N.ON_HIM and swarm <= 1 then return act("shove", stand, "unarmed") end
    if standD <= Core.FLEE_TRIGGER then return flee("unarmed") end
    return NONE
  end

  if on("gates") then
    local why = gateReason(snap)
    if why then
      if standD <= N.ON_HIM then return act("shove", stand, why) end
      return backoff(why)
    end
  end

  if on("spacing") and close2 >= 2 then
    if standD <= N.ON_HIM then return act("shove", stand, "spacing") end
    return backoff("spacing")
  end

  -- A knife does not win a chase. Open the gap until the zombie is close enough to hit.
  if snap.shortBlade and standD > N.BITE then
    local fx, fy = awayFrom(zs, 22, false, stand)
    return act("flee", stand, "short", fx, fy)
  end
  if standD < (tonumber(snap.reach) or 0) or standD <= N.BITE then return act("swing", stand) end
  if standD <= N.CHASE_MAX then return act("close", stand) end
  return NONE
end

-- The nearest door or window that opens from his room to the outside, and the tile one step
-- in from the tile just inside it. A zombie that climbs in falls on the tile just inside,
-- next to him: in stomp reach, and he is not standing where hands come through.
function Reflex.findHoldSpot(p, zx, zy)
  local best, bestD = nil, 9999
  pcall(function()
    local cell = getCell()
    local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
    local r = Reflex.N.HOLD_SCAN
    for x = px - r, px + r do
      for y = py - r, py + r do
        local sq = cell:getGridSquare(x, y, pz)
        local objs = sq and sq:getObjects()
        if objs then
          for i = 0, objs:size() - 1 do
            local o = objs:get(i)
            if instanceof(o, "IsoDoor") or instanceof(o, "IsoWindow") then
              local north = false
              pcall(function() north = o:getNorth() end)
              -- A north opening sits on the edge between y and y-1, a west one between x and x-1.
              local ox, oy = 0, -1
              if not north then ox, oy = -1, 0 end
              local other = cell:getGridSquare(x + ox, y + oy, pz)
              local hereIn, otherIn = sq:getRoom() ~= nil, other and other:getRoom() ~= nil
              local inX, inY, stepX, stepY = nil, nil, 0, 0
              if hereIn and other and not otherIn then inX, inY, stepX, stepY = x, y, -ox, -oy
              elseif otherIn and not hereIn then inX, inY, stepX, stepY = x + ox, y + oy, ox, oy end
              if inX then
                local spot = cell:getGridSquare(inX + stepX, inY + stepY, pz)
                if spot and spot:getRoom() ~= nil and Move.canStand(spot) then
                  local d = math.sqrt((x + 0.5 - zx) ^ 2 + (y + 0.5 - zy) ^ 2)
                  if d < bestD then bestD, best = d, { x = inX + stepX, y = inY + stepY } end
                end
              end
            end
          end
        end
      end
    end
  end)
  return best
end

-- Read the game into the plain table decide wants. Each call is its own pcall so one missing
-- method only loses its own field. objs[i] is the zombie object behind snap.zombies[i].
function Reflex.snapshot(p)
  local N = Reflex.N
  local px, py, pz = p:getX(), p:getY(), 0
  pcall(function() pz = p:getZ() end)
  local snap = { zombies = {}, armed = Core.holdingMelee(p), hp = 100, endurance = 1, panic = 0, heavy = 0, tired = 0 }
  local objs = {}
  snap.reach = Reflex.weaponReach(p)
  snap.shortBlade = snap.armed and Reflex.shortBlade(p) or false
  pcall(function() snap.hp = p:getBodyDamage():getOverallBodyHealth() end)
  pcall(function() snap.endurance = p:getStats():get(CharacterStat.ENDURANCE) end)
  pcall(function() snap.panic = p:getMoodles():getMoodleLevel(MoodleType.PANIC) end)
  pcall(function() snap.heavy = p:getMoodles():getMoodleLevel(MoodleType.HEAVY_LOAD) end)
  pcall(function() snap.tired = p:getMoodles():getMoodleLevel(MoodleType.TIRED) end)
  pcall(function() snap.inside = not p:isOutside() end)
  if LS.travel.active then snap.heading = { dx = LS.travel.dx, dy = LS.travel.dy } end
  local chaserOutside = nil
  pcall(function()
    local zl = getCell():getZombieList()
    if not zl then return end
    for i = 0, zl:size() - 1 do
      local z = zl:get(i)
      if Core.zombieAlive(z) then
        local dx, dy = z:getX() - px, z:getY() - py
        local d = math.sqrt(dx * dx + dy * dy)
        local level = true
        pcall(function() level = math.abs(z:getZ() - pz) < 0.5 end)
        -- One on another floor cannot be hit or reach him through the floor.
        if d <= 22 and level then
          local e = { d = d, dx = dx, dy = dy, down = false, crawl = false, outside = false }
          pcall(function() e.down = z:isOnFloor() and true or false end)
          pcall(function() if z:isKnockedDown() then e.down = true end end)
          pcall(function() if z:isFakeDead() then e.down = true end end)
          pcall(function() e.crawl = z:isCrawling() and true or false end)
          pcall(function() e.outside = z:isOutside() and true or false end)
          -- If the target cannot be read, count it as chasing: that is how the reflex treated
          -- every zombie before it could tell.
          local okChase, chase = pcall(function() return z:getTarget() == p end)
          e.chase = (not okChase) or chase and true or false
          table.insert(snap.zombies, e)
          table.insert(objs, z)
          if e.chase and e.outside and d <= N.HOLD_R and (not chaserOutside or d < chaserOutside.d) then
            chaserOutside = { d = d, x = z:getX(), y = z:getY() }
          end
        end
      end
    end
  end)
  local flags = LS.combat or {}
  if snap.inside and chaserOutside and flags.doorHold ~= false and LS.tick >= (R.holdOffUntil or 0) then
    if not R.holdSpot or LS.tick - (R.holdSpotTick or -9999) >= 60 then
      R.holdSpot = Reflex.findHoldSpot(p, chaserOutside.x, chaserOutside.y)
      R.holdSpotTick = LS.tick
    end
    if R.holdSpot then
      snap.hold = { dx = R.holdSpot.x + 0.5 - px, dy = R.holdSpot.y + 0.5 - py }
    end
  else
    R.holdSpot = nil
  end
  return snap, objs
end

local THOUGHTS = {
  stomp = "It's down. Boot to the head before it gets up.",
  shove = "Too close. Shove it off me.",
  shoveUnarmed = "No weapon. Shove it down and stomp.",
  backoff = "Two on me. Stepping back to take them one at a time.",
  winded = "Out of breath. Backing off before the swings go slow.",
  panic = "Hands are shaking. Backing off, I'll miss like this.",
  heavy = "Carrying too much to fight. Backing off.",
  tired = "Too tired to fight well. Backing off.",
  hold = "Holding inside. Let it come through and fall.",
  down = "One's down. Moving in to finish it.",
  short = "Knife is too short. Opening the gap.",
}

-- Walk a few tiles along the heading decide gave, once. A new walk every tick restarts the path.
function Reflex.backOff(p, a)
  if R.backingOff and Move.queuedWalkOnly(p) then return end
  local dx, dy = tonumber(a.dx) or 0, tonumber(a.dy) or 0
  if math.abs(dx) + math.abs(dy) < 0.01 then return end
  local n = Reflex.N.BACKOFF
  ISTimedActionQueue.clear(p)
  LS.travel.active = false
  LS.reflexTick = LS.tick
  R.backingOff = Move.stepWalk(p, math.floor(dx * n + 0.5), math.floor(dy * n + 0.5)) and true or false
end

-- Get to the spot and stand there facing the opening. Only a queued walk is cut, so he can
-- finish what he was doing while he waits.
function Reflex.holdAt(p, a, z)
  local dx, dy = tonumber(a.dx) or 0, tonumber(a.dy) or 0
  if math.sqrt(dx * dx + dy * dy) > 0.75 then
    if R.holdWalk and Move.queuedWalkOnly(p) then return end
    local sq = nil
    pcall(function() sq = getCell():getGridSquare(math.floor(p:getX() + dx), math.floor(p:getY() + dy), math.floor(p:getZ())) end)
    if Move.canStand(sq) then
      ISTimedActionQueue.clear(p)
      LS.travel.active = false
      ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sq))
      R.holdWalk = true
    end
    return
  end
  R.holdWalk = false
  LS.travel.active = false
  if Move.queuedWalkOnly(p) then ISTimedActionQueue.clear(p) end
  if z then pcall(function() p:faceThisObject(z) end) end
end

-- Carry out what decide chose. Returns true when the reflex took the tick.
function Reflex.perform(p, a, snap, objs)
  local hud = LS.hudData
  local kind = a.kind
  local z = a.index and objs[a.index] or nil
  if kind ~= "close" then R.closingIn = false end
  if kind ~= "backoff" then R.backingOff = false end
  if kind ~= "hold" then R.holdWalk = false; R.holdSince = nil end
  if kind == "none" then return false end
  if kind == "swing" then
    Reflex.attack(p, z, false)
    hud.action = "FIGHT"
    hud.thought = "On it. Swing and drop this one."
  elseif kind == "stomp" then
    local stomped = Reflex.attack(p, z, true)
    hud.action = "STOMP (reflex)"
    hud.thought = stomped and THOUGHTS.stomp or "It's down. Hitting it before it gets up."
  elseif kind == "shove" then
    Reflex.attack(p, z, true)
    hud.action = "SHOVE (reflex)"
    hud.thought = a.why == "unarmed" and THOUGHTS.shoveUnarmed or THOUGHTS.shove
  elseif kind == "backoff" then
    Reflex.backOff(p, a)
    hud.action = "BACK OFF (reflex)"
    hud.thought = THOUGHTS[a.why] or THOUGHTS.backoff
  elseif kind == "hold" then
    if not R.holdSince then R.holdSince = LS.tick end
    local quiet = true
    for _, e in ipairs(snap.zombies) do if e.d <= 3 then quiet = false end end
    -- A zombie that never finds the way in must not pin him to the spot for good.
    if quiet and LS.tick - R.holdSince > Reflex.N.HOLD_MAX then
      R.holdOffUntil = LS.tick + Reflex.N.HOLD_MAX
      R.holdSince = nil
      return false
    end
    if not quiet then R.holdSince = LS.tick end
    Reflex.holdAt(p, a, z)
    hud.action = "HOLD (reflex)"
    hud.thought = THOUGHTS.hold
  elseif kind == "close" then
    if z then Reflex.closeIn(p, z, snap.zombies[a.index].d, a.why == "down" and THOUGHTS.down or nil) end
  elseif kind == "flee" then
    if a.why == "short" then
      Move.doMove(p, math.floor((a.dx or 0) * 16 + 0.5), math.floor((a.dy or 0) * 16 + 0.5))
      hud.action = "FLEE (reflex)"
      hud.thought = THOUGHTS.short
    else
      Reflex.reflex(p)
    end
  end
  return true
end

-- Fight, back off or flee on the game clock. Returns true if it took over.
function Reflex.survive(p)
  local snap, objs = Reflex.snapshot(p)
  local nd = 9999
  for _, e in ipairs(snap.zombies) do if e.d < nd then nd = e.d end end
  -- The door escape must not hold the fight off while a zombie is already on him.
  if LS.tick < R.unstickUntil and nd > 2 then return false end
  return Reflex.perform(p, Reflex.decide(snap), snap, objs)
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
-- neighbour that is not across a door. If every neighbour failed, open an unlocked door directly.
-- A locked door is left alone: the walk fails and the skill picks another way in.
-- Only a walk can be stuck. Anything else at the head of the queue (eating, a transfer, a smash,
-- bandaging, sleeping) stands still on purpose and is never cleared here.
function Reflex.releaseDoor(p)
  if LS.tick < R.unstickUntil then return end
  local z, nd = Reflex.nearestZombie(p:getX(), p:getY(), 3)
  if z and nd <= 2 then return end
  local x, y = math.floor(p:getX()), math.floor(p:getY())
  if x ~= R.stuckX or y ~= R.stuckY or not Move.headIsWalk(p) then
    -- The clock restarts when a walk begins, so a long action in place does not count against the next walk.
    R.stuckX, R.stuckY, R.stuckSince = x, y, LS.tick
    return
  end
  if (LS.tick - R.stuckSince) < 90 then return end
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
                local locked = false
                pcall(function() locked = o:isLocked() or o:isLockedByKey() end)
                pcall(function() if not locked and not o:IsOpen() then o:ToggleDoor(p) end end)
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
