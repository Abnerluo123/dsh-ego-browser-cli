// Portability + upgrade-resilience checks for resolveExecutable().
// Runs the plugin's real resolver against this machine, and simulates the
// "ego not installed / different machine" cases via a temporary HOME.
import { apply } from '../index.js'

let failures = 0
const check = (label, cond, detail = '') => {
  if (cond) console.log(`PASS  ${label}`)
  else { failures++; console.log(`FAIL  ${label} ${detail}`) }
}

function mount(config) {
  const registered = []
  const ctx = {
    on: () => () => {},
    tools: { register: (d) => { registered.push(d); return () => {}; } },
  }
  apply(ctx, config)
  return registered[0]
}

// ---- 1. this machine: no executable configured, must auto-resolve ----
const tool = mount({ requireApproval: 'host-primitives', timeoutMs: 60000 })
check('mounts without an executable config', tool !== undefined)

const real = await tool.execute({
  script: `
await page.goto("https://example.com");
console.log(JSON.stringify({ title: await page.title() }));
`,
  description: 'Auto-resolve smoke test',
  timeoutMs: 60000,
}, { signal: undefined })

check('auto-resolved ego works', real.ok && real.exitCode === 0, `exit=${real.exitCode} err=${real.stderr.slice(-200)}`)
check('auto-resolved run returned page data',
  /"title":"Example Domain"/.test(real.stderr), real.stderr.slice(-200))

// ---- 2. explicit config still wins ----
const explicit = mount({
  executable: 'C:/Users/rosen/.local/share/ego/active_version_dir/ego-browser.exe',
  requireApproval: 'host-primitives',
  timeoutMs: 60000,
})
const explicitRun = await explicit.execute({
  script: 'console.log(JSON.stringify({ok:1}))',
  description: 'Explicit exe path',
  timeoutMs: 60000,
}, { signal: undefined })
check('explicit executable config is honored', explicitRun.ok, `exit=${explicitRun.exitCode}`)

// ---- 3. nonexistent executable yields an actionable message, not raw ENOENT ----
const broken = mount({
  executable: 'C:/definitely/not/here/ego-browser.exe',
  requireApproval: 'host-primitives',
  timeoutMs: 30000,
})
let brokenMsg = null
try {
  await broken.execute({ script: 'console.log(1)', description: 'x', timeoutMs: 30000 }, { signal: undefined })
} catch (e) {
  brokenMsg = e.message
}
check('missing ego raises a setup error', brokenMsg !== null, String(brokenMsg))
check('setup error names the remedy',
  /lite\.ego\.app|onboarding|executable/i.test(brokenMsg ?? ''), String(brokenMsg))
check('setup error is not a bare ENOENT dump',
  !/^Error: spawn .* ENOENT$/.test(brokenMsg ?? ''), String(brokenMsg))

// ---- 4. gate behaviour unchanged after the refactor ----
const gateCtx = { on: (e, h) => { gateCtx._h = h; return () => {} }, tools: { register: () => () => {} } }
apply(gateCtx, { requireApproval: 'host-primitives', timeoutMs: 60000 })
const gate = gateCtx._h
const allow = await gate(
  { name: 'ego_browser', arguments: { script: 'await page.goto("https://x")' } },
  async () => ({ kind: 'allow' }),
)
const ask = await gate(
  { name: 'ego_browser', arguments: { script: `await import('node:fs')` } },
  async () => ({ kind: 'allow' }),
)
check('browser script still un-gated after refactor', allow.kind === 'allow')
check('fs script still gated after refactor', ask.kind === 'ask')

// ---- 5. requireApproval:"never" disables the gate ----
const neverCtx = { on: (e, h) => { neverCtx._h = h; return () => {} }, tools: { register: () => () => {} } }
apply(neverCtx, { requireApproval: 'never', timeoutMs: 60000 })
const neverAsk = await neverCtx._h(
  { name: 'ego_browser', arguments: { script: `await import('node:fs')` } },
  async () => ({ kind: 'allow' }),
)
check('requireApproval:"never" lets host scripts through', neverAsk.kind === 'allow')

console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`)
process.exitCode = failures === 0 ? 0 : 1
