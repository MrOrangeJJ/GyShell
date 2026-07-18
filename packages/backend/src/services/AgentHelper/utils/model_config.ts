import { ChatOpenAI } from '@langchain/openai'
import type { BackendSettings, ModelDefinition } from '../../../types'
import { createOpenAIClientConfiguration } from '../../openaiRequestParameters'
import { resolveBuiltInToolCapabilityName } from '../tool_capabilities'
import { BUILTIN_TOOL_INFO } from '../builtInToolMetadata'

export function createChatModel(item: ModelDefinition, temperature: number): ChatOpenAI {
  return new ChatOpenAI({
    model: item.model,
    apiKey: item.apiKey,
    configuration: createOpenAIClientConfiguration(item),
    __includeRawResponse: true,
    temperature,
    maxRetries: 0,
    modelKwargs: {}
  })
}

export function getMaxTokensForModel(modelName: string, settings: BackendSettings | null): number {
  const DEFAULT_MAX_TOKENS = 200000
  if (!settings || !modelName || modelName === 'unknown') return DEFAULT_MAX_TOKENS

  const modelItem = settings.models.items.find((m) => m.model === modelName)
  if (typeof modelItem?.maxTokens === 'number') return modelItem.maxTokens

  const modelItemByName = settings.models.items.find((m) => m.name === modelName)
  if (typeof modelItemByName?.maxTokens === 'number') return modelItemByName.maxTokens

  return DEFAULT_MAX_TOKENS
}

export function computeReadFileSupport(
  ...profiles: Array<ModelDefinition['profile'] | undefined>
): { image: boolean } {
  const image = profiles
    .filter((profile) => profile !== undefined)
    .every((profile) => profile?.imageInputs === true)
  return { image }
}

export function getEnabledBuiltInTools(allTools: any[], enabledMap: Record<string, boolean>) {
  return allTools.filter((tool: any) => {
    const name = tool?.function?.name ?? tool?.name
    if (!name) return false
    return isBuiltInToolEnabled(name, enabledMap)
  })
}

export function isBuiltInToolEnabled(
  toolName: string,
  enabledMap: Record<string, boolean>
): boolean {
  const capabilityName = resolveBuiltInToolCapabilityName(toolName)
  const configured = enabledMap[capabilityName]
  if (typeof configured === 'boolean') {
    return configured
  }
  const definition = BUILTIN_TOOL_INFO.find(
    (tool) => tool.name === capabilityName
  )
  return definition?.defaultEnabled ?? true
}
