import type {
  TerminalConnectionStatus,
  TerminalConnectionStatusLine,
} from '@gyshell/shared'

export const MAX_CONNECTION_STATUS_LINES = 12

const CLOSED_BEFORE_READY_TEXT =
  'Connection closed before the shell became ready.'

/**
 * Fold one backend status line into the transient connection status.
 * Errors accumulate in `failed`; progress accumulates in `connecting` and is
 * ignored once the shell is ready or the connection already failed. Returns
 * the previous object unchanged when the line is ignored.
 */
export const reduceConnectionStatus = (
  previous: TerminalConnectionStatus | undefined,
  line: TerminalConnectionStatusLine,
  runtimeReady: boolean,
): TerminalConnectionStatus | undefined => {
  if (line.level === 'error') {
    const errors = previous?.phase === 'failed' ? previous.lines : []
    return {
      phase: 'failed',
      lines: [...errors, line].slice(-MAX_CONNECTION_STATUS_LINES),
      updatedAt: line.at,
    }
  }
  if (runtimeReady || previous?.phase === 'failed') return previous
  return {
    phase: 'connecting',
    lines: [...(previous?.lines ?? []), line].slice(-MAX_CONNECTION_STATUS_LINES),
    updatedAt: line.at,
  }
}

/** Clear progress on success; keep only the failure reason on failure. */
export const settleConnectionStatus = (
  status: TerminalConnectionStatus | undefined,
  outcome: 'ready' | 'failed',
  now: number,
): TerminalConnectionStatus | undefined => {
  if (!status || outcome === 'ready') return undefined
  if (status.phase === 'failed') return status
  const errors = status.lines.filter((line) => line.level === 'error')
  return {
    phase: 'failed',
    lines: errors.length
      ? errors
      : [{ level: 'error', text: CLOSED_BEFORE_READY_TEXT, at: now }],
    updatedAt: now,
  }
}
