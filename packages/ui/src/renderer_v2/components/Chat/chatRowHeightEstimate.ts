import type { ChatMessage } from '../../stores/ChatStore'

export type ChatEstimatedRowKind = 'assistant' | 'user' | 'boundary'

export const DEFAULT_CHAT_ESTIMATE_VIEWPORT_WIDTH = 720

const MIN_CHAT_ROW_HEIGHT = 30
const CHAT_ROW_HORIZONTAL_PADDING = 32
const ESTIMATED_MONOSPACE_CHARACTER_WIDTH = 6.5
const ESTIMATED_TEXT_LINE_HEIGHT = 20
const ESTIMATED_BLANK_LINE_HEIGHT = 7
const ESTIMATED_ASSISTANT_TEXT_ROW_CHROME = 8
const ESTIMATED_USER_TEXT_ROW_CHROME = 72
const ESTIMATED_ASSISTANT_ROLE_LABEL_HEIGHT = 22
const ESTIMATED_ASSISTANT_ACTIONS_HEIGHT = 26
const ESTIMATED_IMAGE_STRIP_HEIGHT = 64

const EXPANDED_COMMAND_BANNER_HEIGHT = 168
const EXPANDED_TOOL_CALL_BANNER_HEIGHT = 150
const COLLAPSED_FILE_EDIT_BANNER_HEIGHT = 38
const COLLAPSED_SUB_TOOL_BANNER_HEIGHT = 38
const STREAMING_REASONING_BANNER_HEIGHT = 160
const COMPACTION_BANNER_HEIGHT = 38
const EXPANDED_ASK_BANNER_HEIGHT = 132
const ALERT_BANNER_HEIGHT = 118
const COMPACTION_BOUNDARY_HEIGHT = 40

export interface ChatTextHeightBucket {
  characterUnits: number
  lineCount: number
}

export interface ChatTextHeightShape {
  lineBuckets: ChatTextHeightBucket[]
  blankLineCount: number
}

export interface ChatRowHeightEstimate {
  fixedHeight: number
  textShape: ChatTextHeightShape | null
}

export interface ResolveChatRowHeightEstimateOptions {
  viewportWidth?: number | null
  showAssistantRoleLabel?: boolean
  showAssistantGroupActions?: boolean
}

const normalizeViewportWidth = (viewportWidth: number | null | undefined): number =>
  Number.isFinite(viewportWidth) && typeof viewportWidth === 'number' && viewportWidth > 0
    ? viewportWidth
    : DEFAULT_CHAT_ESTIMATE_VIEWPORT_WIDTH

const estimateCharacterUnits = (value: string): number => {
  let units = 0
  for (const character of value) {
    units += (character.codePointAt(0) || 0) > 0xff ? 2 : 1
  }
  return units
}

const COMMON_MARKDOWN_MARKERS: ReadonlySet<string> = new Set([
  '*',
  '_',
  '`',
  '#',
  '>',
  '|',
  '[',
  ']',
  '(',
  ')',
  '~',
  '-',
])

export const createChatTextHeightShape = (
  text: string,
): ChatTextHeightShape => {
  const lineCountByCharacterUnits = new Map<number, number>()
  let blankLineCount = 0
  let currentLineCharacterUnits = 0
  let currentLineHasVisibleContent = false

  const completeLine = () => {
    if (currentLineHasVisibleContent) {
      lineCountByCharacterUnits.set(
        currentLineCharacterUnits,
        (lineCountByCharacterUnits.get(currentLineCharacterUnits) || 0) + 1,
      )
    } else {
      blankLineCount += 1
    }
    currentLineCharacterUnits = 0
    currentLineHasVisibleContent = false
  }

  for (const character of String(text || '')) {
    if (character === '\n') {
      completeLine()
      continue
    }
    if (!currentLineHasVisibleContent && character.trim().length > 0) {
      currentLineHasVisibleContent = true
    }
    if (!COMMON_MARKDOWN_MARKERS.has(character)) {
      currentLineCharacterUnits += estimateCharacterUnits(character)
    }
  }
  completeLine()

  return {
    lineBuckets: Array.from(
      lineCountByCharacterUnits,
      ([characterUnits, lineCount]) => ({ characterUnits, lineCount }),
    ).sort((left, right) => left.characterUnits - right.characterUnits),
    blankLineCount,
  }
}

