import { ChatOpenAI } from '@langchain/openai'
import type { AppSettings, ModelDefinition } from '../../../types'

export function createChatModel(item: ModelDefinition, temperature: number): ChatOpenAI {
  return new ChatOpenAI({
    model: item.model,
    apiKey: item.apiKey,
    configuration: {
      baseURL: item.baseUrl
    },
    __includeRawResponse: true,
    temperature,
    maxRetries: 0,
    modelKwargs: {
    }
  })
}

export function getMaxTokensForModel(modelName: string, settings: AppSettings | null): number {
  const DEFAULT_MAX_TOKENS = 200000
  if (!settings || !modelName || modelName === 'unknown') return DEFAULT_MAX_TOKENS

  const modelItem = settings.models.items.find((m) => m.model === modelName)
  if (typeof modelItem?.maxTokens === 'number') return modelItem.maxTokens

  const modelItemByName = settings.models.items.find((m) => m.name === modelName)
  if (typeof modelItemByName?.maxTokens === 'number') return modelItemByName.maxTokens

  return DEFAULT_MAX_TOKENS
}

export function computeReadFileSupport(
  globalProfile?: ModelDefinition['profile'],
  thinkingProfile?: ModelDefinition['profile']
): { image: boolean } {
  const image = Boolean(globalProfile?.imageInputs) && Boolean(thinkingProfile?.imageInputs)
  return { image }
}

export function getEnabledBuiltInTools(allTools: any[], enabledMap: Record<string, boolean>) {
  return allTools.filter((tool: any) => {
    const name = tool?.function?.name ?? tool?.name
    if (!name) return false
    const enabled = enabledMap[name]
    return enabled !== false
  })
}
