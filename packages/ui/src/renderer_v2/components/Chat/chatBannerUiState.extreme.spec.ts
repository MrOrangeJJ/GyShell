import {
  getChatBannerUiStateKey,
  mergeChatBannerUiState,
  pruneChatBannerUiStateForSession,
  type ChatBannerUiStateMap,
} from './chatBannerUiState'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

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

runCase('state keys require both session and message identifiers', () => {
  assertEqual(
    getChatBannerUiStateKey('', 'message-1'),
    null,
    'missing session id should not produce a state key',
  )
  assertEqual(
    getChatBannerUiStateKey('session-1', ''),
    null,
    'missing message id should not produce a state key',
  )
  assertEqual(
    getChatBannerUiStateKey('session-1', 'message-1'),
    'session-1::message-1',
    'valid identifiers should compose into a stable key',
  )
})

runCase('partial merges preserve existing state fields for the same banner row', () => {
  const initialState: ChatBannerUiStateMap = {
    'session-1::message-1': {
      expanded: true,
      expandedStepIds: ['step-1'],
      expandedDetailIds: ['step-1:output'],
    },
  }

  const nextState = mergeChatBannerUiState(
    initialState,
    'session-1::message-1',
    { showDetails: true, isSkipping: true },
  )

  assertCondition(
    nextState !== initialState,
    'state merges with new data should produce a new map object',
  )
  assertEqual(
    nextState['session-1::message-1']?.expanded,
    true,
    'merging showDetails should preserve existing expanded state',
  )
  assertEqual(
    nextState['session-1::message-1']?.expandedStepIds?.[0],
    'step-1',
    'merging unrelated fields should preserve expanded step ids',
  )
  assertEqual(
    nextState['session-1::message-1']?.expandedDetailIds?.[0],
    'step-1:output',
    'merging unrelated fields should preserve expanded detail ids',
  )
  assertEqual(
    nextState['session-1::message-1']?.showDetails,
    true,
    'merged state should store the new details flag',
  )
  assertEqual(
    nextState['session-1::message-1']?.isSkipping,
    true,
    'merged state should store the in-flight skip-wait flag',
  )
})

runCase('no-op merges keep the same object identity on hot paths', () => {
  const initialState: ChatBannerUiStateMap = {
    'session-1::message-1': {
      expanded: false,
      expandedStepIds: ['step-1'],
      expandedDetailIds: [],
      showDetails: true,
      isSkipping: true,
    },
  }

  const nextState = mergeChatBannerUiState(
    initialState,
    'session-1::message-1',
    {
      expanded: false,
      expandedStepIds: ['step-1'],
      expandedDetailIds: [],
      isSkipping: true,
    },
  )

  assertCondition(
    nextState === initialState,
    'reapplying the same patch should avoid unnecessary state churn',
  )
})

runCase('pruning a session only removes stale rows for that session', () => {
  const initialState: ChatBannerUiStateMap = {
    'session-1::message-1': { expanded: true },
    'session-1::message-2': { expanded: false },
    'session-2::message-1': { showDetails: true },
  }

  const nextState = pruneChatBannerUiStateForSession(
    initialState,
    'session-1',
    ['message-2', 'message-3'],
  )

  assertCondition(
    !('session-1::message-1' in nextState),
    'removed rows from the active session should be pruned',
  )
  assertCondition(
    'session-1::message-2' in nextState,
    'still-visible rows from the active session must be preserved',
  )
  assertCondition(
    'session-2::message-1' in nextState,
    'rows from other sessions must not be pruned accidentally',
  )
})

runCase('pruning with an unchanged valid set preserves map identity', () => {
  const initialState: ChatBannerUiStateMap = {
    'session-1::message-1': { expanded: true },
    'session-2::message-9': { showDetails: true },
  }

  const nextState = pruneChatBannerUiStateForSession(
    initialState,
    'session-1',
    ['message-1'],
  )

  assertCondition(
    nextState === initialState,
    'unchanged pruning passes should not allocate a new map',
  )
})

runCase('repeated updates stay isolated across many sessions and rows', () => {
  let state: ChatBannerUiStateMap = {}

  for (let sessionIndex = 0; sessionIndex < 32; sessionIndex += 1) {
    for (let messageIndex = 0; messageIndex < 64; messageIndex += 1) {
      const key = getChatBannerUiStateKey(
        `session-${sessionIndex}`,
        `message-${messageIndex}`,
      )
      state = mergeChatBannerUiState(state, key, {
        expanded: messageIndex % 2 === 0,
      })
    }
  }

  assertEqual(
    Object.keys(state).length,
    32 * 64,
    'large update batches should retain a state entry per unique row',
  )
  assertEqual(
    state['session-18::message-6']?.expanded,
    true,
    'even-indexed rows should keep their assigned expanded flag',
  )
  assertEqual(
    state['session-18::message-7']?.expanded,
    false,
    'odd-indexed rows should keep their assigned collapsed flag',
  )
})

console.log('All chat banner UI state extreme tests passed.')
