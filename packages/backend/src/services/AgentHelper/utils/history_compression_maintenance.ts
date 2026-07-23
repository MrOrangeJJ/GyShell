import { ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { hasAnyNormalUserInputTag } from '../prompts'
import { TokenManager } from '../TokenManager'
import { cloneMessageWithPatch } from './message_clone'

export interface HistoryMutationResult {
  messages: BaseMessage[]
  changed: boolean
}

export function sanitizeCompressionAfterRollback(
  messages: BaseMessage[],
  options?: { pruneToolWindow?: number; protectedNormalRounds?: number }
): HistoryMutationResult {
  const pruneToolWindow = Math.max(0, options?.pruneToolWindow ?? 10)
  const protectedNormalRounds = Math.max(1, options?.protectedNormalRounds ?? 2)

  const pruneReset = clearPruneFlagsInTailToolMessages(messages, pruneToolWindow)
  const compactionReset = removeInvalidTailCompactionMarkers(
    pruneReset.messages,
    protectedNormalRounds
  )
  return {
    messages: compactionReset.messages,
    changed: pruneReset.changed || compactionReset.changed
  }
}

function clearPruneFlagsInTailToolMessages(
  messages: BaseMessage[],
  toolWindow: number
): HistoryMutationResult {
  if (toolWindow <= 0 || messages.length === 0) {
    return { messages, changed: false }
  }

  const messagesCopy = [...messages]
  let remaining = toolWindow
  let changed = false

  for (let i = messagesCopy.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messagesCopy[i]
    if (!(message instanceof ToolMessage || message.getType() === 'tool')) {
      continue
    }
    remaining -= 1
    if (!TokenManager.hasPruneLabel(message)) {
      continue
    }
    messagesCopy[i] = cloneWithoutPruneFlag(message)
    changed = true
  }

  return changed ? { messages: messagesCopy, changed: true } : { messages, changed: false }
}

function removeInvalidTailCompactionMarkers(
  messages: BaseMessage[],
  protectedNormalRounds: number
): HistoryMutationResult {
  if (messages.length === 0) {
    return { messages, changed: false }
  }

  let currentMessages = messages
  let changed = false

  while (true) {
    const markerIndex = findLastCompactionMarkerIndex(currentMessages)
    if (markerIndex < 0) break

    const markerProtectedRounds = getMarkerProtectedNormalRounds(
      currentMessages[markerIndex],
      protectedNormalRounds
    )
    const roundsAfterMarker = countNormalUserRoundsAfterIndex(currentMessages, markerIndex)
    if (roundsAfterMarker >= markerProtectedRounds) break

    currentMessages = [
      ...currentMessages.slice(0, markerIndex),
      ...currentMessages.slice(markerIndex + 1)
    ]
    changed = true
  }

  return changed ? { messages: currentMessages, changed: true } : { messages, changed: false }
}

function getMarkerProtectedNormalRounds(
  message: BaseMessage,
  fallback: number
): number {
  const additionalKwargs = (message as any)?.additional_kwargs || {}
  const value = additionalKwargs[
    TokenManager.COMPACTION_PROTECTED_ROUNDS_KEY
  ]
  if (additionalKwargs.zero_retention_compaction === true && value === 0) {
    return 0
  }
  return Number.isInteger(value) && value >= 1 ? value : fallback
}

function findLastCompactionMarkerIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (TokenManager.hasLastCompactionFlag(messages[i])) {
      return i
    }
  }
  return -1
}

function countNormalUserRoundsAfterIndex(messages: BaseMessage[], index: number): number {
  let rounds = 0
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message.type !== 'human') continue
    if (hasAnyNormalUserInputTag(message.content)) {
      rounds += 1
    }
  }
  return rounds
}

function cloneWithoutPruneFlag(message: BaseMessage): BaseMessage {
  const additionalKwargs = { ...((message as any).additional_kwargs || {}) }
  delete additionalKwargs[TokenManager.PRUNE_FLAG_KEY]
  return cloneMessageWithPatch(message, {
    additionalKwargs
  })
}
