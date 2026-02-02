import { BrowserWindow } from 'electron'
import { ChatOpenAI } from '@langchain/openai'
import type { AgentEvent, ModelDefinition, AppSettings } from '../../types'

/**
 * Helper functions for AgentService_v2
 */

export class AgentHelpers {
  constructor() {
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
      temperature
    })
  }

  /**
   * Compute read file support based on model profiles
   */
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
