import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import type { CommandResult } from '../../../types'
import { buildExecCommandNowaitCompletedInsertion } from '../queuedInsertions'
import {
  formatTerminalStatusHeader,
  formatTerminalUnavailableForTool,
  resolveTerminalForTool
} from './terminal_runtime_guard'
import {
  COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES,
  type CommandCaptureMetadata,
  type CommandExecutionState,
} from '@gyshell/shared'
import {
  DEFAULT_LEGACY_LINE_LIMIT,
  MAX_LEGACY_LINE_LIMIT,
  MAX_PAGE_UTF8_BYTES,
  formatCommandOutputPage,
  formatInitialCommandOutput,
  type CommandOutputSource,
} from './command_output_contract'

// --- Schemas ---

const boundedTerminalReferenceSchema = z
  .string()
  .min(1)
  .max(COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES)
  .refine(
    (value) =>
      Buffer.byteLength(value, 'utf8') <=
      COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES,
    {
      message: `terminal reference cannot exceed ${COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES} UTF-8 bytes.`,
    }
  )

const boundedCommandHistoryIdSchema = z
  .string()
  .min(1)
  .max(COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES)
  .refine(
    (value) =>
      Buffer.byteLength(value, 'utf8') <=
      COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES,
    {
      message: `history_command_match_id cannot exceed ${COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES} UTF-8 bytes.`,
    }
  )

export const execCommandSchema = z.object({
  tabIdOrName: boundedTerminalReferenceSchema.describe('The ID or Name of the terminal tab'),
  command: z
    .string()
    .min(1, 'command cannot be empty.')
    .max(256 * 1024, 'command is too large for one shell submission.')
    .refine((command) => !/[\r\n\x00]/.test(command), {
      message:
        'command must be one physical shell submission and cannot contain CR, LF, or NUL. For a multi-line script, use write_file in the terminal temporary directory, then execute that file with a one-line exec_command.',
    })
    .describe('One physical shell command to execute'),
  waitMode: z
    .enum(['wait', 'nowait'])
    .optional()
    .default('wait')
    .describe('Execution mode: "wait" runs synchronously and waits for completion; "nowait" runs asynchronously and returns immediately.')
})

export const readTerminalTabSchema = z.object({
  tabIdOrName: boundedTerminalReferenceSchema.describe('The ID or Name of the terminal tab'),
  lines: z.number().optional().default(100).describe('Number of lines to read')
})

