#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"

echo "[Artemis] Installing dependencies..."
cd "$PLUGIN_DIR" && npm install

echo "[Artemis] Installing Playwright browsers..."
npx playwright install chromium

echo "[Artemis] Verifying build..."
npx tsc --noEmit

echo "[Artemis] Running tests..."
npx vitest run

echo "[Artemis] Setting up directories..."
mkdir -p ~/.artemis/screenshots ~/.artemis/logs ~/.artemis/resumes

echo "[Artemis] Installing daily scan schedule..."
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.openclaw.artemis.daily-scan.plist"
mkdir -p "$PLIST_DIR"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.artemis.daily-scan</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCRIPT_DIR/scripts/daily-scan.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/.artemis/logs/daily-scan.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.artemis/logs/daily-scan-error.log</string>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH"
echo "[Artemis] Daily scan scheduled for 9:00 AM local time"

echo ""
echo "[Artemis] Installation complete."
echo ""
echo "To add Artemis to OpenClaw, add to ~/.openclaw/openclaw.json:"
echo "  agents.list: { \"artemis\": { \"name\": \"Artemis\", \"plugin\": \"$PLUGIN_DIR/src/index.ts\" } }"
echo "  workspaces: { \"artemis\": \"$SCRIPT_DIR/workspace\" }"
echo ""
echo "Next steps:"
echo "  1. Create a Discord bot for Artemis and add to your server"
echo "  2. Create #daily-job-report channel in Discord"
echo "  3. Run: artemis_email_setup to configure your application email"
echo "  4. Run: artemis_company_add to start building your company pool"
