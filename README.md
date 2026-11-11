# dsh-ego-browser-cli

Use the full official Ego Lite runtime from a DSH `workspace-write` session without switching every browser call to Full access.

[中文说明](README.zh.md) · MIT

## Trust scope in 2.0

This plugin is for an Ego Lite browser dedicated to agent automation. It provides a trusted host execution lane for `ego_browser` and the `ego-browser` shell command. It does not scan scripts, register approval/permission hooks, change DSH presets or relax other tools' policy.

| Entry point | Behavior |
|---|---|
| `ego_browser` | Official `ego-browser nodejs` scripts, without plugin approval |
| Shell `ego-browser` | Forward all argv, stdin and cwd to the fixed official executable |
| Other DSH tools | Existing DSH sandbox and approval policy |

**The entire Ego script runtime is trusted.** Official `nodejs` runs real host Node, including imports, local scripts, files and network access. Screenshots, uploads and downloads also access host paths. This plugin does not isolate Node capabilities within an Ego script. DSH's global policy is unchanged, but the Ego entry point itself has host capabilities. Use normal DSH tools for general host work.

Browser-owned consent prompts, device selection and user takeover remain under Ego/website control. The plugin never fabricates consent or automatically claims user-owned spaces. Prepare a dedicated profile for unattended automation.

## Install / update

Requires an onboarded Ego Lite install and an editable DSH profile.

```powershell
git clone https://github.com/Abnerluo123/dsh-ego-browser-cli.git
cd dsh-ego-browser-cli
pwsh -File scripts/install.ps1
```

On macOS/Linux run `bash scripts/install.sh`. Optional Windows flags: `-Profile tui`, `-DshHome C:\path`. The default profile is desktop. Preserve the old plugin payload before updating for rollback; the installer backs up profile package metadata. Restart DSH, or reinstall the local bundle using the plugin manager on hosts supporting live application. Do not mount duplicate copies.

No extra skill is installed and the official Ego skill is not modified. Executable discovery follows Ego's version junction, standard install locations, and PATH.

## Official scripts by default

Pass `description` and `script` to `ego_browser`. Default `mode: "official"` sends source unchanged, without creating a task space or injecting task/page. Follow the official skill directly:

```js
const task = await taskSpace("my-browser-goal");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(JSON.stringify({ id: task.spaceId, title: await page.title() }));
await task.finish({ keep: [] });
```

Control/help/profile-only calls no longer depend on a hidden default space:

```js
console.log(await profiles());
help("taskSpace");
```

File-based official scripts work without scanning or rewriting:

```js
await import("file:///C:/automation/round-01.mjs");
```

Each call starts a new Node process; variables reset, spaces persist according to the official API. Ego usually prints console output to stderr; both streams are returned. Finish successful goals with `task.finish({ keep: [] })` by default, retaining only necessary result tabs. Follow official handoff/takeover/claim rules after user control. `timeoutMs` defaults to 240000, accepts 1–3600000, and truncated output is explicitly marked.

## Optional managed snippets

For legacy snippets such as `await page.goto(...)`, specify `mode: "managed"`. It injects task/page and reuses a session-named space:

```json
{
  "description": "Open example page",
  "mode": "managed",
  "spaceName": "my-goal",
  "script": "await page.goto('https://example.com'); console.log(task.spaceId);"
}
```

Selection arguments (`spaceId`, `spaceName`, `profileId`) imply managed mode when mode is omitted. `spaceId` wins over the name. `profileId` is only for new spaces and cannot accompany `spaceId`. Official mode handles selection in the script and rejects those arguments.

Managed mode never auto-claims user-owned spaces. After keeping tabs or handing off, official errors are preserved. Use official mode for control helpers and long workflows so each goal's lifecycle is explicit.

## Profiles

All official profile functionality is preserved:

```js
console.log(await profiles());
const task = await taskSpace("requested-profile-goal", { profileId: "Profile 5" });
const page = task.page("p1");
// ...
await task.finish({ keep: [] });
```

Use the ID requested by the user; profileId applies only to creation. Managed mode also accepts profileId. Ego supplies the list; this plugin does not hide/count profiles or guarantee their login state.

## Official shell command

A temporary shim is added to PATH and forwards to a loopback endpoint authenticated with a random secret. All CLI subcommands and script syntax are passed to the fixed Ego executable. Unknown commands fail in Ego itself. This transport permission does not automatically execute upgrades/imports; follow user authorization and the official skill.

For PowerShell, use the official UTF-8 `.mjs` workflow:

```powershell
ego-browser nodejs -e "await import('file:///C:/automation/round-01.mjs')"
```

The proxy offers no shell or caller-selected executable. If unavailable, the shim falls back to Ego and replays consumed stdin. That fallback may still be confined by DSH; restore the plugin or use the dedicated tool instead of changing other tools' permissions.

## Configuration

```yaml
- id: ego-browser-cli
  config:
    timeoutMs: 240000
    shellProxy: true
    # executable: C:/custom/ego-browser.exe
    # cwd: C:/automation
```

`requireApproval` was removed in 2.0. From 2.0.1, legacy block/ask/host-primitives settings stop mounting with a migration message so existing users do not silently expand trust. After reviewing the change, remove the legacy setting or explicitly set `trustedRuntime: true`. Fresh installations and the dedicated-browser configuration have no per-call plugin approval. `shellProxy: false` disables the shim while retaining the tool. No DSH core or global permission preset change is necessary.

The proxy requires a pre-resolved absolute executable and installs no shim if Ego cannot be found. Windows shim secrets use an explicit private DACL. Cancellation/timeout attempts process-tree termination and bounds output-pipe cleanup so an exited CLI cannot hang completion indefinitely. This is not an OS Job Object: deliberately detached processes and Windows orphans whose parent has already exited are not guaranteed to be reclaimed.

## Tests and compatibility

```powershell
npm test          # no Ego required: mount, source, space and proxy regression tests
npm run test:live # requires Ego: synthetic page/files/screenshots/upload/download
```

Live tests use synthetic data, close their own spaces and write to a temporary test directory. Tests spawning children may encounter EPERM under confined shells; run development tests in a normal terminal. The installed tool executes from the plugin host. Windows has live verification; macOS/Linux paths have automated coverage but no native Ego smoke test yet.

## Migration / rollback

2.0 intentionally changes the default script contract to official syntax. Add `mode: "managed"` to old short snippets. To roll back, restore the previous plugin payload and profile package metadata, then restart. To uninstall, remove the profile bundle registration; normal unload removes its temporary shim.
