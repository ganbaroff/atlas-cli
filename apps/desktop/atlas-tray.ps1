<#
  Atlas desktop shell - minimal Windows system-tray client (Phase 2).

  WHAT IT IS: a THIN client. It shows Atlas's cloud health, exposes a local
  PANIC switch, and links to the Telegram control plane. It is NOT a second brain
  - no orchestrator, no swarm, no model calls. Cloud Atlas stays the source of
  truth for chat/swarm.

  STACK: Windows PowerShell 5.1 + WinForms (NotifyIcon). Zero install, native,
  no impact on the bot's Railway deploy. See docs/DESKTOP-SHELL.md for the
  rationale vs Electron/Tauri. NOTE: ASCII-only on purpose - PowerShell 5.1 reads
  a no-BOM .ps1 as ANSI, so non-ASCII glyphs corrupt parsing.

  PANIC SEMANTICS (one pause, three surfaces):
    - Local : this tray writes a pause file; isPaused() in spend-policy.ts sees
              it, so any LOCAL Atlas process (CLI, /task subprocess) halts.
    - Cloud : instant  = Telegram /pause (CEO). durable = Railway ATLAS_PAUSE var.
              (The tray does not print secrets or bounce prod automatically.)

  Pattern per research: ApplicationContext + Application.Run + a Timer (never
  Start-Sleep), and dispose the NotifyIcon on exit so it does not linger.
#>

