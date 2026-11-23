#!/bin/bash
# Remove the PushDesk for LUNA helper (the Push 2 screen for the PushDesk Add On).
#
#   curl -fsSL https://github.com/johanze-ops/pushdesk-luna/releases/latest/download/uninstall-helper.sh | bash
#
# Then remove PushDesk itself in LUNA under Settings > Add Ons.
set -euo pipefail
LABEL="com.johanze.pushdesk-luna.helper"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/PushDesk for LUNA"
echo "PushDesk for LUNA helper removed. (Its log is still in ~/Library/Logs/PushDesk for LUNA.)"
