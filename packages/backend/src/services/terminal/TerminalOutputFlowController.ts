const DEFAULT_CHUNK_SIZE = 64 * 1024
const DEFAULT_HIGH_WATERMARK = 256 * 1024
const DEFAULT_LOW_WATERMARK = 64 * 1024

interface OutputFrame {
  sequence: number
  cost: number
  headlessPending: boolean
  rendererConsumers: Set<string>
  onHeadlessDrained?: () => void
}

interface HeadlessChunk {
  data: string
  frame: OutputFrame
  isLast: boolean
}

export interface TerminalOutputFlowControllerOptions {
  runtimeGeneration: number
  writeHeadless?: (data: string, callback: () => void) => void
  pauseSource?: () => void
  resumeSource?: () => void
  onHeadlessFailure: (error: Error) => void
  chunkSize?: number
  highWatermark?: number
  lowWatermark?: number
}

export interface TerminalOutputFrameInput {
  sourceCost: number
  headlessData?: string
  hasVisibleData: boolean
  onHeadlessDrained?: () => void
  publishVisible?: (sequence: number, runtimeGeneration: number) => void
}

const splitWithoutBreakingSurrogatePair = (
  input: string,
  maxCodeUnits: number
): string[] => {
  if (!input) return []
  const chunks: string[] = []
  let start = 0
  while (start < input.length) {
    let end = Math.min(input.length, start + maxCodeUnits)
    if (
      end < input.length &&
      end > start &&
      input.charCodeAt(end - 1) >= 0xd800 &&
      input.charCodeAt(end - 1) <= 0xdbff &&
      input.charCodeAt(end) >= 0xdc00 &&
      input.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1
    }
    if (end <= start) {
      end = Math.min(input.length, start + maxCodeUnits + 1)
    }
    chunks.push(input.slice(start, end))
    start = end
  }
  return chunks
}

/**
 * Bounds source output by the parser drain points of the backend headless
 * xterm and every attached visible xterm. enqueue() is deliberately no-throw:
 * parser failures are isolated from node-pty/ssh2 producer callback stacks.
 */
export class TerminalOutputFlowController {
  readonly runtimeGeneration: number

  private readonly writeHeadless?: (
    data: string,
    callback: () => void
  ) => void
  private readonly pauseSource?: () => void
  private readonly resumeSource?: () => void
  private readonly onHeadlessFailure: (error: Error) => void
  private readonly chunkSize: number
  private readonly highWatermark: number
  private readonly lowWatermark: number
  private readonly activeRendererConsumers = new Set<string>()
  private readonly frames: OutputFrame[] = []
  private readonly headlessChunks: HeadlessChunk[] = []
  private frameHead = 0
  private headlessChunkHead = 0
  private nextSequence = 0
  private outstandingCost = 0
  private headlessWritePending = false
  private sourcePaused = false
  private failed = false
  private disposed = false
  private readonly drainWaiters = new Set<(drained: boolean) => void>()

  constructor(options: TerminalOutputFlowControllerOptions) {
    this.runtimeGeneration = options.runtimeGeneration
    this.writeHeadless = options.writeHeadless
    this.pauseSource = options.pauseSource
    this.resumeSource = options.resumeSource
    this.onHeadlessFailure = options.onHeadlessFailure
    this.chunkSize = Math.max(1024, options.chunkSize ?? DEFAULT_CHUNK_SIZE)
    this.highWatermark = Math.max(
      this.chunkSize,
      options.highWatermark ?? DEFAULT_HIGH_WATERMARK
    )
    this.lowWatermark = Math.max(
      0,
      Math.min(
        this.highWatermark,
        options.lowWatermark ?? DEFAULT_LOW_WATERMARK
      )
    )
  }

  get pendingCost(): number {
    return this.outstandingCost
  }

  get isSourcePaused(): boolean {
    return this.sourcePaused
  }

  attachRendererConsumer(consumerId: string): void {
    if (this.disposed || this.failed || !consumerId) return
    this.activeRendererConsumers.add(consumerId)
  }

