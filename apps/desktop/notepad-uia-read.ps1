param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $false)][string]$ExpectedTitleSubstring = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AtlasWinPid {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$hwndPtr = [IntPtr]([int64]$Hwnd)
$obsPid = 0
[void][AtlasWinPid]::GetWindowThreadProcessId($hwndPtr, [ref]$obsPid)
if ($obsPid -ne $TargetPid) {
  @{ error = 'window_pid_mismatch'; pid = $obsPid; expected = $TargetPid } | ConvertTo-Json -Compress
  exit 3
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr)
if ($null -eq $root) {
  @{ error = 'uia_from_handle_null' } | ConvertTo-Json -Compress
  exit 4
}

$title = $root.Current.Name
if ($ExpectedTitleSubstring -and $title -and ($title -notlike "*$ExpectedTitleSubstring*") -and ($ExpectedTitleSubstring -notlike "*$($title.Substring(0, [Math]::Min(8, $title.Length)))*")) {
  # Soft check only; hard PID match already enforced
}

$conditionEdit = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$conditionDoc = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Document
)
$conditionOr = New-Object System.Windows.Automation.OrCondition($conditionEdit, $conditionDoc)

$target = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $conditionOr)
if ($null -eq $target) {
  # Fallback: walk a few descendants for ValuePattern
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $walker.GetFirstChild($root)
  $depth = 0
  while ($null -ne $node -and $depth -lt 40) {
    $vp = $null
    if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $target = $node
      break
    }
    $tp = $null
    if ($node.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $target = $node
      break
    }
    $next = $walker.GetFirstChild($node)
    if ($null -eq $next) { $next = $walker.GetNextSibling($node) }
    if ($null -eq $next) {
      $parent = $walker.GetParent($node)
      while ($null -ne $parent -and $null -eq $next) {
        $next = $walker.GetNextSibling($parent)
        $parent = $walker.GetParent($parent)
      }
    }
    $node = $next
    $depth++
  }
}

if ($null -eq $target) {
  @{ error = 'uia_edit_not_found'; pid = $TargetPid; title = $title } | ConvertTo-Json -Compress
  exit 5
}

$text = ''
$vp2 = $null
if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp2)) {
  $text = [string]$vp2.Current.Value
} else {
  $tp2 = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp2)) {
    $text = [string]$tp2.DocumentRange.GetText(-1)
  }
}

$first = ''
if ($null -ne $text) {
  $norm = $text -replace "`r`n", "`n"
  $first = ($norm -split "`n")[0]
}

$excerpt = "name=$($target.Current.Name);ctype=$($target.Current.ControlType.ProgrammaticName);class=$($target.Current.ClassName);len=$($text.Length)"

@{
  pid = $TargetPid
  hwnd = $Hwnd
  title = $title
  firstLine = $first
  treeExcerpt = $excerpt
} | ConvertTo-Json -Compress
exit 0
