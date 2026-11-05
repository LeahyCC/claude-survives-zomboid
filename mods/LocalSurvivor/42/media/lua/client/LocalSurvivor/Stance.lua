-- The reflex's judgement: how bad is it, and which stance fits. Pure: plain tables in, one
-- decision out, no game object touched, so every rule can be tested without the game.
-- Reflex.snapshot builds the table, Reflex.perform carries the decision out. See docs/combat.md.

require "LocalSurvivor/Core"
local LS = LocalSurvivor
LS.Stance = LS.Stance or {}
local Stance = LS.Stance
local Core = LS.Core

-- Distances are in tiles. Safe to overwrite on a second run. Reflex.N points at this table.
Stance.N = {
  RANGE = 11,          -- the reflex only looks this far; farther is the brain's job
  SWARM_R = 7,         -- this many living zombies inside SWARM_R is a pack
  SWARM_N = 3,
  HP_FLEE = 30,        -- under this, run from anything that is not already on her
  HP_FIGHT = 50,       -- under this, do not start a fight
  STOMP_REACH = 1.0,
  STOMP_CLEAR = 2.5,   -- no standing zombie this close before looking down to stomp
  DOWN_CLOSE = 4,      -- walk over to a downed zombie this close
  SPACING_R = 2,       -- a second standing zombie this close: step back first
  ON_HIM = 1.2,        -- too close to turn away: shove instead
  BITE = 1.5,          -- a zombie bites from here, so swing even if the weapon is shorter
  CHASE_MAX = 6,       -- never walk farther than this to a fight
  UNAWARE_R = 2,       -- a zombie that is not chasing is left alone unless this close
  BLOCK_R = 4,         -- or this close and in the way of the walk
  STEP_R = 4,          -- unfit to fight: step back from a chaser this close instead of running
  FIGHT_MAX = 1,       -- standing chasers within SWARM_R she takes on with a weak weapon
  STRONG = 30,         -- weapon score that takes on two (a crowbar is 30, a bat 34)
  BARRIER_R = 6,       -- a fence or window this close between her and a zombie can be held
  HOLD_N = 2,          -- hold a fence or window against this many at most
  CLIMB_R = 4,         -- climb a fence or window this close to slow the ones behind her
  CLIMB_AWAY = 0.5,    -- the climb must lead this much away from them (a cosine)
  END_SPRINT = 0.5,    -- endurance to try a sprint; under it she runs as she can
  SNEAK_R = 14,        -- sneak while an unaware zombie is this close
  HIDE_NEAR = 4,       -- a chaser that lost sight of her but is this close is not hidden from
  HIDE_STILL = 7,      -- nearer than this she slips away crouched, farther she keeps still
  RUN_STEP = 10,       -- tiles per break or flee walk
  HIDE_STEP = 4,       -- tiles per crouched slip
  BACKOFF = 3,
  HOLD_R = 12,
  HOLD_SCAN = 6,
  HOLD_MAX = 1800,     -- ticks of holding with nothing coming before giving the spot up
  END_LOW = 0.3,
  ESCAPE_TRIES = 3,    -- this many escape tries in a row that ended chased is a loop (ReflexLog.tally)
  STUCK_MAX = 2,       -- the loop rule is for a small chase: this many chasers at most
  STUCK_AWAY = -0.2,   -- in a loop a fence may lead sideways, just not back toward them (a cosine)
  END_SHOVE = 0.3,     -- endurance to stand and shove instead of walking on
  PANIC_MAX = 3,
  HEAVY_MAX = 2,
  TIRED_MAX = 3,
}

-- The brain's posture shifts the fight thresholds. Anything not listed keeps the normal value.
-- avoid: looting or travelling, a fight is a cost. clear: clearing a house, kill what is there.
Stance.POSTURE = {
  normal = {},
  avoid = { CHASE_MAX = 2, UNAWARE_R = 1.2, BLOCK_R = 0, FIGHT_MAX = 1, STRONG = 999, HOLD_N = 1 },
  clear = { CHASE_MAX = 8, UNAWARE_R = 4, BLOCK_R = 6, FIGHT_MAX = 2, SWARM_N = 4, HOLD_N = 3 },
}

