import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import { buildExecCommandNowaitCompletedInsertion } from '../queuedInsertions'
import {
  formatTerminalStatusHeader,
  formatTerminalUnavailableForTool,
  resolveTerminalForTool
} from './terminal_runtime_guard'

// --- Schemas ---

export const execCommandSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab'),
  command: z.string().describe('The shell command to execute'),
  waitMode: z
    .enum(['wait', 'nowait'])
    .optional()
    .default('wait')
    .describe('Execution mode: "wait" runs synchronously and waits for completion; "nowait" runs asynchronously and returns immediately.')
})

export const readTerminalTabSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab'),
  lines: z.number().optional().default(100).describe('Number of lines to read')
})

export const readCommandOutputSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab'),
  history_command_match_id: z.string().describe('The unique command ID to read output from'),
  offset: z.number().optional().describe('The line number to start reading from (0-based).'),
  limit: z.number().optional().describe('The number of lines to read (defaults to 2000).')
})

export const writeStdinSchema = z
  .object({
    tabIdOrName: z.string().describe('The ID or Name of the terminal tab'),
    sequence: z
      .array(z.string())
      .optional()
      .describe('List of strings; any item that equals a C0 name is treated as that C0 control code.')
  })
  .refine((val) => !!val.sequence && val.sequence.length > 0, {
    message: 'Provide a non-empty sequence list.'
  })

export const reconnectTerminalTabSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the disconnected SSH terminal tab to reconnect')
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

const COMMAND_OUTPUT_MAX_LINES = 200
const COMMAND_OUTPUT_HEAD_LINES = 60
const COMMAND_OUTPUT_TAIL_LINES = 60
const COMMAND_OUTPUT_MAX_LINE_LENGTH = 2000
const COMMAND_OUTPUT_MAX_BYTES = 50 * 1024

const COMMAND_READ_DEFAULT_LIMIT = 2000
const COMMAND_READ_MAX_LINE_LENGTH = 2000
const COMMAND_READ_MAX_BYTES = 50 * 1024
const RECONNECT_READY_TIMEOUT_MS = 45 * 1000
const RECONNECT_READY_POLL_MS = 500

// --- Implementations ---

type RunCommandOptions = {
  shouldSkipWait?: () => boolean
  getSkipWaitReason?: () => string | undefined
  onContinuesInBackground?: () => void
  onRuntimeBoundary?: () => void
}

function enqueueNowaitCompletionNotification(params: {
  context: ToolExecutionContext
  terminalId: string
  terminalName: string
  command: string
  historyCommandMatchId: string
  exitCode?: number
  runtimeBoundary?: boolean
}): void {
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
      runtimeBoundary: params.runtimeBoundary
    })
  )
}

