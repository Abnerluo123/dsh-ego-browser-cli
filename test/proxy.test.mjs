// The official CLI is trusted; the proxy validates transport data and always
// invokes one configured executable without a shell. No Ego install is needed.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { spawn, spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { request } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { startProxy, resolveNodePath } from '../proxy.js'

const fakeDir = mkdtempSync(join(tmpdir(), 'fake-ego-'))
const fakeEgo = join(fakeDir, 'fake-ego.mjs')
const childCwd = join(fakeDir, 'cwd with spaces')
mkdirSync(childCwd)
writeFileSync(fakeEgo, `
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const argv = process.argv.slice(2)
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const stdin = Buffer.concat(chunks).toString('utf8')
if (argv[0] === 'nodejs') {
  const evalIndex = argv.findIndex((arg) => arg === '-e' || arg === '--eval')
  const source = evalIndex < 0 ? stdin : argv[evalIndex + 1]
  try { await import('data:text/javascript,' + encodeURIComponent(source)) }
  catch (error) { process.stderr.write(String(error)); process.exitCode = 7 }
} else if (argv[0] === '__wait__' || argv[0] === '__tree__') {
  writeFileSync(argv[1], String(process.pid))
  if (argv[0] === '__tree__') {
    const code = 'require("node:fs").writeFileSync(' + JSON.stringify(argv[2]) + ', String(process.pid)); setInterval(() => {}, 1000)'
    spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
  }
  setInterval(() => {}, 1000)
} else if (argv[0] === '__orphan__') {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]})
  writeFileSync(argv[1],String(child.pid))
  process.exit(0)
} else if (argv[0] === '__unicode__') {
  for (const byte of Buffer.from('λ中文🌍')) {
    process.stdout.write(Buffer.of(byte))
    process.stderr.write(Buffer.of(byte))
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
} else if (argv[0] === '__flood__') {
  process.stdout.write('λ'.repeat(4 * 1024 * 1024 + 1))
  process.stderr.write('x'.repeat(8 * 1024 * 1024 + 1))
} else if (argv[0] === '__exit__') {
  process.stdout.write('child stdout')
  process.stderr.write('child stderr')
  process.exitCode = 9
} else {
  process.stdout.write(JSON.stringify({ argv, stdin, cwd: process.cwd() }))
}
`, 'utf8')

