-- The inner voice on screen. The bridge writes the newest line to Zomboid/Lua/local_voice.txt (one
-- line, overwritten). This file reads it about twice a second, only when the text changed, and
-- shows it two ways: a bubble over her head and a small "Inner voice" panel with the last 3 lines.
-- A key (;) toggles both, ls_voice_off.txt turns both off, ls_voice_clean.txt stars out a short
-- list of slurs for a stream. The /mind page and pepe.log are never filtered, only this display.
-- It is commentary only. Nothing here touches an order, a verb or the brain.
--
-- Entry file registers Voice.start; this file registers nothing.

require "ISUI/ISUIElement"
require "LocalSurvivor/Core"
local LS = LocalSurvivor
LS.Voice = LS.Voice or {}
local Voice = LS.Voice

-- Constants. Safe to overwrite on a second run.
Voice.FILE        = "local_voice.txt"
Voice.OFF_FLAG    = "ls_voice_off.txt"
Voice.CLEAN_FLAG  = "ls_voice_clean.txt"
Voice.POLL_EVERY  = 30      -- ticks between reads (~0.5s at the 60 a second logic rate)
Voice.HOLD        = 420     -- ticks the bubble is kept alive (~7s)
Voice.KEEP        = 3       -- lines the panel shows
Voice.MAX_LINE    = 300     -- longest line kept, so one runaway line cannot fill the screen
Voice.MAX_BUBBLE  = 140     -- longest bubble; the overhead text is small and wraps badly past this
Voice.MARGIN      = 14      -- panel gap from the top and right screen edges
Voice.PAD         = 12
Voice.BUBBLE_RGB  = { 0.55, 0.92, 0.78 }   -- teal, so her voice reads apart from her own speech

local function default(key, value)
  if LS[key] == nil then LS[key] = value end
end
-- keyOff: the toggle key. fileOff: ls_voice_off.txt. clean: ls_voice_clean.txt.
-- primed: the first read only learns what the file already held (a line from the last run).
-- rev counts new lines, so the panel only re-wraps when something changed.
default("voice", {
  lines = {}, raw = nil, primed = false, keyOff = false, fileOff = false, clean = false,
  rev = 0, bubble = "", bubbleUntil = 0,
})

-- ---------- the stream filter ----------

-- The list is ROT13 so the source holds no slurs in the clear, which keeps it out of greps, diffs
-- and the file filters on a stream machine. Whole words only (a trailing s is allowed), so
-- "raccoon", "spice" and "Pakistan" pass. Leetspeak is not caught, it is a short net, not a wall.
local ENCODED = {
  "avttre", "avttn", "snttbg", "snt", "xvxr", "fcvp", "puvax", "pbba", "genaal", "genaavrf",
  "ergneq", "ergneqrq", "jrgonpx", "tbbx", "cnxv", "qlxr", "xlf",
  "encr", "encrq", "encvat", "encvfg",
}
local function rot13(s)
  return (string.gsub(s, "%a", function(c)
    local b = string.byte(c)
    local base = (b < 97) and 65 or 97
    return string.char((b - base + 13) % 26 + base)
  end))
end
local words = nil
function Voice.words()
  if not words then
    words = {}
    for i, e in ipairs(ENCODED) do words[i] = rot13(e) end
  end
  return words
end

-- Same length out as in, with every letter of a listed word turned into a star.
function Voice.cleanse(text)
  text = tostring(text or "")
  local lower = string.lower(text)
  local mask = nil
  for _, w in ipairs(Voice.words()) do
    local init = 1
    while true do
      local s, e = string.find(lower, w, init, true)
      if not s then break end
      local before = (s > 1) and string.sub(lower, s - 1, s - 1) or ""
      local after = string.sub(lower, e + 1, e + 1)
      local after2 = string.sub(lower, e + 2, e + 2)
      local stop = nil
      if not string.find(before, "%a") then
        if not string.find(after, "%a") then stop = e
        elseif after == "s" and not string.find(after2, "%a") then stop = e + 1 end
      end
      if stop then
        mask = mask or {}
        for i = s, stop do mask[i] = true end
      end
      init = e + 1
    end
  end
  if not mask then return text end
  local out = {}
  for i = 1, #text do out[i] = mask[i] and "*" or string.sub(text, i, i) end
  return table.concat(out)
