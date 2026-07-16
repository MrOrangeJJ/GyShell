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

export const SEAMLESS_DETAIL_PREVIEW_LIMIT = 12_000

const MAX_SUMMARY_LENGTH = 96
const MAX_INLINE_VALUE_LENGTH = 44
const TOOL_FAILURE_OUTPUT_PATTERN =
  /^(?:error(?:\s|:)|parameter validation error\b|command blocked by policy\b|user rejected command\b|failed to\b|this call was blocked\b)/i

const compactWhitespace = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
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
    content: truncated
      ? `${content.slice(0, SEAMLESS_DETAIL_PREVIEW_LIMIT)}\n…`
      : content,
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
    const isBackgroundTransition =
      message.metadata?.isNowait === true && exitCode === -3
    const meta = message.streaming
      ? 'Running'
      : isBackgroundTransition
        ? 'Async'
        : typeof exitCode === 'number'
          ? `Exit ${exitCode}`
          : message.metadata?.isNowait
            ? 'Async'
            : undefined
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
      createDetail('output', 'Output', message.metadata?.output, 'output'),
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
        typeof exitCode === 'number' && exitCode !== 0 && !isBackgroundTransition
          ? 'error'
          : 'neutral',
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
      createDetail('result', 'Result', message.metadata?.output, 'output'),
      [title, input.detail],
    )
    const fullSummary = joinSummary(title, subtitle)
    return {
      kindLabel: 'Tool',
      title,
      subtitle,
      summary: truncate(fullSummary, MAX_SUMMARY_LENGTH),
      fullSummary,
      tone: getToolActivityTone(message),
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
