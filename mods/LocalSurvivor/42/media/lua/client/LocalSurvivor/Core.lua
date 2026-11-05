-- Shared namespace, state, constants and small helpers. Every other module requires this one.
-- State lives on the namespace table, never in a file-local, so two files cannot desync.
-- Every assignment of state is "only when nil", so running this file twice keeps the live values.

LocalSurvivor = LocalSurvivor or {}
local LS = LocalSurvivor
LS.Core = LS.Core or {}
local Core = LS.Core

local function default(key, value)
  if LS[key] == nil then LS[key] = value end
end

-- Debug lines for live runs, in console.txt. Off unless Zomboid/Lua/ls_trace.txt exists, which is
-- looked for once a minute so a run can switch it on or off without a restart.
function Core.trace(tag, msg)
  local now = LS.tick or 0
  if LS.traceCheckedAt == nil or now - LS.traceCheckedAt > 3600 or now < LS.traceCheckedAt then
    LS.traceCheckedAt = now
    local on = false
    pcall(function()
      local r = getFileReader("ls_trace.txt", false)
      if r then on = true; r:close() end
    end)
    LS.traceOn = on
  end
  if LS.traceOn then print("LocalSurvivor trace " .. tostring(tag) .. " " .. tostring(msg)) end
end

-- Constants. Safe to overwrite on a second run.
Core.PERCEPT_EVERY = 60      -- ticks between percept writes (~1s)
Core.INTENT_EVERY  = 45      -- ticks between intent polls (~0.75s)
-- Human override: you can grab the keyboard to help; the AI stands down and auto-resumes
-- once you've stopped (no input AND the body stood still) for MANUAL_IDLE ticks (~10s).
Core.MANUAL_IDLE   = 600
Core.FLEE_TRIGGER   = 8    -- flee only when a threat is genuinely close (was 12, too jumpy)
Core.FLEE_INTERRUPT = 4    -- interrupt a task only when one's basically on him

-- Loop state
default("tick", 0)
default("lastSeq", 0)
default("lastError", "")
default("announced", false)
default("reflexTick", -99999)
default("lastLootTick", -99999)   -- protects an in-progress loot from being interrupted
default("travel", { active = false, dx = 0, dy = 0, budget = 0 })  -- momentum
default("manualMode", false)
default("lastHumanKeyTick", -99999)
default("lastMoveTick", 0)
default("lastPX", nil)
default("lastPY", nil)
default("observing", false)   -- true while the AI is deliberately holding to look around
default("autoSpeed", true)
-- Game speed 0 stops OnTick, so the mod must never pause itself. It could not unpause.
default("nightFast", true)    -- fast forward the night while she waits safely indoors (K toggles)
default("fastCoolUntil", 0)   -- tick before which night fast forward stays off after a snap back

-- Shared with the HUD panel
default("hudData", {
  action = "-", thought = "Booting up. Let's see this body.", say = "", goal = "",
  hp = 100, hunger = 0, thirst = 0, fatigue = 0, panic = 0,
  zNear = 0, zClose = 0, zDist = -1, zDir = "-",
  foods = 0, waters = 0, weapon = "none", room = "", qlen = 0, day = 0, hour = 0,
  lastIntentTick = -9999, seq = 0, visible = true,
})

-- Verb registry. A verb is function(p, args). Other files add theirs here, the dispatcher in
-- Act.lua never changes.
default("verbs", {})

-- What the last order did, as the percept carries it in res. target is what the job works on
-- (a building id, "x,y", an item name) and is left out when there is none. A new order clears
-- it, and done or failed on the same order keeps it, so the bridge can still read it after a
-- restart in the middle of a job.
default("result", { seq = 0, verb = "", status = "idle", why = "" })
function LS.setResult(seq, verb, status, why, target)
  local r = LS.result
  local same = (seq or 0) == r.seq and (verb or "") == r.verb
  r.seq, r.verb, r.status, r.why = seq or 0, verb or "", status or "idle", why or ""
  if target ~= nil then r.target = (target ~= "") and tostring(target) or nil
  elseif not same then r.target = nil end
end

-- Name the running order's target. Ignored when the record already belongs to a newer order.
function LS.aim(seq, target)
  local r = LS.result
  if r.seq == seq then r.target = (target ~= nil and target ~= "") and tostring(target) or nil end
