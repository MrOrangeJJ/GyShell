import {
  COMMAND_OUTPUT_CONTRACT_VERSION,
  COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES,
  COMMAND_TOOL_RESULT_MAX_UTF8_BYTES,
  parseCommandOutputContractV1,
  type CommandCaptureMetadata,
  type CommandExecutionState,
  type CommandOutputContractV1,
} from '@gyshell/shared'
import { createHmac, randomBytes } from 'node:crypto'

const INITIAL_MAX_LINES = 200
const INITIAL_HEAD_LINES = 60
const INITIAL_TAIL_LINES = 60
const DEFAULT_PAGE_UTF8_BYTES = 32 * 1024
const ENVELOPE_REWRITE_RESERVE_UTF8_BYTES = 2 * 1024
export const MAX_PAGE_UTF8_BYTES = 40 * 1024
export const DEFAULT_LEGACY_LINE_LIMIT = 2000
export const MAX_LEGACY_LINE_LIMIT = 10_000

interface CursorPayloadV1 {
  v: 1
  task: string
  byteOffset: number
  utf16Offset: number
  check: string
}

// Command records are process-local, so a process-local cursor MAC prevents
// terminal content (which is untrusted model input) from manufacturing byte
// offsets that skip or duplicate retained output.
const CURSOR_MAC_KEY = randomBytes(32)

export interface CommandOutputSource {
  terminalId: string
  historyCommandMatchId: string
  executionState: CommandExecutionState
  exitCode?: number
  output: string
  capture: CommandCaptureMetadata
}

export interface FormattedCommandOutput {
  text: string
  contract: CommandOutputContractV1
}

export interface ReadCommandOutputPageOptions {
  cursor?: string
  offset?: number
  limit?: number
  maxBytes?: number
}

const utf8Length = (value: string): number => Buffer.byteLength(value, 'utf8')

const assertBoundedContractIdentifier = (
  label: string,
  value: string
): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Length(value) > COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES
  ) {
    throw new Error(
      `${label} must contain between 1 and ${COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES} UTF-8 bytes.`
    )
  }
}

const assertBoundedSourceIdentifiers = (source: CommandOutputSource): void => {
  assertBoundedContractIdentifier('terminalId', source.terminalId)
  assertBoundedContractIdentifier(
    'historyCommandMatchId',
    source.historyCommandMatchId
  )
}

const escapeTerminalContent = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const stringifyJsonForMarkup = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')

const stringifyContractForMarkup = (contract: CommandOutputContractV1): string =>
  stringifyJsonForMarkup(contract)

const normalizeScalar = (scalar: string): string => {
  const codePoint = scalar.codePointAt(0)
  return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff
    ? '\ufffd'
    : scalar
}

export const normalizeUnicodeScalars = (value: string): string => {
  const source = String(value || '')
  let firstInvalid = -1
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = source.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
      } else {
        firstInvalid = index
        break
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      firstInvalid = index
      break
    }
  }
  if (firstInvalid === -1) {
    return source
  }

  const parts: string[] = [source.slice(0, firstInvalid)]
  let retainedStart = firstInvalid
  for (let index = firstInvalid; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = source.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue
    }
    parts.push(source.slice(retainedStart, index), '\ufffd')
    retainedStart = index + 1
  }
  parts.push(source.slice(retainedStart))
  return parts.join('')
}

const cursorCheck = (
  taskId: string,
  byteOffset: number,
  utf16Offset: number
): string =>
  createHmac('sha256', CURSOR_MAC_KEY)
    .update(`gyshell-command-output-v1\0${taskId}\0${byteOffset}\0${utf16Offset}`)
    .digest('base64url')
    .slice(0, 22)

const cursorTaskBinding = (taskId: string): string =>
  createHmac('sha256', CURSOR_MAC_KEY)
    .update(`gyshell-command-output-task-v1\0${taskId}`)
    .digest('base64url')
    .slice(0, 22)

const encodeCursor = (
  taskId: string,
  byteOffset: number,
  utf16Offset: number
): string =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      task: cursorTaskBinding(taskId),
      byteOffset,
      utf16Offset,
      check: cursorCheck(taskId, byteOffset, utf16Offset),
    } satisfies CursorPayloadV1),
    'utf8'
  ).toString('base64url')