export const readCommandOutputSchema = z
  .object({
    tabIdOrName: boundedTerminalReferenceSchema.describe('The ID or Name of the terminal tab'),
    history_command_match_id: boundedCommandHistoryIdSchema.describe('The unique command ID to read output from'),
    cursor: z
      .string()
      .max(4096)
      .optional()
      .describe('Opaque cursor returned by a previous command output result. Pass it back unchanged.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(10_000_000)
      .optional()
      .describe('Legacy line offset (0-based). Do not combine with cursor.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LEGACY_LINE_LIMIT)
      .optional()
      .describe(`Legacy line limit (defaults to ${DEFAULT_LEGACY_LINE_LIMIT}).`),
    maxBytes: z
      .number()
      .int()
      .min(4)
      .max(MAX_PAGE_UTF8_BYTES)
      .optional()
      .describe('Maximum UTF-8 content bytes for this page.'),
  })
  .refine((value) => value.cursor === undefined || value.offset === undefined, {
    message: 'cursor and offset are mutually exclusive.',
  })

export const writeStdinSchema = z
  .object({
    tabIdOrName: boundedTerminalReferenceSchema.describe('The ID or Name of the terminal tab'),
    sequence: z
      .array(z.string())
      .optional()
      .describe('List of strings; CTRL_C and exact C0 names are resolved to their control characters.')
  })
  .refine((val) => !!val.sequence && val.sequence.length > 0, {
    message: 'Provide a non-empty sequence list.'
  })

export const reconnectTerminalTabSchema = z.object({
  tabIdOrName: boundedTerminalReferenceSchema.describe('The ID or Name of the disconnected SSH terminal tab to reconnect')
})

// --- Constants ---

export const C0_NAMES = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
  'BS', 'HT', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
  'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US', 'DEL'
] as const

export const C0_CHAR_BY_NAME: Record<(typeof C0_NAMES)[number], string> = {
  NUL: '\x00', SOH: '\x01', STX: '\x02', ETX: '\x03', EOT: '\x04', ENQ: '\x05', ACK: '\x06', BEL: '\x07',
  BS: '\x08', HT: '\x09', LF: '\x0a', VT: '\x0b', FF: '\x0c', CR: '\x0d', SO: '\x0e', SI: '\x0f',
  DLE: '\x10', DC1: '\x11', DC2: '\x12', DC3: '\x13', DC4: '\x14', NAK: '\x15', SYN: '\x16', ETB: '\x17',
  CAN: '\x18', EM: '\x19', SUB: '\x1a', ESC: '\x1b', FS: '\x1c', GS: '\x1d', RS: '\x1e', US: '\x1f', DEL: '\x7f'
}

export const CONTROL_SEQUENCE_ALIASES = {
  CTRL_C: '\x03',
} as const

const RECONNECT_READY_TIMEOUT_MS = 45 * 1000
const RECONNECT_READY_POLL_MS = 500

// --- Implementations ---

type RunCommandOptions = {
  shouldSkipWait?: () => boolean
  getSkipWaitReason?: () => string | undefined
  onContinuesInBackground?: () => void
  onRuntimeBoundary?: () => void
}

const fallbackCaptureMetadata = (
  output: string,
  state: CommandCaptureMetadata['state'] = 'unknown'
): CommandCaptureMetadata => {
  const bytes = Buffer.byteLength(output, 'utf8')
  return {
    state,
    ...(state === 'unknown' ? { reason: 'tracking_unavailable' as const } : {}),
    observedUtf8Bytes: bytes,
    retainedUtf8Bytes: bytes,
    availableLineCount: output
      ? output.split('\n').length - (output.endsWith('\n') ? 1 : 0)
      : 0,
    revision: 0,
    terminalControlsObserved: false,
  }
}

const formatClosedTerminalCommandHistoryHeader = (
  terminalId: string
): string =>
  [
    `Terminal: ${terminalId} (closed)`,
    'terminal_status:',
    '- runtime_state: closed',
    '- shell_input_state: unavailable',
    '- tab_still_exists: false',
    '- reconnectable: false',
    '',
    'The terminal tab is closed. This result comes from bounded, read-only command history retained by the current GyShell process.',
  ].join('\n')

const formatRunningCommandConflict = (params: {
  error: string
  terminalId: string
  activeTaskId?: string
}): string => {
  const boundedError = String(params.error || '').slice(0, 4096)
  const inspection = params.activeTaskId
    ? `Use read_command_output with tabIdOrName=${JSON.stringify(params.terminalId)} and history_command_match_id=${JSON.stringify(params.activeTaskId)} to inspect its bounded transcript.`
    : `Use read_terminal_tab with tabIdOrName=${JSON.stringify(params.terminalId)} to inspect the current rendered screen.`
  return [
    `Error: ${boundedError}`,
    '',
    'No new command was submitted. GyShell intentionally omitted the terminal screen from this error so untrusted or large display content cannot masquerade as command output.',
    inspection,
    'Use write_stdin only if you intend to interact with or interrupt the active command.',
  ].join('\n')
}

function resolveCommandOutputSource(params: {
  context: ToolExecutionContext
  terminalId: string
  historyCommandMatchId: string
  fallbackOutput?: string
  fallbackExitCode?: number
  fallbackExecutionState?: CommandExecutionState
  fallbackCapture?: CommandCaptureMetadata
}): CommandOutputSource {
  const getSnapshot = (params.context.terminalService as any)
    .getCommandOutputSnapshot
  const snapshot =
    typeof getSnapshot === 'function'
      ? getSnapshot.call(
          params.context.terminalService,
          params.terminalId,
          params.historyCommandMatchId
        )
      : undefined
  if (snapshot) {
    return {
      terminalId: params.terminalId,
      historyCommandMatchId: params.historyCommandMatchId,
      executionState: snapshot.executionState,
      ...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
      output: snapshot.output || '',
      capture: { ...snapshot.capture },
    }
  }
  const output = params.fallbackOutput || ''
  return {
    terminalId: params.terminalId,
    historyCommandMatchId: params.historyCommandMatchId,
    executionState: params.fallbackExecutionState || 'outcome_unknown',
    ...(params.fallbackExitCode !== undefined
      ? { exitCode: params.fallbackExitCode }
      : {}),
    output,
    capture:
      params.fallbackCapture || fallbackCaptureMetadata(output, 'unknown'),
  }
}

function enqueueNowaitCompletionNotification(params: {
  context: ToolExecutionContext
  terminalId: string
  terminalName: string
  command: string
  historyCommandMatchId: string
  output?: string
  exitCode?: number
  executionState?: CommandExecutionState
  capture?: CommandCaptureMetadata
  runtimeBoundary?: boolean
  terminalStatus?: string
}): void {
  const source = resolveCommandOutputSource({
    context: params.context,
    terminalId: params.terminalId,
    historyCommandMatchId: params.historyCommandMatchId,
    fallbackOutput: params.output,
    fallbackExitCode: params.exitCode,
    fallbackExecutionState:
      params.executionState ||
      (params.runtimeBoundary ? 'outcome_unknown' : 'finished'),
    fallbackCapture: params.capture,
  })
  const formatted = formatInitialCommandOutput(source, {
    terminalStatus: params.terminalStatus,
  })
  if (formatted.contract.executionState !== 'running') {
    params.context.replaceExecCommandToolResult?.({
      content: formatted.text,
      terminalId: params.terminalId,
      historyCommandMatchId: params.historyCommandMatchId,
    })
  }
  params.context.sendEvent(params.context.sessionId, {
    messageId: params.context.messageId,
    type: 'command_finished',
    command: params.command,
    commandId: params.context.messageId,
    tabName: params.terminalName,
    exitCode: params.exitCode,
    outputDelta: formatted.text,
    commandOutput: formatted.contract,
    outputMode: 'replace',
    isNowait: true,
  } as any)
  params.context.completeBackgroundExecCommand?.({
    terminalId: params.terminalId,
    terminalName: params.terminalName,
    historyCommandMatchId: params.historyCommandMatchId,
    command: params.command,
    exitCode: params.exitCode
  })
  if (!params.context.enqueueQueuedInsertion) return
  params.context.enqueueQueuedInsertion(
    buildExecCommandNowaitCompletedInsertion({
      terminalId: params.terminalId,
      terminalName: params.terminalName,
      historyCommandMatchId: params.historyCommandMatchId,
      command: params.command,
      exitCode: params.exitCode,
      runtimeBoundary: params.runtimeBoundary,
      executionState: source.executionState,
      terminalAvailable:
        params.context.terminalService.getTerminalRuntimeSnapshot(
          params.terminalId
        ) != null,
    })
  )
}

export async function runCommand(
  args: z.infer<typeof execCommandSchema>,
  context: ToolExecutionContext,
  options?: RunCommandOptions
): Promise<string> {
  const validation = execCommandSchema.safeParse(args)
  if (!validation.success) {
    return `Parameter validation error for exec_command: ${validation.error.message}`
  }
  const { tabIdOrName, command } = validation.data
  const { terminalService, sessionId, messageId } = context
  
  abortIfNeeded(context.signal)
  const resolved = resolveTerminalForTool(context, tabIdOrName)
  if (!resolved.ok) {
    return resolved.message
  }
  const bestMatch = resolved.terminal
  if (!resolved.snapshot.canRunCommand) {
    return formatTerminalUnavailableForTool(
      resolved.snapshot,
      'run commands in this terminal'
    )
  }

  const allowed = await checkCommandPolicy(command, 'run_command', context)
  if (!allowed.allowed) {
    abortIfNeeded(context.signal)
    context.sendEvent(sessionId, {
      messageId,
      type: 'command_started',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      isNowait: false
    })
    context.sendEvent(sessionId, {
      messageId,
      type: 'command_finished',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: -1,
      outputDelta: allowed.message
    })
    return allowed.message
  }

  abortIfNeeded(context.signal)
  context.sendEvent(sessionId, { 
    messageId,
    type: 'command_started', 
    command, 
    commandId: messageId,
    tabName: bestMatch.title || bestMatch.id,
    isNowait: false
  })

  let shouldNotifyAsyncCompletion = false
  let initialResultPublished = false
  let completionBeforeInitialResult: CommandResult | undefined
  const publishAsyncCompletion = (finished: CommandResult): void => {
    enqueueNowaitCompletionNotification({
      context,
      terminalId: bestMatch.id,
      terminalName: bestMatch.title || bestMatch.id,
      command,
      historyCommandMatchId: finished.history_command_match_id,
      output: finished.stdoutDelta,
      exitCode: finished.exitCode,
      executionState: finished.executionState,
      capture: finished.capture,
      runtimeBoundary: finished.runtimeBoundary,
      terminalStatus: finished.terminalStatus,
    })
  }
  try {
    // Subscribe to skip wait feedback for this message
    let userSkipped = false
    if (context.waitForFeedback) {
      context.waitForFeedback(messageId).then((payload: any) => {
        if (payload?.type === 'SKIP_WAIT') {
          userSkipped = true
        }
      })
    }

    const result = await terminalService.runCommandAndWait(bestMatch.id, command, {
      signal: context.signal,
      interruptOnAbort: false,
      shouldSkip: () => {
        const shouldSkip =
          userSkipped || options?.shouldSkipWait?.() === true
        if (shouldSkip) {
          shouldNotifyAsyncCompletion = true
        }
        return shouldSkip
      },
      onFinished: (finished) => {
        if (!shouldNotifyAsyncCompletion) return
        if (!initialResultPublished) {
          completionBeforeInitialResult = finished
          return
        }
        publishAsyncCompletion(finished)
      }
    })
    const historyCommandMatchId = result.history_command_match_id
    let executionState: CommandExecutionState =
      result.executionState ||
      (result.runtimeBoundary ? 'outcome_unknown' : 'finished')
    let fallbackOutput = result.stdoutDelta || ''
    let backgroundRequested = false
    if (result.exitCode === -3) {
      shouldNotifyAsyncCompletion = true
      options?.onContinuesInBackground?.()
      backgroundRequested = true
      executionState = 'running'
      fallbackOutput = ''
    } else if (result.runtimeBoundary) {
      options?.onRuntimeBoundary?.()
      executionState = 'outcome_unknown'
    } else if (result.executionState === 'running') {
      shouldNotifyAsyncCompletion = true
      options?.onContinuesInBackground?.()
      backgroundRequested = true
      executionState = 'running'
      fallbackOutput = ''
    }

    const source = resolveCommandOutputSource({
      context,
      terminalId: bestMatch.id,
      historyCommandMatchId,
      fallbackOutput,
      fallbackExitCode: result.exitCode,
      fallbackExecutionState: executionState,
      fallbackCapture: result.capture,
    })
    if (backgroundRequested && source.executionState === 'running') {
      context.registerBackgroundExecCommand?.({
        terminalId: bestMatch.id,
        terminalName: bestMatch.title || bestMatch.id,
        historyCommandMatchId,
        command
      })
    }
    const formatted = formatInitialCommandOutput(source, {
      terminalStatus: result.terminalStatus,
    })
    const finalResult = formatted.text

    context.replaceExecCommandToolResult?.({
      content: finalResult,
      terminalId: bestMatch.id,
      historyCommandMatchId,
    })

    context.sendEvent(sessionId, {
      messageId,
      type: 'command_finished',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: result.exitCode,
      outputDelta: finalResult,
      commandOutput: formatted.contract,
      outputMode: 'replace',
      ...(formatted.contract.executionState === 'running'
        ? { isNowait: true }
        : {}),
    })
    initialResultPublished = true
    if (
      completionBeforeInitialResult &&
      formatted.contract.executionState === 'running'
    ) {
      publishAsyncCompletion(completionBeforeInitialResult)
    }
    return finalResult
  } catch (error) {
    if (isAbortError(error)) {
      const continuingCommandId =
        error &&
        typeof error === 'object' &&
        (error as any).commandContinues === true
          ? String((error as any).history_command_match_id || '')
          : ''
      if (continuingCommandId) {
        const task = terminalService.getCommandTask(
          bestMatch.id,
          continuingCommandId
        )
        const isStillRunning =
          task?.status === 'running' &&
          terminalService.getActiveTaskId(bestMatch.id) ===
            continuingCommandId
        if (isStillRunning) {
          shouldNotifyAsyncCompletion = true
          context.registerBackgroundExecCommand?.({
            terminalId: bestMatch.id,
            terminalName: bestMatch.title || bestMatch.id,
            historyCommandMatchId: continuingCommandId,
            command
          })

          // The foreground ToolMessage is being cancelled, but the physical
          // command remains live. Publish a durable typed replacement before
          // rethrowing AbortError so UI history and restart recovery retain
          // that distinction. Keep initialResultPublished false until after
          // sendEvent: a re-entrant completion is then queued and cannot race
          // ahead of this running snapshot.
          const source = resolveCommandOutputSource({
            context,
            terminalId: bestMatch.id,
            historyCommandMatchId: continuingCommandId,
            fallbackExecutionState: 'running',
            fallbackCapture: fallbackCaptureMetadata('', 'in_progress'),
          })
          const formatted = formatInitialCommandOutput(source)
          context.replaceExecCommandToolResult?.({
            content: formatted.text,
            terminalId: bestMatch.id,
            historyCommandMatchId: continuingCommandId,
          })
          context.sendEvent(sessionId, {
            messageId,
            type: 'command_finished',
            command,
            commandId: messageId,
            tabName: bestMatch.title || bestMatch.id,
            exitCode: -3,
            outputDelta: formatted.text,
            commandOutput: formatted.contract,
            outputMode: 'replace',
            isNowait: true,
          } as any)
          initialResultPublished = true
          if (completionBeforeInitialResult) {
            publishAsyncCompletion(completionBeforeInitialResult)
            completionBeforeInitialResult = undefined
          }
        } else if (task && task.status !== 'running') {
          enqueueNowaitCompletionNotification({
            context,
            terminalId: bestMatch.id,
            terminalName: bestMatch.title || bestMatch.id,
            command,
            historyCommandMatchId: continuingCommandId,
            exitCode: task.exitCode,
            executionState: task.runtimeBoundary
              ? 'outcome_unknown'
              : task.status === 'aborted'
                ? 'aborted'
                : 'finished',
            capture: task.capture,
            runtimeBoundary: task.runtimeBoundary,
            terminalStatus: task.terminalStatus,
          })
        }
      }
      throw error
    }
    let errorMessage = error instanceof Error ? error.message : String(error)

    // Keep this diagnostic bounded and structurally separate from output of
    // the command that is already running.
    if (errorMessage.includes('There is a running exec_command')) {
      const activeTaskId = terminalService.getActiveTaskId(bestMatch.id)
      errorMessage = formatRunningCommandConflict({
        error: errorMessage,
        terminalId: bestMatch.id,
        activeTaskId,
      })
    }

    context.sendEvent(sessionId, { 
      messageId,
      type: 'command_finished', 
      command, 
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: -1,
      outputDelta: errorMessage
    })
    return errorMessage
  }
}

export async function runCommandNowait(args: z.infer<typeof execCommandSchema>, context: ToolExecutionContext): Promise<string> {
  const validation = execCommandSchema.safeParse(args)
  if (!validation.success) {
    return `Parameter validation error for exec_command: ${validation.error.message}`
  }
  const { tabIdOrName, command } = validation.data
  const { terminalService, sessionId, messageId } = context
  
  abortIfNeeded(context.signal)
  const resolved = resolveTerminalForTool(context, tabIdOrName)
  if (!resolved.ok) {
    return resolved.message
  }
  const bestMatch = resolved.terminal
  if (!resolved.snapshot.canRunCommand) {
    return formatTerminalUnavailableForTool(
      resolved.snapshot,
      'run commands in this terminal'
    )
  }

  const allowed = await checkCommandPolicy(command, 'run_command_nowait', context)
  if (!allowed.allowed) {
    abortIfNeeded(context.signal)
    context.sendEvent(sessionId, {
      messageId,
      type: 'command_started',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      isNowait: true
    })
    context.sendEvent(sessionId, {
      messageId,
      type: 'command_finished',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: -1,
      outputDelta: allowed.message
    })
    return allowed.message
  }

  abortIfNeeded(context.signal)
  context.sendEvent(sessionId, { 
    messageId,
    type: 'command_started', 
    command, 
    commandId: messageId,
    tabName: bestMatch.title || bestMatch.id,
    isNowait: true
  })

  try {
    let initialResultPublished = false
    let completionBeforeInitialResult: CommandResult | undefined
    const publishAsyncCompletion = (finished: CommandResult): void => {
      enqueueNowaitCompletionNotification({
        context,
        terminalId: bestMatch.id,
        terminalName: bestMatch.title || bestMatch.id,
        command,
        historyCommandMatchId: finished.history_command_match_id,
        output: finished.stdoutDelta,
        exitCode: finished.exitCode,
        executionState: finished.executionState,
        capture: finished.capture,
        runtimeBoundary: finished.runtimeBoundary,
        terminalStatus: finished.terminalStatus,
      })
    }
    const historyCommandMatchId = await terminalService.runCommandNoWait(
      bestMatch.id,
      command,
      (finished) => {
        if (!initialResultPublished) {
          completionBeforeInitialResult = finished
          return
        }
        publishAsyncCompletion(finished)
      },
      context.signal
    )
    const source = resolveCommandOutputSource({
      context,
      terminalId: bestMatch.id,
      historyCommandMatchId,
      fallbackExecutionState: 'running',
      fallbackCapture: fallbackCaptureMetadata('', 'in_progress'),
    })
    if (source.executionState === 'running') {
      context.registerBackgroundExecCommand?.({
        terminalId: bestMatch.id,
        terminalName: bestMatch.title || bestMatch.id,
        historyCommandMatchId,
        command
      })
    }
    const formatted = formatInitialCommandOutput(source)
    context.replaceExecCommandToolResult?.({
      content: formatted.text,
      terminalId: bestMatch.id,
      historyCommandMatchId,
    })
    context.sendEvent(sessionId, {
      messageId,
      type: 'command_finished',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: source.exitCode ?? (source.executionState === 'running' ? -3 : undefined),
      outputDelta: formatted.text,
      commandOutput: formatted.contract,
      outputMode: 'replace',
      isNowait: true,
    } as any)
    initialResultPublished = true
    if (
      completionBeforeInitialResult &&
      formatted.contract.executionState === 'running'
    ) {
      publishAsyncCompletion(completionBeforeInitialResult)
    }
    return formatted.text
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    let errorMessage = error instanceof Error ? error.message : String(error)

    // Keep this diagnostic bounded and structurally separate from output of
    // the command that is already running.
    if (errorMessage.includes('There is a running exec_command')) {
      const activeTaskId = terminalService.getActiveTaskId(bestMatch.id)
      errorMessage = formatRunningCommandConflict({
        error: errorMessage,
        terminalId: bestMatch.id,
        activeTaskId,
      })
    }

    context.sendEvent(sessionId, {
      messageId,
      type: 'command_finished',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: -1,
      outputDelta: errorMessage
    })
    return errorMessage
  }
}

export async function readTerminalTab(args: z.infer<typeof readTerminalTabSchema>, context: ToolExecutionContext): Promise<string> {
  const { tabIdOrName, lines = 100 } = args
  const { terminalService, sessionId, messageId, sendEvent } = context
  
  abortIfNeeded(context.signal)
  const resolved = resolveTerminalForTool(context, tabIdOrName)
  if (!resolved.ok) {
    return resolved.message
  }
  const bestMatch = resolved.terminal
  
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'read_terminal_tab',
    title: `Read ${bestMatch.title || bestMatch.id} Tab`,
    hint: args.lines === undefined ? '' : `last ${lines} lines`
  })

  const output = args.lines === undefined 
    ? terminalService.getRecentOutput(bestMatch.id) 
    : terminalService.getRecentOutput(bestMatch.id, lines)
  const terminalContent =
    output && output !== 'No output available.' ? output : '(No output available.)'
  
  const finalResult = `${formatTerminalStatusHeader(resolved.snapshot)}
The following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}":
<terminal_content>
${terminalContent}
</terminal_content>`
  
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_delta',
    outputDelta: finalResult
  })

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_finished'
  })

  return finalResult
}

