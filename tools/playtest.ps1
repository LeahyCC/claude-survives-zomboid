# Unattended playtest: install the mods, start Project Zomboid, continue the latest save, click past
# "Click to Start", and return once the mod is writing senses.
#
#   pwsh tools/playtest.ps1            install, launch (or reuse a running game), get in game
#   pwsh tools/playtest.ps1 -Shot x.png also save a screenshot of the game window when in game
#
# The auto-continue lives in tools/dev-mod/LocalSurvivorDev. It only acts while
# Zomboid/Lua/ls_autoload.txt exists, and this script deletes that file once the game is in.
param(
  [int]$TimeoutSec = 420,
  [string]$Shot = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$zomboid = Join-Path $env:USERPROFILE 'Zomboid'
$luaDir = Join-Path $zomboid 'Lua'
$percept = Join-Path $luaDir 'local_percept.txt'
$flag = Join-Path $luaDir 'ls_autoload.txt'

& pwsh (Join-Path $repo 'install.ps1') | Out-Null
$devSrc = Join-Path $PSScriptRoot 'dev-mod\LocalSurvivorDev'
$devDst = Join-Path $zomboid 'mods\LocalSurvivorDev'
if (Test-Path $devDst) { Remove-Item $devDst -Recurse -Force }
Copy-Item $devSrc $devDst -Recurse -Force

# Main-menu Lua only runs for mods in the default list, so the helper has to be there.
$defaults = Join-Path $zomboid 'mods\default.txt'
if (Test-Path $defaults) {
  $text = Get-Content $defaults -Raw
  if ($text -notmatch 'mod = LocalSurvivorDev,') {
    $text = $text -replace "mods\s*\{", "mods`n{`n`tmod = LocalSurvivorDev,"
    Set-Content -Path $defaults -Value $text -NoNewline
  }
}

# Continuing a save reloads Lua with the save's own mod list, so the helper must be in it too,
# or it disappears before it can click through character creation.
$latest = Join-Path $zomboid 'latestSave.ini'
if (Test-Path $latest) {
  $lines = Get-Content $latest
  if ($lines.Count -ge 2) {
    $saveMods = Join-Path $zomboid (Join-Path 'Saves' (Join-Path $lines[1] (Join-Path $lines[0] 'mods.txt')))
    if (Test-Path $saveMods) {
      $text = Get-Content $saveMods -Raw
      if ($text -notmatch 'mod = LocalSurvivorDev,') {
        $text = $text -replace "mods\s*\{", "mods`n{`n    mod = LocalSurvivorDev,"
        Set-Content -Path $saveMods -Value $text -NoNewline
      }
    }
  }
}

New-Item -ItemType Directory -Force $luaDir | Out-Null
Set-Content -Path $flag -Value '1'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PzWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@

function Get-PzWindow {
  $p = Get-Process ProjectZomboid64 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { return $p.MainWindowHandle }
  return [IntPtr]::Zero
}

function Click-Center($h) {
  $r = New-Object PzWin+RECT
  [PzWin]::ShowWindow($h, 9) | Out-Null
  [PzWin]::SetForegroundWindow($h) | Out-Null
  [PzWin]::GetWindowRect($h, [ref]$r) | Out-Null
  $x = [int](($r.Left + $r.Right) / 2)
  $y = [int](($r.Top + $r.Bottom) / 2)
  [PzWin]::SetCursorPos($x, $y) | Out-Null
  [PzWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [PzWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Test-InGame {
  if (-not (Test-Path $percept)) { return $false }
  return ((Get-Date) - (Get-Item $percept).LastWriteTime).TotalSeconds -lt 6
}

if (Test-InGame) {
  Write-Host 'Already in game.'
} else {
  if ((Get-PzWindow) -eq [IntPtr]::Zero) {
    Write-Host 'Starting Project Zomboid through Steam...'
    Start-Process 'steam://rungameid/108600'
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while (-not (Test-InGame)) {
    if ((Get-Date) -gt $deadline) {
      Remove-Item $flag -ErrorAction SilentlyContinue
      throw "Not in game after $TimeoutSec s. Check the game window."
    }
    Start-Sleep -Seconds 8
    $h = Get-PzWindow
    # The world loads behind a "Click to Start" screen. A click on the main menu does nothing harmful.
    if ($h -ne [IntPtr]::Zero) { Click-Center $h }
  }
  Write-Host 'In game.'
}
Remove-Item $flag -ErrorAction SilentlyContinue

if ($Shot) { & pwsh (Join-Path $PSScriptRoot 'screenshot.ps1') -Out $Shot }
