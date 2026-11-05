-- The reflex log: every stance the reflex takes, the facts it took it on, and what came of it
-- a few seconds later. Without it we only see deaths, not which escapes work. Lines go to
-- Zomboid/Lua/local_reflex.txt, one JSON object each; the bridge copies them into
-- bridge/decisions.jsonl as reflex lines. The percept carries a small summary (docs/percept.md).
--
--   call  written when the stance changes (or comes back after a quiet spell)
--   out   written OUTCOME_TICKS later: escaped or not, hp lost, hits, kills, still chased
--
-- The pure parts (when to log, the outcome sums, the summary) take plain values. Only flush
-- touches a file.

require "LocalSurvivor/Core"
local LS = LocalSurvivor
LS.ReflexLog = LS.ReflexLog or {}
local Log = LS.ReflexLog
local Core = LS.Core

Log.FILE = "local_reflex.txt"
Log.MAX_BYTES = 262144      -- the file starts again past this
Log.OUTCOME_TICKS = 300     -- 5 seconds after the call
Log.REPEAT_GAP = 120        -- the same stance again after this many quiet ticks is a new call
Log.HIT_WINDOW = 3600       -- "hits in the last minute"
Log.FLUSH_TICKS = 60
Log.MAX_OPEN = 12
Log.MAX_BUF = 40

-- Session state. A new session (game restart) starts the file again: the bridge follows it
-- from its end, so nothing it has not read is lost by that.
if LS.reflexLog == nil then
  LS.reflexLog = { calls = 0, escapes = 0, outs = 0, serial = 0, open = {}, buf = {}, hits = {},
    lost = 0, bytes = 0, fresh = true, lastStance = "NONE", lastWhy = "", lastActTick = -99999,
    flushTick = 0 }
end

local function r1(v) return math.floor((tonumber(v) or 0) * 10 + 0.5) / 10 end

-- Pure. Is this decision a new call? A stance other than NONE that differs from the last one,
-- or the same one again after a quiet spell.
function Log.isNewCall(st, stance, tick)
  if not stance or stance == "NONE" then return false end
  if stance ~= st.lastStance then return true end
  return tick - (st.lastActTick or -99999) > Log.REPEAT_GAP
end

-- Pure. The facts worth keeping about the moment: how many and how close, what she has, what
-- the ground offers. snap is Reflex.snapshot's table.
function Log.facts(snap)
  snap = snap or {}
  local nearest, chasers, standing7, within3, downed, unaware, seen = 9999, 0, 0, 0, 0, 0, 0
  for _, z in ipairs(snap.zombies or {}) do
    local d = tonumber(z.d) or 9999
    if d < nearest then nearest = d end
    local down = z.down or z.crawl
    if down then
      if d <= 3 then downed = downed + 1 end
    else
      if d <= 7 then standing7 = standing7 + 1 end
      if d <= 3 then within3 = within3 + 1 end
      if z.chase ~= false and d <= 10 then
        chasers = chasers + 1
        if z.sees ~= false then seen = seen + 1 end
      elseif z.chase == false and d <= 14 then
        unaware = unaware + 1
      end
    end
  end
  local open = 0
  for _, l in ipairs(snap.lines or {}) do if not l.blocked then open = open + 1 end end
  return {
    near = r1(nearest < 9999 and nearest or -1), chasers = chasers, seen = seen, standing = standing7,
    within3 = within3, downed = downed, unaware = unaware,
    armed = snap.armed and true or false, score = r1(snap.weaponScore), endurance = r1(snap.endurance),
    hp = r1(snap.hp), panic = tonumber(snap.panic) or 0, bleeding = tonumber(snap.bleeding) or 0,
    load = r1(snap.load), inside = snap.inside and true or false,
    door = snap.hold ~= nil, barriers = #(snap.barriers or {}), open = open, lines = #(snap.lines or {}),
    posture = snap.posture or "normal",
  }
end

-- Pure. Got away: nothing chasing within 10 tiles and nothing standing within 3. The same
-- line the bridge uses to hold its orders, so "escaped" means the brain gets her back.
function Log.escaped(f)
  return (tonumber(f.chasers) or 0) == 0 and (tonumber(f.within3) or 0) == 0
end

-- Pure. The outcome line for one call, from what it started with and how things are now.
function Log.outcome(call, now)
  local f = now.facts or {}
  return {
    t = "out", id = call.id, stance = call.stance, act = call.act, why = call.why,
    secs = r1((now.tick - call.tick) / 60),
    escaped = Log.escaped(f), chased = (f.chasers or 0) > 0, near = f.near,
    hpLost = r1(math.max(0, (now.lost or 0) - (call.lost or 0))),
    hits = math.max(0, (now.hitCount or 0) - (call.hitCount or 0)),
    kills = math.max(0, (now.kills or 0) - (call.kills or 0)),
    next = now.stance or "NONE",
    sprint = call.sprintTook,
  }
