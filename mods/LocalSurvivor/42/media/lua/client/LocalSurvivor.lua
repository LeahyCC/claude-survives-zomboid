-- LocalSurvivor, the body half. A local model plays Project Zomboid.
-- Perception OUT : one-line JSON in  %USERPROFILE%/Zomboid/Lua/local_percept.txt  (~1/s)
-- Intent     IN  : reads  %USERPROFILE%/Zomboid/Lua/local_intent.txt  ->  "SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET"
-- The .txt extension is required. Build 42.20+ getFileWriter only allows ini, cfg, txt, log.
-- Reflex and movement are from claude-survives-zomboid (MIT).
--
-- This file is the entry point. It requires the modules in LocalSurvivor/ and owns the tick loop
-- and the event registration. Everything else lives in the modules (see docs/architecture.md).
--
-- Fluidity : moves walk to the FARTHEST LOADED square along the heading and "momentum" keeps the
--            body drifting in that heading between decisions, so it never freezes waiting on the brain.
-- Reflex   : a live zombie inside 11 tiles is fought or fled on the game clock.
-- HUD      : on-screen overlay (toggle with H) showing action, live thought, vitals, inventory
--            and zombie awareness.
-- All game calls are pcall-guarded; a bridge failure must never take the game down.

require "LocalSurvivor/Core"
require "LocalSurvivor/Sense"
require "LocalSurvivor/Move"
require "LocalSurvivor/Act"
require "LocalSurvivor/Reflex"
require "LocalSurvivor/Needs"
require "LocalSurvivor/HUD"
require "LocalSurvivor/Death"

local LS = LocalSurvivor
local Core = LS.Core

-- Every timer in the mod counts ticks and was tuned near 60 a second. The game's frame cap can be
-- far higher (240 on the dev PC), which made "stuck for 90 ticks" under half a second and had the
-- unstick cutting ordinary walks. So the logic runs at a steady 60 a second whatever the frame rate.
LS.TICK_MS = 1000 / 60

