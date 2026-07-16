@echo off
REM Launch the Atlas desktop tray. Windows PowerShell 5.1 is STA by default,
REM which WinForms requires. Hidden console; the UI lives in the system tray.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File "%~dp0atlas-tray.ps1" %*
