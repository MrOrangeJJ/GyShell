import {
  parseWindowsBuildNumber,
  resolveTerminalWindowsPty,
  resolveTerminalWindowsPtyTransition,
  windowsPtyOptionsEqual
} from './terminalWindowsPty'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}. expected=${expectedJson} actual=${actualJson}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('parses the Windows build number from a dotted release string', () => {
  assertEqual(parseWindowsBuildNumber('10.0.26100'), 26100, 'should parse the trailing build segment')
})

runCase('parses the Windows build number from a four-part release string', () => {
  assertEqual(
    parseWindowsBuildNumber('10.0.26100.3476'),
    26100,
    'should parse the build segment instead of the revision segment'
  )
})

runCase('ignores invalid Windows release values', () => {
  assertEqual(parseWindowsBuildNumber(''), undefined, 'empty release should not yield a build number')
  assertEqual(parseWindowsBuildNumber('preview-build'), undefined, 'non-numeric release should not yield a build number')
})

runCase('derives a conservative conpty hint for Windows terminals', () => {
  assertDeepEqual(
    resolveTerminalWindowsPty('windows', { release: '10.0.26100' }),
    { backend: 'conpty', buildNumber: 26100 },
    'windows terminals should receive a conpty hint'
  )
})

runCase('uses winpty for pre-ConPTY Windows builds', () => {
  assertDeepEqual(
    resolveTerminalWindowsPty('windows', { release: '10.0.14393' }),
    { backend: 'winpty', buildNumber: 14393 },
    'pre-ConPTY Windows builds should receive a winpty hint'
  )
})

runCase('falls back to a conservative build number before system info arrives', () => {
  assertDeepEqual(
    resolveTerminalWindowsPty('windows'),
    { backend: 'conpty', buildNumber: 18309 },
    'unknown Windows terminals should disable POSIX reflow until their exact build arrives'
  )
})

runCase('does not enable windows pty hints for non-Windows terminals', () => {
  assertEqual(resolveTerminalWindowsPty('unix'), undefined, 'unix terminals should not receive windows pty hints')
})

runCase('does not downgrade an exact Windows build on stale metadata', () => {
  assertDeepEqual(
    resolveTerminalWindowsPtyTransition(
      { backend: 'conpty', buildNumber: 26100 },
      'windows'
    ),
    { backend: 'conpty', buildNumber: 26100 },
    'missing release metadata must not replace a known exact build with the fallback'
  )
})

runCase('does not replace an exact pre-ConPTY build with the unknown fallback', () => {
  assertDeepEqual(
    resolveTerminalWindowsPtyTransition(
      { backend: 'winpty', buildNumber: 14393 },
      'windows'
    ),
    { backend: 'winpty', buildNumber: 14393 },
    'missing release metadata must preserve an exact legacy Windows mode'
  )
})

runCase('still removes Windows mode when the terminal is confirmed Unix', () => {
  assertEqual(
    resolveTerminalWindowsPtyTransition(
      { backend: 'conpty', buildNumber: 26100 },
      'unix'
    ),
    undefined,
    'an explicit Unix transition should remove Windows PTY behavior'
  )
})

runCase('accepts a new exact build after reconnect', () => {
  assertDeepEqual(
    resolveTerminalWindowsPtyTransition(
      { backend: 'conpty', buildNumber: 22631 },
      'windows',
      { release: '10.0.26100' }
    ),
    { backend: 'conpty', buildNumber: 26100 },
    'fresh exact metadata should replace the previous runtime build'
  )
})

runCase('compares windows pty options structurally', () => {
  assertEqual(
    windowsPtyOptionsEqual(
      { backend: 'conpty', buildNumber: 26100 },
      { backend: 'conpty', buildNumber: 26100 }
    ),
    true,
    'matching windows pty options should compare equal'
  )
  assertEqual(
    windowsPtyOptionsEqual(
      { backend: 'conpty', buildNumber: 26100 },
      { backend: 'conpty', buildNumber: 19045 }
    ),
    false,
    'different windows pty options should not compare equal'
  )
})

console.log('All terminal windows pty extreme tests passed.')
