import { ChatStore, type ChatMessage } from './ChatStore'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const createAssistantMessage = (
  id: string,
  overrides?: Partial<ChatMessage>,
): ChatMessage => ({
  id,
  role: 'assistant',
  type: 'text',
  content: '',
  timestamp: 1,
  streaming: true,
  ...overrides,
})

const getActiveSessionOrThrow = (store: ChatStore) => {
  const session = store.activeSession
  assertCondition(session, 'expected an active session to exist')
  return session!
}

runCase('SESSION_RENAMED updates only an already-open session', () => {
  const store = new ChatStore()
  const session = getActiveSessionOrThrow(store)
  const sessionCount = store.sessions.length

  store.handleUiUpdate({
    type: 'SESSION_RENAMED',
    sessionId: session.id,
    title: 'Renamed Chat',
  })
  store.handleUiUpdate({
    type: 'SESSION_RENAMED',
    sessionId: 'closed-session',
    title: 'Must Stay Closed',
  })
  store.addMessage(
    {
      role: 'user',
      type: 'text',
      content: 'optimistic first prompt',
    },
    session.id,
  )

  assertEqual(
    session.title,
    'Renamed Chat',
    'optimistic first messages must preserve a manually renamed title',
  )
  assertEqual(
    store.sessions.length,
    sessionCount,
    'rename broadcasts must not materialize a closed session',
  )

  const broadcastStore = new ChatStore()
  const broadcastSession = getActiveSessionOrThrow(broadcastStore)
  broadcastStore.handleUiUpdate({
    type: 'SESSION_RENAMED',
    sessionId: broadcastSession.id,
    title: 'Broadcast Rename',
  })
  broadcastStore.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: broadcastSession.id,
    message: {
      id: 'first-user-message',
      role: 'user',
      type: 'text',
      content: 'backend first prompt',
      timestamp: 1,
    },
  })
  assertEqual(
    broadcastSession.title,
    'Broadcast Rename',
    'backend first-message updates must preserve a manually renamed title',
  )
})

runCase('ADD_MESSAGE increments renderListVersion for the active session', () => {
  const store = new ChatStore()
  const session = getActiveSessionOrThrow(store)
  const previousVersion = session.renderListVersion

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'hello' }),
  })

  assertEqual(
    session.renderListVersion,
    previousVersion + 1,
    'adding a visible row should invalidate the render list memo',
  )
})

runCase('APPEND_CONTENT keeps renderListVersion stable during streaming', () => {
  const store = new ChatStore()
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'a' }),
  })
  const versionAfterAdd = session.renderListVersion

  for (let index = 0; index < 32; index += 1) {
    store.handleUiUpdate({
      type: 'APPEND_CONTENT',
      sessionId: session.id,
      messageId: 'assistant-1',
      content: String(index),
    })
  }

  assertEqual(
    session.renderListVersion,
    versionAfterAdd,
    'stream deltas should not invalidate the structural render model',
  )
})

runCase('UPDATE_MESSAGE invalidates renderListVersion when streaming status changes', () => {
  const store = new ChatStore()
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'hello' }),
  })
  const versionAfterAdd = session.renderListVersion

  store.handleUiUpdate({
    type: 'UPDATE_MESSAGE',
    sessionId: session.id,
    messageId: 'assistant-1',
    patch: { streaming: false },
  })

  assertEqual(
    session.renderListVersion,
    versionAfterAdd + 1,
    'message update patches should invalidate the render model when row state changes',
  )
})

runCase('REMOVE_MESSAGE invalidates renderListVersion after deleting a visible row', () => {
  const store = new ChatStore()
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', { content: 'hello' }),
  })
  const versionAfterAdd = session.renderListVersion

  store.handleUiUpdate({
    type: 'REMOVE_MESSAGE',
    sessionId: session.id,
    messageId: 'assistant-1',
  })

  assertEqual(
    session.renderListVersion,
    versionAfterAdd + 1,
    'removing a row should invalidate render-driven memoized state',
  )
  assertEqual(
    session.messageIds.length,
    0,
    'removing a row should drop it from the visible message id list',
  )
})

runCase('ROLLBACK invalidates renderListVersion after pruning trailing messages', () => {
  const store = new ChatStore()
  const session = getActiveSessionOrThrow(store)

  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-1', {
      content: 'first',
      backendMessageId: 'backend-1',
      streaming: false,
    }),
  })
  store.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('assistant-2', {
      content: 'second',
      backendMessageId: 'backend-2',
      streaming: false,
    }),
  })
  const versionBeforeRollback = session.renderListVersion

  store.handleUiUpdate({
    type: 'ROLLBACK',
    sessionId: session.id,
    messageId: 'backend-2',
  })

  assertEqual(
    session.renderListVersion,
    versionBeforeRollback + 1,
    'rollback should invalidate the render model after dropping rows',
  )
  assertEqual(
    session.messageIds.length,
    1,
    'rollback should prune messages from the rollback target onward',
  )
})