  detachRendererConsumer(consumerId: string): void {
    if (!consumerId) return
    this.activeRendererConsumers.delete(consumerId)
    for (let index = this.frameHead; index < this.frames.length; index += 1) {
      this.frames[index].rendererConsumers.delete(consumerId)
    }
    this.releaseCommittedFrames()
  }

  acknowledgeRenderer(consumerId: string, sequence: number): void {
    if (
      this.disposed ||
      this.failed ||
      !this.activeRendererConsumers.has(consumerId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      return
    }
    for (let index = this.frameHead; index < this.frames.length; index += 1) {
      const frame = this.frames[index]
      if (frame.sequence > sequence) break
      frame.rendererConsumers.delete(consumerId)
    }
    this.releaseCommittedFrames()
  }

  enqueue(input: TerminalOutputFrameInput): number {
    if (this.disposed || this.failed) return 0
    const sequence = ++this.nextSequence
    const headlessData = input.headlessData || ''
    const frame: OutputFrame = {
      sequence,
      cost: Math.max(1, Math.floor(input.sourceCost || 0)),
      headlessPending: Boolean(headlessData && this.writeHeadless),
      rendererConsumers: input.hasVisibleData
        ? new Set(this.activeRendererConsumers)
        : new Set<string>(),
      onHeadlessDrained: input.onHeadlessDrained,
    }
    this.frames.push(frame)
    this.outstandingCost += frame.cost

    if (frame.headlessPending) {
      const chunks = splitWithoutBreakingSurrogatePair(
        headlessData,
        this.chunkSize
      )
      chunks.forEach((data, index) => {
        this.headlessChunks.push({
          data,
          frame,
          isLast: index === chunks.length - 1,
        })
      })
      this.scheduleHeadlessDrain()
    } else {
      this.notifyHeadlessDrained(frame)
    }

    if (input.hasVisibleData && input.publishVisible) {
      try {
        input.publishVisible(sequence, this.runtimeGeneration)
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error))
        if (frame.rendererConsumers.size > 0) {
          // Delivery may have succeeded for only a subset of renderers. The
          // safe response is to stop this runtime, not to release every
          // consumer credit and continue with divergent terminal state.
          this.failHeadless(normalizedError)
        } else {
          console.warn(
            '[TerminalOutputFlowController] visible output publisher failed with no attached renderer:',
            normalizedError
          )
        }
      }
    }

