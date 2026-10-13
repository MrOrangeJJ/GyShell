import type {
  CommandCaptureMetadata,
  CommandExecutionState,
} from '@gyshell/shared'
import type { CommandTask } from '../../types'

/**
 * One retention policy for Agent command transcripts, shared by the in-memory
 * task registry and the durable store: captured output is bounded by an
 * aggregate byte budget and record count, after which records become
 * output-less `record_expired` tombstones that are themselves bounded.
 */
export const AGENT_COMMAND_CAPTURE_RETENTION_BUDGET_BYTES = 64 * 1024 * 1024
export const AGENT_COMMAND_CAPTURE_RETENTION_MAX_RECORDS = 200
export const AGENT_COMMAND_TOMBSTONE_MAX_RECORDS = 200

/** Durable form of a finished or running Agent `exec_command` task. */
export interface PersistedAgentCommandRecord {
  commandId: string
  terminalId: string
  command: string
  status: CommandTask['status']
  executionState: CommandExecutionState
  exitCode?: number
  runtimeBoundary: boolean
  outcomeUnknown: boolean
  terminalStatus?: string
  startOffset: number
  endOffset?: number
  activityEndOffset?: number
  startedAt: number
  endedAt?: number
  capture: CommandCaptureMetadata
  output: string
}

/** Metadata of the newest Agent command, without its captured output. */
export interface AgentCommandSummary {
  command: string
  exitCode?: number
}

export const toPersistedAgentCommandRecord = (
  terminalId: string,
  task: CommandTask,
  transcript: {
    executionState: CommandExecutionState
    capture: CommandCaptureMetadata
    output: string
  },
): PersistedAgentCommandRecord => ({
  commandId: task.id,
  terminalId,
  command: task.command,
  status: task.status,
  executionState: transcript.executionState,
  ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
  runtimeBoundary: task.runtimeBoundary === true,
  outcomeUnknown: task.outcomeUnknown === true,
  ...(task.terminalStatus ? { terminalStatus: task.terminalStatus } : {}),
  startOffset: task.startOffset,
  ...(task.endOffset !== undefined ? { endOffset: task.endOffset } : {}),
  ...(task.activityEndOffset !== undefined
    ? { activityEndOffset: task.activityEndOffset }
    : {}),
  startedAt: task.startTime,
  ...(task.endTime !== undefined ? { endedAt: task.endTime } : {}),
  capture: { ...transcript.capture },
  output: transcript.output,
})

/** Read-only task view of a record restored from a previous app run. */
export const toCommandTask = (
  record: PersistedAgentCommandRecord,
): CommandTask => ({
  id: record.commandId,
  command: record.command,
  type: 'nowait',
  status: record.status,
  startOffset: record.startOffset,
  ...(record.endOffset !== undefined ? { endOffset: record.endOffset } : {}),
  ...(record.activityEndOffset !== undefined
    ? { activityEndOffset: record.activityEndOffset }
    : {}),
  ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
  output: record.output,
  capture: { ...record.capture },
  runtimeBoundary: record.runtimeBoundary,
  outcomeUnknown: record.outcomeUnknown,
  ...(record.terminalStatus ? { terminalStatus: record.terminalStatus } : {}),
  startTime: record.startedAt,
  ...(record.endedAt !== undefined ? { endTime: record.endedAt } : {}),
})
