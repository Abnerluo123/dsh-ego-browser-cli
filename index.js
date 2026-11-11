/**
 * Trusted Ego Lite automation lane. Only the official Ego executable is launched.
 * Scripts retain the official Node runtime's capabilities; this is not a Node
 * sandbox. No DSH permission preset, approval hook, or non-Ego tool is modified.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { startProxy } from './proxy.js'

export const name = 'ego-browser-cli'
export const inject = ['tools']
const DEFAULT_TIMEOUT_MS = 240_000
const MAX_TIMEOUT_MS = 3_600_000
const MAX_OUTPUT_CHARS = 120_000

function isExecutable(candidate) {
  try { accessSync(candidate, fsConstants.X_OK); return true } catch { return false }
}

function isProxyShim(candidate) {
  return basename(dirname(candidate)).startsWith('dsh-ego-browser-shim-') ||
    (existsSync(join(dirname(candidate), 'proxy.json')) && existsSync(join(dirname(candidate), 'shim.mjs')))
}

// Resolve BEFORE installing the shim. A bare missing command must never resolve
// back to our own newly prepended shim and recursively create children.
export function resolveExecutable(configured, system = {}) {
  const home = system.home ?? homedir()
  const searchPath = system.path ?? process.env.PATH ?? process.env.Path ?? ''
  const exe = process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser'
  if (configured !== undefined && (typeof configured !== 'string' || !configured || configured.includes('\0'))) {
    return { command: null, source: 'invalid-config' }
  }
  if (typeof configured === 'string' && configured.length > 0 &&
      (isAbsolute(configured) || /[\\/]/.test(configured))) {
    const command = resolve(configured)
    return isProxyShim(command) ? { command: null, source: 'refused-shim' } : { command, source: 'config' }
  }
  const candidates = configured ? [] : [
    join(home, '.local', 'share', 'ego', 'active_version_dir', exe),
    join(home, '.local', 'bin', exe),
    ...(system.home === undefined ? ['/Applications/ego lite.app/Contents/MacOS/ego-browser'] : []),
  ]
  for (const candidate of candidates) {
    if (!isProxyShim(candidate) && isExecutable(candidate)) return { command: candidate, source: `junctions:${candidate}` }
  }
  const names = configured ? [configured, ...(process.platform === 'win32' && !configured.endsWith('.exe') ? [`${configured}.exe`] : [])] : [exe]
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = resolve(dir, name)
      if (!isProxyShim(candidate) && isExecutable(candidate)) return { command: candidate, source: `path:${dir}` }
    }
  }
  return { command: null, source: 'missing' }
}

function terminate(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    const deadline = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL') }, 2000)
    killer.on('error', () => { clearTimeout(deadline); child.kill('SIGKILL') })
    killer.on('exit', (code) => { clearTimeout(deadline); if (code !== 0) child.kill('SIGKILL') })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

/** Fixed executable + stdin, never a shell command or a caller-selected program. */
export function runEgo(command, script, options) {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: -1, stdout: '', stderr: 'ego-browser call cancelled before start', timedOut: false, truncated: false })
      return
    }
    let child
    try {
      child = spawn(command, ['nodejs'], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({ exitCode: -1, stdout: '', stderr: `failed to spawn ego-browser: ${error.message}`, timedOut: false, truncated: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    let forcedFinish
    let settled = false
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forcedFinish)
      options.signal?.removeEventListener('abort', abort)
      resolve({ exitCode: timedOut || aborted ? -1 : exitCode, stdout, stderr, timedOut, truncated })
    }
    const stop = () => {
      if (settled || forcedFinish) return
      // Bound completion even if a CLI has exited while a descendant still
      // holds its pipes. Detached descendants are outside this process tree.
      forcedFinish = setTimeout(() => {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
        finish(-1)
      }, 2500)
      terminate(child)
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
    const abort = () => { aborted = true; stop() }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_CHARS) truncated = true
      stdout += chunk.slice(0, Math.max(0, MAX_OUTPUT_CHARS - stdout.length))
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length + chunk.length > MAX_OUTPUT_CHARS) truncated = true
      stderr += chunk.slice(0, Math.max(0, MAX_OUTPUT_CHARS - stderr.length))
    })
    child.on('error', (error) => { stderr += `\nspawn error: ${error.message}`; finish(-1) })
    child.on('close', (code) => finish(code ?? -1))
    child.stdin?.on('error', () => {})
    child.stdin?.end(script)
    if (options.signal?.aborted) abort()
  })
}

