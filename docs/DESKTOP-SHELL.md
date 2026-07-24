# Atlas Desktop Shell (Phase 2)

A minimal Windows **system-tray client** for Atlas. It makes Atlas visible and
gives you a panic switch without needing Telegram. It is a **thin client** — not
a second brain: no orchestrator, no swarm, no model calls. Cloud Atlas remains
the source of truth for chat/swarm; Telegram remains the primary remote UI.

Location: `apps/desktop/` — `atlas-tray.ps1`, `start-atlas-tray.cmd`, `package.json`.

## What it shows
A tray icon (green = online, amber = locally paused, red = cloud unreachable) and
a small status window with:
- **state** — online / PAUSED (local) / offline
- **cloud** — reachable (HTTP 200) or UNREACHABLE
- **uptime · providers · bootTime** — straight from the cloud `/health` JSON
- **pause file** — whether local autonomy is halted
- **polled** — last poll time

Buttons: **PANIC**, **Resume**, **Refresh**. Menu adds **Open status window**,
**Mute voice (stub)**, **Cloud pause — how?**, **Open Telegram**, **Quit tray**.

## Run
```
apps\desktop\start-atlas-tray.cmd
```
or `npm start` inside `apps/desktop`. Optional flags:
```
powershell -STA -File atlas-tray.ps1 -PollSeconds 15 -ShowOnStart `
  -HealthUrl https://fantastic-generosity-production-df90.up.railway.app/health
```
- `-ShowOnStart` opens the status window immediately (otherwise it lives in the tray; single **left-click** the tray icon to open it).
- Autostart (optional): drop a shortcut to `start-atlas-tray.cmd` into `shell:startup`.

## Panic — one pause, three surfaces
The shell's **PANIC** writes a local marker file (default `%USERPROFILE%\.atlas\PAUSE`,
override with `-PauseFile` / env `ATLAS_PAUSE_FILE`). `isPaused()` in
`src/atlas/spend-policy.ts` checks this file, so **any local Atlas process** (the
CLI, the `/task` subprocess) halts — verified: with the file present, `runTask()`
returns `blocked` "Emergency pause active". **Resume** deletes the file.

| Surface | How | Effect |
|---|---|---|
| **Local** | Tray PANIC (writes the pause file) | Halts local Atlas processes instantly, no redeploy |
| **Cloud — instant** | Telegram `/pause` (CEO only) | Halts the live bot's autonomy in-process |
| **Cloud — durable** | Set `ATLAS_PAUSE=1` on the Railway service | Survives redeploys |

The tray deliberately does **not** print secrets or auto-bounce prod. For an
instant cloud stop it points you at Telegram `/pause` (shipped in Phase 1); the
"Cloud pause — how?" menu item spells this out.

## How it talks to Atlas
- **Reads**: HTTP GET on the cloud `/health` endpoint every `PollSeconds`. No auth, no secrets.
- **Writes**: the local pause file only. It does **not** hold the bot token or call the Telegram API.
- No impact on the bot's Railway deploy: `apps/desktop` has its own `package.json`
  with **no dependencies**, and the bot build (`npm ci` at the ANUS root) never installs it.

## Stack choice (why PowerShell/WinForms)
Picked the **smallest path that ships on Windows** with zero install and zero risk
to the bot deploy:
- **PowerShell 5.1 + WinForms `NotifyIcon`** (chosen) — ships with Windows, no
  install, native tray, stays a single script in the monorepo. Windows PowerShell
  5.1 runs STA by default (required by WinForms). Pattern: `ApplicationContext` +
  `Application.Run` + a `Timer` (never `Start-Sleep`, which freezes the UI); the
  `NotifyIcon` is disposed on Quit so it doesn't linger.
- **Electron** — rejected: ~150 MB Chromium, and adding it to the repo risks
  polluting the bot's Railway image (devDep install during every build).
- **Tauri** — rejected: adds a Rust toolchain + WebView2 setup to a Node monorepo.

The script is **ASCII-only** on purpose: Windows PowerShell 5.1 reads a no-BOM
`.ps1` as ANSI, so non-ASCII glyphs corrupt parsing.

## Caveats
- **Mute** is a stub — there is no local voice/TTS path yet (STT lives cloud-side
  in the bot). The menu item documents this.
- Windows only (by design — the CEO machine is Windows).
- If the process is killed instead of using **Quit tray**, the tray icon may
  linger until you hover it (a known .NET `NotifyIcon` quirk); Quit disposes it cleanly.
- The pause file is process-local to the machine; it does not pause the cloud bot
  (use the cloud surfaces above for that).

## Not in scope (Phase 3)
Screen capture, repo-watch, email — deferred. This shell is status + panic + link only.
