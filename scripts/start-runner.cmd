@echo off
setlocal

REM ---------------------------------------------------------------------
REM start-runner.cmd — autostart wrapper for the Atlas L2 local runner.
REM
REM Intended as the Windows scheduled task "AtlasRunner" wrapper (see
REM docs/runbooks/bootstrap.md section 7). Exists because the task used
REM to invoke `node dist\cli.js runner start` directly, and NOTHING in
REM the merge/deploy path rebuilt dist/ — so the runner silently executed
REM a build many commits old (found live 2026-07-28: it predated
REM src/atlas/queue-auth.ts, leaving the P0.1 signing gate inert).
REM
REM Two independent defences, deliberately both:
REM   1. this wrapper rebuilds before starting;
REM   2. `runner start` itself refuses to run a dist/ older than src/,
REM      so a launch that bypasses this wrapper still cannot go stale.
REM
REM A failed build is NOT swallowed: we still hand off to the runner,
REM whose own freshness gate then refuses loudly and exits non-zero.
REM Down-and-logged beats up-and-lying.
REM
REM Usage:  scripts\start-runner.cmd [extra args passed to `runner start`]
REM ---------------------------------------------------------------------

cd /d "%~dp0.."

set "ATLAS_RUNNER_LOG=%USERPROFILE%\.atlas\runner-autostart.log"
if not exist "%USERPROFILE%\.atlas" mkdir "%USERPROFILE%\.atlas"

set "ATLAS_RUNNER_ARGS=%*"
if "%ATLAS_RUNNER_ARGS%"=="" set "ATLAS_RUNNER_ARGS=--interval 20"

echo. >> "%ATLAS_RUNNER_LOG%"
echo ==== AtlasRunner autostart %DATE% %TIME% ==== >> "%ATLAS_RUNNER_LOG%"
echo [wrapper] cwd=%CD% >> "%ATLAS_RUNNER_LOG%"

echo [wrapper] rebuilding dist/ before start... >> "%ATLAS_RUNNER_LOG%"
call npm run build >> "%ATLAS_RUNNER_LOG%" 2>&1
if errorlevel 1 (
  echo [wrapper] BUILD FAILED ^(exit %ERRORLEVEL%^) — starting anyway so the runner's own >> "%ATLAS_RUNNER_LOG%"
  echo [wrapper] freshness gate decides; expect a loud refusal if dist/ is stale. >> "%ATLAS_RUNNER_LOG%"
) else (
  echo [wrapper] build ok >> "%ATLAS_RUNNER_LOG%"
)

echo [wrapper] launching: node dist\cli.js runner start %ATLAS_RUNNER_ARGS% >> "%ATLAS_RUNNER_LOG%"
node dist\cli.js runner start %ATLAS_RUNNER_ARGS% >> "%ATLAS_RUNNER_LOG%" 2>&1
set "RUNNER_EXIT=%ERRORLEVEL%"

echo [wrapper] runner exited with %RUNNER_EXIT% >> "%ATLAS_RUNNER_LOG%"
exit /b %RUNNER_EXIT%
