-- The real survival engine: local and fast, no brain round-trip. Every 5 ticks it reads the
-- game into a plain snapshot, Stance.choose picks a stance (fight, hold, shove and step, break
-- contact, hide, sneak past, climb, flee), and perform carries it out with the game's own
-- actions. Also gets off a stuck door, and slows or speeds the game clock. See docs/combat.md.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
require "LocalSurvivor/Move"
require "LocalSurvivor/Stance"
require "LocalSurvivor/ReflexLog"
local LS = LocalSurvivor
LS.Reflex = LS.Reflex or {}
local Reflex = LS.Reflex
local Core = LS.Core
local Move = LS.Move
local Stance = LS.Stance

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
-- Added after the first release, so an older live table gets them too.
if R.badLine == nil then R.badLine = {} end
if R.climbTried == nil then R.climbTried = {} end

-- Each part of the fight can be switched off at run time. A key left nil counts as on.
if LS.combat == nil then
  LS.combat = { stomp = true, spacing = true, gates = true, doorHold = true, climb = true, hide = true, sprint = true }
end

-- The thresholds live with the pure stance code. Same table, so a live edit reaches both.
Reflex.N = Stance.N

-- Compass headings for the open lines.
Reflex.DIRS = { { 1, 0 }, { 1, 1 }, { 0, 1 }, { -1, 1 }, { -1, 0 }, { -1, -1 }, { 0, -1 }, { 1, -1 } }
Reflex.LINE_LEN = 6          -- tiles a line must be clear for
Reflex.TERRAIN_TICKS = 30    -- lines and barriers are read again this often, or after a 2 tile move
Reflex.BAD_LINE_TICKS = 300  -- a run that went nowhere keeps its line off the list this long
Reflex.RUN_STUCK = 60        -- a run that has not moved a tile in this many ticks went nowhere
Reflex.CLIMB_ANIM = 120      -- the climb happens in the animation after its action leaves the queue
Reflex.CLIMB_GIVEUP = 300    -- a climb not started by then (the walk failed, the game refused) is dropped
Reflex.CLIMB_AGAIN = 600     -- the same fence or window is not tried again for this long
Reflex.WEAPON_TICKS = 300    -- the weapon score is read again this often

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

-- The fight brain. Pure: reads only snap and the flags, touches no game object. The rules are
-- in Stance.choose; this name stays because the tests and the docs use it.
function Reflex.decide(snap)
  return Stance.choose(snap)
end

-- True when a low fence or a window sits on the edge between two neighbouring squares.
local function barrierEdge(a, b)
  if not a or not b then return false end
  local yes = false
  pcall(function() yes = a:isHoppableTo(b) == true or a:isWindowTo(b) == true end)
  return yes
end

-- Walk the tiles from (x0, y0) to (x1, y1) and say whether a low fence or a window lies on the
-- way. A diagonal step is checked through its x corner, which is close enough for "between".
function Reflex.barrierBetween(x0, y0, x1, y1, z)
  local steps = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
  if steps == 0 then return false end
  local x, y = x0, y0
  local cur = Move.square(x, y, z)
  for i = 1, steps do
    local nx = x0 + math.floor((x1 - x0) * i / steps + 0.5)
    local ny = y0 + math.floor((y1 - y0) * i / steps + 0.5)
    local nxt = Move.square(nx, ny, z)
    if not cur or not nxt then return false end
    if nx ~= x and ny ~= y then
      local via = Move.square(nx, y, z)
      if barrierEdge(cur, via) or barrierEdge(via, nxt) then return true end
    elseif barrierEdge(cur, nxt) then
      return true
    end
    x, y, cur = nx, ny, nxt
  end
  return false
end

-- The compass headings with no wall, door or window for LINE_LEN tiles. A line a run went
-- nowhere on lately is marked blocked, so the next run takes another way.
function Reflex.openLines(p)
  local out = {}
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  for i, d in ipairs(Reflex.DIRS) do
    local n = Reflex.LINE_LEN
    if Move.lineClear(px, py, px + d[1] * n, py + d[2] * n, pz) then
      table.insert(out, { dx = d[1], dy = d[2], dir = i, blocked = LS.tick - (R.badLine[i] or -99999) < Reflex.BAD_LINE_TICKS })
    end
  end
  return out
