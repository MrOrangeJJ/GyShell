import { createChatScrollbarDragState } from './useChatScrollbarDrag'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('reports no frozen height until a drag begins', () => {
  const drag = createChatScrollbarDragState(() => {})
  assertEqual(drag.isDragging(), false, 'should start idle')
  assertEqual(
    drag.frozenTotalHeight(),
    null,
    'no height should be pinned while idle',
  )
})

runCase('pins the scroller height for the whole drag', () => {
  const drag = createChatScrollbarDragState(() => {})
  drag.begin(1_795_510)
  // Measured heights replacing estimates would normally shrink the layout.
  drag.syncNaturalHeight(1_780_797)
  drag.syncNaturalHeight(1_784_665)
  assertEqual(
    drag.frozenTotalHeight(),
    1_795_510,
    'scroller length must not shrink mid-drag or Chromium drops the frame',
  )
})

runCase('still allows growth from streaming or pagination', () => {
  const drag = createChatScrollbarDragState(() => {})
  drag.begin(1_795_510)
  drag.syncNaturalHeight(1_801_000)
  assertEqual(
    drag.frozenTotalHeight(),
    1_801_000,
    'appended content must remain reachable during a drag',
  )
  drag.syncNaturalHeight(1_790_000)
  assertEqual(
    drag.frozenTotalHeight(),
    1_801_000,
    'a later shrink must not undo the grown height',
  )
})

runCase('releases the pin and notifies once on pointer release', () => {
  let flushes = 0
  const drag = createChatScrollbarDragState(() => {
    flushes += 1
  })
  drag.begin(1_795_510)
  drag.end()
  assertEqual(drag.isDragging(), false, 'drag should be over')
  assertEqual(drag.frozenTotalHeight(), null, 'pin should be released')
  assertEqual(flushes, 1, 'buffered measurements should flush exactly once')
  drag.end()
  assertEqual(flushes, 1, 'a redundant pointerup must not flush again')
})

runCase('ignores a nested pointerdown while already dragging', () => {
  const drag = createChatScrollbarDragState(() => {})
  drag.begin(1_795_510)
  drag.begin(12_345)
  assertEqual(
    drag.frozenTotalHeight(),
    1_795_510,
    'the original baseline must survive a duplicate pointerdown',
  )
})

runCase('ignores height syncs while idle', () => {
  const drag = createChatScrollbarDragState(() => {})
  drag.syncNaturalHeight(999)
  assertEqual(drag.frozenTotalHeight(), null, 'idle syncs must not pin a height')
  drag.end()
  assertEqual(drag.isDragging(), false, 'ending an idle drag is a no-op')
})

runCase('supports repeated drags on the same controller', () => {
  let flushes = 0
  const drag = createChatScrollbarDragState(() => {
    flushes += 1
  })
  drag.begin(1_000)
  drag.syncNaturalHeight(1_200)
  drag.end()
  drag.begin(900)
  assertEqual(
    drag.frozenTotalHeight(),
    900,
    'a new drag must re-baseline from the current layout height',
  )
  drag.end()
  assertEqual(flushes, 2, 'each completed drag should flush once')
})

console.log('All chat scrollbar drag extreme tests passed.')
