import {
  buildChatVirtualLayout,
  captureChatViewportAnchor,
  CHAT_MESSAGE_LIST_BOTTOM_PADDING,
  resolveChatAutoScrollOnRender,
  resolveChatOffscreenLayoutChangedItems,
  resolveNextChatOffscreenMeasurementRetentionState,
  resolveChatOffscreenStreamingItems,
  resolveChatScrollAnchorAdjustment,
  resolveChatViewportAnchorScrollTop,
  resolveChatVirtualRange,
  shouldInvalidateChatMeasuredHeights,
} from './chatVirtualList'
import type { ChatRenderItem } from './chatRenderModel'
import {
  createChatTextHeightShape,
  createFixedChatRowHeightEstimate,
} from './chatRowHeightEstimate'

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

const createItem = (
  id: string,
  estimatedHeight: number,
): ChatRenderItem => ({
  id,
  kind: 'assistant',
  heightEstimate: createFixedChatRowHeightEstimate(estimatedHeight),
  mergeWithPreviousAssistant: false,
  showAssistantRoleLabel: false,
  showAssistantGroupCopy: false,
  assistantGroupMessageIds: [],
})

runCase('measured row heights override estimated values in layout math', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 100),
    createItem('row-3', 100),
  ]

  const layout = buildChatVirtualLayout(
    items,
    new Map([
      ['row-2', 240],
    ]),
  )

  assertEqual(layout.offsets[0], 0, 'first row should start at offset zero')
  assertEqual(layout.offsets[1], 100, 'second row should start after first row')
  assertEqual(layout.offsets[2], 340, 'third row should start after measured second row')
  assertEqual(
    layout.totalHeight,
    440 + CHAT_MESSAGE_LIST_BOTTOM_PADDING,
    'total height should include measured row heights and bottom padding',
  )
})

runCase('virtual range returns a minimal visible window without overscan', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 240),
    createItem('row-3', 80),
  ]
  const layout = buildChatVirtualLayout(items, new Map())
  const range = resolveChatVirtualRange(layout, 150, 50, 0)

  assertEqual(range.startIndex, 1, 'scrolling into row-2 should start at row-2')
  assertEqual(range.endIndex, 2, 'viewport should only include row-2 without overscan')
})

runCase('virtual range expands in both directions when overscan is enabled', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 240),
    createItem('row-3', 80),
    createItem('row-4', 120),
  ]
  const layout = buildChatVirtualLayout(items, new Map())
  const range = resolveChatVirtualRange(layout, 150, 50, 120)

  assertEqual(range.startIndex, 0, 'overscan should include the previous row')
  assertEqual(
    range.endIndex,
    2,
    'overscan should include rows whose top edge enters the overscan window',
  )
})

runCase('viewport anchors preserve the same message and intra-row offset after resize', () => {
  const items: ChatRenderItem[] = [
    createItem('row-1', 100),
    {
      ...createItem('row-2', 100),
      heightEstimate: {
        fixedHeight: 8,
        textShape: createChatTextHeightShape('x'.repeat(600)),
      },
    },
    createItem('row-3', 100),
  ]
  const wideLayout = buildChatVirtualLayout(items, new Map(), {
    viewportWidth: 720,
  })
  const wideScrollTop = wideLayout.offsets[1] + 24
  const anchor = captureChatViewportAnchor(
    items,
    wideLayout,
    wideScrollTop,
  )

  assertEqual(anchor?.itemId, 'row-2', 'the top visible message should be captured')
  assertEqual(
    anchor?.offsetWithinItem,
    24,
    'the viewport offset inside the top message should be captured',
  )

  const narrowLayout = buildChatVirtualLayout(items, new Map(), {
    viewportWidth: 291,
  })
  const narrowScrollTop = anchor
    ? resolveChatViewportAnchorScrollTop(items, narrowLayout, anchor)
    : null

  assertEqual(
    narrowScrollTop,
    narrowLayout.offsets[1] + 24,
    'resize should restore the same message and intra-row offset',
  )
  assertEqual(
    narrowLayout.heights[1] > wideLayout.heights[1],
    true,
    'the anchor test must exercise a width-sensitive row',
  )
})

