import type { ChatMessage, ChatSession } from '../../stores/ChatStore'
import {
  buildSeamlessStepPresentation,
  isSeamlessGroupRunning,
} from './seamlessToolPresentation'

export type ChatVisibleRowKind = 'assistant' | 'user' | 'boundary'

export interface ChatRenderItem {
  id: string
  kind: ChatVisibleRowKind
  estimatedHeight: number
  mergeWithPreviousAssistant: boolean
  showAssistantRoleLabel: boolean
  showAssistantGroupCopy: boolean
  assistantGroupMessageIds: string[]
  assistantGroupBranchMessageId?: string | null
  // Seamless mode: when set, this item represents a group of tool-call messages
  seamlessGroupMessageIds?: string[]
  // Seamless mode: true if any message in the group is currently streaming
  seamlessGroupStreaming?: boolean
}

type RowDisplayKind = ChatVisibleRowKind | 'hidden'

interface VisibleRow {
  id: string
  kind: ChatVisibleRowKind
  msg: ChatMessage
}

const SPECIAL_ASSISTANT_TYPES: ReadonlySet<ChatMessage['type']> = new Set([
  'command',
  'tool_call',
  'file_edit',
  'sub_tool',
  'reasoning',
  'compaction',
  'ask',
  'alert',
  'error',
])

// Message types that are grouped into a single seamless tool-activity banner
const SEAMLESS_TOOL_TYPES: ReadonlySet<ChatMessage['type']> = new Set([
  'command',
  'tool_call',
  'file_edit',
  'sub_tool',
])

const SEAMLESS_COLLAPSED_ESTIMATED_HEIGHT = 72
const SEAMLESS_DISCLOSURE_ROW_ESTIMATED_HEIGHT = 22
const SEAMLESS_EXPANDED_VERTICAL_CHROME = 12
const EMPTY_EXPANDED_SEAMLESS_GROUP_IDS: ReadonlySet<string> = new Set()

const estimateExpandedSeamlessGroupHeight = (
  messages: readonly ChatMessage[],
): number => {
  const disclosureRowCount =
    messages.length === 1
      ? buildSeamlessStepPresentation(messages[0]).details.length
      : messages.length
  return (
    SEAMLESS_COLLAPSED_ESTIMATED_HEIGHT +
    SEAMLESS_EXPANDED_VERTICAL_CHROME +
    disclosureRowCount * SEAMLESS_DISCLOSURE_ROW_ESTIMATED_HEIGHT
  )
}

const isCompletedWhitespaceAssistantText = (message: ChatMessage): boolean =>
  message.role === 'assistant' &&
  message.type === 'text' &&
  message.streaming !== true &&
  !/\S/.test(String(message.content || ''))

const isSeamlessOverlayMessage = (
  message: ChatMessage,
  lastMessageId: string | null,
): boolean => {
  if (message.type === 'ask' || message.type === 'error') return true
  if (message.type === 'alert') {
    if (message.metadata?.subToolLevel === 'info') {
      return message.id === lastMessageId
    }
    return true
  }
  return false
}

const isHiddenTailMessage = (message: ChatMessage): boolean =>
  message.type === 'tokens_count' || isCompletedWhitespaceAssistantText(message)

const findNextNonBoundaryVisibleRow = (
  rows: readonly VisibleRow[],
  startIndex: number,
): VisibleRow | undefined => {
  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.kind !== 'boundary') return row
  }
  return undefined
}

export const resolveSeamlessOverlayMessages = (
  session: ChatSession | null,
): ChatMessage[] => {
  if (!session) return []

  const lastMessageId =
    session.messageIds.length > 0
      ? session.messageIds[session.messageIds.length - 1]
      : null
  const overlayMessages: ChatMessage[] = []

  for (let index = session.messageIds.length - 1; index >= 0; index -= 1) {
    const messageId = session.messageIds[index]
    const message = session.messagesById.get(messageId)
    if (!message) continue
    if (isHiddenTailMessage(message)) continue
    if (!isSeamlessOverlayMessage(message, lastMessageId)) break
    overlayMessages.unshift(message)
  }

  return overlayMessages
}

