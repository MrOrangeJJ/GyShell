import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// Types (duplicated to avoid cross-project imports)
interface AppSettings {
  schemaVersion: 2
  language: 'en' | 'zh-CN'
  themeId: string
  commandPolicyMode: 'safe' | 'standard' | 'smart'
  tools: {
    builtIn: Record<string, boolean>
    skills?: Record<string, boolean>
  }
  models: {
    items: Array<{
      id: string
      name: string
      model: string
      apiKey?: string
      baseUrl?: string
      maxTokens: number
      profile?: {
        imageInputs?: boolean
        testedAt?: number
        ok?: boolean
        error?: string
      }
    }>
    profiles: Array<{ id: string; name: string; globalModelId: string; actionModelId?: string; thinkingModelId?: string }>
    activeProfileId: string
  }
  connections: {
    ssh: Array<{
      id: string
      name: string
      host: string
      port: number
      username: string
      authMethod: 'password' | 'privateKey'
      password?: string
      privateKey?: string
      privateKeyPath?: string
      passphrase?: string
      proxyId?: string
      tunnelIds?: string[]
    }>
    proxies: Array<{
      id: string
      name: string
      type: 'socks5' | 'http'
      host: string
      port: number
      username?: string
      password?: string
    }>
    tunnels: Array<{
      id: string
      name: string
      type: 'Local' | 'Remote' | 'Dynamic'
      host: string
      port: number
      targetAddress?: string
      targetPort?: number
      viaConnectionId?: string
    }>
  }
  model: string
  baseUrl: string
  apiKey: string
  terminal: {
    fontSize: number
    lineHeight: number
    scrollback: number
    cursorStyle: 'block' | 'underline' | 'bar'
    cursorBlink: boolean
    copyOnSelect: boolean
    rightClickToPaste: boolean
  }
  layout?: {
    window?: {
      width: number
      height: number
      x?: number
      y?: number
    }
    panelSizes?: number[]
    panelOrder?: string[]
  }
  recursionLimit?: number
}

interface CommandPolicyLists {
  allowlist: string[]
  denylist: string[]
  asklist: string[]
}

type AgentEventType =
  | 'say'
  | 'command_started'
  | 'command_finished'
  | 'command_ask'
  | 'tool_call'
  | 'file_edit'
  | 'file_read'
  | 'sub_tool_started'
  | 'sub_tool_delta'
  | 'sub_tool_finished'
  | 'done'
  | 'alert'
  | 'error'
  | 'debug_history'
  | 'user_input'
  | 'tokens_count'

interface AgentEvent {
  type: AgentEventType
  inputKind?: 'normal' | 'inserted'
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
  history?: any[]
  modelName?: string
  totalTokens?: number
  maxTokens?: number
}

interface McpToolSummary {
  name: string
  enabled: boolean
  status: 'disabled' | 'connecting' | 'connected' | 'error'
  error?: string
  toolCount?: number
}

interface BuiltInToolSummary {
  name: string
  description?: string
  enabled: boolean
}

interface SkillSummary {
  name: string
  description: string
  fileName: string
  filePath: string
  baseDir: string
  scanRoot: string
  isNested: boolean
}

interface TerminalColorScheme {
  name: string
  foreground: string
  background: string
  cursor: string
  colors: string[]
  selection?: string
  selectionForeground?: string
  cursorAccent?: string
}

interface VersionCheckResult {
  status: 'up-to-date' | 'update-available' | 'error'
  currentVersion: string
  latestVersion?: string
  downloadUrl: string
  releaseNotes?: string
  note: string
  checkedAt: number
  sourceUrl: string
  warning?: string
}

// Connection Config Types
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
  proxy?: AppSettings['connections']['proxies'][number]
  tunnels?: AppSettings['connections']['tunnels'][number][]
}

export type TerminalConfig = LocalConnectionConfig | SSHConnectionConfig