end

-- The compass index of a heading, or nil when it is not one of the eight.
function Reflex.dirOf(dx, dy)
  local len = math.sqrt(dx * dx + dy * dy)
  if len < 0.01 then return nil end
  for i, d in ipairs(Reflex.DIRS) do
    local dl = math.sqrt(d[1] * d[1] + d[2] * d[2])
    if (dx * d[1] + dy * d[2]) / (len * dl) > 0.99 then return i end
  end
  return nil
end

-- Fences and windows within CLIMB_R she could get over now: low hoppable fences (not the tall
-- ones), and windows or frames the game says she can climb through (open, or the glass gone).
-- Each is an edge between two tiles, stored with its object so perform can climb it.
function Reflex.findBarriers(p)
  local found = {}
  pcall(function()
    local cell = getCell()
    local cx, cy, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
    local r = Stance.N.CLIMB_R
    for x = cx - r, cx + r do
      for y = cy - r, cy + r do
        local sq = cell:getGridSquare(x, y, pz)
        local objs = nil
        if sq then pcall(function() objs = sq:getObjects() end) end
        if objs then
          for i = 0, objs:size() - 1 do
            local o = objs:get(i)
            local kind, north = nil, false
            local isWindow = instanceof(o, "IsoWindow") or instanceof(o, "IsoWindowFrame")
            if not isWindow and instanceof(o, "IsoThumpable") then
              pcall(function() isWindow = o:isWindow() == true end)
            end
            if isWindow then
              local can = false
              pcall(function() can = o:canClimbThrough(p) == true end)
              if can then
                kind = "window"
                pcall(function() north = o:getNorth() == true end)
              end
            else
              local hop, tall = false, false
              pcall(function() hop = o:isHoppable() == true end)
              pcall(function() tall = o:isTallHoppable() == true end)
              if hop and not tall then
                kind = "fence"
                -- The same test vanilla's ISClimbOverFence uses to pick the way over.
                pcall(function() north = sq:has(IsoFlagType.HoppableN) == true end)
              end
            end
            if kind then
              table.insert(found, { kind = kind, x = x, y = y, north = north, obj = o,
                key = x .. "," .. y .. "," .. (north and "n" or "w") })
            end
          end
        end
      end
    end
  end)
  return found
end

-- Pure. Where a barrier edge is from her, and which way is across. A north edge lies between
-- y - 1 and y, a west edge between x - 1 and x (the way the game lays out walls).
function Reflex.edgeFacts(b, px, py)
  local mx, my, nx, ny
  if b.north then
    mx, my = b.x + 0.5, b.y
    nx, ny = 0, (py < b.y) and 1 or -1
  else
    mx, my = b.x, b.y + 0.5
    nx, ny = (px < b.x) and 1 or -1, 0
  end
  local dx, dy = mx - px, my - py
  return { kind = b.kind, dx = dx, dy = dy, d = math.sqrt(dx * dx + dy * dy), nx = nx, ny = ny, key = b.key }
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

-- The weapon in hand's score, read again only when the item changes or now and then (wear).
local function handScore(p)
  local it = nil
  pcall(function() it = p:getPrimaryHandItem() end)
  if not it then return 0 end
  if R.scoreItem ~= it or LS.tick - (R.scoreTick or -99999) >= Reflex.WEAPON_TICKS then
    local s = 0
    pcall(function() s = Core.weaponFacts(it).score end)
    R.scoreItem, R.scoreTick, R.score = it, LS.tick, tonumber(s) or 0
  end
  return R.score or 0
end

