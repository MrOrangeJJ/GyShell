import {
  extractCommandOutputDisplayText,
  parseCommandOutputContractV1,
  type CommandCaptureReason,
} from '@gyshell/shared'
import type { ChatMessage } from '../../stores/ChatStore'

export type SeamlessStepTone = 'neutral' | 'warning' | 'error'
export type SeamlessStepDetailKind = 'input' | 'output' | 'diff'
export type SeamlessDiffLineTone =
  | 'addition'
  | 'removal'
  | 'metadata'
  | 'context'

export interface SeamlessStepDetail {
  key: string
  label: string
  content: string
  kind: SeamlessStepDetailKind
  truncated: boolean
}

export interface SeamlessStepPresentation {
  kindLabel: string
  title: string
  subtitle?: string
  summary: string
  fullSummary: string
  meta?: string
  tone: SeamlessStepTone
  details: SeamlessStepDetail[]
}

export interface CommandOutputUiPresentation {
  executionLabel: string
  captureLabel: string
  presentationLabel: string
  meta: string
  tone: SeamlessStepTone
  executionTone: SeamlessStepTone
  captureTone: SeamlessStepTone
  isRunning: boolean
  isDone: boolean
}

export const SEAMLESS_DETAIL_PREVIEW_LIMIT = 12_000

export const isSeamlessGroupRunning = (
  messages: readonly ChatMessage[],
): boolean =>
  messages.some(
    (message) =>
      message.streaming === true ||
      (message.type === 'command' &&
        message.metadata?.commandOutput?.executionState === 'running'),
  )

const MAX_SUMMARY_LENGTH = 96
const MAX_INLINE_VALUE_LENGTH = 44
const TOOL_FAILURE_OUTPUT_PATTERN =
  /^(?:error(?:\s|:)|parameter validation error\b|command blocked by policy\b|user rejected command\b|failed to\b|this call was blocked\b)/i

const compactWhitespace = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

const isHighSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xd800 && codeUnit <= 0xdbff

const isLowSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xdc00 && codeUnit <= 0xdfff

export const sliceFromStartAtUnicodeBoundary = (
  value: string,
  maxCodeUnits: number,
): string => {
  let end = Math.min(value.length, Math.max(0, maxCodeUnits))
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1
  }
  return value.slice(0, end)
}

const sliceFromEndAtUnicodeBoundary = (
  value: string,
  maxCodeUnits: number,
): string => {
  let start = Math.max(0, value.length - Math.max(0, maxCodeUnits))
  if (
    start > 0 &&
    start < value.length &&
    isHighSurrogate(value.charCodeAt(start - 1)) &&
    isLowSurrogate(value.charCodeAt(start))
  ) {
    start += 1
  }
  return value.slice(start)
}

const UI_PREVIEW_OMISSION_MARKER =
  '\n\n[UI preview omitted middle content; showing beginning and end.]\n\n'

const createBoundedDetailPreview = (content: string): string => {
  if (content.length <= SEAMLESS_DETAIL_PREVIEW_LIMIT) return content

  const availableCodeUnits = Math.max(
    0,
    SEAMLESS_DETAIL_PREVIEW_LIMIT - UI_PREVIEW_OMISSION_MARKER.length,
  )
  const headBudget = Math.ceil(availableCodeUnits / 2)
  const tailBudget = Math.floor(availableCodeUnits / 2)
  return `${sliceFromStartAtUnicodeBoundary(content, headBudget)}${UI_PREVIEW_OMISSION_MARKER}${sliceFromEndAtUnicodeBoundary(content, tailBudget)}`
}

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value
  return `${sliceFromStartAtUnicodeBoundary(value, maxLength - 1).trimEnd()}…`
}

const cleanHint = (value: unknown): string =>
  compactWhitespace(value).replace(/(?:\.{3}|…)\s*$/, '')