const decodeCursor = (cursor: string, expectedTaskId: string): CursorPayloadV1 => {
  if (!cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('Invalid command output cursor.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid command output cursor.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid command output cursor.')
  }
  const candidate = parsed as Partial<CursorPayloadV1>
  if (
    candidate.v !== 1 ||
    candidate.task !== cursorTaskBinding(expectedTaskId) ||
    !Number.isSafeInteger(candidate.byteOffset) ||
    Number(candidate.byteOffset) < 0 ||
    !Number.isSafeInteger(candidate.utf16Offset) ||
    Number(candidate.utf16Offset) < 0 ||
    typeof candidate.check !== 'string' ||
    candidate.check !==
      cursorCheck(
        expectedTaskId,
        Number(candidate.byteOffset),
        Number(candidate.utf16Offset)
      )
  ) {
    throw new Error('Command output cursor does not belong to this command.')
  }
  return candidate as CursorPayloadV1
}

const sliceByUtf8Bytes = (
  value: string,
  startByteOffset: number,
  startUtf16Offset: number,
  maxBytes: number
): { content: string; endByteOffset: number; endUtf16Offset: number } => {
  let index = startUtf16Offset
  let returnedBytes = 0
  let content = ''
  while (index < value.length) {
    const codePoint = value.codePointAt(index)
    const rawScalar = codePoint === undefined ? '' : String.fromCodePoint(codePoint)
    const scalar = normalizeScalar(rawScalar)
    const scalarBytes = utf8Length(scalar)
    if (returnedBytes + scalarBytes > maxBytes) {
      break
    }
    content += scalar
    returnedBytes += scalarBytes
    index += rawScalar.length
  }
  return {
    content,
    endByteOffset: startByteOffset + returnedBytes,
    endUtf16Offset: index,
  }
}

const takeUtf8Prefix = (value: string, maxBytes: number): string =>
  sliceByUtf8Bytes(value, 0, 0, Math.max(0, maxBytes)).content

const takeUtf8PrefixByEscapedBudget = (
  value: string,
  maxEscapedBytes: number
): string => {
  if (maxEscapedBytes <= 0) return ''
  let escapedBytes = 0
  let result = ''
  for (const rawScalar of value) {
    const scalar = normalizeScalar(rawScalar)
    const nextBytes = utf8Length(escapeTerminalContent(scalar))
    if (escapedBytes + nextBytes > maxEscapedBytes) break
    result += scalar
    escapedBytes += nextBytes
  }
  return result
}

const takeUtf8Suffix = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let start = value.length
  while (start > 0) {
    let scalarStart = start - 1
    const lastCodeUnit = value.charCodeAt(scalarStart)
    if (
      lastCodeUnit >= 0xdc00 &&
      lastCodeUnit <= 0xdfff &&
      scalarStart > 0
    ) {
      const previousCodeUnit = value.charCodeAt(scalarStart - 1)
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
        scalarStart -= 1
      }
    }
    const scalar = normalizeScalar(value.slice(scalarStart, start))
    const scalarBytes = utf8Length(scalar)
    if (bytes + scalarBytes > maxBytes) break
    start = scalarStart
    bytes += scalarBytes
  }
  return normalizeUnicodeScalars(value.slice(start))
}

const takeUtf8SuffixByEscapedBudget = (
  value: string,
  maxEscapedBytes: number
): string => {
  if (maxEscapedBytes <= 0) return ''
  let escapedBytes = 0
  let start = value.length
  while (start > 0) {
    let scalarStart = start - 1
    const lastCodeUnit = value.charCodeAt(scalarStart)
    if (
      lastCodeUnit >= 0xdc00 &&
      lastCodeUnit <= 0xdfff &&
      scalarStart > 0
    ) {
      const previousCodeUnit = value.charCodeAt(scalarStart - 1)
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
        scalarStart -= 1
      }
    }
    const scalar = normalizeScalar(value.slice(scalarStart, start))
    const nextBytes = utf8Length(escapeTerminalContent(scalar))
    if (escapedBytes + nextBytes > maxEscapedBytes) break
    start = scalarStart
    escapedBytes += nextBytes
  }
  return normalizeUnicodeScalars(value.slice(start))
}

const previewValue = (value: string, maxBytes: number): string => {
  const normalized = normalizeUnicodeScalars(value)
  if (utf8Length(normalized) <= maxBytes) return normalized
  return `${takeUtf8Prefix(normalized, Math.max(0, maxBytes - 3))}...`
}

