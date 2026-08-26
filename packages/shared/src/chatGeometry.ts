import type { CommandOutputContractV1 } from './commandOutput'

/**
 * Compact histogram encoding: [characterUnits, lineCount, characterUnits,
 * lineCount, ...]. Pairs are sorted by characterUnits.
 */
export interface ChatTextGeometryShape {
  lineBuckets: number[]
  blankLineCount: number
}

export type ChatGeometryDeferredField =
  | 'content'
  | 'output'
  | 'diff'
  | 'details'
  | 'inputImages'
  | 'metadata'

export interface ChatMessageGeometryMetadata {
  tabName?: string
  commandId?: string
  exitCode?: number
  filePath?: string
  action?: 'created' | 'edited' | 'error'
  collapsed?: boolean
  isNowait?: boolean
  commandOutput?: CommandOutputContractV1
  toolName?: string
  subToolTitle?: string
  subToolHint?: string
  subToolLevel?: 'info' | 'warning' | 'error'
  approvalId?: string
  decision?: 'allow' | 'deny'
  command?: string
  modelName?: string
  totalTokens?: number
  maxTokens?: number
  inputKind?: 'normal' | 'inserted'
  compactionBoundaryTargetBackendMessageId?: string
  compactionBoundaryPreviousBackendMessageId?: string
  compactionBoundarySummaryBackendMessageId?: string
  compactionBoundaryProtectedNormalRounds?: number
}

export interface ChatMessageGeometryProjection {
  content?: string
  output?: string
  diff?: string
  details?: string
  deferredFields?: ChatGeometryDeferredField[]
}

export interface ChatMessageGeometry {
  contentShape: ChatTextGeometryShape
  outputShape?: ChatTextGeometryShape
  diffShape?: ChatTextGeometryShape
  detailsShape?: ChatTextGeometryShape
  inputImageCount?: number
}

export interface UiMessageGeometryEntry {
  position: number
  id: string
  backendMessageId?: string
  role: 'user' | 'assistant' | 'system'
  type:
    | 'text'
    | 'command'
    | 'tool_call'
    | 'file_edit'
    | 'sub_tool'
    | 'reasoning'
    | 'compaction'
    | 'compaction_boundary'
    | 'alert'
    | 'error'
    | 'ask'
    | 'tokens_count'
  timestamp: number
  streaming?: boolean
  metadata?: ChatMessageGeometryMetadata
  geometry: ChatMessageGeometry
  projection: ChatMessageGeometryProjection
}

export interface UiMessageGeometryIndex {
  sessionId: string
  entries: UiMessageGeometryEntry[]
  totalCount: number
  uiRevision: number
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

const estimateCharacterUnits = (character: string): number =>
  (character.codePointAt(0) || 0) > 0xff ? 2 : 1

/**
 * Geometry is sent for every historical message, so the number of distinct
 * line-width buckets must be bounded independently of the message contents.
 * Widths up to 127 units stay exact; longer lines use four logarithmic buckets
 * per power-of-two range. The upper edge of each bucket is conservative for
 * virtual layout purposes.
 */
const CHAT_TEXT_GEOMETRY_EXACT_WIDTH_LIMIT = 127
const CHAT_TEXT_GEOMETRY_LOG_BUCKETS_PER_OCTAVE = 4
const CHAT_TEXT_GEOMETRY_LOG_BUCKET_COUNT = 128
export const CHAT_TEXT_GEOMETRY_MAX_BUCKET_PAIRS =
  CHAT_TEXT_GEOMETRY_EXACT_WIDTH_LIMIT + 1 +
  CHAT_TEXT_GEOMETRY_LOG_BUCKET_COUNT

const getGeometryLineWidthBucket = (characterUnits: number): number => {
  if (characterUnits <= CHAT_TEXT_GEOMETRY_EXACT_WIDTH_LIMIT) {
    return characterUnits
  }

  const normalized = characterUnits / (CHAT_TEXT_GEOMETRY_EXACT_WIDTH_LIMIT + 1)
  const logarithmicPosition = Math.max(0, Math.log2(normalized))
  const bucketIndex = Math.min(
    CHAT_TEXT_GEOMETRY_LOG_BUCKET_COUNT - 1,
    Math.floor(
      logarithmicPosition * CHAT_TEXT_GEOMETRY_LOG_BUCKETS_PER_OCTAVE,
    ),
  )
  const bucketUpperExponent =
    (bucketIndex + 1) / CHAT_TEXT_GEOMETRY_LOG_BUCKETS_PER_OCTAVE
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.ceil(
      (CHAT_TEXT_GEOMETRY_EXACT_WIDTH_LIMIT + 1) *
        2 ** bucketUpperExponent,
    ),
  )
}

export const createChatTextGeometryShape = (
  text: string,
): ChatTextGeometryShape => {
  const lineCountByCharacterUnits = new Map<number, number>()
  let blankLineCount = 0
  let currentLineCharacterUnits = 0
  let currentLineHasVisibleContent = false

  const completeLine = () => {
    if (currentLineHasVisibleContent) {
      const bucket = getGeometryLineWidthBucket(currentLineCharacterUnits)
      lineCountByCharacterUnits.set(
        bucket,
        (lineCountByCharacterUnits.get(bucket) || 0) + 1,
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

  const lineBuckets = Array.from(lineCountByCharacterUnits.entries())
    .sort(([left], [right]) => left - right)
    .flatMap(([characterUnits, lineCount]) => [characterUnits, lineCount])

  return { lineBuckets, blankLineCount }
}

export const isChatTextGeometryWhitespace = (
  shape: ChatTextGeometryShape,
): boolean => shape.lineBuckets.length === 0