-- Read the game into the plain table decide wants. Each call is its own pcall so one missing
-- method only loses its own field. objs[i] is the zombie object behind snap.zombies[i], and
-- objs.barriers[i] the fence or window behind snap.barriers[i].
function Reflex.snapshot(p)
  local N = Reflex.N
  local px, py, pz = p:getX(), p:getY(), 0
  pcall(function() pz = p:getZ() end)
  local snap = { zombies = {}, armed = Core.holdingMelee(p), hp = 100, endurance = 1, panic = 0, heavy = 0, tired = 0,
    bleeding = 0, kills = 0 }
  local objs = {}
  snap.reach = Reflex.weaponReach(p)
  snap.shortBlade = snap.armed and Reflex.shortBlade(p) or false
  snap.weaponScore = snap.armed and handScore(p) or 0
  pcall(function() snap.hp = p:getBodyDamage():getOverallBodyHealth() end)
  pcall(function() snap.bleeding = p:getBodyDamage():getNumPartsBleeding() end)
  pcall(function() snap.endurance = p:getStats():get(CharacterStat.ENDURANCE) end)
  pcall(function() snap.panic = p:getMoodles():getMoodleLevel(MoodleType.PANIC) end)
  pcall(function() snap.heavy = p:getMoodles():getMoodleLevel(MoodleType.HEAVY_LOAD) end)
  pcall(function() snap.tired = p:getMoodles():getMoodleLevel(MoodleType.TIRED) end)
  pcall(function() snap.inside = not p:isOutside() end)
  pcall(function() snap.load = p:getInventoryWeight() / math.max(1, p:getMaxWeight()) end)
  pcall(function() snap.kills = p:getZombieKills() end)
  snap.posture = LS.posture or "normal"
  snap.prev = R.stance
  -- A climb's action leaves the queue at once and the body goes over in the animation after.
  local climbing = LS.tick < (R.climbUntil or 0)
  pcall(function()
    local name = p:getCurrentStateName()
    if name and string.find(tostring(name), "Climb", 1, true) then climbing = true end
  end)
  snap.climbing = climbing
  if LS.travel.active then snap.heading = { dx = LS.travel.dx, dy = LS.travel.dy } end
  local chaserOutside = nil
  local cx, cy, cz = math.floor(px), math.floor(py), math.floor(pz)
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
          -- Does the one after her still see her? Lost sight is how a player shakes them off.
          -- Left unknown (nil) when the game will not say, and unknown counts as seeing.
          if e.chase then pcall(function() e.sees = z:isTargetVisible() == true end) end
          if not e.down and d <= N.BARRIER_R then
            e.across = Reflex.barrierBetween(cx, cy, math.floor(z:getX()), math.floor(z:getY()), cz)
          end
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

  -- The ground only matters with one close. Read it at most twice a second, or after a move.
  local nd = 9999
  for _, e in ipairs(snap.zombies) do if e.d < nd then nd = e.d end end
  if nd <= N.RANGE then
    local t = R.terrain
    local moved = t and ((px - t.x) ^ 2 + (py - t.y) ^ 2 >= 4)
    if not t or moved or LS.tick - t.tick >= Reflex.TERRAIN_TICKS then
      t = { x = px, y = py, tick = LS.tick, lines = Reflex.openLines(p) }
      t.barriers = flags.climb ~= false and Reflex.findBarriers(p) or {}
      R.terrain = t
    end
    -- A run that went nowhere since the lines were read is off the list at once.
    for _, l in ipairs(t.lines) do
      if LS.tick - (R.badLine[l.dir] or -99999) < Reflex.BAD_LINE_TICKS then l.blocked = true end
    end
    snap.lines = t.lines
    snap.barriers, objs.barriers = {}, {}
    for _, b in ipairs(t.barriers) do
      local f = Reflex.edgeFacts(b, px, py)
      -- Tried lately, unless it is the one she is on now. Keeps her from climbing straight back.
      f.failed = b.key ~= R.climbKey and LS.tick - (R.climbTried[b.key] or -99999) < Reflex.CLIMB_AGAIN
      table.insert(snap.barriers, f)
      table.insert(objs.barriers, b)
    end
  else
    R.terrain = nil
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
  bleeding = "I'm bleeding. Not starting a fight like this.",
  hurt = "Hurt too badly to trade blows. Backing off.",
  hold = "Holding inside. Let it come through and fall.",
  holdFence = "Fence between us. Let it climb over and fall.",
  short = "Knife is short. Letting it come to me.",
  down = "One's down. Moving in to finish it.",
  breakContact = "Running to get out of their sight.",
  flee = "Too close, breaking away to open the gap.",
  hideStill = "They lost me. Down low and still.",
  hideSlip = "They lost me. Creeping away low.",
  sneak = "It hasn't seen me. Keeping low.",
  sneakPack = "A group that hasn't seen me. Creeping away.",
  climbFence = "Over the fence. They'll be slow on it.",
  climbWindow = "Through the window. That slows them.",
  climbing = "Climbing.",
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

