import { ToolMessage, type BaseMessage } from '@langchain/core/messages'

export type SyntheticToolOutcomeStatus =
  | 'unknown_outcome'
  | 'cancelled'
  | 'not_executed'

export interface SyntheticToolOutcome {
  status: SyntheticToolOutcomeStatus
  reason: string
  retryable: boolean
}

export interface CompleteUnmatchedToolCallsOptions {
  status?: SyntheticToolOutcomeStatus
  reason?: string
  retryable?: boolean
}

export interface ToolCallHistoryCompletionResult {
  messages: BaseMessage[]
  addedToolMessageCount: number
  invalidToolCallCount: number
  duplicateToolCallIdCount: number
  duplicateToolResponseCount: number
  orphanToolResponseCount: number
  changed: boolean
}

interface ToolCallHistoryCleanResult {
  messages: BaseMessage[]
  removedToolCallCount: number
}

interface ValidToolCall {
  id: string
  name?: string
}

interface ToolCallBatch {
  sourceIndex: number
  endIndex: number
  calls: unknown[]
}

const DEFAULT_REASON_BY_STATUS: Record<SyntheticToolOutcomeStatus, string> = {
  unknown_outcome:
    'The run ended before a definitive tool result was recorded. The side effect, if any, must not be assumed or replayed automatically.',
  cancelled:
    'The tool call was cancelled before a definitive result was recorded.',
  not_executed:
    'The tool call was not executed and may be issued again if it is still needed.'
}

function getMessageType(message: BaseMessage): string {
  const getType = (message as { getType?: () => string }).getType
  return typeof getType === 'function'
    ? getType.call(message)
    : String((message as any)?.type || '')
}

function getAssistantToolCalls(message: BaseMessage): unknown[] | null {
  if (getMessageType(message) !== 'ai') return null
  const toolCalls = (message as any)?.tool_calls
  return Array.isArray(toolCalls) && toolCalls.length > 0 ? toolCalls : null
}

function getValidToolCall(toolCall: unknown): ValidToolCall | null {
  if (!toolCall || typeof toolCall !== 'object') return null
  const id = (toolCall as { id?: unknown }).id
  if (typeof id !== 'string' || id.trim().length === 0) return null
  const name = (toolCall as { name?: unknown }).name
  return {
    id,
    ...(typeof name === 'string' ? { name } : {})
  }
}

function getToolResponseId(message: BaseMessage): string | null {
  if (getMessageType(message) !== 'tool') return null
  const id = (message as any)?.tool_call_id
  return typeof id === 'string' && id.trim().length > 0 ? id : null
}

function collectToolCallBatches(messages: BaseMessage[]): ToolCallBatch[] {
  const batches: ToolCallBatch[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const calls = getAssistantToolCalls(messages[index])
    if (calls) {
      batches.push({ sourceIndex: index, endIndex: messages.length, calls })
    }
  }
  for (let index = 0; index < batches.length - 1; index += 1) {
    batches[index].endIndex = batches[index + 1].sourceIndex
  }
  return batches
}

export function serializeSyntheticToolOutcome(
  options: CompleteUnmatchedToolCallsOptions = {}
): string {
  const status: SyntheticToolOutcomeStatus =
    options.status === 'cancelled' ||
    options.status === 'not_executed' ||
    options.status === 'unknown_outcome'
      ? options.status
      : 'unknown_outcome'
  const outcome: SyntheticToolOutcome = {
    status,
    reason:
      typeof options.reason === 'string'
        ? options.reason
        : DEFAULT_REASON_BY_STATUS[status],
    retryable:
      typeof options.retryable === 'boolean'
        ? options.retryable
        : status === 'not_executed'
  }
  return JSON.stringify(outcome)
}

function createSyntheticToolMessage(
  call: ValidToolCall,
  content: string
): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: call.id,
    name: call.name
  })
}

/**
 * Complete unresolved assistant tool batches without deleting valid calls.
 * Matching is batch-local, results are consumed once, and every valid id is
 * committed in source order before later image or role supplements.
 */
