import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import type { ModelDefinition } from '../types'

export interface ModelCapabilityProfile {
  imageInputs: boolean
  testedAt: number
  ok: boolean
  error?: string
}

const TINY_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
export class ModelCapabilityService {
  async probe(model: ModelDefinition): Promise<ModelCapabilityProfile> {
    const testedAt = Date.now()
    if (!model.model || !model.apiKey) {
      return {
        imageInputs: false,
        testedAt,
        ok: false,
        error: 'Missing model or apiKey'
      }
    }

    const client = new ChatOpenAI({
      model: model.model,
      apiKey: model.apiKey,
      configuration: {
        baseURL: model.baseUrl
      },
      temperature: 0,
      maxTokens: 1
    })

    const result: ModelCapabilityProfile = {
      imageInputs: false,
      testedAt,
      ok: true
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)

    try {
      await client.invoke([new HumanMessage('.')], { signal: controller.signal })
    } catch (err) {
      clearTimeout(timer)
      return {
        imageInputs: false,
        testedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }

    try {
      await client.invoke(
        [
          new HumanMessage({
            content: [
              { type: 'text', text: '.' },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${TINY_IMAGE_BASE64}` }
              }
            ]
          })
        ],
        { signal: controller.signal }
      )
      result.imageInputs = true
    } catch {
      result.imageInputs = false
    }

    try {
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}