const formatInlineValue = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return truncate(compactWhitespace(value), MAX_INLINE_VALUE_LENGTH)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.length} items]`
  }
  if (typeof value === 'object') return '{…}'
  return truncate(compactWhitespace(value), MAX_INLINE_VALUE_LENGTH)
}

const formatToolInput = (
  rawInput: string,
): { inline: string; detail: string } => {
  const normalized = rawInput.trim()
  if (!normalized) return { inline: '', detail: '' }
  if (normalized.length > SEAMLESS_DETAIL_PREVIEW_LIMIT) {
    return {
      inline: truncate(
        compactWhitespace(
          normalized.slice(0, SEAMLESS_DETAIL_PREVIEW_LIMIT),
        ),
        MAX_SUMMARY_LENGTH,
      ),
      detail: normalized,
    }
  }

  try {
    const parsed = JSON.parse(normalized) as unknown
    const detail = JSON.stringify(parsed, null, 2) ?? normalized
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return {
        inline: truncate(formatInlineValue(parsed), MAX_SUMMARY_LENGTH),
        detail,
      }
    }

    const inlineParts: string[] = []
    for (const key in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue
      inlineParts.push(
        `${key}: ${formatInlineValue((parsed as Record<string, unknown>)[key])}`,
      )
      if (inlineParts.length === 2) break
    }
    const inline = inlineParts.join(' · ')
    return { inline, detail }
  } catch {
    return {
      inline: truncate(compactWhitespace(normalized), MAX_SUMMARY_LENGTH),
      detail: normalized,
    }
  }
}

const createDetail = (
  key: string,
  label: string,
  rawContent: unknown,
  kind: SeamlessStepDetailKind,
): SeamlessStepDetail | null => {
  const content = String(rawContent ?? '')
  if (!content.trim()) return null
  const truncated = content.length > SEAMLESS_DETAIL_PREVIEW_LIMIT
  return {
    key,
    label,
    content: createBoundedDetailPreview(content),
    kind,
    truncated,
  }
}

const appendDetail = (
  details: SeamlessStepDetail[],
  detail: SeamlessStepDetail | null,
  duplicateCandidates: readonly string[] = [],
): void => {
  if (!detail) return
  const isDuplicate = duplicateCandidates.some(
    (candidate) => candidate === detail.content,
  )
  if (!isDuplicate) details.push(detail)
}

const isDiffFileHeader = (line: string, marker: '+++' | '---'): boolean =>
  line.startsWith(`${marker} `) ||
  line.startsWith(`${marker}\t`)

export const getSeamlessDiffLineTone = (
  line: string,
): SeamlessDiffLineTone => {
  if (line.startsWith('+') && !isDiffFileHeader(line, '+++')) {
    return 'addition'
  }
  if (line.startsWith('-') && !isDiffFileHeader(line, '---')) {
    return 'removal'
  }
  if (
    line.startsWith('@@') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    isDiffFileHeader(line, '+++') ||
    isDiffFileHeader(line, '---')
  ) {
    return 'metadata'
  }
  return 'context'
}

const getDiffSummary = (diff: string): string | undefined => {
  let added = 0
  let removed = 0
  diff.split('\n').forEach((line) => {
    const tone = getSeamlessDiffLineTone(line)
    if (tone === 'addition') added += 1
    if (tone === 'removal') removed += 1
  })
  return added || removed ? `+${added} / −${removed}` : undefined
}

const joinSummary = (...parts: Array<string | undefined>): string =>
  parts.filter((part): part is string => !!part).join(' · ')

const getCaptureReasonLabel = (
  reason: CommandCaptureReason | undefined,
): string | undefined => {
  switch (reason) {
    case 'retention_limit':
      return 'retention limit'
    case 'tracking_lost':
      return 'tracking lost'
    case 'runtime_boundary':
      return 'runtime ended'
    case 'tracking_unavailable':
      return 'tracking unavailable'
    case 'projection_ambiguous':
      return 'ambiguous terminal control sequence'
    case 'record_expired':
      return 'record expired'
    default:
      return undefined
  }
}

export const getCommandOutputUiPresentation = (
  message: ChatMessage,
): CommandOutputUiPresentation | null => {
  const contract = parseCommandOutputContractV1(
    message.metadata?.commandOutput,
  )
  if (!contract) return null

  const executionLabel = (() => {
    switch (contract.executionState) {
      case 'running':
        return 'Running'
      case 'finished':
        return typeof contract.exitCode === 'number'
          ? `Exit ${contract.exitCode}`
          : 'Finished'
      case 'aborted':
        return 'Aborted'
      case 'outcome_unknown':
        return 'Outcome unknown'
    }
  })()
  const captureReason = getCaptureReasonLabel(contract.capture.reason)
  const captureBaseLabel = (() => {
    switch (contract.capture.state) {
      case 'in_progress':
        return 'Capture in progress'
      case 'complete':
        return 'Capture complete'
      case 'incomplete':
        return captureReason
          ? `Capture incomplete (${captureReason})`
          : 'Capture incomplete'
      case 'unknown':
        return captureReason
          ? `Capture unknown (${captureReason})`
          : 'Capture unknown'
    }
  })()
  const captureDiagnostics: string[] = []
  if (
    contract.capture.observedUtf8Bytes !== contract.capture.retainedUtf8Bytes
  ) {
    captureDiagnostics.push(
      `retained ${contract.capture.retainedUtf8Bytes}/${contract.capture.observedUtf8Bytes} UTF-8 bytes`,
    )
  }
  if (contract.capture.terminalControlsObserved) {
    captureDiagnostics.push('terminal controls observed')
  }
  const captureLabel = `${captureBaseLabel}${
    captureDiagnostics.length > 0
      ? `; ${captureDiagnostics.join('; ')}`
      : ''
  }`
  const presentationLabel = (() => {
    switch (contract.presentation.state) {
      case 'none':
        return contract.executionState === 'running'
          ? 'Result: none yet'
          : 'Result: no captured output'
      case 'full':
        return 'Result: all captured output'
      case 'excerpt':
        return 'Result: captured-output excerpt'
    }
  })()

  const hasFailedExit =
    contract.executionState === 'finished' &&
    typeof contract.exitCode === 'number' &&
    contract.exitCode !== 0
  const hasUncertainState =
    contract.executionState === 'aborted' ||
    contract.executionState === 'outcome_unknown' ||
    contract.capture.state === 'incomplete' ||
    contract.capture.state === 'unknown'
  const executionTone: SeamlessStepTone = hasFailedExit
    ? 'error'
    : contract.executionState === 'aborted' ||
        contract.executionState === 'outcome_unknown'
      ? 'warning'
      : 'neutral'
  const captureTone: SeamlessStepTone =
    contract.capture.state === 'incomplete' ||
    contract.capture.state === 'unknown'
      ? 'warning'
      : 'neutral'

  return {
    executionLabel,
    captureLabel,
    presentationLabel,
    meta: [executionLabel, captureLabel, presentationLabel].join(' · '),
    tone: hasFailedExit ? 'error' : hasUncertainState ? 'warning' : 'neutral',
    executionTone,
    captureTone,
    isRunning: contract.executionState === 'running',
    isDone: contract.executionState !== 'running',
  }
}

const getToolActivityTone = (message: ChatMessage): SeamlessStepTone => {
  const explicitLevel = message.metadata?.subToolLevel
  if (explicitLevel === 'error') return 'error'
  if (explicitLevel === 'warning') return 'warning'
  const output = String(message.metadata?.output ?? '').trimStart()
  if (TOOL_FAILURE_OUTPUT_PATTERN.test(output)) return 'error'
  if (output.length > SEAMLESS_DETAIL_PREVIEW_LIMIT) return 'neutral'

  try {
    const structured = JSON.parse(output) as unknown
    if (!structured || Array.isArray(structured) || typeof structured !== 'object') {
      return 'neutral'
    }
    const result = structured as Record<string, unknown>
    const status = compactWhitespace(result.status).toLowerCase()
    if (
      ['error', 'failed', 'failure', 'denied', 'blocked'].includes(status) ||
      result.ok === false ||
      result.success === false
    ) {
      return 'error'
    }
  } catch {
    // Plain-text tool output is expected; the prefix check above handles it.
  }
  return 'neutral'
}

export const buildSeamlessStepPresentation = (
  message: ChatMessage,
): SeamlessStepPresentation => {
  const details: SeamlessStepDetail[] = []

  if (message.type === 'command') {
    const rawCommand = String(message.content ?? '')
    const command = compactWhitespace(rawCommand) || 'Command'
    const title = `$ ${command}`
    const subtitle = message.metadata?.tabName
      ? `on ${compactWhitespace(message.metadata.tabName)}`
      : undefined
    const exitCode = message.metadata?.exitCode
    const commandOutputPresentation = getCommandOutputUiPresentation(message)
    const isBackgroundTransition =
      message.metadata?.isNowait === true && exitCode === -3
    const meta = commandOutputPresentation?.meta ??
      (message.streaming
        ? 'Running'
        : isBackgroundTransition
          ? 'Async'
          : typeof exitCode === 'number'
            ? `Exit ${exitCode}`
            : message.metadata?.isNowait
              ? 'Async'
              : undefined)
    if (
      rawCommand.trim() &&
      (rawCommand.trim() !== command || title.length > MAX_SUMMARY_LENGTH)
    ) {
      appendDetail(
        details,
        createDetail('input', 'Command', rawCommand, 'input'),
      )
    }
    appendDetail(
      details,
      createDetail(
        'output',
        'Output',
        extractCommandOutputDisplayText(message.metadata?.output || ''),
        'output',
      ),
      [command, title],
    )
    const fullSummary = joinSummary(title, subtitle)
    return {
      kindLabel: 'Run',
      title,
      subtitle,
      summary: truncate(fullSummary, MAX_SUMMARY_LENGTH),
      fullSummary,
      meta,
      tone:
        commandOutputPresentation?.tone ??
        (typeof exitCode === 'number' && exitCode !== 0 && !isBackgroundTransition
          ? 'error'
          : 'neutral'),
      details,
    }
  }

  if (message.type === 'tool_call') {
    const title = compactWhitespace(message.metadata?.toolName) || 'Tool call'
    const input = formatToolInput(String(message.content || ''))
    const subtitle = input.inline || undefined
    appendDetail(
      details,
      createDetail('input', 'Input', input.detail, 'input'),
      [title],
    )
    appendDetail(
      details,
      createDetail(
        'result',
        'Result',
        extractCommandOutputDisplayText(message.metadata?.output || ''),
        'output',
      ),
      [title, input.detail],
    )
    const fullSummary = joinSummary(title, subtitle)
    const commandOutputPresentation = getCommandOutputUiPresentation(message)
    const toolTone = getToolActivityTone(message)
    return {
      kindLabel: 'Tool',
      title,
      subtitle,
      summary: truncate(fullSummary, MAX_SUMMARY_LENGTH),
      fullSummary,
      meta: commandOutputPresentation?.meta,
      tone:
        toolTone === 'error' || commandOutputPresentation?.tone === 'error'
          ? 'error'
          : toolTone === 'warning' ||
              commandOutputPresentation?.tone === 'warning'
            ? 'warning'
            : 'neutral',
      details,
    }
  }

  if (message.type === 'file_edit') {
    const action = message.metadata?.action || 'edited'
    const kindLabel =
      action === 'created' ? 'Create' : action === 'error' ? 'Error' : 'Edit'
    const title =
      compactWhitespace(message.metadata?.filePath || message.content) ||
      'Unknown file'
    const diff = String(message.metadata?.diff || '')
    const fullSummary = joinSummary(kindLabel, title)
    if (diff.trim()) {
      appendDetail(details, createDetail('diff', 'Diff', diff, 'diff'))
    } else {
      appendDetail(
        details,
        createDetail(
          'result',
          'Result',
          message.metadata?.output || message.content,
          'output',
        ),
        fullSummary.length > MAX_SUMMARY_LENGTH ? [] : [title],
      )
      if (details.length === 0 && fullSummary.length > MAX_SUMMARY_LENGTH) {
        appendDetail(
          details,
          createDetail(
            'path',
            message.metadata?.filePath ? 'Path' : 'Result',
            title,
            message.metadata?.filePath ? 'input' : 'output',
          ),
        )
      }
    }
    return {
      kindLabel,
      title,
      summary: truncate(fullSummary, MAX_SUMMARY_LENGTH),
      fullSummary,
      meta: getDiffSummary(diff),
      tone: action === 'error' ? 'error' : 'neutral',
      details,
    }
  }

  const title =
    compactWhitespace(message.metadata?.subToolTitle || message.content) ||
    'Activity'
  const subtitle = cleanHint(message.metadata?.subToolHint) || undefined
  appendDetail(
    details,
    createDetail('result', 'Result', message.metadata?.output, 'output'),
    [title, subtitle || ''],
  )
  const fullSummary = joinSummary(title, subtitle)
  return {
    kindLabel: 'Activity',
    title,
    subtitle,
    summary: truncate(fullSummary, MAX_SUMMARY_LENGTH),
    fullSummary,
    tone: getToolActivityTone(message),
    details,
  }
}

export const getSeamlessGroupTone = (
  presentations: readonly SeamlessStepPresentation[],
): SeamlessStepTone => {
  if (presentations.some((presentation) => presentation.tone === 'error')) {
    return 'error'
  }
  if (presentations.some((presentation) => presentation.tone === 'warning')) {
    return 'warning'
  }
  return 'neutral'
}
