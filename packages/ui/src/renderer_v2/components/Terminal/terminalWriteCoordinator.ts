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
  private deferredWrites: DeferredTerminalWrite[] = []
  private disposed = false

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

  write(data: string, transition?: TerminalWriteTransition): void {
    if (this.disposed || (!data && !transition)) return
    if (
      this.refitBarrierActive ||
      this.deferredWrites.length > 0 ||
      (transition !== undefined &&
        transition.key !== this.activeTransitionKey &&
        this.pendingWriteCount > 0)
    ) {
      this.deferredWrites.push({ data, transition })
      return
    }

    this.dispatchWrite(data, transition)
  }

  private dispatchWrite(
    data: string,
    transition?: TerminalWriteTransition
  ): void {
    if (transition && transition.key !== this.activeTransitionKey) {
      transition.apply()
      this.activeTransitionKey = transition.key
    }
    if (!data) {
      this.flushDeferredWrites()
      return
    }

    this.pendingWriteCount += 1
    let completed = false
    const complete = (): void => {
      if (completed) return
      completed = true
      this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1)
      if (this.pendingWriteCount === 0) {
        this.drainHandler?.()
        this.flushDeferredWrites()
      }
    }

    try {
      this.writer(data, complete)
    } catch (error) {
      complete()
      throw error
    }
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
    while (this.deferredWrites.length > 0) {
      const next = this.deferredWrites[0]
      const nextKey = next.transition?.key ?? groupKey
      if (nextKey !== groupKey) break
      data += this.deferredWrites.shift()!.data
    }
    this.dispatchWrite(data, first.transition)
  }

  dispose(): void {
    this.disposed = true
    this.refitBarrierActive = false
    this.deferredWrites = []
    this.drainHandler = undefined
  }
}
