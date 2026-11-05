-- The death record. The bridge used to guess a cause from the percepts it happened to see before
-- the end, and the dead percept carried almost nothing, so every real death read "unknown". This
-- keeps the last 10 seconds as one sample a second, and when player 0 dies it writes them out,
-- with a last sample taken at the moment of death, as the "death" field of one final percept and
-- as Zomboid/Lua/local_death.txt. The file survives the next character starting, which the percept
-- does not. The bridge turns the record into a cause (bridge/death.mjs, docs/percept.md).

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
local LS = LocalSurvivor
LS.Death = LS.Death or {}
local Death = LS.Death
local Core = LS.Core
local Sense = LS.Sense

-- Seconds kept. One sample is about 300 bytes, so the record stays near 3 KB.
Death.RING = 10
-- A zombie this close (tiles) is on her. The same line the old guess used.
Death.ADJ_R = 3
-- A reflex action counts as "now" for this many ticks, three seconds.
Death.REFLEX_TICKS = 180

LS.deathRing = LS.deathRing or {}
if LS.deathDone == nil then LS.deathDone = false end

-- Reflex.perform kinds, grouped. hold is its own reading, and hide and sneak (crouched, out of
-- sight) are too. Anything else is none.
local FIGHT = { swing = true, stomp = true, shove = true, close = true }
local FLEE = { flee = true, backoff = true, ["break"] = true, climb = true, wait = true }
local HIDE = { hide = true, sneak = true }

-- Pure. What the reflex was doing: "fight", "flee", "hold", "hide" or "none".
function Death.reflexMode(kind, ageTicks)
  if not kind or (ageTicks or 0) > Death.REFLEX_TICKS then return "none" end
  if FIGHT[kind] then return "fight" end
  if FLEE[kind] then return "flee" end
  if kind == "hold" then return "hold" end
  if HIDE[kind] then return "hide" end
  return "none"
end

-- Pure. Append a sample and keep the newest RING.
function Death.push(ring, sample)
  table.insert(ring, sample)
  while #ring > Death.RING do table.remove(ring, 1) end
  return ring
end

-- Pure. The sample as plain values from the facts the game gave. f holds numbers, booleans and
-- strings only; a missing one stays out of the sample, and the bridge reads a missing key as
-- "not known" rather than zero.
function Death.makeSample(f)
  local s = {}
  local function put(key, v) if v ~= nil then s[key] = v end end
  local function r1(v) return v ~= nil and math.floor(v * 10 + 0.5) / 10 or nil end
  local function r2(v) return v ~= nil and math.floor(v * 100 + 0.5) / 100 or nil end
  put("hp", r1(f.hp))
  put("bleeding", f.bleeding)
  put("wounds", f.wounds)
  put("bite", f.bite)
  put("scratch", f.scratch)
  put("infected", f.infected)
  put("infect", r1(f.infect))
  put("hunger", r2(f.hunger))
  put("thirst", r2(f.thirst))
  put("sick", r2(f.sick))
  put("foodSick", r2(f.foodSick))
  put("poison", r1(f.poison))
  put("temp", r1(f.temp))
  put("zClose", f.zClose)
  put("zAdj", f.zAdj)
  put("zChasing", f.zChasing)
  put("nearest", r1(f.nearest))
  put("inside", f.inside)
  put("z", f.z)
  put("job", f.job)
  put("order", f.order)
  put("status", f.status)
  put("reflex", f.reflex)
  put("stance", f.stance)
  return s
end

-- Pure. The record the bridge reads: who and when, the ring, and the last sample.
function Death.build(meta, ring, final)
  local list = {}
  for i, s in ipairs(ring or {}) do list[i] = s end
  return {
    id = meta.id, day = meta.day, hours = meta.hours, kills = meta.kills,
    x = meta.x, y = meta.y, z = meta.z, text = meta.text,
    ring = list, final = final,
  }
end

-- What the running job is called: a long order (GOTO, ENTER, SEARCH) or a need job (DRINK, SLEEP).
local function jobName()
  local s = LS.skill
  if s and s.verb then return tostring(s.verb) end
  local n = LS.needsJob
  if n and n.verb then return tostring(n.verb) end
  return nil
end