const buildContract = (
  source: CommandOutputSource,
  presentation: CommandOutputContractV1['presentation']
): CommandOutputContractV1 => {
  const candidate = {
    contractVersion: COMMAND_OUTPUT_CONTRACT_VERSION,
    terminalId: source.terminalId,
    historyCommandMatchId: source.historyCommandMatchId,
    executionState: source.executionState,
    exitCode:
      source.executionState === 'finished'
        ? source.exitCode ?? null
        : null,
    capture: {
      state: source.capture.state,
      ...(source.capture.reason !== undefined
        ? { reason: source.capture.reason }
        : {}),
      observedUtf8Bytes: source.capture.observedUtf8Bytes,
      retainedUtf8Bytes: source.capture.retainedUtf8Bytes,
      availableLineCount: source.capture.availableLineCount,
      revision: source.capture.revision,
      terminalControlsObserved: source.capture.terminalControlsObserved,
    },
    presentation,
  }
  const contract = parseCommandOutputContractV1(candidate)
  if (!contract) {
    throw new Error('Invalid command output source metadata.')
  }
  return contract
}

const buildSemanticsNote = (contract: CommandOutputContractV1): string => {
  const notes: string[] = []
  if (contract.presentation.state === 'none') {
    notes.push(
      contract.executionState === 'running'
        ? 'Output note: no retained text is available at this snapshot; this does not mean the running command cannot emit more.'
        : 'Output note: no retained text is available at this requested position.'
    )
  }
  if (contract.presentation.state === 'excerpt') {
    notes.push(
      'Output note: this tool response is an excerpt of retained captured output; the command itself was not truncated by the presentation layer.'
    )
    if (contract.presentation.nextCursor) {
      notes.push(
        'Pass nextCursor unchanged to read_command_output to continue from the first omitted captured byte. Paging traverses the omitted middle and will eventually repeat the tail preview; deduplicate that preview when reconstructing output.'
      )
    }
  }
  if (contract.capture.state === 'incomplete') {
    notes.push(
      `WARNING: GyShell knows capture is incomplete (${contract.capture.reason || 'unknown reason'}). read_command_output can recover retained captured output only; do not automatically replay a command with side effects.`
    )
  } else if (contract.capture.state === 'unknown') {
    notes.push(
      `WARNING: capture completeness is unverified (${contract.capture.reason || 'unknown reason'}). Missing text is not evidence that the process did not emit it.`
    )
    if (
      contract.capture.observedUtf8Bytes >
      contract.capture.retainedUtf8Bytes
    ) {
      notes.push(
        `Known retention loss also occurred: GyShell observed ${contract.capture.observedUtf8Bytes} UTF-8 bytes but retained ${contract.capture.retainedUtf8Bytes}. read_command_output cannot recover discarded bytes.`
      )
    }
  }
  if (contract.executionState === 'running') {
    notes.push(
      'Execution note: the command is still running. Reaching the current captured tail is a snapshot, not End of output.'
    )
  } else if (contract.executionState === 'outcome_unknown') {
    notes.push(
      'WARNING: the command outcome is unknown. Do not claim success or automatically replay a command with side effects.'
    )
  }
  if (contract.capture.terminalControlsObserved) {
    notes.push(
      'Transcript note: terminal control sequences were projected into an append-only text log; use read_terminal_tab only when the current rendered screen is required.'
    )
  }
  return notes.join('\n')
}

const buildEnvelope = (params: {
  contract: CommandOutputContractV1
  body: string
  commandPreview?: string
  terminalStatus?: string
  excerpt?: boolean
}): string => {
  const sections = [
    '<gyshell_command_result>',
    stringifyContractForMarkup(params.contract),
    '</gyshell_command_result>',
  ]
  if (params.terminalStatus) {
    sections.push(escapeTerminalContent(params.terminalStatus))
  }
  if (params.commandPreview !== undefined) {
    sections.push(`Command: ${escapeTerminalContent(params.commandPreview)}`)
  }
  const note = buildSemanticsNote(params.contract)
  if (note) sections.push(note)
  if (params.excerpt) {
    sections.push(params.body)
  } else {
    sections.push(
      `<terminal_content>\n${escapeTerminalContent(params.body)}\n</terminal_content>`
    )
  }
  return sections.join('\n')
}

export const parseCommandOutputEnvelopeContract = (
  value: string
): CommandOutputContractV1 | undefined => {
  const normalized = String(value || '')
  const envelopePrefix = '<gyshell_command_result>\n'
  const envelopeClose = '\n</gyshell_command_result>'
  if (!normalized.startsWith(envelopePrefix)) return undefined
  const contractEnd = normalized.indexOf(
    envelopeClose,
    envelopePrefix.length
  )
  if (contractEnd < 0) return undefined
  try {
    const parsed = parseCommandOutputContractV1(JSON.parse(
      normalized.slice(envelopePrefix.length, contractEnd)
    ))
    return parsed
  } catch {
    return undefined
  }
}

