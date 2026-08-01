@echo off
setlocal EnableExtensions

REM --------------------------------------------------------------------
REM disable-legacy-atlasrunner-elevated.cmd
REM
REM CEO one-tap (Run as Administrator) after S4 live via AtlasRunnerS4.
REM Stops + disables the OLD "AtlasRunner" task that still points at
REM primary ANUS `node.exe dist\cli.js` (no state-root binding).
REM Does NOT touch AtlasRunnerS4.
REM
REM Safe to re-run. Rollback: Task Scheduler → AtlasRunner → Enable.
REM --------------------------------------------------------------------

net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: Run this file as Administrator ^(right-click → Run as administrator^).
  echo Without elevation Windows returns Access Denied on AtlasRunner.
  exit /b 1
)

echo Disabling legacy scheduled task: AtlasRunner
schtasks /End /TN "AtlasRunner" >nul 2>&1
schtasks /Change /TN "AtlasRunner" /DISABLE
if errorlevel 1 (
  echo FAIL: could not disable AtlasRunner. Is the task name exact?
  schtasks /Query /TN "AtlasRunner" /FO LIST
  exit /b 2
)

echo.
echo Legacy AtlasRunner: DISABLED
schtasks /Query /TN "AtlasRunner" /FO LIST | findstr /I "TaskName Status"
echo.
echo AtlasRunnerS4 should remain Running ^(S4 local activation^):
schtasks /Query /TN "AtlasRunnerS4" /FO LIST 2>nul | findstr /I "TaskName Status"
if errorlevel 1 echo ^(AtlasRunnerS4 not found — check S4 live receipt^)
echo.
echo Done. Next logon will not revive legacy runner while it stays Disabled.
exit /b 0
