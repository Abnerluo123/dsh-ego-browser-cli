import assert from 'node:assert/strict'
import { apply, name, inject, runEgo } from '../index.js'

const registered = []
const listeners = []
const ctx = {
  on(event, handler) { listeners.push([event, handler]) },
  tools: { register(tool) { registered.push(tool) } },
}
apply(ctx, { shellProxy: false })
assert.equal(name, 'ego-browser-cli')
assert.deepEqual(inject, ['tools'])
assert.equal(registered.length, 1)
assert.deepEqual(listeners, [], 'must not alter any DSH pre-execute or permission hook')
const tool = registered[0]
assert.equal(tool.name, 'ego_browser')
assert.deepEqual(tool.parameters.required, ['script', 'description'])
assert.deepEqual(tool.parameters.properties.mode.enum, ['official', 'managed'])
assert.equal(tool.parameters.properties.profileId.type, 'string')
const allowed = new Set(['type', 'properties', 'required', 'description', 'items', 'enum', 'const', 'additionalProperties', 'oneOf'])
function schema(node) {
  for (const key of Object.keys(node)) assert.ok(allowed.has(key), key)
  for (const child of Object.values(node.properties ?? {})) schema(child)
}
schema(tool.parameters)
schema(tool.output.schema)
for (const args of [
  { script: ' ', description: 'x' }, { script: 'x', description: '' },
  { script: 'x', description: 'x', timeoutMs: -1 },
  { script: 'x', description: 'x', timeoutMs: 3_600_001 },
  { script: 'x', description: 'x', spaceId: 0 },
  { script: 'x', description: 'x', profileId: '' },
  { script: 'x', description: 'x', mode: 'wrong' },
]) await assert.rejects(tool.execute(args, {}))

const output = { ok: true, exitCode: 0, stdout: 'out', stderr: 'log', timedOut: false, truncated: false, script: '' }
assert.match(tool.output.render({}, output)[0].text, /log\nout/)
assert.match(tool.output.render({ timeoutMs: 1000 }, { ...output, ok: false, timedOut: true })[0].text, /after 1000ms/)
assert.match(tool.output.render({}, { ...output, truncated: true })[0].text, /output truncated/)
assert.match(tool.output.render({}, { ...output, ok: false, exitCode: 3 })[0].text, /exited 3/)
const controller = new AbortController()
controller.abort()
const cancelled = await runEgo('must-not-spawn', '', { signal: controller.signal, timeoutMs: 100 })
assert.equal(cancelled.exitCode, -1)
assert.match(cancelled.stderr, /before start/)
const missing = await runEgo('missing-ego-binary-test-no-such-executable', '', { timeoutMs: 1000 })
assert.equal(missing.exitCode, -1)
console.log('PASS mount/schema, isolated registration, validation, rendering and cancelled/missing execution')
