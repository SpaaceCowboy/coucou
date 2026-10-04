# Daily-helper implementation verification

Verified on the Windows development host, 2026-10-04:

- TypeScript checks and both frontend test suites pass. Coverage includes legacy inbox migration, retention, deduplication, read/dismiss persistence, connection episodes, silent restoration, notification preferences, quiet expiry and permission fallback, alongside the existing session tests.
- Windows Rust tests: 28 passed, 2 skipped. The skips require a signed-in Codex model connection. Tests include ClickUp task ordering/assignees, GitHub conditional headers and polling delays, credential errors, attachment validation, reviewed commands, hook merge/backups and permission decisions.
- Production frontend assets build successfully. Development fixtures are excluded from the production bundle.
- The Windows x64 NSIS installer builds successfully. The bundled binary starts under isolated settings, and repeated `--show` activation reuses the running app.
- The real Windows relay returns no permission decision in Quiet mode (98 ms in the isolated test) and while the app is closed (22 ms). `scripts/smoke-windows.ps1` reproduces these checks with services disabled and temporary profile/config/data/session directories.
- Browser previews were reviewed at the host's 125% display scale: next three tasks, long titles, crowded service pills, GitHub notifications, inbox scrolling/read counts, file shortcuts, editable translation prompts, quiet controls, reduced motion and the Wayland window silhouette. Clipped task/notification footers were corrected.
- macOS sources, the prototype and existing captures were left untouched. Existing user edits to `package-lock.json` were preserved.

## Remaining release checks

Full dependency resolution could not reach crates.io to fetch the new Linux dependencies. Windows verification used the cached Windows dependency set with Linux-only manifest sections temporarily excluded; the original manifests and `Cargo.lock` were restored afterward. The Linux dependency lock update remains pending an online build. This does not verify Linux compilation.

The host has no Debian GNOME environment. The new Debian workflow builds an amd64 package on Debian 13 and performs an isolated X11 package/activation smoke check when run. Real GNOME Wayland and X11 tests, locked-keyring behavior, Unix transport, native drag/drop/clipboard behavior, idle CPU measurement and native 100%/150% display-scale comparisons remain release checks. See [LINUX.md](LINUX.md) for the separate desktop checklist. CI changes have been added locally; no remote workflow has been dispatched and no package has been published.

The NSIS installer itself was built but not installed over the user's existing installation. Its bundled executable was smoke-tested directly. Live ClickUp/GitHub account checks and signed-in AI checks remain separate from the local mocked/unit checks.