param(
  [string]$HealthUrl = 'https://fantastic-generosity-production-df90.up.railway.app/health',
  [int]$PollSeconds = 15,
  [string]$PauseFile = (Join-Path $env:USERPROFILE '.atlas\PAUSE'),
  [string]$TelegramUrl = 'https://t.me/volaurabot',
  [switch]$ShowOnStart
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── Icons (built once; reused - GetHicon allocates a handle each call) ──
function New-DotIcon([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($brush, 2, 2, 12, 12)
  $g.Dispose(); $brush.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icoOnline  = New-DotIcon ([System.Drawing.Color]::FromArgb(46, 204, 113))   # green
$icoPaused  = New-DotIcon ([System.Drawing.Color]::FromArgb(241, 196, 15))   # amber
$icoOffline = New-DotIcon ([System.Drawing.Color]::FromArgb(231, 76, 60))    # red

# ── Shared state ──
$script:lastStatus = 'starting'
$script:lastLine   = 'polling'
$script:lastHealth = @{ ok = $false }

function Test-Panic { Test-Path -LiteralPath $PauseFile }

function Set-Panic {
  $dir = Split-Path -Parent $PauseFile
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -LiteralPath $PauseFile -Value ("paused " + (Get-Date -Format o)) -Encoding ASCII
  Update-Ui
}
function Clear-Panic {
  if (Test-Panic) { Remove-Item -LiteralPath $PauseFile -Force }
  Update-Ui
}

function Get-Health {
  try {
    $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 8 -ErrorAction Stop
    return @{ ok = $true; status = $r.status; uptime = $r.uptime; providers = $r.providers; bootTime = $r.bootTime }
  } catch {
    return @{ ok = $false }
  }
}

# ── Tray + status window ──
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miHeader  = $menu.Items.Add('Atlas - starting'); $miHeader.Enabled = $false
$miLine    = $menu.Items.Add('polling');          $miLine.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miOpen    = $menu.Items.Add('Open status window')
$miMute    = New-Object System.Windows.Forms.ToolStripMenuItem 'Mute voice (stub - no local voice)'
$miMute.CheckOnClick = $true
[void]$menu.Items.Add($miMute)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miPanic   = $menu.Items.Add('*** PANIC - pause Atlas (local) ***')
$miResume  = $menu.Items.Add('Resume')
$miCloud   = $menu.Items.Add('Cloud pause - how? (Telegram /pause . Railway var)')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miTg      = $menu.Items.Add('Open Telegram (volaurabot)')
$miQuit    = $menu.Items.Add('Quit tray')

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icoOffline
$notify.Text = 'Atlas - starting'
$notify.Visible = $true
$notify.ContextMenuStrip = $menu

# Small status window (hidden until opened; closing hides, does not exit).
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Atlas'
$form.Size = New-Object System.Drawing.Size(380, 250)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedToolWindow'
$form.ShowInTaskbar = $false
$lbl = New-Object System.Windows.Forms.Label
$lbl.AutoSize = $false
$lbl.Dock = 'Top'
$lbl.Height = 160
$lbl.Padding = New-Object System.Windows.Forms.Padding(12, 12, 12, 12)
$lbl.Font = New-Object System.Drawing.Font('Consolas', 9)
$form.Controls.Add($lbl)
$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Dock = 'Bottom'; $panel.Height = 44; $panel.Padding = New-Object System.Windows.Forms.Padding(8, 6, 8, 6)
$btnPanic  = New-Object System.Windows.Forms.Button; $btnPanic.Text = 'PANIC'; $btnPanic.Width = 80
$btnResume = New-Object System.Windows.Forms.Button; $btnResume.Text = 'Resume'; $btnResume.Width = 80
$btnRefresh= New-Object System.Windows.Forms.Button; $btnRefresh.Text = 'Refresh'; $btnRefresh.Width = 80
$panel.Controls.AddRange(@($btnPanic, $btnResume, $btnRefresh))
$form.Controls.Add($panel)
$form.Add_FormClosing({ param($s, $e) $e.Cancel = $true; $form.Hide() })

function Update-Ui {
  $paused = Test-Panic
  $h = $script:lastHealth
  if (-not $h) { $h = @{ ok = $false } }

  if ($paused) {
    $script:lastStatus = 'PAUSED (local)'
    $notify.Icon = $icoPaused
  } elseif ($h.ok) {
    $script:lastStatus = 'online'
    $notify.Icon = $icoOnline
  } else {
    $script:lastStatus = 'offline / unreachable'
    $notify.Icon = $icoOffline
  }

  if ($h.ok) {
    $script:lastLine = "uptime $($h.uptime) . providers $($h.providers)"
  } else {
    $script:lastLine = 'cloud /health unreachable'
  }

  $head = "Atlas - $script:lastStatus"
  $miHeader.Text = $head
  $miLine.Text = $script:lastLine
  $tip = $head + "`n" + $script:lastLine
  $notify.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))
  $miResume.Enabled = $paused
  $miPanic.Enabled  = -not $paused

  $cloudTxt = if ($h.ok) { 'reachable (HTTP 200)' } else { 'UNREACHABLE' }
  $upTxt    = if ($h.ok) { $h.uptime } else { '-' }
  $provTxt  = if ($h.ok) { $h.providers } else { '-' }
  $bootTxt  = if ($h.ok) { $h.bootTime } else { '-' }
  $pauseTxt = if ($paused) { 'PRESENT -> local autonomy halted' } else { 'none' }
  $polled   = Get-Date -Format 'HH:mm:ss'
  $lbl.Text = @"
Atlas desktop shell (thin client)

  state      : $script:lastStatus
  cloud      : $cloudTxt
  uptime     : $upTxt
  providers  : $provTxt
  bootTime   : $bootTxt
  pause file : $pauseTxt
  polled     : $polled
"@
  $btnPanic.Enabled = -not $paused
  $btnResume.Enabled = $paused
}

function Poll {
  $script:lastHealth = Get-Health
  Update-Ui
}

# ── Wiring ──
# Single LEFT-click on the tray icon opens the status window (works even where the
# desktop-control tier blocks right-click / the context menu).
$notify.Add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { $form.Show(); $form.Activate() } })
$miOpen.Add_Click({ $form.Show(); $form.Activate() })
$miPanic.Add_Click({ Set-Panic; $notify.ShowBalloonTip(3000, 'Atlas', 'PANIC: local autonomy paused. Cloud: use /pause in Telegram.', 'Warning') })
$btnPanic.Add_Click({ Set-Panic; $notify.ShowBalloonTip(3000, 'Atlas', 'PANIC: local autonomy paused.', 'Warning') })
$miResume.Add_Click({ Clear-Panic })
$btnResume.Add_Click({ Clear-Panic })
$btnRefresh.Add_Click({ Poll })
$miCloud.Add_Click({
  [System.Windows.Forms.MessageBox]::Show(
    "Instant cloud pause:  send /pause to the bot in Telegram (CEO only).`n`nDurable cloud pause:  set ATLAS_PAUSE=1 on the Railway service; it survives redeploys.`n`nThis tray's PANIC pauses LOCAL Atlas processes only (writes $PauseFile).",
    'Atlas - cloud pause', 'OK', 'Information') | Out-Null
})
$miTg.Add_Click({ Start-Process $TelegramUrl })
$miMute.Add_Click({
  if ($miMute.Checked) {
    $notify.ShowBalloonTip(3000, 'Atlas', 'Mute is a stub - no local voice/TTS path yet (STT is cloud-side in the bot).', 'Info')
  }
})

$appContext = New-Object System.Windows.Forms.ApplicationContext
$miQuit.Add_Click({
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  $appContext.ExitThread()
})

# Timer drives polling inside the message loop (never Start-Sleep - that freezes UI).
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(3, $PollSeconds) * 1000
$timer.Add_Tick({ Poll })
$timer.Start()

Poll  # first paint immediately
if ($ShowOnStart) { $form.Show(); $form.Activate() }
[System.Windows.Forms.Application]::Run($appContext)
