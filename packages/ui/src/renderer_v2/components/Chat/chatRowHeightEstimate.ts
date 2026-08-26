import type { ChatMessage } from '../../stores/ChatStore'
import {
  extractCommandOutputDisplayText,
  type ChatMessageGeometry,
  type ChatTextGeometryShape,
} from '@gyshell/shared'

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

// These are the established fallbacks used before geometry became content-aware.
// They remain the lower bound for special rows so an unloaded row does not
// visibly collapse while its bounded payload is being hydrated.
const EXPANDED_COMMAND_MIN_HEIGHT = 168
const EXPANDED_TOOL_CALL_MIN_HEIGHT = 150
const COLLAPSED_FILE_EDIT_BANNER_HEIGHT = 38
const COLLAPSED_SUB_TOOL_BANNER_HEIGHT = 38
const STREAMING_REASONING_BANNER_HEIGHT = 160
const COMPACTION_BANNER_HEIGHT = 38
const EXPANDED_ASK_BANNER_HEIGHT = 132
const ALERT_BANNER_HEIGHT = 118
const COMPACTION_BOUNDARY_HEIGHT = 40

const BANNER_HEADER_HEIGHT = 32
const BANNER_ROW_CHROME = 28
const BANNER_CONTENT_VERTICAL_PADDING = 24
const BANNER_CONTENT_LINE_GAP = 6
const BANNER_CONTENT_MAX_HEIGHT = 220
const BANNER_MAX_HEIGHT = 300
const ESTIMATED_BANNER_LINE_HEIGHT = 17
const ESTIMATED_BANNER_OUTPUT_LINE_HEIGHT = 16.8

export interface ChatTextHeightBucket {
  characterUnits: number
  lineCount: number
}

export interface ChatTextHeightShape {
  /** Compact [characterUnits, lineCount, ...] histogram pairs. */
  lineBuckets: number[]
  blankLineCount: number
  lineCount?: number
  characterCount?: number
  maxCharacterUnits?: number
}

export interface ChatRowHeightEstimate {
  fixedHeight: number
  textShape: ChatTextHeightShape | null
  outputShape?: ChatTextHeightShape | null
  diffShape?: ChatTextHeightShape | null
  detailsShape?: ChatTextHeightShape | null
  bannerKind?: ChatMessage['type'] | 'boundary' | null
}

export interface ResolveChatRowHeightEstimateOptions {
  viewportWidth?: number | null
  showAssistantRoleLabel?: boolean
  showAssistantGroupActions?: boolean
}

const normalizeViewportWidth = (
  viewportWidth: number | null | undefined,
): number =>
  Number.isFinite(viewportWidth) &&
  typeof viewportWidth === 'number' &&
  viewportWidth > 0
    ? viewportWidth
    : DEFAULT_CHAT_ESTIMATE_VIEWPORT_WIDTH

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

const createEmptyShape = (): ChatTextHeightShape => ({
  lineBuckets: [],
  blankLineCount: 1,
  lineCount: 0,
  characterCount: 0,
  maxCharacterUnits: 0,
})

const fromGeometryShape = (
  shape: ChatTextGeometryShape | null | undefined,
): ChatTextHeightShape | null => {
  if (!shape) return null
  let lineCount = 0
  for (let index = 1; index < shape.lineBuckets.length; index += 2) {
    lineCount += shape.lineBuckets[index] || 0
  }
  return {
    lineBuckets: shape.lineBuckets,
    blankLineCount: shape.blankLineCount,
    lineCount,
  }
}