end

-- ---------- string helpers ----------
function Core.esc(s)
  s = tostring(s or "")
  -- JSON forbids every raw control character, tab included, not only line breaks.
  s = s:gsub("\\", "\\\\"); s = s:gsub('"', '\\"'); s = s:gsub("%c", " ")
  return s
end
-- A nil value drops its key from a Lua table, so a field that must print as null holds this.
Core.NULL = Core.NULL or {}
-- Plain Lua value to JSON. Keys are sorted so the same state always prints the same line.
-- An empty table prints as [] because every optional table in the percept is a list.
-- Whole numbers print bare and others to two places, since 0.30000000000000004 is noise to a model.
function Core.json(v)
  local t = type(v)
  if v == nil or v == Core.NULL then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v ~= v or v > 1e300 or v < -1e300 then return "0" end
    if v == math.floor(v) and v > -1e15 and v < 1e15 then return tostring(v) end
    return Core.n2(v)
  end
  if t == "string" then return '"' .. Core.esc(v) .. '"' end
  if t ~= "table" then return "null" end
  local n = #v
  -- Kahlua has no global next, so emptiness is checked with pairs.
  local empty = true
  for _ in pairs(v) do empty = false; break end
  if n > 0 or empty then
    local out = {}
    for i = 1, n do out[i] = Core.json(v[i]) end
    return "[" .. table.concat(out, ",") .. "]"
  end
  local keys, byName = {}, {}
  for k in pairs(v) do
    local name = tostring(k)
    byName[name] = k
    table.insert(keys, name)
  end
  table.sort(keys)
  local out = {}
  for _, name in ipairs(keys) do table.insert(out, '"' .. Core.esc(name) .. '":' .. Core.json(v[byName[name]])) end
  return "{" .. table.concat(out, ",") .. "}"
end
function Core.n2(x) return tostring(math.floor(((tonumber(x) or 0) * 100) + 0.5) / 100) end
function Core.split(s, sep)
  local out, i = {}, 1
  while true do
    local j = string.find(s, sep, i, true)
    if not j then table.insert(out, string.sub(s, i)); break end
    table.insert(out, string.sub(s, i, j - 1)); i = j + 1
  end
  return out
end

-- ---------- game speed ----------
-- The game multiplier behind each speed button, as the vanilla speed keys set it.
Core.SPEED_MULT = { [1] = 1, [2] = 5, [3] = 20, [4] = 40 }
-- Ticks night fast forward stays off after it was cut short, so a zombie pacing the edge of the
-- range cannot flip the clock back and forth.
Core.FAST_COOL = 600

function Core.gameSpeed()
  local ok, cur = pcall(function() return getGameSpeed() end)
  if ok and type(cur) == "number" then return cur end
  return nil
end

-- Set the speed the way the vanilla keys do: the speed and its clock multiplier together.
function Core.setSpeed(n)
  pcall(function() setGameSpeed(n) end)
  pcall(function() getGameTime():setMultiplier(Core.SPEED_MULT[n] or 1) end)
end

-- ISWalkToTimedAction:isValid is false above speed 2, so a walk queued at 3 or 4 is silently
-- dropped. Anything about to queue one calls this first. Returns true if it slowed the game.
-- A pause (0) and a player who switched auto speed off are left alone.
function Core.snapSpeed()
  if not LS.autoSpeed then return false end
  local cur = Core.gameSpeed()
  if not cur or cur <= 2 then return false end
  Core.setSpeed(1)
  LS.fastCoolUntil = (LS.tick or 0) + Core.FAST_COOL
  return true
end