-- One sample from the live game. Every read is guarded alone, so a stat the game does not have
-- only blanks its own key. Cheap enough for once a second.
function Death.gather(p)
  local f = {}
  local function try(key, fn)
    local ok, v = pcall(fn)
    if ok and v ~= nil then f[key] = v end
  end
  local st = nil
  pcall(function() st = p:getStats() end)
  local function stat(name)
    return function() return st:get(CharacterStat[name]) end
  end
  try("hp", function() return p:getBodyDamage():getOverallBodyHealth() end)
  try("hunger", stat("HUNGER"))
  try("thirst", stat("THIRST"))
  try("sick", stat("SICKNESS"))
  try("foodSick", stat("FOOD_SICKNESS"))
  try("poison", stat("POISON"))
  try("infect", stat("ZOMBIE_INFECTION"))
  try("temp", stat("TEMPERATURE"))
  try("infected", function() return p:getBodyDamage():IsInfected() == true end)
  try("z", function() return math.floor(p:getZ()) end)
  try("inside", function() return not p:isOutside() end)

  local body = Sense.summarizeWounds(Sense.bodyFacts(p))
  f.bleeding = body.bleeding
  f.wounds = #body.wounds
  f.bite, f.scratch = false, false
  for _, w in ipairs(body.wounds) do
    if w.bite then f.bite = true end
    if w.scratch then f.scratch = true end
  end

  local px, py = p:getX(), p:getY()
  local _, _, zClose, nearestD = Sense.zombieScan(px, py)
  f.zClose = zClose
  f.nearest = nearestD < 9999 and nearestD or nil
  local zs = Sense.summarizeZombies(Sense.zombieFacts(p, px, py))
  f.zChasing = zs.zChasing
  f.zAdj = 0
  for _, z in ipairs(zs.zList) do if z.d <= Death.ADJ_R then f.zAdj = f.zAdj + 1 end end

  f.job = jobName()
  local r = LS.result or {}
  if r.verb and r.verb ~= "" then f.order, f.status = r.verb, r.status end
  f.reflex = Death.reflexMode(LS.reflexKind, (LS.tick or 0) - (LS.reflexKindTick or -99999))
  -- The reflex stance behind it (docs/combat.md), while it is fresh.
  if LS.reflexStance and (LS.tick or 0) - (LS.reflexStanceTick or -99999) <= Death.REFLEX_TICKS then
    f.stance = LS.reflexStance
  end
  return Death.makeSample(f)
end

-- Once a second while she lives (Sense.writePercept calls this). Never throws.
function Death.sample(p)
  local ok, s = pcall(Death.gather, p)
  if ok and s then Death.push(LS.deathRing, s) end
end

-- A new character: the old ring and record belong to the one who died.
function Death.reset()
  LS.deathRing = {}
  LS.deathRecord = nil
  LS.deathDone = false
end

local function stamp()
  local ts = nil
  pcall(function() ts = getTimestampMs and getTimestampMs() or nil end)
  return tostring(ts or ("t" .. tostring(LS.tick or 0)))
end

-- Called from OnPlayerDeath and from the tick loop's dead check, whichever comes first. Safe to
-- call twice: the second call does nothing until a living character resets it.
function Death.onDeath(p)
  if LS.deathDone then return end
  LS.deathDone = true
  LS.deathTick = LS.tick or 0
  local final = nil
  pcall(function() final = Death.gather(p) end)
  local meta = { id = stamp(), day = 0, hours = 0, kills = 0, x = 0, y = 0, z = 0, text = "" }
  pcall(function() meta.day = getGameTime():getNightsSurvived() end)
  pcall(function() meta.hours = math.floor(p:getHoursSurvived() * 100 + 0.5) / 100 end)
  pcall(function() meta.kills = p:getZombieKills() end)
  pcall(function() meta.x, meta.y, meta.z = math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ()) end)
  -- The game's own line for the death screen. Its wording is the game's, kept as a hint only.
  pcall(function() meta.text = tostring(getGameTime():getDeathString(p) or "") end)
  LS.deathRecord = Death.build(meta, LS.deathRing, final)
  pcall(function()
    local w = getFileWriter("local_death.txt", true, false)
    if not w then error("writer nil") end
    w:write(Core.json(LS.deathRecord)); w:close()
  end)
  -- The final percept goes out now, not at the next 5 second dead tick, which a respawn can beat.
  pcall(function() Sense.writePercept(p) end)
end

-- Events.OnPlayerDeath gives the player. Only player 0 is ours.
function Death.onEvent(player)
  local mine = false
  pcall(function() mine = player ~= nil and player:getPlayerNum() == 0 end)
  if mine then Death.onDeath(player) end
end

return Death
