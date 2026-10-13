export const TERMINAL_ACTIVITY_COMMAND_PREVIEW_MAX_UTF8_BYTES = 4096
export const TERMINAL_ACTIVITY_INTENT_MAX_CHARACTERS = 40

export type TerminalActivityActor = 'user' | 'agent'

export type TerminalActivityOrigin = 'interactive-shell' | 'agent-exec-command'

export type TerminalActivityStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'outcome-unknown'

/**
 * A bounded, presentation-safe projection of one terminal command lifecycle.
 * Raw PTY output remains owned by TerminalService and is never duplicated here.
 */
export interface TerminalActivitySnapshot {
  id: string
  terminalId: string
  kind: 'command'
  actor: TerminalActivityActor
  origin: TerminalActivityOrigin
  status: TerminalActivityStatus
  revision: number
  startedAt: number
  updatedAt: number
  endedAt?: number
  command?: string
  intent?: string
  exitCode?: number
  startOffset: number
  endOffset?: number
  runtimeGeneration?: number
  shellSequence?: number
  sessionId?: string
  messageId?: string
}
