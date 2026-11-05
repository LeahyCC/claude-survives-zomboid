-- Movement (fluid). Walk to the FARTHEST LOADED square along a heading, and keep drifting that way
-- between decisions so the body never freezes waiting on the brain.
-- Also the walking pieces the skills in Act.lua share: pathfinder walks, progress, and stuck tiles.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
local LS = LocalSurvivor
LS.Move = LS.Move or {}
local Move = LS.Move
local Core = LS.Core

-- Unstick fires seen from here, newest last: { tick, x, y, walk }.
if LS.unstickLog == nil then LS.unstickLog = {} end
-- The reflex's last unstick deadline we saw, and the head of the queue on the tick before.
if LS.moveWatch == nil then LS.moveWatch = { seenUntil = 0, head = "" } end

Move.NO_PROGRESS = 300       -- ticks without moving half a tile while a walk is queued (~5 s)
Move.UNSTICK_WINDOW = 1800   -- ~30 s
Move.UNSTICK_LIMIT = 3
Move.CLEAR_MIN = 3           -- a straight walk shorter than this is a wall in the face
Move.FAN = { 0, 30, -30, 60, -60, 90, -90 }

-- Far chunks may be unloaded, so instead of halving down to a tiny hop we step the vector down
-- until a square exists: the longest smooth path.
function Move.canStand(sq)
  if not sq then return false end
  local ok, free = pcall(function() return sq:isFree(true) end)
  if not ok then return true end
  return free and true or false
end

function Move.square(x, y, z)
  local sq = nil
  pcall(function() sq = getCell():getGridSquare(math.floor(x), math.floor(y), math.floor(z or 0)) end)
  return sq
end

-- Distance from the player to the middle of tile (x, y).
function Move.distTo(p, x, y)
  local dx, dy = (math.floor(x) + 0.5) - p:getX(), (math.floor(y) + 0.5) - p:getY()
  return math.sqrt(dx * dx + dy * dy)
end

-- A straight walk only works if no wall, door or window sits between any two squares on the
-- line. isBlockedTo is a test between neighbours, so the line is walked one square at a time.
-- A diagonal step is open if either corner is.
function Move.lineClear(x0, y0, x1, y1, z)
  local x, y = x0, y0
  local cur = Move.square(x, y, z)
  if not cur then return false end
  local function open(a, b)
    if not a or not b then return false end
    local blocked = true
    if not pcall(function() blocked = a:isBlockedTo(b) end) then return true end
    return not blocked and Move.canStand(b)
  end
  local steps = math.max(math.abs(x1 - x0), math.abs(y1 - y0))
  for i = 1, steps do
    local nx = x0 + math.floor((x1 - x0) * i / steps + 0.5)
    local ny = y0 + math.floor((y1 - y0) * i / steps + 0.5)
    local nxt = Move.square(nx, ny, z)
    if nx ~= x and ny ~= y then
      local viaX, viaY = Move.square(nx, y, z), Move.square(x, ny, z)
      local ok = (open(cur, viaX) and open(viaX, nxt)) or (open(cur, viaY) and open(viaY, nxt))
      if not ok then return false end
    elseif not open(cur, nxt) then
      return false
    end
    x, y, cur = nx, ny, nxt
  end
  return true
end

function Move.walkTo(p, sq)
  ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sq))
end

-- Free square next to sq the player can stand on, the way vanilla picks one for a container.
function Move.adjacent(p, sq)
  local adj = nil
  pcall(function() adj = AdjacentFreeTileFinder.Find(sq, p) end)
  return adj
end

