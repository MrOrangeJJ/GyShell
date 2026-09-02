import {
  decodeOpaqueStringPair,
  encodeOpaqueStringPair,
  readOpaqueNonBlankWellFormedString,
} from '@gyshell/shared'

export interface ChatBannerUiState {
  expanded?: boolean
  expandedStepIds?: string[]
  expandedDetailIds?: string[]
  showDetails?: boolean
  isSkipping?: boolean
}

export type ChatBannerUiStateMap = Record<string, ChatBannerUiState>

const areOptionalStringArraysEqual = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean =>
  left === right ||
  (!!left &&
    !!right &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]))

export const getChatBannerUiStateKey = (
  sessionId: string | null,
  messageId: string,
): string | null => {
  const exactSessionId = readOpaqueNonBlankWellFormedString(sessionId)
  const exactMessageId = readOpaqueNonBlankWellFormedString(messageId)
  if (exactSessionId === undefined || exactMessageId === undefined) {
    return null
  }
  return encodeOpaqueStringPair(exactSessionId, exactMessageId) || null
}

export const parseChatBannerUiStateKey = (
  key: unknown,
): { sessionId: string; messageId: string } | null => {
  const pair = decodeOpaqueStringPair(key)
  if (!pair) return null
  const sessionId = readOpaqueNonBlankWellFormedString(pair[0])
  const messageId = readOpaqueNonBlankWellFormedString(pair[1])
  if (sessionId === undefined || messageId === undefined) return null
  return { sessionId, messageId }
}

export const mergeChatBannerUiState = (
  state: ChatBannerUiStateMap,
  key: string | null,
  patch: Partial<ChatBannerUiState>,
): ChatBannerUiStateMap => {
  if (!key) return state

  const current = state[key] || {}
  const next = {
    ...current,
    ...patch,
  }
  if (
    current.expanded === next.expanded &&
    areOptionalStringArraysEqual(
      current.expandedStepIds,
      next.expandedStepIds,
    ) &&
    areOptionalStringArraysEqual(
      current.expandedDetailIds,
      next.expandedDetailIds,
    ) &&
    current.showDetails === next.showDetails &&
    current.isSkipping === next.isSkipping
  ) {
    return state
  }

  return {
    ...state,
    [key]: next,
  }
}

export const pruneChatBannerUiStateForSession = (
  state: ChatBannerUiStateMap,
  sessionId: string | null,
  validMessageIds: readonly string[],
): ChatBannerUiStateMap => {
  const exactSessionId = readOpaqueNonBlankWellFormedString(sessionId)
  if (exactSessionId === undefined) {
    return state
  }

  const validKeys = new Set(
    validMessageIds
      .map((messageId) =>
        getChatBannerUiStateKey(exactSessionId, messageId),
      )
      .filter((key): key is string => key !== null),
  )

  let changed = false
  const nextState: ChatBannerUiStateMap = {}
  Object.entries(state).forEach(([key, value]) => {
    const parsedKey = parseChatBannerUiStateKey(key)
    const belongsToSession = parsedKey?.sessionId === exactSessionId
    if (belongsToSession && !validKeys.has(key)) {
      changed = true
      return
    }
    nextState[key] = value
  })

  return changed ? nextState : state
}
