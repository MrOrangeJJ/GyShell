export const COMMAND_OUTPUT_CONTRACT_VERSION = 1 as const
export const COMMAND_CAPTURE_MAX_UTF8_BYTES = 16 * 1024 * 1024
export const COMMAND_TOOL_RESULT_MAX_UTF8_BYTES = 50 * 1024
export const COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES = 1024

export type CommandExecutionState =
  | 'running'
  | 'finished'
  | 'aborted'
  | 'outcome_unknown'

export type CommandCaptureState =
  | 'in_progress'
  | 'complete'
  | 'incomplete'
  | 'unknown'

export type CommandCaptureReason =
  | 'retention_limit'
  | 'tracking_lost'
  | 'runtime_boundary'
  | 'tracking_unavailable'
  | 'projection_ambiguous'
  | 'record_expired'

export type CommandPresentationState = 'none' | 'full' | 'excerpt'

export interface CommandCaptureMetadata {
  state: CommandCaptureState
  reason?: CommandCaptureReason
  observedUtf8Bytes: number
  retainedUtf8Bytes: number
  availableLineCount: number
  revision: number
  terminalControlsObserved: boolean
}

export interface CommandPresentationMetadata {
  state: CommandPresentationState
  returnedUtf8Bytes: number
  hasMoreCapturedOutput: boolean
  nextCursor?: string
  pollCursor?: string
}

/**
 * Authoritative machine-readable semantics for one exec_command or
 * read_command_output result. Terminal content remains untrusted data.
 */
export interface CommandOutputContractV1 {
  contractVersion: typeof COMMAND_OUTPUT_CONTRACT_VERSION
  terminalId: string
  historyCommandMatchId: string
  executionState: CommandExecutionState
  /** Authoritative shell status only for `finished`; lifecycle sentinels never cross this boundary. */
  exitCode: number | null
  capture: CommandCaptureMetadata
  presentation: CommandPresentationMetadata
}

const COMMAND_EXECUTION_STATES = new Set<CommandExecutionState>([
  'running',
  'finished',
  'aborted',
  'outcome_unknown',
])
const COMMAND_CAPTURE_STATES = new Set<CommandCaptureState>([
  'in_progress',
  'complete',
  'incomplete',
  'unknown',
])
const COMMAND_CAPTURE_REASONS = new Set<CommandCaptureReason>([
  'retention_limit',
  'tracking_lost',
  'runtime_boundary',
  'tracking_unavailable',
  'projection_ambiguous',
  'record_expired',
])
const COMMAND_PRESENTATION_STATES = new Set<CommandPresentationState>([
  'none',
  'full',
  'excerpt',
])
const COMMAND_OUTPUT_CURSOR_MAX_CHARS = 4096

const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).byteLength

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0

const readBoundedIdentifier = (value: unknown): string | undefined => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Length(value) > COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES
  ) {
    return undefined
  }
  return value
}

const readCursor = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= COMMAND_OUTPUT_CURSOR_MAX_CHARS
    ? value
    : undefined

/**
 * Validates untrusted/persisted contract data and copies only declared fields.
 * Cursor authenticity remains a backend concern because its MAC is process-local.
 */
