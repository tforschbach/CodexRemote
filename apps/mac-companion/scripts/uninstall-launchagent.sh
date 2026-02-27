#!/bin/bash
set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/com.codexremote.companion.plist"

if [[ -f "$PLIST_PATH" ]]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "LaunchAgent removed"
else
  echo "No LaunchAgent found"
fi
