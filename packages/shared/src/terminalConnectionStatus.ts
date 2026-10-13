export type TerminalConnectionStatusLevel = 'info' | 'success' | 'warning' | 'error'

/** One transport/setup progress line (e.g. "Connecting to host:22..."). */
export interface TerminalConnectionStatusLine {
  level: TerminalConnectionStatusLevel
  text: string
  at: number
}

/**
 * Transient connection status of a terminal runtime. This is runtime metadata,
 * never terminal content: it is not written into the visible stream, not
 * persisted, and not restored after an app restart. `connecting` lists setup
 * progress and is cleared once the shell is ready; `failed` keeps only the
 * failure reason until the runtime is reconnected or the tab is closed.
 */
export interface TerminalConnectionStatus {
  phase: 'connecting' | 'failed'
  lines: TerminalConnectionStatusLine[]
  updatedAt: number
}

/** Plain-text failure summary for agent/CLI consumers. */
export const describeTerminalConnectionStatus = (
  status: TerminalConnectionStatus | undefined,
): string | undefined => {
  if (!status || status.lines.length === 0) return undefined
  const relevant =
    status.phase === 'failed'
      ? status.lines.filter((line) => line.level === 'error')
      : status.lines.slice(-1)
  const text = (relevant.length ? relevant : status.lines.slice(-1))
    .map((line) => line.text)
    .join('; ')
  return status.phase === 'failed' ? `Connection failed: ${text}` : `Connecting: ${text}`
}