export const parsePrunedCommandOutputMaterialization = (
  value: string
): { originalApproximateTokens: number } | undefined => {
  const normalized = String(value || '')
  if (!parseCommandOutputEnvelopeContract(normalized)) return undefined
  const openTag = '<gyshell_command_context_materialization>\n'
  const closeTag = '\n</gyshell_command_context_materialization>'
  const start = normalized.indexOf(openTag)
  if (start < 0) return undefined
  const bodyStart = start + openTag.length
  const end = normalized.indexOf(closeTag, bodyStart)
  if (end < 0) return undefined
  try {
    const parsed = JSON.parse(normalized.slice(bodyStart, end))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== 1 ||
      parsed.contractScope !== 'original_tool_result' ||
      parsed.bodyState !== 'pruned_from_model_context' ||
      parsed.modelContextBodyUtf8Bytes !== 0 ||
      parsed.automaticReplayAllowed !== false ||
      parsed.recoveryTool !== 'read_command_output' ||
      !Number.isSafeInteger(parsed.originalApproximateTokens) ||
      parsed.originalApproximateTokens < 0
    ) {
      return undefined
    }
    return {
      originalApproximateTokens: parsed.originalApproximateTokens,
    }
  } catch {
    return undefined
  }
}

/**
 * Materializes a dynamically-pruned command result for model input without
 * weakening its historical execution/capture/presentation truth. The v1
 * contract continues to describe the authoritative historical result state
 * currently known; the adjacent materialization record states that only its
 * terminal body is absent from this model request.
 */
export const formatPrunedCommandOutputForModelContext = (
  value: string,
  originalApproximateTokens: number
): string | undefined => {
  const contract = parseCommandOutputEnvelopeContract(value)
  if (!contract) return undefined

  const boundedTokenEstimate = Number.isSafeInteger(originalApproximateTokens)
    ? Math.max(0, originalApproximateTokens)
    : 0
  const materialization = {
    version: 1,
    contractScope: 'original_tool_result',
    bodyState: 'pruned_from_model_context',
    modelContextBodyUtf8Bytes: 0,
    originalApproximateTokens: boundedTokenEstimate,
    automaticReplayAllowed: false,
    recoveryTool: 'read_command_output',
  }
  const text = [
    '<gyshell_command_result>',
    stringifyContractForMarkup(contract),
    '</gyshell_command_result>',
    '<gyshell_command_context_materialization>',
    stringifyJsonForMarkup(materialization),
    '</gyshell_command_context_materialization>',
    'Context note: the terminal body of this historical command result was pruned from the current model request. The v1 contract above is authoritative for the execution, capture, presentation, identifiers, and cursor semantics currently available to this request.',
    'Use read_command_output with its terminalId and historyCommandMatchId (and its cursor when applicable) if retained output is needed. Do not automatically replay a command with side effects to recover pruned context.',
  ].join('\n')
  if (
    utf8Length(text) >
    COMMAND_TOOL_RESULT_MAX_UTF8_BYTES -
      ENVELOPE_REWRITE_RESERVE_UTF8_BYTES
  ) {
    throw new Error(
      'Validated command output metadata exceeds the bounded pruned model-context envelope.'
    )
  }
  return text
}

/**
 * Converts a persisted process-local snapshot into durable historical truth
 * when its TerminalService record no longer exists. Presented text remains
 * readable, but stale cursors and running claims must not cross lifetimes.
 */
export const expireUnbackedCommandOutputContract = (
  contract: CommandOutputContractV1
): CommandOutputContractV1 => {
  const wasRunning = contract.executionState === 'running'
  const hadProcessLocalCursor =
    typeof contract.presentation.nextCursor === 'string' ||
    typeof contract.presentation.pollCursor === 'string'
  const presentationIsSelfContained =
    (contract.presentation.state === 'full' &&
      contract.presentation.returnedUtf8Bytes ===
        contract.capture.retainedUtf8Bytes) ||
    (contract.presentation.state === 'none' &&
      contract.capture.retainedUtf8Bytes === 0)
  const isDurableTombstone =
    !wasRunning &&
    !hadProcessLocalCursor &&
    !contract.presentation.hasMoreCapturedOutput &&
    contract.capture.state === 'unknown' &&
    contract.capture.retainedUtf8Bytes === 0 &&
    (contract.capture.reason === 'record_expired' ||
      contract.capture.reason === 'tracking_lost')
  if (
    !wasRunning &&
    !hadProcessLocalCursor &&
    (presentationIsSelfContained || isDurableTombstone)
  ) {
    return contract
  }
  const {
    nextCursor: _nextCursor,
    pollCursor: _pollCursor,
    ...presentation
  } = contract.presentation
  return {
    ...contract,
    ...(wasRunning
      ? { executionState: 'outcome_unknown' as const, exitCode: null }
      : {}),
    capture: {
      ...contract.capture,
      state: 'unknown',
      reason: wasRunning ? 'tracking_lost' : 'record_expired',
      retainedUtf8Bytes: 0,
      availableLineCount: 0,
      revision: contract.capture.revision + 1,
    },
    presentation: {
      ...presentation,
      hasMoreCapturedOutput: false,
    },
  }
}