export const createChatTextHeightShape = (
  text: string,
): ChatTextHeightShape => {
  const lineCountByCharacterUnits = new Map<number, number>()
  let blankLineCount = 0
  let characterCount = 0
  let currentLineCharacterUnits = 0
  let currentLineHasVisibleContent = false
  let maxCharacterUnits = 0

  const completeLine = () => {
    if (currentLineHasVisibleContent) {
      lineCountByCharacterUnits.set(
        currentLineCharacterUnits,
        (lineCountByCharacterUnits.get(currentLineCharacterUnits) || 0) + 1,
      )
      maxCharacterUnits = Math.max(maxCharacterUnits, currentLineCharacterUnits)
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
    characterCount += 1
    if (!currentLineHasVisibleContent && character.trim().length > 0) {
      currentLineHasVisibleContent = true
    }
    if (!COMMON_MARKDOWN_MARKERS.has(character)) {
      currentLineCharacterUnits +=
        (character.codePointAt(0) || 0) > 0xff ? 2 : 1
    }
  }
  completeLine()

  const lineBuckets: number[] = []
  Array.from(lineCountByCharacterUnits.entries())
    .sort(([left], [right]) => left - right)
    .forEach(([characterUnits, lineCount]) => {
      lineBuckets.push(characterUnits, lineCount)
    })

  return {
    lineBuckets,
    blankLineCount,
    lineCount: lineBuckets.reduce(
      (total, value, index) => (index % 2 === 1 ? total + value : total),
      0,
    ),
    characterCount,
    maxCharacterUnits,
  }
}

const getGeometryShape = (
  message: ChatMessage,
  field: 'contentShape' | 'outputShape' | 'diffShape' | 'detailsShape',
  fallback: () => ChatTextHeightShape,
): ChatTextHeightShape | null => {
  const geometry = message.geometry as ChatMessageGeometry | undefined
  return fromGeometryShape(geometry?.[field]) || fallback()
}

const getMessageText = (
  message: ChatMessage,
  field: 'content' | 'output' | 'diff' | 'details',
): string => {
  if (field === 'content') return String(message.content || '')
  return String(message.metadata?.[field] || '')
}

const estimateWrappedTextHeight = (
  shape: ChatTextHeightShape,
  viewportWidth: number | null | undefined,
  lineHeight = ESTIMATED_TEXT_LINE_HEIGHT,
  blankLineHeight = ESTIMATED_BLANK_LINE_HEIGHT,
  horizontalPadding = CHAT_ROW_HORIZONTAL_PADDING,
): number => {
  const normalizedWidth = normalizeViewportWidth(viewportWidth)
  const availableWidth = Math.max(1, normalizedWidth - horizontalPadding)
  const charactersPerLine = Math.max(
    8,
    Math.floor(availableWidth / ESTIMATED_MONOSPACE_CHARACTER_WIDTH),
  )
  let wrappedLineCount = 0
  for (let index = 0; index + 1 < shape.lineBuckets.length; index += 2) {
    const characterUnits = shape.lineBuckets[index] || 0
    const lineCount = shape.lineBuckets[index + 1] || 0
    wrappedLineCount +=
      lineCount * Math.max(1, Math.ceil(characterUnits / charactersPerLine))
  }

  return wrappedLineCount * lineHeight + shape.blankLineCount * blankLineHeight
}

const estimateExpandedBannerHeight = (
  estimate: ChatRowHeightEstimate,
  viewportWidth: number | null | undefined,
  minimumHeight: number,
): number => {
  const commandHeight = estimate.textShape
    ? estimateWrappedTextHeight(
        estimate.textShape,
        viewportWidth,
        ESTIMATED_BANNER_LINE_HEIGHT,
        5,
        40,
      )
    : 0
  const outputHeight = estimate.outputShape
    ? estimateWrappedTextHeight(
        estimate.outputShape,
        viewportWidth,
        ESTIMATED_BANNER_OUTPUT_LINE_HEIGHT,
        5,
        40,
      )
    : 0
  const bodyHeight = Math.min(
    BANNER_CONTENT_MAX_HEIGHT,
    Math.max(
      44,
      BANNER_CONTENT_VERTICAL_PADDING +
        commandHeight +
        (outputHeight > 0 ? BANNER_CONTENT_LINE_GAP + outputHeight : 0),
    ),
  )
  return Math.min(
    BANNER_MAX_HEIGHT,
    Math.max(
      minimumHeight,
      BANNER_HEADER_HEIGHT + bodyHeight + BANNER_ROW_CHROME,
    ),
  )
}

const estimateBannerContentDelta = (
  estimate: ChatRowHeightEstimate,
  viewportWidth: number | null | undefined,
): number => {
  const kind = estimate.bannerKind
  if (!kind) return 0

  if (kind === 'command') {
    return estimateExpandedBannerHeight(
      estimate,
      viewportWidth,
      EXPANDED_COMMAND_MIN_HEIGHT,
    )
  }
  if (kind === 'tool_call') {
    return estimateExpandedBannerHeight(
      estimate,
      viewportWidth,
      EXPANDED_TOOL_CALL_MIN_HEIGHT,
    )
  }

  // Non-expanded special banners use their fixed fallback. Streaming reasoning
  // is the one exception: its existing 160px fallback is a lower bound for the
  // visible output body, not an additional amount to add twice.
  if (kind === 'reasoning' && estimate.outputShape) {
    const outputHeight = estimateWrappedTextHeight(
      estimate.outputShape,
      viewportWidth,
      ESTIMATED_BANNER_OUTPUT_LINE_HEIGHT,
      5,
      40,
    )
    return Math.max(
      0,
      Math.min(
        STREAMING_REASONING_BANNER_HEIGHT,
        42 + outputHeight + BANNER_ROW_CHROME,
      ) - estimate.fixedHeight,
    )
  }

  return 0
}

export const createFixedChatRowHeightEstimate = (
  fixedHeight: number,
): ChatRowHeightEstimate => ({
  fixedHeight,
  textShape: null,
  bannerKind: null,
})

export const createChatRowHeightEstimate = (
  message: ChatMessage,
  kind: ChatEstimatedRowKind,
): ChatRowHeightEstimate => {
  if (kind === 'boundary') {
    return createFixedChatRowHeightEstimate(COMPACTION_BOUNDARY_HEIGHT)
  }

  const contentShape = getGeometryShape(message, 'contentShape', () =>
    createChatTextHeightShape(getMessageText(message, 'content')),
  )

  if (kind === 'user') {
    const hasImages =
      (message.geometry?.inputImageCount || 0) > 0 ||
      (Array.isArray(message.metadata?.inputImages) &&
        message.metadata.inputImages.length > 0)
    return {
      fixedHeight:
        ESTIMATED_USER_TEXT_ROW_CHROME +
        (hasImages ? ESTIMATED_IMAGE_STRIP_HEIGHT : 0),
      textShape: contentShape,
      bannerKind: null,
    }
  }

  const outputShape = getGeometryShape(message, 'outputShape', () =>
    createChatTextHeightShape(
      extractCommandOutputDisplayText(getMessageText(message, 'output')),
    ),
  )
  const diffShape = getGeometryShape(message, 'diffShape', () =>
    createChatTextHeightShape(getMessageText(message, 'diff')),
  )
  const detailsShape = getGeometryShape(message, 'detailsShape', () =>
    createChatTextHeightShape(getMessageText(message, 'details')),
  )

  switch (message.type) {
    case 'command':
      return {
        fixedHeight: 0,
        textShape: contentShape,
        outputShape,
        bannerKind: 'command',
      }
    case 'tool_call':
      return {
        fixedHeight: 0,
        textShape: contentShape,
        outputShape,
        bannerKind: 'tool_call',
      }
    case 'file_edit':
      return {
        fixedHeight: COLLAPSED_FILE_EDIT_BANNER_HEIGHT,
        textShape: null,
        diffShape,
        bannerKind: 'file_edit',
      }
    case 'sub_tool':
      return {
        fixedHeight: COLLAPSED_SUB_TOOL_BANNER_HEIGHT,
        textShape: null,
        outputShape,
        bannerKind: 'sub_tool',
      }
    case 'reasoning':
      return {
        fixedHeight: message.streaming
          ? STREAMING_REASONING_BANNER_HEIGHT
          : COLLAPSED_SUB_TOOL_BANNER_HEIGHT,
        textShape: null,
        outputShape,
        bannerKind: 'reasoning',
      }
    case 'compaction':
      return {
        fixedHeight: COMPACTION_BANNER_HEIGHT,
        textShape: null,
        bannerKind: 'compaction',
      }
    case 'ask':
      return {
        fixedHeight: EXPANDED_ASK_BANNER_HEIGHT,
        textShape: null,
        bannerKind: 'ask',
      }
    case 'alert':
    case 'error':
      return {
        fixedHeight: ALERT_BANNER_HEIGHT,
        textShape: contentShape,
        detailsShape,
        bannerKind: message.type,
      }
    default:
      return {
        fixedHeight: ESTIMATED_ASSISTANT_TEXT_ROW_CHROME,
        textShape: contentShape,
        bannerKind: null,
      }
  }
}

export const resolveChatRowHeightEstimate = (
  estimate: ChatRowHeightEstimate,
  options: ResolveChatRowHeightEstimateOptions = {},
): number => {
  const contentHeight = estimate.bannerKind
    ? estimateBannerContentDelta(estimate, options.viewportWidth)
    : estimate.textShape
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
    Math.ceil(
      estimate.fixedHeight + contentHeight + roleLabelHeight + actionsHeight,
    ),
  )
}

export const getChatTextShapeLineCount = (
  shape: ChatTextHeightShape | null | undefined,
): number =>
  shape?.lineCount ??
  shape?.lineBuckets.reduce(
    (total, value, index) => (index % 2 === 1 ? total + value : total),
    0,
  ) ??
  0

export const createEmptyChatTextHeightShape = (): ChatTextHeightShape =>
  createEmptyShape()