runCase('viewport anchor restoration fails closed when its message was removed', () => {
  const beforeItems = [createItem('row-1', 100), createItem('row-2', 100)]
  const beforeLayout = buildChatVirtualLayout(beforeItems, new Map())
  const anchor = captureChatViewportAnchor(beforeItems, beforeLayout, 125)
  const afterItems = [createItem('row-1', 100)]
  const afterLayout = buildChatVirtualLayout(afterItems, new Map())

  assertEqual(anchor?.itemId, 'row-2', 'the removed message should own the anchor')
  assertEqual(
    anchor
      ? resolveChatViewportAnchorScrollTop(afterItems, afterLayout, anchor)
      : -1,
    null,
    'a removed anchor must not produce a fabricated scroll position',
  )
})

runCase('auto-scroll stays disabled for an already handled user tail', () => {
  const decision = resolveChatAutoScrollOnRender({
    lastMessageId: 'user-1',
    lastMessageRole: 'user',
    autoScrollEnabled: false,
    lastUserTailAutoScrollMessageId: 'user-1',
  })

  assertEqual(
    decision.shouldScrollToBottom,
    false,
    'layout changes after a handled user tail must not force bottom scroll',
  )
  assertEqual(
    decision.nextAutoScrollEnabled,
    false,
    'handled user tail must preserve manual scroll-away mode',
  )
  assertEqual(
    decision.nextLastUserTailAutoScrollMessageId,
    'user-1',
    'handled user tail id should remain tracked',
  )
})

runCase('auto-scroll re-enables once when a new user tail appears', () => {
  const firstDecision = resolveChatAutoScrollOnRender({
    lastMessageId: 'user-2',
    lastMessageRole: 'user',
    autoScrollEnabled: false,
    lastUserTailAutoScrollMessageId: 'user-1',
  })

  assertEqual(
    firstDecision.shouldScrollToBottom,
    true,
    'a newly appended user tail should force the list to the bottom once',
  )
  assertEqual(
    firstDecision.nextAutoScrollEnabled,
    true,
    'new user tail should re-enable bottom follow mode',
  )
  assertEqual(
    firstDecision.nextLastUserTailAutoScrollMessageId,
    'user-2',
    'new user tail id should be recorded after the forced scroll',
  )

  const secondDecision = resolveChatAutoScrollOnRender({
    lastMessageId: 'user-2',
    lastMessageRole: 'user',
    autoScrollEnabled: false,
    lastUserTailAutoScrollMessageId:
      firstDecision.nextLastUserTailAutoScrollMessageId,
  })

  assertEqual(
    secondDecision.shouldScrollToBottom,
    false,
    'the same user tail should not repeatedly force bottom scroll after the user scrolls away',
  )
})

runCase('auto-scroll remains disabled for assistant tails when the user scrolls away', () => {
  const decision = resolveChatAutoScrollOnRender({
    lastMessageId: 'assistant-1',
    lastMessageRole: 'assistant',
    autoScrollEnabled: false,
    lastUserTailAutoScrollMessageId: 'user-1',
  })

  assertEqual(
    decision.shouldScrollToBottom,
    false,
    'assistant tails should respect manual scroll-away mode',
  )
  assertEqual(
    decision.nextAutoScrollEnabled,
    false,
    'assistant tails should not re-enable auto-scroll by themselves',
  )
})

runCase('offscreen streaming selection keeps only rows outside the virtual window', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 100),
    createItem('row-3', 100),
    createItem('row-4', 100),
  ]

  const offscreenItems = resolveChatOffscreenStreamingItems(
    [
      { item: items[0], index: 0 },
      { item: items[3], index: 3 },
    ],
    {
      startIndex: 1,
      endIndex: 3,
    },
  )

  assertEqual(
    offscreenItems.map((item) => item.id).join(','),
    'row-1,row-4',
    'streaming rows above and below the window should stay mounted for measurement',
  )
})

runCase('offscreen streaming selection excludes visible and non-streaming rows', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 100),
    createItem('row-3', 100),
  ]

  const offscreenItems = resolveChatOffscreenStreamingItems(
    [
      { item: items[1], index: 1 },
      { item: items[2], index: 2 },
    ],
    {
      startIndex: 0,
      endIndex: 2,
    },
  )

  assertEqual(
    offscreenItems.map((item) => item.id).join(','),
    'row-3',
    'only offscreen streaming rows should be selected for hidden measurement',
  )
})

