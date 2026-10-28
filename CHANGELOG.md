# Changelog

## 1.2.0 — 2026-10-28

Stop asking. The browser surface is free; anything else is refused instead of prompting.

- **Default mode is now `block`.** A script that leaves the browser surface is refused
  with guidance instead of raising an approval prompt, so using the browser never
  interrupts the user. Host work belongs on the normal `pwsh`/file tools, where the
  session sandbox and its own approval policy already apply.
- **One mental model on both channels.** The shell passthrough already refused host
  scripts; the tool now behaves the same way. Previously the tool asked, the shim
  refused, and the same script got two different answers.
- **The refusal is actionable.** It names the primitive, explains why this tool is
  exempt from the file sandbox, and suggests splitting the flow: drive the browser and
  save the artifact (`page.screenshot`, `download.saveAs`, `page.fetch` with `saveAs`),
  then process it with the normal tools.
- **Backward compatible.** `requireApproval: "host-primitives"` (the old default) maps
  to `ask`, and `ask`/`never` still work, so existing profiles keep their behaviour.
- Gate suite grew to 41 checks, covering the new default, the redirect wording, and the
  legacy mapping.

## 1.1.0 — 2026-10-28

Invisible to the model: the official command now works in a confined shell, and the plugin
installs no skill.

- **Shell passthrough.** At startup the plugin starts a loopback endpoint and writes a tiny
  `ego-browser` shim onto `PATH`, so `ego-browser nodejs < script.mjs` works verbatim under
  `workspace-write`. An agent can follow the official ego skill with no knowledge of this
  plugin. Verified from a real confined shell: the command returned the page title that the
  harness process fetched.
- **Browser/host split enforced at the shim.** `nodejs` with a browser-only script, plus
  `skill`/`help`/`--version`, pass; a script importing `node:fs`, `child_process`, sockets or
  `eval` is refused with a message pointing at the normal tools; `upgrade`, `import` and any
  other subcommand are refused. The shim secret is a per-mount random token and the endpoint
  binds to loopback only.
- **No skill installed.** The bundled `ego-browser-cli` skill is gone: it added a
  skill-catalogue entry to every prompt for a plugin whose job is permission control. The
  official ego skill documents the API.
- **Robustness.** The shim falls back to the real binary when the proxy is unreachable; the
  shim directory is per-process so two harnesses cannot delete each other's entry; `PATH`
  gets both native and Git-Bash spellings; `resolveNodePath()` finds the runtime DSH ships
  instead of trusting `process.execPath`, which is the Electron launcher.
- New `test/proxy.test.mjs`: 18 checks over transport, the subcommand whitelist, the script
  filter, the shim secret, and dispose cleanup. It uses a Node stand-in, so it needs neither
  Ego Lite nor a browser. CI runs it.

## 1.0.2 — 2026-10-28

One task space per session, as the official guide intends.

- **Fixed a space leak.** The plugin named every space `dsh-ego-<timestamp>`, so
  each call created a new space and left the previous one behind — the cause of
  the stray windows. The name is now derived from the calling session, so
  `taskSpace(name)` resumes the existing space and repeated calls continue in
  place. This is the official mechanism; the timestamp was defeating it.
- **New `spaceName` argument** for a deliberately separate goal, matching the
  guide's "multiple spaces only when the user asks". `spaceId` still wins, and a
  supplied name is JSON-escaped so quotes cannot escape the string literal.
- New `test/space.test.mjs`: 16 checks over name stability, targeting
  precedence, whitespace handling, agentless calls, and name escaping.

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
