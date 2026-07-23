export type TerminalDataWriter = (
  data: string,
  callback: () => void,
) => void

export interface TerminalWriteTransition {
  key: string
  apply: () => void
}

interface DeferredTerminalWrite {
  data: string
  transition?: TerminalWriteTransition
  completions: Array<() => void>
  failures: Array<(error: Error) => void>
}

const MAX_XTERM_WRITE_CHUNK_CODE_UNITS = 64 * 1024

const splitTerminalWrite = (data: string): string[] => {
  if (data.length <= MAX_XTERM_WRITE_CHUNK_CODE_UNITS) return [data]
  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(
      data.length,
      start + MAX_XTERM_WRITE_CHUNK_CODE_UNITS
    )
    if (
      end < data.length &&
      end > start &&
      data.charCodeAt(end - 1) >= 0xd800 &&
      data.charCodeAt(end - 1) <= 0xdbff &&
      data.charCodeAt(end) >= 0xdc00 &&
      data.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1
    }
    chunks.push(data.slice(start, end))
    start = end
  }
  return chunks
}

/**
 * Exposes xterm's asynchronous write drain point to the layout coordinator.
 * Stable xterm 6.0 must not be fitted while an older-size write is pending.
 * Once a refit is fenced, later writes are held briefly so continuous output
 * cannot starve the resize. Parser-mode transitions are fenced the same way so
 * they cannot overtake bytes already queued inside xterm.
 */
export class TerminalWriteCoordinator {
  private pendingWriteCount = 0
  private refitBarrierActive = false
  private drainHandler: (() => void) | undefined
  private failureHandler: ((error: Error) => void) | undefined
  private deferredWrites: DeferredTerminalWrite[] = []
  private chunkedWriteActive = false
  private failed = false
  private disposed = false
  private readonly drainWaiters = new Set<(drained: boolean) => void>()

  constructor(
    private readonly writer: TerminalDataWriter,
    private activeTransitionKey = 'unknown'
  ) {}

  get hasPendingWrites(): boolean {
    return this.pendingWriteCount > 0
  }

  get isRefitBarrierActive(): boolean {
    return this.refitBarrierActive
  }

  setDrainHandler(handler: (() => void) | undefined): void {
    this.drainHandler = handler
  }

  setFailureHandler(handler: ((error: Error) => void) | undefined): void {
    this.failureHandler = handler
  }

  waitForDrain(timeoutMs = 0): Promise<boolean> {
    if (this.pendingWriteCount === 0) {
      return Promise.resolve(true)
    }
    if (this.disposed) {
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (drained: boolean): void => {
        if (timer) clearTimeout(timer)
        this.drainWaiters.delete(finish)
        resolve(drained)
      }
      this.drainWaiters.add(finish)
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(false), timeoutMs)
      }
    })
  }

  write(
    data: string,
    transition?: TerminalWriteTransition,
    completion?: () => void,
    failure?: (error: Error) => void
  ): void {
    if (this.disposed || this.failed) {
      return
    }
    if (!data && !transition) {
      completion?.()
      return
    }
    if (
      this.refitBarrierActive ||
      this.deferredWrites.length > 0 ||
      this.chunkedWriteActive ||
      (transition !== undefined &&
        transition.key !== this.activeTransitionKey &&
        this.pendingWriteCount > 0)
    ) {
      this.deferredWrites.push({
        data,
        transition,
        completions: completion ? [completion] : [],
        failures: failure ? [failure] : []
      })
      return
    }

    this.dispatchWrite(
      data,
      transition,
      completion ? [completion] : [],
      failure ? [failure] : []
    )
  }

  private dispatchWrite(
    data: string,
    transition?: TerminalWriteTransition,
    completions: Array<() => void> = [],
    failures: Array<(error: Error) => void> = []
  ): void {
    if (transition && transition.key !== this.activeTransitionKey) {
      transition.apply()
      this.activeTransitionKey = transition.key
    }
    if (!data) {
      completions.forEach((completion) => completion())
      this.flushDeferredWrites()
      return
    }

    this.pendingWriteCount += 1
    const chunks = splitTerminalWrite(data)
    const isChunkedWrite = chunks.length > 1
    if (isChunkedWrite) {
      this.chunkedWriteActive = true
    }
    let chunkIndex = 0
    let completed = false
    const complete = (): void => {
      if (completed) return
      completed = true
      if (isChunkedWrite) {
        this.chunkedWriteActive = false
      }
      this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1)
      completions.forEach((completion) => {
        try {
          completion()
        } catch (error) {
          console.warn('[TerminalWriteCoordinator] completion failed:', error)
        }
      })
      if (this.pendingWriteCount === 0) {
        this.drainHandler?.()
        this.resolveDrainWaiters(true)
        if (!this.failed) {
          this.flushDeferredWrites()
        }
      }
    }

    const fail = (error: unknown): void => {
      if (completed) return
      completed = true
      this.failed = true
      if (isChunkedWrite) {
        this.chunkedWriteActive = false
      }
      this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1)
      this.deferredWrites = []
      const normalizedError =
        error instanceof Error ? error : new Error(String(error))
      failures.forEach((failure) => {
        try {
          failure(normalizedError)
        } catch (failureError) {
          console.warn(
            '[TerminalWriteCoordinator] failure callback failed:',
            failureError
          )
        }
      })
      try {
        this.failureHandler?.(normalizedError)
      } catch (failureError) {
        console.warn(
          '[TerminalWriteCoordinator] terminal failure handler failed:',
          failureError
        )
      }
      this.drainHandler?.()
      if (this.pendingWriteCount === 0) {
        this.resolveDrainWaiters(true)
      }
    }

    const writeNextChunk = (): void => {
      if (completed) return
      const chunk = chunks[chunkIndex]
      if (chunk === undefined) {
        complete()
        return
      }
      chunkIndex += 1
      try {
        this.writer(chunk, writeNextChunk)
      } catch (error) {
        console.error('[TerminalWriteCoordinator] xterm write failed:', error)
        fail(error)
      }
    }
    writeNextChunk()
  }

  beginRefitBarrier(): void {
    if (this.disposed) return
    this.refitBarrierActive = true
  }

  endRefitBarrier(): void {
    if (this.disposed || !this.refitBarrierActive) return
    this.refitBarrierActive = false
    this.flushDeferredWrites()
  }

  private flushDeferredWrites(): void {
    if (
      this.disposed ||
      this.refitBarrierActive ||
      this.pendingWriteCount > 0 ||
      this.deferredWrites.length === 0
    ) {
      return
    }

    const first = this.deferredWrites.shift()!
    const groupKey = first.transition?.key ?? this.activeTransitionKey
    let data = first.data
    const completions = [...first.completions]
    const failures = [...first.failures]
    while (this.deferredWrites.length > 0) {
      const next = this.deferredWrites[0]
      const nextKey = next.transition?.key ?? groupKey
      if (nextKey !== groupKey) break
      const grouped = this.deferredWrites.shift()!
      data += grouped.data
      completions.push(...grouped.completions)
      failures.push(...grouped.failures)
    }
    this.dispatchWrite(data, first.transition, completions, failures)
  }

  private resolveDrainWaiters(drained: boolean): void {
    for (const resolve of this.drainWaiters) {
      resolve(drained)
    }
    this.drainWaiters.clear()
  }

  dispose(): void {
    this.disposed = true
    this.refitBarrierActive = false
    this.deferredWrites = []
    this.drainHandler = undefined
    this.failureHandler = undefined
    this.resolveDrainWaiters(false)
  }
}