export const expireUnbackedCommandOutputEnvelope = (value: string): string => {
  const contract = parseCommandOutputEnvelopeContract(value)
  if (!contract) return String(value || '')
  const expired = expireUnbackedCommandOutputContract(contract)
  return expired === contract
    ? String(value || '')
    : rewriteCommandOutputEnvelopeContract(value, expired)
}

/**
 * Rewrites the authoritative contract and its generated semantic note while
 * preserving the already-presented terminal body byte-for-byte. This is used
 * when persisted UI history discovers that a formerly running command cannot
 * still be tracked after process restart.
 */
export const rewriteCommandOutputEnvelopeContract = (
  value: string,
  contract: CommandOutputContractV1
): string => {
  const normalized = String(value || '')
  const envelopePrefix = '<gyshell_command_result>\n'
  const envelopeClose = '\n</gyshell_command_result>'
  if (!normalized.startsWith(envelopePrefix)) return normalized

  const contractEnd = normalized.indexOf(
    envelopeClose,
    envelopePrefix.length
  )
  if (contractEnd < 0) return normalized
  const closeEnd = contractEnd + envelopeClose.length

  const previousContract = parseCommandOutputEnvelopeContract(normalized)

  const bodyMarkers = [
    '\n<terminal_content>\n',
    '\n<terminal_content_excerpt_head>\n',
  ]
  const bodyStart = bodyMarkers.reduce((earliest, marker) => {
    const index = normalized.indexOf(marker, closeEnd)
    if (index < 0) return earliest
    return earliest < 0 ? index : Math.min(earliest, index)
  }, -1)
  const rewrittenContract = [
    envelopePrefix,
    stringifyContractForMarkup(contract),
    envelopeClose,
  ].join('')
  const preservedBody = bodyStart < 0 ? '' : normalized.slice(bodyStart)
  let preservedContext = normalized.slice(
    closeEnd,
    bodyStart < 0 ? normalized.length : bodyStart
  )
  const previousNote = previousContract
    ? buildSemanticsNote(previousContract)
    : ''
  if (previousNote) {
    const noteSuffix = `\n${previousNote}`
    if (preservedContext.endsWith(noteSuffix)) {
      preservedContext = preservedContext.slice(0, -noteSuffix.length)
    }
  }
  const nextNote = buildSemanticsNote(contract)
  const buildRewritten = (
    context: string,
    note: string
  ): string => [
    rewrittenContract,
    context,
    ...(note ? [`\n${note}`] : []),
    preservedBody,
  ].join('')
  const rewritten = buildRewritten(preservedContext, nextNote)
  if (utf8Length(rewritten) <= COMMAND_TOOL_RESULT_MAX_UTF8_BYTES) {
    return rewritten
  }
  const compactSafetyNote =
    'WARNING: persisted command backing is unavailable; the machine-readable contract above is authoritative. Do not replay a side-effecting command merely to recover output.'
  for (const candidate of [
    buildRewritten(preservedContext, compactSafetyNote),
    buildRewritten('', compactSafetyNote),
    buildRewritten('', ''),
  ]) {
    if (utf8Length(candidate) <= COMMAND_TOOL_RESULT_MAX_UTF8_BYTES) {
      return candidate
    }
  }
  // New envelopes reserve headroom for rewrites, so only malformed or
  // pre-contract legacy materialization can exhaust every preservation
  // candidate. Never byte-crop an envelope: that would erase the only
  // machine-readable indication that backing data is gone. Fall back to a
  // complete, self-contained tombstone instead.
  const minimalContract = parseCommandOutputContractV1({
    ...contract,
    presentation: {
      state: 'none',
      returnedUtf8Bytes: 0,
      hasMoreCapturedOutput: false,
    },
  })
  if (!minimalContract) {
    throw new Error('Cannot construct a valid bounded command-output tombstone.')
  }
  const minimalEnvelope = buildEnvelope({
    contract: minimalContract,
    body: '',
  })
  if (utf8Length(minimalEnvelope) > COMMAND_TOOL_RESULT_MAX_UTF8_BYTES) {
    throw new Error('Command-output tombstone metadata exceeds the tool-result limit.')
  }
  return minimalEnvelope
}

