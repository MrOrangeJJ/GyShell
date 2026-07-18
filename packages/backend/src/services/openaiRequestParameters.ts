import {
  MODEL_REQUEST_PROTECTED_KEYS,
  normalizeModelRequestParameters,
  type ModelRequestParameters,
} from '@gyshell/shared'
import type { ModelDefinition } from '../types'

type OpenAIRequestModel = Pick<ModelDefinition, 'baseUrl' | 'requestParameters'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isModelRequestEndpoint(input: string | URL | Request): boolean {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  try {
    const pathname = new URL(rawUrl, 'http://gyshell.local').pathname.replace(/\/+$/, '')
    return pathname.endsWith('/chat/completions') || pathname.endsWith('/responses')
  } catch {
    return false
  }
}

function stripContentLength(headers: RequestInit['headers'] | undefined): Headers {
  const next = new Headers(headers)
  next.delete('content-length')
  return next
}

export function mergeModelRequestBody(
  runtimeBody: unknown,
  configuredParameters: unknown,
): Record<string, unknown> {
  if (!isRecord(runtimeBody)) {
    throw new TypeError('OpenAI request body must be a JSON object')
  }

  const configured = normalizeModelRequestParameters(configuredParameters)
  const merged: Record<string, unknown> = {
    ...runtimeBody,
    ...configured,
  }

  for (const key of MODEL_REQUEST_PROTECTED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(runtimeBody, key)) {
      merged[key] = runtimeBody[key]
    } else {
      delete merged[key]
    }
  }
  return merged
}

export function createModelRequestFetch(
  configuredParameters: ModelRequestParameters | undefined,
  delegate: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const normalized = normalizeModelRequestParameters(configuredParameters)
  if (Object.keys(normalized).length === 0) return delegate

  return async (input, init) => {
    const inputMethod =
      typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET'
    const method = String(init?.method ?? inputMethod).toUpperCase()
    if (
      method !== 'POST' ||
      !isModelRequestEndpoint(input) ||
      typeof init?.body !== 'string'
    ) {
      return delegate(input, init)
    }

    let runtimeBody: unknown
    try {
      runtimeBody = JSON.parse(init.body)
    } catch {
      return delegate(input, init)
    }

    const body = JSON.stringify(mergeModelRequestBody(runtimeBody, normalized))
    return delegate(input, {
      ...init,
      body,
      headers: stripContentLength(init.headers),
    })
  }
}

export function createOpenAIClientConfiguration(model: OpenAIRequestModel) {
  const requestParameters = normalizeModelRequestParameters(model.requestParameters)
  return {
    baseURL: model.baseUrl,
    ...(Object.keys(requestParameters).length > 0
      ? { fetch: createModelRequestFetch(requestParameters) }
      : {}),
  }
}
