<#
  atlas-desktop.ps1 — generic Windows desktop control surface for Atlas.

  Generalises the Notepad-only read-only slice (apps/desktop/notepad-*.ps1) into an
  app-agnostic engine: see the machine, address real UI elements, act on them, and
  read the result back so every action can be verified rather than assumed.

  DESIGN RULES (carried over from the slice, do not relax silently):
    - Element addressing is by UI Automation identity (AutomationId / Name /
      ControlType), never by raw screen coordinates. `click` derives a point from
      the element's own bounding rectangle; there is no "click at x,y" action.
    - Every window-scoped action re-verifies the owning process id through
      GetWindowThreadProcessId before it touches anything. A window that moved to a
      different pid is a hard failure, not a retry.
    - stdout carries exactly one compact JSON object. Diagnostics go to stderr.
      Non-zero exit codes are stable and documented in EXIT CODES below.
    - No secret values are read, printed or logged. Text read back from controls is
      returned verbatim to the caller (it is the caller's own typed content) and is
      capped by -MaxChars.

  EXIT CODES
    0  ok
    2  bad arguments / unknown action
    3  window pid mismatch (window is not owned by the pid the caller named)
    4  window handle did not resolve to a UI Automation element
    5  element not found
    6  requested pattern not supported by the element
    7  action attempted but post-condition check failed
    8  timeout waiting for a window or element
#>

param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$TargetPid = 0,
  [string]$Hwnd = '',
  [string]$Path = '',
  [string]$Arguments = '',
  [string]$AutomationId = '',
  [string]$Name = '',
  [string]$ControlType = '',
  [string]$Text = '',
  [string]$Keys = '',
  [string]$OutFile = '',
  [string]$Bounds = '',
  [string]$Button = 'left',
  [switch]$Double,
  [int]$Index = 0,
  [int]$Depth = 4,
  [int]$TimeoutMs = 10000,
  [int]$MaxChars = 20000,
  [int]$MaxNodes = 400,
  [switch]$IncludeInvisible,
  [switch]$Utf8B64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Text is corrupted on the way OUT as well as in. With base64 input fixed, `settext`
# received the correct 10-character Cyrillic string (chars:10) and wrote it, yet `read`
# still returned "????? ????" — the JSON left PowerShell through the console code page.
# Both ends of the pipe must be UTF-8 or the fix on one end proves nothing.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AtlasDesk {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int  GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public const uint MOUSEEVENTF_LEFTDOWN  = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP    = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP   = 0x0010;
  public const uint MOUSEEVENTF_WHEEL     = 0x0800;
}
"@

# Non-ASCII text cannot survive the command line. PowerShell 5.1 receives arguments
# through the console code page, so "Атлас управляет компьютером" arrived as "????? ..."
# BEFORE the script ran — and the settext read-back then compared corrupted against
# corrupted and reported verified:true. A round-trip check cannot see damage that
# happened upstream of the round trip. So text travels as base64 UTF-8 and is decoded
# here; the typed wrapper always sets -Utf8B64, which makes the safe path the only path.
if ($Utf8B64) {
  function FromB64([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return $s }
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($s))
  }
  $Text = FromB64 $Text
  $Name = FromB64 $Name
  $Keys = FromB64 $Keys
  $Path = FromB64 $Path
  $Arguments = FromB64 $Arguments
  $AutomationId = FromB64 $AutomationId
  $OutFile = FromB64 $OutFile
}

# Must run before anything reads a coordinate. Without it Windows lies to a
# non-DPI-aware process: on this machine a 2560x1600 display reports as 1280x800,
# so `capture` silently saved the top-left quarter and called it the screen, while
# UI Automation kept returning true physical bounds — clicks landed correctly at
# y=964 on a "800-tall" screen, which is how the mismatch surfaced. Both halves must
# speak the same coordinate space or nothing composes.
[void][AtlasDesk]::SetProcessDPIAware()

# ---------------------------------------------------------------- helpers

function Emit([hashtable]$obj, [int]$code = 0) {
  $obj['action'] = $Action
  ($obj | ConvertTo-Json -Compress -Depth 12)
  exit $code
}

function Fail([string]$err, [int]$code, [hashtable]$extra = @{}) {
  $extra['error'] = $err
  $extra['ok'] = $false
  Emit $extra $code
}

