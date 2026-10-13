/**
 * Structured marker for the point where a restored terminal session resumed.
 * The renderer draws it as a divider; it is never written into the stream.
 */
export interface TerminalSessionBoundary {
  id: string
  terminalId: string
  resumedAt: number
  offset: number
  lastCommand?: string
  exitCode?: number
}