export async function readCommandOutput(
  args: z.infer<typeof readCommandOutputSchema>,
  context: ToolExecutionContext
): Promise<string> {
  const { terminalService, sessionId, messageId, sendEvent } = context
  const validation = readCommandOutputSchema.safeParse(args)
  if (!validation.success) {
    const errorText = `Parameter validation error for read_command_output: ${validation.error.message}`
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'read_command_output',
      input: JSON.stringify(args ?? {}),
      output: errorText,
    })
    return errorText
  }
  const { tabIdOrName, history_command_match_id, cursor, offset, limit, maxBytes } = validation.data

  abortIfNeeded(context.signal)
  const getSnapshot = (terminalService as any).getCommandOutputSnapshot
  const getRecordLocation = (terminalService as any).getCommandRecordLocation
  const exactHistoricalSnapshot =
    typeof getSnapshot === 'function'
      ? getSnapshot.call(
          terminalService,
          tabIdOrName,
          history_command_match_id
        )
      : undefined
  const exactHistoricalTasks = terminalService.getCommandTasks(tabIdOrName)
  const terminalResolution = resolveTerminalForTool(context, tabIdOrName)
  if (
    !terminalResolution.ok &&
    !exactHistoricalSnapshot &&
    exactHistoricalTasks.length === 0
  ) {
    const errorText = terminalResolution.message
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'read_command_output',
      input: JSON.stringify(args ?? {}),
      output: errorText
    })
    return errorText
  }
  const exactLocation = exactHistoricalSnapshot && typeof getRecordLocation === 'function'
    ? getRecordLocation.call(
        terminalService,
        tabIdOrName,
        history_command_match_id
      )
    : undefined
  const exactBelongsToDetachedHistory = Boolean(
    exactHistoricalSnapshot &&
      (exactLocation === 'detached' ||
        (terminalResolution.ok &&
          terminalResolution.terminal.id !== tabIdOrName))
  )
  const terminalId = exactHistoricalSnapshot
    ? tabIdOrName
    : terminalResolution.ok
      ? terminalResolution.terminal.id
      : tabIdOrName
  const resolvedSnapshot =
    !exactHistoricalSnapshot && typeof getSnapshot === 'function'
      ? getSnapshot.call(terminalService, terminalId, history_command_match_id)
      : undefined
  const resolvedLocation = resolvedSnapshot && typeof getRecordLocation === 'function'
    ? getRecordLocation.call(
        terminalService,
        terminalId,
        history_command_match_id
      )
    : undefined
  const snapshot = exactHistoricalSnapshot || resolvedSnapshot
  const recordIsDetached =
    exactBelongsToDetachedHistory || resolvedLocation === 'detached'
  const terminalName =
    terminalResolution.ok && !recordIsDetached
      ? terminalResolution.terminal.title || terminalResolution.terminal.id
      : terminalId
  const task = terminalService.getCommandTask(terminalId, history_command_match_id)
  if (!task && !snapshot) {
    const tasks = terminalService.getCommandTasks(terminalId)
    const history = tasks.length
      ? tasks
          .slice(0, 20)
          .map((t) => {
            const started = new Date(t.startTime).toISOString()
            const commandPreview = String(t.command || '').replace(/\s+/g, ' ').slice(0, 160)
            return `- id: ${t.id}, status: ${t.status}, command: ${commandPreview}, started: ${started}`
          })
          .join('\n')
      : '(No command history for this terminal)'
    const errorText = [
      `Error: command record ${JSON.stringify(history_command_match_id)} was not found for terminal ${JSON.stringify(terminalName)}.`,
      'The record may never have existed, or its bounded process-local history may have expired. Do not automatically replay a side-effecting command merely to recover output.',
      history,
    ].join('\n')
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'read_command_output',
      input: JSON.stringify(args ?? {}),
      output: errorText
    })
    return errorText
  }

  const source = snapshot
    ? {
        terminalId,
        historyCommandMatchId: snapshot.taskId,
        executionState: snapshot.executionState,
        ...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
        output: snapshot.output || '',
        capture: { ...snapshot.capture },
      }
    : resolveCommandOutputSource({
        context,
        terminalId,
        historyCommandMatchId: history_command_match_id,
        fallbackOutput: task?.output || '',
        fallbackExitCode: task?.exitCode,
        fallbackExecutionState:
          task?.runtimeBoundary
            ? 'outcome_unknown'
            : task?.status === 'finished'
              ? 'finished'
              : task?.status === 'aborted'
                ? 'aborted'
                : 'running',
        fallbackCapture: task?.capture,
      })
  let formatted: ReturnType<typeof formatCommandOutputPage>
  try {
    formatted = formatCommandOutputPage({
      source,
      options: { cursor, offset, limit, maxBytes },
      command: task?.command || snapshot?.command || '',
      terminalStatus: terminalResolution.ok && !recordIsDetached
        ? formatTerminalStatusHeader(terminalResolution.snapshot)
        : formatClosedTerminalCommandHistoryHeader(terminalId),
    })
  } catch (error) {
    const errorText = `Parameter validation error for read_command_output: ${
      error instanceof Error ? error.message : String(error)
    }`
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'read_command_output',
      input: JSON.stringify(args ?? {}),
      output: errorText,
    })
    return errorText
  }
  const finalOutput = formatted.text

  sendEvent(sessionId, {
    messageId,
    type: 'tool_call',
    toolName: 'read_command_output',
    input: JSON.stringify(args ?? {}),
    output: finalOutput,
    commandOutput: formatted.contract,
  })

  return finalOutput
}

