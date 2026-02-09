export function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message === 'AbortError'
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
      if (isAbortError(error)) {
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
  return !isAbortError(error)
}

export function extractErrorDetails(error: any): string {
  let details = ''

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

  if (error.status) details += `Status: ${error.status}\n`
  details += `Stack Trace:\n${error.stack || error.toString()}`
  return details
}