function LS.onTick()
  if getTimestampMs then
    local now = getTimestampMs()
    local last = LS.lastTickMs
    if last and now - last < LS.TICK_MS then return end
    -- Keep the cadence on a fast PC; after a long stall (a load, a pause) start counting afresh.
    if last and now - last < 100 then LS.lastTickMs = last + LS.TICK_MS else LS.lastTickMs = now end
  end
  local hud = LS.hudData
  LS.tick = LS.tick + 1
  local tick = LS.tick
  local p = getSpecificPlayer(0)
  if not p then return end
  if not LS.announced then LS.announced = true; pcall(function() p:Say("Local model online. Let's survive this.") end) end
  if p:isDead() then
    hud.action = "DEAD"
    -- OnPlayerDeath normally got here first. This catches a death the event missed.
    pcall(function() LS.Death.onDeath(p) end)
    if tick % (Core.PERCEPT_EVERY * 5) == 0 then LS.Sense.writePercept(p) end
    return
  end

  -- A living character a few seconds after a death is a new one: forget the old ring. The wait
  -- covers a death event that fires before the dead flag is set.
  if LS.deathDone and tick - (LS.deathTick or 0) > 300 then pcall(function() LS.Death.reset() end) end

  -- track movement for the manual auto-resume
  local px, py = p:getX(), p:getY()
  if LS.lastPX and (math.abs(px - LS.lastPX) + math.abs(py - LS.lastPY) > 0.3) then LS.lastMoveTick = tick end
  LS.lastPX, LS.lastPY = px, py

  if tick % 30 == 0 then
    local out = nil
    pcall(function() out = p:getCurrentSquare():has(IsoFlagType.exterior) end)
    if out ~= nil and out ~= LS.traceOutside then
      if LS.traceOutside ~= nil then
        local job = (LS.skill and LS.skill.verb) or (LS.needsJob and LS.needsJob.verb) or "-"
        Core.trace(out and "went-out" or "went-in", "job=" .. tostring(job) .. " head=" .. tostring(LS.Move.headType(p))
          .. " reflexTick=" .. tostring(tick - LS.reflexTick) .. " at " .. math.floor(px) .. "," .. math.floor(py))
      end
      LS.traceOutside = out
    end
  end

  -- A slice of the place scan every tick, in manual mode too, so the percept stays current.
  pcall(function() LS.Sense.step(p) end)

  if not LS.manualMode then LS.Reflex.releaseDoor(p) end

  if LS.manualMode then
    local qlen = Core.queueLength(p)
    if (tick - LS.lastMoveTick) > Core.MANUAL_IDLE and (tick - LS.lastHumanKeyTick) > Core.MANUAL_IDLE and qlen == 0 then
      LS.manualMode = false
      LS.travel.active = false
      pcall(function() p:Say("I've got it from here.") end)
    else
      hud.action = "MANUAL, you're driving"
      if tick % Core.PERCEPT_EVERY == 0 then LS.Sense.writePercept(p) end
      return
    end
  end

  -- A hit while the clock is fast cannot wait for the 5 tick checks.
  pcall(function() LS.Reflex.watchHealth(p) end)

  -- SURVIVAL first, every ~5 ticks (fight/flee locally, the brain is too slow for this).
  -- NOTE: no auto game-pause. PZ halts OnTick at speed 0 so the mod could never un-pause itself
  -- (it froze the game). The flee reflex handles dire moments instead; pause manually if you want.
  local acted = false
  if tick % 5 == 0 then pcall(function() acted = LS.Reflex.survive(p) end) end
  -- Long orders (GOTO, ENTER, SEARCH, LOOT) step every tick and stand aside while the reflex acts.
  pcall(function() LS.Act.update(p, acted) end)
  -- A long need (drink at a sink, sleep, bandage) steps here and pauses while the reflex acts.
  if tick % 5 == 0 then pcall(function() LS.Needs.update(p, acted) end) end

  -- CROUCH/SNEAK to avoid drawing zombies when they're around but we're not mid-flee; stand tall
  -- (no sneak) while actively escaping so we move at full speed.
  if tick % 30 == 0 then
    local _, nd = LS.Reflex.nearestZombie(px, py, 30)
    -- sneak only at MID range (creep past); never in melee (would cripple attacks) or mid-flee
    local sneak = nd >= 6 and nd < 25 and (tick - LS.reflexTick > 90)
    pcall(function() p:setSneaking(sneak) end)
  end

  if tick % 15 == 0 then pcall(function() LS.Reflex.manageSpeed(p) end)
  elseif tick % 5 == 0 then pcall(function() LS.Reflex.guardSpeed(p) end) end
  if tick % 90 == 0 then pcall(function() LS.Act.manageLight(p) end) end
  if tick % 120 == 0 then pcall(function() LS.Sense.scanBuildings(math.floor(px), math.floor(py), math.floor(p:getZ())) end) end
  -- keep the body moving between decisions so he's never frozen without a reason
  if not acted and tick % 20 == 0 then pcall(function() LS.Move.momentum(p) end) end

  -- VISIBLE "look around" while deliberately observing: turn through the compass every ~0.5s
  -- so a pause reads clearly as scanning, not a freeze. Exaggerated on purpose.
  if LS.observing and not acted then
    if Core.queueLength(p) == 0 and tick % 30 == 0 then
      local rad = (math.floor(tick / 30) % 8) * (math.pi / 4)
      pcall(function() p:faceLocation(px + math.cos(rad) * 4, py + math.sin(rad) * 4) end)
    end
  end

  -- SITUATIONAL AWARENESS: while moving calmly, glance toward the nearest zombie in view so he
  -- visibly tracks threats (and his vision cone covers them) instead of walking oblivious.
  if not acted and tick % 40 == 0 then
    local z, nd = LS.Reflex.nearestZombie(px, py, 22)
    if z and nd > 7 then pcall(function() p:faceThisObject(z) end) end
  end

  if tick % Core.PERCEPT_EVERY == 0 then LS.Sense.writePercept(p) end
  -- A reflex that just fled or swung must not be overwritten by a stale plan on the same tick.
  if not acted and tick % Core.INTENT_EVERY == 0 then LS.Act.pollIntent(p) end
end

-- Events are registered here and nowhere else, once. The handlers go through the namespace so a
-- reloaded file takes effect without a second registration.
if not LS.eventsRegistered then
  LS.eventsRegistered = true
  Events.OnTick.Add(function() LS.onTick() end)
  Events.OnGameStart.Add(function() LS.HUD.start() end)
  Events.OnCreatePlayer.Add(function() LS.HUD.start() end)
  Events.OnKeyPressed.Add(function(key) LS.HUD.onKeyPressed(key) end)
  Events.OnPlayerDeath.Add(function(player) LS.Death.onEvent(player) end)
end
