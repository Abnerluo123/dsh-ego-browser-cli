// Shell-passthrough suite.
//
// The proxy is what keeps this plugin out of the model's context: it lets the
// OFFICIAL `ego-browser` command run inside a confined shell, so an agent can
// follow the ego skill verbatim. These checks pin the transport, the
// subcommand whitelist, the script filter, the shim secret, and cleanup.
//
// A Node binary stands in for ego-browser so the suite needs neither Ego Lite
// nor a browser. It spawns children, so run it from a normal shell — not from
// inside the DSH sandbox, where spawn with piped stdio returns EPERM.
import { startProxy, resolveNodePath, scriptOf } from '../proxy.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

let failures = 0
const check = (label, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected: ${String(expected)}\n        actual:   ${JSON.stringify(actual)}`)
}

// ---- pure helpers ----
check('scriptOf reads -e', scriptOf(['nodejs', '-e', 'console.log(1)'], ''), 'console.log(1)')
check('scriptOf reads --eval', scriptOf(['nodejs', '--eval', 'x'], ''), 'x')
check('scriptOf falls back to stdin', scriptOf(['nodejs'], 'from-stdin'), 'from-stdin')
check('scriptOf ignores non-nodejs subcommands', scriptOf(['--version'], 'anything'), null)

const nodePath = resolveNodePath()
check('resolveNodePath finds a Node binary', nodePath !== null && existsSync(nodePath), true)

if (nodePath === null) {
  console.log('\n=== SKIPPED transport checks (no Node binary) ===')
  process.exitCode = failures === 0 ? 0 : 1
} else {
  // A stand-in for ego-browser: accepts `nodejs` (stdin script) and
  // `--version`, so the transport can be exercised without Ego Lite.
  const fakeDir = mkdtempSync(join(tmpdir(), 'fake-ego-'))
  const fakeEgo = join(fakeDir, 'fake-ego.mjs')
  writeFileSync(fakeEgo, `
const argv = process.argv.slice(2)
const out = (s) => process.stdout.write(s + "\\n")
if (argv[0] === "--version") { out("fake-ego 9.9.9"); process.exit(0) }
if (argv[0] === "skill") { out("fake skill guide"); process.exit(0) }
if (argv[0] === "nodejs") {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const source = Buffer.concat(chunks).toString("utf8")
  try { await import("data:text/javascript," + encodeURIComponent(source)) }
  catch (error) { process.stderr.write(String(error) + "\\n"); process.exit(1) }
  process.exit(0)
}
process.stderr.write("unknown subcommand\\n")
process.exit(2)
`, 'utf8')

  // ---- transport ----
  const pathBeforeStart = process.env.PATH
  const proxy = await startProxy({
    executable: nodePath,
    executablePrefix: [fakeEgo],
    filter: (script) => (script.includes('FORBIDDEN') ? ['a forbidden test pattern'] : []),
    timeoutMs: 30_000,
    nodePath,
  })

  const secret = JSON.parse(readFileSync(join(proxy.shimDir, 'proxy.json'), 'utf8')).secret
  const call = async (argv, stdin, overrideSecret) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-ego-shim': overrideSecret ?? secret },
      body: JSON.stringify({ argv, stdin, cwd: homedir() }),
    })
    return { status: response.status, body: await response.json() }
  }

  check('shim files installed', ['ego-browser', 'ego-browser.cmd', 'shim.mjs', 'proxy.json'].every((f) => existsSync(join(proxy.shimDir, f))), true)
  check('PATH exposes the shim dir', process.env.PATH.split(';').some((p) => p.replace(/\\/g, '/').includes('dsh-ego-browser-shim')), true)

  const version = await call(['--version'], '')
  check('runs an allowed subcommand', version.body.exitCode, 0)
  check('returns the child output', /fake-ego 9\.9\.9/.test(version.body.stdout ?? ''), true)

  const ran = await call(['nodejs'], 'console.log("PROXY_RAN")')
  check('runs stdin script through nodejs', ran.body.exitCode, 0)
  check('stdout carried back', /PROXY_RAN/.test(ran.body.stdout), true)

  const blockedSub = await call(['upgrade'], '')
  check('blocks a non-browser subcommand', Boolean(blockedSub.body.blocked), true)

  const blockedScript = await call(['nodejs'], 'console.log("FORBIDDEN")')
  check('blocks a filtered script', Boolean(blockedScript.body.blocked), true)
  check('block message names the reason', /forbidden test pattern/.test(blockedScript.body.blocked ?? ''), true)

  const badSecret = await call(['--version'], '', 'wrong-secret')
  check('rejects a wrong shim secret', badSecret.status, 403)

  const notFound = await fetch(`http://127.0.0.1:${proxy.port}/nope`, { method: 'POST', headers: { 'x-dsh-ego-shim': secret } })
  check('unknown route returns 404', notFound.status, 404)

  const shimDir = proxy.shimDir
  proxy.dispose()
  check('dispose removes the shim dir', existsSync(shimDir), false)
  check('dispose restores PATH exactly', process.env.PATH, pathBeforeStart)
  try { rmSync(fakeDir, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n=== ${failures === 0 ? 'ALL PROXY CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`)
process.exitCode = failures === 0 ? 0 : 1