-- One walk of n tiles along the chosen line. It is kept while it heads the same way, since a
-- new walk every 5 ticks restarts the path. A run that has not moved a tile in RUN_STUCK ticks
-- went nowhere: its line goes off the list and the next decision takes another. That is the
-- flee that stood on one tile for seconds in the 2026-11-04 run.
function Reflex.runAlong(p, a, n)
  local dx, dy = tonumber(a.dx) or 0, tonumber(a.dy) or 0
  if math.abs(dx) + math.abs(dy) < 0.01 then return end
  local px, py = p:getX(), p:getY()
  local run = R.running
  if run and run.n == n and Move.queuedWalkOnly(p) and (dx * run.dx + dy * run.dy) > 0.7 then
    if (px - run.x) ^ 2 + (py - run.y) ^ 2 >= 1 then
      run.x, run.y, run.tick = px, py, LS.tick
    elseif LS.tick - run.tick > Reflex.RUN_STUCK then
      if run.dir then R.badLine[run.dir] = LS.tick end
      Core.trace("run-stuck", "dir=" .. tostring(run.dir) .. " at " .. math.floor(px) .. "," .. math.floor(py))
      R.running = nil
      ISTimedActionQueue.clear(p)
    end
    return
  end
  ISTimedActionQueue.clear(p)
  LS.travel.active = false
  LS.reflexTick = LS.tick
  local dir = Reflex.dirOf(dx, dy)
  local ok = Move.stepWalk(p, math.floor(dx * n + 0.5), math.floor(dy * n + 0.5))
  Core.trace("run", tostring(a.kind) .. " " .. tostring(a.why) .. " dir=" .. tostring(dir) .. " ok=" .. tostring(ok)
    .. " at " .. math.floor(px) .. "," .. math.floor(py))
  if ok then
    R.running = { dx = dx, dy = dy, x = px, y = py, tick = LS.tick, dir = dir, n = n }
  else
    R.running = nil
    if dir then R.badLine[dir] = LS.tick end
  end
end

-- Sprint while breaking contact, and stop as soon as the stance changes. The game sets sprint
-- from the keys every frame (IsoPlayer.updateInternal2), so this may not take. survive reads
-- isSprinting back and the log says whether it did (docs/combat.md).
function Reflex.setSprint(p, on)
  if on and (LS.combat or {}).sprint ~= false then
    pcall(function() p:setSprinting(true) end)
    R.sprintSet = true
  elseif R.sprintSet then
    pcall(function() p:setSprinting(false) end)
    R.sprintSet = false
  end
end

-- Crouch or stand. Sneak is a toggle in the game, so it stays as set.
function Reflex.setSneak(p, on)
  local now = nil
  pcall(function() now = p:isSneaking() end)
  if now == on then return end
  pcall(function() p:setSneaking(on) end)
end

-- Every 30 ticks from the tick loop. Crouched only while the reflex wants it (hiding, or
-- creeping past ones that have not seen her); otherwise stand, to move and swing at full
-- speed. Before this she sneaked whenever a zombie was 6 to 25 tiles off, chasers included.
function Reflex.manageSneak(p)
  Reflex.setSneak(p, Stance.wantSneak(R.stance, LS.tick - (R.stanceTick or -99999)))
end

