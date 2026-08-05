param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$FixturePath
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AtlasWinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
}
"@

$leaf = [System.IO.Path]::GetFileNameWithoutExtension($FixturePath)
$found = $null

[AtlasWinEnum+EnumProc]$callback = {
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $procId = 0
  [void][AtlasWinEnum]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  if ($procId -ne $TargetPid) { return $true }
  if (-not [AtlasWinEnum]::IsWindowVisible($hWnd)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][AtlasWinEnum]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $cls = New-Object System.Text.StringBuilder 256
  [void][AtlasWinEnum]::GetClassName($hWnd, $cls, $cls.Capacity)
  $className = $cls.ToString()
  # Accept classic Notepad or Win11 Notepad windows owned by our PID
  $titleOk = ($title -like "*$leaf*") -or ($title -match '(?i)notepad')
  if (-not $titleOk) { return $true }
  $script:found = @{
    hwnd = [int64]$hWnd
    pid = $procId
    title = $title
    className = $className
  }
  return $false
}

[void][AtlasWinEnum]::EnumWindows($callback, [IntPtr]::Zero)

if ($null -eq $found) {
  Write-Error "no_window_for_pid"
  exit 2
}

$found | ConvertTo-Json -Compress
exit 0
