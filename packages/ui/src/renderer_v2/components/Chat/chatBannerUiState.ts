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
  const normalizedSessionId = String(sessionId || '').trim()
  const normalizedMessageId = String(messageId || '').trim()
  if (!normalizedSessionId || !normalizedMessageId) {
    return null
  }
  return `${normalizedSessionId}::${normalizedMessageId}`
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
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) {
    return state
  }

  const validKeys = new Set(
    validMessageIds
      .map((messageId) =>
        getChatBannerUiStateKey(normalizedSessionId, messageId),
      )
      .filter((key): key is string => !!key),
  )

  let changed = false
  const nextState: ChatBannerUiStateMap = {}
  Object.entries(state).forEach(([key, value]) => {
    const belongsToSession = key.startsWith(`${normalizedSessionId}::`)
    if (belongsToSession && !validKeys.has(key)) {
      changed = true
      return
    }
    nextState[key] = value
  })

  return changed ? nextState : state
}
