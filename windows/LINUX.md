# Debian 13 amd64

The existing `windows/` directory contains the shared frontend and Rust workspace. Platform code is under `src-tauri/src/platform/`; macOS remains in its original project. Linux support must pass the checks below before a Debian release is published.

## Build

Install Node 22 and stable Rust, then the native dependencies:

```sh
sudo apt install build-essential pkg-config libssl-dev libdbus-1-dev libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libglib2.0-bin gnome-keyring xdg-utils
cd windows
npm ci
npm test
cargo test --workspace
npm run pack:debian
sudo apt install ./target/release/bundle/deb/*.deb
coucou --show
```

Tauri automatically merges `tauri.linux.conf.json` with the shared configuration. The relay is built before bundling and included as an application resource. The `.deb` provides an application-menu launcher whose command is `coucou --show`. A second invocation opens the running app; tray support is optional. Closing the compact window hides it; the launcher opens it again. Quit is available in Settings and, when present, the tray.

GNOME Wayland uses a movable window with native window controls. Coucou does not attempt compositor positioning. GNOME on X11 uses the top-centre island and an event-gated pointer loop. Both use the same cards and Mochi drawing.

## Connections and hooks

Secrets use the `fr.louisraille.coucou` service in Linux Secret Service. An unavailable or locked keyring produces a connection message. No plaintext fallback is used, and background refresh does not request an unlock dialog. Unlock the login keyring in Passwords and Keys and reconnect in Settings. `gdbus` is required for the non-unlocking status check.

Preferences live in `$XDG_CONFIG_HOME/coucou/settings.json` (default `~/.config/coucou`). The log, file inbox and copied relay live in `$XDG_DATA_HOME/coucou` (default `~/.local/share/coucou`). Attention history is stored in the webview's local application storage. API keys are excluded from these files.

Codex is discovered through `PATH`; use a signed-in executable. Passive sessions use `$CODEX_HOME/sessions` or `~/.codex/sessions`, watched through Linux file notifications. Chat keeps its own isolated connection. Registered `codex:` links open sessions; otherwise cards offer the working folder and a copyable session identifier.

Claude Code hooks use `$XDG_RUNTIME_DIR/coucou-hook.sock`. The runtime directory must belong to the current user and have private permissions. The socket is mode 0600 and both sides check peer identity. Missing/unresponsive Coucou returns immediately to the terminal. Quiet mode also releases permission requests immediately. Hook installation still shows a merged diff, takes a dated backup and requires the user's click; no configuration is overwritten automatically.

## Verification before release

The Debian workflow builds on Debian 13 amd64, runs frontend/Rust tests and launches the installed package under an isolated X11 display. This is a packaging check; it does not certify a GNOME desktop session.

Run the following separately in **GNOME Wayland** and **GNOME on X11**, using a disposable test account:

- Install the `.deb`; open through the application menu and `coucou --show`; close and reopen it. Verify that activation reuses the running process and works without a tray extension.
- On Wayland, move the compact window, expand/collapse it and verify its native controls remain usable. On X11, test the top-edge wake strip, click-through, primary display and 100%, 125% and 150% display scales.
- Connect one service at a time. Confirm only enabled, configured pills appear, and verify Loading, Connected, Stale and Failed states, last successful refresh and recovery controls.
- Verify ClickUp's next three open assigned tasks, overdue/upcoming/undated ordering, manual refresh and five-minute refresh. Verify GitHub mentions, assignments and review requests, conditional responses, polling intervals, invalid/classic/fine-grained credentials and local-only dismissal.
- Generate a permission request, input request and repeated connection failure. Read/dismiss/open entries, restart and confirm no sound or motion is replayed. Verify 200-item and 30-day limits.
- Enable each Quiet duration and manual Quiet; monitoring must continue without sound or automatic opening. Permission requests must fall back to the terminal immediately. Pause must stop monitoring and new network requests.
- Unlock, lock and stop the keyring; errors must be visible and credentials must never be saved in plaintext. Review hook installation, preserved foreign settings, dated backup and fallback while the app is closed.
- Drop an image, UTF-8 text/code, supported Claude PDF, oversized file, folder and unsupported office file. Verify editable shortcuts, language selection, explicit Send, removable attachment and Copy reply. PDFs with Codex must explain how to select Claude.
- Check long titles, crowded pills, keyboard focus, tooltips, inbox scroll during refresh and reduced motion against `../design/prototype/notch-buddy.html` and `../design/captures/`. Check idle CPU/audio after hiding.

Local verification on the Windows development host cannot certify Debian: it has no Debian GNOME environment, and the new Linux dependencies could not be fetched from crates.io. The full dependency lock update and GNOME tests are therefore pending an online Debian build. Do not publish the `.deb` before those checks pass.

References: [Tauri Debian packaging](https://v2.tauri.app/distribute/debian/), [Tauri window limitations](https://docs.rs/tauri-runtime-wry/latest/tauri_runtime_wry/struct.Window.html), [Debian 13 WebKit dependencies](https://packages.debian.org/trixie/libwebkit2gtk-4.1-0).

## NVIDIA compatibility

When the proprietary NVIDIA driver is detected through `/proc/driver/nvidia/version`, Coucou uses an opaque window fitted to the compact or expanded panel. On X11 it remains pinned at the top centre without a title bar; on Wayland it retains native controls and compositor placement. No background pointer polling is needed. The DMA-BUF renderer is disabled unless explicitly configured already. This avoids the fragmented transparent WebKitGTK rendering seen on NVIDIA/X11.

Force this mode with `COUCOU_OPAQUE_WINDOW=1 coucou --show`; opt back into the transparent island with `COUCOU_OPAQUE_WINDOW=0 coucou --show`. Fully quit before switching. Rebuild normally without the temporary `/tmp/coucou-opaque.json` diagnostic override.
