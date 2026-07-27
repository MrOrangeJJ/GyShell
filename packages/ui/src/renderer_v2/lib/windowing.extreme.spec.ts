import type {
  WindowingMessage,
  WindowingDragStartMessage,
  WindowingDragEndMessage,
  WindowingPanelMovedMessage,
  WindowingTabMovedMessage
} from './windowing'
import {
  buildDetachedLayoutTree,
  collectLayoutTabOwnership,
  clearTabDragState,
  clearPanelDragState,
  createWindowingChannel,
  openDetachedWindowState,
  readPanelDragState,
  readTabDragState,
  readDetachedWindowState,
  syncDetachedWindowState,
  stashDetachedWindowState,
  stashTabDragState,
  stashPanelDragState,
  WINDOWING_STORAGE_CHANNEL_KEY
} from './windowing'
import type { LayoutTree, PanelKind } from '../layout'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

// ---------------------------------------------------------------------------
// WindowingDragStartMessage type checks
// ---------------------------------------------------------------------------

runCase('drag-start message with tab payload is valid WindowingMessage', () => {
  const msg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: 'win-abc',
    dragKind: 'tab',
    tabPayload: {
      sourceClientId: 'win-abc',
      tabId: 'tab-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-1'
    }
  }
  const asMessage: WindowingMessage = msg
  assertEqual(asMessage.type, 'drag-start', 'drag-start should be a valid WindowingMessage type')
  assertCondition(msg.tabPayload, 'tabPayload should be present')
  assertEqual(msg.tabPayload!.tabId, 'tab-1', 'tabPayload.tabId should match')
  assertEqual(msg.tabPayload!.kind, 'terminal', 'tabPayload.kind should match')
})

runCase('drag-start message with panel payload is valid WindowingMessage', () => {
  const msg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: 'win-abc',
    dragKind: 'panel',
    panelPayload: {
      sourceClientId: 'win-abc',
      sourcePanelId: 'panel-chat-1',
      kind: 'chat',
      tabBinding: {
        tabIds: ['chat-1', 'chat-2'],
        activeTabId: 'chat-2'
      }
    }
  }
  const asMessage: WindowingMessage = msg
  assertEqual(asMessage.type, 'drag-start', 'panel drag-start should be a valid WindowingMessage type')
  assertCondition(msg.panelPayload, 'panelPayload should be present')
  assertEqual(msg.panelPayload!.sourcePanelId, 'panel-chat-1', 'panelPayload.sourcePanelId should match')
  assertEqual(msg.panelPayload!.kind, 'chat', 'panelPayload.kind should match')
})

runCase('drag-end message is valid WindowingMessage', () => {
  const msg: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: 'win-123'
  }
  const asMessage: WindowingMessage = msg
  assertEqual(asMessage.type, 'drag-end', 'drag-end should be a valid WindowingMessage type')
  assertEqual(msg.sourceClientId, 'win-123', 'sourceClientId should match')
})

runCase('stashed panel drag state round-trips through localStorage by token', () => {
  const originalWindow = (globalThis as any).window
  const storage = new Map<string, string>()

  ;(globalThis as any).window = {
    localStorage: {
      getItem(key: string) {
        return storage.has(key) ? storage.get(key)! : null
      },
      setItem(key: string, value: string) {
        storage.set(key, value)
      },
      removeItem(key: string) {
        storage.delete(key)
      }
    }
  }

  try {
    const token = 'panel-drag-token'
    const payload = {
      sourceClientId: 'win-abc',
      sourcePanelId: 'panel-chat-1',
      kind: 'chat' as const,
      tabBinding: {
        tabIds: ['chat-1', 'chat-2'],
        activeTabId: 'chat-2'
      }
    }

    assertEqual(stashPanelDragState(token, payload), true, 'panel drag state should be stashed')
    assertDeepEqual(readPanelDragState(token), payload, 'panel drag state should be restored intact')
    clearPanelDragState(token)
    assertEqual(readPanelDragState(token), null, 'cleared panel drag state should not be readable')
  } finally {
    ;(globalThis as any).window = originalWindow
  }
})