export const parseCommandOutputContractV1 = (
  value: unknown,
): CommandOutputContractV1 | undefined => {
  if (!isRecord(value)) return undefined
  const terminalId = readBoundedIdentifier(value.terminalId)
  const historyCommandMatchId = readBoundedIdentifier(
    value.historyCommandMatchId,
  )
  const executionState = value.executionState
  const exitCode = value.exitCode
  const capture = value.capture
  const presentation = value.presentation
  if (
    value.contractVersion !== COMMAND_OUTPUT_CONTRACT_VERSION ||
    terminalId === undefined ||
    historyCommandMatchId === undefined ||
    typeof executionState !== 'string' ||
    !COMMAND_EXECUTION_STATES.has(executionState as CommandExecutionState) ||
    (exitCode !== null &&
      (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) ||
    (executionState !== 'finished' && exitCode !== null) ||
    !isRecord(capture) ||
    !isRecord(presentation)
  ) {
    return undefined
  }

  const captureState = capture.state
  const captureReason = capture.reason
  if (
    typeof captureState !== 'string' ||
    !COMMAND_CAPTURE_STATES.has(captureState as CommandCaptureState) ||
    (captureReason !== undefined &&
      (typeof captureReason !== 'string' ||
        !COMMAND_CAPTURE_REASONS.has(captureReason as CommandCaptureReason))) ||
    !isNonNegativeSafeInteger(capture.observedUtf8Bytes) ||
    !isNonNegativeSafeInteger(capture.retainedUtf8Bytes) ||
    capture.retainedUtf8Bytes > capture.observedUtf8Bytes ||
    !isNonNegativeSafeInteger(capture.availableLineCount) ||
    !isNonNegativeSafeInteger(capture.revision) ||
    typeof capture.terminalControlsObserved !== 'boolean' ||
    (captureState === 'complete' &&
      (captureReason !== undefined ||
        capture.observedUtf8Bytes !== capture.retainedUtf8Bytes)) ||
    (captureState === 'in_progress' && captureReason !== undefined)
  ) {
    return undefined
  }

  const presentationState = presentation.state
  const nextCursor = readCursor(presentation.nextCursor)
  const pollCursor = readCursor(presentation.pollCursor)
  if (
    typeof presentationState !== 'string' ||
    !COMMAND_PRESENTATION_STATES.has(
      presentationState as CommandPresentationState,
    ) ||
    !isNonNegativeSafeInteger(presentation.returnedUtf8Bytes) ||
    typeof presentation.hasMoreCapturedOutput !== 'boolean' ||
    (presentation.nextCursor !== undefined && nextCursor === undefined) ||
    (presentation.pollCursor !== undefined && pollCursor === undefined) ||
    (nextCursor !== undefined && pollCursor !== undefined) ||
    (presentation.hasMoreCapturedOutput && nextCursor === undefined) ||
    (!presentation.hasMoreCapturedOutput && nextCursor !== undefined) ||
    (pollCursor !== undefined &&
      (executionState !== 'running' ||
        presentation.hasMoreCapturedOutput)) ||
    (presentationState === 'none' &&
      presentation.returnedUtf8Bytes !== 0) ||
    (presentationState === 'full' &&
      presentation.hasMoreCapturedOutput)
  ) {
    return undefined
  }

  return {
    contractVersion: COMMAND_OUTPUT_CONTRACT_VERSION,
    terminalId,
    historyCommandMatchId,
    executionState: executionState as CommandExecutionState,
    exitCode: exitCode as number | null,
    capture: {
      state: captureState as CommandCaptureState,
      ...(captureReason !== undefined
        ? { reason: captureReason as CommandCaptureReason }
        : {}),
      observedUtf8Bytes: capture.observedUtf8Bytes,
      retainedUtf8Bytes: capture.retainedUtf8Bytes,
      availableLineCount: capture.availableLineCount,
      revision: capture.revision,
      terminalControlsObserved: capture.terminalControlsObserved,
    },
    presentation: {
      state: presentationState as CommandPresentationState,
      returnedUtf8Bytes: presentation.returnedUtf8Bytes,
      hasMoreCapturedOutput: presentation.hasMoreCapturedOutput,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(pollCursor !== undefined ? { pollCursor } : {}),
    },
  }
}

const unwrapCommandOutputTag = (
  value: string,
  tagName: string,
): string | undefined => {
  const openTag = `<${tagName}>`
  const closeTag = `</${tagName}>`
  const openIndex = value.indexOf(openTag)
  const closeIndex = value.lastIndexOf(closeTag)
  if (openIndex < 0 || closeIndex < openIndex + openTag.length) {
    return undefined
  }
  let body = value.slice(openIndex + openTag.length, closeIndex)
  if (body.startsWith('\n')) body = body.slice(1)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return body
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const SESSION_CLOSED_COMMAND_NOTE = '[Session closed before command finished]'

const appendKnownCommandStatusNote = (
  body: string,
  envelope: string,
): string =>
  envelope.trimEnd().endsWith(SESSION_CLOSED_COMMAND_NOTE)
    ? `${body}${body ? '\n' : ''}${SESSION_CLOSED_COMMAND_NOTE}`
    : body

/**
 * Removes GyShell's model-facing command result envelope for human display.
 * The original value remains the durable/tool-message representation.
 */
export const extractCommandOutputDisplayText = (value: string): string => {
  const normalized = String(value || '')
  const envelopePrefix = '<gyshell_command_result>\n'
  const envelopeClose = '\n</gyshell_command_result>'
  if (!normalized.startsWith(envelopePrefix)) return normalized
  const envelopeCloseIndex = normalized.indexOf(
    envelopeClose,
    envelopePrefix.length,
  )
  if (envelopeCloseIndex < 0) return normalized
  try {
    const contract = parseCommandOutputContractV1(JSON.parse(
      normalized.slice(envelopePrefix.length, envelopeCloseIndex),
    ))
    if (!contract) {
      return normalized
    }
  } catch {
    return normalized
  }
  const full = unwrapCommandOutputTag(normalized, 'terminal_content')
  if (full !== undefined) {
    return appendKnownCommandStatusNote(full, normalized)
  }

  const head = unwrapCommandOutputTag(
    normalized,
    'terminal_content_excerpt_head',
  )
  const tail = unwrapCommandOutputTag(
    normalized,
    'terminal_content_excerpt_tail',
  )
  if (head === undefined && tail === undefined) return normalized

  const excerpt = [
    head || '',
    '[Captured-output excerpt: middle retained content omitted from this presentation.]',
    tail || '',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
  return appendKnownCommandStatusNote(excerpt, normalized)
}
