import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import { buildFileTransferFinishedInsertion } from '../queuedInsertions'
import type { FileTransferTaskSnapshot } from '../../FileTransferService'
import {
  formatTerminalUnavailableForTool,
  resolveTerminalForTool
} from './terminal_runtime_guard'

export const copyBetweenTabsSchema = z.object({
  sourceTabIdOrName: z
    .string()
    .describe('The ID or exact name of the source terminal tab.'),
  sourcePaths: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'One or more source file or directory paths on the source terminal tab.',
    ),
  targetTabIdOrName: z
    .string()
    .describe('The ID or exact name of the target terminal tab.'),
  targetDirPath: z
    .string()
    .min(1)
    .describe('Existing target directory path on the target terminal tab.'),
  conflictStrategy: z
    .enum(['rename', 'error', 'overwrite'])
    .optional()
    .default('rename')
    .describe(
      'How to handle target name conflicts. Default rename keeps both files. Use overwrite only when the user explicitly requested replacement.',
    ),
})

export const readFileTransferStatusSchema = z.object({
  transferId: z
    .string()
    .optional()
    .describe(
      'Transfer id returned by copy_between_tabs. If omitted, active transfers for this agent run are listed.',
    ),
  includeCompleted: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Whether completed, failed, and cancelled transfers should be included when listing transfers.',
    ),
})