-- Number of queued timed actions for this player.
function Core.queueLength(p)
  local qlen = 0
  pcall(function() local q = ISTimedActionQueue.getTimedActionQueue(p); if q and q.queue then qlen = #q.queue end end)
  return qlen
end

-- ---------- item classification ----------
function Core.isFoodItem(it)
  local food = false
  pcall(function() if it:IsFood() then food = true end end)
  if not food then pcall(function() if it:getCategory() == "Food" then food = true end end) end
  return food
end
function Core.isWaterItem(it)
  local ok, water = pcall(function()
    local fc = it:getFluidContainer()
    if fc and (not fc:isEmpty()) and fc:contains(Fluid.Water) and not fc:contains(Fluid.TaintedWater) then return true end
    return false
  end)
  return ok and water or false
end
-- Rotten, burnt, or poisoned food still counts as Food. Eating it is how a run ends.
-- This is the double-click test from ISInventoryPane.lua. A sealed can is Food with CantEat set,
-- so EAT on it fails. p is optional: without it a known poison is only caught by its power.
function Core.isEdible(it, p)
  local ok = false
  pcall(function() ok = it:IsFood() and it:getHungChange() < 0 end)
  if not ok then return false end
  local bad = false
  pcall(function() if it:getScriptItem():isCantEat() == true then bad = true end end)
  pcall(function() if it:isRotten() then bad = true end end)
  pcall(function() if it:isBurnt() then bad = true end end)
  pcall(function() if it:isbDangerousUncooked() and not it:isCooked() then bad = true end end)
  pcall(function()
    local poison = it:getPoisonPower() or 0
    if poison > 0 then bad = true end
  end)
  if p then pcall(function() if p:isKnownPoison(it) then bad = true end end) end
  return not bad
end
-- Sealed food needs its opening recipe first (a can opener, or a knife for some).
function Core.isSealedFood(it)
  local sealed = false
  pcall(function()
    local recipe = it:getOpeningRecipe()
    sealed = it:IsFood() and recipe ~= nil and recipe ~= ""
  end)
  return sealed
end
-- What looting should still pick up: food to eat now and food to open later.
function Core.isFoodSupply(it)
  return Core.isEdible(it) or Core.isSealedFood(it)
end
-- A flashlight, a water bottle, or bare hands is not a weapon. A gun is the wrong tool here.
function Core.isMeleeWeapon(it)
  if not it then return false end
  local ok = false
  pcall(function()
    if not it:IsWeapon() then return end
    local bare, ranged = false, false
    pcall(function() bare = it:isBareHands() end)
    pcall(function() ranged = it:isRanged() or it:isAimedFirearm() end)
    ok = not bare and not ranged
  end)
  return ok
end
-- The weapon's class from its script Categories (base:axe, base:blunt, ...), checked the way
-- XpUpdate.lua does. A spear or axe wins over blunt when a script lists both. improvised is
-- separate because it rides along with a real class (a plank is improvised and blunt).
local WEAPON_CLASSES = {
  { "spear", "SPEAR" }, { "axe", "AXE" }, { "longblade", "LONG_BLADE" },
  { "blunt", "BLUNT" }, { "smallblunt", "SMALL_BLUNT" }, { "smallblade", "SMALL_BLADE" },
}
function Core.weaponClass(it)
  local cls, improvised = "other", false
  pcall(function()
    local script = it:getScriptItem()
    for _, c in ipairs(WEAPON_CLASSES) do
      local yes = false
      pcall(function() yes = script:containsWeaponCategory(WeaponCategory[c[2]]) == true end)
      if yes then cls = c[1]; break end
    end
    pcall(function() improvised = script:containsWeaponCategory(WeaponCategory.IMPROVISED) == true end)
  end)
  return cls, improvised
end
-- ---------- weapon score ----------
-- Pure. One number for how good a melee weapon is, from plain facts, so two weapons can be
-- compared the same way everywhere (EQUIP, LOOT, DROP, the percept). w = { dmg, crit, reach, two,
-- wt, swing, cond, cls, imp, broken }. dmg is the script's max damage, crit is a percent, cond is
-- 0 to 1, swing is the script's swing time (lower is faster).
--
-- A crowbar scores about 30, a bat 34, an axe 51, a hammer 19, a kitchen knife 9. A pen, fork or
-- spoon does under half a point of damage, so it scores 0 and is never a weapon.
Core.WEAPON = {
  MIN_DMG = 0.5,     -- under this a hit does nothing worth the swing: pens, forks, spoons, scissors
  DMG_CAP = 3,       -- a few scripts list absurd damage; past this the swing is not any better
  MIN_SCORE = 5,     -- under this EQUIP and LOOT ignore it, so a nearly broken knife is not a weapon
  SWAP = 1.25,       -- a new weapon has to beat the one in hand by this much, or he keeps swapping
  CLASS = { axe = 1.1, spear = 1.05, longblade = 1.1, blunt = 1, smallblunt = 0.85, smallblade = 0.6, other = 0.8 },
}

local function clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end

function Core.weaponScore(w)
  if type(w) ~= "table" or w.broken then return 0 end
  local N = Core.WEAPON
  local dmg = tonumber(w.dmg) or 0
  if dmg < N.MIN_DMG then return 0 end
  local cond = clamp(tonumber(w.cond) or 1, 0, 1)
  if cond <= 0 then return 0 end
  -- Damage with the crit chance folded in, then a factor for each thing that helps or hurts.
  local value = math.min(dmg, N.DMG_CAP) * (1 + clamp(tonumber(w.crit) or 0, 0, 100) / 100)
  value = value * clamp((tonumber(w.reach) or 1) / 1.2, 0.5, 1.35)
  value = value * clamp(1 + (3 - (tonumber(w.swing) or 3)) * 0.1, 0.85, 1.2)
  -- Heavy weapons cost endurance on every swing.
  value = value / (1 + 0.08 * math.max(0, (tonumber(w.wt) or 0) - 2))
  if w.two then value = value * 1.05 end
  value = value * (N.CLASS[w.cls or "other"] or N.CLASS.other)
  if w.imp then value = value * 0.85 end
  value = value * (0.4 + 0.6 * cond)
  return math.floor(value * 20 * 10 + 0.5) / 10
end

-- Pure. A real weapon: it scores over the floor EQUIP and LOOT use.
function Core.isRealWeapon(w)
  return type(w) == "table" and (tonumber(w.score) or Core.weaponScore(w)) >= Core.WEAPON.MIN_SCORE
end

-- Plain facts about a melee weapon item, with its score. t is the cached item type from
-- Sense.itemType when the caller has it, so the script lookups are done once per type.
function Core.weaponFacts(it, t)
  local w = { n = "?", dmg = 0, crit = 0, reach = 0, wt = 0, swing = 3, cond = 1, cls = "other", imp = false,
    two = false, broken = false }
  if t and t.wcls then
    w.cls, w.imp, w.two = t.wcls, t.wimp, t.wtwo
  else
    w.cls, w.imp = Core.weaponClass(it)
    pcall(function() w.two = it:isTwoHandWeapon() == true end)
  end
  pcall(function() w.n = it:getDisplayName() end)
  pcall(function() w.dmg = it:getMaxDamage() end)
  pcall(function() w.crit = it:getCriticalChance() end)
  pcall(function() w.reach = it:getMaxRange() end)
  pcall(function() w.wt = it:getActualWeight() end)
  pcall(function() w.swing = it:getSwingTime() end)
  pcall(function() w.broken = it:isBroken() == true end)
  pcall(function()
    local max = it:getConditionMax()
    w.cond = max > 0 and it:getCondition() / max or 1
  end)
  w.score = Core.weaponScore(w)
  return w
end

-- A bag worn on the back (CanBeEquipped = base:back). A fanny pack is a bag too, but not this.
function Core.isBackBag(it)
  local back = false
  pcall(function()
    if not it:IsInventoryContainer() then return end
    local loc = it:canBeEquipped()
    if loc == nil then return end
    back = loc == ItemBodyLocation.BACK or string.find(string.lower(tostring(loc)), "back", 1, true) ~= nil
  end)
  return back
end
function Core.holdingMelee(p)
  local armed = false
  -- The method is on the Java character. A Lua field check never sees it, so call it.
  local ok, err = pcall(function() armed = p:isMeleeWeaponEquipped() end)
  if not ok then LS.lastError = "armed:" .. tostring(err) end
  if not armed then pcall(function() armed = Core.isMeleeWeapon(p:getPrimaryHandItem()) end) end
  if not armed then return false end
  -- The game calls a pen or a fork a melee weapon, but a swing with one does nothing. Count it as
  -- bare hands so the reflex shoves and stomps instead of poking.
  local real = true
  pcall(function() real = Core.isRealWeapon(Core.weaponFacts(p:getPrimaryHandItem())) end)
  return real
end
function Core.zombieAlive(z)
  local dead = false
  pcall(function() if z:isDead() then dead = true end end)
  return not dead
end
