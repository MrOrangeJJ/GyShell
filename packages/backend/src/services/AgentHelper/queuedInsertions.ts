import { AGENT_NOTIFICATION_TAG } from './prompts'
import type { CommandExecutionState } from '@gyshell/shared'

export type QueuedAgentInsertionKind = 'exec_command_nowait_completed' | string

export const EXEC_COMMAND_NOTIFICATION_MAX_UTF8_BYTES = 16 * 1024
const EXEC_COMMAND_NOTIFICATION_COMMAND_JSON_BYTES = 4 * 1024
const EXEC_COMMAND_NOTIFICATION_IDENTIFIER_JSON_BYTES = 2 * 1024
const EXEC_COMMAND_NOTIFICATION_NAME_JSON_BYTES = 1024

const normalizeNotificationScalar = (value: string): string => {
  const codePoint = value.codePointAt(0)
  return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff
    ? '\ufffd'
    : value
}

const boundedJsonString = (
  input: string,
  maxEncodedBytes: number,
): { value: string; originalUtf8Bytes: number; truncated: boolean } => {
  const source = String(input || '')
  const originalUtf8Bytes = Buffer.byteLength(source, 'utf8')
  let encodedBytes = 0
  let value = ''
  let truncated = false
  for (const rawScalar of source) {
    const scalar = normalizeNotificationScalar(rawScalar)
    const scalarEncodedBytes = Buffer.byteLength(
      JSON.stringify(scalar).slice(1, -1),
      'utf8',
    )
    if (encodedBytes + scalarEncodedBytes > maxEncodedBytes) {
      truncated = true
      break
    }
    value += scalar
    encodedBytes += scalarEncodedBytes
  }
  return { value, originalUtf8Bytes, truncated }
}

export interface QueuedAgentInsertionInput {
  kind: QueuedAgentInsertionKind
  content: string
  dedupeKey?: string
  originAgentRunId?: string
}

export interface QueuedAgentInsertion extends QueuedAgentInsertionInput {
  id: string
  sessionId: string
  agentRunId: string
  createdAt: number
}

export interface RunBackgroundExecCommandInput {
  terminalId: string
  terminalName: string
  historyCommandMatchId: string
  command: string
  originAgentRunId?: string
}

export interface RunBackgroundExecCommand extends RunBackgroundExecCommandInput {
  id: string
  sessionId: string
  agentRunId: string
  createdAt: number
  completedAt?: number
  exitCode?: number
  guardNotifiedAt?: number
}

export interface RunBackgroundFileTransferInput {
  transferId: string
  sourceTerminalId: string
  sourceTerminalName: string
  targetTerminalId: string
  targetTerminalName: string
  sourcePaths: string[]
  targetDirPath: string
  originAgentRunId?: string
}

export interface RunBackgroundFileTransfer extends RunBackgroundFileTransferInput {
  id: string
  sessionId: string
  agentRunId: string
  createdAt: number
  completedAt?: number
  status?: string
  error?: string
  guardNotifiedAt?: number
}

export type QueuedAgentInsertionProvider = (
  sessionId: string,
  agentRunId: string
) => QueuedAgentInsertion[]
export type QueuedAgentInsertionAcknowledger = (
  sessionId: string,
  agentRunId: string,
  itemIds: string[]
) => void
export type QueuedAgentInsertionAvailabilityWaiter = (
  sessionId: string,
  agentRunId: string,
  signal?: AbortSignal
) => Promise<boolean>
export type QueuedAgentInsertionEnqueuer = (
  sessionId: string,
  insertion: QueuedAgentInsertionInput
) => void
export type RunBackgroundExecCommandRegistrar = (
  sessionId: string,
  command: RunBackgroundExecCommandInput
) => void
export type RunBackgroundExecCommandCompleter = (
  sessionId: string,
  command: RunBackgroundExecCommandInput & { exitCode?: number }
) => void
export type UnfinishedRunBackgroundExecCommandProvider = (
  sessionId: string,
  agentRunId: string
) => RunBackgroundExecCommand[]
export type RunBackgroundFileTransferRegistrar = (
  sessionId: string,
  transfer: RunBackgroundFileTransferInput
) => void
export type RunBackgroundFileTransferCompleter = (
  sessionId: string,
  transfer: RunBackgroundFileTransferInput & { status?: string; error?: string }
) => void
export type UnfinishedRunBackgroundFileTransferProvider = (
  sessionId: string,
  agentRunId: string
) => RunBackgroundFileTransfer[]

