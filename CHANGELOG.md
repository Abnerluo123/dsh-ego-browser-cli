# Changelog

## 1.0.0 — 2026-10-28

Initial release.

- `ego_browser` tool: runs the official `ego-browser` CLI from the DSH host process, so the
  full Ego Lite API works while the session stays on `workspace-write`.
- Approval gate on host-level primitives (raw fs, `child_process`, sockets, `eval`); browser
  automation runs without prompting.
- Portable executable discovery: explicit config → Ego Lite's `active_version_dir` junction →
  `PATH`. Survives ego upgrades and works across machines.
- Actionable error when Ego Lite is missing, instead of a bare `ENOENT`.
- Installers for Windows (PowerShell) and macOS/Linux (bash), plus a bundled
  `ego-browser-cli` skill.
- Test suites: `test/mount.test.mjs` (registration, gate, render, arg validation) and
  `test/portability.test.mjs` (resolution, upgrade resilience, missing-ego errors).

### Verified capability coverage

All 65 checks against the official ego skill's API surface pass on Windows
(Ego Lite 0.6.1.13, Chromium 156, Node v24.22.1), covering TaskSpace control, page
observation, screenshots (path/fullPage/clip/scale), navigation and waits, element actions,
uploads, downloads, JS dialogs, popups, pointer and keyboard input, `evaluate`, `fetch`,
`cdp`, and every documented selector dialect.
