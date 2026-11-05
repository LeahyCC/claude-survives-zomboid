# Copy LocalSurvivor into the Project Zomboid mods folder.
# Usage: pwsh ./install.ps1
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'mods\LocalSurvivor'
$zomboid = Join-Path $env:USERPROFILE 'Zomboid'
$dst = Join-Path $zomboid 'mods\LocalSurvivor'

if (-not (Test-Path $src)) { throw "mods\LocalSurvivor not found next to this script." }
if (-not (Test-Path $zomboid)) {
  Write-Host "Zomboid folder not found at $zomboid. Launch the game once so it creates that folder."
}

New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Copy-Item $src $dst -Recurse -Force
New-Item -ItemType Directory -Force (Join-Path $zomboid 'Lua') | Out-Null

Write-Host "Installed -> $dst"
Write-Host "Next: cd bridge; node pz-bridge.mjs"
Write-Host "Then enable Local Survivor in the mods menu and start a sandbox game."
Write-Host "Watch http://localhost:8799/mind"