runCase('offscreen layout invalidation selects assistant rows whose grouping changes', () => {
  const previousItems = [
    createItem('row-1', 100),
    createItem('row-2', 100),
    createItem('row-3', 100),
  ]
  const nextItems: ChatRenderItem[] = [
    previousItems[0],
    {
      ...previousItems[1],
      mergeWithPreviousAssistant: true,
    },
    previousItems[2],
  ]

  const invalidatedItems = resolveChatOffscreenLayoutChangedItems(
    nextItems,
    new Map(previousItems.map((item) => [item.id, item])),
    {
      startIndex: 2,
      endIndex: 3,
    },
  )

  assertEqual(
    invalidatedItems.map((item) => item.id).join(','),
    'row-2',
    'offscreen rows should be re-measured when assistant grouping removes header spacing',
  )
})

runCase('offscreen layout invalidation selects tail rows whose copy footer changes', () => {
  const previousItems = [
    createItem('row-1', 100),
    createItem('row-2', 100),
  ]
  const nextItems: ChatRenderItem[] = [
    previousItems[0],
    {
      ...previousItems[1],
      showAssistantGroupCopy: true,
      assistantGroupMessageIds: ['row-1', 'row-2'],
    },
  ]

  const invalidatedItems = resolveChatOffscreenLayoutChangedItems(
    nextItems,
    new Map(previousItems.map((item) => [item.id, item])),
    {
      startIndex: 0,
      endIndex: 1,
    },
  )

  assertEqual(
    invalidatedItems.map((item) => item.id).join(','),
    'row-2',
    'offscreen rows should be re-measured when copy controls appear after completion',
  )
})

runCase('offscreen layout invalidation selects rows whose assistant label changes', () => {
  const previousItems = [
    createItem('row-1', 100),
    createItem('row-2', 100),
  ]
  const nextItems: ChatRenderItem[] = [
    previousItems[0],
    {
      ...previousItems[1],
      showAssistantRoleLabel: true,
    },
  ]

  const invalidatedItems = resolveChatOffscreenLayoutChangedItems(
    nextItems,
    new Map(previousItems.map((item) => [item.id, item])),
    {
      startIndex: 0,
      endIndex: 1,
    },
  )

  assertEqual(
    invalidatedItems.map((item) => item.id).join(','),
    'row-2',
    'offscreen rows should be re-measured when assistant role labels appear',
  )
})

runCase('equivalent height descriptors do not fan out hidden measurements', () => {
  const previousItems = [
    {
      ...createItem('row-1', 30),
      heightEstimate: {
        fixedHeight: 8,
        textShape: createChatTextHeightShape('same content\nwith wrapping'),
      },
    },
  ]
  const nextItems = [
    {
      ...previousItems[0],
      heightEstimate: {
        fixedHeight: 8,
        textShape: createChatTextHeightShape('same content\nwith wrapping'),
      },
    },
  ]

  const invalidatedItems = resolveChatOffscreenLayoutChangedItems(
    nextItems,
    new Map(previousItems.map((item) => [item.id, item])),
    { startIndex: 1, endIndex: 1 },
  )

  assertEqual(
    invalidatedItems.length,
    0,
    'descriptor reallocation without semantic changes must not mount offscreen rows',
  )
})

runCase('offscreen layout invalidation ignores visible rows and stable layout props', () => {
  const previousItems = [
    createItem('row-1', 100),
    createItem('row-2', 100),
    createItem('row-3', 100),
  ]
  const nextItems: ChatRenderItem[] = [
    {
      ...previousItems[0],
      mergeWithPreviousAssistant: true,
    },
    previousItems[1],
    {
      ...previousItems[2],
      assistantGroupMessageIds: ['row-2', 'row-3'],
    },
  ]

  const invalidatedItems = resolveChatOffscreenLayoutChangedItems(
    nextItems,
    new Map(previousItems.map((item) => [item.id, item])),
    {
      startIndex: 0,
      endIndex: 1,
    },
  )

  assertEqual(
    invalidatedItems.length,
    0,
    'visible rows and assistant-group id churn without layout changes should not trigger hidden measurement',
  )
})

runCase('width-driven cache invalidation only runs when the viewport width actually changes', () => {
  assertEqual(
    shouldInvalidateChatMeasuredHeights(null, 720),
    false,
    'initial viewport measurement should not flush an empty cache',
  )
  assertEqual(
    shouldInvalidateChatMeasuredHeights(720, 720.4),
    false,
    'sub-pixel resize noise should not invalidate measured heights',
  )
  assertEqual(
    shouldInvalidateChatMeasuredHeights(720, 680),
    true,
    'real viewport width changes should invalidate stale measured heights',
  )
})