end

-- ---------- reading ----------

-- The voice's half of the file. The bridge writes `ACTION "thought" | line` and the thought
-- cannot hold a bar (it turns them into slashes), so the first bar splits it. A line with no
-- bar is an idle thought and is all voice.
function Voice.speech(raw)
  local text = tostring(raw or "")
  local s, e = string.find(text, "|", 1, true)
  if s then text = string.sub(text, e + 1) end
  text = string.gsub(text, "%c", " ")
  text = string.gsub(text, "%s+", " ")
  text = string.gsub(text, "^ ", "")
  text = string.gsub(text, " $", "")
  if #text > Voice.MAX_LINE then text = string.sub(text, 1, Voice.MAX_LINE - 3) .. "..." end
  return text
end

local function exists(name)
  local found = false
  pcall(function()
    local r = getFileReader(name, false)
    if r then found = true; r:close() end
  end)
  return found
end

local function readFirstLine(name)
  local text = nil
  pcall(function()
    local r = getFileReader(name, false)
    if not r then return end
    local line = r:readLine()
    r:close()
    if line ~= nil then text = tostring(line) end
  end)
  return text
end

function Voice.visible()
  local st = LS.voice
  return not st.keyOff and not st.fileOff
end

function Voice.toggle()
  local st = LS.voice
  st.keyOff = not st.keyOff
  if st.keyOff then st.bubbleUntil = 0 end
end

function Voice.refreshFlags()
  local st = LS.voice
  st.fileOff = exists(Voice.OFF_FLAG)
  st.clean = exists(Voice.CLEAN_FLAG)
end

-- Newest first, the last KEEP kept.
function Voice.push(text)
  local st = LS.voice
  table.insert(st.lines, 1, text)
  while #st.lines > Voice.KEEP do table.remove(st.lines) end
  st.rev = st.rev + 1
end

-- ---------- the bubble ----------