export function defaultSpaceName(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id ? `dsh-ego-${id}` : `dsh-ego-pid-${process.pid}`
}

function validateSelection(args) {
  if (args.spaceId !== undefined && (!Number.isSafeInteger(args.spaceId) || args.spaceId <= 0)) {
    throw new Error('spaceId must be a positive safe integer')
  }
  if (args.profileId !== undefined && (typeof args.profileId !== 'string' || !args.profileId.trim())) {
    throw new Error('profileId must be a non-empty Ego profile ID')
  }
  if (args.spaceId !== undefined && args.profileId !== undefined) {
    throw new Error('profileId is for creating a new space; use spaceId alone to resume an existing space')
  }
}

export function spacePreamble(args, exec) {
  validateSelection(args)
  const target = args.spaceId ?? (args.spaceName?.trim() || defaultSpaceName(exec))
  const profile = args.profileId === undefined ? '' : `, { profileId: ${JSON.stringify(args.profileId)} }`
  return `const task = await taskSpace(${JSON.stringify(target)}${profile});\nconst page = task.page("p1");\n`
}

/** Official mode preserves source exactly, including imports and declarations. */
export function prepareScript(args, exec) {
  const hasSelection = args.spaceId !== undefined || args.spaceName !== undefined || args.profileId !== undefined
  const mode = args.mode ?? (hasSelection ? 'managed' : 'official')
  if (mode !== 'official' && mode !== 'managed') throw new Error('mode must be official or managed')
  if (mode === 'official' && hasSelection) {
    throw new Error('official mode manages task spaces in the script; remove selection arguments or use mode: managed')
  }
  return mode === 'official' ? args.script : `${spacePreamble(args, exec)}${args.script}\n`
}

const PARAMETERS = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description: 'Official ego-browser Node.js script, passed unchanged by default. Declare task/page as in the official skill, or use profiles()/help() without creating a space. Use mode: managed for snippets with implicit task/page. Finish successful goals with task.finish({ keep: [] }); retain pages only when needed.',
    },
    description: { type: 'string', description: 'Short imperative summary shown on the tool card.' },
    mode: {
      type: 'string', enum: ['official', 'managed'],
      description: 'official (default): run the exact script, with no task or page injected. managed: inject task/page and reuse a session space. Selection arguments imply managed mode when mode is omitted.',
    },
    spaceId: { type: 'integer', description: 'Managed mode: resume a specific Agent-owned space. Does not claim a user-owned space.' },
    spaceName: { type: 'string', description: 'Managed mode: create/resume this named space. Without a name, use the session name. Never auto-claim user-owned spaces.' },
    profileId: { type: 'string', description: 'Managed mode: Ego profile ID for NEW spaces only. Obtain IDs with profiles(); for existing spaces omit it. Official mode can pass profileId directly to taskSpace().' },
    timeoutMs: { type: 'integer', description: `Wall-clock limit from 1 to ${MAX_TIMEOUT_MS}ms. Default ${DEFAULT_TIMEOUT_MS}ms.` },
  },
  required: ['script', 'description'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' }, exitCode: { type: 'integer' },
    stdout: { type: 'string' }, stderr: { type: 'string' },
    timedOut: { type: 'boolean' }, truncated: { type: 'boolean' }, script: { type: 'string' },
  },
  required: ['ok', 'exitCode', 'stdout', 'stderr', 'timedOut', 'truncated', 'script'],
}