-- Standable squares around the heading, as the flat x, y, z list pathToNearest takes.
function Move.fanTargets(px, py, pz, dx, dy)
  local len = math.sqrt(dx * dx + dy * dy)
  if len < 0.5 then return {} end
  local reach = math.max(6, math.min(16, len))
  -- Lua 5.3 (the test VM) dropped math.atan2 for a two-argument math.atan.
  local base = (math.atan2 or math.atan)(dy, dx)
  local out = {}
  for _, deg in ipairs(Move.FAN) do
    local a = base + deg * math.pi / 180
    local tx = px + math.floor(math.cos(a) * reach + 0.5)
    local ty = py + math.floor(math.sin(a) * reach + 0.5)
    if Move.canStand(Move.square(tx, ty, pz)) then
      table.insert(out, tx + 0.5)
      table.insert(out, ty + 0.5)
      table.insert(out, pz)
    end
  end
  return out
end

-- route: a brain MOVE. A wall right ahead makes the plain walk press into it, so the pathfinder
-- gets a spread of squares around the heading and goes to the nearest one it can reach.
-- Without route (the reflex) the walk is the old one: the farthest loaded square.
function Move.stepWalk(p, dx, dy, route)
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  dx = math.max(-40, math.min(40, math.floor(tonumber(dx) or 0)))
  dy = math.max(-40, math.min(40, math.floor(tonumber(dy) or 0)))
  if dx == 0 and dy == 0 then return false end
  local far, farI = nil, 0
  for i = 8, 1, -1 do
    local tx = px + math.floor(dx * i / 8 + 0.5)
    local ty = py + math.floor(dy * i / 8 + 0.5)
    local sq = getCell():getGridSquare(tx, ty, pz)
    if Move.canStand(sq) then
      if not route then ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sq)); return true end
      if not far then far, farI = sq, i end
      if Move.lineClear(px, py, tx, ty, pz) then
        local run = math.max(math.abs(tx - px), math.abs(ty - py))
        if run >= Move.CLEAR_MIN or i == farI then ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sq)); return true end
        break
      end
    end
  end
  if route then
    local spots = Move.fanTargets(px, py, pz, dx, dy)
    if #spots > 0 then
      local ok = pcall(function() ISTimedActionQueue.add(ISPathFindAction:pathToNearest(p, spots)) end)
      if ok then return true end
    end
    if far then ISTimedActionQueue.add(ISWalkToTimedAction:new(p, far)); return true end
  end
  LS.lastError = "move: no loaded square along heading"
  return false
end

-- True only when every queued action is a walk. An eat, a smash, or a transfer must not
-- be treated as "already walking" or the new step never starts.
function Move.queuedWalkOnly(p)
  local only = false
  pcall(function()
    local q = ISTimedActionQueue.getTimedActionQueue(p)
    if not q or not q.queue or #q.queue == 0 then return end
    only = true
    for i = 1, #q.queue do
      if q.queue[i].Type ~= "ISWalkToTimedAction" then only = false end
    end
  end)
  return only
end

function Move.headType(p)
  local head = ""
  pcall(function()
    local q = ISTimedActionQueue.getTimedActionQueue(p)
    if q and q.queue and q.queue[1] then head = q.queue[1].Type or "" end
  end)
  return head
end

-- seq is the brain order behind the walk, nil for a reflex flee. Only a brain MOVE routes
-- around walls and can be reported as failed.
function Move.doMove(p, dx, dy, seq)
  local travel = LS.travel
  dx = math.max(-40, math.min(40, math.floor(tonumber(dx) or 0)))
  dy = math.max(-40, math.min(40, math.floor(tonumber(dy) or 0)))
  if dx == 0 and dy == 0 then return end
  -- Same heading, and the queue is only a walk: keep that step. Anything else gets replaced.
  if Move.queuedWalkOnly(p) and travel.active and (dx * travel.dx + dy * travel.dy) > 0 then
    travel.dx, travel.dy, travel.budget = dx, dy, 6
    travel.seq = seq
    return
  end
  ISTimedActionQueue.clear(p)
  travel.active, travel.dx, travel.dy, travel.budget = true, dx, dy, 6
  travel.seq, travel.fails, travel.failed = seq, 0, nil
  travel.fromX, travel.fromY = p:getX(), p:getY()
  Move.stepWalk(p, dx, dy, seq ~= nil)
