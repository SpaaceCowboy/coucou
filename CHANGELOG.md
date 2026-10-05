# Changelog

## Unreleased

### Repository updates — 2026-10-05

- Include the existing root `AGENTS.md` project guide and Windows package-lock changes at the user's request to push all local changes. The lockfile records version `0.1.1`, updates optional-platform package metadata and marks the TypeScript peer dependency. These files were previously kept outside the implementation commit.

- Compact island on screens without a notch (#22) — thanks @Kamasoutra
- Only web links (http/https) open from the notch; other kinds of links from Claude or integrations are ignored (#16) — thanks @Cris1670
- Hook socket limited to your own user account, with size and time limits; logs no longer keep commands, n8n data or full URLs, and stay under 1 MB (#16) — thanks @Cris1670 and @Vignesh-Thangamariappan
- The island always reopens after folding, and Settings opens below it, resizable — thanks @rouderz

### Windows daily helper and Debian groundwork — 2026-10-04

Implementation commit: `fed7d53`. Windows package version: `0.1.1`. These changes retain Mochi, the dark island and the existing two-card layout. Native macOS sources, the visual prototype and reference captures are unchanged.

#### Attention inbox

- Extend Recent alerts into a persistent inbox for configured services, session attention, input/permission requests and connection problems.
- Add unread counts, source labels, relative timestamps, Open, Mark read and Dismiss actions.
- Introduce a shared inbox item with source, provider event identifier, category, timestamp, read state and validated action target.
- Migrate the existing alert history using the existing local storage key; retain the latest 200 items for up to 30 days.
- Deduplicate provider events and keep repeated connection failures in one connection episode; resolve the episode when the service recovers.
- Preserve read state and dismissal across restarts, including bounded dismissal records and active connection episodes.
- Restore saved items and initial provider snapshots silently, without replaying sounds, badges or animations.
- Validate web, session, folder and internal navigation targets before opening them.
- Add per-service notification preferences: actionable updates by default, all updates, or off. Routine successful activity uses a subtle badge.

#### Quiet mode and Pause

- Add Quiet mode until manually disabled, or for 30 minutes, one hour or two hours; persist its expiry and handle expiration automatically.
- Keep monitoring active during Quiet mode while suppressing sounds and automatic opening.
- Immediately return Claude permission requests to the terminal in Quiet mode, recording an informational inbox entry without approving the request.
- Release pending requests when entering Quiet mode, pausing or hiding the relevant window.
- Keep Pause separate: stop monitoring and new network requests, discard paused updates and establish a fresh baseline on resume.
- Stop active audio immediately when quiet, paused, muted or hidden; suspend the audio context and stop hidden animation loops.
- Avoid resuming monitoring merely because a view or Settings opens.
- Schedule expiry and retention maintenance around deadlines instead of a continuous maintenance timer.

#### ClickUp

- Add a direct API card showing the next three open tasks assigned to the authenticated user in the configured default list.
- Fetch the authenticated user, filter by assignee, paginate within bounds and exclude closed tasks.
- Order overdue and upcoming tasks by due date, followed by undated tasks; treat invalid due dates as undated.
- Display task status, due date and an Open action with readable long-title truncation.
- Refresh every five minutes and on demand; show connection status and the last successful refresh.
- Retain the reviewed command interface and its isolated AI connection, with an Ask ClickUp action alongside the direct task card.
- Move unconfigured ClickUp access into Settings instead of permanently displaying a service entry.

#### GitHub and other integrations

- Replace repository statistics as GitHub's primary content with mentions, team mentions, assignments and review requests.
- Open validated issue or pull-request links; dismiss notifications locally without modifying GitHub's read state.
- Include event identity and provider timestamps in integration updates, with silent first-poll restoration.
- Use conditional Last-Modified polling, honor GitHub's polling interval and rate-limit/retry headers, and coordinate manual and scheduled refreshes.
- Restrict pagination to trusted API targets and bound the number of pages.
- Explain notification credential incompatibility, including unsupported fine-grained personal access tokens, without replacing saved credentials.
- Distinguish Not connected, Loading, Connected, Stale and Failed; report transport and unreadable-response errors, last successful refresh and recovery actions.
- Show only enabled, configured service pills; require both an n8n API key and URL before treating n8n as configured.
- Keep routine and nonterminal service activity connected and fresh without turning every update into an attention alert.
- Replace the permanently red API indicator with actual provider state and distinguish missing credentials from credential-storage failures.

#### File helper and chat

- Offer Summarize, Explain, Translate and Ask a question after a single-file drop.
- Open an editable prompt for every shortcut and require an explicit Send click; default translation to English with an editable target language.
- Add removable attachment chips and Copy reply while keeping responses safely rendered as text.
- Show accurate supported-format and size-limit explanations, including the requirement to use Claude for PDFs.
- Validate regular files, provider limits, UTF-8 text, binary/NUL content, image types and PDFs before making a network request.
- Reject unsupported files and folders with useful explanations; preserve errors until the user navigates back instead of dismissing them on a short timer.
- Copy attachments exclusively without overwriting existing files; enforce PDF and request-body limits rather than silently omitting files.
- Clear attachments on cancellation, truncate long filenames with tooltips and stop the drop animation when displaying shortcuts.
- Remove unsupported window-drop advertising.

#### Visuals, accessibility and interaction

- Improve secondary-text contrast, spacing, title truncation and card readability while preserving the silhouette, palette and Mochi drawing.
- Add status text alongside color; reserve stronger glows for attention events and keep routine activity subdued.
- Add descriptive tab tooltips, accessible control names, keyboard tab behavior and visible focus states.
- Support operating-system and Settings reduced-motion preferences.
- Preserve scroll position and keyboard focus during background updates and protect active prompts, attachments and reviewed commands from view replacement.
- Correct clipped task and GitHub footers so refresh, command and connection controls fit inside the island.
- Remove the misleading Retry button that only navigated away.
- Keep session actions capability-aware: open registered session links when available, otherwise offer the working folder and a copyable session identifier.
- Add development-only previews for tasks, inbox, GitHub, files, Settings, reduced motion and the Wayland silhouette; exclude preview fixtures from production assets.

#### Shared runtime and Debian GNOME support

- Keep the current project directory and isolate platform-specific window behavior, process launching, paths, credential storage, watching and hook transport.
- Return desktop capabilities at startup so the frontend exposes supported actions and display behavior.
- Preserve existing Windows data paths, service identifiers, Credential Manager storage and credentials; migrate Settings using defaults for quiet mode, notification preferences and reduced motion.
- Use Linux XDG configuration/data paths and Secret Service, with a non-unlocking keyring status check and visible locked/unavailable errors; never fall back to plaintext secrets.
- Add an event-driven Linux file watcher, ignoring access events caused by the app's own reads and watching the nearest existing ancestor until the session directory exists.
- Discover Codex through the executable search path while retaining the isolated chat connection and passive session monitoring.
- Add a same-user Unix hook socket in a private runtime directory, restrictive socket permissions, peer-identity checks, bounded connections and immediate terminal fallback.
- Preserve Windows named-pipe transport and reviewed hook installation with merged settings, dated backups and explicit confirmation.
- Preserve provider event identifiers and terminal-fallback information through the hook relay; validate session identifiers before opening links.
- Use a movable compact window with native controls on GNOME Wayland, without unsupported compositor positioning; use the top-edge island on X11.
- Keep frontend-driven compact window sizing on reopen; use an event-gated X11 pointer loop and cached click-through state.
- Hide the Linux window on close, release pending permissions and reopen through the launcher or `coucou --show`; retain Quit in Settings and optional tray controls.
- Split shared Tauri configuration into Windows NSIS and Linux Debian overlays, bundle the platform hook and add an application-menu launcher.
- Add Debian 13 amd64 build instructions and separate GNOME Wayland/X11 release checklists in `windows/LINUX.md`.

#### Tests, builds and automation

- Add frontend helper tests for inbox migration, retention, deduplication, read/dismiss restoration, connection episodes, silent restoration, notification preferences, quiet expiry, permission fallback and immediate audio stopping.
- Retain and extend existing session/approval tests and add Rust coverage for task ordering/assignees, GitHub polling headers/delays, credential errors, attachment validation, settings migration, reviewed commands and hook behavior.
- Add an isolated Windows packaged-app smoke script covering startup, second-instance activation, Quiet-mode permission fallback and fallback while the app is closed.
- Run frontend and Rust tests before Windows packaging and smoke-test the bundled app afterward; leave release publication disabled.
- Add a Debian 13 CI workflow for frontend/Rust tests, amd64 package building, installation, desktop-launcher validation, isolated non-root X11 startup/activation and artifact upload.
- Update the Windows README, build scripts, frontend build targets and verification documentation.
- Build the Windows x64 NSIS installer and local versioned/rolling installer copies.

#### Verification and remaining release checks

- TypeScript, both frontend suites and the production frontend build passed; production assets exclude development fixtures.
- Windows Rust tests passed: 28 passed and two signed-in Codex tests skipped.
- The final Windows bundled executable passed startup and repeated `--show` activation. Quiet permission fallback returned no decision in 46 ms; closed-app fallback returned no decision in 22 ms.
- Reviewed browser previews at the host's 125% display scale, including long titles, crowded pills, inbox read counts, editable translation prompts, reduced motion and the Wayland silhouette.
- Preserve the user's pre-existing `windows/package-lock.json` changes and untracked `AGENTS.md`; neither is included in the implementation commit.
- Linux compilation, dependency lock regeneration and `.deb` production remain unverified: crates.io downloads were unavailable and this host has no Debian GNOME environment.
- Cached Windows builds/tests temporarily excluded Linux-only dependencies and restored the original manifests and `Cargo.lock` afterward.
- Real GNOME Wayland/X11 behavior, keyring/Unix transport, native drag/drop and clipboard, idle CPU, native 100%/150% scale checks, live service accounts and signed-in AI checks remain release verification tasks.
- The installer was built but was not installed over the user's existing installation. The Debian workflow has not been run; no Debian package or release has been published.
- Full verification details are in `windows/VERIFICATION.md`.

### Earlier Windows updates on this branch

- Add passive Codex monitoring through shared agent events (`86be1b0`).
- Open the related Codex chat from session actions (`30370cc`).
- Keep routine agent activity quiet and surface attention events (`03bde96`).
- Handle resumed work and Codex goal blockers (`18bdd3d`).
- Add per-chat Mochis, Recent alerts history and reviewed ClickUp commands (`869d643`).
- Improve chat-card readability and exclude internal Guardian review sessions (`3d9e383`).
- Add inline chat links and ChatGPT-backed Codex chat (`1331e3e`).
- Keep compact Mochi visible and expire finished chats after five minutes (`2bae3f8`).
