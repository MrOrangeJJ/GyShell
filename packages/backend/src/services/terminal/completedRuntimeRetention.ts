export const DEFAULT_COMPLETED_RUNTIME_RETENTION_MS = 30_000

export interface CompletedRuntimeWithEviction {
  completedRuntimeEvictionTimer?: ReturnType<typeof setTimeout>
}

const clearRuntimeEvictionTimer = (
  runtime: CompletedRuntimeWithEviction,
): void => {
  if (!runtime.completedRuntimeEvictionTimer) return
  clearTimeout(runtime.completedRuntimeEvictionTimer)
  runtime.completedRuntimeEvictionTimer = undefined
}

/**
 * Keeps a completed runtime available long enough for a late subscriber while
 * placing a hard upper bound on retained PTY/SSH state and buffered output.
 */
export const scheduleCompletedRuntimeEviction = <
  T extends CompletedRuntimeWithEviction,
>(
  runtimes: Map<string, T>,
  runtimeId: string,
  runtime: T,
  retentionMs = DEFAULT_COMPLETED_RUNTIME_RETENTION_MS,
): void => {
  const previousRuntime = runtimes.get(runtimeId)
  if (previousRuntime && previousRuntime !== runtime) {
    clearRuntimeEvictionTimer(previousRuntime)
  }
  clearRuntimeEvictionTimer(runtime)
  const timer = setTimeout(() => {
    if (runtimes.get(runtimeId) === runtime) {
      runtimes.delete(runtimeId)
    }
    runtime.completedRuntimeEvictionTimer = undefined
  }, Math.max(1, retentionMs))
  const unref = (timer as ReturnType<typeof setTimeout> & {
    unref?: () => void
  }).unref
  unref?.call(timer)
  runtime.completedRuntimeEvictionTimer = timer
}

export const deleteCompletedRuntime = <
  T extends CompletedRuntimeWithEviction,
>(
  runtimes: Map<string, T>,
  runtimeId: string,
): boolean => {
  const runtime = runtimes.get(runtimeId)
  if (!runtime) return false
  clearRuntimeEvictionTimer(runtime)
  return runtimes.delete(runtimeId)
}
