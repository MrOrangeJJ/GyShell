import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import { TokenManager } from '../TokenManager'
import {
  expireUnbackedCommandOutputEnvelope,
  formatInitialCommandOutput,
  formatPrunedCommandOutputForModelContext,
  parseCommandOutputEnvelopeContract,
  parsePrunedCommandOutputMaterialization,
  rewriteCommandOutputEnvelopeContract,
  type CommandOutputSource,
} from '../tools/command_output_contract'
import { cloneMessageWithPatch } from './message_clone'

type RetryCapableHelpers = {
  invokeWithRetry: <T>(
    fn: (attempt: number) => Promise<T>,
    maxRetries?: number,
    delays?: number[],
    signal?: AbortSignal
  ) => Promise<T>
}

type CommandOutputBackingSourceResolver = (
  terminalId: string,
  historyCommandMatchId: string,
) => CommandOutputSource | undefined

export function stripRawResponseForModelInput(messages: BaseMessage[]): BaseMessage[] {
  const stored = mapChatMessagesToStoredMessages(messages)
  const mutated = stripRawResponseFromStoredMessages(stored as any[])
  return mutated ? mapStoredMessagesToChatMessages(stored) : messages
}

export function sanitizeStoredMessagesForChatRuntime(storedMessages: any[]): {
  messages: any[]
  removedCount: number
} {
  if (!Array.isArray(storedMessages) || storedMessages.length === 0) {
    return {
      messages: Array.isArray(storedMessages) ? storedMessages : [],
      removedCount: 0
    }
  }

  const kept: any[] = []
  let removedCount = 0

  for (const storedMessage of storedMessages) {
    try {
      const rebuilt = mapStoredMessagesToChatMessages([storedMessage] as any[])
      if (!Array.isArray(rebuilt) || rebuilt.length === 0) {
        removedCount += 1
        continue
      }
      kept.push(storedMessage)
    } catch {
      removedCount += 1
    }
  }

  return removedCount > 0
    ? { messages: kept, removedCount }
    : { messages: storedMessages, removedCount: 0 }
}

export function expireUnbackedStoredCommandOutputEnvelopes(
  storedMessages: any[],
  getBackingSource: (
    terminalId: string,
    historyCommandMatchId: string,
  ) => CommandOutputSource | undefined,
): boolean {
  let mutated = false
  for (const storedMessage of storedMessages) {
    if (
      storedMessage?.type !== 'tool' ||
      !['exec_command', 'read_command_output'].includes(
        String(storedMessage?.data?.name || '')
      )
    ) {
      continue
    }
    const content = storedMessage?.data?.content
    if (typeof content !== 'string') continue
    const contract = parseCommandOutputEnvelopeContract(content)
    if (!contract) continue
    const source = getBackingSource(
      contract.terminalId,
      contract.historyCommandMatchId,
    )
    let reconciled = content
    if (!source) {
      reconciled = expireUnbackedCommandOutputEnvelope(content)
    } else {
      const executionState = source.executionState
      const exitCode =
        executionState === 'finished' ? source.exitCode ?? null : null
      const capture = {
        state: source.capture.state,
        ...(source.capture.reason !== undefined
          ? { reason: source.capture.reason }
          : {}),
        observedUtf8Bytes: source.capture.observedUtf8Bytes,
        retainedUtf8Bytes: source.capture.retainedUtf8Bytes,
        availableLineCount: source.capture.availableLineCount,
        revision: source.capture.revision,
        terminalControlsObserved: source.capture.terminalControlsObserved,
      }
      const executionChanged =
        contract.executionState !== executionState ||
        contract.exitCode !== exitCode
      const captureChanged =
        JSON.stringify(contract.capture) !== JSON.stringify(capture)
      const recordExpired = capture.reason === 'record_expired'
      const isExecCommand = storedMessage.data.name === 'exec_command'
      const mustRematerialize =
        !recordExpired &&
        isExecCommand &&
        (executionChanged || captureChanged)

      if (mustRematerialize) {
        try {
          const refreshed = formatInitialCommandOutput(source).text
          const prunedMaterialization =
            parsePrunedCommandOutputMaterialization(content)
          reconciled = prunedMaterialization
            ? formatPrunedCommandOutputForModelContext(
                refreshed,
                prunedMaterialization.originalApproximateTokens,
              ) || expireUnbackedCommandOutputEnvelope(content)
            : refreshed
        } catch {
          reconciled = expireUnbackedCommandOutputEnvelope(content)
        }
      } else if (captureChanged || executionChanged || recordExpired) {
        const presentation = (() => {
          const {
            nextCursor: _nextCursor,
            pollCursor: _pollCursor,
            ...cursorlessPresentation
          } = contract.presentation
          if (recordExpired) {
            return {
              ...cursorlessPresentation,
              hasMoreCapturedOutput: false,
            }
          }
          if (
            storedMessage.data.name !== 'read_command_output' ||
            contract.presentation.pollCursor === undefined
          ) {
            return contract.presentation
          }

          const retainedOutputGrew =
            capture.retainedUtf8Bytes >
            contract.capture.retainedUtf8Bytes
          if (retainedOutputGrew) {
            // A poll cursor denotes the exact captured tail that this
            // historical page reached. Once more retained bytes exist, the
            // same authenticated position becomes the page's next cursor;
            // rematerializing from byte zero would erase paging progress.
            return {
              ...cursorlessPresentation,
              state: 'excerpt' as const,
              hasMoreCapturedOutput: true,
              nextCursor: contract.presentation.pollCursor,
            }
          }
          if (executionState !== 'running') {
            // The page reached the final retained tail. Polling is no longer
            // meaningful, but the already-presented page remains historical
            // evidence and must stay byte-for-byte stable.
            return {
              ...cursorlessPresentation,
              hasMoreCapturedOutput: false,
            }
          }
          return contract.presentation
        })()
        reconciled = rewriteCommandOutputEnvelopeContract(content, {
          ...contract,
          executionState,
          exitCode,
          capture,
          presentation,
        })
      }
    }
    if (reconciled !== content) {
      storedMessage.data.content = reconciled
      mutated = true
    }
  }
  return mutated
}

