#!/bin/bash
# Install the PushDesk for LUNA helper: draws the Ableton Push 2's screen for the PushDesk
# Add On in LUNA. It starts at login, does nothing until LUNA is running, and only uses the
# Push screen while PushDesk is talking to it (so Ableton Live can use the Push otherwise).
#
#   curl -fsSL https://github.com/johanze-ops/pushdesk-luna/releases/latest/download/install-helper.sh | bash
#
# From a checkout, with a binary you built:  PUSHDESK_HELPER_BINARY=build/pushdesk-luna-helper ./install-helper.sh
# Remove it again: uninstall-helper.sh
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/PushDesk for LUNA"
LOG_DIR="$HOME/Library/Logs/PushDesk for LUNA"
LABEL="com.johanze.pushdesk-luna.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$APP_DIR/pushdesk-luna-helper"
URL="https://github.com/johanze-ops/pushdesk-luna/releases/latest/download/pushdesk-luna-helper"
UID_NUM="$(id -u)"

[ "$(uname)" = "Darwin" ] || { echo "PushDesk for LUNA's helper is for macOS." >&2; exit 1; }
mkdir -p "$APP_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"

# Stop a running copy first, so the new one can take its place.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true

if [ -n "${PUSHDESK_HELPER_BINARY:-}" ]; then
  cp "$PUSHDESK_HELPER_BINARY" "$BIN.new"
else
  echo "Downloading the helper..."
  curl -fsSL "$URL" -o "$BIN.new"
fi
chmod +x "$BIN.new"
xattr -d com.apple.quarantine "$BIN.new" 2>/dev/null || true
"$BIN.new" --version >/dev/null || { echo "The downloaded helper doesn't run on this Mac." >&2; rm -f "$BIN.new"; exit 1; }
mv -f "$BIN.new" "$BIN"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key><array><string>$BIN</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>$LOG_DIR/helper.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/helper.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null

# launchd needs a moment after bootout before the same label can be loaded again.
for i in 1 2 3 4 5; do launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null && break; sleep 1; done
launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || { echo "launchd didn't start the helper; see $PLIST" >&2; exit 1; }

echo "PushDesk for LUNA helper $("$BIN" --version | awk '{print $2}') installed. It starts with LUNA from now on."
echo "Log: $LOG_DIR/helper.log    Remove: uninstall-helper.sh"
