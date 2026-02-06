// ============ Settings Types ============
export type AppLanguage = 'en' | 'zh-CN'

export interface ModelDefinition {
  /** Stable id used by profiles */
  id: string
  /** Display name */
  name: string
  /** Provider model name, e.g. "gpt-4o" */
  model: string
  /** Optional override for API Key */
  apiKey?: string
  /** Optional override for Base URL */
  baseUrl?: string
  /** Max tokens for context management */
  maxTokens: number
  /** Cached capability profile detected by backend */
  profile?: {
    imageInputs?: boolean
    testedAt?: number
    ok?: boolean
    error?: string
  }
}

export interface ModelProfile {
  id: string
  name: string
  /**
   * Current app only uses one model (global).
   * We keep this structure to support multi-model agents in the future.
   */
  globalModelId: string
  // reserved for future:
  actionModelId?: string
  thinkingModelId?: string
}

export interface SSHConnectionEntry {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  // Credentials stored locally (future: keychain integration)
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  // optional proxy/tunnel refs (future)
  proxyId?: string
  tunnelIds?: string[]
}

export interface ProxyEntry {
  id: string
  name: string
  type: 'socks5' | 'http'
  host: string
  port: number
  username?: string
  password?: string
}

export enum PortForwardType {
  Local = 'Local',
  Remote = 'Remote',
  Dynamic = 'Dynamic',
}

export interface TunnelEntry {
  id: string
  name: string
  /** Type of port forwarding */
  type: PortForwardType
  /** Listen address on the forwarding side */
  host: string
  /** Listen port on the forwarding side */
  port: number
  /** Target address (not used for dynamic forwarding) */
  targetAddress?: string
  /** Target port (not used for dynamic forwarding) */
  targetPort?: number
  /** Which ssh connection provides the tunnel */
  viaConnectionId?: string
}

export interface AppSettings {
  /** Settings schema version, used for migrations */
  schemaVersion: 2

  /** UI language */
  language: AppLanguage

  /** Theme id (must be from built-in list) */
  themeId: string

  /** Command policy mode */
  commandPolicyMode: 'safe' | 'standard' | 'smart'

  /**
   * Effective model config for current AgentService (legacy + runtime binding).
   * Kept for compatibility with existing code until AgentService supports multi-model profiles.
   */
  model: string
  baseUrl: string
  apiKey: string

  /** Model registry + profile selection */
  models: {
    items: ModelDefinition[]
    profiles: ModelProfile[]
    activeProfileId: string
  }

  /** Saved connections (local is implicit, ssh is persisted) */
  connections: {
    ssh: SSHConnectionEntry[]
    proxies: ProxyEntry[]
    tunnels: TunnelEntry[]
  }

  /** Tools enablement (built-in only; MCP is managed separately) */
  tools: {
    builtIn: Record<string, boolean>
  }

  /** Terminal visual settings */
  terminal: {
    fontSize: number
    lineHeight: number
    scrollback: number
    cursorStyle: 'block' | 'underline' | 'bar'
    cursorBlink: boolean
    copyOnSelect: boolean
    rightClickToPaste: boolean
  }

  /** Layout persistence */
  layout?: {
    window?: {
      width: number
      height: number
      x?: number
      y?: number
    }
    panelSizes?: number[]
    panelOrder?: string[] // e.g. ['chat', 'terminal']
  }
  /** Agent recursion limit */
  recursionLimit?: number
}

// ============ Terminal Types ============
export type ConnectionType = 'local' | 'ssh'

export interface BaseConnectionConfig {
  type: ConnectionType
  id: string
  /** Display name for UI/agent/system prompts (required, no legacy fallback) */
  title: string
  cols: number
  rows: number
}

export interface LocalConnectionConfig extends BaseConnectionConfig {
  type: 'local'
  cwd?: string
  shell?: string
}

export interface SSHConnectionConfig extends BaseConnectionConfig {
  type: 'ssh'
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  /** Optional proxy configuration for SSH connection */
  proxy?: ProxyEntry
  /** Port forwarding rules to activate for this SSH session */
  tunnels?: TunnelEntry[]
}

export type TerminalConfig = LocalConnectionConfig | SSHConnectionConfig

