import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import type { ModelDefinition } from '../types'

export interface ModelCapabilityProfile {
  imageInputs: boolean
  textOutputs: boolean
  testedAt: number
  ok: boolean
  error?: string
}

const TINY_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const PROBE_TIMEOUT_MS = 8000
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

interface ProbeStepResult {
  ok: boolean
  error?: string
}

export class ModelCapabilityService {
  async probe(model: ModelDefinition): Promise<ModelCapabilityProfile> {
    const testedAt = Date.now()
    if (!model.model || !model.apiKey) {
      return {
        imageInputs: false,
        textOutputs: false,
        testedAt,
        ok: false,
        error: 'Missing model or apiKey'
      }
    }

    const textCheck = await this.checkTextOutputs(model)

    if (textCheck.ok) {
      const imageCheck = await this.checkImageInputs(model)
      const errors: string[] = []
      if (!imageCheck.ok && imageCheck.error) errors.push(`image: ${imageCheck.error}`)
      return {
        imageInputs: imageCheck.ok,
        textOutputs: true,
        testedAt,
        ok: true,
        error: errors.length > 0 ? errors.join(' | ') : undefined
      }
    }

    const activeCheck = await this.checkActiveByModelsEndpoint(model)
    const errors: string[] = []
    if (textCheck.error) errors.push(`text: ${textCheck.error}`)
    if (!activeCheck.ok && activeCheck.error) errors.push(`active: ${activeCheck.error}`)

    return {
      imageInputs: false,
      textOutputs: false,
      testedAt,
      ok: activeCheck.ok,
      error: errors.length > 0 ? errors.join(' | ') : undefined
    }
  }

  private createProbeClient(model: ModelDefinition): ChatOpenAI {
    return new ChatOpenAI({
      model: model.model,
      apiKey: model.apiKey,
      configuration: {
        baseURL: model.baseUrl
      },
      temperature: 0,
      maxTokens: 1
    })
  }

  private buildModelsEndpoint(baseUrl?: string): string {
    const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
    if (!normalized) return `${DEFAULT_OPENAI_BASE_URL}/models`
    if (/\/v1$/i.test(normalized)) return `${normalized}/models`
    return `${normalized}/v1/models`
  }

  private async checkActiveByModelsEndpoint(model: ModelDefinition): Promise<ProbeStepResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    const endpoint = this.buildModelsEndpoint(model.baseUrl)

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${model.apiKey || ''}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      })

      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status} ${response.statusText}`.trim()
        }
      }

      const payload = await response.json().catch(() => undefined)
      const data = payload && typeof payload === 'object' ? (payload as any).data : undefined
      if (Array.isArray(data) && data.length > 0) {
        const listed = data.some((item: any) => item && typeof item.id === 'string' && item.id === model.model)
        if (!listed) {
          return { ok: false, error: `Model "${model.model}" not found in /v1/models` }
        }
      }

      return { ok: true }
    } catch (err) {
      if (this.isAbortError(err)) {
        return { ok: false, error: `Timeout after ${PROBE_TIMEOUT_MS}ms` }
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async checkTextOutputs(model: ModelDefinition): Promise<ProbeStepResult> {
    const client = this.createProbeClient(model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

    try {
      await client.invoke([new HumanMessage('.')], { signal: controller.signal })
      return { ok: true }
    } catch (err) {
      if (this.isAbortError(err)) {
        return { ok: false, error: `Timeout after ${PROBE_TIMEOUT_MS}ms` }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private async checkImageInputs(model: ModelDefinition): Promise<ProbeStepResult> {
    const client = this.createProbeClient(model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

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
      return { ok: true }
    } catch (err) {
      if (this.isAbortError(err)) {
        return { ok: false, error: `Timeout after ${PROBE_TIMEOUT_MS}ms` }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private isAbortError(err: unknown): boolean {
    if (!err) return false
    if (err instanceof Error) {
      return err.name === 'AbortError' || err.message === 'AbortError'
    }
    return false
  }
}