local function shortBubble(text)
  if #text <= Voice.MAX_BUBBLE then return text end
  local cut = string.sub(text, 1, Voice.MAX_BUBBLE - 3)
  local back = string.match(cut, "^(.*)%s%S*$")
  return (back and #back > 40 and back or cut) .. "..."
end

-- addLineChatElement is the overhead text alone: no chat window entry and no world sound. Say
-- is the plain fallback. Shout and Callout are never used, they would draw zombies.
local function showBubble(p, text)
  local c = Voice.BUBBLE_RGB
  local ok = pcall(function() p:addLineChatElement(text, c[1], c[2], c[3]) end)
  if not ok then pcall(function() p:Say(text) end) end
end

local function bubbleText(st)
  local text = st.bubble
  if st.clean then text = Voice.cleanse(text) end
  return shortBubble(text)
end

-- The game decides how long its own bubble lives. If it faded before our hold is over, say it
-- again, so the line stays up for about HOLD ticks. A longer game bubble is left alone.
local function keepBubble(p, tick)
  local st = LS.voice
  if st.bubble == "" or tick >= st.bubbleUntil then return end
  local speaking = nil
  pcall(function() speaking = p:getChatElement():IsSpeaking() end)
  if speaking == false then showBubble(p, bubbleText(st)) end
end

-- ---------- the poll ----------

-- Called every POLL_EVERY ticks by the tick loop. Never throws.
function Voice.poll(p, tick)
  local st = LS.voice
  pcall(Voice.refreshFlags)
  local raw = readFirstLine(Voice.FILE)
  if raw ~= nil and raw ~= "" then
    if not st.primed then
      -- Whatever the file held at the start belongs to the last run.
      st.primed = true
      st.raw = raw
    elseif raw ~= st.raw then
      st.raw = raw
      local text = Voice.speech(raw)
      if text ~= "" then
        Voice.push(text)
        st.bubble = text
        st.bubbleUntil = tick + Voice.HOLD
        if Voice.visible() and p then
          local dead = false
          pcall(function() dead = p:isDead() end)
          if not dead then showBubble(p, bubbleText(st)) end
        end
      end
    end
  else
    st.primed = true
  end
  if Voice.visible() and p then keepBubble(p, tick) end
end

-- ---------- the panel ----------

-- Break text into rows no wider than maxW pixels. measure(s) is the pixel width of s. A word
-- wider than a row is cut by characters.
function Voice.wrap(text, maxW, measure)
  local rows, line = {}, ""
  local function flush() if line ~= "" then table.insert(rows, line); line = "" end end
  for word in string.gmatch(tostring(text), "%S+") do
    local try = (line == "") and word or (line .. " " .. word)
    if measure(try) <= maxW then
      line = try
    else
      flush()
      while measure(word) > maxW and #word > 1 do
        local n = #word - 1
        while n > 1 and measure(string.sub(word, 1, n)) > maxW do n = n - 1 end
        table.insert(rows, string.sub(word, 1, n))
        word = string.sub(word, n + 1)
      end
      line = word
    end
  end
  flush()
  return rows
end

-- Rows for every kept line, newest first. block is the line's number (1 is the newest), so the
-- panel can draw the newest bright and leave a gap between lines.
function Voice.rows(lines, clean, maxW, measure)
  local out = {}
  for i, text in ipairs(lines) do
    if clean then text = Voice.cleanse(text) end
    for _, r in ipairs(Voice.wrap(text, maxW, measure)) do
      table.insert(out, { text = r, block = i })
    end
  end
  return out
end

local function measureWith(font)
  return function(s)
    local w = nil
    pcall(function() w = getTextManager():MeasureStringX(font, s) end)
    return w or (#s * 9)
  end
end
local function fontHeight(font)
  local h = nil
  pcall(function() h = getTextManager():getFontHeight(font) end)
  return h or 20
end

LocalVoicePanel = LocalVoicePanel or ISUIElement:derive("LocalVoicePanel")
function LocalVoicePanel:new()
  local o = ISUIElement:new(0, Voice.MARGIN, 400, 60)
  setmetatable(o, self); self.__index = self
  o.layoutKey = nil
  o.rows = {}
  return o
end

-- Size and place the panel for the current lines. Top right, clear of the HUD (bottom left) and
-- of the moodles (down the right edge, below the middle).
function LocalVoicePanel:layout(sw)
  local st = LS.voice
  local font = UIFont.Medium
  local fh = fontHeight(font)
  local w = math.max(360, math.min(600, math.floor(sw * 0.28)))
  local rows = Voice.rows(st.lines, st.clean, w - 2 * Voice.PAD, measureWith(font))
  local y = Voice.PAD + fh + 8
  local lastBlock = nil
  for _, r in ipairs(rows) do
    if lastBlock and r.block ~= lastBlock then y = y + 8 end
    r.y = y
    y = y + fh
    lastBlock = r.block
  end
  self.rows = rows
  self.fh = fh
  self.panelH = y + Voice.PAD
  self.panelW = w
  pcall(function() self:setWidth(w) end)
  pcall(function() self:setHeight(self.panelH) end)
  pcall(function() self:setX(sw - w - Voice.MARGIN) end)
end

function LocalVoicePanel:render()
  local st = LS.voice
  if not Voice.visible() or #st.lines == 0 then return end
  local sw = 1920
  pcall(function() sw = getCore():getScreenWidth() end)
  local key = tostring(st.rev) .. ":" .. tostring(st.clean) .. ":" .. tostring(sw)
  if key ~= self.layoutKey then
    self.layoutKey = key
    self:layout(sw)
  end
  local w, h = self.panelW, self.panelH
  self:drawRect(0, 0, w, h, 0.62, 0.04, 0.06, 0.08)
  self:drawRectBorder(0, 0, w, h, 0.7, 0.5, 0.82, 0.72)
  self:drawText("Inner voice", Voice.PAD, Voice.PAD - 2, 0.5, 0.82, 0.72, 1, UIFont.Medium)
  for _, r in ipairs(self.rows) do
    if r.block == 1 then
      self:drawText(r.text, Voice.PAD, r.y, 1, 1, 1, 1, UIFont.Medium)
    else
      self:drawText(r.text, Voice.PAD, r.y, 0.62, 0.68, 0.74, 1, UIFont.Medium)
    end
  end
end

function Voice.start()
  if Voice.instance then return end
  Voice.instance = LocalVoicePanel:new()
  Voice.instance:initialise()
  Voice.instance:addToUIManager()
end