-- Pure. A posture name from the order line, cleaned. Anything unknown is normal.
function Stance.posture(name)
  local s = string.lower(tostring(name or ""))
  s = string.gsub(s, "[^a-z]", "")
  if s == "avoidfights" or s == "avoidfight" then s = "avoid" end
  if Stance.POSTURE[s] then return s end
  return "normal"
end

-- Pure. The numbers for a posture: Stance.N with the posture's overrides on top.
function Stance.params(posture)
  local out = {}
  for k, v in pairs(Stance.N) do out[k] = v end
  for k, v in pairs(Stance.POSTURE[Stance.posture(posture)] or {}) do out[k] = v end
  return out
end

-- Which stance each action belongs to, for the log and the HUD.
Stance.OF = {
  swing = "FIGHT", close = "FIGHT", stomp = "FIGHT",
  shove = "SHOVE", backoff = "SHOVE",
  hold = "HOLD", ["break"] = "BREAK", hide = "HIDE", sneak = "SNEAK", climb = "CLIMB", wait = "CLIMB",
  flee = "FLEE", none = "NONE",
}

local function num(v, d) return tonumber(v) or d end

-- Unit vector away from the given zombies, nearer ones pushing harder. Falls back to straight
-- away from the nearest so a perfectly balanced pair still gives a heading.
function Stance.awayFrom(zs, radius, standingOnly, nearestIdx)
  local fx, fy = 0, 0
  for _, z in ipairs(zs) do
    local d = num(z.d, 9999)
    if d <= radius and d > 0.1 and not (standingOnly and z.isDown) then
      local w = (radius - d) / radius
      fx = fx - (z.dx / d) * w
      fy = fy - (z.dy / d) * w
    end
  end
  local len = math.sqrt(fx * fx + fy * fy)
  if len < 0.01 and nearestIdx and zs[nearestIdx] then
    local z = zs[nearestIdx]
    fx, fy = -z.dx, -z.dy
    len = math.sqrt(fx * fx + fy * fy)
  end
  if len < 0.01 then return 0, 0 end
  return fx / len, fy / len
end

-- Pure. The best open line to run along: lines are the compass headings the snapshot found
-- clear for a few tiles. A line is good when it points away from them and no standing zombie
-- sits near it. Without lines (or with none worth taking) it is the plain away vector, which is
-- how the flee always worked. Returns dx, dy (unit) and whether an open line was used.
function Stance.pickLine(lines, zs, ax, ay)
  if type(lines) ~= "table" or #lines == 0 then return ax, ay, false end
  local best, bestScore = nil, -0.3
  for i, l in ipairs(lines) do
    local lx, ly = num(l.dx, 0), num(l.dy, 0)
    local len = math.sqrt(lx * lx + ly * ly)
    if len > 0.01 and not l.blocked then
      lx, ly = lx / len, ly / len
      local score = lx * ax + ly * ay
      for _, z in ipairs(zs) do
        if not z.isDown and z.d > 0.1 and z.d <= 8 and (z.dx * lx + z.dy * ly) / z.d > 0.8 then
          score = score - 2 / math.max(1, z.d)
        end
      end
      if score > bestScore then best, bestScore = i, score end
    end
  end
  if not best then return ax, ay, false end
  local l = lines[best]
  local len = math.sqrt(l.dx * l.dx + l.dy * l.dy)
  return l.dx / len, l.dy / len, true
end

-- The first thing that says she must not start a fight, or nil.
function Stance.gate(snap, N)
  if num(snap.endurance, 1) < N.END_LOW then return "winded" end
  if num(snap.panic, 0) >= N.PANIC_MAX then return "panic" end
  if num(snap.heavy, 0) >= N.HEAVY_MAX then return "heavy" end
  if num(snap.tired, 0) >= N.TIRED_MAX then return "tired" end
  if num(snap.bleeding, 0) > 0 then return "bleeding" end
  if num(snap.hp, 100) < N.HP_FIGHT then return "hurt" end
  return nil
end