export async function writeStdin(args: z.infer<typeof writeStdinSchema>, context: ToolExecutionContext): Promise<string> {
  const { tabIdOrName, sequence } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const terminalResolution = resolveTerminalForTool(context, tabIdOrName)
  if (!terminalResolution.ok) {
    const errorText = terminalResolution.message
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'write_stdin',
      input: JSON.stringify(sequence ?? []),
      output: errorText
    })
    return errorText
  }
  const bestMatch = terminalResolution.terminal

  if (!terminalResolution.snapshot.canWrite) {
    const errorText = formatTerminalUnavailableForTool(
      terminalResolution.snapshot,
      'send input to this terminal'
    )
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'write_stdin',
      input: JSON.stringify(sequence ?? []),
      output: errorText
    })
    return errorText
  }

  const commandText = (sequence ?? []).join('')
  const allowed = await checkCommandPolicy(commandText, 'write_stdin', context)
  if (!allowed.allowed) {
    abortIfNeeded(context.signal)
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'write_stdin',
      input: JSON.stringify(sequence ?? []),
      output: allowed.message
    })
    return allowed.message
  }

  const resolvedSequence: string[] = []
  for (const item of sequence ?? []) {
    if (item === 'CTRL_C') {
      resolvedSequence.push(CONTROL_SEQUENCE_ALIASES.CTRL_C)
    } else if (C0_NAMES.includes(item as (typeof C0_NAMES)[number])) {
      resolvedSequence.push(C0_CHAR_BY_NAME[item as (typeof C0_NAMES)[number]])
    } else {
      resolvedSequence.push(item)
    }
  }

  await terminalService.writeInputSequence(bestMatch.id, resolvedSequence, {
    intervalMs: resolvedSequence.length > 1 ? 100 : 0,
    signal: context.signal,
    inputOwner: 'active-task'
  })

  await waitWithSignal(1000, context.signal)
  abortIfNeeded(context.signal)
  const output = terminalService.getRecentOutput(bestMatch.id) || 'No output available.'
  const resultHint = `Sent sequence: ${sequence?.join(', ')}. The following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}" 1s after the sequence was sent:
<terminal_content>
${output}
</terminal_content>`

  sendEvent(sessionId, {
    messageId,
    type: 'tool_call',
    toolName: 'write_stdin',
    input: JSON.stringify(sequence ?? []),
    output: resultHint
  })

  return resultHint
}