runCase('stashed tab drag state round-trips through localStorage by token', () => {
  const originalWindow = (globalThis as any).window
  const storage = new Map<string, string>()

  ;(globalThis as any).window = {
    localStorage: {
      getItem(key: string) {
        return storage.has(key) ? storage.get(key)! : null
      },
      setItem(key: string, value: string) {
        storage.set(key, value)
      },
      removeItem(key: string) {
        storage.delete(key)
      }
    }
  }

  try {
    const token = 'tab-drag-token'
    const payload = {
      sourceClientId: 'win-abc',
      tabId: 'term-1',
      sourcePanelId: 'panel-term-1',
      kind: 'terminal' as const,
      terminalTab: {
        id: 'term-1',
        title: 'LOCAL',
        config: {
          type: 'local' as const,
          id: 'term-1',
          title: 'LOCAL',
          cols: 80,
          rows: 24
        }
      }
    }

    assertEqual(stashTabDragState(token, payload), true, 'tab drag state should be stashed')
    assertDeepEqual(readTabDragState(token), payload, 'tab drag state should be restored intact')
    clearTabDragState(token)
    assertEqual(readTabDragState(token), null, 'cleared tab drag state should not be readable')
  } finally {
    ;(globalThis as any).window = originalWindow
  }
})

runCase('detached window state survives repeated reads for renderer reloads', () => {
  const originalWindow = (globalThis as any).window
  const localStorageState = new Map<string, string>()
  const sessionStorageState = new Map<string, string>()

  const createStorage = (state: Map<string, string>) => ({
    getItem(key: string) {
      return state.has(key) ? state.get(key)! : null
    },
    setItem(key: string, value: string) {
      state.set(key, value)
    },
    removeItem(key: string) {
      state.delete(key)
    }
  })

  ;(globalThis as any).window = {
    localStorage: createStorage(localStorageState),
    sessionStorage: createStorage(sessionStorageState)
  }

  try {
    const token = 'detached-state-token'
    const detachedState = {
      sourceClientId: 'win-main',
      layoutTree: {
        schemaVersion: 2,
        root: { type: 'panel' as const, id: 'node-term', panel: { id: 'panel-term', kind: 'terminal' as const } },
        focusedPanelId: 'panel-term'
      } as LayoutTree,
      createdAt: 123,
      terminalTabs: [
        {
          id: 'ssh-detached',
          title: 'Deploy Host',
          config: {
            type: 'ssh' as const,
            id: 'ssh-detached',
            title: 'Deploy Host',
            cols: 120,
            rows: 32,
            host: 'deploy.example.test',
            port: 22,
            username: 'deploy',
            authMethod: 'password' as const
          },
          connectionRef: { type: 'ssh', entryId: 'ssh-entry' },
          runtimeState: 'initializing' as const
        }
      ]
    }

    assertEqual(stashDetachedWindowState(token, detachedState), true, 'detached state should be stashed')
    assertDeepEqual(readDetachedWindowState(token), detachedState, 'first detached state read should succeed')
    assertCondition(
      !localStorageState.has(`gyshell.detachedState.${token}`),
      'first detached state read should clear the persistent localStorage blob'
    )
    assertDeepEqual(readDetachedWindowState(token), detachedState, 'second detached state read should still succeed after reload')

    const refreshedState = {
      ...detachedState,
      createdAt: 456,
      layoutTree: {
        schemaVersion: 2,
        root: { type: 'panel' as const, id: 'node-chat', panel: { id: 'panel-chat', kind: 'chat' as const } },
        focusedPanelId: 'panel-chat'
      } as LayoutTree
    }
    assertEqual(syncDetachedWindowState(token, refreshedState), true, 'detached state refresh should update session snapshot')
    assertDeepEqual(readDetachedWindowState(token), refreshedState, 'later reads should pick refreshed detached session snapshot')
  } finally {
    ;(globalThis as any).window = originalWindow
  }
})