-- Pure. The threat assessment: who is where, what she can take on, and one number for how bad
-- it is. threat sums every living zombie in range (a chaser counts most, a downed one least,
-- nearer counts more). Her side is the weapon (score / 40 on top of 1, half for bare hands)
-- times how fit she is. ratio is threat over that, and level buckets it 0 to 4.
function Stance.assess(snap, N)
  snap = snap or {}
  N = N or Stance.params(snap.posture)
  local flags = snap.flags or LS.combat or {}
  local function on(key) return flags[key] ~= false end
  local A = { zs = {}, nearD = 9999, standD = 9999, downD = 9999, chaseD = 9999, unawareD = 9999,
    pack = 0, close2 = 0, chasers = 0, seers = 0, unaware = 0, across = 0, nearSide = 0, threat = 0 }
  for _, z in ipairs(snap.zombies or {}) do
    local e = { d = num(z.d, 9999), dx = num(z.dx, 0), dy = num(z.dy, 0), chase = z.chase, outside = z.outside,
      across = z.across and true or false, crawl = z.crawl and true or false }
    -- Unknown sight counts as seeing her: that is the safe guess.
    e.sees = z.sees ~= false
    -- Stomping off means downed zombies are fought like any other, the way it was before.
    -- One lying outside while she is inside cannot be reached through the wall.
    e.isDown = on("stomp") and (z.down or z.crawl) and true or false
    e.canStomp = e.isDown and not (snap.inside and z.outside)
    table.insert(A.zs, e)
  end
  for i, z in ipairs(A.zs) do
    if z.d < A.nearD then A.near, A.nearD = i, z.d end
    if z.d <= N.SWARM_R then A.pack = A.pack + 1 end
    if z.isDown then
      if z.canStomp and z.d < A.downD then A.down, A.downD = i, z.d end
    else
      if z.d < A.standD then A.stand, A.standD = i, z.d end
      if z.d <= N.SPACING_R then A.close2 = A.close2 + 1 end
      -- Any chaser in the list, near or not, rules out crouching: sneaking is slow.
      if z.chase ~= false then A.chasingAny = true end
      if z.chase ~= false and z.d <= N.RANGE then
        A.chasers = A.chasers + 1
        if z.sees then A.seers = A.seers + 1 end
        if z.d < A.chaseD then A.chaser, A.chaseD = i, z.d end
        if z.d <= N.BARRIER_R then
          if z.across then A.across = A.across + 1 else A.nearSide = A.nearSide + 1 end
        end
      elseif z.chase == false and z.d <= N.SNEAK_R then
        A.unaware = A.unaware + 1
        if z.d < A.unawareD then A.unawareD = z.d end
      end
    end
    if z.d <= N.RANGE then
      local base = z.isDown and (z.crawl and 0.3 or 0.15) or (z.chase ~= false and 1 or 0.3)
      local close = (z.d <= N.BITE and 2) or (z.d <= 4 and 1.5) or (z.d <= N.SWARM_R and 1) or 0.5
      A.threat = A.threat + base * close
    end
  end
  A.armed = snap.armed and true or false
  A.score = num(snap.weaponScore, A.armed and N.STRONG or 0)
  A.gate = on("gates") and Stance.gate(snap, N) or nil
  local fit = 1
  local e, hp = num(snap.endurance, 1), num(snap.hp, 100)
  if e < N.END_LOW then fit = fit * 0.4 elseif e < N.END_SPRINT then fit = fit * 0.75 end
  if hp < N.HP_FLEE then fit = fit * 0.3 elseif hp < N.HP_FIGHT then fit = fit * 0.6 end
  if num(snap.bleeding, 0) > 0 then fit = fit * 0.7 end
  if num(snap.panic, 0) >= N.PANIC_MAX then fit = fit * 0.6 end
  if num(snap.heavy, 0) >= N.HEAVY_MAX then fit = fit * 0.7 end
  if num(snap.tired, 0) >= N.TIRED_MAX then fit = fit * 0.7 end
  A.fit = math.floor(fit * 100 + 0.5) / 100
  local power = A.armed and (1 + A.score / 40) or 0.5
  A.ratio = math.floor(A.threat / (power * fit) * 10 + 0.5) / 10
  if A.threat <= 0 then A.level = 0
  elseif A.ratio < 1 then A.level = 1
  elseif A.ratio < 2 then A.level = 2
  elseif A.ratio < 4 then A.level = 3
  else A.level = 4 end
  A.fightMax = A.score >= N.STRONG and math.max(2, N.FIGHT_MAX) or N.FIGHT_MAX
  A.canFight = A.armed and not A.gate
  return A
