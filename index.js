/**
 * dsh-ego-browser-cli — run the OFFICIAL ego-browser CLI from the DSH host process.
 *
 * Why this exists
 * ---------------
 * `ego-browser` cannot start under `workspace-write`: the confined token has no
 * access to the ego daemon's bootstrap channel, so `ego-browser nodejs` fails with
 * "Failed to connect to ego_cli bootstrap" while `ego-browser skill` (no daemon
 * contact) still works. The only sanctioned escape is Full access, which throws
 * away file confinement for EVERY tool.
 *
 * This plugin applies the split where the boundary actually is:
 *
 *   - Browser automation → runs freely, no approval prompt.
 *   - Host-level primitives (raw fs / child_process / sockets / eval) → this
 *     plugin asks the approval service first, once per call.
 *
 * The gate is a texture scan over the script text, not a sandbox. It is a
 * consent mechanism for the user, not a containment boundary: `ego-browser
 * nodejs` runs real Node with host permissions by design (see the ego-browser
 * skill's own warning). A determined script can evade a text scan, so treat the
 * scan as "surfaces the risky calls" rather than "proves safety".
 *
 * Packaging note: a third-party profile plugin cannot resolve `@deepseek-ai/*`
 * (the profile has no such dependency and the harness vendors them inside its
 * own asar). So this file imports nothing but Node builtins, and registers a
 * plain tool definition object — the shape `ctx.tools.register()` accepts
 * without going through `defineTool`.
 *
 * @module dsh-ego-browser-cli
 */

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'ego-browser-cli'

/** This plugin only needs the tool registry; approval is looked up lazily. */
export const inject = ['tools']

/** Tool name as the model sees it. */
const TOOL_NAME = 'ego_browser'

/** Default wall-clock ceiling for one ego script. */
const DEFAULT_TIMEOUT_MS = 240_000

/** Refuse output beyond this; keeps one call from flooding the context. */
const MAX_OUTPUT_CHARS = 120_000

/**
 * Host-level primitives that leave the browser and touch the machine.
 * Each pattern is anchored to a module-specifier position or a process/eval
 * call so ordinary page code (`page.goto('https://…')`) never matches.
 */
