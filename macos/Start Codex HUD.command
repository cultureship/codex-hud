#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
NODE_BIN="${CODEX_HUD_NODE:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ]; then
  osascript -e 'display alert "Codex HUD" message "Node.js 20 or newer is required to run the macOS launcher." as critical' >/dev/null 2>&1 || true
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/codex-hud-macos.mjs" --project-dir "$PROJECT_DIR"