end

-- Pure. The percept's reflex field.
function Log.summary(st, tick)
  local hits = 0
  for _, h in ipairs(st.hits or {}) do if tick - h <= Log.HIT_WINDOW then hits = hits + 1 end end
  return {
    stance = st.lastStance or "NONE", why = st.lastWhy or "", calls = st.calls or 0,
    escapes = st.escapes or 0, outcomes = st.outs or 0, hits60 = hits,
    level = st.level or 0, posture = LS.posture or "normal",
    age = st.lastActTick and st.lastActTick > -99999 and math.floor((tick - st.lastActTick) / 60) or -1,
  }
end

-- A hit seen by Reflex.watchHealth: body health fell by more than its line in one tick.
function Log.health(drop, tick)
  local st = LS.reflexLog
  if not drop or drop <= 0 then return end
  st.lost = (st.lost or 0) + drop
  if drop > (LS.Reflex and LS.Reflex.HIT_DROP or 0.2) then
    st.hitTotal = (st.hitTotal or 0) + 1
    table.insert(st.hits, tick)
    while #st.hits > 0 and tick - st.hits[1] > Log.HIT_WINDOW do table.remove(st.hits, 1) end
  end
end

local function stamp()
  local s = "0"
  pcall(function() s = tostring(getTimestampMs()) end)
  return s
end

-- One decision from Reflex.survive. Writes a call line when the stance is new, closes the
-- outcomes that are due, and flushes about once a second. kills is getZombieKills now.
function Log.note(a, snap, tick, kills, sprintTook)
  local st = LS.reflexLog
  a = a or {}
  local stance = a.stance or "NONE"
  st.level = a.level or 0
  local facts = nil
  if Log.isNewCall(st, stance, tick) then
    facts = Log.facts(snap)
    st.serial = st.serial + 1
    st.session = st.session or stamp()
    local call = { id = st.session .. "-" .. st.serial, tick = tick, stance = stance, act = a.kind or "none",
      why = a.why or "", lost = st.lost or 0, hitCount = (st.hitTotal or 0), kills = kills or 0 }
    table.insert(st.open, call)
    while #st.open > Log.MAX_OPEN do table.remove(st.open, 1) end
    st.calls = st.calls + 1
    table.insert(st.buf, { t = "call", id = call.id, tick = tick, stance = stance, act = call.act, why = call.why,
      threat = a.threat or 0, level = a.level or 0, f = facts })
    st.lastWhy = call.why
  end
  if stance ~= "NONE" then
    st.lastStance = stance
    st.lastActTick = tick
    -- Whether the game kept her sprinting at least once in this break (docs/combat.md, sprint).
    if stance == "BREAK" and sprintTook ~= nil then
      for _, c in ipairs(st.open) do
        if c.stance == "BREAK" then c.sprintTook = c.sprintTook or sprintTook end
      end
    end
  end
  local keep = {}
  for _, c in ipairs(st.open) do
    if tick - c.tick >= Log.OUTCOME_TICKS then
      facts = facts or Log.facts(snap)
      local out = Log.outcome(c, { tick = tick, facts = facts, lost = st.lost, hitCount = (st.hitTotal or 0),
        kills = kills, stance = stance })
      st.outs = st.outs + 1
      if out.escaped then st.escapes = st.escapes + 1 end
      table.insert(st.buf, out)
    else
      table.insert(keep, c)
    end
  end
  st.open = keep
  while #st.buf > Log.MAX_BUF do table.remove(st.buf, 1) end
  if #st.buf > 0 and (tick - (st.flushTick or 0) >= Log.FLUSH_TICKS or #st.buf >= 20) then Log.flush(tick) end
end

-- Append the waiting lines. The first write of a session, and any write past MAX_BYTES, starts
-- the file again.
function Log.flush(tick)
  local st = LS.reflexLog
  st.flushTick = tick or LS.tick or 0
  if #st.buf == 0 then return end
  local text = ""
  for _, line in ipairs(st.buf) do text = text .. Core.json(line) .. "\n" end
  local fresh = st.fresh or st.bytes + #text > Log.MAX_BYTES
  local ok = pcall(function()
    local w = getFileWriter(Log.FILE, true, not fresh)
    if not w then error("writer nil") end
    w:write(text); w:close()
  end)
  if ok then
    if fresh then st.bytes = 0 end
    st.bytes = st.bytes + #text
    st.fresh = false
    st.buf = {}
  end
end