export async function reconnectTerminalTab(
  args: z.infer<typeof reconnectTerminalTabSchema>,
  context: ToolExecutionContext
): Promise<string> {
  const { tabIdOrName } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const resolved = resolveTerminalForTool(context, tabIdOrName)
  if (!resolved.ok) {
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'reconnect_terminal_tab',
      input: JSON.stringify(args),
      output: resolved.message
    })
    return resolved.message
  }

  const terminal = resolved.terminal
  const startSnapshot = resolved.snapshot
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'reconnect_terminal_tab',
    title: `Reconnect ${terminal.title || terminal.id}`,
    hint: startSnapshot.runtimeState,
    input: JSON.stringify(args)
  })

  const finish = (output: string): string => {
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: output
    })
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished'
    })
    return output
  }

  if (startSnapshot.runtimeState === 'ready') {
    return finish(
      `${formatTerminalStatusHeader(startSnapshot)}
Terminal tab "${terminal.title || terminal.id}" is already connected. No reconnect was attempted.`
    )
  }

  if (startSnapshot.runtimeState === 'initializing') {
    return finish(
      `${formatTerminalStatusHeader(startSnapshot)}
Terminal tab "${terminal.title || terminal.id}" is already initializing. Wait briefly, then verify it with read_terminal_tab or exec_command.`
    )
  }

  if (!startSnapshot.reconnectable) {
    return finish(
      `${formatTerminalStatusHeader(startSnapshot)}
Cannot reconnect this tab. Only disconnected SSH tabs with a saved SSH config are reconnectable.`
    )
  }

  try {
    await terminalService.reconnectTerminal(terminal.id)
    const finalSnapshot = await waitForReconnectTerminalState(
      terminalService,
      terminal.id,
      context.signal
    )

    if (!finalSnapshot) {
      return finish(
        `Reconnect was requested for terminal tab "${terminal.title || terminal.id}", but the tab was closed before readiness could be confirmed.`
      )
    }

    if (finalSnapshot.runtimeState === 'ready') {
      return finish(
        `${formatTerminalStatusHeader(finalSnapshot)}
Reconnect succeeded. The existing terminal tab is ready again. Re-validate the remote working directory and environment before continuing.`
      )
    }

    if (finalSnapshot.runtimeState === 'exited') {
      return finish(
        `${formatTerminalStatusHeader(finalSnapshot)}
Reconnect was attempted, but the terminal disconnected again before becoming ready.`
      )
    }

    return finish(
      `${formatTerminalStatusHeader(finalSnapshot)}
Reconnect was requested, but the terminal is still initializing after ${Math.floor(
        RECONNECT_READY_TIMEOUT_MS / 1000
      )} seconds. Check the tab again before running commands.`
    )
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    const snapshot = terminalService.getTerminalRuntimeSnapshot(terminal.id)
    const status = snapshot ? `\n${formatTerminalStatusHeader(snapshot)}` : ''
    return finish(`Reconnect failed: ${message}${status}`)
  }
}