const getRowDisplayKind = (
  session: ChatSession,
  messageId: string,
  lastMessageId: string | null,
): RowDisplayKind => {
  const candidate = session.messagesById.get(messageId)
  if (!candidate) return 'hidden'
  if (candidate.type === 'tokens_count') return 'hidden'
  if (candidate.type === 'compaction_boundary') return 'boundary'
  if (candidate.role === 'user') return 'user'
  if (isCompletedWhitespaceAssistantText(candidate)) return 'hidden'

  const isLastInSession = lastMessageId === messageId
  const isRetryHint =
    candidate.type === 'alert' && candidate.metadata?.subToolLevel === 'info'
  if (isRetryHint && !isLastInSession) return 'hidden'
  if (
    (candidate.type === 'reasoning' || candidate.type === 'compaction') &&
    !isLastInSession
  ) {
    return 'hidden'
  }
  if (SPECIAL_ASSISTANT_TYPES.has(candidate.type)) return 'assistant'
  return candidate.role === 'assistant' ? 'assistant' : 'hidden'
}

const estimateRowHeight = (
  message: ChatMessage,
  kind: ChatVisibleRowKind,
): number => {
  if (kind === 'user') {
    return Array.isArray(message.metadata?.inputImages) &&
      message.metadata.inputImages.length > 0
      ? 156
      : 92
  }
  if (kind === 'boundary') return 40

  switch (message.type) {
    case 'command':
      return 168
    case 'tool_call':
      return 150
    case 'file_edit':
      return 176
    case 'sub_tool':
    case 'reasoning':
    case 'compaction':
      return 160
    case 'ask':
      return 132
    case 'alert':
    case 'error':
      return 118
    default:
      return 140
  }
}

const hasAssistantItemInCurrentTurn = (
  items: readonly ChatRenderItem[],
): boolean => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind === 'user' || items[index].kind === 'boundary') {
      return false
    }
    if (items[index].kind === 'assistant') return true
  }
  return false
}

