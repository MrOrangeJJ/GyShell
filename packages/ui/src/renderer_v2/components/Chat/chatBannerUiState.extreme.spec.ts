import {
  getChatBannerUiStateKey,
  mergeChatBannerUiState,
  parseChatBannerUiStateKey,
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

const requireKey = (sessionId: string, messageId: string): string => {
  const key = getChatBannerUiStateKey(sessionId, messageId)
  if (!key) throw new Error('expected identifiers to produce a state key')
  return key
}

runCase('state keys require exact well-formed string identifiers', () => {
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
    getChatBannerUiStateKey(17 as unknown as string, 'message-1'),
    null,
    'non-string session ids must not be coerced',
  )
  assertEqual(
    getChatBannerUiStateKey('session-1', '\ud800'),
    null,
    'lone UTF-16 surrogates must fail before key serialization',
  )

  const key = requireKey('  session-1  ', '  message-1  ')
  const parsed = parseChatBannerUiStateKey(key)
  assertEqual(
    parsed?.sessionId,
    '  session-1  ',
    'legal session whitespace must remain part of the identity',
  )
  assertEqual(
    parsed?.messageId,
    '  message-1  ',
    'legal message whitespace must remain part of the identity',
  )
})

runCase('pair encoding is delimiter-safe and round trips Unicode', () => {
  const delimiterInSession = requireKey('session::alpha', 'message')
  const delimiterInMessage = requireKey('session', 'alpha::message')
  assertCondition(
    delimiterInSession !== delimiterInMessage,
    'moving a delimiter between tuple components must not collide',
  )

  const unicodeKey = requireKey(' 会话::😀 ', '消息::🧪')
  const parsed = parseChatBannerUiStateKey(unicodeKey)
  assertEqual(parsed?.sessionId, ' 会话::😀 ', 'Unicode session id should round trip')
  assertEqual(parsed?.messageId, '消息::🧪', 'Unicode message id should round trip')
  assertEqual(
    parseChatBannerUiStateKey(`${unicodeKey}%00`),
    null,
    'trailing encoded data must invalidate the key',
  )
  assertEqual(
    parseChatBannerUiStateKey('gyshell-pair-v1:1:%:1:a'),
    null,
    'invalid percent-encoded UTF-8 must fail closed',
  )
  assertEqual(
    parseChatBannerUiStateKey('session::message'),
    null,
    'legacy delimiter keys must not be interpreted ambiguously',
  )
})

runCase('partial merges preserve existing state fields for the same banner row', () => {
  const key = requireKey('session-1', 'message-1')
  const initialState: ChatBannerUiStateMap = {
    [key]: {
      expanded: true,
      expandedStepIds: ['step-1'],
      expandedDetailIds: ['step-1:output'],
    },
  }

  const nextState = mergeChatBannerUiState(initialState, key, {
    showDetails: true,
    isSkipping: true,
  })

  assertCondition(
    nextState !== initialState,
    'state merges with new data should produce a new map object',
  )
  assertEqual(
    nextState[key]?.expanded,
    true,
    'merging showDetails should preserve existing expanded state',
  )
  assertEqual(
    nextState[key]?.expandedStepIds?.[0],
    'step-1',
    'merging unrelated fields should preserve expanded step ids',
  )
  assertEqual(
    nextState[key]?.expandedDetailIds?.[0],
    'step-1:output',
    'merging unrelated fields should preserve expanded detail ids',
  )
  assertEqual(nextState[key]?.showDetails, true, 'merged state should store details')
  assertEqual(nextState[key]?.isSkipping, true, 'merged state should store skip state')
})

runCase('no-op merges keep the same object identity on hot paths', () => {
  const key = requireKey('session-1', 'message-1')
  const initialState: ChatBannerUiStateMap = {
    [key]: {
      expanded: false,
      expandedStepIds: ['step-1'],
      expandedDetailIds: [],
      showDetails: true,
      isSkipping: true,
    },
  }

  const nextState = mergeChatBannerUiState(initialState, key, {
    expanded: false,
    expandedStepIds: ['step-1'],
    expandedDetailIds: [],
    isSkipping: true,
  })

  assertCondition(
    nextState === initialState,
    'reapplying the same patch should avoid unnecessary state churn',
  )
})

runCase('pruning uses exact decoded session membership', () => {
  const targetSessionId = ' session::A '
  const keepKey = requireKey(targetSessionId, 'message-2')
  const staleKey = requireKey(targetSessionId, 'message-1')
  const caseDistinctKey = requireKey(' session::a ', 'message-1')
  const whitespaceDistinctKey = requireKey('session::A', 'message-1')
  const delimiterShiftKey = requireKey(' session', ':A ::message-1')
  const legacyMalformedKey = `${targetSessionId}::message-legacy`
  const initialState: ChatBannerUiStateMap = {
    [staleKey]: { expanded: true },
    [keepKey]: { expanded: false },
    [caseDistinctKey]: { showDetails: true },
    [whitespaceDistinctKey]: { showDetails: true },
    [delimiterShiftKey]: { showDetails: true },
    [legacyMalformedKey]: { showDetails: true },
  }

  const nextState = pruneChatBannerUiStateForSession(
    initialState,
    targetSessionId,
    ['message-2', 'message-3'],
  )

  assertCondition(!(staleKey in nextState), 'stale rows for the exact session should be pruned')
  assertCondition(keepKey in nextState, 'visible rows for the exact session must remain')
  assertCondition(caseDistinctKey in nextState, 'case-distinct sessions must remain isolated')
  assertCondition(
    whitespaceDistinctKey in nextState,
    'whitespace-distinct sessions must remain isolated',
  )
  assertCondition(delimiterShiftKey in nextState, 'delimiter-bearing tuples must not alias')
  assertCondition(
    legacyMalformedKey in nextState,
    'unparseable keys must not be attributed to an arbitrary session',
  )
})

runCase('pruning with an unchanged valid set preserves map identity', () => {
  const sessionOneKey = requireKey('session-1', 'message-1')
  const sessionTwoKey = requireKey('session-2', 'message-9')
  const initialState: ChatBannerUiStateMap = {
    [sessionOneKey]: { expanded: true },
    [sessionTwoKey]: { showDetails: true },
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
      const key = requireKey(
        `session::${sessionIndex}`,
        `message::${messageIndex}`,
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
    state[requireKey('session::18', 'message::6')]?.expanded,
    true,
    'even-indexed rows should keep their assigned expanded flag',
  )
  assertEqual(
    state[requireKey('session::18', 'message::7')]?.expanded,
    false,
    'odd-indexed rows should keep their assigned collapsed flag',
  )
})

console.log('All chat banner UI state extreme tests passed.')