export function stripRawResponseFromStoredMessages(storedMessages: any[]): boolean {
  let mutated = false
  for (const msg of storedMessages) {
    const additionalKwargs = msg?.data?.additional_kwargs
    if (additionalKwargs && Object.prototype.hasOwnProperty.call(additionalKwargs, '__raw_response')) {
      delete additionalKwargs.__raw_response
      mutated = true
    }
  }
  return mutated
}

export async function invokeWithRetryAndSanitizedInput<T>(opts: {
  helpers: RetryCapableHelpers
  messages: BaseMessage[]
  modelSupportsImage?: boolean
  signal: AbortSignal | undefined
  operation: (sanitizedMessages: BaseMessage[]) => Promise<T>
  onRetry?: (attempt: number) => void
  maxRetries: number
  delaysMs: number[]
  getCommandOutputBackingSource?: CommandOutputBackingSourceResolver
}): Promise<T> {
  return await opts.helpers.invokeWithRetry(
    async (attempt) => {
      if (attempt > 0) {
        opts.onRetry?.(attempt)
      }
      const sanitizedMessages = prepareModelInputMessagesForInvocation(
        opts.messages,
        {
          modelSupportsImage: opts.modelSupportsImage,
          getCommandOutputBackingSource:
            opts.getCommandOutputBackingSource,
        }
      )
      return await opts.operation(sanitizedMessages)
    },
    opts.maxRetries,
    opts.delaysMs,
    opts.signal
  )
}

/**
 * Builds the final immutable request view immediately before one model call.
 * It is intentionally reusable by secondary calls made inside a streaming
 * attempt so those calls cannot inherit stale command lifecycle metadata.
 */
export function prepareModelInputMessagesForInvocation(
  messages: BaseMessage[],
  options?: {
    modelSupportsImage?: boolean
    getCommandOutputBackingSource?: CommandOutputBackingSourceResolver
  }
): BaseMessage[] {
  let currentMessages = messages
  if (options?.getCommandOutputBackingSource) {
    const stored = mapChatMessagesToStoredMessages(currentMessages) as any[]
    if (
      expireUnbackedStoredCommandOutputEnvelopes(
        stored,
        options.getCommandOutputBackingSource,
      )
    ) {
      currentMessages = mapStoredMessagesToChatMessages(stored)
    }
  }
  return sanitizeModelInputMessages(
    stripRawResponseForModelInput(currentMessages),
    { modelSupportsImage: options?.modelSupportsImage }
  )
}