export function completeUnmatchedToolCallsInHistory(
  messages: BaseMessage[],
  options: CompleteUnmatchedToolCallsOptions = {}
): ToolCallHistoryCompletionResult {
  const emptyResult = {
    messages,
    addedToolMessageCount: 0,
    invalidToolCallCount: 0,
    duplicateToolCallIdCount: 0,
    duplicateToolResponseCount: 0,
    orphanToolResponseCount: 0,
    changed: false
  }
  if (messages.length === 0) return emptyResult

  const batches = collectToolCallBatches(messages)
  if (
    batches.length === 0 &&
    !messages.some((message) => getMessageType(message) === 'tool')
  ) {
    return emptyResult
  }

  const synthesizedContent = serializeSyntheticToolOutcome(options)
  const consumedResponseIndices = new Set<number>()
  const orderedResultsBySourceIndex = new Map<number, BaseMessage[]>()
  let addedToolMessageCount = 0
  let invalidToolCallCount = 0
  let duplicateToolCallIdCount = 0
  let duplicateToolResponseCount = 0
  let orphanToolResponseCount = 0

  for (const batch of batches) {
    const uniqueCalls: ValidToolCall[] = []
    const callIds = new Set<string>()
    for (const rawCall of batch.calls) {
      const call = getValidToolCall(rawCall)
      if (!call) {
        invalidToolCallCount += 1
        continue
      }
      if (callIds.has(call.id)) {
        duplicateToolCallIdCount += 1
        continue
      }
      callIds.add(call.id)
      uniqueCalls.push(call)
    }

    const firstResponseById = new Map<string, BaseMessage>()
    for (
      let index = batch.sourceIndex + 1;
      index < batch.endIndex;
      index += 1
    ) {
      const responseId = getToolResponseId(messages[index])
      if (!responseId || !callIds.has(responseId)) continue
      consumedResponseIndices.add(index)
      if (firstResponseById.has(responseId)) {
        duplicateToolResponseCount += 1
        continue
      }
      firstResponseById.set(responseId, messages[index])
    }

    const orderedResults: BaseMessage[] = []
    for (const call of uniqueCalls) {
      const existing = firstResponseById.get(call.id)
      if (existing) {
        orderedResults.push(existing)
      } else {
        orderedResults.push(
          createSyntheticToolMessage(call, synthesizedContent)
        )
        addedToolMessageCount += 1
      }
    }
    if (orderedResults.length > 0) {
      orderedResultsBySourceIndex.set(batch.sourceIndex, orderedResults)
    }
  }

  const completedMessages: BaseMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const responseWasConsumed = consumedResponseIndices.has(index)
    if (
      !responseWasConsumed &&
      getMessageType(messages[index]) === 'tool'
    ) {
      // A role=tool message without a batch-local assistant call is not a
      // valid protocol result. Exclude only this orphaned response; matched
      // responses and every assistant tool call remain byte-for-byte intact.
      orphanToolResponseCount += 1
    } else if (!responseWasConsumed) {
      completedMessages.push(messages[index])
    }
    const orderedResults = orderedResultsBySourceIndex.get(index)
    if (orderedResults) completedMessages.push(...orderedResults)
  }

  const changed =
    completedMessages.length !== messages.length ||
    completedMessages.some((message, index) => message !== messages[index])
  return {
    messages: changed ? completedMessages : messages,
    addedToolMessageCount,
    invalidToolCallCount,
    duplicateToolCallIdCount,
    duplicateToolResponseCount,
    orphanToolResponseCount,
    changed
  }
}

/**
 * @deprecated Use completeUnmatchedToolCallsInHistory. Kept as a
 * non-destructive compatibility wrapper for older callers.
 */
export function removeUnmatchedToolCallsFromHistory(
  messages: BaseMessage[]
): ToolCallHistoryCleanResult {
  const result = completeUnmatchedToolCallsInHistory(messages)
  return { messages: result.messages, removedToolCallCount: 0 }
}