end

-- Pure. The nearest fence or window she can climb that puts it between her and the ones after
-- her. A barrier is { kind, dx, dy (to its middle), nx, ny (the way across), d, failed }.
-- Pointless with nobody behind her, and no good with one already waiting on the far side.
function Stance.pickBarrier(snap, A, N, ax, ay)
  local best, bestD = nil, 9999
  for i, b in ipairs(snap.barriers or {}) do
    local d, nx, ny = num(b.d, 9999), num(b.nx, 0), num(b.ny, 0)
    if not b.failed and d <= N.CLIMB_R and d < bestD and nx * ax + ny * ay >= N.CLIMB_AWAY then
      local behind, waiting = 0, false
      for _, z in ipairs(A.zs) do
        if not z.isDown then
          local side = (z.dx - num(b.dx, 0)) * nx + (z.dy - num(b.dy, 0)) * ny
          if side > 0 then
            local ex, ey = z.dx - num(b.dx, 0), z.dy - num(b.dy, 0)
            if math.sqrt(ex * ex + ey * ey) < 4 then waiting = true end
          elseif z.chase ~= false then
            behind = behind + 1
          end
        end
      end
      if behind > 0 and not waiting then best, bestD = i, d end
    end
  end
  return best
end

-- Pure. The decision. snap is the table Reflex.snapshot builds (docs/combat.md lists every
-- field). Returns { kind, stance, index, why, dx, dy, target, threat, level }. kind is what
-- Reflex.perform does, stance is the name it is logged under. The first rule that fits wins.
function Stance.choose(snap)
  snap = snap or {}
  local N = Stance.params(snap.posture)
  local flags = snap.flags or LS.combat or {}
  local function on(key) return flags[key] ~= false end
  local A = Stance.assess(snap, N)
  local zs = A.zs

  local function act(kind, index, why, dx, dy, target)
    return { kind = kind, stance = Stance.OF[kind] or "NONE", index = index, why = why, dx = dx, dy = dy,
      target = target, threat = A.ratio, level = A.level }
  end
  local NONE = act("none")

  -- A climb runs its animation after its action has left the queue. Touching the queue or
  -- starting a walk now would cut it, so wait it out.
  if snap.climbing then return act("wait", nil, "climbing") end

  if not A.near or A.nearD > N.RANGE then
    if not A.chasingAny and A.unaware > 0 then return act("sneak", nil, "unaware") end
    return NONE
  end

  local ax, ay = Stance.awayFrom(zs, 22, false, A.near)
  local lines = snap.lines
  local function run(kind, why, index)
    local dx, dy = Stance.pickLine(lines, zs, ax, ay)
    return act(kind, index or A.chaser or A.near, why, dx, dy)
  end
  local function backoff(why)
    local fx, fy = Stance.awayFrom(zs, N.SWARM_R, true, A.stand or A.near)
    return act("backoff", A.stand or A.near, why, fx, fy)
  end
  -- Get away: over a fence or through a window if one is right there, crouch if they have lost
  -- her, sprint if she has the breath for it, otherwise just run.
  local function getAway(why)
    if on("climb") then
      local b = Stance.pickBarrier(snap, A, N, ax, ay)
      if b and A.standD > N.ON_HIM then
        local bar = snap.barriers[b]
        return act("climb", A.chaser or A.near, why, num(bar.dx, 0), num(bar.dy, 0), b)
      end
    end
    if on("hide") and A.chasers > 0 and A.seers == 0 and A.chaseD > N.HIDE_NEAR then
      if A.chaseD >= N.HIDE_STILL then return act("hide", A.chaser, why, 0, 0) end
      local dx, dy = Stance.pickLine(lines, zs, ax, ay)
      return act("hide", A.chaser, why, dx, dy)
    end
    if num(snap.endurance, 1) >= N.END_SPRINT and num(snap.heavy, 0) < N.HEAVY_MAX then return run("break", why) end
    return run("flee", why)
  end

  -- Getting away, unless that has been tried again and again against a small chase and a
  -- chaser is still there (the 2026-11-05 soak: 35 FLEEs in 33 minutes against one zombie, none
  -- escaped). Then try what can end it: a fence or window even if it leads sideways, or stand
  -- and shove a lone chaser while she has the breath and the health. With neither, walk on
  -- along another line than the last, and mark the decision so the bridge gives the brain a
  -- turn. A door between them is the brain's job: it knows where the buildings are.
  local function escape(why)
    local fails = num(snap.escapeFails, 0)
    local loop = fails >= N.ESCAPE_TRIES and A.chasers >= 1 and A.chasers <= N.STUCK_MAX and A.pack < N.SWARM_N
    if not loop then return getAway(why) end
    local tag = "stuck:" .. tostring(why)
    local function mark(a) a.stuck = fails; return a end
    if on("climb") then
      local M = Stance.params(snap.posture)
      M.CLIMB_AWAY = N.STUCK_AWAY
      local b = Stance.pickBarrier(snap, A, M, ax, ay)
      if b and A.standD > N.ON_HIM then
        local bar = snap.barriers[b]
        return mark(act("climb", A.chaser or A.near, tag, num(bar.dx, 0), num(bar.dy, 0), b))
      end
    end
    -- Shoving with no breath left only gets her bitten, so this needs breath, health, calm
    -- hands and no bleeding. It is the fight gates again, without the weapon.
    local fitToShove = num(snap.endurance, 1) >= N.END_SHOVE and num(snap.hp, 100) >= N.HP_FIGHT
      and num(snap.bleeding, 0) == 0 and num(snap.panic, 0) < N.PANIC_MAX
    if A.chasers == 1 and A.pack <= 1 and fitToShove then
      return mark(act("hold", A.chaser, tag, 0, 0))
    end
    -- Another heading than the run that did not work. Lines carry their compass index.
    if snap.lastDir and type(lines) == "table" then
      local other = {}
      for i, l in ipairs(lines) do
        other[i] = { dx = l.dx, dy = l.dy, dir = l.dir, blocked = l.blocked or l.dir == snap.lastDir }
      end
      lines = other
    end
    local a = getAway(why)
    a.why = tag
    a.handoff = true
    return mark(a)
  end

  -- One on her. Turning to walk away now gets her bitten, so it is a swing or a shove.
  if A.stand and A.standD <= N.ON_HIM then
    if A.canFight and A.close2 <= 1 then return act("swing", A.stand) end
    return act("shove", A.stand, A.armed and (A.gate or "spacing") or "unarmed")
  end

  if num(snap.hp, 100) < N.HP_FLEE then
    if A.nearD <= Core.FLEE_TRIGGER then return escape("hurt") end
    return NONE
  end

  if A.pack >= N.SWARM_N then
    -- None of them knows she is here: creep away instead of making noise.
    if not A.chasingAny then
      local dx, dy = Stance.pickLine(snap.lines, zs, ax, ay)
      return act("sneak", A.near, "pack", dx, dy)
    end
    return escape("pack")
  end
  if not on("spacing") and A.nearD <= Core.FLEE_INTERRUPT and A.pack >= 2 then
    local fx, fy = Stance.awayFrom(zs, 22, false, A.near)
    return act("flee", A.near, "cornered", fx, fy)
  end

  -- Stomp: no weapon wear, no swing. Only while nothing standing is close enough to grab her.
  if A.down and A.standD > N.STOMP_CLEAR then
    if A.downD <= N.STOMP_REACH then
      local a = act("stomp", A.down)
      if not A.canFight then a.stance = "SHOVE" end
      return a
    end
    if A.downD <= N.DOWN_CLOSE then return act("close", A.down, "down") end
  end

  -- Inside with one coming from outside: let it come through the opening and fall. Hit it as
  -- it climbs if it is already in reach. One standing inside is a normal fight.
  local inReach = A.stand and A.armed and (A.standD < num(snap.reach, 0) or A.standD <= N.BITE)
  if on("doorHold") and snap.inside and snap.hold then
    local standIn = 9999
    for _, z in ipairs(zs) do
      if not z.isDown and not z.outside and z.d < standIn then standIn = z.d end
    end
    if standIn > N.STOMP_CLEAR then
      local comer = nil
      for i, z in ipairs(zs) do
        if z.chase and z.outside and z.d <= N.HOLD_R and (not comer or z.d < zs[comer].d) then comer = i end
      end
      if comer and not inReach then
        return act("hold", comer, "door", num(snap.hold.dx, 0), num(snap.hold.dy, 0))
      end
    end
  end

  -- A low fence or a window between her and them: they come over one at a time and fall.
  if A.canFight and A.across > 0 and A.nearSide == 0 and A.across <= N.HOLD_N then
    if inReach then return act("swing", A.stand, "fence") end
    return act("hold", A.chaser, "fence", 0, 0)
  end

  -- An unaware zombie is sneaked past, not fought, unless it is close or in the way.
  local hx, hy, hl = 0, 0, 0
  if snap.heading then
    hx, hy = num(snap.heading.dx, 0), num(snap.heading.dy, 0)
    hl = math.sqrt(hx * hx + hy * hy)
  end
  local function worthFighting(z)
    if z.chase ~= false or z.d <= N.UNAWARE_R then return true end
    return hl > 0.01 and z.d <= N.BLOCK_R and (hx * z.dx + hy * z.dy) / (hl * z.d) > 0.7
  end
  local stand, standD, worth = nil, 9999, 0
  for i, z in ipairs(zs) do
    if not z.isDown and worthFighting(z) then
      if z.d <= N.SWARM_R then worth = worth + 1 end
      if z.d < standD then stand, standD = i, z.d end
    end
  end
  if not stand then
    if not A.chasingAny and A.unaware > 0 then return act("sneak", nil, "unaware") end
    return NONE
  end

  -- They lost sight of her while she was getting away: stay low and let them wander off.
  local escaping = snap.prev == "BREAK" or snap.prev == "FLEE" or snap.prev == "HIDE" or snap.prev == "CLIMB"
  if on("hide") and A.chasers > 0 and A.seers == 0 and A.chaseD > N.HIDE_NEAR
    and (escaping or A.gate or not A.armed) then
    return escape("lost")
  end
  -- Still getting away from more than she takes on: a pack strung out past SWARM_R is still a
  -- pack. Without this she stopped, they bunched up, and she ran again.
  if escaping and A.chasers > A.fightMax and A.chaseD <= Core.FLEE_TRIGGER then return escape("pack") end

  -- Bare hands lose a trade of blows. One on her was shoved above.
  if not A.armed then
    if standD <= Core.FLEE_TRIGGER then return escape("unarmed") end
    return NONE
  end

  -- Never start a fight winded, badly hurt, bleeding or overloaded. Close in, step back while
  -- getting the breath back. Farther off, get away.
  if A.gate then
    if standD <= N.STEP_R then return backoff(A.gate) end
    if standD <= Core.FLEE_TRIGGER then return escape(A.gate) end
    return NONE
  end

  if on("spacing") and A.close2 >= 2 then return backoff("spacing") end

  -- More standing chasers than this weapon takes on, and no fence or door to take them at.
  if worth > A.fightMax then return escape("outnumbered") end

  -- Told to avoid fights: get away from a chaser before it closes, instead of walking to it.
  if Stance.posture(snap.posture) == "avoid" and standD > N.CHASE_MAX and standD <= Core.FLEE_TRIGGER
    and zs[stand].chase ~= false then
    return escape("avoid")
  end

  -- A knife does not win a chase. Stand and let it come into reach.
  if snap.shortBlade and standD > N.BITE then return act("hold", stand, "short", 0, 0) end
  if standD < num(snap.reach, 0) or standD <= N.BITE then return act("swing", stand) end
  if standD <= N.CHASE_MAX then return act("close", stand) end
  return NONE
end

-- Pure. Whether she should be crouched: hiding, or creeping past ones that have not seen her.
-- age is ticks since that stance was last chosen. Everything else stands, to move and swing
-- at full speed.
function Stance.wantSneak(stance, age)
  if (tonumber(age) or 9999) > 90 then return false end
  return stance == "HIDE" or stance == "SNEAK"
end
