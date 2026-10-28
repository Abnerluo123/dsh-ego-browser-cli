/**
 * Transparent proxy that makes the official `ego-browser` command work inside a
 * confined shell.
 *
 * Why this exists: under `workspace-write` the shell's restricted token cannot
 * reach the ego daemon, so `ego-browser nodejs` dies with "Failed to connect to
 * ego_cli bootstrap". That forces agents to learn a special tool instead of
 * following the official skill. This module removes that burden.
 *
 * How it works:
 *   1. The plugin starts a loopback HTTP server in the harness (unconfined)
 *      process.
 *   2. It writes a shim named `ego-browser` into a private directory and
 *      prepends that directory to PATH, so confined children resolve the shim.
 *   3. The shim forwards argv + stdin to the server, which runs the real binary
 *      and returns exit code and both streams.
 *
 * The shim is therefore a sandbox bypass for the browser path. That is the same
 * trade the explicit tool already makes, but it is worth stating plainly: while
 * the proxy is enabled, a script that evades the text gate runs with host
 * permissions. `filter` exists so the caller keeps the browser/host split.
 *
 * @module dsh-ego-browser-cli/proxy
 */

import { createServer } from 'node:http'
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

/**
 * PATH spellings for one directory.
 *
 * Git Bash searches POSIX-style entries and native Windows children search
 * drive-letter entries, so a Windows install needs both forms to be found from
 * either shell. Extra entries are harmless: a child that cannot use one simply
 * skips it.
 *
 * @param dir - the directory to expose.
 * @returns one or two spellings, native first.
 */
function pathSpellings(dir) {
  const out = [dir]
  if (process.platform === 'win32') {
    const posix = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    if (posix !== dir) out.push(posix)
  }
  return out
}


function isExecutable(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate a real Node binary for the shim.
 *
 * `process.execPath` is NOT usable here: in the DSH desktop build it is the
 * Electron launcher, and inside ego's embedded runtime it is `ego.exe`. The
 * shim needs a genuine Node, so look for the runtime DSH ships, then PATH.
 *
 * @returns an absolute node path, or null when none is found.
 */
export function resolveNodePath() {
  if (typeof process.env.DSH_NODE === 'string' && isExecutable(process.env.DSH_NODE)) return process.env.DSH_NODE

  const exeDir = dirname(process.execPath)
  const bundled = [
    join(exeDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    join(exeDir, 'resources', 'runtime', 'bin', 'node', 'node.exe'),
    join(exeDir, 'resources', 'runtime', 'bin', 'node.exe'),
  ]
  for (const candidate of bundled) if (isExecutable(candidate)) return candidate

  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}


/** Subcommands the proxy will execute. Anything else is host-level by default. */
const ALLOWED_SUBCOMMANDS = new Set(['nodejs', 'skill', 'help', '--help', '-h', '--version', '-v'])

/** Cap request/response bodies so one call cannot flood memory. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Read a request body as text with a hard ceiling. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Work out which script text a `nodejs` invocation carries, so the caller can
 * apply its host-primitive filter.
 * @param argv - the argument list after `ego-browser`.
 * @param stdin - the request body written to stdin.
 * @returns the script text, or null for subcommands that carry no script.
 */
export function scriptOf(argv, stdin) {
  const sub = argv[0]
  if (sub !== 'nodejs') return null
  // `-e/--eval <script>` carries it in argv; otherwise it arrives on stdin.
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '-e' || argv[i] === '--eval') return argv[i + 1] ?? ''
  }
  return stdin
}

/** The shim's client side. Written verbatim to disk. */
const SHIM_SOURCE = `#!/usr/bin/env node
// Forward one ego-browser invocation to the DSH proxy and mirror its result.
const { readFileSync } = await import("node:fs");
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "proxy.json"), "utf8"));

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const argv = process.argv.slice(2);
const stdin = await readStdin();

let response;
try {
  response = await fetch(\`http://127.0.0.1:\${config.port}/run\`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-ego-shim": config.secret },
    body: JSON.stringify({ argv, stdin, cwd: process.cwd() }),
  });
} catch (error) {
  // Proxy unreachable (plugin unloaded, harness restarting): fall back to the
  // real binary so the command behaves like a plain install instead of hanging.
  const { spawnSync } = await import("node:child_process");
  if (config.realExecutable) {
    const r = spawnSync(config.realExecutable, argv, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  process.stderr.write(\`ego-browser shim: cannot reach the DSH proxy (\${error.message}).\\n\`);
  process.exit(1);
}

const result = await response.json().catch(() => null);
if (result === null) {
  process.stderr.write("ego-browser shim: malformed proxy response.\\n");
  process.exit(1);
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.blocked) {
  process.stderr.write(\`\\n[ego-browser proxy] \${result.blocked}\\n\`);
}
process.exit(typeof result.exitCode === "number" ? result.exitCode : 1);
`

