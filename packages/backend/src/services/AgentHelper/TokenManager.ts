import { BaseMessage, ToolMessage } from '@langchain/core/messages'
import { cloneMessageWithPatch } from './utils/message_clone'

export interface PruneLabelResult {
  messages: BaseMessage[]
  newlyTaggedCount: number
  totalTaggedCount: number
  estimatedPrunedTokens: number
  changed: boolean
}

export class TokenManager {
  // Conservative estimate: 4 chars per token
  private static readonly CHARS_PER_TOKEN = 4

  // Minimum amount to prune to avoid frequent small updates (20k tokens)
  private static readonly PRUNE_MINIMUM = 20_000
  // Reserve tokens for output generation
  private static readonly OUTPUT_RESERVE = 10000

  // Tools that should never be pruned
  private static readonly PRUNE_PROTECTED_TOOLS = ['skill']

  // Number of recent tool messages to protect regardless of size
  private static readonly RECENT_TOOL_MESSAGES_TO_PROTECT = 10

  // Keys/markers used by dynamic request-history pruning.
  static readonly PRUNE_FLAG_KEY = '_gyshellPrune'
  static readonly LAST_COMPACTION_FLAG_KEY = 'last_compaction'
  static readonly COMPACTION_PROTECTED_ROUNDS_KEY = 'compaction_protected_normal_rounds'
  static readonly PRUNED_CONTENT_PLACEHOLDER = '[Content Pruned by TokenManager]'

  /**
   * Estimate token count for a string using simple character length heuristic
   */
  static estimate(input: string | undefined | null): number {
    if (!input) return 0
    return Math.max(0, Math.round(input.length / this.CHARS_PER_TOKEN))
  }

  static estimateMessages(messages: BaseMessage[]): number {
    let total = 0
    for (const message of messages) {
      total += this.estimateMessageContent(message.content)
    }
    return total
  }

  /**
   * Keep the legacy character estimator, but do not count encoded image URLs
   * as text. Vision providers tokenize the image itself rather than the data
   * URI string, so counting that string can overstate one image by hundreds of
   * thousands of tokens.
   */
  static estimateMessageContent(
    content: BaseMessage['content'] | unknown
  ): number {
    if (typeof content === 'string') {
      return this.estimate(content)
    }

    const estimableContent = Array.isArray(content)
      ? content.filter((part) => !this.isImageUrlPart(part))
      : this.isImageUrlPart(content)
        ? []
        : content
    return this.estimate(JSON.stringify(estimableContent))
  }

  private static isImageUrlPart(part: unknown): boolean {
    return (
      !!part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'image_url'
    )
  }

  /**
   * Check if current usage exceeds safe limits
   */
  static isOverflow(currentTokens: number, maxTokens: number): boolean {
    if (maxTokens <= 0) return false

    // Calculate usable context window
    const usable = maxTokens - this.OUTPUT_RESERVE

    return currentTokens > usable
  }

  static hasPruneLabel(message: BaseMessage): boolean {
    const additionalKwargs = (message as any)?.additional_kwargs
    return additionalKwargs?.[this.PRUNE_FLAG_KEY] === true
  }

  static hasLastCompactionFlag(message: BaseMessage): boolean {
    const additionalKwargs = (message as any)?.additional_kwargs
    return additionalKwargs?.[this.LAST_COMPACTION_FLAG_KEY] === true
  }

  /**
   * Mark prune candidates by writing a prune label to additional_kwargs.
   * It never mutates message content.
   */
  static applyPruneLabels(messages: BaseMessage[]): PruneLabelResult {
    const msgs = [...messages]
    const pruneWindowStartIndex = this.getPruneWindowStartIndex(msgs)

    let estimatedPrunedTokens = 0
    const indicesToLabel: number[] = []
    let toolMessageCount = 0

    // Traverse backwards
    for (let i = msgs.length - 1; i >= pruneWindowStartIndex; i--) {
      const msg = msgs[i]

      // 1. Identify ToolMessages
      if (msg instanceof ToolMessage || msg.getType() === 'tool') {
        toolMessageCount++

        // 2. Protect the most recent N tool messages
        if (toolMessageCount <= this.RECENT_TOOL_MESSAGES_TO_PROTECT) {
          continue
        }

        const toolMsg = msg as any // Cast to access tool_call_id, name etc if needed
        const toolName = toolMsg.name || ''

        // 3. Skip protected tools
        if (this.PRUNE_PROTECTED_TOOLS.includes(toolName)) continue

        // 4. Estimate tokens
        // Skip any message already tagged in additional_kwargs.
        if (this.hasPruneLabel(msg)) continue

        const estimate = this.estimateMessageContent(msg.content)
        estimatedPrunedTokens += estimate
        indicesToLabel.push(i)
      }
    }

    // 5. Only label if estimated savings are meaningful (PRUNE_MINIMUM)
    if (estimatedPrunedTokens <= this.PRUNE_MINIMUM) {
      return {
        messages,
        newlyTaggedCount: 0,
        totalTaggedCount: this.countTaggedMessages(messages),
        estimatedPrunedTokens,
        changed: false
      }
    }

    let newlyTaggedCount = 0
    for (const index of indicesToLabel) {
      const originalMsg = msgs[index]
      if (this.hasPruneLabel(originalMsg)) continue
      const nextAdditionalKwargs = {
        ...((originalMsg as any).additional_kwargs || {}),
        [this.PRUNE_FLAG_KEY]: true
      }
      msgs[index] = cloneMessageWithPatch(originalMsg, {
        additionalKwargs: nextAdditionalKwargs
      })
      newlyTaggedCount += 1
    }

    return {
      messages: newlyTaggedCount > 0 ? msgs : messages,
      newlyTaggedCount,
      totalTaggedCount: this.countTaggedMessages(newlyTaggedCount > 0 ? msgs : messages),
      estimatedPrunedTokens,
      changed: newlyTaggedCount > 0
    }
  }

  private static countTaggedMessages(messages: BaseMessage[]): number {
    let count = 0
    for (const message of messages) {
      if (this.hasPruneLabel(message)) {
        count += 1
      }
    }
    return count
  }

  private static getPruneWindowStartIndex(messages: BaseMessage[]): number {
    let lastCompactionIndex = -1
    for (let i = 0; i < messages.length; i++) {
      if (this.hasLastCompactionFlag(messages[i])) {
        lastCompactionIndex = i
      }
    }
    if (lastCompactionIndex < 0) {
      return 0
    }

    let leadingSystemCount = 0
    while (leadingSystemCount < messages.length && messages[leadingSystemCount]?.type === 'system') {
      leadingSystemCount += 1
    }
    return Math.max(lastCompactionIndex, leadingSystemCount)
  }
}