export function buildDynamicRequestHistory(
  messages: BaseMessage[],
  options?: { modelSupportsImage?: boolean }
): BaseMessage[] {
  const compacted = applyCompactionBoundary(messages)
  const materialized = applyPruneMaterialization(compacted)
  return sanitizeModelInputMessages(materialized, options)
}

function applyCompactionBoundary(messages: BaseMessage[]): BaseMessage[] {
  let lastCompactionIndex = -1
  for (let i = 0; i < messages.length; i++) {
    if (TokenManager.hasLastCompactionFlag(messages[i])) {
      lastCompactionIndex = i
    }
  }
  if (lastCompactionIndex < 0) return messages

  // Keep leading system prompts untouched, then keep from the last compaction marker onward.
  let leadingSystemCount = 0
  while (leadingSystemCount < messages.length && messages[leadingSystemCount]?.type === 'system') {
    leadingSystemCount += 1
  }

  const startIndex = Math.max(lastCompactionIndex, leadingSystemCount)
  const head = messages.slice(0, leadingSystemCount)
  const tail = messages.slice(startIndex)
  return [...head, ...tail]
}

function applyPruneMaterialization(messages: BaseMessage[]): BaseMessage[] {
  let changed = false
  const nextMessages = messages.map((message) => {
    if (!TokenManager.hasPruneLabel(message)) {
      return message
    }
    changed = true
    if (
      message.getType() === 'tool' &&
      ['exec_command', 'read_command_output'].includes(
        String((message as { name?: unknown }).name || '')
      ) &&
      typeof message.content === 'string'
    ) {
      const estimate = TokenManager.estimate(message.content)
      const commandMaterialization =
        formatPrunedCommandOutputForModelContext(message.content, estimate)
      if (commandMaterialization) {
        return cloneMessageWithPatch(message, {
          content: commandMaterialization,
        })
      }
    }
    return cloneMessageWithPatch(message, {
      content: buildPrunedPlaceholder(message.content)
    })
  })
  return changed ? nextMessages : messages
}

export function sanitizeModelInputMessages(
  messages: BaseMessage[],
  options?: { modelSupportsImage?: boolean }
): BaseMessage[] {
  if (options?.modelSupportsImage !== false) {
    return messages
  }

  let changed = false
  const nextMessages = messages.map((message) => {
    const sanitized = sanitizeMessageContentForTextOnlyModel(message.content)
    if (!sanitized.changed) {
      return message
    }
    changed = true
    return cloneMessageWithPatch(message, {
      content: sanitized.content
    })
  })
  return changed ? nextMessages : messages
}

function sanitizeMessageContentForTextOnlyModel(
  content: unknown
): { content: unknown; changed: boolean } {
  if (!Array.isArray(content)) {
    return { content, changed: false }
  }

  let changed = false
  const nextParts: unknown[] = []
  const textParts: string[] = []

  for (const part of content) {
    if (isImageContentPart(part)) {
      changed = true
      continue
    }
    nextParts.push(part)
    if (isTextContentPart(part)) {
      textParts.push(part.text)
    } else if (typeof part === 'string') {
      textParts.push(part)
    }
  }

  if (!changed) {
    return { content, changed: false }
  }

  const mergedText = textParts.join('').trim()
  if (nextParts.length === 0) {
    return {
      content: mergedText || '[Image content omitted because the target model does not support image inputs.]',
      changed: true
    }
  }

  if (nextParts.every((part) => isTextContentPart(part) || typeof part === 'string')) {
    return {
      content: mergedText || '[Image content omitted because the target model does not support image inputs.]',
      changed: true
    }
  }

  return { content: nextParts, changed: true }
}

function isImageContentPart(part: unknown): boolean {
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url'
}

function isTextContentPart(part: unknown): part is { type: 'text'; text: string } {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  )
}

function buildPrunedPlaceholder(content: unknown): string {
  const estimate = TokenManager.estimateMessageContent(content)
  return `${TokenManager.PRUNED_CONTENT_PLACEHOLDER} Original length: ~${estimate} tokens.`
}
