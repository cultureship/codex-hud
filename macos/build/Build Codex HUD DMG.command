#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
"$SCRIPT_DIR/build-dmg.sh"
open -R "$SCRIPT_DIR/../dist/Codex-HUD-0.7.dmg"