-- Get over the chosen fence or through the chosen window: walk to the square vanilla picks in
-- front of it, then the game's own climb action. The action ends at once and the body goes
-- over in the animation after it, so once the queue is empty decide waits CLIMB_ANIM ticks.
function Reflex.climb(p, a, snap, objs)
  local b = snap.barriers and snap.barriers[a.target]
  local ob = objs.barriers and objs.barriers[a.target]
  if not b or not ob then return false end
  if R.climbKey ~= ob.key then
    R.climbKey, R.climbAt = ob.key, LS.tick
    R.climbTried[ob.key] = LS.tick
    ISTimedActionQueue.clear(p)
    LS.travel.active = false
    LS.reflexTick = LS.tick
    local spot, here = nil, nil
    pcall(function() spot = AdjacentFreeTileFinder.FindWindowOrDoor(ob.obj:getSquare(), ob.obj, p) end)
    pcall(function() here = p:getCurrentSquare() end)
    if spot and spot ~= here then ISTimedActionQueue.add(ISWalkToTimedAction:new(p, spot)) end
    local ok = pcall(function()
      if ob.kind == "window" then ISTimedActionQueue.add(ISClimbThroughWindow:new(p, ob.obj, 0))
      else ISTimedActionQueue.add(ISClimbOverFence:new(p, ob.obj, nil)) end
    end)
    Core.trace("climb", ob.kind .. " " .. ob.key .. " queued=" .. tostring(ok))
    if not ok then R.climbKey = nil end
    return ok
  end
  if Core.queueLength(p) == 0 then
    R.climbUntil = LS.tick + Reflex.CLIMB_ANIM
    R.climbKey = nil
  elseif LS.tick - (R.climbAt or 0) > Reflex.CLIMB_GIVEUP then
    ISTimedActionQueue.clear(p)
    R.climbKey = nil
    return false
  end
  return true
end

-- Carry out what decide chose. Returns true when the reflex took the tick.
function Reflex.perform(p, a, snap, objs)
  local hud = LS.hudData
  local kind = a.kind
  snap, objs = snap or {}, objs or {}
  local z = a.index and objs[a.index] or nil
  local moving = (tonumber(a.dx) or 0) ~= 0 or (tonumber(a.dy) or 0) ~= 0
  if kind ~= "close" then R.closingIn = false end
  if kind ~= "backoff" then R.backingOff = false end
  if kind ~= "hold" then R.holdWalk = false; R.holdSince = nil end
  if kind ~= "break" and kind ~= "flee" then R.running = nil end
  if kind ~= "hide" then R.hideSince = nil end
  if kind ~= "hide" and kind ~= "sneak" then R.slipWalk = false end
  if kind ~= "climb" and kind ~= "wait" then R.climbKey = nil end
  Reflex.setSprint(p, kind == "break")
  if kind ~= "none" then
    R.stance, R.stanceTick = a.stance or Stance.OF[kind] or "NONE", LS.tick
    -- The death record reads these: what she was doing in her last seconds.
    LS.reflexStance, LS.reflexStanceTick = R.stance, LS.tick
    Reflex.setSneak(p, kind == "hide" or kind == "sneak")
  end
  if kind == "none" then return false end
  -- Creeping past ones that have not seen her: crouch and let the walk go on.
  if kind == "sneak" and not moving then
    hud.thought = THOUGHTS.sneak
    return false
  end
  LS.reflexKind, LS.reflexKindTick = kind, LS.tick
  -- Every branch below may queue a walk, and a walk queued above speed 2 is dropped.
  Core.snapSpeed()
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
    for _, e in ipairs(snap.zombies or {}) do if e.d <= 3 then quiet = false end end
    -- A zombie that never finds the way in must not pin him to the spot for good.
    if quiet and LS.tick - R.holdSince > Reflex.N.HOLD_MAX then
      R.holdOffUntil = LS.tick + Reflex.N.HOLD_MAX
      R.holdSince = nil
      return false
    end
    if not quiet then R.holdSince = LS.tick end
    Reflex.holdAt(p, a, z)
    hud.action = "HOLD (reflex)"
    hud.thought = (a.why == "fence" and THOUGHTS.holdFence) or (a.why == "short" and THOUGHTS.short) or THOUGHTS.hold
  elseif kind == "close" then
    if z then Reflex.closeIn(p, z, snap.zombies[a.index].d, a.why == "down" and THOUGHTS.down or nil) end
  elseif kind == "break" or kind == "flee" then
    Reflex.runAlong(p, a, Reflex.N.RUN_STEP)
    hud.action = kind == "break" and "BREAK CONTACT (reflex)" or "FLEE (reflex)"
    hud.thought = kind == "break" and THOUGHTS.breakContact or THOUGHTS.flee
  elseif kind == "hide" or kind == "sneak" then
    if kind == "hide" then
      if not R.hideSince then R.hideSince = LS.tick end
      -- Long enough. The brain can move her on, still crouched.
      if LS.tick - R.hideSince > Reflex.N.HOLD_MAX then return false end
    end
    if moving then
      if not (R.slipWalk and Move.queuedWalkOnly(p)) then
        ISTimedActionQueue.clear(p)
        LS.travel.active = false
        local n = Reflex.N.HIDE_STEP
        R.slipWalk = Move.stepWalk(p, math.floor(a.dx * n + 0.5), math.floor(a.dy * n + 0.5)) and true or false
      end
    else
      LS.travel.active = false
      if Move.queuedWalkOnly(p) then ISTimedActionQueue.clear(p) end
    end
    hud.action = kind == "hide" and "HIDE (reflex)" or "SNEAK (reflex)"
    hud.thought = (kind == "sneak" and THOUGHTS.sneakPack) or (moving and THOUGHTS.hideSlip) or THOUGHTS.hideStill
  elseif kind == "climb" then
    local b = snap.barriers and snap.barriers[a.target]
    if not Reflex.climb(p, a, snap, objs) then return false end
    hud.action = "CLIMB (reflex)"
    hud.thought = (b and b.kind == "window") and THOUGHTS.climbWindow or THOUGHTS.climbFence
  elseif kind == "wait" then
    hud.action = "CLIMB (reflex)"
    hud.thought = THOUGHTS.climbing
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
  -- Did the sprint set last time survive the game's own input update?
  local sprintTook = nil
  if R.sprintSet then pcall(function() sprintTook = p:isSprinting() == true end) end
  local a = Reflex.decide(snap)
  local acted = Reflex.perform(p, a, snap, objs)
  pcall(function() LS.ReflexLog.note(a, snap, LS.tick, snap.kills, sprintTook) end)
  return acted