const summarizeTransfer = (
  task: FileTransferTaskSnapshot,
): Record<string, unknown> => {
  const targetOutputMayBeIncomplete =
    task.status === 'error' || task.status === 'cancelled'
  return {
    transfer_id: task.id,
    origin: task.origin,
    status: task.status,
    source_terminal_id: task.sourceTerminalId,
    source_terminal_name: task.sourceTerminalName,
    source_machine_identity: task.sourceMachineIdentity,
    target_terminal_id: task.targetTerminalId,
    target_terminal_name: task.targetTerminalName,
    target_machine_identity: task.targetMachineIdentity,
    target_dir_path: task.targetDirPath,
    item_names: task.itemNames,
    conflict_strategy: task.conflictStrategy,
    bytes_done: task.bytesDone,
    total_bytes: task.totalBytes,
    transferred_files: task.transferredFiles,
    total_files: task.totalFiles,
    percent: task.percent,
    message: task.message,
    error_message: task.errorMessage,
    ...(targetOutputMayBeIncomplete
      ? {
          target_output_may_be_incomplete: true,
          caution:
            'The target directory may contain incomplete files from the failed or cancelled transfer. Verify, retry, or clean them up before reading or using them as complete.',
        }
      : {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    completed_at: task.completedAt,
  }
}

function buildBackgroundTransferInput(task: FileTransferTaskSnapshot) {
  return {
    transferId: task.id,
    sourceTerminalId: task.sourceTerminalId,
    sourceTerminalName: task.sourceTerminalName,
    targetTerminalId: task.targetTerminalId,
    targetTerminalName: task.targetTerminalName,
    sourcePaths: task.sourcePaths,
    targetDirPath: task.targetDirPath,
    itemNames: task.itemNames,
  }
}

export async function copyBetweenTabs(
  args: z.infer<typeof copyBetweenTabsSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const {
    fileTransferService,
    sessionId,
    messageId,
    sendEvent,
  } = context
  if (!fileTransferService) {
    return 'Error: File transfer service is not available.'
  }

  const sourceResolved = resolveTerminalForTool(
    context,
    args.sourceTabIdOrName,
    'source terminal tab',
  )
  if (!sourceResolved.ok) {
    return sourceResolved.message
  }
  if (!sourceResolved.snapshot.canUseFilesystem) {
    return sourceResolved.terminal.capabilities?.supportsFilesystem !== true &&
      sourceResolved.snapshot.runtimeState === 'ready'
      ? `Error: Source terminal tab "${sourceResolved.terminal.title || sourceResolved.terminal.id}" (id=${sourceResolved.terminal.id}, type=${sourceResolved.terminal.type}) does not support filesystem operations.`
      : formatTerminalUnavailableForTool(
          sourceResolved.snapshot,
          'copy files from this source terminal'
        )
  }

  const targetResolved = resolveTerminalForTool(
    context,
    args.targetTabIdOrName,
    'target terminal tab',
  )
  if (!targetResolved.ok) {
    return targetResolved.message
  }
  if (!targetResolved.snapshot.canUseFilesystem) {
    return targetResolved.terminal.capabilities?.supportsFilesystem !== true &&
      targetResolved.snapshot.runtimeState === 'ready'
      ? `Error: Target terminal tab "${targetResolved.terminal.title || targetResolved.terminal.id}" (id=${targetResolved.terminal.id}, type=${targetResolved.terminal.type}) does not support filesystem operations.`
      : formatTerminalUnavailableForTool(
          targetResolved.snapshot,
          'copy files into this target terminal'
        )
  }

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'copy_between_tabs',
    title: 'Copy between tabs',
    hint: `${sourceResolved.terminal.title || sourceResolved.terminal.id} -> ${targetResolved.terminal.title || targetResolved.terminal.id}`,
    input: JSON.stringify(args),
  })

  try {
    const task = fileTransferService.startTransfer({
      origin: 'agent',
      mode: 'copy',
      sourceTerminalId: sourceResolved.terminal.id,
      sourcePaths: args.sourcePaths,
      targetTerminalId: targetResolved.terminal.id,
      targetDirPath: args.targetDirPath,
      conflictStrategy: args.conflictStrategy,
      requireDistinctMachine: true,
      sessionId,
      agentRunId: context.agentRunId,
      toolMessageId: messageId,
      onSettled: (settledTask) => {
        context.completeBackgroundFileTransfer?.({
          ...buildBackgroundTransferInput(settledTask),
          status: settledTask.status,
          error: settledTask.errorMessage || undefined,
        })
        context.enqueueQueuedInsertion?.(
          buildFileTransferFinishedInsertion({
            transferId: settledTask.id,
            status: settledTask.status,
            sourceTerminalId: settledTask.sourceTerminalId,
            sourceTerminalName: settledTask.sourceTerminalName,
            targetTerminalId: settledTask.targetTerminalId,
            targetTerminalName: settledTask.targetTerminalName,
            sourcePaths: settledTask.sourcePaths,
            targetDirPath: settledTask.targetDirPath,
            error: settledTask.errorMessage || undefined,
          }),
        )
      },
    })
    context.registerBackgroundFileTransfer?.(buildBackgroundTransferInput(task))

    const result = {
      message:
        'File copy started asynchronously. Do not assume it has completed.',
      transfer: summarizeTransfer(task),
      next_step: `Use read_file_transfer_status with transferId=${JSON.stringify(task.id)} to check progress or final status.`,
      failure_caution:
        'If the final status is error or cancelled, the target directory may contain incomplete files. Verify, retry, or clean them up before reading or using them as complete.',
    }
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: JSON.stringify(result, null, 2),
    })
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished',
    })
    return JSON.stringify(result, null, 2)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: `Error: ${message}`,
    })
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished',
      level: 'error',
    })
    return `Error: ${message}`
  }
}

export async function readFileTransferStatus(
  args: z.infer<typeof readFileTransferStatusSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const { fileTransferService } = context
  if (!fileTransferService) {
    return 'Error: File transfer service is not available.'
  }

  if (args.transferId) {
    const task = fileTransferService.getTransfer(args.transferId)
    if (!task) {
      return `Error: File transfer not found: ${args.transferId}`
    }
    return JSON.stringify({ transfer: summarizeTransfer(task) }, null, 2)
  }

  const transfers = fileTransferService.listTransfers({
    includeCompleted: args.includeCompleted,
    origin: 'agent',
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.agentRunId ? { agentRunId: context.agentRunId } : {}),
  })
  return JSON.stringify(
    {
      transfers: transfers.map((task) => summarizeTransfer(task)),
    },
    null,
    2,
  )
}
