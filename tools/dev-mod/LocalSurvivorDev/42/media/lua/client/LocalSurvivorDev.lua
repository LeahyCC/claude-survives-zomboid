-- Test helper for unattended playtests (tools/playtest.ps1).
-- While Zomboid/Lua/ls_autoload.txt starts with "1":
--   main menu : continue the latest save
--   in game   : when player 0 is dead, respawn a random survivor through the game's own screens
-- Without that file it does nothing, so leaving the mod enabled is harmless.

local function flagOn()
  local ok, on = pcall(function()
    local r = getFileReader("ls_autoload.txt", false)
    if not r then return false end
    local line = r:readLine()
    r:close()
    return line ~= nil and string.sub(tostring(line), 1, 1) == "1"
  end)
  return ok and on
end

local function say(msg)
  print("LocalSurvivorDev " .. msg)
end

-- ---------- main menu: continue the latest save ----------
-- A save whose survivor died opens character creation instead of the world, so the same
-- loop also clicks through spawn select, profession and character with a random survivor.
local continued = false
local menuFrames = 0
local menuNext = 0

local function visible(panel)
  local v = false
  pcall(function() v = panel and panel:isVisible() end)
  return v
end

local NEXT = { internal = "NEXT" }
local RANDOM = { internal = "RANDOM" }

local function menuStep()
  menuFrames = menuFrames + 1
  -- MainScreen builds itself over the first frames; calling earlier finds no instance.
  if menuFrames < 180 or menuFrames < menuNext then return end
  menuNext = menuFrames + 30
  if not MainScreen or not MainScreen.instance then return end
  if not flagOn() then return end
  local ms = MainScreen.instance
  if not continued then
    continued = true
    -- The first-time survival guide opens in game and pauses it until someone closes it.
    -- Set in memory only; the game may still write it to options.ini on exit.
    pcall(function() getCore():setOptionShowSurvivalGuide(false) end)
    pcall(function() ms:getLatestSave() end)
    local ok, err = pcall(function()
      MainScreen.continueLatestSave(MainScreen.latestSaveGameMode, MainScreen.latestSaveWorld)
    end)
    say("continue latest save: " .. tostring(ok) .. " " .. tostring(err or ""))
    return
  end
  if MapSpawnSelect and MapSpawnSelect.instance and visible(MapSpawnSelect.instance) then
    local ok, err = pcall(function()
      local lb = MapSpawnSelect.instance.listbox
      if lb and lb.items and #lb.items > 0 and (lb.selected or 0) < 1 then lb.selected = 1 end
      MapSpawnSelect.instance:clickNext()
    end)
    say("menu spawn region: " .. tostring(ok) .. " " .. tostring(err or ""))
    return
  end
  if visible(ms.charCreationProfession) then
    local ok, err = pcall(function() ms.charCreationProfession:onOptionMouseDown(NEXT, 0, 0) end)
    say("menu profession next: " .. tostring(ok) .. " " .. tostring(err or ""))
    return
  end
  if visible(ms.charCreationMain) then
    local ok, err = pcall(function()
      ms.charCreationMain:onOptionMouseDown(RANDOM, 0, 0)
      ms.charCreationMain:onOptionMouseDown(NEXT, 0, 0)
    end)
    say("menu character next: " .. tostring(ok) .. " " .. tostring(err or ""))
    return
  end
end

Events.OnFETick.Add(menuStep)

-- ---------- in game: respawn when dead ----------
-- Character creation pauses the game, so this runs on a tick that fires while paused.
local nextTry = 0
local frames = 0

local function respawnStep()
  frames = frames + 1
  if frames < nextTry then return end
  nextTry = frames + 30
  local p = getSpecificPlayer(0)
  local dead = (not p)
  pcall(function() if p and p:isDead() then dead = true end end)
  if not dead then return end
  if not flagOn() then return end

  local w = CoopCharacterCreation and CoopCharacterCreation.instance
  if not w then
    local ui = ISPostDeathUI and ISPostDeathUI.instance and ISPostDeathUI.instance[0]
    if ui and ui.buttonRespawn and visible(ui.buttonRespawn) then
      local ok, err = pcall(function() ui:onRespawn() end)
      say("respawn pressed: " .. tostring(ok) .. " " .. tostring(err or ""))
    end
    return
  end

  if visible(w.mapSpawnSelect) then
    local ok, err = pcall(function()
      local lb = w.mapSpawnSelect.listbox
      if lb and lb.items and #lb.items > 0 and (lb.selected or 0) < 1 then lb.selected = 1 end
      w.mapSpawnSelect:clickNext()
    end)
    say("spawn region: " .. tostring(ok) .. " " .. tostring(err or ""))
    return
  end
  if visible(w.charCreationProfession) then
    local ok, err = pcall(function() w.charCreationProfession:onOptionMouseDown(NEXT, 0, 0) end)
    say("profession next: " .. tostring(ok) .. " " .. tostring(err or ""))
    return
  end
  if visible(w.charCreationMain) then
    local ok, err = pcall(function()
      w.charCreationMain:onOptionMouseDown(RANDOM, 0, 0)
      w.charCreationMain:onOptionMouseDown(NEXT, 0, 0)
    end)
    say("character next: " .. tostring(ok) .. " " .. tostring(err or ""))
    return
  end
end

Events.OnTickEvenPaused.Add(respawnStep)
