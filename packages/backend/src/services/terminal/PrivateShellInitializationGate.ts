import { findInitializationReadyRecord } from './CommandStreamProtocol'

const MAX_PENDING_INITIALIZATION_CHARS = 256 * 1024

export type PrivateShellInitializationChunk =
  | { kind: 'suppressed' }
  | {
      kind: 'opened'
      suppressedData: string
      visibleData: string
    }
  | {
      kind: 'visible'
      visibleData: string
    }

interface PendingInitializationAttempt {
  readyRecord: string
  settle: (opened: boolean) => void
}

/**
 * Owns the privacy boundary between a backend-generated shell bootstrap and
 * ordinary interactive output. Attempts may supersede one another, but only
 * the newest attempt's marker can open the gate.
 */
export class PrivateShellInitializationGate {
  private state: 'pending' | 'ready' | 'failed' = 'pending'
  private pendingAttempt: PendingInitializationAttempt | undefined
  private bufferedData = ''

  beginAttempt(readyRecord: string): Promise<boolean> {
    if (!readyRecord) {
      throw new Error('Private shell initialization ready record is empty')
    }
    if (this.state !== 'pending') {
      return Promise.resolve(this.state === 'ready')
    }

    this.pendingAttempt?.settle(false)
    this.bufferedData = ''
    return new Promise<boolean>((resolve) => {
      this.pendingAttempt = {
        readyRecord,
        settle: resolve
      }
    })
  }

  accept(data: string): PrivateShellInitializationChunk {
    if (!data) return { kind: 'suppressed' }
    if (this.state === 'ready') {
      return { kind: 'visible', visibleData: data }
    }
    if (this.state === 'failed' || !this.pendingAttempt) {
      return { kind: 'suppressed' }
    }

    const combined = this.bufferedData + data
    const readyRecordOffset = findInitializationReadyRecord(
      combined,
      this.pendingAttempt.readyRecord
    )
    if (readyRecordOffset < 0) {
      this.bufferedData = combined.slice(-MAX_PENDING_INITIALIZATION_CHARS)
      return { kind: 'suppressed' }
    }

    const attempt = this.pendingAttempt
    const readyRecordEnd = readyRecordOffset + attempt.readyRecord.length
    this.state = 'ready'
    this.pendingAttempt = undefined
    this.bufferedData = ''
    attempt.settle(true)
    return {
      kind: 'opened',
      suppressedData: combined.slice(0, readyRecordOffset),
      visibleData: combined.slice(readyRecordEnd)
    }
  }

  fail(): void {
    if (this.state === 'failed') return
    this.state = 'failed'
    this.bufferedData = ''
    const attempt = this.pendingAttempt
    this.pendingAttempt = undefined
    attempt?.settle(false)
  }
}
