import { parseCommandOutputContractV1 } from '@gyshell/shared'
import type { ChatMessage } from '../types'
import { normalizeDisplayText, trimOuterBlankLines } from '../session-store'

export interface UserTimelineItem {
  kind: 'user'
  id: string
  message: ChatMessage
  branchBlockedByUnsettledCommand: boolean
}

export interface AgentTimelineItem {
  kind: 'agent'
  id: string
  latestMessage: ChatMessage
  detailMessages: ChatMessage[]
  startedAt: number
  streaming: boolean
}

export interface BoundaryTimelineItem {
  kind: 'boundary'
  id: string
  message: ChatMessage
}

export type ChatTimelineItem =
  | UserTimelineItem
  | AgentTimelineItem
  | BoundaryTimelineItem

export interface TokenUsage {
  totalTokens: number
  maxTokens: number
  percent: number | null
}

function hasText(value: string | undefined): boolean {
  return (
    trimOuterBlankLines(normalizeDisplayText(value || '')).trim().length > 0
  )
}

function hasMessagePayload(message: ChatMessage): boolean {
  if (message.type === 'tokens_count') return false
  if (message.type !== 'text') return true
  if (message.streaming) return true
  if (
    Array.isArray(message.metadata?.inputImages) &&
    message.metadata.inputImages.length > 0
  )
    return true
  if (hasText(message.content)) return true
  if (hasText(message.metadata?.output)) return true
  return false
}

function isUnsettledCommand(message: ChatMessage): boolean {
  if (message.type !== 'command') return false
  const commandOutput = parseCommandOutputContractV1(
    message.metadata?.commandOutput,
  )
  return (
    message.streaming === true || commandOutput?.executionState === 'running'
  )
}

export function buildChatTimeline(messages: ChatMessage[]): ChatTimelineItem[] {
  const timeline: ChatTimelineItem[] = []
  let currentAgent: AgentTimelineItem | null = null
  let hasUnsettledCommandInPrefix = false

  for (const message of messages) {
    if (!message || message.type === 'tokens_count') continue
    if (message.type === 'compaction_boundary') {
      timeline.push({
        kind: 'boundary',
        id: message.id,
        message,
      })
      currentAgent = null
      continue
    }
    if (!hasMessagePayload(message)) continue

    if (message.role === 'user') {
      timeline.push({
        kind: 'user',
        id: message.id,
        message,
        branchBlockedByUnsettledCommand: hasUnsettledCommandInPrefix,
      })
      currentAgent = null
      continue
    }

    hasUnsettledCommandInPrefix ||= isUnsettledCommand(message)

    if (!currentAgent) {
      currentAgent = {
        kind: 'agent',
        id: `agent-${message.id}`,
        latestMessage: message,
        detailMessages: [message],
        startedAt: message.timestamp || Date.now(),
        streaming: !!message.streaming,
      }
      timeline.push(currentAgent)
      continue
    }

    currentAgent.detailMessages.push(message)
    currentAgent.latestMessage = message
    currentAgent.streaming = !!message.streaming
  }

  return timeline
}

export function getLatestTokenUsage(messages: ChatMessage[]): TokenUsage {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.type !== 'tokens_count') continue

    const totalTokens = Number(message.metadata?.totalTokens || 0)
    const maxTokens = Number(message.metadata?.maxTokens || 0)
    const percent =
      maxTokens > 0
        ? Math.max(
            0,
            Math.min(100, Math.round((totalTokens / maxTokens) * 100)),
          )
        : null

    return {
      totalTokens,
      maxTokens,
      percent,
    }
  }

  return {
    totalTokens: 0,
    maxTokens: 0,
    percent: null,
  }
}
