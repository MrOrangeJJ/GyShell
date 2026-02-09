import { ChatOpenAI } from '@langchain/openai'
import type { BaseMessage } from '@langchain/core/messages'
import type { AgentEvent, ModelDefinition, AppSettings } from '../../types'
import { buildActionModelHistory } from './utils/action_model_history'
import { sendAgentEvent, extractText, parseStrictJsonObject, isEphemeral, markEphemeral } from './utils/common'
import { createChatModel, getMaxTokensForModel, computeReadFileSupport, getEnabledBuiltInTools } from './utils/model_config'
import { invokeWithRetry, isAbortError, isRetryableError, extractErrorDetails } from './utils/runtime'

/**
 * Helper functions for AgentService_v2
 */

export class AgentHelpers {
  constructor() {}

  /**
   * Build a temporary history for the action model to make decisions.
   * This includes the last 3 special marker messages and recent execution details.
   */
  buildActionModelHistory(allMessages: BaseMessage[]): BaseMessage[] {
    return buildActionModelHistory(allMessages)
  }

  /**
   * Look up max tokens for a model name from settings
   */
  getMaxTokensForModel(modelName: string, settings: AppSettings | null): number {
    return getMaxTokensForModel(modelName, settings)
  }

  /**
   * Send an event to the Gateway EventBus.
   * The Gateway will handle UI history recording and frontend distribution.
   */
  sendEvent(sessionId: string, event: AgentEvent): void {
    sendAgentEvent(sessionId, event)
  }

  /**
   * Extract plain text from LangChain message content.
   */
  extractText(content: any): string {
    return extractText(content)
  }

  /**
   * Strict JSON: model must output pure JSON only.
   */
  parseStrictJsonObject(text: string): unknown {
    return parseStrictJsonObject(text)
  }

  /**
   * Mark a message as ephemeral: do not persist and do not send to frontend.
   */
  markEphemeral<T extends any>(msg: T): T {
    return markEphemeral(msg)
  }

  isEphemeral(msg: any): boolean {
    return isEphemeral(msg)
  }

  /**
   * Factory for creating ChatOpenAI instances
   */
  createChatModel(item: ModelDefinition, temperature: number): ChatOpenAI {
    return createChatModel(item, temperature)
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
    return await invokeWithRetry(fn, maxRetries, delays, signal)
  }

  isRetryableError(error: any): boolean {
    return isRetryableError(error)
  }

  /**
   * Extract deep error details from OpenAI/LangChain error objects
   */
  extractErrorDetails(error: any): string {
    return extractErrorDetails(error)
  }

  computeReadFileSupport(
    globalProfile?: ModelDefinition['profile'],
    thinkingProfile?: ModelDefinition['profile']
  ): { image: boolean } {
    return computeReadFileSupport(globalProfile, thinkingProfile)
  }

  /**
   * Filter built-in tools based on settings
   */
  getEnabledBuiltInTools(allTools: any[], enabledMap: Record<string, boolean>) {
    return getEnabledBuiltInTools(allTools, enabledMap)
  }

  isAbortError(error: unknown): boolean {
    return isAbortError(error)
  }
}