/** POSIX/Git-Bash wrapper: no extension, so bash resolves it directly. */
function bashWrapper(nodePath, shimMjs) {
  return `#!/usr/bin/env bash\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(shimMjs)} "$@"\n`
}

/** cmd/PowerShell wrapper: `.cmd` is found through PATHEXT. */
function cmdWrapper(nodePath, shimMjs) {
  return `@echo off\r\n"${nodePath}" "${shimMjs}" %*\r\n`
}

/**
 * Start the loopback proxy and install the shim on PATH.
 *
 * @param options - executable path, the script filter, timeout, and PATH handling.
 * @returns the bound port, shim directory, and a dispose function.
 */
export async function startProxy(options) {
  const {
    executable,
    executablePrefix = [],
    filter,
    allowedSubcommands = ALLOWED_SUBCOMMANDS,
    timeoutMs = 240_000,
    nodePath,
    log = () => {},
  } = options
  const shimNode = nodePath ?? resolveNodePath()

  const secret = randomBytes(24).toString('hex')
  // Per-process directory: two harness instances must not share one shim, or
  // disposing either would delete the other's PATH entry.
  const shimDir = join(tmpdir(), `dsh-ego-browser-shim-${process.pid}`)

  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }

    if (req.method !== 'POST' || req.url !== '/run') return send(404, { exitCode: 1, stderr: 'not found' })
    if (req.headers['x-dsh-ego-shim'] !== secret) return send(403, { exitCode: 1, stderr: 'bad shim secret' })

    let payload
    try {
      payload = JSON.parse(await readBody(req))
    } catch (error) {
      return send(400, { exitCode: 1, stderr: String(error.message) })
    }

    const argv = Array.isArray(payload.argv) ? payload.argv.map(String) : []
    const stdin = typeof payload.stdin === 'string' ? payload.stdin : ''
    if (argv.length === 0) return send(400, { exitCode: 1, stderr: 'missing command' })

    // Only the browser-facing subcommands run. Anything else would let the
    // confined shell reach host-level behaviour through the proxy.
    if (!allowedSubcommands.has(argv[0])) {
      return send(403, {
        exitCode: 1,
        blocked: `subcommand "${argv[0]}" is not allowed through the proxy. Run it outside the sandbox, or use the normal tools for host changes.`,
      })
    }

    const script = scriptOf(argv, stdin)
    if (script !== null) {
      const reasons = filter(script)
      if (reasons.length > 0) {
        return send(403, {
          exitCode: 1,
          blocked: `this script leaves the browser surface (${reasons.join(', ')}), so the proxy refused it. Browser automation runs freely; host access must go through the normal tools, which apply the session sandbox and escalation.`,
        })
      }
    }

    const started = Date.now()
    const child = spawn(executable, [...executablePrefix, ...argv], {
      cwd: typeof payload.cwd === 'string' ? payload.cwd : homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log(`proxy ${argv[0]} -> ${exitCode} in ${Date.now() - started}ms`)
      send(exitCode === 0 ? 200 : 200, { exitCode, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill())
      } else {
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    child.stdout.on('data', (c) => { if (stdout.length < MAX_BODY_BYTES) stdout += c })
    child.stderr.on('data', (c) => { if (stderr.length < MAX_BODY_BYTES) stderr += c })
    child.on('error', (error) => {
      stderr += `spawn failed: ${error.message}`
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

  // Install the shim only with a real Node binary and a resolved ego path;
  // otherwise the shim would be unrunnable or would shadow itself and loop.
  let pathPrepended = false
  const originalPath = process.env.PATH ?? ''
  if (shimNode === null) {
    log('proxy: no Node binary found for the shim; shell passthrough disabled')
  } else try {
    mkdirSync(shimDir, { recursive: true })
    const shimMjs = join(shimDir, 'shim.mjs')
    writeFileSync(shimMjs, SHIM_SOURCE, 'utf8')
    writeFileSync(join(shimDir, 'proxy.json'), JSON.stringify({ port, secret, realExecutable: executable }), 'utf8')

    const bashShim = join(shimDir, 'ego-browser')
    writeFileSync(bashShim, bashWrapper(shimNode, shimMjs), 'utf8')
    try { chmodSync(bashShim, 0o755) } catch { /* Windows may ignore the mode */ }

    writeFileSync(join(shimDir, 'ego-browser.cmd'), cmdWrapper(shimNode, shimMjs), 'utf8')

    process.env.PATH = [...pathSpellings(shimDir), originalPath].filter(Boolean).join(';')
    pathPrepended = true
    log(`proxy listening on 127.0.0.1:${port}; shim at ${shimDir}`)
  } catch (error) {
    log(`proxy shim install failed: ${error.message}`)
  }

  return {
    port,
    shimDir,
    get pathActive() { return pathPrepended },
    dispose() {
      if (pathPrepended) process.env.PATH = originalPath
      pathPrepended = false
      try { server.close() } catch { /* already closed */ }
      try { rmSync(shimDir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}
