#!/bin/sh
# Installs the generator as a macOS LaunchAgent so it starts at login and restarts if it stops.
#   npm run generator:install      npm run generator:uninstall
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.rounds.generator
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
CLAUDE_DIR="$(dirname "$(command -v claude)")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/rounds"

if [ "$1" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "generator removed"
  exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/tools/generator.mjs</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$CLAUDE_DIR:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/rounds/generator.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/rounds/generator.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "generator installed and running; log: ~/Library/Logs/rounds/generator.log"