runCase('buildDetachedLayoutTree creates a single-panel detached layout with optional tab binding', () => {
  const tree = buildDetachedLayoutTree('terminal', {
    tabIds: ['term-a', 'term-b'],
    activeTabId: 'term-b'
  })

  assertEqual(tree.schemaVersion, 2, 'detached layout tree should use schema version 2')
  assertCondition(tree.root.type === 'panel', 'detached layout root should be a single panel')
  if (tree.root.type !== 'panel') {
    throw new Error('detached layout root should be a panel')
  }
  assertEqual(tree.root.panel.kind, 'terminal', 'detached layout panel kind should match')
  assertCondition(Boolean(tree.focusedPanelId), 'detached layout should focus its only panel')
  assertCondition(Boolean(tree.panelTabs?.[tree.root.panel.id]), 'detached layout should persist tab bindings')
  assertDeepEqual(
    tree.panelTabs?.[tree.root.panel.id],
    {
      tabIds: ['term-a', 'term-b'],
      activeTabId: 'term-b'
    },
    'detached layout should preserve the provided tab binding'
  )
})

runCase('file protocol falls back to storage-backed windowing channel', () => {
  const originalWindow = (globalThis as any).window
  const originalBroadcastChannel = (globalThis as any).BroadcastChannel
  const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>()
  const writes: Array<{ key: string; value: string | null }> = []
  let broadcastChannelConstructed = 0

  ;(globalThis as any).window = {
    location: { protocol: 'file:' },
    localStorage: {
      removeItem(key: string) {
        writes.push({ key, value: null })
      },
      setItem(key: string, value: string) {
        writes.push({ key, value })
      }
    },
    addEventListener(type: string, listener: (event: { key: string | null; newValue: string | null }) => void) {
      if (type === 'storage') {
        listeners.add(listener)
      }
    },
    removeEventListener(type: string, listener: (event: { key: string | null; newValue: string | null }) => void) {
      if (type === 'storage') {
        listeners.delete(listener)
      }
    }
  }
  ;(globalThis as any).BroadcastChannel = class {
    constructor() {
      broadcastChannelConstructed += 1
    }
  }

  try {
    const channel = createWindowingChannel()
    assertCondition(channel !== null, 'storage-backed channel should be created')
    assertEqual(broadcastChannelConstructed, 0, 'file protocol should not construct BroadcastChannel')

    let received: WindowingMessage | null = null
    channel!.onmessage = (event) => {
      received = event.data
    }

    const outboundMessage: WindowingDragEndMessage = {
      type: 'drag-end',
      sourceClientId: 'win-source'
    }
    channel!.postMessage(outboundMessage)
    assertDeepEqual(
      writes,
      [
        { key: WINDOWING_STORAGE_CHANNEL_KEY, value: null },
        { key: WINDOWING_STORAGE_CHANNEL_KEY, value: JSON.stringify(outboundMessage) }
      ],
      'storage-backed channel should write serialized payload via localStorage'
    )

    const inboundMessage: WindowingDragEndMessage = {
      type: 'drag-end',
      sourceClientId: 'win-target'
    }
    listeners.forEach((listener) => {
      listener({
        key: WINDOWING_STORAGE_CHANNEL_KEY,
        newValue: JSON.stringify(inboundMessage)
      })
    })
    assertDeepEqual(received, inboundMessage, 'storage event should deliver payload to onmessage')

    channel!.close()
    assertEqual(listeners.size, 0, 'closing the channel should remove the storage listener')
  } finally {
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).BroadcastChannel = originalBroadcastChannel
  }
})

// ---------------------------------------------------------------------------
// Cross-window drag message coordination protocol validation
// ---------------------------------------------------------------------------

runCase('drag-start and drag-end form a valid lifecycle', () => {
  const clientId = 'win-source'
  const startMsg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: clientId,
    dragKind: 'tab',
    tabPayload: {
      sourceClientId: clientId,
      tabId: 'term-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-1'
    }
  }
  const endMsg: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: clientId
  }

  // Simulate cross-window drag ref tracking
  let crossWindowDrag: WindowingDragStartMessage | null = null

  // Source window sends drag-start
  crossWindowDrag = startMsg
  assertCondition(crossWindowDrag !== null, 'cross-window drag should be set after drag-start')
  assertEqual(crossWindowDrag!.sourceClientId, clientId, 'source client should match')

  // Source window sends drag-end
  if (crossWindowDrag?.sourceClientId === endMsg.sourceClientId) {
    crossWindowDrag = null
  }
  assertEqual(crossWindowDrag, null, 'cross-window drag should be cleared after drag-end')
})

