import assert from 'node:assert/strict'
import { defaultSpaceName, spacePreamble, prepareScript } from '../index.js'

const exec = { agent: { session: { id: 'alpha' } } }
assert.equal(defaultSpaceName(exec), defaultSpaceName(exec))
assert.notEqual(defaultSpaceName(exec), defaultSpaceName({ agent: { session: { id: 'beta' } } }))
assert.equal(defaultSpaceName({}), defaultSpaceName())
assert.match(spacePreamble({ spaceId: 42, spaceName: 'ignored' }, exec), /taskSpace\(42\)/)
assert.match(spacePreamble({ spaceName: ' goal ', profileId: 'Profile 5' }, exec), /taskSpace\("goal", \{ profileId: "Profile 5" \}\)/)
assert.throws(() => spacePreamble({ spaceId: 42, profileId: 'Profile 5' }, exec), /new space/)
const name = 'x"); process.exit(1); //'
assert.ok(spacePreamble({ spaceName: name }, exec).startsWith(`const task = await taskSpace(${JSON.stringify(name)});`))
assert.throws(() => prepareScript({ mode: 'official', spaceId: 1, script: 'x' }, exec), /official mode/)

// No eager selection: profile listing/control helpers/full official scripts can
// run even when a convenience space has been handed to the user.
let selections = 0
const official = 'console.log("official source")'
assert.equal(prepareScript({ script: official }, exec), official)
assert.equal(selections, 0)

// Simulate SDK state in managed mode, including success/keep/handoff rules.
const spaces = new Map()
let nextId = 1
const taskSpace = async (target, options) => {
  selections++
  let task = typeof target === 'number' ? [...spaces.values()].find(s => s.spaceId === target) : spaces.get(target)
  if (task?.ownership === 'user') throw new Error('EGO_TASK_SPACE_NAME_IN_USE')
  if (!task) {
    task = {
      spaceId: nextId++, profile: options?.profileId, ownership: 'agent',
      page: () => ({ label: 'p1' }),
      async finish({ keep }) { if (keep.length === 0) spaces.delete(target); else this.ownership = 'user' },
      async handOff() { this.ownership = 'user' },
    }
    spaces.set(target, task)
  }
  return task
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const run = (args) => new AsyncFunction('taskSpace', prepareScript(args, exec))(taskSpace)
await run({ mode: 'managed', script: 'task.marker = 123' })
await run({ mode: 'managed', script: 'if (task.marker !== 123) throw Error("not resumed")' })
assert.equal(spaces.size, 1)
await run({ mode: 'managed', script: 'await task.finish({ keep: [] })' })
assert.equal(spaces.size, 0)
await run({ spaceName: 'new-goal', profileId: 'Profile 5', script: 'if (task.profile !== "Profile 5") throw Error("profile lost"); await task.finish({ keep: [] })' })
await run({ spaceName: 'kept', script: 'await task.finish({ keep: ["p1"] })' })
await assert.rejects(run({ spaceName: 'kept', script: 'throw Error("must not run")' }), /EGO_TASK_SPACE_NAME_IN_USE/)
await run({ spaceName: 'handoff', script: 'await task.handOff()' })
await assert.rejects(run({ spaceName: 'handoff', script: 'throw Error("must not run")' }), /EGO_TASK_SPACE_NAME_IN_USE/)
assert.equal(prepareScript({ script: 'await claimTaskSpace(7)' }, exec), 'await claimTaskSpace(7)')
console.log('PASS official syntax and managed space/profile lifecycle, keep/handoff ownership protection')