export function buildQueuedInsertionBatchContent(items: QueuedAgentInsertion[]): string {
  return items
    .map((item) => item.content.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function buildExecCommandNowaitCompletedInsertion(params: {
  terminalId: string
  terminalName: string
  historyCommandMatchId: string
  command: string
  exitCode?: number
  runtimeBoundary?: boolean
  executionState?: CommandExecutionState
  terminalAvailable?: boolean
}): QueuedAgentInsertionInput {
  const terminalId = boundedJsonString(
    params.terminalId,
    EXEC_COMMAND_NOTIFICATION_IDENTIFIER_JSON_BYTES,
  )
  const historyCommandMatchId = boundedJsonString(
    params.historyCommandMatchId,
    EXEC_COMMAND_NOTIFICATION_IDENTIFIER_JSON_BYTES,
  )
  const terminalName = boundedJsonString(
    params.terminalName,
    EXEC_COMMAND_NOTIFICATION_NAME_JSON_BYTES,
  )
  const command = boundedJsonString(
    params.command,
    EXEC_COMMAND_NOTIFICATION_COMMAND_JSON_BYTES,
  )
  const terminalRef = terminalId.value || terminalName.value
  const outcomeUnknown =
    params.runtimeBoundary === true ||
    params.executionState === 'outcome_unknown'
  const aborted = params.executionState === 'aborted'
  const readInstruction = params.terminalAvailable === false
    ? `The terminal tab is closed, but retention-bounded read-only command history remains available in this GyShell process until it is evicted. Use read_command_output with tabIdOrName=${JSON.stringify(terminalId.value)} and history_command_match_id=${JSON.stringify(historyCommandMatchId.value)}; do not use the old terminal name.`
    : `Use read_command_output with tabIdOrName=${JSON.stringify(terminalRef)} and history_command_match_id=${JSON.stringify(historyCommandMatchId.value)} if you need to inspect the result.`
  const instruction = aborted
    ? 'The background exec_command was aborted. It did not produce a trustworthy successful outcome; do not assume success or automatically replay a command with side effects. ' +
      readInstruction
    : outcomeUnknown
    ? 'The command is no longer running, but GyShell has no trustworthy definitive outcome (for example, the runtime ended or the shell could not determine an exact exit code). Do not assume success or replay the command automatically. ' +
      readInstruction
    : 'The nowait exec_command has completed. Do not infer or summarize command output from this notification. ' +
      readInstruction
  const payload = {
    notification_type: aborted
      ? 'exec_command_nowait_aborted'
      : outcomeUnknown
        ? 'exec_command_nowait_outcome_unknown'
        : 'exec_command_nowait_completed',
    message: aborted
      ? 'A background exec_command was aborted.'
      : outcomeUnknown
        ? 'A background exec_command ended without a definitive tracked outcome.'
        : 'A background nowait exec_command has completed.',
    history_command_match_id: historyCommandMatchId.value,
    terminal_id: terminalId.value,
    terminal_name: terminalName.value,
    tool: 'exec_command',
    execution_mode: 'nowait',
    terminal_tab_exists: params.terminalAvailable !== false,
    ...(!outcomeUnknown && !aborted && typeof params.exitCode === 'number'
      ? { exit_code: params.exitCode }
      : {}),
    command_preview: command.value,
    command_utf8_bytes: command.originalUtf8Bytes,
    command_truncated: command.truncated,
    ...(terminalId.truncated || historyCommandMatchId.truncated
      ? { identifiers_truncated: true }
      : {}),
    ...(terminalName.truncated ? { terminal_name_truncated: true } : {}),
    instruction
  }
  const content = `${AGENT_NOTIFICATION_TAG}${JSON.stringify(payload, null, 2)}`
  if (Buffer.byteLength(content, 'utf8') > EXEC_COMMAND_NOTIFICATION_MAX_UTF8_BYTES) {
    throw new Error('exec_command completion notification exceeded its hard size limit.')
  }
  return {
    kind: aborted
      ? 'exec_command_nowait_aborted'
      : outcomeUnknown
        ? 'exec_command_nowait_outcome_unknown'
        : 'exec_command_nowait_completed',
    content,
    dedupeKey: `exec_command_nowait_completed:${terminalId.value}:${historyCommandMatchId.value}`
  }
}

export function buildFileTransferFinishedInsertion(params: {
  transferId: string
  sourceTerminalId: string
  sourceTerminalName: string
  targetTerminalId: string
  targetTerminalName: string
  sourcePaths: string[]
  targetDirPath: string
  status: string
  error?: string
}): QueuedAgentInsertionInput {
  const targetOutputMayBeIncomplete =
    params.status === 'error' || params.status === 'cancelled'
  const incompleteOutputInstruction = targetOutputMayBeIncomplete
    ? ' The target directory may contain incomplete files from the failed or cancelled transfer; do not read or use those files as complete until you verify them, retry the transfer, or clean them up.'
    : ''
  const instruction =
    'The asynchronous copy_between_tabs file transfer has reached a terminal state. ' +
    `Use read_file_transfer_status with transferId=${JSON.stringify(params.transferId)} if you need progress totals, final paths, or error details before continuing.` +
    incompleteOutputInstruction
  const payload = {
    notification_type: 'file_transfer_finished',
    message: 'A background file transfer has finished.',
    transfer_id: params.transferId,
    source_terminal_id: params.sourceTerminalId,
    source_terminal_name: params.sourceTerminalName,
    target_terminal_id: params.targetTerminalId,
    target_terminal_name: params.targetTerminalName,
    source_paths: params.sourcePaths,
    target_dir_path: params.targetDirPath,
    status: params.status,
    ...(params.error ? { error: params.error } : {}),
    ...(targetOutputMayBeIncomplete
      ? { target_output_may_be_incomplete: true }
      : {}),
    tool: 'copy_between_tabs',
    instruction
  }
  const content = `${AGENT_NOTIFICATION_TAG}${JSON.stringify(payload, null, 2)}`
  return {
    kind: 'file_transfer_finished',
    content,
    dedupeKey: `file_transfer_finished:${params.transferId}`
  }
}

export function buildUnfinishedExecCommandContinueInstruction(commands: RunBackgroundExecCommand[]): string {
  const commandLines = commands.map((command, index) => {
    const commandPreview = boundedJsonString(
      command.command,
      EXEC_COMMAND_NOTIFICATION_COMMAND_JSON_BYTES,
    )
    const terminalId = boundedJsonString(
      command.terminalId,
      EXEC_COMMAND_NOTIFICATION_IDENTIFIER_JSON_BYTES,
    ).value
    const terminalName = boundedJsonString(
      command.terminalName,
      EXEC_COMMAND_NOTIFICATION_NAME_JSON_BYTES,
    ).value
    const historyCommandMatchId = boundedJsonString(
      command.historyCommandMatchId,
      EXEC_COMMAND_NOTIFICATION_IDENTIFIER_JSON_BYTES,
    ).value
    const terminalRef = terminalId || terminalName
    return [
      `${index + 1}. command_preview=${JSON.stringify(commandPreview.value)}`,
      `   command_utf8_bytes=${commandPreview.originalUtf8Bytes}, command_truncated=${commandPreview.truncated}`,
      `   terminalId=${JSON.stringify(terminalId)}`,
      `   terminalName=${JSON.stringify(terminalName)}`,
      `   history_command_match_id=${JSON.stringify(historyCommandMatchId)}`,
      `   suggested read_command_output args: tabIdOrName=${JSON.stringify(terminalRef)}, history_command_match_id=${JSON.stringify(historyCommandMatchId)}`
    ].join('\n')
  })

  return [
    'You previously started one or more exec_command tasks in background/nowait mode, and they have not finished yet.',
    'Before ending this turn, inspect their current progress and decide whether you should wait longer, take another action, or explicitly proceed without waiting.',
    'Use read_command_output with the provided history_command_match_id and terminal id/name. Do not assume the command output or final status.',
    '',
    'Unfinished background exec_command tasks:',
    ...commandLines
  ].join('\n')
}

export function buildUnfinishedFileTransferContinueInstruction(
  transfers: RunBackgroundFileTransfer[]
): string {
  const transferLines = transfers.map((transfer, index) => {
    return [
      `${index + 1}. transferId=${JSON.stringify(transfer.transferId)}`,
      `   source=${JSON.stringify(transfer.sourceTerminalName || transfer.sourceTerminalId)}`,
      `   target=${JSON.stringify(transfer.targetTerminalName || transfer.targetTerminalId)}`,
      `   sourcePaths=${JSON.stringify(transfer.sourcePaths)}`,
      `   targetDirPath=${JSON.stringify(transfer.targetDirPath)}`,
      `   suggested read_file_transfer_status args: transferId=${JSON.stringify(transfer.transferId)}`
    ].join('\n')
  })

  return [
    'You previously started one or more copy_between_tabs file transfers, and they have not finished yet.',
    'Before ending this turn, inspect their current progress and decide whether you should wait longer, take another action, or explicitly proceed without waiting.',
    'Use read_file_transfer_status with the provided transferId. Do not assume the file transfer output or final status.',
    '',
    'Unfinished background file transfers:',
    ...transferLines
  ].join('\n')
}
