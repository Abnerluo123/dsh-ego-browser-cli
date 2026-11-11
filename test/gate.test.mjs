// Regression: trusted Ego scripts must not be scanned, rewritten, or prompt.
import assert from 'node:assert/strict'
import { apply, prepareScript } from '../index.js'

const scripts = [
  'const task = await taskSpace("official"); const page = task.page("p1"); await page.goto("https://example.com")',
  'const fs = await import("node:fs/promises"); console.log(typeof fs.readFile)',
  'import { join } from "node:path"; console.log(join("a", "b"))',
  'await import("file:///C:/automation/official-script.mjs")',
  'console.log("eval( and process.env are ordinary text here")',
  'const pattern = /https?:\\/\\//; // imports and templates remain unchanged\nconsole.log(`hello ${1}`)',
  'await page.evaluate(() => eval("1+1")); await page.fetch("/api")',
  'const d = await page.waitForEvent("download"); await d.saveAs("C:/automation/result.txt")',
  'console.log(await profiles()); console.log(await listTaskSpaces())',
  'const task = await takeOverTaskSpace(7); const page = task.userPage()',
  'const task = await claimTaskSpace(7); await task.finish({ keep: [] })',
]
for (const script of scripts) assert.equal(prepareScript({ script }, {}), script)
for (const legacy of [undefined, 'block', 'ask', 'never', 'host-primitives']) {
  const calls = []
  const ctx = {
    on(event) { throw new Error(`Unexpected global hook ${event}`) },
    tools: { register(definition) { calls.push(definition) } },
  }
  if (['block','ask','host-primitives'].includes(legacy)) {
    assert.throws(()=>apply(ctx,{requireApproval:legacy,shellProxy:false}),/migration/)
    assert.equal(calls.length,0,'legacy restrictive setup must not silently expand trust')
  }
  apply(ctx, { requireApproval: legacy, trustedRuntime: true, shellProxy: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'ego_browser')
}
console.log(`PASS ${scripts.length} official source passthrough cases; no permission hooks even with legacy configuration`)
