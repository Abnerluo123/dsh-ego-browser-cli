/**
 * Forward the official ego-browser CLI through a secret-protected loopback
 * endpoint. The configured Ego executable is trusted to provide the complete
 * official automation lane, including nodejs imports; this transport neither
 * filters scripts nor selects commands or executables from request data.
 *
 * @module dsh-ego-browser-cli/proxy
 */
import { createServer } from 'node:http'
import { accessSync, chmodSync, constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

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

/** Find genuine Node, avoiding Electron and Ego's embedded launcher. */
export function resolveNodePath() {
  if (typeof process.env.DSH_NODE === 'string' && isExecutable(process.env.DSH_NODE)) return process.env.DSH_NODE
  if (!process.versions.electron && /^(node|nodejs)(\.exe)?$/i.test(basename(process.execPath)) && isExecutable(process.execPath)) {
    return process.execPath
  }

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

const MAX_BODY_BYTES = 8 * 1024 * 1024
const isArgument = (value) => typeof value === 'string' && !value.includes('\0')

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
    req.on('aborted', () => reject(new Error('request aborted')))
    req.on('error', reject)
  })
}

/** The client consumes stdin once, then replays it even on direct fallback. */
const SHIM_SOURCE = `#!/usr/bin/env node
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
  const { spawn } = await import("node:child_process");
  if (config.realExecutable) {
    try {
      const child = spawn(config.realExecutable, [...config.executablePrefix, ...argv], {
        cwd: process.cwd(), stdio: ["pipe", "inherit", "inherit"], windowsHide: true, shell: false,
      });
      child.on("error", (error) => {
        process.stderr.write(\`ego-browser shim: spawn failed: \${error.message}\\n\`);
        process.exitCode = 1;
      });
      child.on("close", (code) => { process.exitCode = code ?? 1; });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    } catch (error) {
      process.stderr.write(\`ego-browser shim: spawn failed: \${error.message}\\n\`);
      process.exitCode = 1;
    }
  } else {
    process.stderr.write(\`ego-browser shim: cannot reach the DSH proxy (\${error.message}).\\n\`);
    process.exitCode = 1;
  }
}
if (response) {
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== "object") {
    process.stderr.write("ego-browser shim: malformed proxy response.\\n");
    process.exitCode = 1;
  } else {
    if (typeof result.stdout === "string") process.stdout.write(result.stdout);
    if (typeof result.stderr === "string") process.stderr.write(result.stderr);
    if (result.timedOut) process.stderr.write("\\n[ego-browser proxy] command timed out.\\n");
    if (result.truncated) process.stderr.write("\\n[ego-browser proxy] output truncated.\\n");
    process.exitCode = Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : 1;
  }
}
`

function bashWrapper(nodePath, shimMjs) {
  const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`
  return `#!/usr/bin/env bash\nexec ${quote(nodePath)} ${quote(shimMjs)} "$@"\n`
}

function cmdWrapper(nodePath, shimMjs) {
  return `@echo off\r\n"${nodePath}" "${shimMjs}" %*\r\n`
}

