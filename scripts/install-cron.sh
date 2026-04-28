#!/usr/bin/env bash
WORK_DIR="C:/Users/user/OneDrive/Documents/GitHub/ANUS"
STARTUP_DIR="$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup"
VBS_FILE="$STARTUP_DIR/AtlasCron.vbs"

cat > "$VBS_FILE" << VBS
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\Program Files\Git\bin\bash.exe"" ""$WORK_DIR/scripts/atlas-cron.sh""", 0, False
VBS

if [ -f "$VBS_FILE" ]; then
  echo "AtlasCron installed in Windows Startup."
  echo "Path: $VBS_FILE"
  echo "Runs atlas-cron.sh every 30 min in background. Starts on login."
  echo "Remove: rm \"$VBS_FILE\""
else
  echo "FAILED: could not write to Startup folder."
  exit 1
fi
