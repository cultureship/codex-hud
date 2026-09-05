#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
APP_DIR="$MACOS_DIR/Codex HUD.app"
DIST_DIR="$MACOS_DIR/dist"
DMG_PATH="$DIST_DIR/Codex-HUD-0.7.dmg"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-hud-dmg.XXXXXX")"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

"$SCRIPT_DIR/build-menu-bar-app.sh"
mkdir -p "$DIST_DIR"
ditto "$APP_DIR" "$STAGING_DIR/Codex HUD.app"
ln -s /Applications "$STAGING_DIR/Applications"
hdiutil create -volname "Codex HUD" -srcfolder "$STAGING_DIR" -format UDZO -ov "$DMG_PATH" >/dev/null
hdiutil verify "$DMG_PATH" >/dev/null

echo "Built: $DMG_PATH"
