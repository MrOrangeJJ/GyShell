import { BrowserWindow } from 'electron'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { AgentEvent, ModelDefinition, AppSettings } from '../../types'
import { 
  USER_INPUT_TAG, 
  TAB_CONTEXT_MARKER, 
  SYS_INFO_MARKER 
} from './prompts'

/**
 * Helper functions for AgentService_v2
 */

export class AgentHelpers {
  constructor() {
  }

  /**
   * Build a temporary history for the action model to make decisions.
   * This includes the last 3 special marker messages and recent execution details.
   */
  buildActionModelHistory(allMessages: BaseMessage[]): BaseMessage[] {
    // 1. Find the last 3 special marker messages (only from HumanMessages)
    const specialTags = [USER_INPUT_TAG, TAB_CONTEXT_MARKER, SYS_INFO_MARKER]
    const last3Special: BaseMessage[] = []
    for (let i = allMessages.length - 1; i >= 0 && last3Special.length < 3; i--) {
      const msg = allMessages[i]
      const content = msg.content
      if (msg.type === 'human' && typeof content === 'string' && specialTags.some(tag => content.includes(tag))) {
        last3Special.unshift(msg)
      }
    }

    // 2. Locate the very last USER_INPUT_TAG message to define the execution detail range
    let lastUserInputIndex = -1
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i]
      const content = m.content
      if (m.type === 'human' && typeof content === 'string' && content.includes(USER_INPUT_TAG)) {
        lastUserInputIndex = i
        break
      }
    }
    
    // 3. Get execution details: messages strictly AFTER the last USER_INPUT_TAG
    const executionDetails = lastUserInputIndex !== -1 
      ? allMessages.slice(lastUserInputIndex + 1) 
      : []

    const recentExecutionMsgs: BaseMessage[] = []
    if (executionDetails.length > 10) {
      recentExecutionMsgs.push(new HumanMessage({ content: '... (some execution details omitted) ...' }))
      recentExecutionMsgs.push(...executionDetails.slice(-10))
    } else {
      recentExecutionMsgs.push(...executionDetails)
    }

    // 4. Construct final message list for Action Model
    return [
      ...last3Special,
      ...recentExecutionMsgs
    ]
  }

  /**
   * Look up max tokens for a model name from settings
   */
  getMaxTokensForModel(modelName: string, settings: AppSettings | null): number {
    const DEFAULT_MAX_TOKENS = 200000
    if (!settings || !modelName || modelName === 'unknown') return DEFAULT_MAX_TOKENS

    // 1. Try to find the model in items
    const modelItem = settings.models.items.find(m => m.model === modelName)
    if (typeof modelItem?.maxTokens === 'number') return modelItem.maxTokens

    // 2. If not found by provider model name, it might be the display name
    const modelItemByName = settings.models.items.find(m => m.name === modelName)
    if (typeof modelItemByName?.maxTokens === 'number') return modelItemByName.maxTokens

    return DEFAULT_MAX_TOKENS
  }

  /**
   * Send an event to the Gateway EventBus.
   * The Gateway will handle UI history recording and frontend distribution.
   */
  sendEvent(sessionId: string, event: AgentEvent): void {
    if ((global as any).gateway) {
      (global as any).gateway.broadcast({
        type: 'agent:event',
        sessionId,
        payload: event
      });
    } else {
      // Fallback for initialization phase or tests
      const windows = BrowserWindow.getAllWindows()
      windows.forEach((window) => {
        window.webContents.send('agent:event', { sessionId, event })
      })
    }
  }

  /**
   * Extract plain text from LangChain message content.
   */
  extractText(content: any): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((c: any) => c?.text || '').join('')
    }
    return JSON.stringify(content)
  }

  /**
   * Strict JSON: model must output pure JSON only.
   */
  parseStrictJsonObject(text: string): unknown {
    const trimmed = (text || '').trim()
    // Try to find the first '{' and last '}' to handle potential markdown wrappers like ```json ... ```
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonCandidate = trimmed.substring(firstBrace, lastBrace + 1)
      try {
        return JSON.parse(jsonCandidate)
      } catch {
        // Fallback to parsing the whole string if extraction fails
      }
    }
    return JSON.parse(trimmed)
  }

  /**
   * Mark a message as ephemeral: do not persist and do not send to frontend.
   */
  markEphemeral<T extends any>(msg: T): T {
    ;(msg as any).additional_kwargs = {
      ...((msg as any).additional_kwargs || {}),
      _gyshellEphemeral: true
    }
    return msg
  }

  isEphemeral(msg: any): boolean {
    return !!msg?.additional_kwargs?._gyshellEphemeral
  }

  /**
   * Factory for creating ChatOpenAI instances
   */
  createChatModel(item: ModelDefinition, temperature: number): ChatOpenAI {
    return new ChatOpenAI({
      model: item.model,
      apiKey: item.apiKey,
      configuration: {
        baseURL: item.baseUrl
      },
      temperature,
      maxRetries: 0 // Disable built-in retry to use our custom logic
    })
  }

  /**
   * Custom retry logic for model invocation
   */
  async invokeWithRetry<T>(
    fn: (attempt: number) => Promise<T>,
    maxRetries: number = 4,
    delays: number[] = [1000, 2000, 4000, 6000],
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: any
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new Error('AbortError')
      }
      try {
        return await fn(attempt)
      } catch (error: any) {
        lastError = error
        
        // Never retry on user abort
        if (this.isAbortError(error)) {
          throw error
        }

        if (attempt < maxRetries - 1) {
          const delay = delays[attempt]
          console.warn(`[AgentService] Model invocation failed (Attempt ${attempt + 1}/${maxRetries}). Error: ${error.message}. Retrying in ${delay}ms...`)
          
          // Wait with signal support
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delay)
            const onAbort = () => {
              clearTimeout(timer)
              reject(new Error('AbortError'))
            }
            if (signal?.aborted) onAbort()
            signal?.addEventListener('abort', onAbort, { once: true })
          })
          continue
        }
      }
    }
    throw lastError
  }

  isRetryableError(error: any): boolean {
    // Legacy method, keeping for compatibility if needed elsewhere, 
    // but invokeWithRetry now retries almost everything as requested.
    if (this.isAbortError(error)) return false
    return true
  }

  /**
   * Extract deep error details from OpenAI/LangChain error objects
   */
  extractErrorDetails(error: any): string {
    let details = ''
    
    // 1. Try to get the structured error from OpenAI SDK
    if (error.error?.metadata?.raw) {
      try {
        const raw = typeof error.error.metadata.raw === 'string' 
          ? JSON.parse(error.error.metadata.raw) 
          : error.error.metadata.raw
        details += `Provider Error:\n${JSON.stringify(raw, null, 2)}\n\n`
      } catch {
        details += `Provider Error (Raw):\n${error.error.metadata.raw}\n\n`
      }
    } else if (error.error?.message) {
      details += `Provider Message: ${error.error.message}\n\n`
    }

    // 2. Add status and headers if available
    if (error.status) details += `Status: ${error.status}\n`
    
    // 3. Add the full stack trace
    details += `Stack Trace:\n${error.stack || error.toString()}`
    
    return details
  }

  computeReadFileSupport(
    globalProfile?: ModelDefinition['profile'],
    thinkingProfile?: ModelDefinition['profile']
  ): { image: boolean } {
    const image = Boolean(globalProfile?.imageInputs) && Boolean(thinkingProfile?.imageInputs)
    return { image }
  }

  /**
   * Filter built-in tools based on settings
   */
  getEnabledBuiltInTools(allTools: any[], enabledMap: Record<string, boolean>) {
    return allTools.filter((tool: any) => {
      const name = tool?.function?.name ?? tool?.name
      if (!name) return false
      const enabled = enabledMap[name]
      return enabled !== false
    })
  }

  isAbortError(error: unknown): boolean {
    if (!error) return false
    if (error instanceof Error) {
      return error.name === 'AbortError' || error.message === 'AbortError'
    }
    return false
  }
}
