import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'

type RetryCapableHelpers = {
  invokeWithRetry: <T>(
    fn: (attempt: number) => Promise<T>,
    maxRetries?: number,
    delays?: number[],
    signal?: AbortSignal
  ) => Promise<T>
}

export function stripRawResponseForModelInput(messages: BaseMessage[]): BaseMessage[] {
  const stored = mapChatMessagesToStoredMessages(messages)
  const mutated = stripRawResponseFromStoredMessages(stored as any[])
  return mutated ? mapStoredMessagesToChatMessages(stored) : messages
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
  signal: AbortSignal | undefined
  operation: (sanitizedMessages: BaseMessage[]) => Promise<T>
  onRetry?: (attempt: number) => void
  maxRetries: number
  delaysMs: number[]
}): Promise<T> {
  return await opts.helpers.invokeWithRetry(
    async (attempt) => {
      if (attempt > 0) {
        opts.onRetry?.(attempt)
      }
      const sanitizedMessages = stripRawResponseForModelInput(opts.messages)
      return await opts.operation(sanitizedMessages)
    },
    opts.maxRetries,
    opts.delaysMs,
    opts.signal
  )
}
