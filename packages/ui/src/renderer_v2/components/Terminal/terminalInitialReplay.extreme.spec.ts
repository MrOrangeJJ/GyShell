import assert from 'node:assert/strict'
import {
  hasTerminalLiveOffsetGap,
  mergeTerminalInitialReplay,
} from './terminalInitialReplay'

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('live output restores the prefix trimmed from an atomic ring-buffer snapshot', () => {
  const live = `${'a'.repeat(50_000)}${'b'.repeat(200_000)}`
  const snapshot = live.slice(-200_000)
  const replay = mergeTerminalInitialReplay([
    { data: snapshot, offset: live.length },
    { data: live, offset: live.length }
  ])

  assert.equal(replay.data, live)
  assert.equal(replay.offset, live.length)
  assert.equal(replay.hasGap, false)
})

runCase('overlapping snapshot and live chunks preserve exact order once', () => {
  const replay = mergeTerminalInitialReplay([
    { data: 'abcdefghij', offset: 10 },
    { data: 'ijklmnop', offset: 16 },
    { data: 'mnopqrst', offset: 20 }
  ])

  assert.equal(replay.data, 'abcdefghijklmnopqrst')
  assert.equal(replay.offset, 20)
  assert.equal(replay.hasGap, false)
})

runCase('a bounded snapshot with no live prefix remains readable at its absolute offset', () => {
  const replay = mergeTerminalInitialReplay([
    { data: 'retained-tail', offset: 250_000 }
  ])

  assert.equal(replay.data, 'retained-tail')
  assert.equal(replay.offset, 250_000)
  assert.equal(replay.hasGap, false)
})

runCase('non-contiguous initial replay intervals fail closed before ACK', () => {
  const replay = mergeTerminalInitialReplay([
    { data: 'abcdefghij', offset: 10 },
    { data: 'uvwxyz', offset: 30 }
  ])

  assert.equal(replay.hasGap, true)
  assert.equal(replay.gapStart, 10)
  assert.equal(replay.gapEnd, 24)
})

runCase('an empty generation boundary still exposes a replay offset gap', () => {
  const replay = mergeTerminalInitialReplay([
    { data: 'abcdefghij', offset: 10 },
    { data: '', offset: 30 }
  ])

  assert.equal(replay.hasGap, true)
  assert.equal(replay.gapStart, 10)
  assert.equal(replay.gapEnd, 30)
})

runCase('live offset gaps are detected before a cumulative acknowledgement', () => {
  assert.equal(
    hasTerminalLiveOffsetGap(100, { data: 'missing-prefix', offset: 130 }),
    true,
  )
  assert.equal(
    hasTerminalLiveOffsetGap(116, { data: 'next-frame', offset: 126 }),
    false,
  )
  assert.equal(
    hasTerminalLiveOffsetGap(126, { data: '', offset: 200 }),
    true,
    'a generation boundary must expose output lost before the replacement runtime',
  )
})

console.log('All terminal initial replay extreme tests passed.')
