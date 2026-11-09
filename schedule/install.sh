#!/bin/zsh
# Installs the daily 07:30 sweep+score as a macOS launchd agent for THIS checkout.
# Usage: schedule/install.sh          Remove: launchctl bootout gui/$(id -u)/local.jobhunt.daily
set -euo pipefail
ROOT="${0:A:h:h}"
LABEL="local.jobhunt.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$ROOT/logs" "$HOME/Library/LaunchAgents"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__LABEL__|$LABEL|g" "$ROOT/schedule/launchd.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST — runs schedule/daily.sh daily at 07:30, logging to $ROOT/logs/sweep.log"
