// Mount-shape harness: fake a Cordis ctx and exercise the plugin's apply().
// Verifies registration shape, pre-execute gate decisions, and output schema
// conformance WITHOUT importing @deepseek-ai/* (mirrors what the harness does).
import { apply, name, inject } from '../index.js'

const listeners = []
const registered = []

const ctx = {
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
}

const config = {
  executable: 'C:/Users/rosen/.local/share/ego/active_version_dir/ego-browser.exe',
  requireApproval: 'host-primitives',
  timeoutMs: 240000,
}

let failures = 0
const check = (label, cond, detail = '') => {
  if (cond) console.log(`PASS  ${label}`)
  else { failures++; console.log(`FAIL  ${label} ${detail}`) }
}

// ---- apply() ----
apply(ctx, config)

check('exports name', typeof name === 'string' && name.length > 0, `name=${name}`)
check('exports inject with tools', Array.isArray(inject) && inject.includes('tools'))
check('registers exactly one tool', registered.length === 1, `got ${registered.length}`)

const tool = registered[0]
check('tool name is ego_browser', tool.name === 'ego_browser', tool.name)
check('has output.render function', typeof tool.output?.render === 'function')
check('has output.schema object root', tool.output?.schema?.type === 'object')
check('parameters is object root', tool.parameters?.type === 'object')
check('parameters requires script+description',
  JSON.stringify(tool.parameters.required) === JSON.stringify(['script', 'description']),
  JSON.stringify(tool.parameters.required))
check('declares timeoutMs', Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, String(tool.timeoutMs))
check('has execute function', typeof tool.execute === 'function')

// registration must not add unsupported JSON Schema keywords
const allowedKeys = new Set(['type', 'properties', 'required', 'description', 'items', 'enum', 'const', 'additionalProperties', 'oneOf'])
function scanSchema(node, path, out) {
  if (node === null || typeof node !== 'object') return
  for (const k of Object.keys(node)) if (!allowedKeys.has(k)) out.push(`${path}.${k}`)
  for (const [k, v] of Object.entries(node.properties ?? {})) scanSchema(v, `${path}.properties.${k}`, out)
  if (node.items) scanSchema(node.items, `${path}.items`, out)
}
for (const [label, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
  const bad = []
  scanSchema(schema, label, bad)
  check(`${label} uses only supported keywords`, bad.length === 0, bad.join(', '))
}
// raw register() bypasses object-root assertion, but `required` at node level
// (the author-spec style `required: true`) would be wrong JSON Schema.
check('output.schema has no author-style required:true',
  !JSON.stringify(tool.output.schema).includes('"required":true'))

// ---- pre-execute gate ----
const gate = listeners.find((l) => l.event === 'tools/pre-execute')
check('registers tools/pre-execute listener', gate !== undefined)

const callGate = async (toolName, script) => {
  let nextCalled = false
  const result = await gate.handler(
    { name: toolName, arguments: { script, description: 'x' } },
    async () => { nextCalled = true; return { kind: 'allow' } },
  )
  return { result, nextCalled }
}

const browserOnly = await callGate('ego_browser', 'await page.goto("https://xiumi.us")')
check('browser-only script passes without ask', browserOnly.result.kind === 'allow' && browserOnly.nextCalled)

const fsScript = await callGate('ego_browser', `const fs = await import('node:fs/promises')`)
check('fs script raises ask', fsScript.result.kind === 'ask', JSON.stringify(fsScript.result))
check('ask carries reason', typeof fsScript.result.reason === 'string' && fsScript.result.reason.length > 0)
check('ask carries en+zh displayReason',
  typeof fsScript.result.displayReason?.en === 'string' &&
  typeof fsScript.result.displayReason?.zh === 'string')

const otherTool = await callGate('bash', `import fs from 'node:fs'`)
check('other tools are untouched', otherTool.result.kind === 'allow' && otherTool.nextCalled)

const noScript = await gate.handler({ name: 'ego_browser', arguments: {} }, async () => { return { kind: 'allow' } })
check('missing script degrades to next()', noScript.kind === 'allow')

// ---- render ----
const rendered = tool.output.render({}, {
  ok: true, exitCode: 0, stdout: '', stderr: '{"a":1}',
  timedOut: false, truncated: false, script: 'x',
})
check('render returns text blocks', Array.isArray(rendered) && rendered[0]?.type === 'text')
check('render surfaces stderr output', rendered[0].text.includes('{"a":1}'), rendered[0].text)

const renderedFail = tool.output.render({}, {
  ok: false, exitCode: 3, stdout: '', stderr: 'boom',
  timedOut: false, truncated: false, script: 'x',
})
check('render marks nonzero exit', renderedFail[0].text.includes('exited 3'), renderedFail[0].text)

// ---- execute rejects bad args before spawning ----
let threw = false
try { await tool.execute({ script: '   ', description: 'x' }, { signal: undefined }) }
catch { threw = true }
check('execute rejects blank script', threw)

threw = false
try { await tool.execute({ script: 'x', description: '' }, { signal: undefined }) }
catch { threw = true }
check('execute rejects blank description', threw)

console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`)
process.exitCode = failures === 0 ? 0 : 1
