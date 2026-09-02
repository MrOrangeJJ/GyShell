import type { UiMessageGeometryIndex } from '@gyshell/shared'
import { ChatStore, type ChatMessage } from './ChatStore'

const SESSION_ID = 'geometry-store-session'
const ATOMIC_SESSION_ID = 'atomic-geometry-store-session'
const STALE_SESSION_ID = 'stale-geometry-store-session'
const MESSAGE_COUNT = 8_192
const UI_REVISION = 5

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const messageIdAt = (position: number): string => `geometry-message-${position}`

const createProjectedMessage = (position: number): ChatMessage => ({
  id: messageIdAt(position),
  backendMessageId: `backend-${position}`,
  role: position % 5 === 0 ? 'user' : 'assistant',
  type: 'text',
  content: `preview-${position}-${'p'.repeat(500)}`,
  timestamp: position + 1,
  streaming: false,
  deferredPayload: { fields: ['content'] },
})

const createFullMessage = (position: number): ChatMessage => ({
  id: messageIdAt(position),
  backendMessageId: `backend-${position}`,
  role: position % 5 === 0 ? 'user' : 'assistant',
  type: 'text',
  content: `full-${position}-${'x'.repeat(1_000_000)}`,
  timestamp: position + 1,
  streaming: false,
})

const createGeometryIndex = (
  sessionId: string,
  uiRevision: number,
): UiMessageGeometryIndex => ({
  sessionId,
  totalCount: MESSAGE_COUNT,
  uiRevision,
  entries: Array.from({ length: MESSAGE_COUNT }, (_, position) => ({
    position,
    id: messageIdAt(position),
    backendMessageId: `backend-${position}`,
    role: position % 5 === 0 ? ('user' as const) : ('assistant' as const),
    type: 'text' as const,
    timestamp: position + 1,
    streaming: false,
    geometry: {
      contentShape: {
        lineBuckets: [1_000, 1],
        blankLineCount: 0,
      },
    },
    projection: {
      content: `preview-${position}-${'p'.repeat(500)}`,
      deferredFields: ['content' as const],
    },
  })),
})

const createPage = (
  sessionId: string,
  request?: { limit?: number; aroundPosition?: number },
) => {
  const limit = Math.max(1, Math.min(1_000, Math.floor(request?.limit || 300)))
  const start =
    typeof request?.aroundPosition === 'number'
      ? Math.max(0, Math.floor(request.aroundPosition) - Math.floor(limit / 2))
      : Math.max(0, MESSAGE_COUNT - limit)
  const end = Math.min(MESSAGE_COUNT, start + limit)
  const entries = Array.from({ length: end - start }, (_, offset) => {
    const position = start + offset
    return { position, message: createProjectedMessage(position) }
  })
  return {
    sessionId,
    entries,
    totalCount: MESSAGE_COUNT,
    startPosition: entries[0]?.position ?? null,
    endPosition: entries.at(-1)?.position ?? null,
    hasOlder: start > 0,
    hasNewer: end < MESSAGE_COUNT,
    uiRevision: UI_REVISION,
    metadata: {
      id: sessionId,
      title: 'Geometry store session',
      updatedAt: 1,
      messagesCount: MESSAGE_COUNT,
      isBusy: false,
      lockedProfileId: null,
      uiRevision: UI_REVISION,
    },
  }
}