const availableBodyBytes = (params: {
  contract: CommandOutputContractV1
  commandPreview?: string
  terminalStatus?: string
  excerpt?: boolean
}): number => {
  const fixed = buildEnvelope({ ...params, body: '' })
  return Math.max(
    0,
    COMMAND_TOOL_RESULT_MAX_UTF8_BYTES -
      ENVELOPE_REWRITE_RESERVE_UTF8_BYTES -
      utf8Length(fixed)
  )
}

const formatExcerptBody = (
  head: string,
  tail: string
): string =>
  [
    '<terminal_content_excerpt_head>',
    escapeTerminalContent(head),
    '</terminal_content_excerpt_head>',
    '<gyshell_output_omission>Middle captured bytes are not presented in this tool response.</gyshell_output_omission>',
    '<terminal_content_excerpt_tail>',
    escapeTerminalContent(tail),
    '</terminal_content_excerpt_tail>',
  ].join('\n')

const countLines = (output: string): number => {
  if (!output) return 0
  let lineCount = output.endsWith('\n') ? 0 : 1
  for (let index = output.indexOf('\n'); index !== -1; index = output.indexOf('\n', index + 1)) {
    lineCount += 1
  }
  return lineCount
}

const getLineBoundedHead = (output: string): string => {
  let boundary = -1
  for (let lines = 0; lines < INITIAL_HEAD_LINES; lines += 1) {
    boundary = output.indexOf('\n', boundary + 1)
    if (boundary === -1) return output
  }
  return output.slice(0, boundary)
}

const getLineBoundedTail = (output: string): string => {
  let boundary = output.length
  for (let lines = 0; lines < INITIAL_TAIL_LINES; lines += 1) {
    boundary = output.lastIndexOf('\n', boundary - 1)
    if (boundary === -1) return output
  }
  return output.slice(boundary + 1)
}

