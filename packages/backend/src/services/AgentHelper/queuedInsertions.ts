import { AGENT_NOTIFICATION_TAG } from './prompts'

export type QueuedAgentInsertionKind = 'exec_command_nowait_completed' | string

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
}): QueuedAgentInsertionInput {
  const terminalRef = params.terminalId || params.terminalName
  const outcomeUnknown = params.runtimeBoundary === true
  const instruction = outcomeUnknown
    ? 'The hidden completion tracker stopped before a definitive outcome was observed. Do not assume success or replay the command automatically. ' +
      `Inspect the terminal and use read_command_output with tabIdOrName=${JSON.stringify(terminalRef)} and history_command_match_id=${JSON.stringify(params.historyCommandMatchId)} before planning later mutations.`
    : 'The nowait exec_command has completed. Do not infer or summarize command output from this notification. ' +
      `Use read_command_output with tabIdOrName=${JSON.stringify(terminalRef)} and history_command_match_id=${JSON.stringify(params.historyCommandMatchId)} if you need to inspect the result.`
  const payload = {
    notification_type: outcomeUnknown
      ? 'exec_command_nowait_outcome_unknown'
      : 'exec_command_nowait_completed',
    message: outcomeUnknown
      ? 'A background exec_command no longer has a definitive tracked outcome.'
      : 'A background nowait exec_command has completed.',
    history_command_match_id: params.historyCommandMatchId,
    terminal_id: params.terminalId,
    terminal_name: params.terminalName,
    tool: 'exec_command',
    execution_mode: 'nowait',
    ...(typeof params.exitCode === 'number' ? { exit_code: params.exitCode } : {}),
    command: params.command,
    instruction
  }
  const content = `${AGENT_NOTIFICATION_TAG}${JSON.stringify(payload, null, 2)}`
  return {
    kind: outcomeUnknown
      ? 'exec_command_nowait_outcome_unknown'
      : 'exec_command_nowait_completed',
    content,
    dedupeKey: `exec_command_nowait_completed:${params.terminalId}:${params.historyCommandMatchId}`
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
    const terminalRef = command.terminalId || command.terminalName
    return [
      `${index + 1}. command=${JSON.stringify(command.command)}`,
      `   terminalId=${JSON.stringify(command.terminalId)}`,
      `   terminalName=${JSON.stringify(command.terminalName)}`,
      `   history_command_match_id=${JSON.stringify(command.historyCommandMatchId)}`,
      `   suggested read_command_output args: tabIdOrName=${JSON.stringify(terminalRef)}, history_command_match_id=${JSON.stringify(command.historyCommandMatchId)}`
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
