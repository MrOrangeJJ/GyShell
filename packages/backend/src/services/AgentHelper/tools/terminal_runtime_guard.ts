import type { TerminalTab } from '../../../types'
import type {
  TerminalRuntimeSnapshot,
  TerminalService
} from '../../TerminalService'
import type { ToolExecutionContext } from '../types'

export type TerminalToolResolution =
  | {
      ok: true
      terminal: TerminalTab
      snapshot: TerminalRuntimeSnapshot
    }
  | {
      ok: false
      message: string
    }

export function resolveTerminalForTool(
  context: Pick<ToolExecutionContext, 'terminalService'>,
  tabIdOrName: string,
  label = 'terminal tab'
): TerminalToolResolution {
  const { found, bestMatch } = context.terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    return {
      ok: false,
      message: formatTerminalReferenceError(label, tabIdOrName, found)
    }
  }

  const snapshot = context.terminalService.getTerminalRuntimeSnapshot(bestMatch.id)
  if (!snapshot) {
    return {
      ok: false,
      message: `Error: ${capitalize(label)} "${tabIdOrName}" was closed or no longer exists.`
    }
  }

  return { ok: true, terminal: bestMatch, snapshot }
}

export function requireTerminalReadyForTool(
  terminalService: TerminalService,
  terminal: TerminalTab,
  operation: string
): string | null {
  const snapshot = terminalService.getTerminalRuntimeSnapshot(terminal.id)
  if (!snapshot) {
    return `Error: Terminal tab "${terminal.title || terminal.id}" was closed or no longer exists.`
  }
  if (snapshot.canRunCommand) return null
  return formatTerminalUnavailableForTool(snapshot, operation)
}

export function requireTerminalWritableForTool(
  terminalService: TerminalService,
  terminal: TerminalTab,
  operation: string
): string | null {
  const snapshot = terminalService.getTerminalRuntimeSnapshot(terminal.id)
  if (!snapshot) {
    return `Error: Terminal tab "${terminal.title || terminal.id}" was closed or no longer exists.`
  }
  if (snapshot.canWrite) return null
  return formatTerminalUnavailableForTool(snapshot, operation)
}

export function requireTerminalFilesystemForTool(
  terminalService: TerminalService,
  terminal: TerminalTab,
  operation: string
): string | null {
  const snapshot = terminalService.getTerminalRuntimeSnapshot(terminal.id)
  if (!snapshot) {
    return `Error: Terminal tab "${terminal.title || terminal.id}" was closed or no longer exists.`
  }
  if (snapshot.canUseFilesystem) return null
  if (terminal.capabilities?.supportsFilesystem !== true && snapshot.runtimeState === 'ready') {
    return `Error: Terminal tab "${terminal.title || terminal.id}" (id=${terminal.id}, type=${terminal.type}) does not support filesystem operations.`
  }
  return formatTerminalUnavailableForTool(snapshot, operation)
}

export function formatTerminalStatusHeader(snapshot: TerminalRuntimeSnapshot): string {
  return [
    `Terminal: ${snapshot.title || snapshot.id} (id=${snapshot.id}, type=${snapshot.type})`,
    'terminal_status:',
    `- runtime_state: ${snapshot.runtimeState}`,
    `- shell_input_state: ${snapshot.shellInputState || 'unknown'}`,
    ...(snapshot.commandProtocolAvailable !== undefined
      ? [`- command_protocol_available: ${snapshot.commandProtocolAvailable}`]
      : []),
    `- tab_still_exists: true`,
    `- reconnectable: ${snapshot.reconnectable}`,
    ...(typeof snapshot.lastExitCode === 'number'
      ? [`- last_exit_code: ${snapshot.lastExitCode}`]
      : []),
    ...(snapshot.runtimeState === 'exited'
      ? [
          '',
          'The terminal backend session is disconnected. Any terminal output below is retained history and may be stale.'
        ]
      : [])
  ].join('\n')
}

export function formatTerminalUnavailableForTool(
  snapshot: TerminalRuntimeSnapshot,
  operation: string
): string {
  const stateLabel =
    snapshot.runtimeState === 'exited'
      ? 'disconnected'
      : snapshot.runtimeState === 'initializing'
        ? 'initializing'
        : snapshot.shellInputState === 'busy'
          ? 'connected, but its shell is busy and not at a prompt'
          : snapshot.commandProtocolAvailable === false
            ? 'connected, but its shell has no reliable exec_command boundary protocol'
          : 'not ready'
  const lines = [
    `Error: Terminal tab "${snapshot.title || snapshot.id}" (id=${snapshot.id}, type=${snapshot.type}) is ${stateLabel}.`,
    'terminal_status:',
    `- runtime_state: ${snapshot.runtimeState}`,
    `- shell_input_state: ${snapshot.shellInputState || 'unknown'}`,
    ...(snapshot.commandProtocolAvailable !== undefined
      ? [`- command_protocol_available: ${snapshot.commandProtocolAvailable}`]
      : []),
    `- tab_still_exists: true`,
    `- reconnectable: ${snapshot.reconnectable}`,
    ...(typeof snapshot.lastExitCode === 'number'
      ? [`- last_exit_code: ${snapshot.lastExitCode}`]
      : []),
    '',
    snapshot.commandProtocolAvailable === false
      ? `Cannot ${operation} because this shell cannot provide reliable command start/end boundaries. Use write_stdin for manual interaction or open a bash, zsh, or PowerShell terminal.`
      : `Cannot ${operation} until the terminal is connected and ready${
          snapshot.shellInputState === 'busy' ? ' at an idle shell prompt' : ''
        }.`
  ]

  if (snapshot.runtimeState === 'exited') {
    lines.push(
      'This tab still exists because it was not closed by the user, but its backend session is no longer connected.'
    )
  }
  if (snapshot.reconnectable) {
    lines.push(
      `Call reconnect_terminal_tab with tabIdOrName="${snapshot.id}" to try to reconnect this existing tab.`
    )
  }

  return lines.join('\n')
}

export function formatTerminalReferenceError(
  label: string,
  tabIdOrName: string,
  found: Array<{ id: string; title?: string }>
): string {
  if (found.length > 1) {
    return `Error: Multiple ${label}s found for "${tabIdOrName}". Use a specific tab id: ${found
      .map((item) => item.id)
      .join(', ')}`
  }
  return `Error: ${capitalize(label)} "${tabIdOrName}" not found. It may have been closed by the user.`
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value
}