export const formatInitialCommandOutput = (
  sourceInput: CommandOutputSource,
  options?: { terminalStatus?: string }
): FormattedCommandOutput => {
  assertBoundedSourceIdentifiers(sourceInput)
  const source = { ...sourceInput, output: normalizeUnicodeScalars(sourceInput.output) }
  const terminalStatus = options?.terminalStatus
    ? previewValue(options.terminalStatus, 2048)
    : undefined
  const totalBytes = utf8Length(source.output)
  const totalLines = countLines(source.output)
  const fullContract = buildContract(source, {
    state: totalBytes === 0 ? 'none' : 'full',
    returnedUtf8Bytes: totalBytes,
    hasMoreCapturedOutput: false,
    ...(source.executionState === 'running'
      ? {
          pollCursor: encodeCursor(
            source.historyCommandMatchId,
            totalBytes,
            source.output.length
          ),
        }
      : {}),
  })
  if (
    totalLines <= INITIAL_MAX_LINES &&
    totalBytes <= COMMAND_TOOL_RESULT_MAX_UTF8_BYTES
  ) {
    const text = buildEnvelope({
      contract: fullContract,
      body: source.output,
      terminalStatus,
    })
    if (
      utf8Length(text) <=
      COMMAND_TOOL_RESULT_MAX_UTF8_BYTES -
        ENVELOPE_REWRITE_RESERVE_UTF8_BYTES
    ) {
      return { text, contract: fullContract }
    }
  }

  const provisionalCursor = encodeCursor(source.historyCommandMatchId, 0, 0)
  let contract = buildContract(source, {
    state: 'excerpt',
    returnedUtf8Bytes: 0,
    hasMoreCapturedOutput: totalBytes > 0,
    ...(totalBytes > 0 ? { nextCursor: provisionalCursor } : {}),
  })
  const bodyBudget = availableBodyBytes({ contract, terminalStatus, excerpt: true })
  const wrapperReserve = 320
  const contentBudget = Math.max(0, bodyBudget - wrapperReserve)
  const headBudget = Math.floor(contentBudget * 0.58)
  const tailBudget = contentBudget - headBudget
  const lineHead = totalLines > INITIAL_MAX_LINES
    ? getLineBoundedHead(source.output)
    : source.output
  const lineTail = totalLines > INITIAL_MAX_LINES
    ? getLineBoundedTail(source.output)
    : source.output
  let head = takeUtf8PrefixByEscapedBudget(lineHead, headBudget)
  const headBytes = utf8Length(head)
  let tail = takeUtf8SuffixByEscapedBudget(lineTail, tailBudget)
  const maximumTailStart = totalBytes - utf8Length(tail)
  if (maximumTailStart < headBytes) {
    tail = takeUtf8SuffixByEscapedBudget(
      takeUtf8Suffix(source.output, Math.max(0, totalBytes - headBytes)),
      tailBudget
    )
  }
  const nextCursor = encodeCursor(
    source.historyCommandMatchId,
    headBytes,
    head.length
  )
  contract = buildContract(source, {
    state: 'excerpt',
    returnedUtf8Bytes: headBytes + utf8Length(tail),
    hasMoreCapturedOutput: headBytes < totalBytes,
    ...(headBytes < totalBytes ? { nextCursor } : {}),
  })
  let body = formatExcerptBody(head, tail)
  let text = buildEnvelope({ contract, body, terminalStatus, excerpt: true })
  while (utf8Length(text) > COMMAND_TOOL_RESULT_MAX_UTF8_BYTES && tail) {
    tail = takeUtf8Suffix(tail, Math.max(0, utf8Length(tail) - 1024))
    contract = buildContract(source, {
      ...contract.presentation,
      returnedUtf8Bytes: headBytes + utf8Length(tail),
    })
    body = formatExcerptBody(head, tail)
    text = buildEnvelope({ contract, body, terminalStatus, excerpt: true })
  }
  if (utf8Length(text) > COMMAND_TOOL_RESULT_MAX_UTF8_BYTES) {
    head = takeUtf8Prefix(head, Math.max(0, utf8Length(head) - 2048))
    const adjustedHeadBytes = utf8Length(head)
    contract = buildContract(source, {
      state: 'excerpt',
      returnedUtf8Bytes: adjustedHeadBytes,
      hasMoreCapturedOutput: adjustedHeadBytes < totalBytes,
      ...(adjustedHeadBytes < totalBytes
        ? {
            nextCursor: encodeCursor(
              source.historyCommandMatchId,
              adjustedHeadBytes,
              head.length
            ),
          }
        : {}),
    })
    body = formatExcerptBody(head, '')
    text = buildEnvelope({ contract, body, terminalStatus, excerpt: true })
  }
  return { text, contract }
}

const positionForLine = (
  output: string,
  lineOffset: number
): { byteOffset: number; utf16Offset: number } => {
  if (lineOffset <= 0) return { byteOffset: 0, utf16Offset: 0 }
  let lines = 0
  let bytes = 0
  let utf16Offset = 0
  while (utf16Offset < output.length) {
    const codePoint = output.codePointAt(utf16Offset)
    const rawScalar = codePoint === undefined ? '' : String.fromCodePoint(codePoint)
    const scalar = normalizeScalar(rawScalar)
    if (lines === lineOffset) break
    bytes += utf8Length(scalar)
    utf16Offset += rawScalar.length
    if (scalar === '\n') lines += 1
  }
  return { byteOffset: bytes, utf16Offset }
}

const byteLimitForLines = (
  output: string,
  startUtf16Offset: number,
  lineLimit: number,
  maxBytes: number
): number => {
  let utf16Offset = startUtf16Offset
  let bytes = 0
  let lines = 0
  while (utf16Offset < output.length) {
    const codePoint = output.codePointAt(utf16Offset)
    const rawScalar = codePoint === undefined ? '' : String.fromCodePoint(codePoint)
    const scalar = normalizeScalar(rawScalar)
    const scalarBytes = utf8Length(scalar)
    if (lines >= lineLimit || bytes + scalarBytes > maxBytes) break
    bytes += scalarBytes
    utf16Offset += rawScalar.length
    if (scalar === '\n') lines += 1
  }
  return bytes
}