end

-- momentum: while traveling, if the body finished its segment and the brain hasn't redirected
-- (and nothing's close), keep drifting in the same heading so motion stays continuous.
-- A segment that ended where it started is a failed path. Three in a row and a brain MOVE gives up.
function Move.momentum(p)
  local travel = LS.travel
  if not travel.active or travel.budget <= 0 then return end
  local _, _, zClose = LS.Sense.zombieScan(p:getX(), p:getY())
  if zClose > 0 then return end
  if Core.queueLength(p) > 0 then return end
  local len = math.sqrt(travel.dx * travel.dx + travel.dy * travel.dy)
  if len < 1 then travel.active = false; return end
  if travel.seq and travel.fromX then
    local mx, my = p:getX() - travel.fromX, p:getY() - travel.fromY
    if mx * mx + my * my < 1 then travel.fails = (travel.fails or 0) + 1 else travel.fails = 0 end
    if travel.fails >= 3 then
      travel.active, travel.failed = false, "unreachable"
      return
    end
  end
  travel.budget = travel.budget - 1
  travel.fromX, travel.fromY = p:getX(), p:getY()
  Move.stepWalk(p, math.floor(travel.dx / len * 8 + 0.5), math.floor(travel.dy / len * 8 + 0.5), travel.seq ~= nil)
end

-- ---------- progress and stuck tiles ----------
-- t is any table the caller keeps. Returns the distance to tile (x, y) and the ticks since the
-- body last moved half a tile. Movement, not closeness: a path round a building walks away
-- from the goal for a while and is not stuck.
function Move.progress(t, p, x, y)
  local px, py = p:getX(), p:getY()
  if t.ax == nil or (px - t.ax) ^ 2 + (py - t.ay) ^ 2 >= 0.25 then t.ax, t.ay, t.gainTick = px, py, LS.tick end
  return Move.distTo(p, x, y), LS.tick - (t.gainTick or LS.tick)
end
function Move.resetProgress(t)
  t.ax, t.ay, t.gainTick = nil, nil, LS.tick
end

-- Called every tick. The reflex's unstick helper (Reflex.releaseDoor) pushes unstickUntil out
-- each time it fires. It runs earlier in the tick and clears the queue, so the queue head seen
-- on the previous tick says whether it cut a walk or something else (a transfer, a smash).
-- Returns true on the tick a fire is logged.
function Move.watchUnstick(p)
  local w = LS.moveWatch
  local R = LS.reflexState
  local fired = false
  local untilTick = R and tonumber(R.unstickUntil) or 0
  if untilTick ~= w.seenUntil then
    w.seenUntil = untilTick
    if untilTick > LS.tick then
      local x, y = R.stuckX, R.stuckY
      if x == nil then x, y = math.floor(p:getX()), math.floor(p:getY()) end
      table.insert(LS.unstickLog, { tick = LS.tick, x = x, y = y,
        walk = w.head == "ISWalkToTimedAction" or w.head == "ISPathFindAction" })
      fired = true
    end
  end
  local log = LS.unstickLog
  while #log > 0 and LS.tick - log[1].tick > Move.UNSTICK_WINDOW do table.remove(log, 1) end
  w.head = Move.headType(p)
  return fired
end

-- Three walk fires within the window on the tile of the newest one, counting only fires at
-- or after since.
function Move.stuckHere(since)
  local log = LS.unstickLog
  local last = log[#log]
  if not last or not last.walk then return false end
  local n = 0
  for _, e in ipairs(log) do
    if e.walk and e.tick >= (since or 0) and e.x == last.x and e.y == last.y
      and LS.tick - e.tick <= Move.UNSTICK_WINDOW then n = n + 1 end
  end
  return n >= Move.UNSTICK_LIMIT
end
