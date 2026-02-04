import { z } from 'zod'
import type { ToolExecutionContext } from './types'

// --- Schemas ---

export const execCommandSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab'),
  command: z.string().describe('The shell command to execute')
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

export const sendCharSchema = z
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

export const waitTerminalIdleSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab to monitor')
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

// --- Implementations ---

export async function runCommand(args: z.infer<typeof execCommandSchema>, context: ToolExecutionContext): Promise<string> {
  const { tabIdOrName, command } = args
  const { terminalService, sessionId, messageId } = context
  
  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    if (found.length > 1) {
      return `Error: Multiple terminal tabs found with name "${tabIdOrName}". Please use a specific Tab ID: ${found.map((t: any) => t.id).join(', ')}`
    }
    return `Error: Terminal tab "${tabIdOrName}" not found.`
  }

  const allowed = await checkCommandPolicy(command, 'run_command', context)
  if (!allowed.allowed) {
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

  context.sendEvent(sessionId, { 
    messageId,
    type: 'command_started', 
    command, 
    commandId: messageId,
    tabName: bestMatch.title || bestMatch.id,
    isNowait: false
  })

  try {
    const result = await terminalService.runCommandAndWait(bestMatch.id, command, {
      signal: context.signal,
      interruptOnAbort: true
    })
    const historyCommandMatchId = result.history_command_match_id
    const truncatedOutput = truncateCommandOutput(result.stdoutDelta || '', historyCommandMatchId, bestMatch.id)
    context.sendEvent(sessionId, { 
      messageId,
      type: 'command_finished', 
      command, 
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: result.exitCode,
      outputDelta: truncatedOutput
    })
    return truncatedOutput || `Command executed with exit code ${result.exitCode}`
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    context.sendEvent(sessionId, { 
      messageId,
      type: 'command_finished', 
      command, 
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: -1,
      outputDelta: errorMessage
    })
    return `Error executing command: ${errorMessage}`
  }
}

export async function runCommandNowait(args: z.infer<typeof execCommandSchema>, context: ToolExecutionContext): Promise<string> {
  const { tabIdOrName, command } = args
  const { terminalService, sessionId, messageId } = context
  
  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    if (found.length > 1) {
      return `Error: Multiple terminal tabs found with name "${tabIdOrName}". Please use a specific Tab ID: ${found.map((t: any) => t.id).join(', ')}`
    }
    return `Error: Terminal tab "${tabIdOrName}" not found.`
  }

  const allowed = await checkCommandPolicy(command, 'run_command_nowait', context)
  if (!allowed.allowed) {
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

  context.sendEvent(sessionId, { 
    messageId,
    type: 'command_started', 
    command, 
    commandId: messageId,
    tabName: bestMatch.title || bestMatch.id,
    isNowait: true
  })

  try {
    const historyCommandMatchId = await terminalService.runCommandNoWait(bestMatch.id, command)
    return `Command started in background. Use read_command_output to view output and status(finished or running), history_command_match_id=${historyCommandMatchId}, terminalId=${bestMatch.id}.`
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    context.sendEvent(sessionId, { 
      messageId,
      type: 'command_finished', 
      command, 
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: -1,
      outputDelta: errorMessage
    })
    return `Error: ${errorMessage}`
  }
}

export async function readTerminalTab(args: z.infer<typeof readTerminalTabSchema>, context: ToolExecutionContext): Promise<string> {
  const { tabIdOrName, lines = 100 } = args
  const { terminalService, sessionId, messageId, sendEvent } = context
  
  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    if (found.length > 1) {
      return `Error: Multiple terminal tabs found with name "${tabIdOrName}". Please use a specific Tab ID: ${found.map((t: any) => t.id).join(', ')}`
    }
    return `Error: Terminal tab "${tabIdOrName}" not found.`
  }
  
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'read_terminal_tab',
    title: `Read ${bestMatch.title || bestMatch.id} Tab`,
    hint: `last ${lines} line${lines === 1 ? '' : 's'}`
  })

  const output = terminalService.getRecentOutput(bestMatch.id, lines) || 'No output available.'

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