function Resolve-Hwnd([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { Fail 'hwnd_required' 2 }
  return [IntPtr]([int64]$raw)
}

# Every window-scoped action goes through this. A window whose owning process is not
# the one the caller named is refused outright — silently acting on whatever window
# now holds that handle is how automation types into the wrong application.
function Assert-WindowPid([IntPtr]$h, [int]$expected) {
  $observed = 0
  [void][AtlasDesk]::GetWindowThreadProcessId($h, [ref]$observed)
  if ($expected -gt 0 -and $observed -ne $expected) {
    Fail 'window_pid_mismatch' 3 @{ pid = $observed; expected = $expected }
  }
  return [int]$observed
}

function Get-WindowTitle([IntPtr]$h) {
  $len = [AtlasDesk]::GetWindowTextLength($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][AtlasDesk]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Get-WindowBounds([IntPtr]$h) {
  $r = New-Object AtlasDesk+RECT
  if (-not [AtlasDesk]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
}

function Get-ProcessName([int]$processId) {
  try { return (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { return '' }
}

# SetForegroundWindow is refused by Windows unless the calling thread already owns the
# foreground or is attached to the thread that does. Attaching input is the documented
# way round the foreground lock; without it focus silently no-ops and every later
# keystroke lands in the wrong window.
function Focus-Window([IntPtr]$h) {
  # One attempt is not enough. Store-hosted windows (ApplicationFrameHost) accept the
  # activation and then finish composing, so a check 180ms later still saw the old
  # foreground and reported focus_not_confirmed on a window that was about to be
  # focused. Attempt, verify, and only give up after the window has had real time —
  # never report success without observing the foreground actually change.
  if ([AtlasDesk]::IsIconic($h)) { [void][AtlasDesk]::ShowWindow($h, 9) }  # SW_RESTORE
  $self = [AtlasDesk]::GetCurrentThreadId()
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    if ([AtlasDesk]::GetForegroundWindow() -eq $h) { return $true }
    $fg = [AtlasDesk]::GetForegroundWindow()
    $tp = 0; $fp = 0
    $targetThread = [AtlasDesk]::GetWindowThreadProcessId($h, [ref]$tp)
    $fgThread = [AtlasDesk]::GetWindowThreadProcessId($fg, [ref]$fp)
    $attachedFg = $false; $attachedTarget = $false
    try {
      if ($fgThread -ne 0 -and $fgThread -ne $self) { $attachedFg = [AtlasDesk]::AttachThreadInput($self, $fgThread, $true) }
      if ($targetThread -ne 0 -and $targetThread -ne $self) { $attachedTarget = [AtlasDesk]::AttachThreadInput($self, $targetThread, $true) }
      [void][AtlasDesk]::ShowWindow($h, 5)  # SW_SHOW
      [void][AtlasDesk]::SetForegroundWindow($h)
    } finally {
      if ($attachedTarget) { [void][AtlasDesk]::AttachThreadInput($self, $targetThread, $false) }
      if ($attachedFg) { [void][AtlasDesk]::AttachThreadInput($self, $fgThread, $false) }
    }
    Start-Sleep -Milliseconds (150 * $attempt)
  }
  return ([AtlasDesk]::GetForegroundWindow() -eq $h)
}

function Get-UiaRoot([IntPtr]$h) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if ($null -eq $root) { Fail 'uia_from_handle_null' 4 }
  return $root
}

function Parse-ControlType([string]$n) {
  if ([string]::IsNullOrWhiteSpace($n)) { return $null }
  $field = [System.Windows.Automation.ControlType].GetField($n, 'Public,Static,IgnoreCase')
  if ($null -eq $field) { return $null }
  return $field.GetValue($null)
}

function Element-Info($el, [bool]$withPatterns = $true) {
  $c = $el.Current
  $info = [ordered]@{
    name         = $c.Name
    automationId = $c.AutomationId
    controlType  = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    className    = $c.ClassName
    enabled      = $c.IsEnabled
    offscreen    = $c.IsOffscreen
  }
  $r = $c.BoundingRectangle
  if (-not [double]::IsInfinity($r.X)) {
    $info['bounds'] = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
  }
  if ($withPatterns) {
    $pats = @()
    foreach ($p in @('Invoke', 'Value', 'Toggle', 'Selection', 'SelectionItem', 'ExpandCollapse', 'Text', 'Scroll', 'Window')) {
      $pf = [System.Windows.Automation.AutomationElement].Assembly.GetType("System.Windows.Automation.${p}Pattern")
      if ($null -eq $pf) { continue }
      $idField = $pf.GetField('Pattern', 'Public,Static')
      if ($null -eq $idField) { continue }
      $tmp = $null
      if ($el.TryGetCurrentPattern($idField.GetValue($null), [ref]$tmp)) { $pats += $p }
    }
    $info['patterns'] = $pats
  }
  return $info
}

# Find one element under $root. Conditions compose: any of AutomationId / Name /
# ControlType may be given; -Index picks the nth match when several qualify.
function Find-Element($root) {
  $conds = New-Object System.Collections.ArrayList
  if ($AutomationId) {
    [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId)))
  }
  if ($ControlType) {
    $ct = Parse-ControlType $ControlType
    if ($null -eq $ct) { Fail 'unknown_control_type' 2 @{ controlType = $ControlType } }
    [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)))
  }
  if ($Name) {
    [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
  }
  if ($conds.Count -eq 0) { Fail 'selector_required' 2 @{ hint = 'pass -AutomationId and/or -Name and/or -ControlType' } }

  $cond = if ($conds.Count -eq 1) { $conds[0] } else {
    New-Object System.Windows.Automation.AndCondition ([System.Windows.Automation.Condition[]]$conds.ToArray())
  }

  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  do {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($all.Count -gt $Index) { return $all[$Index] }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)

  Fail 'element_not_found' 5 @{ automationId = $AutomationId; name = $Name; controlType = $ControlType; index = $Index }
}

