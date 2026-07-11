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
    compactionBoundaryTargetBackendMessageId?: string
    compactionBoundaryPreviousBackendMessageId?: string
    compactionBoundarySummaryBackendMessageId?: string
    compactionBoundaryProtectedNormalRounds?: number
  }
  timestamp: number
  streaming?: boolean
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

export interface GatewayEvent {
  id: string
  timestamp: number
  type: 'agent:event' | 'session:update' | 'ui:action' | 'system:notification'
  sessionId?: string
  payload: unknown
}

export interface RpcRequest {
  id?: string
  method: string
  params?: Record<string, unknown>
}

export interface RpcSuccessResponse {
  type: 'gateway:response'
  id: string
  ok: true
  result: unknown
}

export interface RpcErrorResponse {
  type: 'gateway:response'
  id: string
  ok: false
  error: {
    code: string
    message: string
  }
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

export interface GatewayEventEnvelope {
  type: 'gateway:event'
  payload: GatewayEvent
}

export interface GatewayUiUpdateEnvelope {
  type: 'gateway:ui-update'
  payload: UIUpdateAction
}

export interface GatewayRawEnvelope {
  type: 'gateway:raw'
  channel: string
  payload: unknown
}

export type GatewayIncomingEnvelope = RpcResponse | GatewayEventEnvelope | GatewayUiUpdateEnvelope | GatewayRawEnvelope

export interface GatewayTerminalSummary {
  id: string
  title: string
  type: string
}

export interface GatewayProfileSummary {
  id: string
  name: string
  globalModelId: string
  modelName?: string
}

export interface GatewayProfilesPayload {
  activeProfileId: string
  profiles: GatewayProfileSummary[]
}

export interface SkillSummary {
  name: string
  description?: string
  enabled?: boolean
}

export interface GatewaySessionSummary {
  id: string
  title: string
  updatedAt: number
  messagesCount: number
  lastMessagePreview?: string
  isBusy: boolean
  lockedProfileId: string | null
  uiRevision?: number
}

export interface GatewaySessionSnapshot {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
  isBusy: boolean
  lockedProfileId: string | null
  uiRevision?: number
}