export interface GyShellAPI {
  system: {
    platform: NodeJS.Platform
    openExternal: (url: string) => Promise<void>
    saveTempPaste: (content: string) => Promise<string>
  }
  // Settings
  settings: {
    get: () => Promise<AppSettings>
    set: (settings: Partial<AppSettings>) => Promise<void>
    openCommandPolicyFile: () => Promise<void>
    getCommandPolicyLists: () => Promise<CommandPolicyLists>
    addCommandPolicyRule: (listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => Promise<CommandPolicyLists>
    deleteCommandPolicyRule: (listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => Promise<CommandPolicyLists>
  }

  // Terminal
  terminal: {
    createTab: (config: TerminalConfig) => Promise<{ id: string }>
    write: (terminalId: string, data: string) => Promise<void>
    writePaths: (terminalId: string, paths: string[]) => Promise<void>
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>
    kill: (terminalId: string) => Promise<void>
    setSelection: (terminalId: string, selectionText: string) => Promise<void>
    onData: (callback: (data: { terminalId: string; data: string }) => void) => () => void
    onExit: (callback: (data: { terminalId: string; code: number }) => void) => () => void
  }

  // UI
  ui: {
    showContextMenu: (payload: { id: string; canCopy: boolean; canPaste: boolean }) => Promise<void>
    onContextMenuAction: (callback: (data: { id: string; action: 'copy' | 'paste' }) => void) => () => void
  }

  // Agent
  agent: {
    startTask: (
      sessionId: string,
      terminalId: string,
      userText: string,
      options?: { startMode?: 'normal' | 'inserted' }
    ) => Promise<void>
    stopTask: (sessionId: string) => Promise<void>
    getAllChatHistory: () => Promise<any[]>
    loadChatSession: (sessionId: string) => Promise<any>
    getUiMessages: (sessionId: string) => Promise<any[]>
    deleteChatSession: (sessionId: string) => Promise<void>
    rollbackToMessage: (sessionId: string, messageId: string) => Promise<{ ok: boolean; removedCount: number }>
    replyMessage: (messageId: string, payload: any) => Promise<{ ok: boolean }>
    onEvent: (
      callback: (data: { sessionId: string; event: AgentEvent }) => void
    ) => () => void
    onUiUpdate: (
      callback: (action: any) => void
    ) => () => void
    exportHistory: (sessionId: string, frontendSession?: any) => Promise<void>
    renameSession: (sessionId: string, newTitle: string) => Promise<void>
    replyCommandApproval: (approvalId: string, decision: 'allow' | 'deny') => Promise<void>
  }

  // Models
  models: {
    probe: (model: AppSettings['models']['items'][number]) => Promise<{
      imageInputs: boolean
      testedAt: number
      ok: boolean
      error?: string
    }>
  }

  // Tools
  tools: {
    openMcpConfig: () => Promise<void>
    reloadMcp: () => Promise<McpToolSummary[]>
    getMcp: () => Promise<McpToolSummary[]>
    setMcpEnabled: (name: string, enabled: boolean) => Promise<McpToolSummary[]>
    getBuiltIn: () => Promise<BuiltInToolSummary[]>
    setBuiltInEnabled: (name: string, enabled: boolean) => Promise<BuiltInToolSummary[]>
    onMcpUpdated: (callback: (data: McpToolSummary[]) => void) => () => void
  }

  themes: {
    openCustomConfig: () => Promise<void>
    reloadCustom: () => Promise<TerminalColorScheme[]>
    getCustom: () => Promise<TerminalColorScheme[]>
  }

  skills: {
    openFolder: () => Promise<void>
    reload: () => Promise<SkillSummary[]>
    getAll: () => Promise<SkillSummary[]>
    create: () => Promise<SkillSummary>
    openFile: (fileName: string) => Promise<void>
    delete: (fileName: string) => Promise<SkillSummary[]>
    setEnabled: (name: string, enabled: boolean) => Promise<SkillSummary[]>
    onUpdated: (callback: (data: SkillSummary[]) => void) => () => void
  }

  version: {
    getState: () => Promise<VersionCheckResult>
    check: () => Promise<VersionCheckResult>
  }
}

const api: GyShellAPI = {
  system: {
    platform: process.platform,
    openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
    saveTempPaste: (content: string) => ipcRenderer.invoke('system:saveTempPaste', content)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
    openCommandPolicyFile: () => ipcRenderer.invoke('settings:openCommandPolicyFile'),
    getCommandPolicyLists: () => ipcRenderer.invoke('settings:getCommandPolicyLists'),
    addCommandPolicyRule: (listName, rule) => ipcRenderer.invoke('settings:addCommandPolicyRule', listName, rule),
    deleteCommandPolicyRule: (listName, rule) => ipcRenderer.invoke('settings:deleteCommandPolicyRule', listName, rule)
  },

  terminal: {
    createTab: (config) => ipcRenderer.invoke('terminal:createTab', config),
    write: (terminalId, data) => ipcRenderer.invoke('terminal:write', terminalId, data),
    writePaths: (terminalId, paths) => ipcRenderer.invoke('terminal:writePaths', terminalId, paths),
    resize: (terminalId, cols, rows) =>
      ipcRenderer.invoke('terminal:resize', terminalId, cols, rows),
    kill: (terminalId) => ipcRenderer.invoke('terminal:kill', terminalId),
    setSelection: (terminalId, selectionText) =>
      ipcRenderer.invoke('terminal:setSelection', terminalId, selectionText),
    onData: (callback) => {
      const handler = (_: IpcRendererEvent, data: { terminalId: string; data: string }) =>
        callback(data)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.off('terminal:data', handler)
    },
    onExit: (callback) => {
      const handler = (_: IpcRendererEvent, data: { terminalId: string; code: number }) =>
        callback(data)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.off('terminal:exit', handler)
    }
  },

  ui: {
    showContextMenu: (payload) => ipcRenderer.invoke('ui:showContextMenu', payload),
    onContextMenuAction: (callback) => {
      const handler = (_: IpcRendererEvent, data: { id: string; action: 'copy' | 'paste' }) =>
        callback(data)
      ipcRenderer.on('ui:contextMenuAction', handler)
      return () => ipcRenderer.off('ui:contextMenuAction', handler)
    }
  },

  agent: {
    startTask: (sessionId, terminalId, userText, options) =>
      ipcRenderer.invoke('agent:startTask', sessionId, terminalId, userText, options),
    stopTask: (sessionId) => ipcRenderer.invoke('agent:stopTask', sessionId),
    getAllChatHistory: () => ipcRenderer.invoke('agent:getAllChatHistory'),
    loadChatSession: (sessionId) => ipcRenderer.invoke('agent:loadChatSession', sessionId),
    getUiMessages: (sessionId) => ipcRenderer.invoke('agent:getUiMessages', sessionId),
    deleteChatSession: (sessionId) => ipcRenderer.invoke('agent:deleteChatSession', sessionId),
    rollbackToMessage: (sessionId, messageId) =>
      ipcRenderer.invoke('agent:rollbackToMessage', sessionId, messageId),
    replyMessage: (messageId, payload) =>
      ipcRenderer.invoke('agent:replyMessage', messageId, payload),
    onEvent: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        data: { sessionId: string; event: AgentEvent }
      ) => callback(data)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.off('agent:event', handler)
    },
    onUiUpdate: (callback) => {
      const handler = (_: IpcRendererEvent, action: any) => callback(action)
      ipcRenderer.on('agent:ui-update', handler)
      return () => ipcRenderer.off('agent:ui-update', handler)
    },
    exportHistory: (sessionId, frontendSession?) => ipcRenderer.invoke('agent:exportHistory', sessionId, frontendSession),
    renameSession: (sessionId, newTitle) => ipcRenderer.invoke('agent:renameSession', sessionId, newTitle),
    replyCommandApproval: (approvalId, decision) =>
      ipcRenderer.invoke('agent:replyCommandApproval', approvalId, decision)
  },
  models: {
    probe: (model) => ipcRenderer.invoke('models:probe', model)
  },
  tools: {
    openMcpConfig: () => ipcRenderer.invoke('tools:openMcpConfig'),
    reloadMcp: () => ipcRenderer.invoke('tools:reloadMcp'),
    getMcp: () => ipcRenderer.invoke('tools:getMcp'),
    setMcpEnabled: (name, enabled) => ipcRenderer.invoke('tools:setMcpEnabled', name, enabled),
    getBuiltIn: () => ipcRenderer.invoke('tools:getBuiltIn'),
    setBuiltInEnabled: (name, enabled) => ipcRenderer.invoke('tools:setBuiltInEnabled', name, enabled),
    onMcpUpdated: (callback) => {
      const handler = (_: IpcRendererEvent, data: McpToolSummary[]) => callback(data)
      ipcRenderer.on('tools:mcpUpdated', handler)
      return () => ipcRenderer.off('tools:mcpUpdated', handler)
    }
  },
  themes: {
    openCustomConfig: () => ipcRenderer.invoke('themes:openCustomConfig'),
    reloadCustom: () => ipcRenderer.invoke('themes:reloadCustom'),
    getCustom: () => ipcRenderer.invoke('themes:getCustom')
  },
  skills: {
    openFolder: () => ipcRenderer.invoke('skills:openFolder'),
    reload: () => ipcRenderer.invoke('skills:reload'),
    getAll: () => ipcRenderer.invoke('skills:getAll'),
    create: () => ipcRenderer.invoke('skills:create'),
    openFile: (fileName) => ipcRenderer.invoke('skills:openFile', fileName),
    delete: (fileName) => ipcRenderer.invoke('skills:delete', fileName),
    setEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', name, enabled),
    onUpdated: (callback: (data: SkillSummary[]) => void) => {
      const handler = (_: IpcRendererEvent, data: SkillSummary[]) => callback(data)
      ipcRenderer.on('skills:updated', handler)
      return () => ipcRenderer.off('skills:updated', handler)
    }
  },
  version: {
    getState: () => ipcRenderer.invoke('version:getState'),
    check: () => ipcRenderer.invoke('version:check')
  }
}

contextBridge.exposeInMainWorld('gyshell', api)