const proxies = new Set()
async function makeProxy(options = {}) {
  const proxy = await startProxy({ executable: process.execPath, executablePrefix: [fakeEgo], nodePath: process.execPath, timeoutMs: 10_000, ...options })
  proxies.add(proxy)
  return proxy
}
function configOf(proxy) {
  return JSON.parse(readFileSync(join(proxy.shimDir, 'proxy.json'), 'utf8'))
}
async function rawCall(proxy, body, secret = configOf(proxy).secret, path = '/run') {
  const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-ego-shim': secret }, body,
  })
  return { status: response.status, body: await response.json() }
}
function call(proxy, argv = [], stdin = '', cwd = childCwd) {
  return rawCall(proxy, JSON.stringify({ argv, stdin, cwd }))
}
function runShim(shim, argv, stdin, cwd = childCwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [shim, ...argv], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
after(() => {
  for (const proxy of proxies) proxy.dispose()
  rmSync(fakeDir, { recursive: true, force: true })
})

test('discovers process.execPath with no DSH_NODE or PATH', () => {
  const savedNode = process.env.DSH_NODE
  const savedPath = process.env.PATH
  try {
    delete process.env.DSH_NODE
    process.env.PATH = ''
    assert.equal(resolveNodePath(), process.execPath)
  } finally {
    if (savedNode === undefined) delete process.env.DSH_NODE
    else process.env.DSH_NODE = savedNode
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
  }
})

test('forwards full argv, stdin and cwd only to the configured executable', async () => {
  const proxy = await makeProxy()
  try {
    const argv = ['previously-unknown-command', '--flag=value', '', 'spaces and "quotes"', 'line\nbreak', '你好', '$HOME; echo nope | cat', '--eval', 'literal']
    const stdin = 'first line\nsecond line\nUnicode: λ\n\0'
    const response = await rawCall(proxy, JSON.stringify({ argv, stdin, cwd: childCwd, executable: 'never-execute-this', shell: true }))
    assert.equal(response.status, 200)
    assert.equal(response.body.exitCode, 0)
    assert.deepEqual(JSON.parse(response.body.stdout), { argv, stdin, cwd: childCwd })
    const empty = await call(proxy)
    assert.deepEqual(JSON.parse(empty.body.stdout).argv, [])
    const exited = await call(proxy, ['__exit__'])
    assert.equal(exited.body.exitCode, 9)
    assert.equal(exited.body.stdout, 'child stdout')
    assert.equal(exited.body.stderr, 'child stderr')
  } finally { proxy.dispose() }
})

test('official nodejs stdin and eval scripts can use harmless formerly denied imports', async () => {
  const proxy = await makeProxy({ filter: () => { throw new Error('legacy filter must not run') }, allowedSubcommands: new Set() })
  try {
    const source = `const fs = await import('node:fs'); const cp = await import('node:child_process'); const os = await import('node:os'); console.log(JSON.stringify([typeof fs.readFile, typeof cp.spawn, typeof os.tmpdir, typeof process.cwd]));`
    for (const [argv, stdin] of [[['nodejs'], source], [['nodejs', '-e', source], 'ignored stdin'], [['nodejs', '--eval', source], '']]) {
      const response = await call(proxy, argv, stdin)
      assert.equal(response.status, 200)
      assert.equal(response.body.exitCode, 0, response.body.stderr)
      assert.deepEqual(JSON.parse(response.body.stdout), ['function', 'function', 'function', 'function'])
    }
  } finally { proxy.dispose() }
})

test('secret and route remain enforced, malformed payloads do not crash the server', async () => {
  const proxy = await makeProxy()
  try {
    assert.equal((await rawCall(proxy, '{', 'wrong-secret')).status, 403)
    assert.equal((await rawCall(proxy, '{}', '', '/run')).status, 403)
    assert.equal((await rawCall(proxy, '{}', configOf(proxy).secret, '/nope')).status, 404)
    for (const body of ['{', 'null', '[]', 'true', '"text"', '{}', '{"argv":null}']) {
      assert.equal((await rawCall(proxy, body)).status, 400, body)
    }
    const badPayloads = [
      { argv: [null] }, { argv: [1] }, { argv: [{}] }, { argv: ['nodejs\0bad'] },
      { argv: [], cwd: null }, { argv: [], cwd: 1 }, { argv: [], cwd: '' }, { argv: [], cwd: 'bad\0cwd' },
      { argv: [], stdin: null }, { argv: [], stdin: {} },
    ]
    for (const payload of badPayloads) assert.equal((await rawCall(proxy, JSON.stringify(payload))).status, 400, JSON.stringify(payload))
    assert.equal((await call(proxy, ['still-alive'])).body.exitCode, 0)
  } finally { proxy.dispose() }
})

test('both synchronous and asynchronous spawn failures become results', async () => {
  const proxy = await makeProxy()
  try {
    const originalSpawn = childProcess.spawn
    try {
      childProcess.spawn = () => { throw new Error('synthetic synchronous spawn failure') }
      syncBuiltinESMExports()
      const response = await call(proxy)
      assert.equal(response.body.exitCode, 1)
      assert.match(response.body.stderr, /synthetic synchronous spawn failure/)
    } finally {
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
    }
    const missingCwd = await call(proxy, [], '', join(fakeDir, 'does-not-exist'))
    assert.equal(missingCwd.body.exitCode, 1)
    assert.match(missingCwd.body.stderr, /spawn failed/)
    assert.equal((await call(proxy)).body.exitCode, 0)
  } finally { proxy.dispose() }
  await assert.rejects(startProxy({ executable: null }), /invalid configured/)
  await assert.rejects(startProxy({ executable: 'bad\0exe' }), /invalid configured/)
  await assert.rejects(startProxy({ executable: process.execPath, executablePrefix: [null] }), /invalid configured/)
})

test('installed shim forwards arguments and consumed stdin through the proxy', async () => {
  const proxy = await makeProxy()
  try {
    const argv = ['new-command', '', 'quoted "arg"', 'line\nbreak']
    const stdin = 'shim input\nλ\n'
    const result = await runShim(join(proxy.shimDir, 'shim.mjs'), argv, stdin)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { argv, stdin, cwd: childCwd })
  } finally { proxy.dispose() }
})

