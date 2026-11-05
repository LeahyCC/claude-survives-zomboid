# Save a PNG of the Project Zomboid window (or the whole primary screen if the game is not up).
#   pwsh tools/screenshot.ps1 -Out shot.png
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PzShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[PzShot]::SetProcessDPIAware() | Out-Null
$p = Get-Process ProjectZomboid64 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  $r = New-Object PzShot+RECT
  [PzShot]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  $x, $y, $w, $h = $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)
} else {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x, $y, $w, $h = $b.X, $b.Y, $b.Width, $b.Height
}
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save((Resolve-Path -LiteralPath (Split-Path $Out -Parent) -ErrorAction SilentlyContinue).Path + '\' + (Split-Path $Out -Leaf), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Host "Saved $Out ($w x $h)"