/** Explicit Windows DACL: POSIX modes alone do not protect Windows secrets. */
function protectShimDirectory(directory) {
  if (process.platform !== 'win32') { chmodSync(directory, 0o700); return }
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const identity = spawnSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
  })
  const sid = identity.stdout?.match(/S-1-5-\d+(?:-\d+)+/)?.[0]
  if (identity.error || identity.status !== 0 || !sid) throw new Error('cannot identify Windows user for private Ego shim ACL')
  const result = spawnSync(join(system32, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r',
    `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
  })
  if (result.error || result.status !== 0) throw new Error('cannot set private Ego shim ACL')
}

/** Start the fixed-executable transport and install a private shim on PATH. */
export async function startProxy(options) {
  const {
    executable,
    executablePrefix = [],
    timeoutMs = 240_000,
    nodePath,
    log = () => {},
  } = options
  if (!isArgument(executable) || !isAbsolute(executable) || !Array.isArray(executablePrefix) || !executablePrefix.every(isArgument)) {
    throw new TypeError('invalid configured Ego executable or prefix')
  }
  const shimNode = nodePath ?? resolveNodePath()
  const secret = randomBytes(24).toString('hex')
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-ego-browser-shim-'))
  try { protectShimDirectory(shimDir) } catch (error) {
    rmSync(shimDir, { recursive: true, force: true })
    throw error
  }
  const children = new Set()
  let disposed = false

  const stopping = new WeakSet()
  const completions = new Map()
  const completionTimers = new WeakMap()
  const stop = (child) => {
    if (stopping.has(child)) return
    stopping.add(child)
    completionTimers.set(child, setTimeout(() => {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
      completions.get(child)?.(1)
    }, 2500))
    if (Number.isInteger(child.pid) && child.pid > 0) {
      if (process.platform === 'win32') {
        // This fixed Windows utility is only for cleanup, never request-selected.
        // Bound its lifetime too, so a stuck helper cannot outlive a timeout.
        try {
          const result = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false, timeout: 2000, killSignal: 'SIGKILL' })
          if (!result.error && result.status === 0) return
        } catch { /* fall back to terminating the direct child */ }
      } else {
        // Each CLI starts a new session below; never signal the harness's group.
        try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* group already gone */ }
      }
    }
    try { child.kill('SIGKILL') } catch { /* child already exited */ }
  }
  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      if (res.destroyed || res.writableEnded) return
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
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !Array.isArray(payload.argv) || !payload.argv.every(isArgument) ||
        (payload.stdin !== undefined && typeof payload.stdin !== 'string') ||
        (payload.cwd !== undefined && (!isArgument(payload.cwd) || payload.cwd.length === 0))) {
      return send(400, { exitCode: 1, stderr: 'invalid argv, stdin, or cwd' })
    }
    if (req.aborted || res.destroyed || disposed) return
    const { argv, stdin = '', cwd = homedir() } = payload
    const started = Date.now()
    let child
    try {
      child = spawn(executable, [...executablePrefix, ...argv], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32',
      })
    } catch (error) {
      return send(200, { exitCode: 1, stdout: '', stderr: `spawn failed: ${error.message}`, timedOut: false })
    }
    children.add(child)
    const output = { stdout: { text: '', bytes: 0 }, stderr: { text: '', bytes: 0 } }
    let truncated = false
    const append = (stream, text) => {
      const target = output[stream]
      const data = Buffer.from(text, 'utf8')
      let end = Math.min(data.length, MAX_BODY_BYTES - target.bytes)
      if (end < data.length) {
        truncated = true
        // Drop a partial UTF-8 character at the cap instead of corrupting it.
        while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1
      }
      target.text += data.subarray(0, end).toString('utf8')
      target.bytes += end
    }
    let settled = false
    let timedOut = false
    let timer
    const disconnected = () => { if (!res.writableEnded) stop(child) }
    req.once('aborted', disconnected)
    res.once('close', disconnected)
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(completionTimers.get(child))
      completions.delete(child)
      children.delete(child)
      req.off('aborted', disconnected)
      res.off('close', disconnected)
      log(`proxy ${argv[0] ?? ''} -> ${exitCode} in ${Date.now() - started}ms`)
      send(200, { exitCode: timedOut ? 1 : exitCode, stdout: output.stdout.text, stderr: output.stderr.text, timedOut, truncated })
    }
    completions.set(child, finish)
    timer = setTimeout(() => {
      timedOut = true
      stop(child)
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => append('stdout', text))
    child.stderr.on('data', (text) => append('stderr', text))
    child.on('error', (error) => {
      append('stderr', `spawn failed: ${error.message}`)
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })

  let port
  try {
    port = await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
  } catch (error) {
    rmSync(shimDir, { recursive: true, force: true })
    throw error
  }

  let pathPrepended = false
  const originalPath = process.env.PATH
  const ownEntries = pathSpellings(shimDir)
  if (shimNode === null) {
    log('proxy: no Node binary found for the shim; shell passthrough disabled')
  } else try {
    const shimMjs = join(shimDir, 'shim.mjs')
    writeFileSync(shimMjs, SHIM_SOURCE, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(join(shimDir, 'proxy.json'), JSON.stringify({ port, secret, realExecutable: executable, executablePrefix }), { encoding: 'utf8', mode: 0o600 })
    const bashShim = join(shimDir, 'ego-browser')
    writeFileSync(bashShim, bashWrapper(shimNode, shimMjs), { encoding: 'utf8', mode: 0o700 })
    writeFileSync(join(shimDir, 'ego-browser.cmd'), cmdWrapper(shimNode, shimMjs), { encoding: 'utf8', mode: 0o600 })
    process.env.PATH = [...ownEntries, ...(originalPath ? [originalPath] : [])].join(delimiter)
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
      if (disposed) return
      disposed = true
      if (pathPrepended) {
        const remaining = (process.env.PATH ?? '').split(delimiter).filter((entry) => !ownEntries.includes(entry)).join(delimiter)
        if (remaining === '' && originalPath === undefined) delete process.env.PATH
        else process.env.PATH = remaining
      }
      pathPrepended = false
      for (const child of children) stop(child)
      server.close()
      server.closeAllConnections()
      try { rmSync(shimDir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}
