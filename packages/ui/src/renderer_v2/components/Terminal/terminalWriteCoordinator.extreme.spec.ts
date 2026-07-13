import { TerminalWriteCoordinator } from './terminalWriteCoordinator'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('writes immediately without a refit barrier', () => {
  const writes: string[] = []
  const coordinator = new TerminalWriteCoordinator((data, callback) => {
    writes.push(data)
    callback()
  })

  coordinator.write('alpha')

  assertEqual(writes.join(''), 'alpha', 'the writer should receive data immediately')
  assertEqual(coordinator.hasPendingWrites, false, 'a synchronous callback should drain the write')
})

runCase('fences and coalesces new output so a refit cannot starve', () => {
  const writes: string[] = []
  const coordinator = new TerminalWriteCoordinator((data, callback) => {
    writes.push(data)
    callback()
  })

  coordinator.beginRefitBarrier()
  coordinator.write('alpha')
  coordinator.write('beta')
  assertEqual(
    writes.join(''),
    '',
    'post-fence bytes should wait until the resize has completed'
  )

  coordinator.endRefitBarrier()
  assertEqual(writes.length, 1, 'ending a refit should release one coalesced parser write')
  assertEqual(writes[0], 'alphabeta', 'coalescing must preserve byte order')
})

runCase('notifies a waiting refit only after every older write drains', () => {
  const callbacks: Array<() => void> = []
  let drainCount = 0
  const coordinator = new TerminalWriteCoordinator((_data, callback) => {
    callbacks.push(callback)
  })
  coordinator.setDrainHandler(() => {
    drainCount += 1
  })

  coordinator.write('one')
  coordinator.write('two')
  coordinator.beginRefitBarrier()
  coordinator.write('new-size')
  callbacks[0]()
  assertEqual(drainCount, 0, 'remaining old-size writes must keep the refit waiting')
  callbacks[1]()
  assertEqual(drainCount, 1, 'the final old-size write should release the refit')

  coordinator.endRefitBarrier()
  assertEqual(callbacks.length, 3, 'post-fence output should be released only after the refit')
})

runCase('applies metadata transitions only after earlier parser writes drain', () => {
  const events: string[] = []
  const callbacks: Array<() => void> = []
  const coordinator = new TerminalWriteCoordinator((data, callback) => {
    events.push(`write:${data}`)
    callbacks.push(callback)
  }, 'unix')

  coordinator.write('old')
  coordinator.write('new-a', {
    key: 'windows:26100',
    apply: () => events.push('mode:windows')
  })
  coordinator.write('new-b', {
    key: 'windows:26100',
    apply: () => events.push('mode:windows-duplicate')
  })
  assertEqual(
    events.join('|'),
    'write:old',
    'a new parser mode must not overtake an older asynchronous write'
  )

  callbacks[0]()
  assertEqual(
    events.join('|'),
    'write:old|mode:windows|write:new-anew-b',
    'same-mode data should coalesce after applying the transition once'
  )
})

runCase('serializes distinct metadata transitions around their matching data', () => {
  const events: string[] = []
  const callbacks: Array<() => void> = []
  const coordinator = new TerminalWriteCoordinator((data, callback) => {
    events.push(`write:${data}`)
    callbacks.push(callback)
  }, 'unknown')

  coordinator.write('windows', {
    key: 'windows:19045',
    apply: () => events.push('mode:windows')
  })
  coordinator.write('unix', {
    key: 'unix',
    apply: () => events.push('mode:unix')
  })
  assertEqual(
    events.join('|'),
    'mode:windows|write:windows',
    'the later Unix transition should wait behind Windows data'
  )

  callbacks[0]()
  assertEqual(
    events.join('|'),
    'mode:windows|write:windows|mode:unix|write:unix',
    'each transition must be adjacent to the data it describes'
  )
})

runCase('dispose ignores later output and drain notifications', () => {
  const writes: string[] = []
  const coordinator = new TerminalWriteCoordinator((data, callback) => {
    writes.push(data)
    callback()
  })

  coordinator.beginRefitBarrier()
  coordinator.dispose()
  coordinator.endRefitBarrier()
  coordinator.write('discarded')

  assertEqual(writes.length, 0, 'disposed runtimes should not receive queued output')
})

console.log('All terminal write coordinator extreme tests passed.')
