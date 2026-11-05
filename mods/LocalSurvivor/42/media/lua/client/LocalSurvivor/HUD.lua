-- On-screen transparency: the panel (toggle with H) and the key handlers. The entry file
-- registers HUD.start and HUD.onKeyPressed with the game, this file registers nothing.

require "ISUI/ISUIElement"
require "LocalSurvivor/Core"
local LS = LocalSurvivor
LS.HUD = LS.HUD or {}
local HUD = LS.HUD

LocalHUD = LocalHUD or ISUIElement:derive("LocalHUD")
function LocalHUD:new()
  local sh = 1080
  pcall(function() sh = getCore():getScreenHeight() end)
  local h = 182
  local o = ISUIElement:new(14, sh - h - 48, 384, h)   -- bottom-left, above the vanilla bars
  setmetatable(o, self); self.__index = self
  return o
end
function LocalHUD:wrap(text, n)
  local out, line = {}, ""
  for word in string.gmatch(tostring(text), "%S+") do
    if #line + #word + 1 > n then table.insert(out, line); line = word
    else line = (line == "") and word or (line .. " " .. word) end
  end
  if line ~= "" then table.insert(out, line) end
  return out
end
function LocalHUD:statusText()
  local data = LS.hudData
  if LS.manualMode then return "MANUAL" end
  if string.find(data.action, "reflex") then return "REFLEX" end
  local since = LS.tick - data.lastIntentTick
  if since < 60 then return "NEW PLAN" end
  if data.qlen > 0 then return "ACTING" end
  return "thinking..."
end
function LocalHUD:bar(label, v, x, y, invert)
  v = math.max(0, math.min(1, v or 0))
  self:drawText(label, x, y - 1, 0.6, 0.66, 0.72, 1, UIFont.Small)
  local bx, bw = x + 32, 46
  self:drawRect(bx, y + 2, bw, 8, 0.5, 0.15, 0.19, 0.23)
  local danger = invert and (v > 0.7) or ((not invert) and (v < 0.3))
  local r, g, b = 0.5, 0.82, 0.72
  if danger then r, g, b = 0.9, 0.33, 0.33 end
  self:drawRect(bx, y + 2, bw * v, 8, 0.95, r, g, b)
end
function LocalHUD:render()
  local data = LS.hudData
  if not data.visible then return end
  local w, h = self.width, self.height
  self:drawRect(0, 0, w, h, 0.62, 0.04, 0.06, 0.08)
  self:drawRectBorder(0, 0, w, h, 0.7, 0.5, 0.82, 0.72)
  self:drawText("LOCAL", 12, 8, 0.5, 0.82, 0.72, 1, UIFont.Medium)
  self:drawTextRight(self:statusText(), w - 12, 11, 1, 0.83, 0.28, 1, UIFont.Small)
  if data.goal ~= "" then
    for _, gl in ipairs(self:wrap("GOAL: " .. data.goal, 62)) do
      self:drawText(gl, 12, 28, 1, 0.83, 0.28, 1, UIFont.Small); break  -- one line, amber
    end
  end
  self:drawText("ACTION: " .. data.action, 12, 44, 0.9, 0.95, 1, 1, UIFont.Small)
  local ty = 64
  for _, line in ipairs(self:wrap(data.thought, 58)) do
    if ty > 104 then break end
    self:drawText(line, 12, ty, 0.74, 0.79, 0.85, 1, UIFont.Small); ty = ty + 15
  end
  local by = 116
  self:bar("HP", (data.hp or 0) / 100, 12, by, false)
  self:bar("HUN", data.hunger, 104, by, true)
  self:bar("THI", data.thirst, 196, by, true)
  self:bar("FAT", data.fatigue, 288, by, true)
  local zt = (data.zDist and data.zDist >= 0) and (math.floor(data.zDist) .. " " .. data.zDir) or "none near"
  self:drawText("Zombies  " .. data.zClose .. " close / " .. data.zNear .. " near  (" .. zt .. ")", 12, by + 22, 0.9, 0.62, 0.62, 1, UIFont.Small)
  self:drawText("Inv  " .. data.foods .. " food, " .. data.waters .. " water  |  " .. data.weapon, 12, by + 38, 0.7, 0.86, 0.7, 1, UIFont.Small)
  self:drawTextRight("day " .. data.day .. "  " .. string.format("%02d", data.hour) .. ":00   [H hides]", w - 12, by + 38, 0.55, 0.6, 0.66, 1, UIFont.Small)
end

function HUD.start()
  if HUD.instance then return end
  HUD.instance = LocalHUD:new()
  HUD.instance:initialise()
  HUD.instance:addToUIManager()
end

-- Human override: pressing a movement/action key hands control to you; the AI stands down
-- and auto-resumes once you've stopped moving for ~10s (see the main loop).
local MOVE_KEYS = {
  [Keyboard.KEY_W] = true, [Keyboard.KEY_A] = true, [Keyboard.KEY_S] = true, [Keyboard.KEY_D] = true,
  [Keyboard.KEY_UP] = true, [Keyboard.KEY_DOWN] = true, [Keyboard.KEY_LEFT] = true, [Keyboard.KEY_RIGHT] = true,
  [Keyboard.KEY_E] = true, [Keyboard.KEY_SPACE] = true, [Keyboard.KEY_F] = true, [Keyboard.KEY_R] = true, [Keyboard.KEY_Q] = true,
}
function HUD.onKeyPressed(key)
  if key == Keyboard.KEY_H then LS.hudData.visible = not LS.hudData.visible; return end
  if key == Keyboard.KEY_G then
    LS.autoSpeed = not LS.autoSpeed
    if not LS.autoSpeed then pcall(function() setGameSpeed(1) end) end
    return
  end
  if MOVE_KEYS[key] then
    LS.lastHumanKeyTick = LS.tick
    if not LS.manualMode then
      LS.manualMode = true
      LS.travel.active = false
      pcall(function() ISTimedActionQueue.clear(getSpecificPlayer(0)) end)
    end
  end
end