export interface TerminalTab {
  id: string
  ptyId: string
  title: string
  cols: number
  rows: number
  type: ConnectionType
  isInitializing?: boolean // Silence mode flag
  remoteOs?: 'unix' | 'windows'
  systemInfo?: TerminalSystemInfo
}

export interface TerminalSystemInfo {
  os: string // e.g. "darwin", "linux", "win32", "ubuntu", "centos"
  platform: string // e.g. "darwin", "linux", "win32"
  release: string // version
  arch: string
  hostname: string
  isRemote: boolean
  shell?: string
}

export interface CommandResult {
  stdoutDelta: string
  exitCode?: number
  history_command_match_id: string
}

export interface CommandTask {
  id: string
  command: string
  type: 'wait' | 'nowait'
  status: 'running' | 'finished' | 'aborted' | 'timeout'
  startOffset: number
  endOffset?: number
  exitCode?: number
  output?: string
  startTime: number
  endTime?: number
  startAbsLine?: number
}

export interface FileStatInfo {
  exists: boolean
  isDirectory: boolean
}

// ============ Agent Types ============
export type AgentActionType = 'say' | 'command' | 'done'

export interface AgentAction {
  type: AgentActionType
  content?: string
  command?: string
  summary?: string
}

import { StoredMessage } from '@langchain/core/messages'

export interface ChatSession {
  id: string
  title: string
  boundTerminalTabId: string
  messages: Map<string, StoredMessage>
  lastCheckpointOffset: number
}

// ============ Agent Events (Main → Renderer) ============
export type AgentEventType =
  | 'say'
  | 'command_started'
  | 'command_finished'
  | 'command_ask'
  | 'tool_call'
  | 'file_edit'
  | 'file_read' // Added
  | 'sub_tool_started'
  | 'sub_tool_delta'
  | 'sub_tool_finished'
  | 'done'
  | 'alert'
  | 'error'
  | 'debug_history'
  | 'user_input'
  | 'tokens_count'

export interface AgentEvent {
  type: AgentEventType
  messageId?: string
  level?: 'info' | 'warning' | 'error'
  content?: string
  command?: string
  commandId?: string
  tabName?: string
  toolName?: string
  approvalId?: string
  title?: string
  hint?: string
  input?: string
  output?: string
  filePath?: string
  action?: 'created' | 'edited' | 'error'
  diff?: string
  exitCode?: number
  outputDelta?: string
  summary?: string
  message?: string
  history?: any[] // Raw LangChain message history
  modelName?: string
  totalTokens?: number
  maxTokens?: number
}

// ============ Terminal Backend Interface ============
export interface TerminalBackend {
  /**
   * Spawns a connection.
   * @returns The ptyId or session identifier
   */
  spawn(config: TerminalConfig): Promise<string>
  
  /**
   * Write data to the backend (pty/ssh channel).
   */
  write(ptyId: string, data: string): void
  
  /**
   * Resize the terminal session.
   */
  resize(ptyId: string, cols: number, rows: number): void
  
  /**
   * Kill/Disconnect the session.
   */
  kill(ptyId: string): void
  
  /**
   * Subscribe to data events from the backend.
   */
  onData(ptyId: string, callback: (data: string) => void): void
  
  /**
   * Subscribe to exit events.
   */
  onExit(ptyId: string, callback: (code: number) => void): void

  /**
   * Read a file from the backend connection.
   */
  readFile(ptyId: string, filePath: string): Promise<Buffer>

  /**
   * Write a file through the backend connection.
   */
  writeFile(ptyId: string, filePath: string, content: string): Promise<void>

  /**
   * Get current working directory for the session.
   */
  getCwd(ptyId: string): string | undefined

  /**
   * Get the home directory for the session.
   */
  getHomeDir(ptyId: string): Promise<string | undefined>

  /**
   * Get the remote OS type if known.
   */
  getRemoteOs(ptyId: string): 'unix' | 'windows' | undefined

  /**
   * Get detailed system information.
   */
  getSystemInfo(ptyId: string): Promise<TerminalSystemInfo | undefined>

  /**
   * Stat a file through the backend connection.
   */
  statFile(ptyId: string, filePath: string): Promise<FileStatInfo>

  /**
   * Optional: Hook for custom initialization logic (e.g. SSH injection)
   * This might be internal to the implementation but good to have in mind.
   */
}
