export function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message === 'AbortError'
  }
  return false
}

const CONTEXT_WINDOW_ERROR_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'max_context_length_exceeded',
  'prompt_too_long',
  'input_too_long',
])

const CONTEXT_WINDOW_MESSAGE_PATTERNS = [
  /\bmaximum context(?: window)? length\b[\s\S]{0,240}\b(?:requested|resulted in|input|prompt|messages?)\b[\s\S]{0,160}\btokens?\b/i,
  /\b(?:input|request|prompt|messages?)\b[\s\S]{0,120}\bexceeds?\b[\s\S]{0,100}\bcontext window\b/i,
  /\b(?:input|prompt|messages?)\b[\s\S]{0,120}\bexceeds?\b[\s\S]{0,120}\b(?:maximum|max) context(?: window)? length\b/i,
  /\bcontext[_ -](?:window[_ -])?length[_ -](?:is[_ -])?exceeded\b/i,
  /\bprompt is too long\b/i,
  /\binput (?:is )?too long\b[\s\S]{0,100}\b(?:context|tokens?|model)\b/i,
  /\binput token count\b[\s\S]{0,160}\bexceeds?\b[\s\S]{0,120}\bmaximum\b/i,
]

const CONTEXT_ERROR_NESTED_KEYS = [
  'message',
  'code',
  'type',
  'error',
  'errors',
  'body',
  'data',
  'response',
  'metadata',
  'raw',
  'cause',
  'statusText',
] as const

/**
 * Identifies only high-confidence provider rejections caused by input context
 * size. HTTP 400/413 and `invalid_request_error` are intentionally not enough:
 * those statuses also cover malformed tools, bad parameters, and other errors
 * that compaction cannot repair.
 */
export function isContextWindowExceededError(error: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ]
  const visited = new Set<object>()
  let inspectedNodes = 0

  while (pending.length > 0 && inspectedNodes < 80) {
    const entry = pending.shift()!
    const value = entry.value
    inspectedNodes += 1

    if (typeof value === 'string') {
      const text = value.slice(0, 30_000)
      const normalized = text.trim().toLowerCase()
      if (CONTEXT_WINDOW_ERROR_CODES.has(normalized)) return true
      if (
        CONTEXT_WINDOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))
      ) {
        return true
      }

      if (
        entry.depth < 6 &&
        text.length <= 100_000 &&
        /^[\s]*[\[{]/.test(text)
      ) {
        try {
          pending.push({ value: JSON.parse(text), depth: entry.depth + 1 })
        } catch {
          // Provider metadata.raw is often plain text rather than JSON.
        }
      }
      continue
    }

    if (!value || typeof value !== 'object' || entry.depth >= 6) continue
    if (visited.has(value)) continue
    visited.add(value)

    if (Array.isArray(value)) {
      value.slice(0, 16).forEach((item) => {
        pending.push({ value: item, depth: entry.depth + 1 })
      })
      continue
    }

    if (value instanceof Error) {
      pending.push({ value: value.message, depth: entry.depth + 1 })
      const cause = (value as Error & { cause?: unknown }).cause
      if (cause !== undefined) {
        pending.push({ value: cause, depth: entry.depth + 1 })
      }
    }

    for (const key of CONTEXT_ERROR_NESTED_KEYS) {
      try {
        const nested = (value as Record<string, unknown>)[key]
        if (nested !== undefined) {
          pending.push({ value: nested, depth: entry.depth + 1 })
        }
      } catch {
        // Ignore provider objects with throwing property accessors.
      }
    }
  }

  return false
}

export async function invokeWithRetry<T>(
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
      if (isAbortError(error) || isContextWindowExceededError(error)) {
        throw error
      }

      if (attempt < maxRetries - 1) {
        const delay = delays[attempt]
        console.warn(`[AgentService] Model invocation failed (Attempt ${attempt + 1}/${maxRetries}). Error: ${error.message}. Retrying in ${delay}ms...`)
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

export function isRetryableError(error: unknown): boolean {
  return !isAbortError(error) && !isContextWindowExceededError(error)
}

export function extractErrorDetails(error: any): string {
  let details = ''

  if (error.error?.metadata?.raw) {
    try {
      const raw =
        typeof error.error.metadata.raw === 'string'
          ? JSON.parse(error.error.metadata.raw)
          : error.error.metadata.raw
      details += `Provider Error:\n${JSON.stringify(raw, null, 2)}\n\n`
    } catch {
      details += `Provider Error (Raw):\n${error.error.metadata.raw}\n\n`
    }
  } else if (error.error?.message) {
    details += `Provider Message: ${error.error.message}\n\n`
  }

  if (error.status) details += `Status: ${error.status}\n`
  details += `Stack Trace:\n${error.stack || error.toString()}`
  return details
}