const HOST_PRIMITIVE_PATTERNS = [
  {
    pattern: /(?:from|require\s*\(|import\s*\()\s*['"](?:node:)?(?:fs|fs\/promises)['"]/,
    label: 'the filesystem module',
  },
  {
    pattern: /(?:from|require\s*\(|import\s*\()\s*['"](?:node:)?child_process['"]/,
    label: 'subprocess spawning',
  },
  {
    pattern: /(?:from|require\s*\(|import\s*\()\s*['"](?:node:)?(?:net|tls|dgram|http|https|worker_threads)['"]/,
    label: 'raw network or worker threads',
  },
  {
    pattern: /(?:from|require\s*\(|import\s*\()\s*['"](?:node:)?(?:os|vm)['"]/,
    label: 'host OS or VM access',
  },
  {
    pattern: /\bprocess\s*\.\s*(?:exit|kill|binding|dlopen)\s*\(/,
    label: 'process control',
  },
  {
    pattern: /\b(?:eval|new\s+Function)\s*\(/,
    label: 'dynamic code evaluation',
  },
]

/**
 * Describe which host primitives a script touches.
 * @param script - the untrusted script text.
 * @returns the reasons found; an empty array means "browser-level only".
 */
function hostPrimitivesIn(script) {
  const reasons = []
  for (const { pattern, label } of HOST_PRIMITIVE_PATTERNS) {
    if (pattern.test(script)) reasons.push(label)
  }
  return reasons
}

/** Clamp captured output and report whether it was cut. */
function clamp(text, limit) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`, truncated: true }
}

/** Whether a path names an existing regular file. */
function isFile(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate the official ego-browser executable.
 *
 * A hard-coded absolute path would break on every other machine and on every
 * ego upgrade, so resolution is layered:
 *
 *   1. An explicit `executable` config wins (escape hatch for odd layouts).
 *   2. The same junctions ego's own onboarding creates, under the current
 *      user's home — `active_version_dir` is a junction retargeted on upgrade,
 *      so this survives ego updates without editing config.
 *   3. A bare `ego-browser` on PATH, letting the OS resolve it. This is what
 *      onboarding guarantees, and it is the most portable option.
 *
 * Exported for the portability test; not part of the plugin contract.
 *
 * @param configured - the `executable` config value, if any.
 * @returns the command to spawn, plus how it was found.
 */
export function resolveExecutable(configured) {
  if (typeof configured === 'string' && configured.length > 0) {
    return { command: configured, source: 'config' }
  }

  const home = homedir()
  const exeName = process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser'
  const candidates = [
    // ego onboarding junctions (Windows layout).
    join(home, '.local', 'share', 'ego', 'active_version_dir', exeName),
    // macOS / Linux layouts used by the ego skill's install script.
    join(home, '.local', 'bin', exeName),
    '/Applications/ego lite.app/Contents/MacOS/ego-browser',
  ]
  for (const candidate of candidates) {
    if (isFile(candidate)) return { command: candidate, source: `junctions:${candidate}` }
  }

  // Fall back to PATH: find the first directory containing the executable.
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, exeName)
    if (isFile(candidate)) return { command: candidate, source: `path:${dir}` }
  }

  // Last resort: the bare name; spawn reports a clear ENOENT if it is absent.
  return { command: 'ego-browser', source: 'bare-name' }
}

/** Kill a process tree; a bare kill leaves the ego helper orphaned on Windows. */
function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => child.kill())
    return
  }
  child.kill('SIGKILL')
}

/**
 * Run one ego CLI invocation with a stdin-fed script.
 *
 * ego reports script output (`console.log`) on **stderr**, not stdout, so both
 * streams are captured and returned; callers must not treat stderr as failure.
 *
 * @param command - absolute path to the ego-browser executable.
 * @param script - the Node script handed to `ego-browser nodejs`.
 * @param options - cwd, environment, timeout, and the caller's abort signal.
 * @returns exit facts and the two captured streams.
 */
function runEgo(command, script, options) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, ['nodejs'], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: `failed to spawn ego-browser: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
        truncated: false,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const out = clamp(stdout, MAX_OUTPUT_CHARS)
      const err = clamp(stderr, MAX_OUTPUT_CHARS)
      resolve({
        exitCode,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate(child)
      // Do not settle here: `close` still arrives and carries the real streams.
    }, options.timeoutMs)

    const onAbort = () => terminate(child)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk
    })
    child.on('error', (error) => {
      stderr += `${stderr.length > 0 ? '\n' : ''}spawn error: ${error.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))

    // A closed stdin mid-write is a normal race after a timeout kill.
    child.stdin?.on('error', () => {})
    child.stdin?.write(script)
    child.stdin?.end()
  })
}

/** Standard JSON Schema for the tool's arguments (raw register: no author-spec `required:true`). */
const PARAMETERS = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description:
        'The Node.js script handed to `ego-browser nodejs` on stdin. It runs with `task` and a default `page` already in scope, e.g. `await page.goto("https://example.com"); console.log(await page.title())`. End with `console.log(JSON.stringify(...))` to return data. Do NOT call `task.finish()` with no argument or with an empty `keep` — both throw. Either omit `finish` entirely (the space is released when the process exits) or pass `task.finish({ keep: "all" })` to retain result tabs.',
    },
    description: {
      type: 'string',
      description: 'Short imperative summary shown on the tool card, e.g. "Open Xiumi editor".',
    },
    spaceId: {
      type: 'integer',
      description:
        'Reuse an existing ego task space. Omit to start a fresh one. Task spaces persist across calls, but JavaScript variables do not — every call is a new process.',
    },
    timeoutMs: {
      type: 'integer',
      description: `Wall-clock ceiling in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
    },
  },
  required: ['script', 'description'],
}

/** Output schema: also plain JSON Schema, since `register()` validates it directly. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'True when the ego process exited 0.' },
    exitCode: { type: 'integer', description: 'The ego process exit code.' },
    stdout: { type: 'string', description: 'Captured stdout.' },
    stderr: { type: 'string', description: 'Captured stderr; ego prints script console.log output here.' },
    timedOut: { type: 'boolean', description: 'True when the wall-clock ceiling killed the run.' },
    truncated: { type: 'boolean', description: 'True when captured output was clamped.' },
    script: { type: 'string', description: 'The script that ran, echoed for replay.' },
  },
  required: ['ok', 'exitCode', 'stdout', 'stderr', 'timedOut', 'truncated', 'script'],
}

/**
 * Register the `ego_browser` tool and its host-primitive consent gate.
 * @param ctx - Cordis context supplying the tool registry.
 * @param config - this row's config: executable, cwd, env, requireApproval, timeoutMs.
 */
export function apply(ctx, config) {
  const options = config ?? {}

  // Resolved once at mount; the junction it goes through is retargeted by ego's
  // own updater, so an in-place upgrade keeps working without a config edit.
  const resolved = resolveExecutable(options.executable)

  const requireApproval = options.requireApproval ?? 'host-primitives'
  const cwd = typeof options.cwd === 'string' && isAbsolute(options.cwd)
    ? options.cwd
    : homedir()
  const env = options.env ?? {}
  const defaultTimeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS

  // Consent gate. Returning `{kind:'ask'}` hands the decision to the approval
  // service, so the session's `never` policy still rejects deterministically
  // and an absent approval channel still fails closed.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== TOOL_NAME) return next()
    if (requireApproval === 'never') return next()

    const script = exec.arguments?.script
    if (typeof script !== 'string') return next()

    const reasons = hostPrimitivesIn(script)
    if (reasons.length === 0) return next()

    return {
      kind: 'ask',
      reason: `ego script touches ${reasons.join(', ')}`,
      displayReason: {
        en: `This ego-browser script reaches outside the browser: ${reasons.join(', ')}. Allow it?`,
        zh: `这个 ego-browser 脚本会碰浏览器之外的东西：${reasons.join(', ')}。允许吗？`,
      },
    }
  })

  ctx.tools.register({
    name: TOOL_NAME,
    description: [
      'Run the official ego-browser CLI to open pages, click, fill forms, screenshot, and extract data.',
      'This is the full ego lite API (TaskSpace/Page/mouse/keyboard) inside a real Node process, so it works even when the session file policy is workspace-write and the sandboxed shell cannot reach the ego daemon.',
      '',
      'Contract:',
      '- `task` and the default `page` ("p1") are already in scope; top-level await is allowed.',
      '- ego prints script `console.log` output on STDERR. Both streams are returned; do not read stderr as failure.',
      '- Each call is a new process and new variables; a named task space persists across calls — print `task.spaceId` and pass it back as `spaceId` to continue.',
      '- Prefer ONE script that finishes the whole flow over many round trips: it costs far fewer tokens.',
      '- Scripts touching raw fs / child_process / sockets / eval trigger a one-shot approval prompt.',
      '- Read the bundled ego-browser skill before non-trivial work; it documents the exact API.',
    ].join('\n'),
    parameters: PARAMETERS,
    timeoutMs: defaultTimeout + 30_000,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const parts = []
        if (value.stderr.length > 0) parts.push(value.stderr.trimEnd())
        if (value.stdout.length > 0) parts.push(value.stdout.trimEnd())
        if (value.timedOut) parts.push(`[ego-browser: timed out after ${defaultTimeout}ms; process tree killed]`)
        if (!value.ok && !value.timedOut) parts.push(`[ego-browser: exited ${value.exitCode}]`)
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(ego-browser completed with no output)' }]
      },
    },
    async execute(args, exec) {
      if (typeof args.script !== 'string' || args.script.trim().length === 0) {
        throw new Error('invalid script: expected a non-empty string')
      }
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string')
      }

      // A caller-supplied spaceId resumes that space instead of creating one.
      const preamble = args.spaceId === undefined
        ? 'const task = await taskSpace("dsh-ego-" + Date.now());\n'
        : `const task = await taskSpace(${Number(args.spaceId)});\n`

      const script = `${preamble}const page = task.page("p1");\n${args.script}\n`

      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? args.timeoutMs
        : defaultTimeout

      const result = await runEgo(resolved.command, script, {
        cwd,
        env,
        timeoutMs,
        signal: exec.signal,
      })

      // A missing ego install is a setup problem, not a script failure; say so
      // instead of surfacing a bare ENOENT.
      if (result.exitCode === -1 && /ENOENT|not recognized|not found/i.test(result.stderr)) {
        throw new Error(
          `ego-browser was not found (looked for ${resolved.command}, resolved via ${resolved.source}). ` +
          'Install ego lite from https://lite.ego.app/ and finish its onboarding, or set `executable` in this plugin\'s config to the full path of ego-browser.',
        )
      }

      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
        script,
      }
    },
  })
}