export async function readCommandOutput(
  args: z.infer<typeof readCommandOutputSchema>,
  context: ToolExecutionContext
): Promise<string> {
  const { tabIdOrName, history_command_match_id, offset = 0, limit = COMMAND_READ_DEFAULT_LIMIT } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    const tabs = terminalService.getAllTerminals()
    const list = tabs.length
      ? tabs.map((t) => `- ID: ${t.id}, Name: ${t.title}, Type: ${t.type}`).join('\n')
      : '(No active terminal tabs)'
    const errorText =
      found.length > 1
        ? `Error: Multiple terminal tabs found with name "${tabIdOrName}". Please use a specific Tab ID.\n${list}`
        : `Error: Terminal tab "${tabIdOrName}" not found.\n${list}`
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'read_command_output',
      input: JSON.stringify(args ?? {}),
      output: errorText
    })
    return errorText
  }

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

  const finalOutput = `${header}\n\n${result}`

  sendEvent(sessionId, {
    messageId,
    type: 'tool_call',
    toolName: 'read_command_output',
    input: JSON.stringify(args ?? {}),
    output: finalOutput
  })

  return finalOutput
}

export async function sendChar(args: z.infer<typeof sendCharSchema>, context: ToolExecutionContext): Promise<string> {
  const { tabIdOrName, sequence } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    const errorText =
      found.length > 1
        ? `Error: Multiple terminal tabs found with name "${tabIdOrName}". Please use a specific Tab ID: ${found.map((t: any) => t.id).join(', ')}`
        : `Error: Terminal tab "${tabIdOrName}" not found.`
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'send_char',
      input: JSON.stringify(sequence ?? []),
      output: errorText
    })
    return errorText
  }

  const commandText = (sequence ?? []).join('')
  const allowed = await checkCommandPolicy(commandText, 'send_char', context)
  if (!allowed.allowed) {
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName: 'send_char',
      input: JSON.stringify(sequence ?? []),
      output: allowed.message
    })
    return allowed.message
  }

  const resolved: string[] = []
  for (const item of sequence ?? []) {
    if (C0_NAMES.includes(item as (typeof C0_NAMES)[number])) {
      resolved.push(C0_CHAR_BY_NAME[item as (typeof C0_NAMES)[number]])
    } else {
      resolved.push(item)
    }
  }

  for (const ch of resolved) {
    abortIfNeeded(context.signal)
    terminalService.write(bestMatch.id, ch)
  }

  await waitWithSignal(1000, context.signal)
  const output = terminalService.getRecentOutput(bestMatch.id, 40) || 'No output available.'

  sendEvent(sessionId, {
    messageId,
    type: 'tool_call',
    toolName: 'send_char',
    input: JSON.stringify(sequence ?? []),
    output
  })

  return output
}

export async function waitTerminalIdle(
  args: z.infer<typeof waitTerminalIdleSchema>,
  context: ToolExecutionContext
): Promise<string> {
  const { tabIdOrName } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    return found.length > 1
      ? `Error: Multiple terminal tabs found with name "${tabIdOrName}".`
      : `Error: Terminal tab "${tabIdOrName}" not found.`
  }

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'wait_terminal_idle',
    title: `Waiting on ${bestMatch.title || bestMatch.id}`,
    hint: ''
  })

  let lastContent = ''
  let stableCount = 0
  const maxWaitSeconds = 120
  let elapsed = 0

  while (elapsed < maxWaitSeconds) {
    abortIfNeeded(context.signal)
    
    // Read last 100 lines
    const currentContent = terminalService.getRecentOutput(bestMatch.id, 100)
    
    if (currentContent === lastContent && currentContent !== '') {
      stableCount++
    } else {
      stableCount = 0
      lastContent = currentContent
    }

    if (stableCount >= 4) {
      const finalOutput = terminalService.getRecentOutput(bestMatch.id, 40)
      sendEvent(sessionId, {
        messageId,
        type: 'sub_tool_delta',
        outputDelta: finalOutput
      })
      sendEvent(sessionId, {
        messageId,
        type: 'sub_tool_finished'
      })
      return `Terminal is now idle. Recent output (last 40 lines):\n${finalOutput}`
    }

    await waitWithSignal(1000, context.signal)
    elapsed++
  }

  const currentOutput = terminalService.getRecentOutput(bestMatch.id, 40)
  const timeoutMsg = `Wait timeout: The terminal has been running for over 120s and is still not idle. Please check if the task is still running correctly. If you need to continue waiting, run this tool again. If you need to stop it, use send_char (e.g., Ctrl+C). Recent output:\n${currentOutput}`
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_delta',
    outputDelta: timeoutMsg
  })

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_finished'
  })

  return timeoutMsg
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

function truncateCommandOutput(output: string, historyCommandMatchId: string, terminalId: string): string {
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
  let result = '<command_output>\n'
  result += content.join('\n')

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

  result += '\n</command_output>'
  return result
}
