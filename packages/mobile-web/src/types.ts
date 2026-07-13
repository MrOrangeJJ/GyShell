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

export interface InputImageAttachment {
  attachmentId?: string
  fileName?: string
  mimeType?: string
  sizeBytes?: number
  sha256?: string
  previewDataUrl?: string
  status?: 'ready' | 'missing'
}

export interface UserInputPayload {
  text: string
  images?: InputImageAttachment[]
}

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
    inputImages?: InputImageAttachment[]
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

export interface SkillSummary {
  name: string
  description?: string
  enabled?: boolean
  fileName?: string
  filePath?: string
  baseDir?: string
  scanRoot?: string
  isNested?: boolean
  supportingFiles?: string[]
}

export interface GatewayMemorySnapshot {
  filePath: string
  content: string
}

export type McpServerStatus = 'disabled' | 'connecting' | 'connected' | 'error'

export interface McpServerSummary {
  name: string
  enabled: boolean
  status: McpServerStatus
  error?: string
  toolCount?: number
}

export interface BuiltInToolSummary {
  name: string
  description: string
  enabled: boolean
  experimental?: boolean
}

export interface GatewayTerminalSummary {
  id: string
  title: string
  type: string
  cols?: number
  rows?: number
  runtimeState?: 'initializing' | 'ready' | 'exited'
  lastExitCode?: number
}

export type GatewayProxyType = 'socks5' | 'http'

export interface GatewayProxyEntry {
  id: string
  name: string
  type: GatewayProxyType
  host: string
  port: number
  username?: string
  password?: string
}

export type GatewayPortForwardType = 'Local' | 'Remote' | 'Dynamic'

export interface GatewayTunnelEntry {
  id: string
  name: string
  type: GatewayPortForwardType
  host: string
  port: number
  targetAddress?: string
  targetPort?: number
  viaConnectionId?: string
}

export type GatewaySshAuthMethod = 'password' | 'privateKey'

export interface GatewaySshConnectionEntry {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: GatewaySshAuthMethod
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  proxyId?: string
  tunnelIds?: string[]
  jumpHost?: GatewaySshConnectionEntry
}

export interface GatewayConnectionsSnapshot {
  ssh: GatewaySshConnectionEntry[]
  proxies: GatewayProxyEntry[]
  tunnels: GatewayTunnelEntry[]
}

export interface GatewaySshConnectionSummary {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: GatewaySshAuthMethod
}

export type CreateTerminalTarget = { type: 'local' } | { type: 'ssh'; connectionId: string }

export interface GatewayProfileSummary {
  id: string
  name: string
  globalModelId: string
  modelName?: string
}

export type CommandPolicyMode = 'safe' | 'standard' | 'smart'

export interface CommandPolicyLists {
  allowlist: string[]
  denylist: string[]
  asklist: string[]
}

export interface TerminalBufferSnapshot {
  data: string
  offset: number
}

export type AgentSettingProfileSlot = 1 | 2 | 3 | 4 | 5 | 6

export interface AgentSettingProfileSummary {
  id: string
  slotNumber: AgentSettingProfileSlot
  createdAt: number
  updatedAt: number
  modelName?: string
  modelProfileId?: string
  commandPolicyMode?: CommandPolicyMode
}

export interface AgentSettingStateSummary {
  profiles: AgentSettingProfileSummary[]
  activeProfileId: string | null
}

export interface AgentSettingApplyOutcome {
  applied: boolean
  experimentalToolNames: string[]
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

export type GatewayIncomingEnvelope =
  | RpcSuccessResponse
  | RpcErrorResponse
  | GatewayEventEnvelope
  | GatewayUiUpdateEnvelope
  | GatewayRawEnvelope
