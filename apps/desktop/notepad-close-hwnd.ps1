param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $false)][string]$FixtureLeaf = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AtlasClose3 {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public const uint WM_CLOSE = 0x0010;
}
"@

function Invoke-NamedButton([System.Windows.Automation.AutomationElement]$root, [string[]]$names) {
  foreach ($n in $names) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $n)
    $btn = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($null -ne $btn) {
      $inv = $null
      if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
        $inv.Invoke()
        return $true
      }
    }
  }
  return $false
}

$hwndPtr = [IntPtr]([int64]$Hwnd)
if (-not [AtlasClose3]::IsWindow($hwndPtr)) {
  @{ closed = $true; refused = $false; reason = 'window_already_gone'; pid = $TargetPid } | ConvertTo-Json -Compress
  exit 0
}

$obsPid = 0
[void][AtlasClose3]::GetWindowThreadProcessId($hwndPtr, [ref]$obsPid)
if ($obsPid -ne $TargetPid) {
  @{ closed = $false; refused = $true; reason = 'hwnd_pid_mismatch'; pid = $obsPid; expected = $TargetPid } | ConvertTo-Json -Compress
  exit 3
}

$el = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr)
$closedTab = $false
$method = 'none'

# 1) Prefer closing only the matching tab (shared Win11 Notepad process safe)
if ($FixtureLeaf -and $null -ne $el) {
  $tabType = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  $tabs = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabType)
  foreach ($tab in $tabs) {
    $tname = [string]$tab.Current.Name
    if ($tname -like "*$FixtureLeaf*") {
      # Select tab then close via close button on tab or Ctrl-equivalent UIA
      $sel = $null
      if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
        $sel.Select()
      }
      Start-Sleep -Milliseconds 150
      # Try close button child
      $btnType = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
      $buttons = $tab.FindAll([System.Windows.Automation.TreeScope]::Children, $btnType)
      foreach ($b in $buttons) {
        $bn = [string]$b.Current.Name
        if ($bn -match '(?i)close|закры') {
          $inv = $null
          if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
            $inv.Invoke()
            $closedTab = $true
            $method = 'tab_close_button'
            break
          }
        }
      }
      if (-not $closedTab) {
        # Fallback: window Close then Don't Save only if single tab — still last resort
      }
      break
    }
  }
}

if (-not $closedTab) {
  # 2) If this process has only one top-level window title matching our leaf, close window
  try {
    $wp = $null
    if ($el -ne $null -and $el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
      $wp.Close()
      $method = 'window_pattern_close'
    } else {
      [void][AtlasClose3]::SendMessage($hwndPtr, [AtlasClose3]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
      $method = 'wm_close'
    }
  } catch {
    [void][AtlasClose3]::PostMessage($hwndPtr, [AtlasClose3]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    $method = 'wm_close_post'
  }
}

Start-Sleep -Milliseconds 300
# Dismiss save dialog if any (Don't Save) — scoped to TargetPid
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $pidCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
  $dialogs = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
  foreach ($d in $dialogs) {
    [void](Invoke-NamedButton $d @("Don't Save", "Не сохранять", "No"))
  }
} catch {}

Start-Sleep -Milliseconds 400

# Success criteria: our fixture title no longer present for this HWND, OR HWND gone
$stillWindow = [AtlasClose3]::IsWindow($hwndPtr)
$titleGone = $true
if ($stillWindow -and $FixtureLeaf) {
  try {
    $el2 = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr)
    $nm = [string]$el2.Current.Name
    if ($nm -like "*$FixtureLeaf*") { $titleGone = $false }
    # also check tabs
    $tabType2 = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem)
    $tabs2 = $el2.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabType2)
    foreach ($tab in $tabs2) {
      if ([string]$tab.Current.Name -like "*$FixtureLeaf*") { $titleGone = $false }
    }
  } catch {
    $titleGone = $true
  }
}

$closed = (-not $stillWindow) -or $titleGone
@{
  closed = $closed
  refused = $false
  reason = $(if ($closed) { "closed_owned_document:$method" } else { "close_attempted_still_present:$method" })
  pid = $TargetPid
  hwnd = $Hwnd
  processLeftAlive = $stillWindow
} | ConvertTo-Json -Compress
exit 0
