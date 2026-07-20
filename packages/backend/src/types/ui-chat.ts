import type { CommandOutputContractV1 } from '@gyshell/shared'
import type { InputImageAttachment } from './index'

export type MessageType =
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

export interface ChatMessage {
  id: string
  backendMessageId?: string
  role: 'user' | 'assistant' | 'system'
  type: MessageType
  content: string
  metadata?: {
    tabName?: string
    commandId?: string
    exitCode?: number
    output?: string
    diff?: string
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
    details?: string
    inputKind?: 'normal' | 'inserted'
    inputImages?: InputImageAttachment[]
    compactionBoundaryTargetBackendMessageId?: string
    compactionBoundaryPreviousBackendMessageId?: string
    compactionBoundarySummaryBackendMessageId?: string
    compactionBoundaryProtectedNormalRounds?: number
  }
  timestamp: number
  streaming?: boolean
}

export interface UIChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
}

export type UIUpdateAction = (
  | { type: 'ADD_MESSAGE'; sessionId: string; message: ChatMessage }
  | {
      type: 'INSERT_MESSAGE'
      sessionId: string
      message: ChatMessage
      anchorMessageId?: string
      anchorBackendMessageId?: string
      placement: 'before' | 'after'
    }
  | { type: 'REMOVE_MESSAGE'; sessionId: string; messageId: string }
  | { type: 'APPEND_CONTENT'; sessionId: string; messageId: string; content: string }
  | { type: 'APPEND_OUTPUT'; sessionId: string; messageId: string; outputDelta: string }
  | { type: 'UPDATE_MESSAGE'; sessionId: string; messageId: string; patch: Partial<ChatMessage> }
  | { type: 'DONE'; sessionId: string }
  | { type: 'SESSION_RENAMED'; sessionId: string; title: string }
  | { type: 'SESSION_PROFILE_LOCKED'; sessionId: string; lockedProfileId: string | null }
  | { type: 'SESSION_READY'; sessionId: string }
  | { type: 'ROLLBACK'; sessionId: string; messageId: string }
) & { uiRevision?: number }