end

-- ---------- game speed ----------
-- Night fast forward: speed 3 while she waits out the dark inside, safe and not walking.
Reflex.NIGHT_SPEED = 3
-- Tiles. No zombie nearer than this, and none in sight. It was 20, but in town some zombie is
-- almost always inside 20 tiles, so the night never sped up. One 15 tiles off outside a shut
-- house is no threat, and at speed 3 the 5 tick guard still sees one closing from 8.
Reflex.FAST_CLEAR = 8
Reflex.GENTLE_CLEAR = 60        -- tiles. Speed 2 outside the night rule needs this much room
Reflex.HIT_DROP = 0.2           -- body health lost between two ticks that counts as a hit
-- The orders that leave her standing still. Anything else may walk.
Reflex.CALM_VERBS = { WAIT = true, REST = true, SLEEP = true }
-- The only queued action that may be running while the clock is fast. Sitting down for a REST
-- stays in place. A walk would be dropped above speed 2.
Reflex.IN_PLACE = { ISSitOnGround = true }
-- The bridge treats 21:00 to 06:00 as night (isNight in senses.mjs). Keep the two the same.
Reflex.NIGHT_FROM = 21
Reflex.NIGHT_TO = 6

function Reflex.isNightHour(hour)
  local h = tonumber(hour) or 12
  return h >= Reflex.NIGHT_FROM or h < Reflex.NIGHT_TO
end

-- Pure. f holds the facts speedFacts gathers: manual, nightFast, night, inside, nd (nearest
-- zombie, 9999 if none), chasing, bleeding, cooling, calm. Returns the speed to run at.
-- Today's rule is 2 with 60 tiles of room and 1 otherwise. Night fast forward is the one case
-- that goes above 2, and every condition has to hold.
function Reflex.pickSpeed(f)
  if f.manual then return 1 end
  -- Any hour, not only the night: a wait the brain chose, safe inside, is worth nothing in real
  -- time. At 19:00 she sat out the dusk at speed 1 because the night rule had not started yet.
  if f.nightFast and f.inside and f.calm and not f.cooling
    and f.nd > Reflex.FAST_CLEAR and not f.seen and not f.chasing and not f.bleeding then
    return Reflex.NIGHT_SPEED
  end
  if f.nd > Reflex.GENTLE_CLEAR then return 2 end
  return 1
