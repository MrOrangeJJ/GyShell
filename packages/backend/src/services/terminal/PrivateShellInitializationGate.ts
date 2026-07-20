import { findInitializationReadyMarkerLine } from './CommandStreamProtocol'

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
  marker: string
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

  beginAttempt(marker: string): Promise<boolean> {
    if (!marker) {
      throw new Error('Private shell initialization marker is empty')
    }
    if (this.state !== 'pending') {
      return Promise.resolve(this.state === 'ready')
    }

    this.pendingAttempt?.settle(false)
    this.bufferedData = ''
    return new Promise<boolean>((resolve) => {
      this.pendingAttempt = {
        marker,
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
    const markerOffset = findInitializationReadyMarkerLine(
      combined,
      this.pendingAttempt.marker
    )
    if (markerOffset < 0) {
      this.bufferedData = combined.slice(-MAX_PENDING_INITIALIZATION_CHARS)
      return { kind: 'suppressed' }
    }

    const attempt = this.pendingAttempt
    const markerEnd = markerOffset + attempt.marker.length
    this.state = 'ready'
    this.pendingAttempt = undefined
    this.bufferedData = ''
    attempt.settle(true)
    return {
      kind: 'opened',
      suppressedData: combined.slice(0, markerOffset),
      visibleData: combined.slice(markerEnd)
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
