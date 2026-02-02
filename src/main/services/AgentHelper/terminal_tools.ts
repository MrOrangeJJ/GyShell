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

// --- Implementations ---

export async function runCommand(args: z.infer<typeof execCommandSchema>, context: ToolExecutionContext): Promise<string> {
  const { tabIdOrName, command } = args
  const { terminalService, sessionId, messageId, sendEvent } = context
  
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
    sendEvent(sessionId, {
      messageId,
      type: 'command_started',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      isNowait: false
    })
    sendEvent(sessionId, {
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
  
  sendEvent(sessionId, { 
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
    sendEvent(sessionId, { 
      messageId,
      type: 'command_finished', 
      command, 
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      exitCode: result.exitCode,
      outputDelta: result.stdoutDelta
    })
    return result.stdoutDelta || `Command executed with exit code ${result.exitCode}`
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    sendEvent(sessionId, { 
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
  const { terminalService, sessionId, messageId, sendEvent } = context
  
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
    sendEvent(sessionId, {
      messageId,
      type: 'command_started',
      command,
      commandId: messageId,
      tabName: bestMatch.title || bestMatch.id,
      isNowait: true
    })
    sendEvent(sessionId, {
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
  
  sendEvent(sessionId, { 
    messageId,
    type: 'command_started', 
    command, 
    commandId: messageId,
    tabName: bestMatch.title || bestMatch.id,
    isNowait: true
  })

  try {
    await terminalService.runCommandNoWait(bestMatch.id, command)
    return `Command started in terminal ${bestMatch.title || bestMatch.id} with command ID ${messageId}. This command is running in the background. Please use read_terminal_tab to check its progress later. Do not attempt to run another command in this tab until this one finishes.`
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    sendEvent(sessionId, { 
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
