-- Test helper for unattended playtests (tools/playtest.ps1).
-- While Zomboid/Lua/ls_autoload.txt starts with "1":
--   main menu : continue the latest save
--   in game   : when player 0 is dead, respawn a random survivor through the game's own screens
-- Without that file it does nothing, so leaving the mod enabled is harmless.
--
-- While Zomboid/Lua/ls_loot.txt exists, a world that loads gets much more loot (see "rich loot"
-- at the bottom). Without that file the loot options are never touched.

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

-- Spawn in a random region, not always the first. On the first one every life started in the
-- same town, picked clean by the lives before and full of the zombies they drew (soak
-- 2026-11-05: day 14, 54 around, nothing left to loot near the spawn). The list ends with the
-- game's own "Random" entry, and clickNext rolls a real region for it (MapSpawnSelect.lua).
local function pickRegion(lb)
  if not (lb and lb.items and #lb.items > 0) then return end
  local randomName = nil
  pcall(function() randomName = getText("UI_mapspawn_random") end)
  for i, it in ipairs(lb.items) do
    if randomName and it.item and it.item.name == randomName then lb.selected = i; return end
  end
  lb.selected = ZombRand(#lb.items) + 1
end
-- For the tests.
LocalSurvivorDevSpawn = { pickRegion = pickRegion }
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
      pickRegion(lb)
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
      pickRegion(lb)
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

-- ---------- rich loot (Zomboid/Lua/ls_loot.txt) ----------
-- Lets a playtest watch how she chooses gear when there is plenty to choose from.
--
-- Why this is not just SandboxVars: the loot rolls never read the options. Java copies each
-- option once into a static float (ItemPickerJava.foodLootModifier and the like) inside
-- IsoWorld.init, right after the save's sandbox file is read. So the option is set first and
-- ItemPickerJava.InitSandboxLootSettings() is called to copy it again. Both come from the
-- vanilla game: getSandboxOptions():getOptionByName(...):setValue(...) is what its admin
-- sandbox screen does, and IsoWorld.init itself calls the refresh.
--
-- When: OnLoadedMapZones runs inside IsoWorld.init after that copy and before chunks load.
-- OnGameStart is a second chance, and a no-op if the first one worked.
--
-- The game writes the sandbox options to map_sand.bin when it saves. OnSave puts the old values
-- back first, so the file keeps what the player chose. OnPostSave sets the high values again.
-- The loot rolls keep using the copied floats either way. If OnSave ever fails to run before
-- the write, the high values would be saved with the world.

local LOOT_FLAG = "ls_loot.txt"

-- Each option and the value a test run wants. Every value is clamped to the option's own range.
-- 4 is the loot options' maximum in Build 42.21 (0 to 4, default 0.6); the sandbox screen stops
-- at 3 ("Abundant"). RollsMultiplier rolls each container more times: its tooltip warns it can
-- cost performance, which is fine for a test run. MaximumLooted and MaximumDiminishedLoot empty
-- a share of buildings that grows with the world's age, so an older save looked picked over even
-- with every loot option at 4. Both go to 0.
local LOOT_OPTIONS = {
  { "WeaponLootNew", 4 },          -- melee weapons
  { "RangedWeaponLootNew", 4 },
  { "AmmoLootNew", 4 },
  { "FoodLootNew", 4 },            -- perishable food
  { "CannedFoodLootNew", 4 },      -- non-perishable food
  { "MedicalLootNew", 4 },
  { "SurvivalGearsLootNew", 4 },
  { "ContainerLootNew", 4 },       -- bags
  { "ToolLootNew", 4 },
  { "KeyLootNew", 4 },             -- house keys, which ENTER can use
  { "LiteratureLootNew", 4 },
  { "CookwareLootNew", 4 },
  { "ClothingLootNew", 4 },
  { "MaterialLootNew", 4 },
  { "FarmingLootNew", 4 },
  { "GeneratorLootNew", 4 },
  { "RollsMultiplier", 4 },
  { "MaximumLooted", 0 },
  { "MaximumDiminishedLoot", 0 },
}

local lootState = nil -- set once the options were raised: old and new values, to swap on save

local function fileExists(name)
  local found = false
  pcall(function()
    local r = getFileReader(name, false)
    if r then found = true; r:close() end
  end)
  return found
end

local function lootApply()
  if lootState then return end
  if not fileExists(LOOT_FLAG) then return end
  local state = { old = {}, new = {}, oldVars = {}, missing = {} }
  -- Stored before the first change, so a failure half way can still be undone on save.
  lootState = state
  local okSet, errSet = pcall(function()
    local options = getSandboxOptions()
    for _, row in ipairs(LOOT_OPTIONS) do
      local name, top = row[1], row[2]
      local opt = options:getOptionByName(name)
      if not opt then
        table.insert(state.missing, name)
      else
        pcall(function() local max = opt:getMax(); if max and max < top then top = max end end)
        pcall(function() local min = opt:getMin(); if min and min > top then top = min end end)
        state.old[name] = opt:getValue()
        opt:setValue(top)
        state.new[name] = opt:getValue()
        -- The Lua table is what updateFromLua() copies back into the options, so keep it in step.
        if SandboxVars then
          state.oldVars[name] = SandboxVars[name]
          SandboxVars[name] = state.new[name]
        end
      end
    end
  end)
  local okRefresh, errRefresh = pcall(function() ItemPickerJava.InitSandboxLootSettings() end)
  local parts = {}
  for _, row in ipairs(LOOT_OPTIONS) do
    local name = row[1]
    if state.old[name] ~= nil then
      table.insert(parts, name .. " " .. tostring(state.old[name]) .. " to " .. tostring(state.new[name]))
    end
  end
  local line = "loot " .. table.concat(parts, ", ") .. "; refreshed=" .. tostring(okRefresh)
  if #state.missing > 0 then line = line .. "; missing=" .. table.concat(state.missing, ",") end
  if not okSet then line = line .. "; set failed: " .. tostring(errSet) end
  if not okRefresh then line = line .. "; refresh failed: " .. tostring(errRefresh) end
  say(line)
end

-- Put the old values back (raised = false) or the high ones again (raised = true).
local function lootSwap(raised)
  if not lootState then return end
  pcall(function()
    local options = getSandboxOptions()
    for name, old in pairs(lootState.old) do
      local opt = options:getOptionByName(name)
      if opt then opt:setValue(raised and lootState.new[name] or old) end
      if SandboxVars then
        if raised then SandboxVars[name] = lootState.new[name] else SandboxVars[name] = lootState.oldVars[name] end
      end
    end
  end)
end

-- A world loaded after returning to the menu reads its own sandbox file again, so start clean.
Events.OnInitWorld.Add(function() lootState = nil end)
Events.OnLoadedMapZones.Add(lootApply)
Events.OnGameStart.Add(lootApply)
Events.OnSave.Add(function() lootSwap(false) end)
Events.OnPostSave.Add(function() lootSwap(true) end)
