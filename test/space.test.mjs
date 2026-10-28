// Task-space selection suite.
//
// The official ego guide asks for one TaskSpace per user goal and provides
// `taskSpace(name)` to resume a space by name. The plugin previously used a
// timestamped name, which recreated a space on every call and left strays
// behind. These checks pin the fix: the default name must be stable for a
// session, and explicit targeting must still win.
import { defaultSpaceName, spacePreamble } from '../index.js'

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`)
}

const execOf = (sessionId) => ({ agent: { session: { id: sessionId } } })

// ---- 1. the default name is stable per session ----
const a1 = defaultSpaceName(execOf('session-alpha'))
const a2 = defaultSpaceName(execOf('session-alpha'))
const b1 = defaultSpaceName(execOf('session-beta'))

check('same session yields the same name', a1, a2)
check('different sessions yield different names', a1 === b1, false)
check('name carries the session id', a1.includes('session-alpha'), true)
check('name has no timestamp-like suffix', /\d{10,}/.test(a1), false)

// ---- 2. repeated calls produce an identical prelude (the actual fix) ----
const p1 = spacePreamble({ script: 'x' }, execOf('session-alpha'))
const p2 = spacePreamble({ script: 'y' }, execOf('session-alpha'))
check('identical prelude across calls in one session', p1, p2)
check('prelude resolves by name, not by minting an id', p1.startsWith('const task = await taskSpace("'), true)
check('prelude ends with a newline', p1.endsWith('\n'), true)
check('prelude has no Date.now', p1.includes('Date.now'), false)

// ---- 3. explicit targeting wins ----
check(
  'spaceId wins over everything',
  spacePreamble({ spaceId: 42, spaceName: 'ignored' }, execOf('s')),
  'const task = await taskSpace(42);\n',
)
check(
  'spaceName wins over the session default',
  spacePreamble({ spaceName: 'my-goal' }, execOf('s')),
  'const task = await taskSpace("my-goal");\n',
)
check(
  'blank spaceName falls back to the session default',
  spacePreamble({ spaceName: '   ' }, execOf('session-z')),
  `const task = await taskSpace(${JSON.stringify(defaultSpaceName(execOf('session-z')))});\n`,
)
check(
  'spaceName is trimmed',
  spacePreamble({ spaceName: '  padded  ' }, execOf('s')),
  'const task = await taskSpace("padded");\n',
)

// ---- 4. agentless calls stay stable instead of minting spaces ----
const noAgent1 = defaultSpaceName({})
const noAgent2 = defaultSpaceName(undefined)
check('agentless name is stable', noAgent1, noAgent2)
check('agentless name is not timestamped', /\d{10,}/.test(noAgent1), false)

// ---- 5. an attacker-shaped name cannot break out of the string literal ----
const injected = spacePreamble({ spaceName: 'x"); process.exit(1); //' }, execOf('s'))
check(
  'quotes in spaceName are escaped',
  injected.includes('process.exit'),
  true,
)
check(
  'escaped name stays inside one string literal',
  /^const task = await taskSpace\("(?:[^"\\]|\\.)*"\);\n$/.test(injected),
  true,
)

console.log(`\n=== ${failures === 0 ? 'ALL SPACE CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`)
process.exitCode = failures === 0 ? 0 : 1