runCase(
  'INSERT_MESSAGE places a compaction boundary before its backend anchor',
  () => {
    const store = new ChatStore()
    const session = getActiveSessionOrThrow(store)

    store.handleUiUpdate({
      type: 'ADD_MESSAGE',
      sessionId: session.id,
      message: createAssistantMessage('assistant-1', {
        content: 'first',
        backendMessageId: 'backend-assistant-1',
        streaming: false,
      }),
    })
    store.handleUiUpdate({
      type: 'ADD_MESSAGE',
      sessionId: session.id,
      message: createAssistantMessage('user-2', {
        role: 'user',
        type: 'text',
        content: 'second user',
        backendMessageId: 'backend-user-2',
        streaming: false,
      }),
    })

    store.handleUiUpdate({
      type: 'INSERT_MESSAGE',
      sessionId: session.id,
      message: createAssistantMessage('boundary-1', {
        role: 'system',
        type: 'compaction_boundary',
        content: '',
        backendMessageId: 'ui-boundary-1',
        streaming: false,
        metadata: {
          compactionBoundaryTargetBackendMessageId: 'backend-user-2',
          compactionBoundarySummaryBackendMessageId: 'backend-summary-1',
        },
      }),
      anchorBackendMessageId: 'backend-user-2',
      placement: 'before',
    })

    assertEqual(
      session.messageIds.join(','),
      'assistant-1,boundary-1,user-2',
      'insert action should place the boundary before its protected tail anchor',
    )
  },
)

runCase(
  'ROLLBACK removes compaction boundaries whose target anchor is cut',
  () => {
    const store = new ChatStore()
    const session = getActiveSessionOrThrow(store)

    store.handleUiUpdate({
      type: 'ADD_MESSAGE',
      sessionId: session.id,
      message: createAssistantMessage('assistant-1', {
        content: 'first',
        backendMessageId: 'backend-assistant-1',
        streaming: false,
      }),
    })
    store.handleUiUpdate({
      type: 'ADD_MESSAGE',
      sessionId: session.id,
      message: createAssistantMessage('user-2', {
        role: 'user',
        type: 'text',
        content: 'second user',
        backendMessageId: 'backend-user-2',
        streaming: false,
      }),
    })
    store.handleUiUpdate({
      type: 'INSERT_MESSAGE',
      sessionId: session.id,
      message: createAssistantMessage('boundary-1', {
        role: 'system',
        type: 'compaction_boundary',
        content: '',
        backendMessageId: 'ui-boundary-1',
        streaming: false,
        metadata: {
          compactionBoundaryTargetBackendMessageId: 'backend-user-2',
        },
      }),
      anchorBackendMessageId: 'backend-user-2',
      placement: 'before',
    })
    const versionBeforeRollback = session.renderListVersion

    store.handleUiUpdate({
      type: 'ROLLBACK',
      sessionId: session.id,
      messageId: 'backend-user-2',
    })

    assertEqual(
      session.messageIds.join(','),
      'assistant-1',
      'rollback should drop the boundary after its target is removed',
    )
    assertEqual(
      session.renderListVersion,
      versionBeforeRollback + 1,
      'rollback cleanup should invalidate the render model once',
    )
  },
)

runCase('INSERT_MESSAGE ignores missing anchors instead of appending', () => {
  const store = new ChatStore()
  const session = getActiveSessionOrThrow(store)
  const previousVersion = session.renderListVersion

  store.handleUiUpdate({
    type: 'INSERT_MESSAGE',
    sessionId: session.id,
    message: createAssistantMessage('boundary-1', {
      role: 'system',
      type: 'compaction_boundary',
      content: '',
      backendMessageId: 'ui-boundary-1',
      streaming: false,
      metadata: {
        compactionBoundaryTargetBackendMessageId: 'missing-backend-user',
      },
    }),
    anchorBackendMessageId: 'missing-backend-user',
    placement: 'before',
  })

  assertEqual(
    session.messageIds.length,
    0,
    'missing insert anchor should not add a misplaced boundary',
  )
  assertEqual(
    session.renderListVersion,
    previousVersion,
    'missing insert anchor should not invalidate rendering',
  )
})

