param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AtlasCap {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

Add-Type -AssemblyName System.Drawing

$hwndPtr = [IntPtr]([int64]$Hwnd)
$obsPid = 0
[void][AtlasCap]::GetWindowThreadProcessId($hwndPtr, [ref]$obsPid)
if ($obsPid -ne $TargetPid) {
  Write-Error "window_pid_mismatch"
  exit 3
}

$rect = New-Object AtlasCap+RECT
if (-not [AtlasCap]::GetWindowRect($hwndPtr, [ref]$rect)) {
  Write-Error "get_window_rect_failed"
  exit 4
}

$w = [Math]::Max(1, $rect.Right - $rect.Left)
$h = [Math]::Max(1, $rect.Bottom - $rect.Top)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $dir = Split-Path -Parent $OutPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}

@{ ok = $true; path = $OutPath; width = $w; height = $h; pid = $TargetPid } | ConvertTo-Json -Compress
exit 0
