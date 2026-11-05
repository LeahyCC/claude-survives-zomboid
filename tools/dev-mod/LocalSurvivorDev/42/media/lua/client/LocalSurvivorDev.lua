-- Test helper for unattended playtests (tools/playtest.ps1).
-- At the main menu, continue the latest save when Zomboid/Lua/ls_autoload.txt starts with "1".
-- Without that file it does nothing, so leaving the mod enabled is harmless.

local decided = false
local frames = 0

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

local function tryContinue()
  if decided then return end
  frames = frames + 1
  -- MainScreen builds itself over the first frames; calling earlier finds no instance.
  if frames < 180 then return end
  if not MainScreen or not MainScreen.instance then return end
  decided = true
  if not flagOn() then return end
  pcall(function() MainScreen.instance:getLatestSave() end)
  local ok, err = pcall(function()
    MainScreen.continueLatestSave(MainScreen.latestSaveGameMode, MainScreen.latestSaveWorld)
  end)
  print("LocalSurvivorDev continue latest save: " .. tostring(ok) .. " " .. tostring(err or ""))
end

Events.OnFETick.Add(tryContinue)
