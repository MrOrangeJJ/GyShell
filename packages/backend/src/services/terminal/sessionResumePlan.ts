import type {
  TerminalActivitySnapshot,
  TerminalSessionBoundary,
} from '@gyshell/shared'
import type { AgentCommandSummary } from './agentCommandRecord'
import { hasVisibleTerminalText } from './terminalVisibleText'

/**
 * Rows appended after restored history so the renderer can anchor the resume
 * divider on the row below the cursor and the next prompt starts two rows
 * below it, whether or not the restored text ended with a newline.
 */
export const SESSION_RESUME_SPACING = '\r\n\r\n'

export interface SessionResumeInput {
  terminalId: string
  /** Restored visible tail and its absolute end offset. */
  visible: { data: string; endOffset: number }
  activities: readonly TerminalActivitySnapshot[]
  previousBoundary: TerminalSessionBoundary | undefined
  /** Fallback summary when no restored Activity names a command. */
  latestAgentCommand: AgentCommandSummary | undefined
  now: number
  boundaryId: string
}

export type SessionResumePlan =
  /** Nothing was restored; the terminal starts fresh. */
  | { kind: 'fresh' }
  /**
   * The previous session printed nothing after its divider: move that
   * divider to the newest resume time instead of stacking another one.
   */
  | { kind: 'reuse-boundary'; boundary: TerminalSessionBoundary }
  /** Record a new divider at the restored end and append spacing rows. */
  | { kind: 'new-boundary'; boundary: TerminalSessionBoundary; spacing: string }

/**
 * Decide how a terminal resumes from durable history. Session boundaries are
 * structured metadata for the renderer; no divider text is ever written into
 * the terminal stream.
 */
export const planSessionResume = (input: SessionResumeInput): SessionResumePlan => {
  const { visible, previousBoundary } = input
  if (visible.endOffset === 0 && input.activities.length === 0) {
    return { kind: 'fresh' }
  }

  const visibleStart = visible.endOffset - visible.data.length
  if (
    previousBoundary &&
    previousBoundary.offset >= visibleStart &&
    previousBoundary.offset <= visible.endOffset &&
    !hasVisibleTerminalText(visible.data.slice(previousBoundary.offset - visibleStart))
  ) {
    return {
      kind: 'reuse-boundary',
      boundary: { ...previousBoundary, resumedAt: input.now },
    }
  }

  const lastActivity = input.activities
    .filter((activity) => Boolean(activity.command || activity.intent))
    .at(-1)
  const lastCommand = lastActivity
    ? lastActivity.command || lastActivity.intent
    : input.latestAgentCommand?.command
  const exitCode = lastActivity
    ? lastActivity.exitCode
    : input.latestAgentCommand?.exitCode
  return {
    kind: 'new-boundary',
    boundary: {
      id: input.boundaryId,
      terminalId: input.terminalId,
      resumedAt: input.now,
      offset: visible.endOffset,
      ...(lastCommand ? { lastCommand } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    },
    spacing: SESSION_RESUME_SPACING,
  }
}