function Get-Pattern($el, [string]$patternName, [int]$failCode = 6) {
  $type = [System.Windows.Automation.AutomationElement].Assembly.GetType("System.Windows.Automation.${patternName}Pattern")
  if ($null -eq $type) { Fail 'unknown_pattern' 2 @{ pattern = $patternName } }
  $id = $type.GetField('Pattern', 'Public,Static').GetValue($null)
  $p = $null
  if (-not $el.TryGetCurrentPattern($id, [ref]$p)) {
    Fail 'pattern_not_supported' $failCode @{ pattern = $patternName; element = (Element-Info $el $false) }
  }
  return $p
}

function Read-ElementText($el) {
  $vType = [System.Windows.Automation.ValuePattern]::Pattern
  $v = $null
  if ($el.TryGetCurrentPattern($vType, [ref]$v)) { return $v.Current.Value }
  $tType = [System.Windows.Automation.TextPattern]::Pattern
  $t = $null
  if ($el.TryGetCurrentPattern($tType, [ref]$t)) { return $t.DocumentRange.GetText($MaxChars) }
  return $el.Current.Name
}

# ---------------------------------------------------------------- actions

switch ($Action.ToLowerInvariant()) {

  # ---- SEE -------------------------------------------------------------

  'windows' {
    $rows = New-Object System.Collections.ArrayList
    $fg = [AtlasDesk]::GetForegroundWindow()
    $cb = [AtlasDesk+EnumProc]{
      param([IntPtr]$h, [IntPtr]$l)
      if (-not $IncludeInvisible -and -not [AtlasDesk]::IsWindowVisible($h)) { return $true }
      $title = Get-WindowTitle $h
      if (-not $IncludeInvisible -and [string]::IsNullOrWhiteSpace($title)) { return $true }
      $wpid = 0
      [void][AtlasDesk]::GetWindowThreadProcessId($h, [ref]$wpid)
      if ($TargetPid -gt 0 -and $wpid -ne $TargetPid) { return $true }
      [void]$rows.Add([ordered]@{
        hwnd       = [int64]$h
        pid        = [int]$wpid
        process    = (Get-ProcessName ([int]$wpid))
        title      = $title
        bounds     = (Get-WindowBounds $h)
        minimized  = [bool][AtlasDesk]::IsIconic($h)
        foreground = ($h -eq $fg)
      })
      return $true
    }
    [void][AtlasDesk]::EnumWindows($cb, [IntPtr]::Zero)
    Emit @{ ok = $true; count = $rows.Count; windows = $rows.ToArray() }
  }

  'screen' {
    $screens = @()
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
      $screens += [ordered]@{
        name    = $s.DeviceName
        primary = $s.Primary
        bounds  = @{ x = $s.Bounds.X; y = $s.Bounds.Y; w = $s.Bounds.Width; h = $s.Bounds.Height }
        working = @{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; w = $s.WorkingArea.Width; h = $s.WorkingArea.Height }
      }
    }
    $fg = [AtlasDesk]::GetForegroundWindow()
    $fgPid = 0
    [void][AtlasDesk]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    Emit @{
      ok = $true
      monitors = $screens
      foreground = [ordered]@{
        hwnd    = [int64]$fg
        pid     = [int]$fgPid
        process = (Get-ProcessName ([int]$fgPid))
        title   = (Get-WindowTitle $fg)
      }
    }
  }

  'capture' {
    if (-not $OutFile) { Fail 'outfile_required' 2 }
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    if ($Bounds) {
      # Region capture exists for OCR: running a vision model over a whole 2560x1600
      # desktop is slow and returns mostly irrelevant text. Crop to the part in question.
      if ($Bounds -notmatch '^\-?\d+,\-?\d+,\d+,\d+$') { Fail 'bad_bounds' 2 @{ bounds = $Bounds } }
      $p = $Bounds.Split(',')
      $rect = New-Object System.Drawing.Rectangle([int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3])
    } elseif ($Hwnd) {
      $h = Resolve-Hwnd $Hwnd
      [void](Assert-WindowPid $h $TargetPid)
      [void](Focus-Window $h)
      $b = Get-WindowBounds $h
      if ($null -eq $b) { Fail 'window_bounds_unavailable' 7 }
      $rect = New-Object System.Drawing.Rectangle($b.x, $b.y, $b.w, $b.h)
    } else {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $rect = New-Object System.Drawing.Rectangle($vs.X, $vs.Y, $vs.Width, $vs.Height)
    }
    $bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.X, $rect.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $w = $bmp.Width; $ht = $bmp.Height
    $bmp.Dispose()
    Emit @{ ok = $true; path = $OutFile; width = $w; height = $ht; bytes = (Get-Item $OutFile).Length }
  }

  'tree' {
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    $root = Get-UiaRoot $h
    $nodes = New-Object System.Collections.ArrayList
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    function Walk($el, [int]$level) {
      if ($nodes.Count -ge $MaxNodes -or $level -gt $Depth) { return }
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child -and $nodes.Count -lt $MaxNodes) {
        $info = Element-Info $child
        $info['level'] = $level
        [void]$nodes.Add($info)
        Walk $child ($level + 1)
        $child = $walker.GetNextSibling($child)
      }
    }
    Walk $root 1
    Emit @{
      ok = $true; pid = $owner; hwnd = [int64]$h
      window = (Element-Info $root $false)
      truncated = ($nodes.Count -ge $MaxNodes)
      count = $nodes.Count
      elements = $nodes.ToArray()
    }
  }

  'read' {
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    $root = Get-UiaRoot $h
    $el = if ($AutomationId -or $Name -or $ControlType) { Find-Element $root } else { $root }
    $value = Read-ElementText $el
    if ($null -ne $value -and $value.Length -gt $MaxChars) { $value = $value.Substring(0, $MaxChars) }
    Emit @{ ok = $true; pid = $owner; element = (Element-Info $el $false); text = $value; chars = ($value | Measure-Object -Character).Characters }
  }

  # ---- ACT -------------------------------------------------------------

  'launch' {
    if (-not $Path) { Fail 'path_required' 2 }

    # Snapshot every window that already exists. Tabbed applications (Windows 11
    # Notepad, Explorer) answer a launch by adding a TAB to a window that is already
    # open, so "a window belonging to notepad.exe" is not proof that it is OUR window.
    # Binding to it and typing would edit whatever the user had open — this exact case
    # was hit on 2026-08-08 against an unsaved *final_turn_001.md. Anything already on
    # screen before the launch is therefore disqualified unless its title matches the
    # expectation the caller passed in -Name.
    $preExisting = New-Object System.Collections.Generic.HashSet[int64]
    $snapCb = [AtlasDesk+EnumProc]{
      param([IntPtr]$hh, [IntPtr]$ll)
      [void]$preExisting.Add([int64]$hh)
      return $true
    }
    [void][AtlasDesk]::EnumWindows($snapCb, [IntPtr]::Zero)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Path
    if ($Arguments) { $psi.Arguments = $Arguments }
    $psi.UseShellExecute = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $proc) { Fail 'launch_failed' 7 @{ path = $Path } }

    # The process id that Start() hands back is not always the one that owns the
    # window (store-packaged apps such as Calculator relaunch themselves through
    # ApplicationFrameHost). So wait on a *window*, then trust the window's pid.
    $procName = ''
    try { $procName = $proc.ProcessName } catch { }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $found = $null
    $rejected = New-Object System.Collections.ArrayList
    do {
      Start-Sleep -Milliseconds 250
      $candidates = New-Object System.Collections.ArrayList
      $cb = [AtlasDesk+EnumProc]{
        param([IntPtr]$hh, [IntPtr]$ll)
        if (-not [AtlasDesk]::IsWindowVisible($hh)) { return $true }
        $t = Get-WindowTitle $hh
        if ([string]::IsNullOrWhiteSpace($t)) { return $true }
        $wp = 0
        [void][AtlasDesk]::GetWindowThreadProcessId($hh, [ref]$wp)
        $pn = Get-ProcessName ([int]$wp)
        $isNew = -not $preExisting.Contains([int64]$hh)
        $matchPid = ($wp -eq $proc.Id)
        $matchName = ($Name -and $t -like "*$Name*")
        $matchProc = ($procName -and $pn -eq $procName)
        if (-not ($matchPid -or $matchName -or $matchProc)) { return $true }
        # A pre-existing window only qualifies when the caller named a title and this
        # window carries it — that is the caller vouching for the target, not a guess.
        if (-not $isNew -and -not $matchName) {
          [void]$rejected.Add(@{ hwnd = [int64]$hh; pid = [int]$wp; title = $t; process = $pn; reason = 'pre_existing_window' })
          return $true
        }
        $score = 0
        if ($isNew) { $score += 4 }
        if ($matchPid) { $score += 2 }
        if ($matchName) { $score += 1 }
        [void]$candidates.Add(@{ hwnd = [int64]$hh; pid = [int]$wp; title = $t; process = $pn; isNew = $isNew; score = $score })
        return $true
      }
      [void][AtlasDesk]::EnumWindows($cb, [IntPtr]::Zero)
      if ($candidates.Count -gt 0) {
        $found = $candidates | Sort-Object -Property score -Descending | Select-Object -First 1
      }
    } while ($null -eq $found -and (Get-Date) -lt $deadline)

    if ($null -eq $found) {
      # Report what was refused. A caller that sees `pre_existing_window` knows the app
      # answered by reusing a window and can decide, instead of acting on the wrong one.
      Fail 'no_new_window_after_launch' 8 @{
        startedPid = $proc.Id; path = $Path
        rejected = ($rejected | Select-Object -First 5)
        hint = 'tabbed app reused an existing window; pass -Name with the expected title to accept it deliberately'
      }
    }
    $h = [IntPtr]([int64]$found.hwnd)
    $focused = Focus-Window $h
    Emit @{
      ok = $true; pid = $found.pid; startedPid = $proc.Id; hwnd = $found.hwnd
      title = $found.title; process = $found.process; focused = $focused
      newWindow = $found.isNew
      reusedWindow = (-not $found.isNew)
    }
  }

  'focus' {
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    $ok = Focus-Window $h
    if (-not $ok) { Fail 'focus_not_confirmed' 7 @{ pid = $owner; hwnd = [int64]$h } }
    Emit @{ ok = $true; pid = $owner; hwnd = [int64]$h; title = (Get-WindowTitle $h) }
  }

  'settext' {
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    $root = Get-UiaRoot $h
    $el = Find-Element $root
    $vp = Get-Pattern $el 'Value'
    if ($vp.Current.IsReadOnly) { Fail 'element_read_only' 6 @{ element = (Element-Info $el $false) } }
    $vp.SetValue($Text)
    Start-Sleep -Milliseconds 120
    # Read back through the same pattern: an action is only done when its effect is observable.
    $after = Read-ElementText $el
    if ($after -ne $Text) {
      $actualLen = 0
      if ($null -ne $after) { $actualLen = $after.Length }
      Fail 'settext_verify_failed' 7 @{ expectedChars = $Text.Length; actualChars = $actualLen }
    }
    Emit @{ ok = $true; pid = $owner; element = (Element-Info $el $false); chars = $Text.Length; verified = $true }
  }

  'invoke' {
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    $root = Get-UiaRoot $h
    $el = Find-Element $root
    $info = Element-Info $el $false
    $ip = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
      $ip.Invoke()
    } else {
      $sp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) {
        $sp.Select()
      } else {
        $tp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
          $tp.Toggle()
        } else {
          Fail 'pattern_not_supported' 6 @{ tried = @('Invoke', 'SelectionItem', 'Toggle'); element = $info }
        }
      }
    }
    Start-Sleep -Milliseconds 120
    Emit @{ ok = $true; pid = $owner; element = $info }
  }

  'click' {
    # Coordinates are derived from the element's own bounding rectangle, never taken
    # from the caller. There is deliberately no "click at x,y" action: a raw point is
    # unverifiable and lands wherever the desktop happens to be at that moment.
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    [void](Focus-Window $h)
    $root = Get-UiaRoot $h
    $el = Find-Element $root
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.X) -or $r.Width -le 0 -or $r.Height -le 0) {
      Fail 'element_not_clickable' 7 @{ element = (Element-Info $el $false) }
    }
    $cx = [int]($r.X + $r.Width / 2)
    $cy = [int]($r.Y + $r.Height / 2)
    $down = if ($Button -eq 'right') { [AtlasDesk]::MOUSEEVENTF_RIGHTDOWN } else { [AtlasDesk]::MOUSEEVENTF_LEFTDOWN }
    $up = if ($Button -eq 'right') { [AtlasDesk]::MOUSEEVENTF_RIGHTUP } else { [AtlasDesk]::MOUSEEVENTF_LEFTUP }
    [void][AtlasDesk]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 60
    $presses = if ($Double) { 2 } else { 1 }
    for ($i = 0; $i -lt $presses; $i++) {
      [AtlasDesk]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [AtlasDesk]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      if ($i -lt $presses - 1) { Start-Sleep -Milliseconds 60 }
    }
    Start-Sleep -Milliseconds 120
    Emit @{ ok = $true; pid = $owner; element = (Element-Info $el $false); point = @{ x = $cx; y = $cy }; button = $Button; presses = $presses }
  }

  'keys' {
    if (-not $Keys) { Fail 'keys_required' 2 }
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    if (-not (Focus-Window $h)) { Fail 'focus_not_confirmed' 7 @{ pid = $owner } }
    # Keystrokes are only ever sent once the intended window is confirmed foreground,
    # so a failed focus can never spray input across whatever else is on screen.
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Start-Sleep -Milliseconds 200
    Emit @{ ok = $true; pid = $owner; hwnd = [int64]$h; sent = $Keys.Length }
  }

  'ocr' {
    # Pixels, for the surfaces UI Automation cannot see: browser canvas, Electron apps
    # with no accessibility tree, games, remote desktop. Windows.Media.Ocr is used rather
    # than the local documents adapter on :8766 — that adapter runs PaddleOCR-VL on CPU
    # and had not answered a single 1293x765 window after five minutes (4482s of CPU
    # burned), while this returns in under two seconds and ships with the OS. The adapter
    # stays the right tool for scanned documents; it is the wrong one for a screen.
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    function AwaitOp($op, $t) {
      $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
      [void]$task.Wait(-1)
      return $task.Result
    }
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

    $installed = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    # No image means the caller is asking what this machine can read, not asking to read
    # something. Answering that through a deliberate failure would make the language list
    # reachable only by catching an error.
    if (-not $Path) { Emit @{ ok = $true; mode = 'languages'; available = $installed } }
    $img = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $img) { Fail 'image_not_found' 2 @{ path = $Path; available = $installed } }

    $engine = $null
    if ($Name) {
      # Caller asked for a specific language; only honour it if the pack is installed,
      # otherwise say so rather than silently reading Cyrillic with an English model.
      $lang = New-Object Windows.Globalization.Language($Name)
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      if ($null -eq $engine) {
        Fail 'ocr_language_not_installed' 5 @{
          requested = $Name
          available = ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
        }
      }
    } else {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) { Fail 'no_ocr_language' 5 }

    # Windows OCR is trained on dark text over a light page and returns almost nothing for
    # light-on-dark. That is not an edge case here: the calculator, the editors and the
    # browsers on this machine are all dark-themed, and a capture showing "72" in 100px
    # digits produced 6 lines with no 72 in them. Sample the luminance and invert first.
    $probe = [System.Drawing.Bitmap]::FromFile($img.Path)
    $sum = 0.0; $n = 0
    $stepX = [Math]::Max(1, [int]($probe.Width / 40))
    $stepY = [Math]::Max(1, [int]($probe.Height / 40))
    for ($px = 0; $px -lt $probe.Width; $px += $stepX) {
      for ($py = 0; $py -lt $probe.Height; $py += $stepY) {
        $c = $probe.GetPixel($px, $py)
        $sum += ($c.R * 0.299 + $c.G * 0.587 + $c.B * 0.114) / 255.0
        $n++
      }
    }
    $meanLuma = if ($n -gt 0) { $sum / $n } else { 1.0 }
    $inverted = $false
    $ocrPath = $img.Path
    if ($meanLuma -lt 0.45) {
      $inv = New-Object System.Drawing.Bitmap($probe.Width, $probe.Height)
      $g = [System.Drawing.Graphics]::FromImage($inv)
      $matrix = New-Object System.Drawing.Imaging.ColorMatrix(, [float[][]](
        [float[]](-1, 0, 0, 0, 0), [float[]](0, -1, 0, 0, 0), [float[]](0, 0, -1, 0, 0),
        [float[]](0, 0, 0, 1, 0), [float[]](1, 1, 1, 0, 1)))
      $attrs = New-Object System.Drawing.Imaging.ImageAttributes
      $attrs.SetColorMatrix($matrix)
      $rect = New-Object System.Drawing.Rectangle(0, 0, $probe.Width, $probe.Height)
      $g.DrawImage($probe, $rect, 0, 0, $probe.Width, $probe.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
      $g.Dispose()
      $ocrPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($img.Path),
        [System.IO.Path]::GetFileNameWithoutExtension($img.Path) + '.inverted.png')
      $inv.Save($ocrPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $inv.Dispose()
      $inverted = $true
    }
    $probe.Dispose()

    $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ocrPath)) ([Windows.Storage.StorageFile])
    $stream = AwaitOp ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = AwaitOp ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = New-Object System.Collections.ArrayList
    foreach ($ln in $result.Lines) {
      [void]$lines.Add($ln.Text)
      if ($lines.Count -ge $MaxNodes) { break }
    }
    $text = $result.Text
    if ($null -ne $text -and $text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) }
    $stream.Dispose()
    Emit @{
      ok = $true; path = $img.Path
      language = $engine.RecognizerLanguage.LanguageTag
      lineCount = [int]$lines.Count
      lines = $lines.ToArray()
      text = $text
      available = $installed
      meanLuma = [math]::Round($meanLuma, 3)
      inverted = $inverted
    }
  }

  'processes' {
    # Read-only inventory of what is running, so a caller can tell "the app is not open"
    # from "the app is open but has no window". No kill action is offered here: ending a
    # process is destructive and belongs behind `close`, which refuses shared hosts.
    $rows = New-Object System.Collections.ArrayList
    $withWindows = New-Object System.Collections.Generic.HashSet[int]
    $cb = [AtlasDesk+EnumProc]{
      param([IntPtr]$hh, [IntPtr]$ll)
      if (-not [AtlasDesk]::IsWindowVisible($hh)) { return $true }
      if ([string]::IsNullOrWhiteSpace((Get-WindowTitle $hh))) { return $true }
      $wp = 0
      [void][AtlasDesk]::GetWindowThreadProcessId($hh, [ref]$wp)
      [void]$withWindows.Add([int]$wp)
      return $true
    }
    [void][AtlasDesk]::EnumWindows($cb, [IntPtr]::Zero)
    $procs = Get-Process | Sort-Object -Property WorkingSet64 -Descending
    if ($Name) { $procs = $procs | Where-Object { $_.ProcessName -like "*$Name*" } }
    foreach ($p in ($procs | Select-Object -First $MaxNodes)) {
      [void]$rows.Add([ordered]@{
        pid = $p.Id; name = $p.ProcessName
        memMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
        hasWindow = $withWindows.Contains($p.Id)
      })
    }
    Emit @{ ok = $true; count = $rows.Count; processes = $rows.ToArray() }
  }

  'window' {
    # Move / resize / minimise / maximise / restore. Geometry is verified by reading the
    # rectangle back: a window can refuse a size (minimum tracking size, snap layouts,
    # DPI rounding) and MoveWindow still returns true, so its return value proves nothing.
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    $before = Get-WindowBounds $h
    $state = $Text.ToLowerInvariant()
    switch ($state) {
      'minimize' { [void][AtlasDesk]::ShowWindow($h, 6) }
      'maximize' { [void][AtlasDesk]::ShowWindow($h, 3) }
      'restore'  { [void][AtlasDesk]::ShowWindow($h, 9) }
      ''         {
        if ($Bounds -notmatch '^\-?\d+,\-?\d+,\d+,\d+$') {
          Fail 'bounds_required' 2 @{ hint = 'pass -Text minimize|maximize|restore, or -Bounds "x,y,w,h"' }
        }
        $p = $Bounds.Split(',')
        [void][AtlasDesk]::MoveWindow($h, [int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3], $true)
      }
      default { Fail 'unknown_window_state' 2 @{ given = $state; known = @('minimize', 'maximize', 'restore') } }
    }
    Start-Sleep -Milliseconds 300
    $after = Get-WindowBounds $h
    $minimized = [bool][AtlasDesk]::IsIconic($h)
    if ($state -eq 'minimize' -and -not $minimized) { Fail 'window_state_verify_failed' 7 @{ wanted = 'minimize'; minimized = $minimized } }
    $constrained = $false
    if ($state -eq '' -and $after) {
      $p = $Bounds.Split(',')
      # Tolerance covers the invisible resize border Windows keeps outside the frame.
      $off = ([Math]::Abs($after.w - [int]$p[2]) -gt 24) -or ([Math]::Abs($after.h - [int]$p[3]) -gt 24)
      $moved = ($null -eq $before) -or ($after.x -ne $before.x) -or ($after.y -ne $before.y) -or
               ($after.w -ne $before.w) -or ($after.h -ne $before.h)
      # An application may enforce a minimum tracking size — Calculator refused a 900px
      # height and settled at 1014 while honouring the position and width. That is the
      # app exercising its own rules, not a failed call, so it is reported rather than
      # thrown. A window that did not move AT ALL is a genuine failure.
      if ($off -and -not $moved) {
        Fail 'window_geometry_unchanged' 7 @{ wanted = @{ w = [int]$p[2]; h = [int]$p[3] }; got = $after }
      }
      $constrained = $off
    }
    Emit @{
      ok = $true; pid = $owner; hwnd = [int64]$h
      before = $before; after = $after; minimized = $minimized; constrained = $constrained
    }
  }

  'scroll' {
    # Wheel notches land where the cursor is, so the cursor is parked over the target
    # element first — scrolling "the window" without saying where lands in whatever
    # pane the mouse was already over.
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    [void](Focus-Window $h)
    $root = Get-UiaRoot $h
    $el = if ($AutomationId -or $Name -or $ControlType) { Find-Element $root } else { $root }
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.X)) { Fail 'element_not_scrollable' 7 @{ element = (Element-Info $el $false) } }
    [void][AtlasDesk]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
    Start-Sleep -Milliseconds 60
    $notches = if ($Index -ne 0) { $Index } else { -3 }
    # Scrolling down is a NEGATIVE delta, and [uint32](-360) throws in PowerShell rather
    # than wrapping. Reinterpret the bits instead of converting the value.
    $delta = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]($notches * 120)), 0)
    [AtlasDesk]::mouse_event([AtlasDesk]::MOUSEEVENTF_WHEEL, 0, 0, $delta, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    Emit @{ ok = $true; pid = $owner; notches = $notches; element = (Element-Info $el $false) }
  }

  'clipboard' {
    # Reading the clipboard is a read of whatever the operator last copied, so it is
    # returned but never logged elsewhere, and it is capped like any other text read.
    if ($Text) {
      Set-Clipboard -Value $Text
      Start-Sleep -Milliseconds 120
      $back = Get-Clipboard -Raw
      if ($back -ne $Text) { Fail 'clipboard_verify_failed' 7 @{ expectedChars = $Text.Length } }
      Emit @{ ok = $true; mode = 'set'; chars = $Text.Length; verified = $true }
    }
    $v = Get-Clipboard -Raw
    if ($null -eq $v) { $v = '' }
    if ($v.Length -gt $MaxChars) { $v = $v.Substring(0, $MaxChars) }
    Emit @{ ok = $true; mode = 'get'; text = $v; chars = $v.Length }
  }

  'hotkey' {
    # SendKeys parses a mini-language and drops modifiers when the input queue is busy:
    # `^s` arrived at Notepad on 2026-08-08 as a literal "s", appending a character
    # instead of saving. keybd_event presses and releases real virtual keys in order,
    # so a chord is a chord. Format: "ctrl+s", "ctrl+shift+n", "alt+f4", "enter".
    if (-not $Keys) { Fail 'keys_required' 2 }
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    if (-not (Focus-Window $h)) { Fail 'focus_not_confirmed' 7 @{ pid = $owner } }
    Start-Sleep -Milliseconds 250

    $vk = @{
      'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'win' = 0x5B
      'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
      'space' = 0x20; 'back' = 0x08; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E
      'home' = 0x24; 'end' = 0x23; 'pgup' = 0x21; 'pgdn' = 0x22
      'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
      'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
      'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
    }
    $parts = $Keys.Split('+') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ }
    if ($parts.Count -eq 0) { Fail 'keys_unparsable' 2 @{ keys = $Keys } }

    $codes = @()
    foreach ($p in $parts) {
      if ($vk.ContainsKey($p)) { $codes += [byte]$vk[$p]; continue }
      if ($p.Length -eq 1) {
        $ch = $p[0]
        # Accelerators are defined by virtual-key code, not by the character the
        # current layout would produce. VkKeyScan asks the ACTIVE layout and returned
        # -1 for 's' on 2026-08-08 because the keyboard was in Russian — Ctrl+S would
        # have been unreachable for as long as the layout stayed RU. Latin letters and
        # digits map straight to their VK codes, which is layout-independent.
        if ($ch -ge 'a' -and $ch -le 'z') { $codes += [byte](0x41 + ([int][char]$ch - [int][char]'a')); continue }
        if ($ch -ge '0' -and $ch -le '9') { $codes += [byte](0x30 + ([int][char]$ch - [int][char]'0')); continue }
        $scan = [AtlasDesk]::VkKeyScan($ch)
        if ($scan -eq -1) { Fail 'key_not_mappable' 2 @{ key = $p; hint = 'not a latin letter/digit and unmappable in the active keyboard layout' } }
        $codes += [byte]($scan -band 0xFF)
        continue
      }
      Fail 'unknown_key' 2 @{ key = $p; known = ($vk.Keys | Sort-Object) }
    }

    $KEYUP = 0x0002
    foreach ($c in $codes) { [AtlasDesk]::keybd_event($c, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
    [array]::Reverse($codes)
    foreach ($c in $codes) { [AtlasDesk]::keybd_event($c, 0, $KEYUP, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
    Start-Sleep -Milliseconds 350
    Emit @{ ok = $true; pid = $owner; hwnd = [int64]$h; chord = $Keys; keys = $codes.Count; titleAfter = (Get-WindowTitle $h) }
  }

  'close' {
    $h = Resolve-Hwnd $Hwnd
    $owner = Assert-WindowPid $h $TargetPid
    if ($TargetPid -le 0) { Fail 'pid_required_for_close' 2 @{ hint = 'closing is only allowed against an explicitly owned pid' } }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $closed = $false
    if ($null -ne $root) {
      $wp = $null
      if ($root.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
        try { $wp.Close(); $closed = $true } catch { }
      }
    }
    if (-not $closed) {
      # Killing the process is only safe when this window is the only thing it owns.
      # Store apps share a host: Calculator and Media Player both lived in the same
      # ApplicationFrameHost pid on 2026-08-08, so a fallback Stop-Process would have
      # taken down an unrelated window the caller never named. Refuse instead.
      $siblings = 0
      $sibCb = [AtlasDesk+EnumProc]{
        param([IntPtr]$hh, [IntPtr]$ll)
        if (-not [AtlasDesk]::IsWindowVisible($hh)) { return $true }
        if ([string]::IsNullOrWhiteSpace((Get-WindowTitle $hh))) { return $true }
        $wp = 0
        [void][AtlasDesk]::GetWindowThreadProcessId($hh, [ref]$wp)
        if ($wp -eq $owner) { $script:siblings++ }
        return $true
      }
      [void][AtlasDesk]::EnumWindows($sibCb, [IntPtr]::Zero)
      if ($script:siblings -gt 1) {
        Fail 'close_would_kill_shared_process' 7 @{
          pid = $owner; windowsOwnedByPid = $script:siblings
          hint = 'window did not honour WindowPattern.Close and its process hosts other windows; refusing to Stop-Process'
        }
      }
      try { Stop-Process -Id $owner -ErrorAction Stop; $closed = $true } catch { }
    }
    Start-Sleep -Milliseconds 400
    $alive = $true
    try { $null = Get-Process -Id $owner -ErrorAction Stop } catch { $alive = $false }
    Emit @{ ok = $true; pid = $owner; closed = $closed; processAlive = $alive }
  }

  default { Fail 'unknown_action' 2 @{ given = $Action } }
}
