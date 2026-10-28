# dsh-ego-browser-cli

**Use the official Ego Lite browser in DeepSeek Harness — with full capability, without
giving up file confinement.**

A DSH plugin that runs the official `ego-browser` CLI from the Harness host process and
exposes it as one `ego_browser` tool.

[中文说明](README.zh.md) · MIT

---

## The problem it solves

`ego-browser` cannot start under a confined file policy. The sandboxed shell has no access
to the ego daemon's bootstrap channel:

```
$ ego-browser nodejs -e "console.log(1)"
Failed to connect to ego_cli bootstrap
Agent note: ego-browser cannot connect to the ego_cli bootstrap from the default agent
sandbox. Retry with Full Access or run ego-browser outside the agent sandbox.
```

The only sanctioned escape is switching the session to **Full access** — which drops file
confinement for *every* tool, not just the browser. So the usual choice is:

- keep `workspace-write` and lose the browser, or
- gain the browser and lose confinement everywhere.

This plugin removes the trade-off. It applies the boundary where the boundary actually is:

| Capability | Behaviour |
|---|---|
| Browser automation (navigate, click, fill, screenshot, extract) | runs freely, **no prompt** |
| Host-level primitives (raw fs, subprocess, sockets, `eval`) | **one approval prompt** per call |

The session stays on `workspace-write`. `write`, `edit`, and `bash` remain confined. Only
the browser path runs from the host process.

## Why running from the host process is legitimate

This is not a sandbox bypass bolted on from outside. DSH's own MCP client already works this
way — `dsh-mcp-client` spawns MCP servers through the MCP SDK's `StdioClientTransport`
without routing through `ctx.sandbox` or `ctx.shell`. Tools reached over MCP are therefore
unconfined by the same mechanism. This plugin makes that same path available to the
**official** CLI, so you no longer need a separate MCP server to get a browser.

## Requirements

