import { BaseMessage, ToolMessage } from '@langchain/core/messages'

export class TokenManager {
  // Conservative estimate: 4 chars per token
  private static readonly CHARS_PER_TOKEN = 4
  
  // Pruning Thresholds
  // Start pruning when accumulated tool outputs exceed this (40k tokens)
  private static readonly PRUNE_PROTECT = 40_000
  // Minimum amount to prune to avoid frequent small updates (20k tokens)
  private static readonly PRUNE_MINIMUM = 20_000
  // Reserve tokens for output generation
  private static readonly OUTPUT_RESERVE = 10000
  
  // Tools that should never be pruned
  private static readonly PRUNE_PROTECTED_TOOLS = ['skill']

  // Number of recent tool messages to protect regardless of size
  private static readonly RECENT_TOOL_MESSAGES_TO_PROTECT = 10

  /**
   * Estimate token count for a string using simple character length heuristic
   */
  static estimate(input: string | undefined | null): number {
    if (!input) return 0
    return Math.max(0, Math.round(input.length / this.CHARS_PER_TOKEN))
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

  /**
   * Prune messages to reduce token usage
   * Strategy based on opencode:
   * 1. Protect the most recent 5 ToolMessages.
   * 2. For ToolMessages older than that, apply PRUNE_PROTECT threshold.
   * 3. Replace content if total pruned amount > PRUNE_MINIMUM.
   */
  static prune(messages: BaseMessage[]): BaseMessage[] {
    // We need to work on a copy to avoid mutating the original reference in place
    // until we are sure we want to return a new list
    const msgs = [...messages]
    
    let totalToolTokens = 0
    let prunedTokens = 0
    const indicesToPrune: number[] = []
    let toolMessageCount = 0

    // Traverse backwards
    for (let i = msgs.length - 1; i >= 0; i--) {
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
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        // Check if already pruned
        if (content.includes('[Content Pruned]')) continue

        const estimate = this.estimate(content)
        totalToolTokens += estimate

        // 5. If accumulated tool tokens exceed protection threshold, mark for pruning
        if (totalToolTokens > this.PRUNE_PROTECT) {
          prunedTokens += estimate
          indicesToPrune.push(i)
        }
      }
    }

    // 6. Only apply pruning if we can save a significant amount (PRUNE_MINIMUM)
    if (prunedTokens > this.PRUNE_MINIMUM) {
      console.log(`[TokenManager] Pruning triggered. Saving ~${prunedTokens} tokens from ${indicesToPrune.length} messages.`)
      
      for (const index of indicesToPrune) {
        const originalMsg = msgs[index]
        // Create a new message instance with pruned content
        // We preserve metadata but replace content
        const prunedMsg = new (originalMsg.constructor as any)({
          ...originalMsg,
          content: `[Content Pruned by TokenManager] Original length: ~${this.estimate(typeof originalMsg.content === 'string' ? originalMsg.content : JSON.stringify(originalMsg.content))} tokens.`
        })
        // Ensure strictly type-compatible
        prunedMsg.id = originalMsg.id
        if ('name' in originalMsg) (prunedMsg as any).name = (originalMsg as any).name
        if ('tool_call_id' in (originalMsg as any)) (prunedMsg as any).tool_call_id = (originalMsg as any).tool_call_id
        
        msgs[index] = prunedMsg
      }
      
      return msgs
    }

    // No changes needed
    return messages
  }

}

