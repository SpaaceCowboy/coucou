# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Coucou: Mochi, a small animated character living in the MacBook notch (or at the top of the screen on Windows/Linux), shows Claude Code and Codex sessions plus a few integrations, and lets the user approve, answer, chat and drop files from the island.

`AGENTS.md` is the same guide for other agents (with "Codex" wording). Keep the two in sync when changing rules.

## Two separate apps
- **macOS** — `NotchBuddy/`: Swift 6, SwiftUI + AppKit, all code in `NotchBuddy/Sources/App/`. `NotchBuddy/project.yml` is the XcodeGen project (never edit the `.xcodeproj` by hand).
- **Windows + Debian/Linux** — `windows/`: Tauri 2. Frontend in `windows/src/` (plain TypeScript, no framework, Mochi in Canvas 2D); Rust backend in `windows/src-tauri/src/`; the hook relay in `windows/hook/` (`coucou-hook`). Cargo workspace = `src-tauri` + `hook`. Linux-specific code lives in `src-tauri/src/platform/` behind `cfg`; `tauri.linux.conf.json` is merged automatically on Linux.
- They share no code, only assets: the 28 WAV sounds in `NotchBuddy/Resources/sounds/` are served/copied into the Tauri build via `SOUNDS_DIR` in `windows/vite.config.ts` — never duplicate them.

## Build and test

macOS (needs a Mac):
```
cd NotchBuddy && xcodegen && xcodebuild -scheme NotchBuddy -configuration Debug build
bash scripts/test-screen-geometry.sh   # plain swiftc executables, no XCTest
bash scripts/test-safe-links.sh
```

Windows/Linux (from `windows/`):
```
npm ci
npm test                    # test:agents + test:helper: node scripts that transpile src/*.ts and assert, no framework
npm run build               # tsc --noEmit + vite build (prebuild compiles coucou-hook)
cargo test --workspace      # single test: cargo test <name>
npm run tauri dev           # full app, live reload
npm run dev                 # frontend only in a browser; Bridge calls become no-ops. dev/upload-preview.html replays the file-drop animation
npm run pack                # Windows NSIS installer → windows/release/
npm run pack:debian         # .deb → target/release/bundle/deb/
```
Some Rust tests are `#[ignore]` because they need a signed-in Codex (e.g. `cargo test installed_codex_supports_isolated_clickup_tools -- --ignored`). Debian native deps and the manual GNOME Wayland/X11 release checklist are in `windows/LINUX.md`; `windows/VERIFICATION.md` records what was actually verified.

Releasing Windows: the version lives in three files that must match the `windows-vX.Y.Z` tag — `windows/package.json`, `windows/Cargo.toml`, `windows/src-tauri/tauri.conf.json` (CI fails otherwise).

## Architecture
- **Hook path.** Claude Code runs a small relay on every hook event; it forwards the JSON to the running app and exits. Only `PermissionRequest` waits for the island's decision; no answer = empty stdout, and Claude Code asks in the terminal as usual. Transports: macOS `nb-hook` → Unix socket `nb.sock` (`HookServer.swift`); Windows `coucou-hook.exe` → named pipe `\\.\pipe\coucou-<sid>` (`src-tauri/src/pipe.rs`); Linux → `$XDG_RUNTIME_DIR/coucou-hook.sock` (mode 0600, peer check). The backend only waits for a human once the island confirms the card is on screen.
- **Hook install** (`src-tauri/src/hooks.rs` / `HookServer.swift`) merges into `~/.claude/settings.json` — see the rules below.
- **Tauri frontend ↔ backend.** All `invoke`/`listen` calls go through `windows/src/core/bridge.ts`. Backend commands are registered in `src-tauri/src/lib.rs` (`generate_handler!`). Hook events arrive as a `hook` event and are handled in `src/island/hooks.ts`; `src/island/fsm.ts` is the island state machine, `src/core/state.ts` the app state, `src/core/inbox.ts` the persisted attention inbox (localStorage).
- **Integrations** are pollers + a pill + a detail card. macOS: one `*Poller.swift` per service (`StripePoller.swift` is the compact example). Tauri: `src-tauri/src/integrations.rs`, plus `clickup.rs`, `codex.rs`, `claude.rs` (chat).
- **Secrets**: macOS Keychain; Windows Credential Manager / Linux Secret Service via `keyring` (`src-tauri/src/secrets.rs`). The frontend can only ask whether a key exists.

## Where else to look
- `docs/SPEC.md`, `docs/INTEGRATIONS.md` — behaviour, views, states, integrations (in French).
- `design/prototype/notch-buddy.html` — original prototype, the visual source of truth. `design/captures/` — target screenshots.
- `docs/*.html` — the GitHub Pages site (privacy, terms, support, legal notice).
- Logs: macOS `AppLog.swift`; Windows `%LOCALAPPDATA%\Coucou\coucou.log`; Linux `~/.local/share/coucou/`.

## Rules
- macOS: Swift 6, SwiftUI + AppKit. No third-party dependencies unless truly unavoidable. The character is drawn in code (`Canvas` + `TimelineView` on macOS, Canvas 2D on Tauri), no Rive/Lottie/images. App and tray icons are generated in code too (`npm run icons`).
- Secrets live in the OS keychain, never on disk or in git. No plaintext fallback.
- No telemetry. Network calls only to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a Claude Code permission without an explicit click. Closing a permission pill or Quiet mode returns the decision to the terminal; it never approves or denies.
- Performance: 0 % CPU when the island is hidden.
- Keep the bundle identifier `fr.louisraille.NotchBuddy` (Keychain items, preferences and permissions depend on it). The Tauri app's keyring service is `fr.louisraille.coucou`.
- Visual changes must match the prototype and the screenshots in `design/captures/`.