export function apply(ctx, config) {
  const options = config ?? {}
  if (['block', 'ask', 'host-primitives'].includes(options.requireApproval) && options.trustedRuntime !== true) {
    throw new Error('ego-browser-cli 2.x no longer implements requireApproval. Review the trusted-runtime migration: remove the legacy restriction or set trustedRuntime: true to explicitly opt in. Other DSH permissions were not changed.')
  }
  const resolved = resolveExecutable(options.executable)
  const cwd = typeof options.cwd === 'string' && isAbsolute(options.cwd) ? options.cwd : homedir()
  const env = options.env ?? {}
  const defaultTimeout = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS

  // No tools/pre-execute listener or approval-service integration. Non-Ego
  // tools, file policy, presets, and the host sandbox remain untouched.
  if (resolved.command && options.shellProxy !== false && typeof ctx.effect === 'function') {
    ctx.effect(() => {
      let proxy
      let disposed = false
      startProxy({ executable: resolved.command, timeoutMs: defaultTimeout }).then((started) => {
        if (disposed) started.dispose()
        else proxy = started
      }).catch((error) => { console.error(`[ego-browser-cli] shell proxy unavailable: ${error.message}`) })
      return () => { disposed = true; proxy?.dispose() }
    }, 'ego-browser-cli shell passthrough')
  }

  ctx.tools.register({
    name: 'ego_browser',
    description: [
      'Run the official Ego Lite Node.js runtime without per-call plugin approval or source filtering.',
      'Default is official syntax: declare task/page yourself exactly as in ego-browser skill. No space is created before your script.',
      'Optional managed mode injects task/page for short snippets; explicit space selectors also enable it.',
      'All official APIs, Node imports, file-based scripts, screenshots, uploads/downloads, profiles and control helpers remain available.',
      'This trusted Ego lane runs with host permissions. Other DSH tools keep their existing policy.',
      'Ego logs console output to stderr. Each call has fresh variables; spaces persist until finished.',
      'Read ego-browser skill. Stop on user takeover; never automatically claim user-owned spaces.',
    ].join('\n'),
    parameters: PARAMETERS,
    timeoutMs: MAX_TIMEOUT_MS + 30_000,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => {
        const parts = [value.stderr.trimEnd(), value.stdout.trimEnd()].filter(Boolean)
        if (value.truncated) parts.push('[ego-browser: output truncated; extract less data or save an artifact]')
        if (value.timedOut) parts.push(`[ego-browser: timed out after ${args.timeoutMs ?? defaultTimeout}ms; process terminated]`)
        else if (!value.ok) parts.push(`[ego-browser: exited ${value.exitCode}]`)
        return [{ type: 'text', text: parts.join('\n') || '(ego-browser completed with no output)' }]
      },
    },
    async execute(args, exec) {
      if (typeof args.script !== 'string' || !args.script.trim()) throw new Error('invalid script: expected a non-empty string')
      if (typeof args.description !== 'string' || !args.description.trim()) throw new Error('invalid description: expected a non-empty string')
      if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > MAX_TIMEOUT_MS)) {
        throw new Error(`timeoutMs must be a positive integer at most ${MAX_TIMEOUT_MS}`)
      }
      const script = prepareScript(args, exec)
      if (!resolved.command) {
        throw new Error(`ego-browser was not found (${resolved.source}). Install Ego Lite, finish onboarding, or configure its absolute executable path; no shell shim was installed.`)
      }
      const result = await runEgo(resolved.command, script, {
        cwd, env, timeoutMs: args.timeoutMs ?? defaultTimeout, signal: exec?.signal,
      })
      if (result.exitCode === -1 && /ENOENT|not recognized|not found/i.test(result.stderr)) {
        throw new Error(`ego-browser was not found (looked for ${resolved.command}, via ${resolved.source}). Install Ego Lite from https://lite.ego.app/ and finish onboarding, or set executable in this plugin's config.`)
      }
      return { ok: result.exitCode === 0, ...result, script }
    },
  })
}
