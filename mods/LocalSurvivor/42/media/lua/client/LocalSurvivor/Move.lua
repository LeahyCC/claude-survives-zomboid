-- Movement (fluid). Walk to the FARTHEST LOADED square along a heading, and keep drifting that way
-- between decisions so the body never freezes waiting on the brain.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
local LS = LocalSurvivor
LS.Move = LS.Move or {}
local Move = LS.Move
local Core = LS.Core

-- Far chunks may be unloaded, so instead of halving down to a tiny hop we step the vector down
-- until a square exists: the longest smooth path.
function Move.canStand(sq)
  if not sq then return false end
  local ok, free = pcall(function() return sq:isFree(true) end)
  if not ok then return true end
  return free and true or false
end

function Move.stepWalk(p, dx, dy)
  local px, py, pz = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())
  dx = math.max(-40, math.min(40, math.floor(tonumber(dx) or 0)))
  dy = math.max(-40, math.min(40, math.floor(tonumber(dy) or 0)))
  if dx == 0 and dy == 0 then return false end
  for i = 8, 1, -1 do
    local tx = px + math.floor(dx * i / 8 + 0.5)
    local ty = py + math.floor(dy * i / 8 + 0.5)
    local sq = getCell():getGridSquare(tx, ty, pz)
    if Move.canStand(sq) then ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sq)); return true end
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

function Move.doMove(p, dx, dy)
  local travel = LS.travel
  dx = math.max(-40, math.min(40, math.floor(tonumber(dx) or 0)))
  dy = math.max(-40, math.min(40, math.floor(tonumber(dy) or 0)))
  if dx == 0 and dy == 0 then return end
  -- Same heading, and the queue is only a walk: keep that step. Anything else gets replaced.
  if Move.queuedWalkOnly(p) and travel.active and (dx * travel.dx + dy * travel.dy) > 0 then
    travel.dx, travel.dy, travel.budget = dx, dy, 6
    return
  end
  ISTimedActionQueue.clear(p)
  travel.active, travel.dx, travel.dy, travel.budget = true, dx, dy, 6
  Move.stepWalk(p, dx, dy)
end

-- momentum: while traveling, if the body finished its segment and the brain hasn't redirected
-- (and nothing's close), keep drifting in the same heading so motion stays continuous.
function Move.momentum(p)
  local travel = LS.travel
  if not travel.active or travel.budget <= 0 then return end
  local _, _, zClose = LS.Sense.zombieScan(p:getX(), p:getY())
  if zClose > 0 then return end
  if Core.queueLength(p) > 0 then return end
  local len = math.sqrt(travel.dx * travel.dx + travel.dy * travel.dy)
  if len < 1 then travel.active = false; return end
  travel.budget = travel.budget - 1
  Move.stepWalk(p, math.floor(travel.dx / len * 8 + 0.5), math.floor(travel.dy / len * 8 + 0.5))
end