const run = async (): Promise<void> => {
  const previousWindow = (globalThis as any).window
  const pageRequests: Array<{
    sessionId: string
    limit?: number
    aroundPosition?: number
  }> = []
  const fullRequests: string[][] = []
  let resolveAtomicPage: ((value: ReturnType<typeof createPage>) => void) | null = null
  let resolveAtomicGeometry: ((value: UiMessageGeometryIndex) => void) | null = null
  let notifyAtomicPageRequested: (() => void) | null = null
  let notifyAtomicGeometryRequested: (() => void) | null = null
  const atomicPageRequested = new Promise<void>((resolve) => {
    notifyAtomicPageRequested = resolve
  })
  const atomicGeometryRequested = new Promise<void>((resolve) => {
    notifyAtomicGeometryRequested = resolve
  })

  ;(globalThis as any).window = {
    gyshell: {
      agent: {
        registerSession: async () => undefined,
        unregisterSession: async () => undefined,
        getSessionMetadata: async (sessionId: string) => ({
          id: sessionId,
          title: 'Geometry store session',
          updatedAt: 1,
          messagesCount: MESSAGE_COUNT,
          isBusy: false,
          lockedProfileId: null,
          uiRevision: UI_REVISION,
        }),
        getSessionSnapshot: async () => null,
        getUiMessages: async () => [],
        getUiMessagePage: async (
          sessionId: string,
          request?: { limit?: number; aroundPosition?: number },
        ) => {
          pageRequests.push({ sessionId, ...request })
          if (sessionId === ATOMIC_SESSION_ID) {
            notifyAtomicPageRequested?.()
            return await new Promise<ReturnType<typeof createPage>>((resolve) => {
              resolveAtomicPage = resolve
            })
          }
          if (typeof request?.aroundPosition === 'number') {
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          return createPage(sessionId, request)
        },
        getUiMessageGeometry: async (sessionId: string) => {
          if (sessionId === ATOMIC_SESSION_ID) {
            notifyAtomicGeometryRequested?.()
            return await new Promise<UiMessageGeometryIndex>((resolve) => {
              resolveAtomicGeometry = resolve
            })
          }
          return createGeometryIndex(
            sessionId,
            sessionId === STALE_SESSION_ID ? UI_REVISION - 1 : UI_REVISION,
          )
        },
        getFullUiMessages: async (
          sessionId: string,
          messageIds: string[],
        ) => {
          fullRequests.push([...messageIds])
          return {
            sessionId,
            messages: messageIds.map((id) =>
              createFullMessage(Number(id.replace('geometry-message-', ''))),
            ),
            uiRevision: UI_REVISION,
          }
        },
        loadChatRuntimeSession: async () => null,
        loadChatSession: async () => null,
        getAllChatHistory: async () => [],
      },
    },
  }

  try {
    const atomicStore = new ChatStore()
    atomicStore.ensureSession(ATOMIC_SESSION_ID)
    const atomicHydration = atomicStore.hydrateSessionFromBackend(
      ATOMIC_SESSION_ID,
      { activate: true, loadAgentContext: false },
    )
    await atomicPageRequested
    const atomicSession = atomicStore.getSessionById(ATOMIC_SESSION_ID)!
    assertEqual(
      atomicSession.isLoadingInitialHistory,
      true,
      'initial history should remain hidden while the page is pending',
    )
    ;(resolveAtomicPage as ((value: ReturnType<typeof createPage>) => void) | null)?.(
      createPage(ATOMIC_SESSION_ID),
    )
    await atomicGeometryRequested
    await new Promise((resolve) => setTimeout(resolve, 20))
    assertEqual(
      atomicSession.messageIds.length,
      0,
      'a resolved tail page must not become an intermediate visible transcript',
    )
    ;(resolveAtomicGeometry as ((value: UiMessageGeometryIndex) => void) | null)?.(
      createGeometryIndex(ATOMIC_SESSION_ID, UI_REVISION),
    )
    await atomicHydration
    assertEqual(
      atomicSession.messageIds.length,
      MESSAGE_COUNT,
      'the first committed transcript should contain the full geometry index',
    )
    assertEqual(
      atomicSession.geometryLoaded,
      true,
      'the atomic first commit should enter geometry mode',
    )
    assertEqual(
      atomicSession.isLoadingInitialHistory,
      false,
      'the transcript should become visible after the atomic commit',
    )
    console.log('PASS initial page and geometry hydrate atomically')

    const store = new ChatStore()
    store.ensureSession(SESSION_ID)
    await store.hydrateSessionFromBackend(SESSION_ID, {
      activate: true,
      loadAgentContext: false,
    })
    const session = store.getSessionById(SESSION_ID)
    assertCondition(session, 'geometry session should exist after hydration')
    assertEqual(session!.geometryLoaded, true, 'geometry mode should activate')
    assertEqual(
      session!.messageIds.length,
      MESSAGE_COUNT,
      'geometry mode should retain every message position',
    )
    assertEqual(
      session!.messagePositionById?.get(messageIdAt(MESSAGE_COUNT - 1)),
      MESSAGE_COUNT - 1,
      'the final message id should map to the final durable position',
    )

    const rangeRequestBaseline = pageRequests.length
    const [firstRange, overlappingRange] = await Promise.all([
      store.loadMessageRange(SESSION_ID, 600, 620),
      store.loadMessageRange(SESSION_ID, 610, 630),
    ])
    assertEqual(firstRange, true, 'the first geometry range should hydrate')
    assertEqual(
      overlappingRange,
      true,
      'an overlapping geometry range should share the same hydration',
    )
    const overlapRequests = pageRequests.slice(rangeRequestBaseline)
    assertEqual(
      overlapRequests.length,
      1,
      'overlapping ranges in one canonical chunk should issue one page request',
    )
    assertEqual(
      overlapRequests[0]?.aroundPosition,
      768,
      'the canonical 512-position chunk should use a stable center',
    )
    assertEqual(
      overlapRequests[0]?.limit,
      512,
      'the canonical chunk should request exactly 512 positions',
    )
    assertEqual(
      session!.messagesById.get(messageIdAt(600))?.payloadState,
      'page',
      'a hydrated range should hold bounded page payloads',
    )

    for (const chunkStart of [
      1_024,
      1_536,
      2_048,
      2_560,
      3_072,
      3_584,
      4_096,
      4_608,
    ]) {
      await store.loadMessageRange(
        SESSION_ID,
        chunkStart + 80,
        chunkStart + 100,
      )
    }
    assertEqual(
      session!.messagesById.get(messageIdAt(600))?.payloadState,
      'geometry',
      'the ninth newer chunk should evict old page payloads back to geometry',
    )
    assertEqual(
      session!.loadedPayloadPositions?.has(600),
      false,
      'evicted page positions should become eligible for future hydration',
    )

    const fullIds = Array.from({ length: 20 }, (_, offset) =>
      messageIdAt(4_600 + offset),
    )
    const fullRequestBaseline = fullRequests.length
    const fullLoad = store.loadFullMessages(SESSION_ID, fullIds)
    const overlappingFullLoad = store.loadFullMessages(
      SESSION_ID,
      fullIds.slice(10),
    )
    const [loadedFullMessages, overlappingFullMessages] = await Promise.all([
      fullLoad,
      overlappingFullLoad,
    ])
    const boundedFullRequests = fullRequests.slice(fullRequestBaseline)
    assertEqual(
      boundedFullRequests.length,
      2,
      'twenty full payloads should use exactly two sequential IPC batches',
    )
    assertEqual(
      boundedFullRequests[0]?.length,
      16,
      'the first full-payload IPC request should stay bounded to 16 messages',
    )
    assertEqual(
      boundedFullRequests[1]?.length,
      4,
      'the remaining full payloads should use one four-message batch',
    )
    assertEqual(
      loadedFullMessages.length,
      20,
      'the public loader should resolve every requested deferred message',
    )
    assertEqual(
      overlappingFullMessages.length,
      10,
      'an overlapping caller should share per-message in-flight promises',
    )
    const fullResidentCount = fullIds.filter(
      (id) => session!.messagesById.get(id)?.payloadState === 'full',
    ).length
    assertCondition(
      fullResidentCount >= 1 && fullResidentCount <= 8,
      `the character budget should retain a bounded full-payload working set, got ${fullResidentCount}`,
    )
    assertEqual(
      session!.messagesById.get(fullIds[0])?.payloadState,
      'geometry',
      'older oversized full payloads should fall back to geometry',
    )
    assertEqual(
      session!.messagesById.get(fullIds[15])?.payloadState,
      'full',
      'the newest visible oversized payload should remain available',
    )

    const previousMessageCount = session!.messageIds.length
    store.handleUiUpdate({
      type: 'REMOVE_MESSAGE',
      sessionId: SESSION_ID,
      messageId: messageIdAt(100),
      uiRevision: UI_REVISION + 1,
    })
    assertEqual(
      session!.messageIds.length,
      previousMessageCount - 1,
      'a geometry removal should delete one full-length position',
    )
    assertEqual(
      session!.totalMessageCount,
      previousMessageCount - 1,
      'a geometry removal should keep totalMessageCount exact',
    )
    assertEqual(
      session!.messagePositionById?.get(messageIdAt(MESSAGE_COUNT - 1)),
      MESSAGE_COUNT - 2,
      'position lookup should rebuild after a structural removal',
    )
    console.log('PASS geometry ranges deduplicate and payload residency stays bounded')

    const staleStore = new ChatStore()
    staleStore.ensureSession(STALE_SESSION_ID)
    await staleStore.hydrateSessionFromBackend(STALE_SESSION_ID, {
      activate: true,
      loadAgentContext: false,
    })
    const staleSession = staleStore.getSessionById(STALE_SESSION_ID)
    assertCondition(staleSession, 'stale geometry session should exist')
    assertEqual(
      staleSession!.geometryLoaded,
      false,
      'an older geometry revision must not replace a newer page baseline',
    )
    assertEqual(
      staleSession!.messageIds.length,
      300,
      'stale geometry should fall back to the established bounded page window',
    )
    console.log('PASS stale geometry falls back to paged history')
  } finally {
    ;(globalThis as any).window = previousWindow
  }
}

void run()
  .then(() => {
    console.log('All chat geometry store extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