end

-- Is she standing still on purpose? Asleep counts at once: she cannot walk, and the game runs
-- the clock fast for sleep itself. Otherwise the last order must be a calm one and nothing may
-- be walking: no skill, no needs job other than a REST, no momentum, nothing but a sit queued.
function Reflex.isCalm(p, asleep)
  if asleep then return true end
  if not Reflex.CALM_VERBS[LS.result.verb or ""] then return false end
  if LS.skill ~= nil or LS.travel.active then return false end
  local job = LS.needsJob
  -- A SLEEP job that is not asleep yet is still walking to a bed and shutting the room.
  if job and job.verb ~= "REST" then return false end
  local qlen = Core.queueLength(p)
  return qlen == 0 or (qlen == 1 and Reflex.IN_PLACE[Move.headType(p)] == true)
end

function Reflex.speedFacts(p)
  local f = { nd = 9999, night = false, inside = false, chasing = false, bleeding = false, asleep = false }
  f.manual = LS.manualMode and true or false
  f.nightFast = LS.nightFast ~= false
  f.cooling = LS.tick < LS.fastCoolUntil
  local _, nd = Reflex.nearestZombie(p:getX(), p:getY(), 70)
  f.nd = nd
  pcall(function() f.night = Reflex.isNightHour(getGameTime():getHour()) end)
  pcall(function() f.asleep = p:isAsleep() == true end)
  pcall(function() f.inside = (not p:isOutside()) and p:getSquare():getBuilding() ~= nil end)
  -- The scans below are only worth paying for once everything cheaper says fast forward is on.
  if f.nightFast and f.inside and f.nd > Reflex.FAST_CLEAR then
    pcall(function() f.chasing = LS.Needs.chasing(p) end)
    pcall(function() f.seen = p:getStats():getNumVisibleZombies() > 0 end)
    pcall(function() f.bleeding = p:getBodyDamage():getNumPartsBleeding() > 0 end)
    f.calm = Reflex.isCalm(p, f.asleep)
  else
    f.calm = false
  end
  return f
end

-- auto game-speed: fast-forward the boring safe stretches, snap to normal near danger so the
-- reflex keeps full fidelity. Toggle with G. The user's manual pause (speed 0) always wins.
function Reflex.manageSpeed(p)
  if not LS.autoSpeed then return end
  local cur = Core.gameSpeed()
  if not cur or cur == 0 then return end          -- paused by user -> leave it
  local want = Reflex.pickSpeed(Reflex.speedFacts(p))
  -- Asleep, the game picks its own fast speed. Do not lower it to ours.
  if want == Reflex.NIGHT_SPEED and cur >= want then return end
  if cur == want then return end
  -- Cut short: keep the fast forward off for a while so the clock does not flutter.
  if cur > 2 and want < cur then LS.fastCoolUntil = LS.tick + Core.FAST_COOL end
  Core.setSpeed(want)
end

-- Every tick: a hit is the one danger the 5 tick check is too slow for. Costs one getter.
function Reflex.watchHealth(p)
  local hp = nil
  pcall(function() hp = p:getBodyDamage():getOverallBodyHealth() end)
  if not hp then return end
  local last = R.lastHp
  R.lastHp = hp
  if last and hp < last - Reflex.HIT_DROP then Core.snapSpeed() end
  -- The reflex log counts the hits and the hp lost, for the outcome of each stance.
  if last and hp < last then pcall(function() LS.ReflexLog.health(last - hp, LS.tick) end) end
end

-- Run every 5 ticks while the clock is fast: danger is only seen at the speed it is checked at,
-- and 20 tiles go by quickly at speed 3.
function Reflex.guardSpeed(p)
  local cur = Core.gameSpeed()
  if cur and cur > 2 then Reflex.manageSpeed(p) end
end

-- True while night fast forward is what the clock is running at, for the HUD and the percept.
function Reflex.nightFastOn()
  local cur = Core.gameSpeed()
  return LS.autoSpeed and LS.nightFast ~= false and cur ~= nil and cur > 2
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
