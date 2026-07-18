import {
  normalizeModelRequestParameters,
  validateModelRequestParameters,
} from '@gyshell/shared'
import {
  createModelRequestFetch,
  mergeModelRequestBody,
} from './openaiRequestParameters'
import { createChatModel } from './AgentHelper/utils/model_config'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}. expected=${expectedJson} actual=${actualJson}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  await runCase('model parameters override generated defaults while runtime fields stay protected', () => {
    const body = mergeModelRequestBody(
      {
        model: 'provider-model',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function' }],
        stream: true,
        temperature: 0.1,
        top_p: 1,
      },
      {
        model: 'malicious-model',
        messages: [],
        stream: false,
        temperature: 0.75,
        top_p: 0.9,
        max_completion_tokens: 4096,
        reasoning_effort: 'high',
      },
    )

    assertEqual(body.model, 'provider-model', 'runtime model should win')
    assertEqual(body.stream, true, 'runtime streaming mode should win')
    assertEqual(body.temperature, 0.75, 'configured temperature should override role default')
    assertEqual(body.top_p, 0.9, 'configured top_p should override SDK default')
    assertEqual(body.max_completion_tokens, 4096, 'custom numeric fields should be forwarded')
    assertEqual(body.reasoning_effort, 'high', 'custom string fields should be forwarded')
    assertEqual((body.messages as unknown[]).length, 1, 'runtime messages should stay intact')
    assertEqual((body.tools as unknown[]).length, 1, 'runtime tools should stay intact')
  })

  await runCase('absence of a model override preserves the role temperature', () => {
    const body = mergeModelRequestBody(
      { model: 'model', messages: [], stream: true, temperature: 0.2 },
      { seed: 42 },
    )
    assertEqual(body.temperature, 0.2, 'role temperature should be inherited')
    assertEqual(body.seed, 42, 'unrelated custom fields should still be forwarded')
  })

  await runCase('validation removes protected and unsafe fields but preserves valid JSON', () => {
    const input = JSON.parse(
      '{"temperature":0.6,"tools":[],"metadata":{"safe":true,"__proto__":{"polluted":true}}}',
    )
    const validation = validateModelRequestParameters(input)
    assertEqual(validation.valid, false, 'protected and unsafe fields should be rejected')
    assertDeepEqual(
      normalizeModelRequestParameters(input),
      { temperature: 0.6 },
      'normalization should retain only safe fields',
    )
    assertEqual(
      ({} as { polluted?: boolean }).polluted,
      undefined,
      'normalization should not pollute object prototypes',
    )
  })

  await runCase('custom fetch changes only OpenAI-compatible POST request bodies', async () => {
    const captures: Array<{ input: string | URL | Request; init?: RequestInit }> = []
    const delegate: typeof globalThis.fetch = async (input, init) => {
      captures.push({ input, init })
      return new Response('{}', { status: 200 })
    }
    const requestFetch = createModelRequestFetch(
      {
        temperature: 0.8,
        custom_router: { route: 'fast', fallbacks: ['safe'] },
      },
      delegate,
    )

    await requestFetch('https://provider.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '1',
      },
      body: JSON.stringify({
        model: 'model',
        messages: [],
        stream: true,
        temperature: 0.1,
      }),
    })
    await requestFetch('https://provider.test/v1/models', { method: 'GET' })

    const first = captures[0]
    const firstBody = JSON.parse(String(first.init?.body)) as Record<string, unknown>
    const firstHeaders = new Headers(first.init?.headers)
    assertEqual(firstBody.temperature, 0.8, 'POST body should receive configured parameters')
    assertDeepEqual(
      firstBody.custom_router,
      { route: 'fast', fallbacks: ['safe'] },
      'nested custom JSON should be preserved',
    )
    assertEqual(firstHeaders.has('content-length'), false, 'stale content length should be removed')
    assertEqual(captures[1].init?.body, undefined, 'GET requests should pass through unchanged')
  })

  await runCase('responses API requests use the same merge contract', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const delegate: typeof globalThis.fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response('{}', { status: 200 })
    }
    const requestFetch = createModelRequestFetch(
      { temperature: 0.4, service_tier: 'flex', input: 'blocked' },
      delegate,
    )
    await requestFetch('https://provider.test/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'model', input: 'runtime-input', stream: true }),
    })

    assertEqual(capturedBody?.input, 'runtime-input', 'Responses input should stay protected')
    assertEqual(capturedBody?.temperature, 0.4, 'Responses custom temperature should be applied')
    assertEqual(capturedBody?.service_tier, 'flex', 'Responses custom fields should be applied')
  })

  await runCase('the shared ChatOpenAI factory installs the final-body transport', async () => {
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response('{}', { status: 200 })
    }

    try {
      const model = createChatModel(
        {
          id: 'model-1',
          name: 'Model',
          model: 'provider-model',
          apiKey: 'test-key',
          baseUrl: 'https://provider.test/v1',
          maxTokens: 128000,
          requestParameters: { temperature: 0.55, seed: 9 },
          supportsStructuredOutput: false,
          supportsObjectToolChoice: false,
        },
        0.1,
      )
      const configuredFetch = (model as unknown as {
        clientConfig: { fetch?: typeof globalThis.fetch }
      }).clientConfig.fetch

      assertEqual(model.temperature, 0.1, 'factory should retain the role default on the model')
      assertEqual(typeof configuredFetch, 'function', 'factory should install the request transport')
      await configuredFetch?.('https://provider.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'provider-model',
          messages: [],
          stream: true,
          temperature: 0.1,
        }),
      })
      assertEqual(capturedBody?.temperature, 0.55, 'transport should apply the model override')
      assertEqual(capturedBody?.seed, 9, 'transport should forward custom model fields')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
