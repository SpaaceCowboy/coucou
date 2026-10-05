<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Coucou icon">

# Coucou for Windows

**Mochi doesn't get a notch on a PC — so it lives at the top of your screen instead.**

Approve Claude Code permissions, watch your session work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

<img src="screenshots/greeting.png" width="640" alt="Mochi waving hello at launch">

---

## Install

The downloadable installer is **temporarily unavailable**. Microsoft Defender
wrongly flags the unsigned installer as malware (`Trojan:Win32/Wacatac.H!ml`, a
machine-learning false positive). A report is under review at Microsoft, and the
installer will be published again once it is cleared and code-signed.

Until then, [build it yourself](#build-it-yourself): it takes a few minutes and
installs for the current user only — no admin prompt.

## Using it

The attention inbox keeps useful service updates, input requests and connection problems on this device for up to 30 days (latest 200). Use its Open, Mark read and Dismiss actions. Saved history does not replay attention sounds or motion. Per-service notification choices in Settings default to actionable updates; routine successes keep a subtle badge.

**Clear inbox** removes all saved alerts and marks them dismissed, so repeated service polls do not immediately bring them back. New alerts still arrive. Clear inbox affects Coucou only; it does not change anything in your services.

Every pill has a **×**, including running chats and the focused pill. Closing it hides the pill while its session or service keeps running. Background activity does not reopen it. Use **Restore closed pills** (↶ in the header) to bring it back; a new session turn also reopens that session's pill. Closed pills stay closed across restarts. Closing a Claude permission pill returns the decision to the terminal without approving or denying it.

In **Ask a quick question**, the button at the top right expands chat to the display's full height and 50% more width (960 pixels, limited by the display). Click it again to restore the normal size. Switching sections or collapsing Coucou also restores the normal size, while keeping the conversation.

New attention alerts also produce native desktop notifications. **Settings → Notifications** has an on/off switch and a test button. Quiet mode, Pause, service preferences and duplicate suppression apply to these notifications too. Restoring inbox history or initial provider snapshots does not replay them. On Windows, use an installed build with its Start menu shortcut and allow Coucou in Windows notification settings. Linux uses `notify-send` from `libnotify-bin` (included as a Debian package dependency). Notification delivery is controlled by your operating system; alerts remain in the attention inbox when desktop delivery is disabled.

Quiet mode can stay on until you turn it off, or last 30 minutes, one hour or two hours. Monitoring continues, while sounds and automatic opening stop. Claude permissions immediately return to the terminal. Pause is separate and stops monitoring and new network requests.

Configured ClickUp shows your next three open assigned tasks in the default list, ordered by due date with undated tasks last. It refreshes directly every five minutes and on demand. The reviewed command interface remains under Ask ClickUp. GitHub focuses on mentions, assignments and review requests. Dismissal affects Coucou only; GitHub notifications require compatible classic credentials, and Coucou never replaces an existing token automatically.

Drop one file to choose Summarize, Explain, Translate or Ask a question. Shortcuts open an editable prompt and require Send. Translation defaults to English with an editable language. Attachment chips can be removed and replies copied. Text/code and common images are supported within provider limits; PDFs require Claude. Unsupported or oversized files explain how to recover before any AI request.

For the shared Debian implementation and release verification checklist, see [LINUX.md](LINUX.md). The macOS app remains separate.

<img src="screenshots/compact.png" width="292" alt="The compact island, with the integration pills as mini Mochis">
<img src="screenshots/overview.png" width="640" alt="The overview: the focused integration on the left, the other pills on the right">
<img src="screenshots/approval.png" width="640" alt="A Claude Code permission request, with Deny and Allow">
<img src="screenshots/chat.png" width="640" alt="Chatting with Claude from the island">
<img src="screenshots/drop.png" width="640" alt="Mochi turned into a box, waiting for a file">

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Mochi peeks out |
| Click the small island | It opens |
| Click Mochi | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Mochi for two seconds | Hearts |
| Drag a file onto the island | Mochi turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a finished session shows what it did, and
your integrations sit in the coloured pills next to Mochi.

## Claude Code

<img src="screenshots/settings.png" width="562" alt="The settings window">

Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `%USERPROFILE%\.claude\settings.json`, the path of the dated backup
that will be taken, and nothing is written until you click. Your own hooks are
never touched, and uninstalling removes only Coucou's entries.

The relay is a tiny executable, `coucou-hook.exe`, copied to
`%LOCALAPPDATA%\Coucou\bin\` at launch. It is given 300 ms to reach Coucou and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Coucou.** If nobody answers a permission request
in time, Coucou stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

## Codex sessions

Each Codex chat appears automatically as its own **Mochi**, using the same
session ticker, completion sounds and error views as Claude Code. Claude hooks,
approvals, chat, file drops and service integrations continue to work as before.

The Windows app passively watches local `rollout-*.jsonl` files under
`%CODEX_HOME%\sessions`, or `%USERPROFILE%\.codex\sessions` by default.
It detects new sessions/turns, commands, edits and completion/interruption events
when those records are available. Monitoring never changes Codex configuration
or answers Codex approvals. No API key is needed for monitoring.

**Open chat** on a completed Codex task (or the overview arrow) opens that
session in the installed Codex desktop app using its registered `codex://` link.
The desktop app must be installed and able to access that local session.

Routine session starts, commands and edits update the ticker silently. Alerts
are limited to completion, errors, approval requests, input requests and rate
limits. The same filter applies to Claude and Codex. Codex input-request tool
calls are detected; live approval/error events are handled if present, but
Codex does not reliably persist them in rollout files, so some blockers remain
visible only inside Codex. Codex approvals remain inside Codex.

Old events never replay notifications at startup. Saved chat states are reconciled
quietly; previously unseen running chats appear on their next activity. Chat names
come from `session_index.jsonl`, with project folders as the fallback. Working and
unresolved chats stay visible alongside the five most recent finished chats.
Dismiss finished Mochis with ×. The clock tab holds attention alerts until you
dismiss them, even after restarting. Settings → Show integration pills restores
the existing service pills; Claude approvals always remain available. Rollout
formats vary by Codex version, so unknown records are ignored; command/edit
detail depends on the records that version writes. A completed turn is shown as
finished, but an idle CLI process closing has no reliable event in this adapter.
Oversized records (over 1 MiB) are skipped, and the directory watcher scans file
metadata on changes. Native notifications sleep between writes; chat-title changes are checked every three seconds.
WSL/remote sessions are only visible if their rollouts are in the watched folder.
The macOS implementation is unchanged.

Run the focused adapter/state checks with `npm run test:agents`, and the Windows
backend and existing hook tests with `cargo test --workspace`.

## ClickUp commands

The ClickUp Mochi opens a command box inside Coucou. In **Settings → ClickUp**,
save a personal API token, choose a workspace, and select a default list. Tokens
stay in Windows Credential Manager. Install Codex and sign in with ChatGPT;
ClickUp commands use that existing sign-in and the available default Codex model.

Ask to find, create, edit or delete a task. Supported fields are name, description,
status, priority, assignees and due date (shown in your computer's timezone).
Ambiguous searches offer exact task choices. Every write requires **Confirm change**
or **Confirm delete** after a preview; **Cancel** performs no write. Tasks changed
since their preview require a fresh review. Uncertain write results are not retried.

This command view starts a dedicated, ephemeral Codex app-server conversation on
demand, with read-only permissions and inherited connectors, MCP servers, plugins,
shell tools and user hooks disabled for that connection. It does not edit global
Codex settings. Experimental tool support is checked at connection time. Missing
credentials, unsupported versions, permissions, rate limits and network errors
appear in the command view. Bulk actions and custom fields are not included.

Run the optional signed-in connection check with:
`cargo test installed_codex_supports_isolated_clickup_tools -- --ignored`.
It makes a small model request and performs no ClickUp write. Live ClickUp writes
still need a connected account and your review in the app.

## Chat and keys

**Settings… → Claude** takes your Anthropic API key. Keys live in the **Windows
Credential Manager**, never on disk and never in the interface — the island can
only ask whether a key exists. Same for every integration key.

No telemetry. The only network requests Coucou makes are to the services you
configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer and drops it in windows/release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag from Explorer to see. Neither page ships in the app.

`npm run pack` leaves two files in `windows/release/`, the same names the release
workflow publishes:

```
Coucou-Windows-X.Y.Z-setup.exe    the versioned installer
Coucou-Windows-setup.exe          the same file under the rolling name
```

Installing is optional — `target/release/coucou.exe` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Mochi in the notification area are the whole app, and Quit lives in its menu.

The 28 sounds are the macOS app's own files; they are never duplicated in this
folder. The path is declared once, in `SOUNDS_DIR` at the top of
`vite.config.ts` — when they move to `shared/sounds/`, change that one line.

The app icon and the tray icon are drawn in code, like Mochi itself:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    mochi/             Mochi and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
  hook/                coucou-hook.exe, the Claude Code relay
  scripts/             icon generator
```

### Log

`%LOCALAPPDATA%\Coucou\coucou.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## What's different from the Mac version

- No notch, so the island lives at the top centre of the screen and retracts into
  the top edge instead of hiding in a notch.
- Permission approval works from **any** terminal; the Mac build only listens to
  VS Code sessions.
- Not in this version: sending a file by email, dragging Mochi onto a window to
  attach it as context, and jumping to a specific terminal window — "Open
  terminal" opens the working folder in VS Code when `code` is on your `PATH`.
- Cal.com shows the next bookings as a list rather than the Mac's calendar.


### Coucou chat

The chat section defaults to Codex using the installed Codex app and existing ChatGPT sign-in. Settings → Chat lets you switch back to Claude; its API key, model, web search and PDF support remain available. Switching provider starts a new conversation. Codex chat supports multi-turn questions, web search, text/code attachments up to 200 KB and images up to 8 MB. PDFs use the Claude option. Connection and usage errors stay inside chat so you can retry; New chat resets the conversation. The dedicated chat connection is read-only and does not expose your configured external integrations.