const estimateWrappedTextHeight = (
  shape: ChatTextHeightShape,
  viewportWidth: number | null | undefined,
): number => {
  const normalizedWidth = normalizeViewportWidth(viewportWidth)
  const availableWidth = Math.max(1, normalizedWidth - CHAT_ROW_HORIZONTAL_PADDING)
  const charactersPerLine = Math.max(
    8,
    Math.floor(availableWidth / ESTIMATED_MONOSPACE_CHARACTER_WIDTH),
  )
  const wrappedLineCount = shape.lineBuckets.reduce(
    (total, bucket) =>
      total +
      bucket.lineCount *
        Math.max(1, Math.ceil(bucket.characterUnits / charactersPerLine)),
    0,
  )

  return (
    wrappedLineCount * ESTIMATED_TEXT_LINE_HEIGHT +
    shape.blankLineCount * ESTIMATED_BLANK_LINE_HEIGHT
  )
}

export const createFixedChatRowHeightEstimate = (
  fixedHeight: number,
): ChatRowHeightEstimate => ({
  fixedHeight,
  textShape: null,
})

export const createChatRowHeightEstimate = (
  message: ChatMessage,
  kind: ChatEstimatedRowKind,
): ChatRowHeightEstimate => {
  if (kind === 'boundary') {
    return createFixedChatRowHeightEstimate(COMPACTION_BOUNDARY_HEIGHT)
  }

  if (kind === 'user') {
    const hasImages =
      Array.isArray(message.metadata?.inputImages) &&
      message.metadata.inputImages.length > 0
    return {
      fixedHeight:
        ESTIMATED_USER_TEXT_ROW_CHROME +
        (hasImages ? ESTIMATED_IMAGE_STRIP_HEIGHT : 0),
      textShape: createChatTextHeightShape(message.content),
    }
  }

  switch (message.type) {
    case 'command':
      return createFixedChatRowHeightEstimate(EXPANDED_COMMAND_BANNER_HEIGHT)
    case 'tool_call':
      return createFixedChatRowHeightEstimate(EXPANDED_TOOL_CALL_BANNER_HEIGHT)
    case 'file_edit':
      return createFixedChatRowHeightEstimate(COLLAPSED_FILE_EDIT_BANNER_HEIGHT)
    case 'sub_tool':
      return createFixedChatRowHeightEstimate(COLLAPSED_SUB_TOOL_BANNER_HEIGHT)
    case 'reasoning':
      return createFixedChatRowHeightEstimate(
        message.streaming
          ? STREAMING_REASONING_BANNER_HEIGHT
          : COLLAPSED_SUB_TOOL_BANNER_HEIGHT,
      )
    case 'compaction':
      return createFixedChatRowHeightEstimate(COMPACTION_BANNER_HEIGHT)
    case 'ask':
      return createFixedChatRowHeightEstimate(EXPANDED_ASK_BANNER_HEIGHT)
    case 'alert':
    case 'error':
      return createFixedChatRowHeightEstimate(ALERT_BANNER_HEIGHT)
    default:
      return {
        fixedHeight: ESTIMATED_ASSISTANT_TEXT_ROW_CHROME,
        textShape: createChatTextHeightShape(message.content),
      }
  }
}

export const resolveChatRowHeightEstimate = (
  estimate: ChatRowHeightEstimate,
  options: ResolveChatRowHeightEstimateOptions = {},
): number => {
  const textHeight = estimate.textShape
    ? estimateWrappedTextHeight(estimate.textShape, options.viewportWidth)
    : 0
  const roleLabelHeight = options.showAssistantRoleLabel
    ? ESTIMATED_ASSISTANT_ROLE_LABEL_HEIGHT
    : 0
  const actionsHeight = options.showAssistantGroupActions
    ? ESTIMATED_ASSISTANT_ACTIONS_HEIGHT
    : 0

  return Math.max(
    MIN_CHAT_ROW_HEIGHT,
    Math.ceil(estimate.fixedHeight + textHeight + roleLabelHeight + actionsHeight),
  )
}