// --- Internal Helpers ---

async function checkCommandPolicy(
  command: string,
  toolName: string,
  context: ToolExecutionContext
): Promise<{ allowed: boolean; message: string }> {
  abortIfNeeded(context.signal)
  const decision = await context.commandPolicyService.evaluate(command, context.commandPolicyMode)
  if (decision === 'allow') {
    return { allowed: true, message: '' }
  }
  if (decision === 'deny') {
    return { allowed: false, message: `Command blocked by policy: ${command}` }
  }
  const approved = await context.commandPolicyService.requestApproval({
    sessionId: context.sessionId,
    messageId: context.messageId,
    command,
    toolName,
    sendEvent: context.sendEvent,
    signal: context.signal
  })

  if (!approved) {
    return { allowed: false, message: `User rejected command: ${command}` }
  }
  return { allowed: true, message: '' }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('AbortError')
  }
}

async function waitForReconnectTerminalState(
  terminalService: ToolExecutionContext['terminalService'],
  terminalId: string,
  signal?: AbortSignal
) {
  const deadline = Date.now() + RECONNECT_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    abortIfNeeded(signal)
    const snapshot = terminalService.getTerminalRuntimeSnapshot(terminalId)
    if (!snapshot || snapshot.runtimeState === 'ready' || snapshot.runtimeState === 'exited') {
      return snapshot
    }
    await waitWithSignal(RECONNECT_READY_POLL_MS, signal)
  }
  return terminalService.getTerminalRuntimeSnapshot(terminalId)
}

function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message === 'AbortError'
  }
  return false
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error('AbortError'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
