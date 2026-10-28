# Changelog

## 1.0.1 — 2026-10-28

Gate correctness. The approval check now means "leaves the official browser
surface", not "matches a suspicious string".

- **Comments no longer trigger a prompt.** The scanner drops comments before
  matching, so a script that documents a module (`// uses node:fs`) runs free.
  Strings and template literals are preserved, because module specifiers live
  inside them, and a URL like `https://…` is never mistaken for a comment.
- **`process.env` is now detected.** It previously went unflagged, so a script
  could read credentials out of the environment with no consent prompt.
- **Prompts name the primitive** (`node:fs`, `node:child_process`, …) instead of
  a vague category, so the decision is easier to make.
- **`node:path` is explicitly free** — pure computation, no filesystem access.
- New suite `test/gate.test.mjs`: 34 checks covering the browser surface, real
  host access, the comment false-positive class, and the "stripping must not
  hide real code" cases (import after a URL string, inside a template
  expression, or after an escaped quote).

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