runCase('completed offscreen rows stay retained for one extra measurement render', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 100),
  ]
  const renderItemIndexById = new Map<string, number>([
    ['row-1', 0],
    ['row-2', 1],
  ])

  const retentionAfterStreaming = resolveNextChatOffscreenMeasurementRetentionState(
    {
      currentState: {},
      currentOffscreenStreamingItems: [items[0]],
      renderItemIndexById,
      visibleRange: {
        startIndex: 1,
        endIndex: 2,
      },
      tailRetentionItemId: null,
      thinking: true,
    },
  )

  assertEqual(
    retentionAfterStreaming['row-1'],
    'next-layout',
    'offscreen streaming rows should stay mounted for one more render after completion',
  )

  const retentionAfterCompletion = resolveNextChatOffscreenMeasurementRetentionState(
    {
      currentState: retentionAfterStreaming,
      currentOffscreenStreamingItems: [],
      renderItemIndexById,
      visibleRange: {
        startIndex: 1,
        endIndex: 2,
      },
      tailRetentionItemId: null,
      thinking: true,
    },
  )

  assertEqual(
    Object.keys(retentionAfterCompletion).length,
    0,
    'one-layout retention rows should drop after the completion render is observed',
  )
})

runCase('tail rows stay retained until thinking completes', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 100),
  ]
  const renderItemIndexById = new Map<string, number>([
    ['row-1', 0],
    ['row-2', 1],
  ])

  const retentionWhileStreaming = resolveNextChatOffscreenMeasurementRetentionState(
    {
      currentState: {},
      currentOffscreenStreamingItems: [items[1]],
      renderItemIndexById,
      visibleRange: {
        startIndex: 0,
        endIndex: 1,
      },
      tailRetentionItemId: 'row-2',
      thinking: true,
    },
  )

  assertEqual(
    retentionWhileStreaming['row-2'],
    'until-done',
    'tail rows should stay retained while waiting for DONE-driven UI changes',
  )

  const retentionBeforeDone = resolveNextChatOffscreenMeasurementRetentionState(
    {
      currentState: retentionWhileStreaming,
      currentOffscreenStreamingItems: [],
      renderItemIndexById,
      visibleRange: {
        startIndex: 0,
        endIndex: 1,
      },
      tailRetentionItemId: 'row-2',
      thinking: true,
    },
  )

  assertEqual(
    retentionBeforeDone['row-2'],
    'until-done',
    'tail rows should keep measuring through non-streaming completion updates before DONE',
  )

  const retentionAfterDone = resolveNextChatOffscreenMeasurementRetentionState(
    {
      currentState: retentionBeforeDone,
      currentOffscreenStreamingItems: [],
      renderItemIndexById,
      visibleRange: {
        startIndex: 0,
        endIndex: 1,
      },
      tailRetentionItemId: 'row-2',
      thinking: false,
    },
  )

  assertEqual(
    Object.keys(retentionAfterDone).length,
    0,
    'tail rows should drop from hidden measurement after the DONE render is observed',
  )
})

runCase('scroll anchor shifts by the measured delta when a row above the viewport changes height', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 200),
    createItem('row-3', 80),
  ]
  const layout = buildChatVirtualLayout(items, new Map())

  const adjustment = resolveChatScrollAnchorAdjustment({
    layout,
    itemIndex: 0,
    nextHeight: 160,
    scrollTop: 220,
    autoScrollEnabled: false,
  })

  assertEqual(
    adjustment,
    60,
    'rows fully above the viewport should preserve the reader anchor by their delta',
  )
})

runCase('scroll anchor does not change when the resized row is inside the viewport', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 200),
    createItem('row-3', 80),
  ]
  const layout = buildChatVirtualLayout(items, new Map())

  const adjustment = resolveChatScrollAnchorAdjustment({
    layout,
    itemIndex: 1,
    nextHeight: 260,
    scrollTop: 220,
    autoScrollEnabled: false,
  })

  assertEqual(
    adjustment,
    0,
    'rows intersecting the viewport should not force an anchor correction',
  )
})

runCase('scroll anchor does not shift while auto-scroll is enabled', () => {
  const items = [
    createItem('row-1', 100),
    createItem('row-2', 200),
    createItem('row-3', 80),
  ]
  const layout = buildChatVirtualLayout(items, new Map())

  const adjustment = resolveChatScrollAnchorAdjustment({
    layout,
    itemIndex: 0,
    nextHeight: 160,
    scrollTop: 220,
    autoScrollEnabled: true,
  })

  assertEqual(
    adjustment,
    0,
    'bottom-follow mode should defer to auto-scroll instead of applying anchor corrections',
  )
})

console.log('All chat virtual list extreme tests passed.')
