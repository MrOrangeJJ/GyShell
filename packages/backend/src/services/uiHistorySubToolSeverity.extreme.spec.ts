import { UIHistoryService } from './UIHistoryService'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const sessions = new Map<string, any>()
const history = new UIHistoryService({
  store: {
    listUiSessionSummaries: () => [],
    listUiSessions: () => [...sessions.values()],
    loadUiSession: (sessionId: string) => sessions.get(sessionId) || null,
    saveUiSessions: (
      entries: Array<{ session: { id: string }; summary: unknown }>,
    ) => {
      entries.forEach((entry) => sessions.set(entry.session.id, entry.session))
    },
    deleteUiSessions: () => {},
  } as any,
})

history.recordEvent('session-1', {
  type: 'sub_tool_started',
  messageId: 'sub-tool-1',
  title: 'Create terminal tab',
})
history.recordEvent('session-1', {
  type: 'sub_tool_delta',
  messageId: 'sub-tool-1',
  outputDelta: 'Failed to create terminal tab: connection refused',
})
const actions = history.recordEvent('session-1', {
  type: 'sub_tool_finished',
  messageId: 'sub-tool-1',
  level: 'error',
})

const message = history.getSession('session-1')?.messages[0]
const updateAction = actions.find((action) => action.type === 'UPDATE_MESSAGE')
assertEqual(
  message?.metadata?.subToolLevel,
  'error',
  'finished sub-tool severity should update retained history metadata',
)
assertEqual(
  message?.streaming,
  false,
  'finished sub-tool activity should stop streaming',
)
assertEqual(
  updateAction?.type === 'UPDATE_MESSAGE'
    ? updateAction.patch.metadata?.subToolLevel
    : undefined,
  'error',
  'renderer update should carry the final sub-tool severity',
)

console.log('PASS UI history preserves final sub-tool severity')
