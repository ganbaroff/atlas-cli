param(
  [Parameter(Mandatory = $true)][string]$FixturePath,
  [Parameter(Mandatory = $false)][string]$NotepadPath = ''
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AtlasWinEnum2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
}
"@

if (-not (Test-Path -LiteralPath $FixturePath)) {
  Write-Error "fixture_missing"
  exit 2
}

$exe = $NotepadPath
if (-not $exe -or -not (Test-Path -LiteralPath $exe)) {
  $exe = "$env:SystemRoot\System32\notepad.exe"
  if (-not (Test-Path -LiteralPath $exe)) { $exe = "notepad.exe" }
}

$launchTs = (Get-Date).ToUniversalTime().ToString('o')
$proc = Start-Process -FilePath $exe -ArgumentList @("`"$FixturePath`"") -PassThru
$launcherPid = $proc.Id
$leaf = [System.IO.Path]::GetFileNameWithoutExtension($FixturePath)
$fileName = [System.IO.Path]::GetFileName($FixturePath)

$found = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $script:found = $null
  [AtlasWinEnum2+EnumProc]$callback = {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [AtlasWinEnum2]::IsWindowVisible($hWnd)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][AtlasWinEnum2]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    $titleOk = ($title -like "*$leaf*") -or ($title -like "*$fileName*") -or ($title -match '(?i)notepad')
    # Require fixture leaf in title to avoid binding a random pre-existing Notepad
    if ($title -notlike "*$leaf*" -and $title -notlike "*$fileName*") { return $true }
    $procId = 0
    [void][AtlasWinEnum2]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    $cls = New-Object System.Text.StringBuilder 256
    [void][AtlasWinEnum2]::GetClassName($hWnd, $cls, $cls.Capacity)
    $script:found = @{
      hwnd = [int64]$hWnd
      pid = [int]$procId
      title = $title
      className = $cls.ToString()
      launcherPid = $launcherPid
      executablePath = $exe
      launchTimestamp = $launchTs
      fixturePath = $FixturePath
    }
    return $false
  }
  [void][AtlasWinEnum2]::EnumWindows($callback, [IntPtr]::Zero)
  if ($null -ne $script:found) { break }
}

if ($null -eq $found) {
  try { Stop-Process -Id $launcherPid -Force -ErrorAction SilentlyContinue } catch {}
  Write-Error "no_window_for_fixture"
  exit 3
}

$found | ConvertTo-Json -Compress
exit 0