- DeepSeek Harness with a profile you can edit
- [Ego Lite](https://lite.ego.app/) installed, with onboarding completed
  (onboarding is what registers `ego-browser` on the PATH)
- Node.js 22+ (for the macOS/Linux installer script)

## Install

### 1. Get the plugin

```bash
git clone https://github.com/Abnerluo123/dsh-ego-browser-cli.git
cd dsh-ego-browser-cli
```

Or download and unpack a release archive.

### 2. Run the installer

**Windows (PowerShell):**

```powershell
pwsh -File scripts/install.ps1
```

**macOS / Linux:**

```bash
bash scripts/install.sh
```

The installer writes the plugin into your profile's `node_modules`, registers it in that
profile's `package.json` (both `dependencies` and `dsh.profile.bundles`), backs the file up
first, and installs the skill to `~/.agents/skills/ego-browser-cli/`.

Useful flags:

```powershell
pwsh -File scripts/install.ps1 -Profile tui      # non-default profile
pwsh -File scripts/install.ps1 -NoSkill          # skip the skill
```

```bash
bash scripts/install.sh --profile tui
bash scripts/install.sh --no-skill
```

### 3. Restart DeepSeek Harness

The plugin loads at startup. After restarting, the `ego_browser` tool is available.

### Verify

Ask the Harness to run:

```js
await page.goto("https://example.com");
console.log(JSON.stringify({ title: await page.title(), url: await page.url() }));
```

A JSON line with the page title in the result means the whole chain works: loader →
executable discovery → unconfined spawn.

## Usage

The tool takes a `script` (the Node body handed to `ego-browser nodejs` on stdin) and a
short `description`. `task` and a default `page` (`"p1"`) are already in scope, and
top-level `await` works.

```js
await page.goto("https://xiumi.us");
const info = await page.evaluate(() => ({
  title: document.title,
  links: [...document.querySelectorAll("a")].slice(0, 5).map((a) => a.innerText.trim()),
}));
console.log(JSON.stringify(info));
```

Options: `spaceId` to resume a task space, `timeoutMs` to cap the run.

### Things worth knowing

- **Ego prints script `console.log` output on STDERR, not stdout.** Both streams come back;
  stderr is not failure.
- **Each call is a new process.** Task spaces persist by name/id; JavaScript variables do
  not. Print `task.spaceId` and pass it back as `spaceId` to continue.
- **Prefer one script that finishes the whole flow.** Intermediate state never enters the
  model's context, so batching is dramatically cheaper than many small calls.
- **Do not call `task.finish()` with no argument or an empty `keep`** — both throw. Omit
  `finish` (the space is released on process exit) or pass `task.finish({ keep: "all" })`.

The full API guide ships with Ego Lite: run `ego-browser skill`. That command prints text
only and works fine even under confinement.

### API details that surprise people

| Symptom | Cause |
|---|---|
| `page.screenshot received unknown option: saveAs` | the option is `path` |
| `screenshot scale must be one of css` | `scale` is a string and only accepts `"css"` |
| `loc=href:` matches nothing | it needs the **complete** URL — no substrings, no regex |
| `matched 2 elements` | element actions require exactly one match; this is an error |
| `page.fetch` fails on `file://` | it uses `window.fetch` and obeys browser CORS |

## Security

**The official browser surface is free.** Everything the ego skill documents — `task`, `page`
and its methods, `console`, ordinary JavaScript — runs with no prompt. `node:path` is free
too: it is pure string computation with no filesystem access.

A script that reaches outside the browser gets **one** approval prompt for that call: the
filesystem, subprocess spawning, raw sockets, host OS/VM access, the process environment, or
dynamic evaluation. Comments are ignored during the scan, so documenting a module
(`// uses node:fs`) does not prompt.

When a task needs both browser work and host access, prefer splitting it: one call drives the
browser and saves its artifact, then the ordinary `pwsh`/file tools handle the host side,
where the normal sandbox and escalation apply.

The gate is a **consent mechanism, not a containment boundary**.

`ego-browser nodejs` runs real Node.js with host permissions by design — the official skill
says so explicitly. The gate scans the script text so you see the risky calls, but a
determined or obfuscated script can evade a text scan. Treat the prompt as a signal, not a
guarantee.

This is inherent to the approach, not a defect in the implementation: any route that gives
the browser full capability gives the script that drives it the same reach. If you need real
containment, the browser must run in a container, microVM, or other isolated environment —
this plugin deliberately does not pretend otherwise.

Set `requireApproval: "never"` in the plugin config to disable prompting entirely.

## Configuration

The installer registers the plugin with defaults. To change them, edit the `ego-browser-cli`
row in your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: ego-browser-cli
      name: dsh-ego-browser-cli
      config:
        requireApproval: host-primitives   # or "never"
        timeoutMs: 240000
        # executable: /custom/path/ego-browser   # only for non-standard installs
```

`executable` is deliberately unset by default. The plugin resolves the binary itself:

1. `executable` from config, if set
2. the junction Ego Lite creates — `~/.local/share/ego/active_version_dir/ego-browser[.exe]`
3. `ego-browser` on `PATH`

Because `active_version_dir` is a junction that Ego Lite's own updater retargets, an
upgrade keeps working without editing config. This also means the same config works on a
different machine with a different username.

## Compatibility

- **Tested on Windows** (Ego Lite 0.6.1.13, Chromium 156, Node v24.22.1).
- **macOS and Linux paths are supported but untested.** The resolver covers
  `~/.local/bin/ego-browser` and `/Applications/ego lite.app/Contents/MacOS/ego-browser`.
  Reports welcome.
- Ego upgrades: the junction is retargeted in place, so the plugin survives version bumps.
  If Ego Lite ever changes that mechanism, the `PATH` fallback still applies.

## Tests

```bash
node test/mount.test.mjs        # registration shape, gate decisions, render, arg validation
node test/portability.test.mjs  # executable resolution, upgrade resilience, missing-ego errors
```

`portability.test.mjs` runs a real browser flow, so Ego Lite must be installed. Note that
`spawn` with piped stdio returns `EPERM` inside the confined shell — run the tests from a
normal terminal, not through a sandboxed `pwsh` tool call.

## Uninstall

```powershell
# Windows
pwsh -File scripts/install.ps1 -h    # prints usage; rollback path is printed by the installer
```

Manual rollback: restore the `package.json.bak.*` backup the installer printed, delete
`<profile>/node_modules/dsh-ego-browser-cli`, remove `~/.agents/skills/ego-browser-cli/`, and
restart.

## License

MIT