export const formatCommandOutputPage = (params: {
  source: CommandOutputSource
  options: ReadCommandOutputPageOptions
  command?: string
  terminalStatus?: string
}): FormattedCommandOutput => {
  assertBoundedSourceIdentifiers(params.source)
  const source = {
    ...params.source,
    output: normalizeUnicodeScalars(params.source.output),
  }
  const totalBytes = utf8Length(source.output)
  const terminalStatus = params.terminalStatus
    ? previewValue(params.terminalStatus, 2048)
    : undefined
  const { cursor, offset, limit } = params.options
  if (cursor !== undefined && offset !== undefined) {
    throw new Error('cursor and offset are mutually exclusive.')
  }
  let startByte = 0
  let startUtf16 = 0
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor, source.historyCommandMatchId)
    startByte = decoded.byteOffset
    startUtf16 = decoded.utf16Offset
  } else if (offset !== undefined) {
    const linePosition = positionForLine(source.output, offset)
    startByte = linePosition.byteOffset
    startUtf16 = linePosition.utf16Offset
  }
  if (
    source.capture.reason === 'record_expired' &&
    source.output.length === 0
  ) {
    // Keep a once-valid cursor useful as an explicit tombstone lookup. The
    // retained bytes are gone, but the contract can still explain why instead
    // of degrading into an ambiguous "cursor beyond output" error.
    startByte = 0
    startUtf16 = 0
  }
  if (startByte > totalBytes || startUtf16 > source.output.length) {
    throw new Error('Command output cursor is beyond the retained output.')
  }
  if (
    startUtf16 > 0 &&
    startUtf16 < source.output.length &&
    /[\ud800-\udbff]/.test(source.output[startUtf16 - 1]) &&
    /[\udc00-\udfff]/.test(source.output[startUtf16])
  ) {
    throw new Error('Command output cursor points inside a Unicode character.')
  }

  const requestedMaxBytes = params.options.maxBytes ?? DEFAULT_PAGE_UTF8_BYTES
  if (
    !Number.isSafeInteger(requestedMaxBytes) ||
    requestedMaxBytes < 4 ||
    requestedMaxBytes > MAX_PAGE_UTF8_BYTES
  ) {
    throw new Error(
      `maxBytes must be an integer between 4 and ${MAX_PAGE_UTF8_BYTES}.`
    )
  }
  const pageByteLimit = Math.min(MAX_PAGE_UTF8_BYTES, requestedMaxBytes)
  const legacyLineByteLimit = byteLimitForLines(
    source.output,
    startUtf16,
    limit ?? DEFAULT_LEGACY_LINE_LIMIT,
    pageByteLimit
  )
  const slice = sliceByUtf8Bytes(
    source.output,
    startByte,
    startUtf16,
    Math.min(pageByteLimit, legacyLineByteLimit)
  )
  const hasMore = slice.endUtf16Offset < source.output.length
  const nextCursor = hasMore
    ? encodeCursor(
        source.historyCommandMatchId,
        slice.endByteOffset,
        slice.endUtf16Offset
      )
    : undefined
  const pollCursor =
    !hasMore && source.executionState === 'running'
      ? encodeCursor(
          source.historyCommandMatchId,
          slice.endByteOffset,
          slice.endUtf16Offset
        )
      : undefined
  const contract = buildContract(source, {
    state:
      slice.content.length === 0 && !hasMore
        ? 'none'
        : startByte === 0 && !hasMore
          ? 'full'
          : 'excerpt',
    returnedUtf8Bytes: utf8Length(slice.content),
    hasMoreCapturedOutput: hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    ...(pollCursor ? { pollCursor } : {}),
  })
  const commandPreview = previewValue(params.command || '', 1024)
  let resultContract = contract
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bodyBudget = availableBodyBytes({
      contract: resultContract,
      commandPreview,
      terminalStatus,
    })
    const body = takeUtf8PrefixByEscapedBudget(slice.content, bodyBudget)
    if (body === slice.content) {
      resultContract = contract
    } else {
      const returnedBytes = utf8Length(body)
      const adjustedEnd = startByte + returnedBytes
      const adjustedUtf16End = startUtf16 + body.length
      resultContract = buildContract(source, {
        state: 'excerpt',
        returnedUtf8Bytes: returnedBytes,
        hasMoreCapturedOutput: adjustedEnd < totalBytes,
        ...(adjustedEnd < totalBytes
          ? {
              nextCursor: encodeCursor(
                source.historyCommandMatchId,
                adjustedEnd,
                adjustedUtf16End
              ),
            }
          : {}),
      })
    }
    const text = buildEnvelope({
      contract: resultContract,
      body,
      commandPreview,
      terminalStatus,
    })
    if (utf8Length(text) <= COMMAND_TOOL_RESULT_MAX_UTF8_BYTES) {
      return { contract: resultContract, text }
    }
  }
  throw new Error('Command output metadata exceeds the bounded tool-result envelope.')
}