export const buildChatRenderItems = (
  session: ChatSession | null,
  isThinking: boolean,
  displayMode: 'classic' | 'seamless' = 'classic',
  expandedSeamlessGroupIds: ReadonlySet<string> =
    EMPTY_EXPANDED_SEAMLESS_GROUP_IDS,
): ChatRenderItem[] => {
  if (!session) return []

  const visibleRows: VisibleRow[] = []
  const lastMessageId =
    session.messageIds.length > 0
      ? session.messageIds[session.messageIds.length - 1]
      : null

  session.messageIds.forEach((messageId) => {
    const msg = session.messagesById.get(messageId)
    if (!msg) return

    // In seamless mode, overlay types (ask/alert/error) are shown in the
    // floating overlay above the input area, not inline in the message list.
    if (
      displayMode === 'seamless' &&
      isSeamlessOverlayMessage(msg, lastMessageId)
    ) {
      return
    }

    const kind = getRowDisplayKind(session, messageId, lastMessageId)
    if (kind === 'hidden') return

    visibleRows.push({
      id: messageId,
      kind,
      msg,
    })
  })

  const items: ChatRenderItem[] = []
  // A branch clones every message up to its target, while command completion
  // events remain scoped to the source session. Keep all later branch/copy
  // controls hidden whenever their cloned prefix would contain live state.
  let hasUnsettledMessageInPrefix = false
  let visibleIndex = 0
  while (visibleIndex < visibleRows.length) {
    const row = visibleRows[visibleIndex]
    if (row.kind !== 'assistant') {
      items.push({
        id: row.id,
        kind: row.kind,
        estimatedHeight: estimateRowHeight(row.msg, row.kind),
        mergeWithPreviousAssistant: false,
        showAssistantRoleLabel: false,
        showAssistantGroupCopy: false,
        assistantGroupMessageIds: [],
        assistantGroupBranchMessageId: null,
      })
      visibleIndex += 1
      continue
    }

    // In seamless mode, group consecutive tool-call messages into one render item
    if (displayMode === 'seamless' && SEAMLESS_TOOL_TYPES.has(row.msg.type)) {
      const groupFirstId = row.id
      const seamlessGroupMessageIds: string[] = [row.id]
      const seamlessGroupMessages: ChatMessage[] = [row.msg]
      let isGroupStreaming = isSeamlessGroupRunning([row.msg])

      while (
        visibleIndex + 1 < visibleRows.length &&
        visibleRows[visibleIndex + 1].kind === 'assistant' &&
        SEAMLESS_TOOL_TYPES.has(visibleRows[visibleIndex + 1].msg.type)
      ) {
        visibleIndex += 1
        const nextRow = visibleRows[visibleIndex]
        seamlessGroupMessageIds.push(nextRow.id)
        seamlessGroupMessages.push(nextRow.msg)
        if (isSeamlessGroupRunning([nextRow.msg])) isGroupStreaming = true
      }
      hasUnsettledMessageInPrefix ||= isGroupStreaming

      // Merge if this is not the first assistant item in the turn.
      const prevIsAssistant =
        items.length > 0 && items[items.length - 1].kind === 'assistant'
      const turnAlreadyHasLabel = hasAssistantItemInCurrentTurn(items)

      // When this grouped tool activity is the tail of an assistant turn
      // (followed by a user row, or the end of a settled session), it owns the
      // copy/branch controls for the turn — mirroring a trailing text run.
      // Otherwise the controls would vanish whenever a turn ends on a tool call.
      const groupTailRow = visibleRows[visibleIndex]
      const nextVisibleRow = findNextNonBoundaryVisibleRow(
        visibleRows,
        visibleIndex + 1,
      )
      const nextVisibleKind = nextVisibleRow?.kind ?? null
      const isTurnTail =
        !hasUnsettledMessageInPrefix &&
        (nextVisibleKind === 'user' || (!nextVisibleRow && !isThinking))

      items.push({
        id: groupFirstId,
        kind: 'assistant',
        // Restored group state can outlive measured heights across session
        // switches, so estimate the compact first disclosure level until the
        // ResizeObserver reports its real size.
        estimatedHeight: expandedSeamlessGroupIds.has(groupFirstId)
          ? estimateExpandedSeamlessGroupHeight(seamlessGroupMessages)
          : SEAMLESS_COLLAPSED_ESTIMATED_HEIGHT,
        mergeWithPreviousAssistant: prevIsAssistant,
        showAssistantRoleLabel: !turnAlreadyHasLabel,
        showAssistantGroupCopy: isTurnTail,
        assistantGroupMessageIds: isTurnTail
          ? [...seamlessGroupMessageIds]
          : [],
        assistantGroupBranchMessageId: isTurnTail
          ? (groupTailRow?.id ?? null)
          : null,
        seamlessGroupMessageIds,
        seamlessGroupStreaming: isGroupStreaming,
      })

      visibleIndex += 1
      continue
    }

    const runStart = visibleIndex
    const assistantGroupMessageIds: string[] = [row.id]
    while (
      visibleIndex + 1 < visibleRows.length &&
      visibleRows[visibleIndex + 1].kind === 'assistant' &&
      // In seamless mode, don't extend a run into tool types (they're grouped separately)
      !(
        displayMode === 'seamless' &&
        SEAMLESS_TOOL_TYPES.has(visibleRows[visibleIndex + 1].msg.type)
      )
    ) {
      visibleIndex += 1
      assistantGroupMessageIds.push(visibleRows[visibleIndex].id)
    }

    const runEnd = visibleIndex
    const nextVisibleRow = findNextNonBoundaryVisibleRow(
      visibleRows,
      runEnd + 1,
    )
    const nextVisibleKind = nextVisibleRow?.kind ?? null
    const runMessages = visibleRows
      .slice(runStart, runEnd + 1)
      .map((entry) => entry.msg)
    hasUnsettledMessageInPrefix ||=
      isSeamlessGroupRunning(runMessages)
    const canShowGroupCopy =
      runMessages.length > 0 &&
      !hasUnsettledMessageInPrefix &&
      (nextVisibleKind === 'user' || (!nextVisibleRow && !isThinking))
    const branchTargetMessageId = visibleRows[runEnd]?.id ?? null

    let turnAlreadyHasLabel = hasAssistantItemInCurrentTurn(items)
    for (let index = runStart; index <= runEnd; index += 1) {
      const assistantRow = visibleRows[index]
      const prevIsAssistant =
        items.length > 0 && items[items.length - 1].kind === 'assistant'
      const showAssistantRoleLabel = !turnAlreadyHasLabel
      if (showAssistantRoleLabel) turnAlreadyHasLabel = true

      items.push({
        id: assistantRow.id,
        kind: assistantRow.kind,
        estimatedHeight: estimateRowHeight(assistantRow.msg, assistantRow.kind),
        mergeWithPreviousAssistant: prevIsAssistant,
        showAssistantRoleLabel,
        showAssistantGroupCopy: canShowGroupCopy && index === runEnd,
        assistantGroupMessageIds:
          canShowGroupCopy && index === runEnd ? assistantGroupMessageIds : [],
        assistantGroupBranchMessageId:
          canShowGroupCopy && index === runEnd ? branchTargetMessageId : null,
      })
    }

    visibleIndex += 1
  }

  return items
}