runCase('drag-start from same window should be ignored by receiver', () => {
  const localClientId = 'win-local'
  const msg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: localClientId,
    dragKind: 'tab',
    tabPayload: {
      sourceClientId: localClientId,
      tabId: 'tab-1',
      kind: 'chat',
      sourcePanelId: 'panel-chat-1'
    }
  }

  // Receiver logic: ignore if sourceClientId matches local clientId
  const shouldAccept = msg.sourceClientId !== localClientId
  assertEqual(shouldAccept, false, 'drag-start from same window should be ignored')
})

runCase('drag-start from different window should be accepted by receiver', () => {
  const localClientId = 'win-local'
  const msg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: 'win-remote',
    dragKind: 'tab',
    tabPayload: {
      sourceClientId: 'win-remote',
      tabId: 'tab-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-1'
    }
  }

  const shouldAccept = msg.sourceClientId !== localClientId
  assertEqual(shouldAccept, true, 'drag-start from different window should be accepted')
})

// ---------------------------------------------------------------------------
// PanelKind validation in drag payloads
// ---------------------------------------------------------------------------

runCase('all panel kinds are valid in tab drag payload', () => {
  const kinds: PanelKind[] = ['chat', 'terminal', 'filesystem', 'fileEditor', 'monitor', 'listPanel']
  kinds.forEach((kind) => {
    const msg: WindowingDragStartMessage = {
      type: 'drag-start',
      sourceClientId: 'win-1',
      dragKind: 'tab',
      tabPayload: {
        sourceClientId: 'win-1',
        tabId: `tab-${kind}`,
        kind,
        sourcePanelId: `panel-${kind}`
      }
    }
    assertEqual(msg.tabPayload!.kind, kind, `kind ${kind} should be accepted in tab drag payload`)
  })
})

// ---------------------------------------------------------------------------
// Tab-moved integration with drag protocol
// ---------------------------------------------------------------------------

runCase('tab-moved message completes cross-window tab drag lifecycle', () => {
  const sourceClientId = 'win-source'
  const targetClientId = 'win-target'

  // Step 1: drag-start broadcast from source
  const dragStart: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId,
    dragKind: 'tab',
    tabPayload: {
      sourceClientId,
      tabId: 'term-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-src'
    }
  }

  // Step 2: target window receives drag, accepts drop, sends tab-moved
  const tabMoved: WindowingTabMovedMessage = {
    type: 'tab-moved',
    sourceClientId,
    targetClientId,
    kind: 'terminal',
    tabId: 'term-1'
  }

  // Step 3: source receives tab-moved and cleans up
  assertEqual(tabMoved.sourceClientId, sourceClientId, 'tab-moved sourceClientId should match drag source')
  assertEqual(tabMoved.tabId, dragStart.tabPayload!.tabId, 'tab-moved tabId should match dragged tab')
  assertEqual(tabMoved.kind, dragStart.tabPayload!.kind, 'tab-moved kind should match dragged tab kind')
})

runCase('panel-moved message is valid WindowingMessage', () => {
  const msg: WindowingPanelMovedMessage = {
    type: 'panel-moved',
    sourceClientId: 'win-source',
    targetClientId: 'win-target',
    sourcePanelId: 'panel-terminal-1',
    kind: 'terminal',
    tabIds: ['term-1', 'term-2']
  }
  const asMessage: WindowingMessage = msg
  assertEqual(asMessage.type, 'panel-moved', 'panel-moved should be a valid WindowingMessage type')
  assertEqual(msg.sourcePanelId, 'panel-terminal-1', 'panel-moved sourcePanelId should match')
  assertEqual(msg.tabIds.length, 2, 'panel-moved tabIds should be preserved')
})

