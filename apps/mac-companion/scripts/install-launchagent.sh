#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.codexremote.companion.plist"
NODE_BIN="$(command -v node)"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "node binary not found"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$REPO_ROOT/logs"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.codexremote.companion</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE_BIN</string>
      <string>$APP_DIR/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$REPO_ROOT/logs/mac-companion.out.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO_ROOT/logs/mac-companion.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PORT</key>
      <string>8787</string>
    </dict>
  </dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "LaunchAgent installed: $PLIST_PATH"
