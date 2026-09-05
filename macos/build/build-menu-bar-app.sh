#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MACOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_DIR="$(cd "$MACOS_ROOT/.." && pwd -P)"
SOURCE_DIR="$MACOS_ROOT/menu-bar-app"
APP_DIR="$MACOS_ROOT/Codex HUD.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
swiftc -parse-as-library "$SOURCE_DIR/CodexHUDMenuBar.swift" -framework AppKit -o "$MACOS_DIR/Codex HUD"
cp "$SOURCE_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$PROJECT_DIR/hud.js" "$RESOURCES_DIR/hud.js"
cp "$PROJECT_DIR/config.json" "$RESOURCES_DIR/config.json"
cp "$MACOS_ROOT/codex-hud-macos.mjs" "$RESOURCES_DIR/codex-hud-macos.mjs"
plutil -lint "$CONTENTS_DIR/Info.plist" >/dev/null
codesign --force --sign - "$APP_DIR" >/dev/null

echo "Built: $APP_DIR"
