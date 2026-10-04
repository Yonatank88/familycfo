#!/bin/sh
# Daily scrape at 07:00 via launchd (macOS). Usage: scripts/schedule.sh install | uninstall
set -e
LABEL=com.familycfo.scrape
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

case "$1" in
  install)
    NPM="$(command -v npm)" || { echo "npm not found on PATH" >&2; exit 1; }
    mkdir -p "$REPO/data/logs" "$HOME/Library/LaunchAgents"
    sed -e "s#__REPO__#$REPO#g" -e "s#__NPM__#$NPM#g" -e "s#__PATH__#$PATH#g" \
      "$REPO/scripts/$LABEL.plist.template" > "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed: scrape daily at 07:00, log in data/logs/scrape.log"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Uninstalled"
    ;;
  *)
    echo "usage: $0 install | uninstall" >&2
    exit 1
    ;;
esac