test('unreachable proxy fallback replays stdin, configured prefix, argv and cwd', async () => {
  const proxy = await makeProxy()
  const fallbackDir = join(fakeDir, 'fallback')
  mkdirSync(fallbackDir)
  const fallbackShim = join(fallbackDir, 'shim.mjs')
  copyFileSync(join(proxy.shimDir, 'shim.mjs'), fallbackShim)
  copyFileSync(join(proxy.shimDir, 'proxy.json'), join(fallbackDir, 'proxy.json'))
  proxy.dispose()
  const argv = ['fallback-command', '', 'space arg']
  const stdin = 'already consumed\nsecond line\nλ\0'
  const result = await runShim(fallbackShim, argv, stdin)
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { argv, stdin, cwd: childCwd })
})

test('unique private shim directories and disposal preserve other PATH changes', async () => {
  const originalPath = process.env.PATH
  const first = await makeProxy()
  const second = await makeProxy()
  try {
    assert.notEqual(first.shimDir, second.shimDir)
    assert.ok(first.pathActive && second.pathActive)
    for (const proxy of [first, second]) {
      assert.ok(['ego-browser', 'ego-browser.cmd', 'shim.mjs', 'proxy.json'].every((file) => existsSync(join(proxy.shimDir, file))))
      assert.ok(process.env.PATH.split(delimiter).includes(proxy.shimDir))
      if (process.platform !== 'win32') {
        assert.equal(statSync(proxy.shimDir).mode & 0o777, 0o700)
        assert.equal(statSync(join(proxy.shimDir, 'proxy.json')).mode & 0o777, 0o600)
      } else {
        const command = '$a=Get-Acl -LiteralPath $args[0]; if(-not $a.AreAccessRulesProtected){exit 2}; $allowed=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"); foreach($r in $a.Access){if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed){exit 3}}'
        const encoded = Buffer.from(`& { ${command} } '${proxy.shimDir.replaceAll("'", "''")}'`, 'utf16le').toString('base64')
        const aclCheck=spawnSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{encoding:'utf8',timeout:10000})
        assert.equal(aclCheck.status,0,aclCheck.stderr)
      }
    }
    const external = join(fakeDir, 'external-path-entry')
    process.env.PATH = `${external}${delimiter}${process.env.PATH}`
    first.dispose()
    assert.equal(existsSync(first.shimDir), false)
    assert.equal(first.pathActive, false)
    assert.ok(process.env.PATH.split(delimiter).includes(second.shimDir))
    assert.ok(process.env.PATH.split(delimiter).includes(external))
    second.dispose()
    assert.equal(existsSync(second.shimDir), false)
    assert.equal(process.env.PATH, `${external}${originalPath ? delimiter + originalPath : ''}`)
    first.dispose()
    assert.equal(process.env.PATH, `${external}${originalPath ? delimiter + originalPath : ''}`)
  } finally {
    first.dispose()
    second.dispose()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test('Windows tree-helper errors fall back to terminating the direct child', { skip: process.platform !== 'win32' }, async () => {
  const originalSpawnSync = childProcess.spawnSync
  try {
    for (const failure of ['throw', 'error', 'status']) {
      childProcess.spawnSync = (command, ...args) => {
        if (!String(command).endsWith('taskkill.exe')) return originalSpawnSync(command, ...args)
        if (failure === 'throw') throw new Error('synthetic helper failure')
        return failure === 'error' ? { error: new Error('synthetic helper failure'), status: null } : { status: 1 }
      }
      syncBuiltinESMExports()
      const proxy = await makeProxy({ timeoutMs: 500 })
      try {
        const pidFile = join(fakeDir, `helper-${failure}.pid`)
        const result = await call(proxy, ['__wait__', pidFile])
        assert.equal(result.body.timedOut, true)
        assert.ok(existsSync(pidFile))
        await until(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 'fallback child exit')
      } finally { proxy.dispose() }
    }
  } finally {
    childProcess.spawnSync = originalSpawnSync
    syncBuiltinESMExports()
  }
})

test('UTF-8 streams retain split characters, cap output and report truncation', async () => {
  const proxy = await makeProxy()
  try {
    const unicode = await call(proxy, ['__unicode__'])
    assert.equal(unicode.body.stdout, 'λ中文🌍')
    assert.equal(unicode.body.stderr, 'λ中文🌍')
    assert.equal(unicode.body.truncated, false)
    const flood = await call(proxy, ['__flood__'])
    assert.equal(flood.body.truncated, true)
    assert.equal(Buffer.byteLength(flood.body.stdout), 8 * 1024 * 1024)
    assert.equal(Buffer.byteLength(flood.body.stderr), 8 * 1024 * 1024)
    assert.ok(!flood.body.stdout.includes('�'))
    const shim = await runShim(join(proxy.shimDir, 'shim.mjs'), ['__flood__'], '')
    assert.equal(shim.code, 0)
    assert.match(shim.stderr, /output truncated/)
  } finally { proxy.dispose() }
})

test('an exited CLI with inherited output pipes cannot hang proxy completion', async () => {
  const proxy=await makeProxy({timeoutMs:300})
  const pidFile=join(fakeDir,'orphan.pid')
  try {
    const began=Date.now()
    const result=await call(proxy,['__orphan__',pidFile])
    if(result.body.timedOut) assert.notEqual(result.body.exitCode,0)
    else assert.equal(result.body.exitCode,0) // Some Windows runtimes close inherited pipes at parent exit.
    assert.ok(Date.now()-began<5000)
  } finally {
    if(existsSync(pidFile)) { const pid=Number(readFileSync(pidFile,'utf8'));if(alive(pid)) process.kill(pid,'SIGKILL') }
    proxy.dispose()
  }
})

test('disconnect, timeout and disposal terminate active children and descendants', async () => {
  const proxy = await makeProxy()
  const pidFile = join(fakeDir, 'disconnect.pid')
  const descendantFile = join(fakeDir, 'disconnect-descendant.pid')
  const req = request({ hostname: '127.0.0.1', port: proxy.port, path: '/run', method: 'POST', headers: { 'x-dsh-ego-shim': configOf(proxy).secret } })
  req.on('error', () => {})
  req.end(JSON.stringify({ argv: ['__tree__', pidFile, descendantFile], stdin: '', cwd: childCwd }))
  try {
    await until(() => existsSync(pidFile) && existsSync(descendantFile), 'disconnected process tree startup')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const descendantPid = Number(readFileSync(descendantFile, 'utf8'))
    assert.ok(alive(pid) && alive(descendantPid))
    req.destroy()
    await until(() => !alive(pid) && !alive(descendantPid), 'disconnected process tree exit')

    const disposalPidFile = join(fakeDir, 'dispose.pid')
    const disposalDescendantFile = join(fakeDir, 'dispose-descendant.pid')
    const pending = call(proxy, ['__tree__', disposalPidFile, disposalDescendantFile]).catch(() => null)
    await until(() => existsSync(disposalPidFile) && existsSync(disposalDescendantFile), 'disposed process tree startup')
    const disposalPid = Number(readFileSync(disposalPidFile, 'utf8'))
    const disposalDescendantPid = Number(readFileSync(disposalDescendantFile, 'utf8'))
    proxy.dispose()
    await pending
    await until(() => !alive(disposalPid) && !alive(disposalDescendantPid), 'disposed process tree exit')
  } finally { req.destroy(); proxy.dispose() }

  const timedProxy = await makeProxy({ timeoutMs: 500 })
  try {
    const timeoutPidFile = join(fakeDir, 'timeout.pid')
    const timeoutDescendantFile = join(fakeDir, 'timeout-descendant.pid')
    const result = await call(timedProxy, ['__tree__', timeoutPidFile, timeoutDescendantFile])
    assert.equal(result.body.timedOut, true)
    assert.notEqual(result.body.exitCode, 0)
    assert.ok(existsSync(timeoutPidFile) && existsSync(timeoutDescendantFile))
    await until(() => !alive(Number(readFileSync(timeoutPidFile, 'utf8'))) && !alive(Number(readFileSync(timeoutDescendantFile, 'utf8'))), 'timed out process tree exit')
    const shim = await runShim(join(timedProxy.shimDir, 'shim.mjs'), ['__wait__', join(fakeDir, 'shim-timeout.pid')], '')
    assert.notEqual(shim.code, 0)
    assert.match(shim.stderr, /command timed out/)
  } finally { timedProxy.dispose() }
})
