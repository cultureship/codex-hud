# macOS launcher

This is an experimental macOS port of Codex HUD. It starts a separate Codex
instance with loopback CDP enabled, injects the existing `hud.js`, and reads
the active thread's local rollout files.

On a Mac, from the repository root, run this once after checkout:

```bash
chmod +x "macos/Start Codex HUD.command" "macos/Attach Codex HUD.command"
```

Then double-click `Start Codex HUD.command`. It starts Codex with the port from
`config.json`; use `Attach Codex HUD.command` only when Codex is already
running with that port enabled.

## Menu bar app

Run `build/build-menu-bar-app.sh` to build `Codex HUD.app`. The app runs only in the
menu bar and starts the HUD without opening Terminal. Its menu can stop the
HUD, open the launcher log, and open this project folder.

To produce a drag-to-install disk image, double-click `build/Build Codex HUD DMG.command`.
The resulting `dist/Codex-HUD-0.7.dmg` contains the menu bar app and an
Applications shortcut. The app stores its runtime and user-edited configuration
under `~/Library/Application Support/CodexHUD/runtime`; upgrading the app keeps
the existing `config.json`.

Before the first switch from a `.command` launcher, stop its existing Node
process with `Control-C` in the Terminal window. Only one HUD launcher should
attach to Codex at a time.

When starting normally, the launcher first checks the configured CDP port. If
Codex is already running without that CDP endpoint, it asks the running app to
quit, waits for it to exit, and reopens it with loopback CDP enabled. If another
process already owns the configured port, the launcher stops instead of closing
Codex.

Requirements:

- macOS with Codex.app in `/Applications/Codex.app`, or set `CODEX_APP` to the
  app bundle path.
- Node.js 20 or newer. Set `CODEX_HUD_NODE` when `node` is not on your PATH.

The port only binds to `127.0.0.1`. The launcher stores its local usage ledger
at `~/Library/Application Support/CodexHUD/runtime/usage-ledger.json`. It reads
the existing rollout history on first launch, then adds only JSONL content from
rollouts changed by filesystem events. The ledger contains timestamps, model
names, token counts, and deduplication keys; it does not store conversation
content.

The macOS launcher uses a persistent CDP listener for sidebar selection and
FSEvents for rollout creation and writes. Rollout JSONL files are parsed
incrementally after their first read. `pollIntervalMs` is therefore a recovery
setting on macOS: health checks run no more often than every 15 seconds, and a
full session-directory rescan runs no more often than every 30 seconds to
recover from missed filesystem events.
