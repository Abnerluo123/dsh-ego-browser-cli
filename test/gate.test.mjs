// Gate behaviour suite: the official browser surface must never prompt, real
// host access must, and comments must not be mistaken for code.
//
// This suite exists because a plain-text scan produced both false positives
// (a comment mentioning `node:fs`) and one real gap (unflagged `process.env`).
// Each case below is a regression guard for one of those.
import { apply } from '../index.js'

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected: ${expected}\n        actual:   ${actual}`)
}

/** Mount the plugin with a fake ctx and return the pre-execute gate. */
function mountGate(config = { requireApproval: 'host-primitives', timeoutMs: 60000 }) {
  let gate = null
  const ctx = {
    on: (event, handler) => { if (event === 'tools/pre-execute') gate = handler; return () => {} },
    tools: { register: () => () => {} },
  }
  apply(ctx, config)
  return async (script) => {
    const result = await gate({ name: 'ego_browser', arguments: { script } }, async () => ({ kind: 'allow' }))
    return result.kind === 'ask' ? 'ask' : 'allow'
  }
}

const ask = mountGate()

// ---- 1. the official browser surface: never prompts ----
const browserSurface = [
  ['navigation', 'await page.goto("https://xiumi.us"); await page.waitForLoadState("load")'],
  ['observation', 'const s = await page.snapshot(); const t = await page.title(); console.log(s, t)'],
  ['click / fill / select', 'await page.click("@3"); await page.fill("@5", "hi"); await page.selectOption("#s", { label: "A" })'],
  ['pointer + keyboard', 'await page.mouse.click(10, 20); await page.keyboard.press("Enter")'],
  ['screenshots', 'await page.screenshot({ path: "C:/tmp/a.png", fullPage: true })'],
  ['evaluate + fetch + cdp', 'await page.evaluate(() => document.title); await page.fetch("/api"); await page.cdp("Browser.getVersion", {})'],
  ['uploads and downloads', 'await page.setInputFiles("#f", ["C:/tmp/a.txt"]); const d = await page.waitForEvent("download")'],
  ['task control', 'await task.newPage(); await task.pages(); await task.finish({ keep: [] })'],
  ['plain JS helpers', 'const rows = [...Array(3)].map((_, i) => i); console.log(JSON.stringify(rows))'],
  ['node:path (pure computation)', 'const p = await import("node:path"); console.log(p.join("a", "b"))'],
]
for (const [label, script] of browserSurface) check(`allow: ${label}`, await ask(script), 'allow')

// ---- 2. real host access: always prompts ----
const hostAccess = [
  ['node:fs import', 'const fs = await import("node:fs/promises")'],
  ['node:fs via require', 'const fs = require("node:fs")'],
  ['bare fs specifier', 'import { readFile } from "fs/promises"'],
  ['node:child_process', 'const { spawn } = await import("node:child_process")'],
  ['node:net', 'const net = await import("node:net")'],
  ['node:os', 'const os = await import("node:os")'],
  ['process.env', 'console.log(process.env.PATH)'],
  ['process.exit', 'process.exit(0)'],
  ['eval', 'eval("1+1")'],
  ['new Function', 'const f = new Function("return 1")'],
]
for (const [label, script] of hostAccess) check(`ask: ${label}`, await ask(script), 'ask')

// ---- 3. the false-positive class that motivated this rewrite ----
const commentCases = [
  ['line comment naming an import', '// uses import fs from "node:fs"\nawait page.goto("https://x")'],
  ['block comment naming an import', '/* const { spawn } = require("child_process") */\nawait page.goto("https://x")'],
  ['comment mentioning process.env', '// do not read process.env here\nawait page.goto("https://x")'],
  ['comment with a URL', '// see https://example.com/docs\nawait page.goto("https://x")'],
]
for (const [label, script] of commentCases) check(`allow: ${label}`, await ask(script), 'allow')

// ---- 4. stripping must not hide real code behind strings or comments ----
check(
  'ask: import after a URL string',
  await ask('await page.goto("https://x.com");\nconst fs = await import("node:fs")'),
  'ask',
)
check(
  'ask: import after a line comment',
  await ask('// note\nconst { spawn } = require("child_process")'),
  'ask',
)
check(
  'ask: import inside a template literal expression',
  await ask('const m = `${await import("node:fs")}`'),
  'ask',
)
check(
  'ask: escaped quote then import',
  await ask('const s = "he said \\"hi\\"";\nconst fs = await import("node:fs")'),
  'ask',
)
check(
  'allow: apostrophe in a comment does not swallow the next line',
  await ask("// it's fine\nawait page.goto('https://x')"),
  'allow',
)
check(
  'ask: apostrophe in comment then real import on next line',
  await ask("// it's fine\nconst { spawn } = require('child_process')"),
  'ask',
)

// ---- 5. reason text names the specific primitive ----
{
  let gate = null
  const ctx = {
    on: (event, handler) => { if (event === 'tools/pre-execute') gate = handler; return () => {} },
    tools: { register: () => () => {} },
  }
  apply(ctx, { requireApproval: 'host-primitives', timeoutMs: 60000 })
  const result = await gate(
    { name: 'ego_browser', arguments: { script: 'const fs = await import("node:fs/promises")' } },
    async () => ({ kind: 'allow' }),
  )
  check('reason mentions node:fs', /node:fs/.test(result.reason ?? ''), true)
  check('reason has zh display text', typeof result.displayReason?.zh === 'string', true)
}

// ---- 6. opt-outs still work ----
{
  const neverAsk = mountGate({ requireApproval: 'never', timeoutMs: 60000 })
  check('requireApproval:"never" allows host access', await neverAsk('const fs = await import("node:fs")'), 'allow')
}

// ---- 7. other tools untouched ----
{
  let gate = null
  const ctx = {
    on: (event, handler) => { if (event === 'tools/pre-execute') gate = handler; return () => {} },
    tools: { register: () => () => {} },
  }
  apply(ctx, { requireApproval: 'host-primitives', timeoutMs: 60000 })
  const result = await gate(
    { name: 'pwsh', arguments: { command: 'import fs from "node:fs"' } },
    async () => ({ kind: 'allow' }),
  )
  check('non-ego tools pass through', result.kind, 'allow')
}

// ---- 8. the default is `block`: refuse host scripts, never interrupt ----
{
  const mountMode = (config) => {
    let gate = null
    const ctx = {
      on: (event, handler) => { if (event === 'tools/pre-execute') gate = handler; return () => {} },
      tools: { register: () => () => {} },
    }
    apply(ctx, config)
    return async (script) => {
      const result = await gate({ name: 'ego_browser', arguments: { script } }, async () => ({ kind: 'allow' }))
      return { kind: result.kind, reason: result.reason ?? '' }
    }
  }

  // No requireApproval key in the config at all.
  const defaultMode = mountMode({ timeoutMs: 60000 })

  const browserOk = await defaultMode('await page.goto("https://x")')
  check('default: browser script passes', browserOk.kind, 'allow')

  const hostBlocked = await defaultMode('const fs = await import("node:fs")')
  check('default: host script is denied, not asked', hostBlocked.kind, 'deny')
  check('default: denial names the primitive', /node:fs/.test(hostBlocked.reason), true)
  check('default: denial redirects to normal tools', /pwsh|file tools/.test(hostBlocked.reason), true)
  check('default: denial suggests splitting the flow', /split/i.test(hostBlocked.reason), true)

  // The legacy value maps to ask, so existing configs keep their behaviour.
  const legacy = await mountMode({ requireApproval: 'host-primitives', timeoutMs: 60000 })(`await import('node:fs')`)
  check('legacy "host-primitives" still asks', legacy.kind, 'ask')

  const explicitAsk = await mountMode({ requireApproval: 'ask', timeoutMs: 60000 })(`await import('node:fs')`)
  check('explicit "ask" asks', explicitAsk.kind, 'ask')
}

console.log(`\n=== ${failures === 0 ? 'ALL GATE CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`)
process.exitCode = failures === 0 ? 0 : 1
