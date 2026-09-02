import { COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES } from '@gyshell/shared'
import type { TerminalTab } from '../../../types'
import type {
  TerminalRuntimeGuard,
  TerminalRuntimeSnapshot,
  TerminalService
} from '../../TerminalService'
import type { ToolExecutionContext } from '../types'

export type TerminalToolResolution =
  | {
      ok: true
      terminal: TerminalTab
      snapshot: TerminalRuntimeSnapshot
      runtimeGuard?: TerminalRuntimeGuard
    }
  | {
      ok: false
      message: string
    }

export function resolveTerminalForTool(
  context: Pick<
    ToolExecutionContext,
    'terminalService' | 'expectedTerminalRuntimeBindings'
  >,
  terminalId: string,
  label = 'terminal tab'
): TerminalToolResolution {
  const terminal = context.terminalService.getTerminalById(terminalId)
  if (!terminal) {
    return {
      ok: false,
      message: formatTerminalIdError(
        label,
        terminalId,
        context.terminalService.getDisplayTerminals()
      )
    }
  }

  const expectedRuntimeGeneration =
    context.expectedTerminalRuntimeBindings?.get(terminalId)
  const getRuntimeGeneration = (context.terminalService as Partial<
    Pick<TerminalService, 'getTerminalRuntimeGeneration'>
  >).getTerminalRuntimeGeneration
  if (
    expectedRuntimeGeneration !== undefined &&
    (typeof getRuntimeGeneration !== 'function' ||
      getRuntimeGeneration.call(context.terminalService, terminalId) !==
        expectedRuntimeGeneration)
  ) {
    return {
      ok: false,
      message: `Error: ${capitalize(label)} terminalId=${JSON.stringify(terminalId)} changed after this tool call was planned. No terminal operation was executed; use the latest Available Terminal Tabs inventory and replan.`
    }
  }

  const createRuntimeGuard = (context.terminalService as Partial<
    Pick<TerminalService, 'createTerminalRuntimeGuard'>
  >).createTerminalRuntimeGuard
  let runtimeGuard: TerminalRuntimeGuard | undefined
  if (typeof createRuntimeGuard === 'function') {
    try {
      runtimeGuard = createRuntimeGuard.call(
        context.terminalService,
        terminalId,
        expectedRuntimeGeneration
      )
    } catch {
      return {
        ok: false,
        message: `Error: ${capitalize(label)} terminalId=${JSON.stringify(terminalId)} changed while this tool call was entering execution. No terminal operation was executed; use the latest Available Terminal Tabs inventory and replan.`
      }
    }
  } else if (expectedRuntimeGeneration !== undefined) {
    return {
      ok: false,
      message: `Error: ${capitalize(label)} runtime lease validation is unavailable. No terminal operation was executed; use the latest Available Terminal Tabs inventory and replan.`
    }
  }

  let snapshot: TerminalRuntimeSnapshot | null
  try {
    snapshot = context.terminalService.getTerminalRuntimeSnapshot(
      terminal.id,
      runtimeGuard
    )
  } catch {
    return {
      ok: false,
      message: `Error: ${capitalize(label)} terminalId=${JSON.stringify(terminalId)} changed while this tool call was entering execution. No terminal operation was executed; use the latest Available Terminal Tabs inventory and replan.`
    }
  }
  if (!snapshot) {
    return {
      ok: false,
      message: `Error: ${capitalize(label)} with terminalId=${JSON.stringify(terminalId)} was closed or no longer exists.`
    }
  }

  return { ok: true, terminal, snapshot, runtimeGuard }
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
      `Call reconnect_terminal_tab with terminalId=${JSON.stringify(snapshot.id)} to try to reconnect this existing tab.`
    )
  }

  return lines.join('\n')
}

const TERMINAL_ID_ERROR_MAX_UTF8_BYTES = 16 * 1024
const TERMINAL_ID_ERROR_MAX_CANDIDATES = 64

export function formatTerminalIdError(
  label: string,
  terminalId: string,
  availableTerminals: Array<{ id: string }>
): string {
  const suppliedTerminalIdUtf8Bytes = Buffer.byteLength(terminalId, 'utf8')
  const boundedSuppliedTerminalId = truncateUtf8(
    terminalId,
    COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES
  )
  const suppliedTerminalIdTruncated =
    boundedSuppliedTerminalId !== terminalId
  const allIds = [
    ...new Set(
      availableTerminals
        .map((terminal) => terminal.id)
        .filter((id): id is string => typeof id === 'string')
    )
  ].sort()
  const availableTerminalIds = allIds.slice(
    0,
    TERMINAL_ID_ERROR_MAX_CANDIDATES
  )

  const render = (): string => {
    const resolution = {
      status: 'not_found',
      suppliedTerminalId: boundedSuppliedTerminalId,
      ...(suppliedTerminalIdTruncated
        ? {
            suppliedTerminalIdTruncated: true,
            suppliedTerminalIdUtf8Bytes
          }
        : {}),
      availableTerminalIds,
      ...(availableTerminalIds.length < allIds.length
        ? {
            availableTerminalIdsTruncated: true,
            availableTerminalCount: allIds.length
          }
        : {})
    }
    return [
      `Error: ${capitalize(label)} supplied terminalId does not exactly match a current terminal ID.`,
      `terminal_id_resolution: ${JSON.stringify(resolution)}`,
      'Use one complete, case-sensitive ID from availableTerminalIds or the latest Available Terminal Tabs inventory. Terminal names, shortened IDs, reconstructed IDs, case variants, and stale IDs are not accepted.'
    ].join('\n')
  }

  let message = render()
  while (
    availableTerminalIds.length > 0 &&
    Buffer.byteLength(message, 'utf8') > TERMINAL_ID_ERROR_MAX_UTF8_BYTES
  ) {
    availableTerminalIds.pop()
    message = render()
  }
  return message
}

function truncateUtf8(value: string, maxUtf8Bytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxUtf8Bytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxUtf8Bytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value
}