const runAsyncCases = async (): Promise<void> => {
  const previousWindow = (globalThis as any).window
  const registeredSessionIds: string[] = []
  const unregisteredSessionIds: string[] = []
  const renamedSessionIds: string[] = []
  const backendOwnedSessionIds = new Set<string>()
  let registrationFailuresRemaining = 0
  let deferNextRegistration = false
  let rejectDeferredRegistration: ((error: Error) => void) | null = null
  ;(globalThis as any).window = {
    gyshell: {
      agent: {
        registerSession: async (sessionId: string) => {
          registeredSessionIds.push(sessionId)
          if (deferNextRegistration) {
            deferNextRegistration = false
            await new Promise<void>((_resolve, reject) => {
              rejectDeferredRegistration = reject
            })
          }
          if (registrationFailuresRemaining > 0) {
            registrationFailuresRemaining -= 1
            throw new Error('IPC handler not ready')
          }
          backendOwnedSessionIds.add(sessionId)
        },
        unregisterSession: async (sessionId: string) => {
          unregisteredSessionIds.push(sessionId)
          backendOwnedSessionIds.delete(sessionId)
        },
        renameSession: async (sessionId: string) => {
          if (!backendOwnedSessionIds.has(sessionId)) {
            throw new Error('backend owner missing')
          }
          renamedSessionIds.push(sessionId)
        },
        getAllChatHistory: async () => [],
        getUiMessages: async () => [],
        getSessionSnapshot: async () => null,
        loadChatSession: async () => null,
      },
    },
  }

  try {
    const store = new ChatStore()
    const initialSessionId = getActiveSessionOrThrow(store).id
    const transferredSessionId = 'transferred-empty-session'
    store.ensureSession(transferredSessionId)
    store.ensureSession(transferredSessionId)
    store.unregisterSessionOwnership(transferredSessionId)
    store.registerSessionOwnership(transferredSessionId)
    await store.renameChatSession(transferredSessionId, 'Transferred Chat')

    assertEqual(
      registeredSessionIds.filter((id) => id === transferredSessionId).length,
      2,
      'target materialization should acquire once and reacquire once after release',
    )
    assertEqual(
      unregisteredSessionIds.filter((id) => id === transferredSessionId).length,
      1,
      'source suppression should release only its renderer ownership',
    )
    assertCondition(
      renamedSessionIds.includes(transferredSessionId),
      'rename should wait for the latest ownership operation',
    )

    store.hydrateSessionInventoryFromLayout(['stale-layout-session'])
    await store.hydrateSessionsFromBackend(['stale-layout-session'])

    const fallbackSessionId = getActiveSessionOrThrow(store).id
    assertCondition(
      fallbackSessionId !== 'stale-layout-session',
      'stale persisted ids should be replaced with a fresh local session',
    )
    assertCondition(
      registeredSessionIds.includes(fallbackSessionId),
      'replacement New Chat should register before it can be renamed',
    )
    assertCondition(
      unregisteredSessionIds.includes(initialSessionId),
      'discarded constructor session should release its backend registration',
    )
    assertCondition(
      unregisteredSessionIds.includes('stale-layout-session'),
      'backend hydration should release invalid layout session registrations',
    )
    console.log('PASS hydration registers replacement empty chat sessions')

    registrationFailuresRemaining = 1
    const retryStore = new ChatStore()
    const retrySessionId = getActiveSessionOrThrow(retryStore).id
    await retryStore.renameChatSession(retrySessionId, 'Rename after startup')

    assertEqual(
      registeredSessionIds.filter((id) => id === retrySessionId).length,
      2,
      'rename should retry an in-flight constructor registration that fails before IPC is ready',
    )
    assertCondition(
      renamedSessionIds.includes(retrySessionId),
      'successful retry should allow the empty startup session to be renamed',
    )
    console.log('PASS failed startup session registration retries on rename')

    deferNextRegistration = true
    const churnStore = new ChatStore()
    const churnSessionId = getActiveSessionOrThrow(churnStore).id
    const churnRename = churnStore.renameChatSession(
      churnSessionId,
      'Rename during ownership churn',
    )
    churnStore.unregisterSessionOwnership(churnSessionId)
    churnStore.registerSessionOwnership(churnSessionId)
    await Promise.resolve()
    assertCondition(
      rejectDeferredRegistration,
      'first registration should remain pending while ownership changes',
    )
    rejectDeferredRegistration!(new Error('IPC handler restarted'))
    await churnRename

    assertEqual(
      registeredSessionIds.filter((id) => id === churnSessionId).length,
      2,
      'rename should wait for the newer registration queued during ownership churn',
    )
    assertCondition(
      renamedSessionIds.includes(churnSessionId),
      'rename should run only after the latest backend ownership is established',
    )
    console.log('PASS rename waits for stable ownership registration')
  } finally {
    ;(globalThis as any).window = previousWindow
  }
}

void runAsyncCases()
  .then(() => {
    console.log('All ChatStore extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