export async function runCommand(
  args: z.infer<typeof execCommandSchema>,
  context: ToolExecutionContext,
  options?: RunCommandOptions
): Promise<string> {
  const { tabIdOrName, command } = args
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
          options?.onContinuesInBackground?.()
        }
        return shouldSkip
      },
      onFinished: (finished) => {
        if (!shouldNotifyAsyncCompletion) return
        enqueueNowaitCompletionNotification({
          context,
          terminalId: bestMatch.id,
          terminalName: bestMatch.title || bestMatch.id,
          command,
          historyCommandMatchId: finished.history_command_match_id,
          exitCode: finished.exitCode,
          runtimeBoundary: finished.runtimeBoundary
        })
      }
    })
    const historyCommandMatchId = result.history_command_match_id
    const truncatedOutput = truncateCommandOutput(result.stdoutDelta || '', historyCommandMatchId, bestMatch.id)
    
    let finalResult = ''
    if (result.exitCode === -3 || result.stdoutDelta === 'USER_SKIPPED_WAIT') {
      shouldNotifyAsyncCompletion = true
      options?.onContinuesInBackground?.()
      context.registerBackgroundExecCommand?.({
        terminalId: bestMatch.id,
        terminalName: bestMatch.title || bestMatch.id,
        historyCommandMatchId,
        command
      })
      const autoSwitchReason = options?.getSkipWaitReason?.()?.trim()
      finalResult = autoSwitchReason
        ? `This command has been switched to nowait mode because ${autoSwitchReason}. The command is currently running in the background. Please DO NOT wait for it to finish unless specifically asked. You can use read_command_output to check its progress if needed. history_command_match_id=${historyCommandMatchId}, terminalId=${bestMatch.id}`
        : `The command has been switched to asynchronous mode by user choice. It is currently running in the background. Please DO NOT wait for it to finish unless specifically asked. You can use read_command_output to check its progress if needed. history_command_match_id=${historyCommandMatchId}, terminalId=${bestMatch.id}`
      
      // Update the finished event to mark it as isNowait: true so the UI banner switches to Async style
      context.sendEvent(sessionId, { 
        messageId,
        type: 'command_finished', 
        command, 
        commandId: messageId,
        tabName: bestMatch.title || bestMatch.id,
        exitCode: result.exitCode,
        outputDelta: finalResult,
        isNowait: true // Force UI to switch to Async style
      })
      return finalResult
    } else if (result.runtimeBoundary) {
      options?.onRuntimeBoundary?.()
      finalResult = `The command did not reach a definitive tracked completion. It may still be running, or the terminal runtime may have exited; the command outcome is unknown and must not be treated as successful or replayed automatically. The following output was retained (history_command_match_id=${historyCommandMatchId}):
<terminal_content>
${truncatedOutput}
</terminal_content>`
    } else if (result.exitCode === -1 && result.stdoutDelta?.includes('timed out')) {
      shouldNotifyAsyncCompletion = true
      options?.onContinuesInBackground?.()
      context.registerBackgroundExecCommand?.({
        terminalId: bestMatch.id,
        terminalName: bestMatch.title || bestMatch.id,
        historyCommandMatchId,
        command
      })
      finalResult = `The command has been running for over 120s and has been switched to nowait mode (running in the background). You can use read_command_output to check its progress. history_command_match_id=${historyCommandMatchId}, terminalId=${bestMatch.id}`
    } else {
      finalResult = `The command has finished executing. The following is the output (history_command_match_id=${historyCommandMatchId}):
<terminal_content>
${truncatedOutput}
</terminal_content>`
    }

    context.sendEvent(sessionId, {
      messageId,
      type: 'command_finished',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: result.exitCode,
      outputDelta: finalResult
    })
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
        } else if (task?.status === 'finished') {
          enqueueNowaitCompletionNotification({
            context,
            terminalId: bestMatch.id,
            terminalName: bestMatch.title || bestMatch.id,
            command,
            historyCommandMatchId: continuingCommandId,
            exitCode: task.exitCode,
            runtimeBoundary: task.runtimeBoundary
          })
        }
      }
      throw error
    }
    let errorMessage = error instanceof Error ? error.message : String(error)

    // If it's a "command running" error, append the last terminal output
    if (errorMessage.includes('There is a running exec_command')) {
      const recentOutput = terminalService.getRecentOutput(bestMatch.id) || '(No recent output available)'
      const activeTaskId = terminalService.getActiveTaskId(bestMatch.id)
      errorMessage = `Error: ${errorMessage}\n\nThe current visible state of the terminal tab "${bestMatch.title || bestMatch.id}" is:
<terminal_content>
${recentOutput}
</terminal_content>\n\nIf you think you need to exit the current command, use write_stdin. If you want to check its status, use read_command_output.${activeTaskId ? ` history_command_match_id=${activeTaskId}, terminalId=${bestMatch.id}` : ''}`
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
  const { tabIdOrName, command } = args
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
    const historyCommandMatchId = await terminalService.runCommandNoWait(
      bestMatch.id,
      command,
      (finished) => {
        enqueueNowaitCompletionNotification({
          context,
          terminalId: bestMatch.id,
          terminalName: bestMatch.title || bestMatch.id,
          command,
          historyCommandMatchId: finished.history_command_match_id,
          exitCode: finished.exitCode,
          runtimeBoundary: finished.runtimeBoundary
        })
      },
      context.signal
    )
    context.registerBackgroundExecCommand?.({
      terminalId: bestMatch.id,
      terminalName: bestMatch.title || bestMatch.id,
      historyCommandMatchId,
      command
    })
    return `Command started in background. Use read_command_output to view output and check status (finished or running). history_command_match_id=${historyCommandMatchId}, terminalId=${bestMatch.id}.`
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    let errorMessage = error instanceof Error ? error.message : String(error)

    // If it's a "command running" error, append the last terminal output
    if (errorMessage.includes('There is a running exec_command')) {
      const recentOutput = terminalService.getRecentOutput(bestMatch.id) || '(No recent output available)'
      const activeTaskId = terminalService.getActiveTaskId(bestMatch.id)
      errorMessage = `Error: ${errorMessage}\n\nThe current visible state of the terminal tab "${bestMatch.title || bestMatch.id}" is:
<terminal_content>
${recentOutput}
</terminal_content>\n\nIf you think you need to exit the current command, use write_stdin. If you want to check its status, use read_command_output.${activeTaskId ? ` history_command_match_id=${activeTaskId}, terminalId=${bestMatch.id}` : ''}`
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
  const { tabIdOrName, history_command_match_id, offset = 0, limit = COMMAND_READ_DEFAULT_LIMIT } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const terminalResolution = resolveTerminalForTool(context, tabIdOrName)
  if (!terminalResolution.ok) {
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
  const bestMatch = terminalResolution.terminal

  const task = terminalService.getCommandTask(bestMatch.id, history_command_match_id)
  if (!task) {
    const tasks = terminalService.getCommandTasks(bestMatch.id)
    const history = tasks.length
      ? tasks
          .map((t) => {
            const started = new Date(t.startTime).toISOString()
            return `- id: ${t.id}, status: ${t.status}, command: ${t.command}, started: ${started}`
          })
          .join('\n')
      : '(No command history for this terminal)'
    const errorText = `Error: history_command_match_id "${history_command_match_id}" not found in terminal "${bestMatch.title || bestMatch.id}".\n${history}`
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'read_command_output',
      input: JSON.stringify(args ?? {}),
      output: errorText
    })
    return errorText
  }

  const output = task.output || ''
  const isRunning = task.status === 'running'
  const result = formatCommandOutputSlice({
    output,
    offset,
    limit,
    isRunning
  })

  const header = [
    `Command: ${task.command}`,
    `history_command_match_id: ${task.id}`,
    `Terminal: ${bestMatch.title || bestMatch.id}`,
    `Status: ${task.status}`
  ].join('\n')

  const finalOutput = `${formatTerminalStatusHeader(terminalResolution.snapshot)}
${header}
<terminal_content>
${result}
</terminal_content>`

  sendEvent(sessionId, {
    messageId,
    type: 'tool_call',
    toolName: 'read_command_output',
    input: JSON.stringify(args ?? {}),
    output: finalOutput
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
    if (C0_NAMES.includes(item as (typeof C0_NAMES)[number])) {
      resolvedSequence.push(C0_CHAR_BY_NAME[item as (typeof C0_NAMES)[number]])
    } else {
      resolvedSequence.push(item)
    }
  }

  await terminalService.writeInputSequence(bestMatch.id, resolvedSequence, {
    intervalMs: resolvedSequence.length > 1 ? 100 : 0,
    signal: context.signal
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

export function truncateCommandOutput(output: string, historyCommandMatchId: string, terminalId: string): string {
  const normalized = String(output || '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n').map((line) => {
    if (line.length <= COMMAND_OUTPUT_MAX_LINE_LENGTH) return line
    return line.slice(0, COMMAND_OUTPUT_MAX_LINE_LENGTH) + '...'
  })
  const totalLines = lines.length
  const totalBytes = Buffer.byteLength(lines.join('\n'), 'utf8')

  if (totalLines <= COMMAND_OUTPUT_MAX_LINES && totalBytes <= COMMAND_OUTPUT_MAX_BYTES) {
    return normalized.trimEnd()
  }

  const headCount = Math.min(COMMAND_OUTPUT_HEAD_LINES, totalLines)
  const tailCount = Math.min(COMMAND_OUTPUT_TAIL_LINES, Math.max(0, totalLines - headCount))
  const omittedStart = headCount + 1
  const omittedEnd = totalLines - tailCount
  const omittedMessage =
    omittedEnd >= omittedStart
      ? `... omitted lines ${omittedStart} - ${omittedEnd}. Use read_command_output to view full output, history_command_match_id=${historyCommandMatchId}, terminalId=${terminalId}`
      : `... output truncated. Use read_command_output to view full output, history_command_match_id=${historyCommandMatchId}, terminalId=${terminalId}`

  const lineLabel = (lineNumber: number) => `${lineNumber.toString().padStart(5, '0')}| `
  const formatLines = (startIndex: number, segment: string[]) =>
    segment.map((line, index) => `${lineLabel(startIndex + index)}${line}`)

  const head = formatLines(1, lines.slice(0, headCount))
  const tailStart = totalLines - tailCount + 1
  const tail = tailCount > 0 ? formatLines(tailStart, lines.slice(totalLines - tailCount)) : []
  const omittedLine = `.....| ${omittedMessage}`

  const truncatedLines = [...head, omittedLine, ...tail]

  let result = truncatedLines.join('\n').trimEnd()
  if (Buffer.byteLength(result, 'utf8') > COMMAND_OUTPUT_MAX_BYTES) {
    result =
      result.slice(0, COMMAND_OUTPUT_MAX_BYTES) +
      `\n.....| ... output truncated. Use read_command_output to view full output, history_command_match_id=${historyCommandMatchId}, terminalId=${terminalId}`
  }
  return result
}

function formatCommandOutputSlice(params: { output: string; offset: number; limit: number; isRunning?: boolean }): string {
  const { output, offset, limit, isRunning } = params
  const lines = String(output || '').replace(/\r\n/g, '\n').split('\n')
  if (lines.length === 1 && lines[0] === '' && !isRunning) {
    return 'No output captured for this command yet.'
  }

  const safeOffset = Math.max(0, offset || 0)
  const safeLimit = Math.max(1, limit || COMMAND_READ_DEFAULT_LIMIT)
  const raw: string[] = []
  let bytesCount = 0
  let truncatedByBytes = false

  for (let i = safeOffset; i < Math.min(lines.length, safeOffset + safeLimit); i++) {
    const line =
      lines[i].length > COMMAND_READ_MAX_LINE_LENGTH ? lines[i].slice(0, COMMAND_READ_MAX_LINE_LENGTH) + '...' : lines[i]
    const size = Buffer.byteLength(line, 'utf8') + (raw.length > 0 ? 1 : 0)
    if (bytesCount + size > COMMAND_READ_MAX_BYTES) {
      truncatedByBytes = true
      break
    }
    raw.push(line)
    bytesCount += size
  }

  const content = raw.map((line, index) => `${(index + safeOffset + 1).toString().padStart(5, '0')}| ${line}`)
  let result = content.join('\n')

  const totalLines = lines.length
  const lastReadLine = safeOffset + raw.length
  const hasMoreLines = totalLines > lastReadLine

  if (truncatedByBytes) {
    result += `\n\n(Output truncated at ${COMMAND_READ_MAX_BYTES} bytes. Use 'offset' to read beyond line ${lastReadLine})`
  } else if (hasMoreLines) {
    result += `\n\n(Output has more lines. Use 'offset' to read beyond line ${lastReadLine})`
  } else if (isRunning) {
    result += `\n\n(Command is still running. Total ${totalLines} lines captured so far. Use read_command_output again later to see more)`
  } else {
    result += `\n\n(End of output - total ${totalLines} lines)`
  }
  return result
}