    this.updateSourceFlowControl()
    this.releaseCommittedFrames()
    return sequence
  }

  waitForDrain(timeoutMs = 0): Promise<boolean> {
    if (!this.hasFrames() && !this.hasHeadlessChunks()) {
      return Promise.resolve(true)
    }
    if (this.disposed || this.failed) {
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.frames.length = 0
    this.headlessChunks.length = 0
    this.frameHead = 0
    this.headlessChunkHead = 0
    this.activeRendererConsumers.clear()
    this.outstandingCost = 0
    this.resolveDrainWaiters(false)
    if (this.sourcePaused) {
      this.sourcePaused = false
      try {
        this.resumeSource?.()
      } catch {
        // The retired runtime may already be closed.
      }
    }
  }

  private scheduleHeadlessDrain(): void {
    if (
      this.disposed ||
      this.failed ||
      this.headlessWritePending ||
      !this.hasHeadlessChunks()
    ) {
      return
    }
    this.headlessWritePending = true
    queueMicrotask(() => this.drainOneHeadlessChunk())
  }

  private drainOneHeadlessChunk(): void {
    if (this.disposed || this.failed) {
      this.headlessWritePending = false
      return
    }
    const chunk = this.headlessChunks[this.headlessChunkHead]
    if (chunk) {
      this.headlessChunkHead += 1
      this.compactHeadlessChunks()
    }
    if (!chunk || !this.writeHeadless) {
      this.headlessWritePending = false
      return
    }

    let completed = false
    const complete = (): void => {
      if (completed) return
      completed = true
      this.headlessWritePending = false
      if (this.disposed || this.failed) return
      if (chunk.isLast) {
        chunk.frame.headlessPending = false
        this.notifyHeadlessDrained(chunk.frame)
      }
      this.releaseCommittedFrames()
      this.scheduleHeadlessDrain()
    }

    try {
      this.writeHeadless(chunk.data, complete)
    } catch (error) {
      completed = true
      this.headlessWritePending = false
      this.failHeadless(
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  private notifyHeadlessDrained(frame: OutputFrame): void {
    if (!frame.onHeadlessDrained) return
    const callback = frame.onHeadlessDrained
    frame.onHeadlessDrained = undefined
    try {
      callback()
    } catch (error) {
      console.warn(
        '[TerminalOutputFlowController] headless drain callback failed:',
        error
      )
    }
  }

  private releaseCommittedFrames(): void {
    while (this.hasFrames()) {
      const frame = this.frames[this.frameHead]
      if (frame.headlessPending || frame.rendererConsumers.size > 0) break
      this.frameHead += 1
      this.outstandingCost = Math.max(0, this.outstandingCost - frame.cost)
    }
    this.compactFrames()
    this.updateSourceFlowControl()
    if (!this.hasFrames() && !this.hasHeadlessChunks()) {
      this.resolveDrainWaiters(true)
    }
  }

  private hasFrames(): boolean {
    return this.frameHead < this.frames.length
  }

  private hasHeadlessChunks(): boolean {
    return this.headlessChunkHead < this.headlessChunks.length
  }

  private compactFrames(): void {
    if (this.frameHead === 0) return
    if (this.frameHead === this.frames.length) {
      this.frames.length = 0
      this.frameHead = 0
      return
    }
    if (this.frameHead >= 1024 && this.frameHead * 2 >= this.frames.length) {
      this.frames.splice(0, this.frameHead)
      this.frameHead = 0
    }
  }

  private compactHeadlessChunks(): void {
    if (this.headlessChunkHead === 0) return
    if (this.headlessChunkHead === this.headlessChunks.length) {
      this.headlessChunks.length = 0
      this.headlessChunkHead = 0
      return
    }
    if (
      this.headlessChunkHead >= 1024 &&
      this.headlessChunkHead * 2 >= this.headlessChunks.length
    ) {
      this.headlessChunks.splice(0, this.headlessChunkHead)
      this.headlessChunkHead = 0
    }
  }

  private updateSourceFlowControl(): void {
    if (this.disposed || this.failed) return
    if (!this.sourcePaused && this.outstandingCost > this.highWatermark) {
      try {
        this.pauseSource?.()
        this.sourcePaused = true
      } catch (error) {
        console.warn(
          '[TerminalOutputFlowController] failed to pause output source:',
          error
        )
      }
      return
    }
    if (this.sourcePaused && this.outstandingCost <= this.lowWatermark) {
      try {
        this.resumeSource?.()
        this.sourcePaused = false
      } catch (error) {
        console.warn(
          '[TerminalOutputFlowController] failed to resume output source:',
          error
        )
      }
    }
  }

  private failHeadless(error: Error): void {
    if (this.failed || this.disposed) return
    this.failed = true
    this.headlessChunks.length = 0
    this.headlessChunkHead = 0
    this.resolveDrainWaiters(false)
    if (!this.sourcePaused) {
      try {
        this.pauseSource?.()
        this.sourcePaused = true
      } catch {
        // The fatal callback below owns runtime teardown.
      }
    }
    queueMicrotask(() => {
      try {
        this.onHeadlessFailure(error)
      } catch (callbackError) {
        console.error(
          '[TerminalOutputFlowController] fatal output callback failed:',
          callbackError
        )
      }
    })
  }

  private resolveDrainWaiters(drained: boolean): void {
    if (this.drainWaiters.size === 0) return
    const waiters = [...this.drainWaiters]
    this.drainWaiters.clear()
    waiters.forEach((resolve) => resolve(drained))
  }
}