runCase('detached ownership is derived from exact panel-kind bindings', () => {
  const tree: LayoutTree = {
    schemaVersion: 2,
    root: {
      type: 'split',
      id: 'root-ownership',
      direction: 'horizontal',
      children: [
        {
          type: 'panel',
          id: 'node-terminal',
          panel: { id: 'panel-terminal', kind: 'terminal' }
        },
        {
          type: 'panel',
          id: 'node-filesystem',
          panel: { id: 'panel-filesystem', kind: 'filesystem' }
        }
      ],
      sizes: [50, 50]
    },
    panelTabs: {
      'panel-terminal': {
        tabIds: ['term-a', 'term-a', 'term-b'],
        activeTabId: 'term-a'
      },
      'panel-filesystem': {
        tabIds: ['term-b'],
        activeTabId: 'term-b'
      }
    }
  }

  assertDeepEqual(
    collectLayoutTabOwnership(tree),
    {
      chat: [],
      terminal: ['term-a', 'term-b'],
      filesystem: ['term-b'],
      monitor: []
    },
    'main-process ownership should track exact hosted kinds and normalize duplicates'
  )
})

await (async () => {
  const originalWindow = (globalThis as any).window
  const localStorageState = new Map<string, string>()
  let receivedOptions: unknown = null
  const storage = {
    getItem(key: string) {
      return localStorageState.get(key) ?? null
    },
    setItem(key: string, value: string) {
      localStorageState.set(key, value)
    },
    removeItem(key: string) {
      localStorageState.delete(key)
    }
  }
  ;(globalThis as any).window = {
    localStorage: storage,
    sessionStorage: storage,
    gyshell: {
      windowing: {
        openDetached: async (
          _token: string,
          _sourceClientId: string,
          options: unknown
        ) => {
          receivedOptions = options
          return { ok: true, reused: true }
        }
      }
    }
  }

  try {
    const opened = await openDetachedWindowState(
      {
        sourceClientId: 'win-main',
        layoutTree: buildDetachedLayoutTree('terminal', {
          tabIds: ['term-a'],
          activeTabId: 'term-a'
        }),
        createdAt: 123
      },
      {
        focusTarget: {
          kind: 'terminal',
          tabId: 'term-a'
        }
      }
    )

    assertEqual(opened, true, 'reusing a detached window should count as a successful open')
    assertDeepEqual(
      receivedOptions,
      {
        tabOwnership: {
          chat: [],
          terminal: ['term-a'],
          filesystem: [],
          monitor: []
        },
        focusTarget: {
          kind: 'terminal',
          tabId: 'term-a'
        }
      },
      'open request should atomically register ownership and the tab to activate'
    )
    assertEqual(
      localStorageState.size,
      0,
      'a reused window should discard the unused detached bootstrap payload'
    )
    console.log('PASS repeated detached open reuses ownership and clears unused state')
  } finally {
    ;(globalThis as any).window = originalWindow
  }
})()

// ---------------------------------------------------------------------------
// Drag-end clears only matching source
// ---------------------------------------------------------------------------

runCase('drag-end only clears matching source client', () => {
  let crossWindowDrag: WindowingDragStartMessage | null = {
    type: 'drag-start',
    sourceClientId: 'win-A',
    dragKind: 'tab',
    tabPayload: { sourceClientId: 'win-A', tabId: 't1', kind: 'terminal', sourcePanelId: 'p1' }
  }

  // drag-end from a DIFFERENT source should NOT clear
  const endFromOther: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: 'win-B'
  }
  if (crossWindowDrag?.sourceClientId === endFromOther.sourceClientId) {
    crossWindowDrag = null
  }
  assertCondition(crossWindowDrag !== null, 'drag-end from different source should not clear ref')

  // drag-end from matching source SHOULD clear
  const endFromSame: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: 'win-A'
  }
  if (crossWindowDrag?.sourceClientId === endFromSame.sourceClientId) {
    crossWindowDrag = null
  }
  assertEqual(crossWindowDrag, null, 'drag-end from matching source should clear ref')
})

console.log('All windowing cross-window drag extreme tests passed.')
