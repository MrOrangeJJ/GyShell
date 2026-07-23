import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";

// Types (duplicated to avoid cross-project imports)
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface BackendSettings {
  schemaVersion: 5;
  commandPolicyMode: "safe" | "standard" | "smart";
  memory?: {
    enabled: boolean;
  };
  agentSettings?: AgentSettingState;
  tools: {
    builtIn: Record<string, boolean>;
    skills?: Record<string, boolean>;
  };
  models: {
    items: Array<{
      id: string;
      name: string;
      model: string;
      apiKey?: string;
      baseUrl?: string;
      maxTokens: number;
      requestParameters?: Record<string, JsonValue>;
      structuredOutputMode?: "auto" | "on" | "off";
      supportsStructuredOutput: boolean;
      supportsObjectToolChoice: boolean;
      profile?: {
        imageInputs?: boolean;
        textOutputs?: boolean;
        supportsStructuredOutput?: boolean;
        supportsObjectToolChoice?: boolean;
        testedAt?: number;
        ok?: boolean;
        error?: string;
      };
    }>;
    profiles: Array<{
      id: string;
      name: string;
      globalModelId: string;
      actionModelId?: string;
      thinkingModelId?: string;
      compactionModelId?: string;
    }>;
    activeProfileId: string;
  };
  connections: {
    ssh: Array<{
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      authMethod: "password" | "privateKey";
      password?: string;
      privateKey?: string;
      privateKeyPath?: string;
      passphrase?: string;
      proxyId?: string;
      tunnelIds?: string[];
    }>;
    proxies: Array<{
      id: string;
      name: string;
      type: "socks5" | "http";
      host: string;
      port: number;
      username?: string;
      password?: string;
    }>;
    tunnels: Array<{
      id: string;
      name: string;
      type: "Local" | "Remote" | "Dynamic";
      host: string;
      port: number;
      targetAddress?: string;
      targetPort?: number;
      viaConnectionId?: string;
    }>;
  };
  model: string;
  baseUrl: string;
  apiKey: string;
  layout?: {
    window?: {
      width: number;
      height: number;
      x?: number;
      y?: number;
    };
    panelSizes?: number[];
    panelOrder?: string[];
    v2?: unknown;
    savedLayouts?: unknown;
    activeSavedLayoutId?: string | null;
  };
  recursionLimit?: number;
  debugMode?: boolean;
  experimental?: {
    runtimeThinkingCorrectionEnabled: boolean;
    taskFinishGuardEnabled: boolean;
    firstTurnThinkingModelEnabled: boolean;
    execCommandActionModelEnabled: boolean;
    writeStdinActionModelEnabled: boolean;
  };
  gateway: {
    ws: {
      access: "disabled" | "localhost" | "internet" | "lan" | "custom";
      port: number;
      allowedCidrs?: string[];
    };
    mobileWeb?: {
      port: number | null;
    };
  };
}

interface UiSettings {
  uiSchemaVersion: 1;
  language: "en" | "zh-CN";
  themeId: string;
  terminal: {
    fontSize: number;
    lineHeight: number;
    scrollback: number;
    cursorStyle: "block" | "underline" | "bar";
    cursorBlink: boolean;
    copyOnSelect: boolean;
    rightClickToPaste: boolean;
    commandDraftShortcut: string;
  };
  panelTabs: {
    displayMode: "auto" | "expanded" | "select";
  };
  commandDraft: {
    profileId: string;
  };
  chat: {
    displayMode: "classic" | "seamless";
  };
  runtime?: {
    preventSleepWhileRunning?: boolean;
  };
  monitorEnabledSources?: string[];
}

type TerminalRecoveryReason =
  | "resume"
  | "unlock-screen"
  | "display-metrics-changed";

type AppSettings = BackendSettings & UiSettings;

type SyncSettingsPatch = {
  layout: NonNullable<BackendSettings["layout"]>;
};

interface CommandPolicyLists {
  allowlist: string[];
  denylist: string[];
  asklist: string[];
}

type AgentSettingSlotNumber = 1 | 2 | 3 | 4 | 5;

interface AgentSettingSnapshot {
  version: 1;
  security: {
    commandPolicyMode: BackendSettings["commandPolicyMode"];
    commandPolicyLists: CommandPolicyLists;
  };
  tools: {
    builtIn: Record<string, boolean>;
    mcp: Record<string, boolean>;
  };
  skills: Record<string, boolean>;
  memory: {
    enabled: boolean;
  };
  workflow: {
    recursionLimit: number;
    experimental: NonNullable<BackendSettings["experimental"]>;
  };
  model: {
    activeProfileId: string;
    activeProfileName?: string;
  };
}

interface AgentSettingProfile {
  id: string;
  slotNumber: AgentSettingSlotNumber;
  createdAt: number;
  updatedAt: number;
  snapshot: AgentSettingSnapshot;
}

interface AgentSettingState {
  profiles: AgentSettingProfile[];
  activeProfileId: string | null;
}

type AgentEventType =
  | "say"
  | "remove_message"
  | "command_started"
  | "command_finished"
  | "command_ask"
  | "tool_call"
  | "file_edit"
  | "file_read"
  | "sub_tool_started"
  | "sub_tool_delta"
  | "sub_tool_finished"
  | "done"
  | "alert"
  | "error"
  | "debug_history"
  | "user_input"
  | "tokens_count";

interface AgentEvent {
  type: AgentEventType;
  inputKind?: "normal" | "inserted";
  inputImages?: InputImageAttachment[];
  level?: "info" | "warning" | "error";
  content?: string;
  command?: string;
  commandId?: string;
  tabName?: string;
  toolName?: string;
  approvalId?: string;
  title?: string;
  hint?: string;
  input?: string;
  output?: string;
  filePath?: string;
  action?: "created" | "edited" | "error";
  diff?: string;
  exitCode?: number;
  outputDelta?: string;
  summary?: string;
  message?: string;
  details?: string;
  history?: any[];
  modelName?: string;
  totalTokens?: number;
  maxTokens?: number;
}

interface InputImageAttachment {
  attachmentId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  previewDataUrl?: string;
  status?: "ready" | "missing";
}

interface UserInputPayload {
  text: string;
  images?: InputImageAttachment[];
}

interface SaveImageAttachmentPayload {
  dataBase64: string;
  fileName?: string;
  mimeType?: string;
  previewDataUrl?: string;
}

interface McpToolSummary {
  name: string;
  enabled: boolean;
  status: "disabled" | "connecting" | "connected" | "error";
  error?: string;
  toolCount?: number;
}

interface BuiltInToolSummary {
  name: string;
  description: string;
  enabled: boolean;
  experimental?: boolean;
}

interface SkillSummary {
  name: string;
  description: string;
  fileName: string;
  filePath: string;
  baseDir: string;
  scanRoot: string;
  isNested: boolean;
}

interface SkillStatusSummary {
  name: string;
  description?: string;
  enabled: boolean;
}

interface MemorySnapshot {
  filePath: string;
  content: string;
}

interface AgentSettingOperationResult {
  settings: BackendSettings;
  agentSettings: AgentSettingState;
  commandPolicyLists: CommandPolicyLists;
  mcpTools: McpToolSummary[];
  builtInTools: BuiltInToolSummary[];
  skills: SkillStatusSummary[];
  memory: MemorySnapshot;
  warnings: string[];
}

interface ExperimentalToolConfirmationRequired {
  kind: "experimental_tool_confirmation_required";
  experimentalToolNames: string[];
}

type AgentSettingApplyResult =
  | AgentSettingOperationResult
  | ExperimentalToolConfirmationRequired;

interface AccessTokenSummary {
  id: string;
  name: string;
  createdAt: number;
}

interface CreateAccessTokenResult extends AccessTokenSummary {
  token: string;
}

interface TerminalColorScheme {
  name: string;
  foreground: string;
  background: string;
  cursor: string;
  colors: string[];
  selection?: string;
  selectionForeground?: string;
  cursorAccent?: string;
}

interface VersionCheckResult {
  status: "up-to-date" | "update-available" | "error";
  currentVersion: string;
  latestVersion?: string;
  downloadUrl: string;
  releaseNotes?: string;
  checkedAt: number;
  sourceUrl: string;
  warning?: string;
}

interface HistoryMigrationState {
  status: "idle" | "running" | "done" | "error";
  ready: boolean;
  active: boolean;
  blocking: boolean;
  detectedLegacy: boolean;
  phase:
    | "idle"
    | "detecting"
    | "reading"
    | "migrating-backend"
    | "migrating-ui"
    | "finalizing"
    | "done"
    | "error";
  title: string;
  message: string;
  completedUnits: number;
  totalUnits: number;
  percent: number;
  error?: string;
}

interface TerminalSystemInfo {
  os: string;
  platform: string;
  release: string;
  arch: string;
  hostname: string;
  isRemote: boolean;
  shell?: string;
}

interface TerminalRenderMetadata {
  remoteOs?: "unix" | "windows";
  windowsRelease?: string;
}

interface TerminalSummary {
  id: string;
  title: string;
  type: ConnectionType;
  cols: number;
  rows: number;
  runtimeState?: "initializing" | "ready" | "exited";
  lastExitCode?: number;
  remoteOs?: "unix" | "windows";
  systemInfo?: TerminalSystemInfo;
  monitorIdentity?: string;
}

// Connection Config Types
export type ConnectionType = "local" | "ssh";

export interface BaseConnectionConfig {
  type: ConnectionType;
  id: string;
  /** Display name for UI/agent/system prompts (required, no legacy fallback) */
  title: string;
  cols: number;
  rows: number;
}

export interface LocalConnectionConfig extends BaseConnectionConfig {
  type: "local";
  cwd?: string;
  shell?: string;
}

export interface SSHConnectionConfig extends BaseConnectionConfig {
  type: "ssh";
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  proxy?: AppSettings["connections"]["proxies"][number];
  tunnels?: AppSettings["connections"]["tunnels"][number][];
}

export type TerminalConfig = LocalConnectionConfig | SSHConnectionConfig;

export interface FileSystemEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode?: string;
  modifiedAt?: string;
}

export interface FileSystemListResult {
  path: string;
  entries: FileSystemEntry[];
}

export interface ReadTextFileResult {
  path: string;
  content: string;
  size: number;
  encoding: "utf8";
}

export interface ReadBase64FileResult {
  path: string;
  contentBase64: string;
  size: number;
  mimeType: string;
}

export interface FileTransferTaskSnapshot {
  id: string;
  origin: "user" | "agent";
  mode: "copy" | "move";
  sourceTerminalId: string;
  sourceTerminalName: string;
  sourceMachineIdentity: string | null;
  sourcePaths: string[];
  targetTerminalId: string;
  targetTerminalName: string;
  targetMachineIdentity: string | null;
  targetDirPath: string;
  itemNames: string[];
  conflictStrategy: "error" | "overwrite" | "rename";
  status: "queued" | "scanning" | "running" | "success" | "error" | "cancelled";
  bytesDone: number;
  totalBytes: number;
  transferredFiles: number;
  totalFiles: number;
  percent: number;
  message: string | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  agentRunId?: string;
  toolMessageId?: string;
}

export interface GyShellAPI {
  system: {
    platform: NodeJS.Platform;
    openExternal: (url: string) => Promise<void>;
    saveImageAttachment: (
      payload: SaveImageAttachmentPayload,
    ) => Promise<InputImageAttachment>;
    getPathForFile: (file: File) => string;
    startFileDrag: (filePaths: string[]) => void;
  };
  gateway: {
    isSameMachine: () => Promise<{ sameMachine: boolean }>;
  };
  historyMigration: {
    getState: () => Promise<HistoryMigrationState>;
    waitUntilSettled: () => Promise<HistoryMigrationState>;
    onStateChanged: (
      callback: (state: HistoryMigrationState) => void,
    ) => () => void;
  };
  windowing: {
    openDetached: (
      detachedStateToken: string,
      sourceClientId: string,
    ) => Promise<{ ok: boolean }>;
    onMainWindowClosing: (callback: () => void) => () => void;
  };
  // Settings
  settings: {
    get: () => Promise<BackendSettings>;
    set: (settings: Partial<BackendSettings>) => Promise<void>;
    setSync: (settings: SyncSettingsPatch) => void;
    setWsGatewayAccess: (
      access: BackendSettings["gateway"]["ws"]["access"],
    ) => Promise<BackendSettings["gateway"]["ws"]>;
    setWsGatewayConfig: (
      ws: BackendSettings["gateway"]["ws"],
    ) => Promise<BackendSettings["gateway"]["ws"]>;
    openCommandPolicyFile: () => Promise<void>;
    getCommandPolicyLists: () => Promise<CommandPolicyLists>;
    onUpdated: (callback: (settings: BackendSettings) => void) => () => void;
    onCommandPolicyListsUpdated: (
      callback: (lists: CommandPolicyLists) => void,
    ) => () => void;
    addCommandPolicyRule: (
      listName: "allowlist" | "denylist" | "asklist",
      rule: string,
    ) => Promise<CommandPolicyLists>;
    deleteCommandPolicyRule: (
      listName: "allowlist" | "denylist" | "asklist",
      rule: string,
    ) => Promise<CommandPolicyLists>;
  };

  accessTokens: {
    list: () => Promise<AccessTokenSummary[]>;
    create: (name: string) => Promise<CreateAccessTokenResult>;
    delete: (id: string) => Promise<boolean>;
  };

  uiSettings: {
    get: () => Promise<UiSettings>;
    set: (settings: Partial<UiSettings>) => Promise<void>;
  };

  // Terminal
  terminal: {
    list: () => Promise<{
      terminals: TerminalSummary[];
    }>;
    createTab: (config: TerminalConfig) => Promise<{ id: string }>;
    reconnect: (terminalId: string) => Promise<{ id: string }>;
    write: (terminalId: string, data: string) => Promise<void>;
    writePaths: (terminalId: string, paths: string[]) => Promise<void>;
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
    kill: (terminalId: string) => Promise<void>;
    setSelection: (terminalId: string, selectionText: string) => Promise<void>;
    getBufferDelta: (
      terminalId: string,
      fromOffset: number,
    ) => Promise<{
      data: string;
      offset: number;
      remoteOs?: "unix" | "windows";
      windowsRelease?: string;
    }>;
    attachOutputConsumer: (
      terminalId: string,
      consumerId: string,
    ) => Promise<{
      runtimeGeneration?: number;
      data: string;
      offset: number;
      remoteOs?: "unix" | "windows";
      windowsRelease?: string;
    }>;
    detachOutputConsumer: (terminalId: string, consumerId: string) => void;
    acknowledgeOutput: (
      terminalId: string,
      consumerId: string,
      runtimeGeneration: number,
      outputSequence: number,
    ) => void;
    reportOutputFailure: (
      terminalId: string,
      consumerId: string,
      runtimeGeneration: number,
      errorMessage: string,
    ) => void;
    generateCommandDraft: (
      terminalId: string,
      prompt: string,
      profileId: string,
    ) => Promise<{ command: string }>;
    onData: (
      callback: (data: {
        terminalId: string;
        data: string;
        offset?: number;
        outputSequence?: number;
        runtimeGeneration?: number;
      } & TerminalRenderMetadata) => void,
    ) => () => void;
    onExit: (
      callback: (data: { terminalId: string; code: number }) => void,
    ) => () => void;
    onTabsUpdated: (
      callback: (data: { terminals: TerminalSummary[] }) => void,
    ) => () => void;
    onRecoveryHint: (
      callback: (data: { reason: TerminalRecoveryReason }) => void,
    ) => () => void;
  };

  filesystem: {
    list: (
      terminalId: string,
      dirPath?: string,
    ) => Promise<FileSystemListResult>;
    readTextFile: (
      terminalId: string,
      filePath: string,
      options?: { maxBytes?: number },
    ) => Promise<ReadTextFileResult>;
    readFileBase64: (
      terminalId: string,
      filePath: string,
      options?: { maxBytes?: number },
    ) => Promise<ReadBase64FileResult>;
    writeTextFile: (
      terminalId: string,
      filePath: string,
      content: string,
    ) => Promise<void>;
    writeFileBase64: (
      terminalId: string,
      filePath: string,
      contentBase64: string,
      options?: { maxBytes?: number },
    ) => Promise<void>;
    transferEntries: (
      sourceTerminalId: string,
      sourcePaths: string[],
      targetTerminalId: string,
      targetDirPath: string,
      options?: {
        mode?: "copy" | "move";
        transferId?: string;
        chunkSize?: number;
        overwrite?: boolean;
        conflictStrategy?: "error" | "overwrite" | "rename";
      },
    ) => Promise<{
      mode: "copy" | "move";
      totalBytes: number;
      transferredFiles: number;
      totalFiles: number;
    }>;
    cancelTransfer: (transferId: string) => Promise<{ ok: boolean }>;
    startTransfer: (input: {
      origin: "user" | "agent";
      mode?: "copy" | "move";
      sourceTerminalId: string;
      sourcePaths: string[];
      targetTerminalId: string;
      targetDirPath: string;
      transferId?: string;
      chunkSize?: number;
      overwrite?: boolean;
      conflictStrategy?: "error" | "overwrite" | "rename";
      requireDistinctMachine?: boolean;
      sessionId?: string;
      agentRunId?: string;
      toolMessageId?: string;
    }) => Promise<FileTransferTaskSnapshot>;
    getTransfer: (
      transferId: string,
    ) => Promise<FileTransferTaskSnapshot | null>;
    listTransfers: (options?: {
      includeCompleted?: boolean;
      origin?: "user" | "agent";
      terminalId?: string;
      sessionId?: string;
      agentRunId?: string;
    }) => Promise<FileTransferTaskSnapshot[]>;
    cancelTransferTask: (
      transferId: string,
    ) => Promise<FileTransferTaskSnapshot | null>;
    createDirectory: (terminalId: string, dirPath: string) => Promise<void>;
    createFile: (terminalId: string, filePath: string) => Promise<void>;
    deletePath: (
      terminalId: string,
      targetPath: string,
      options?: { recursive?: boolean },
    ) => Promise<void>;
    renamePath: (
      terminalId: string,
      sourcePath: string,
      targetPath: string,
    ) => Promise<void>;
    onTransferProgress: (
      callback: (payload: {
        transferId: string;
        mode: "copy" | "move";
        sourceTerminalId: string;
        targetTerminalId: string;
        targetDirPath: string;
        sourcePaths: string[];
        bytesTransferred: number;
        totalBytes: number;
        transferredFiles: number;
        totalFiles: number;
        eof: boolean;
      }) => void,
    ) => () => void;
    onTransferTaskUpdated: (
      callback: (payload: FileTransferTaskSnapshot) => void,
    ) => () => void;
    onTransferTaskRemoved: (
      callback: (payload: { transferId: string }) => void,
    ) => () => void;
  };

  // UI
  ui: {
    showContextMenu: (payload: {
      id: string;
      canCopy: boolean;
      canPaste: boolean;
    }) => Promise<void>;
    onContextMenuAction: (
      callback: (data: { id: string; action: "copy" | "paste" }) => void,
    ) => () => void;
  };

  // Agent
  agent: {
    registerSession: (sessionId: string) => Promise<void>;
    unregisterSession: (sessionId: string) => Promise<void>;
    startTask: (
      sessionId: string,
      userInput: string | UserInputPayload,
      options?: { startMode?: "normal" | "inserted" },
    ) => Promise<void>;
    stopTask: (sessionId: string) => Promise<void>;
    getAllChatHistory: () => Promise<any[]>;
    loadChatSession: (sessionId: string) => Promise<any>;
    getUiMessages: (sessionId: string) => Promise<any[]>;
    getSessionSnapshot: (sessionId: string) => Promise<{
      id: string;
      title: string;
      updatedAt: number;
      messages: any[];
      isBusy: boolean;
      lockedProfileId: string | null;
      uiRevision: number;
    } | null>;
    deleteChatSession: (sessionId: string) => Promise<void>;
    deleteChatSessions: (sessionIds: string[]) => Promise<void>;
    rollbackToMessage: (
      sessionId: string,
      messageId: string,
    ) => Promise<{ ok: boolean; removedCount: number }>;
    branchFromMessage: (
      sessionId: string,
      messageId: string,
    ) => Promise<{
      ok: boolean;
      sessionId?: string;
      title?: string;
      messageCount?: number;
      reason?: string;
    }>;
    replyMessage: (messageId: string, payload: any) => Promise<{ ok: boolean }>;
    onEvent: (
      callback: (data: { sessionId: string; event: AgentEvent }) => void,
    ) => () => void;
    onUiUpdate: (callback: (action: any) => void) => () => void;
    exportHistory: (
      sessionId: string,
      mode?: "simple" | "detailed",
    ) => Promise<void>;
    formatMessagesMarkdown: (
      sessionId: string,
      messageIds: string[],
    ) => Promise<string>;
    renameSession: (sessionId: string, newTitle: string) => Promise<void>;
    replyCommandApproval: (
      approvalId: string,
      decision: "allow" | "deny",
    ) => Promise<void>;
  };

  // Models
  models: {
    probe: (model: BackendSettings["models"]["items"][number]) => Promise<{
      imageInputs: boolean;
      textOutputs: boolean;
      supportsStructuredOutput: boolean;
      supportsObjectToolChoice: boolean;
      testedAt: number;
      ok: boolean;
      error?: string;
    }>;
  };

  // Tools
  tools: {
    openMcpConfig: () => Promise<void>;
    reloadMcp: () => Promise<McpToolSummary[]>;
    getMcp: () => Promise<McpToolSummary[]>;
    setMcpEnabled: (
      name: string,
      enabled: boolean,
    ) => Promise<McpToolSummary[]>;
    getBuiltIn: () => Promise<BuiltInToolSummary[]>;
    setBuiltInEnabled: (
      name: string,
      enabled: boolean,
      acknowledgedExperimentalToolNames?: string[],
    ) => Promise<
      BuiltInToolSummary[] | ExperimentalToolConfirmationRequired
    >;
    onMcpUpdated: (callback: (data: McpToolSummary[]) => void) => () => void;
    onBuiltInUpdated: (
      callback: (data: BuiltInToolSummary[]) => void,
    ) => () => void;
  };

  themes: {
    openCustomConfig: () => Promise<void>;
    reloadCustom: () => Promise<TerminalColorScheme[]>;
    getCustom: () => Promise<TerminalColorScheme[]>;
  };

  skills: {
    openFolder: () => Promise<void>;
    reload: () => Promise<SkillSummary[]>;
    getAll: () => Promise<SkillSummary[]>;
    getEnabled: () => Promise<SkillSummary[]>;
    create: () => Promise<SkillSummary>;
    openFile: (fileName: string) => Promise<void>;
    delete: (fileName: string) => Promise<SkillSummary[]>;
    setEnabled: (
      name: string,
      enabled: boolean,
    ) => Promise<SkillStatusSummary[]>;
    onUpdated: (callback: (data: SkillStatusSummary[]) => void) => () => void;
  };

  memory: {
    get: () => Promise<MemorySnapshot>;
    setContent: (content: string) => Promise<MemorySnapshot>;
    openFile: () => Promise<void>;
    onUpdated: (callback: (snapshot: MemorySnapshot) => void) => () => void;
  };

  agentSettings: {
    get: () => Promise<AgentSettingState>;
    saveCurrent: () => Promise<AgentSettingOperationResult>;
    apply: (
      profileId: string,
      acknowledgedExperimentalToolNames?: string[],
    ) => Promise<AgentSettingApplyResult>;
    overwrite: (profileId: string) => Promise<AgentSettingOperationResult>;
    delete: (profileId: string) => Promise<AgentSettingOperationResult>;
  };

  version: {
    getState: () => Promise<VersionCheckResult>;
    check: () => Promise<VersionCheckResult>;
  };

  mobileWeb: {
    getStatus: () => Promise<{
      running: boolean;
      port?: number;
      urls?: string[];
    }>;
    start: () => Promise<{ running: boolean; port?: number; urls?: string[] }>;
    stop: () => Promise<{ ok: boolean }>;
    setPort: (port: number | null) => Promise<{ ok: boolean }>;
  };

  monitor: {
    start: (
      terminalId: string,
      intervalMs?: number,
    ) => Promise<{ ok: boolean }>;
    stop: (terminalId: string) => Promise<{ ok: boolean }>;
    subscribe: (terminalId: string) => Promise<{ ok: boolean }>;
    unsubscribe: (terminalId: string) => Promise<{ ok: boolean }>;
    snapshot: (terminalId: string) => Promise<any>;
    isMonitoring: (terminalId: string) => Promise<{ monitoring: boolean }>;
    onSnapshot: (callback: (data: any) => void) => () => void;
  };

  windowControls: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
}

const api: GyShellAPI = {
  system: {
    platform: process.platform,
    openExternal: (url: string) =>
      ipcRenderer.invoke("system:openExternal", url),
    saveImageAttachment: (payload: SaveImageAttachmentPayload) =>
      ipcRenderer.invoke("system:saveImageAttachment", payload),
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    },
    startFileDrag: (filePaths: string[]) => {
      const paths = Array.isArray(filePaths)
        ? filePaths.filter(
            (path): path is string =>
              typeof path === "string" && path.length > 0,
          )
        : [];
      if (paths.length === 0) return;
      ipcRenderer.send("system:startFileDrag", paths);
    },
  },
  gateway: {
    isSameMachine: () => ipcRenderer.invoke("gateway:isSameMachine"),
  },
  historyMigration: {
    getState: () => ipcRenderer.invoke("historyMigration:getState"),
    waitUntilSettled: () =>
      ipcRenderer.invoke("historyMigration:waitUntilSettled"),
    onStateChanged: (callback) => {
      const handler = (_: IpcRendererEvent, state: HistoryMigrationState) =>
        callback(state);
      ipcRenderer.on("historyMigration:state", handler);
      return () => ipcRenderer.off("historyMigration:state", handler);
    },
  },
  windowing: {
    openDetached: (detachedStateToken, sourceClientId) =>
      ipcRenderer.invoke(
        "windowing:openDetached",
        detachedStateToken,
        sourceClientId,
      ),
    onMainWindowClosing: (callback) => {
      const handler = () => callback();
      ipcRenderer.on("windowing:mainWindowClosing", handler);
      return () => ipcRenderer.off("windowing:mainWindowClosing", handler);
    },
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (settings) => ipcRenderer.invoke("settings:set", settings),
    setSync: (settings) => {
      const result = ipcRenderer.sendSync("settings:setSync", settings);
      if (result?.ok === false) {
        throw new Error(result.error || "Failed to persist settings.");
      }
    },
    setWsGatewayAccess: (access) =>
      ipcRenderer.invoke("settings:setWsGatewayAccess", access),
    setWsGatewayConfig: (ws) =>
      ipcRenderer.invoke("settings:setWsGatewayConfig", ws),
    openCommandPolicyFile: () =>
      ipcRenderer.invoke("settings:openCommandPolicyFile"),
    getCommandPolicyLists: () =>
      ipcRenderer.invoke("settings:getCommandPolicyLists"),
    onUpdated: (callback: (settings: BackendSettings) => void) => {
      const handler = (_: IpcRendererEvent, settings: BackendSettings) =>
        callback(settings);
      ipcRenderer.on("settings:updated", handler);
      return () => ipcRenderer.off("settings:updated", handler);
    },
    onCommandPolicyListsUpdated: (
      callback: (lists: CommandPolicyLists) => void,
    ) => {
      const handler = (_: IpcRendererEvent, lists: CommandPolicyLists) =>
        callback(lists);
      ipcRenderer.on("settings:commandPolicyListsUpdated", handler);
      return () =>
        ipcRenderer.off("settings:commandPolicyListsUpdated", handler);
    },
    addCommandPolicyRule: (listName, rule) =>
      ipcRenderer.invoke("settings:addCommandPolicyRule", listName, rule),
    deleteCommandPolicyRule: (listName, rule) =>
      ipcRenderer.invoke("settings:deleteCommandPolicyRule", listName, rule),
  },
  accessTokens: {
    list: () => ipcRenderer.invoke("access-tokens:list"),
    create: (name: string) => ipcRenderer.invoke("access-tokens:create", name),
    delete: (id: string) => ipcRenderer.invoke("access-tokens:delete", id),
  },
  uiSettings: {
    get: () => ipcRenderer.invoke("ui-settings:get"),
    set: (settings) => ipcRenderer.invoke("ui-settings:set", settings),
  },

  terminal: {
    list: () => ipcRenderer.invoke("terminal:list"),
    createTab: (config) => ipcRenderer.invoke("terminal:createTab", config),
    reconnect: (terminalId) =>
      ipcRenderer.invoke("terminal:reconnect", terminalId),
    write: (terminalId, data) =>
      ipcRenderer.invoke("terminal:write", terminalId, data),
    writePaths: (terminalId, paths) =>
      ipcRenderer.invoke("terminal:writePaths", terminalId, paths),
    resize: (terminalId, cols, rows) =>
      ipcRenderer.invoke("terminal:resize", terminalId, cols, rows),
    kill: (terminalId) => ipcRenderer.invoke("terminal:kill", terminalId),
    setSelection: (terminalId, selectionText) =>
      ipcRenderer.invoke("terminal:setSelection", terminalId, selectionText),
    getBufferDelta: (terminalId, fromOffset) =>
      ipcRenderer.invoke("terminal:getBufferDelta", terminalId, fromOffset),
    attachOutputConsumer: (terminalId, consumerId) =>
      ipcRenderer.invoke(
        "terminal:attachOutputConsumer",
        terminalId,
        consumerId,
      ),
    detachOutputConsumer: (terminalId, consumerId) =>
      ipcRenderer.send(
        "terminal:detachOutputConsumer",
        terminalId,
        consumerId,
      ),
    acknowledgeOutput: (
      terminalId,
      consumerId,
      runtimeGeneration,
      outputSequence,
    ) =>
      ipcRenderer.send(
        "terminal:acknowledgeOutput",
        terminalId,
        consumerId,
        runtimeGeneration,
        outputSequence,
      ),
    reportOutputFailure: (
      terminalId,
      consumerId,
      runtimeGeneration,
      errorMessage,
    ) =>
      ipcRenderer.send(
        "terminal:reportOutputFailure",
        terminalId,
        consumerId,
        runtimeGeneration,
        errorMessage,
      ),
    generateCommandDraft: (terminalId, prompt, profileId) =>
      ipcRenderer.invoke(
        "terminal:generateCommandDraft",
        terminalId,
        prompt,
        profileId,
      ),
    onData: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        data: {
          terminalId: string;
          data: string;
          offset?: number;
          outputSequence?: number;
          runtimeGeneration?: number;
        } & TerminalRenderMetadata,
      ) => callback(data);
      ipcRenderer.on("terminal:data", handler);
      return () => ipcRenderer.off("terminal:data", handler);
    },
    onExit: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        data: { terminalId: string; code: number },
      ) => callback(data);
      ipcRenderer.on("terminal:exit", handler);
      return () => ipcRenderer.off("terminal:exit", handler);
    },
    onTabsUpdated: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        data: { terminals: TerminalSummary[] },
      ) => callback(data);
      ipcRenderer.on("terminal:tabs", handler);
      return () => ipcRenderer.off("terminal:tabs", handler);
    },
    onRecoveryHint: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        data: { reason: TerminalRecoveryReason },
      ) => callback(data);
      ipcRenderer.on("terminal:recoveryHint", handler);
      return () => ipcRenderer.off("terminal:recoveryHint", handler);
    },
  },

  filesystem: {
    list: (terminalId, dirPath) =>
      ipcRenderer.invoke("filesystem:list", terminalId, dirPath),
    readTextFile: (terminalId, filePath, options) =>
      ipcRenderer.invoke(
        "filesystem:readTextFile",
        terminalId,
        filePath,
        options,
      ),
    readFileBase64: (terminalId, filePath, options) =>
      ipcRenderer.invoke(
        "filesystem:readFileBase64",
        terminalId,
        filePath,
        options,
      ),
    writeTextFile: (terminalId, filePath, content) =>
      ipcRenderer.invoke(
        "filesystem:writeTextFile",
        terminalId,
        filePath,
        content,
      ),
    writeFileBase64: (terminalId, filePath, contentBase64, options) =>
      ipcRenderer.invoke(
        "filesystem:writeFileBase64",
        terminalId,
        filePath,
        contentBase64,
        options,
      ),
    transferEntries: (
      sourceTerminalId,
      sourcePaths,
      targetTerminalId,
      targetDirPath,
      options,
    ) =>
      ipcRenderer.invoke(
        "filesystem:transferEntries",
        sourceTerminalId,
        sourcePaths,
        targetTerminalId,
        targetDirPath,
        options,
      ),
    cancelTransfer: (transferId) =>
      ipcRenderer.invoke("filesystem:cancelTransfer", transferId),
    startTransfer: (input) =>
      ipcRenderer.invoke("filesystem:startTransfer", input),
    getTransfer: (transferId) =>
      ipcRenderer.invoke("filesystem:getTransfer", transferId),
    listTransfers: (options) =>
      ipcRenderer.invoke("filesystem:listTransfers", options),
    cancelTransferTask: (transferId) =>
      ipcRenderer.invoke("filesystem:cancelTransferTask", transferId),
    createDirectory: (terminalId, dirPath) =>
      ipcRenderer.invoke("filesystem:createDirectory", terminalId, dirPath),
    createFile: (terminalId, filePath) =>
      ipcRenderer.invoke("filesystem:createFile", terminalId, filePath),
    deletePath: (terminalId, targetPath, options) =>
      ipcRenderer.invoke(
        "filesystem:deletePath",
        terminalId,
        targetPath,
        options,
      ),
    renamePath: (terminalId, sourcePath, targetPath) =>
      ipcRenderer.invoke(
        "filesystem:renamePath",
        terminalId,
        sourcePath,
        targetPath,
      ),
    onTransferProgress: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        payload: {
          transferId: string;
          mode: "copy" | "move";
          sourceTerminalId: string;
          targetTerminalId: string;
          targetDirPath: string;
          sourcePaths: string[];
          bytesTransferred: number;
          totalBytes: number;
          transferredFiles: number;
          totalFiles: number;
          eof: boolean;
        },
      ) => callback(payload);
      ipcRenderer.on("filesystem:transferProgress", handler);
      return () => ipcRenderer.off("filesystem:transferProgress", handler);
    },
    onTransferTaskUpdated: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        payload: FileTransferTaskSnapshot,
      ) => callback(payload);
      ipcRenderer.on("filesystem:transferTaskUpdated", handler);
      return () => ipcRenderer.off("filesystem:transferTaskUpdated", handler);
    },
    onTransferTaskRemoved: (callback) => {
      const handler = (_: IpcRendererEvent, payload: { transferId: string }) =>
        callback(payload);
      ipcRenderer.on("filesystem:transferTaskRemoved", handler);
      return () => ipcRenderer.off("filesystem:transferTaskRemoved", handler);
    },
  },

  monitor: {
    start: (terminalId: string, intervalMs?: number) =>
      ipcRenderer.invoke("monitor:start", terminalId, intervalMs),
    stop: (terminalId: string) =>
      ipcRenderer.invoke("monitor:stop", terminalId),
    subscribe: (terminalId: string) =>
      ipcRenderer.invoke("monitor:subscribe", terminalId),
    unsubscribe: (terminalId: string) =>
      ipcRenderer.invoke("monitor:unsubscribe", terminalId),
    snapshot: (terminalId: string) =>
      ipcRenderer.invoke("monitor:snapshot", terminalId),
    isMonitoring: (terminalId: string) =>
      ipcRenderer.invoke("monitor:isMonitoring", terminalId) as Promise<{
        monitoring: boolean;
      }>,
    onSnapshot: (callback: (data: any) => void) => {
      const handler = (_: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on("monitor:snapshot", handler);
      return () => ipcRenderer.off("monitor:snapshot", handler);
    },
  },

  ui: {
    showContextMenu: (payload) =>
      ipcRenderer.invoke("ui:showContextMenu", payload),
    onContextMenuAction: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        data: { id: string; action: "copy" | "paste" },
      ) => callback(data);
      ipcRenderer.on("ui:contextMenuAction", handler);
      return () => ipcRenderer.off("ui:contextMenuAction", handler);
    },
  },

  agent: {
    registerSession: (sessionId) =>
      ipcRenderer.invoke("agent:registerSession", sessionId),
    unregisterSession: (sessionId) =>
      ipcRenderer.invoke("agent:unregisterSession", sessionId),
    startTask: (sessionId, userInput, options) =>
      ipcRenderer.invoke("agent:startTask", sessionId, userInput, options),
    stopTask: (sessionId) => ipcRenderer.invoke("agent:stopTask", sessionId),
    getAllChatHistory: () => ipcRenderer.invoke("agent:getAllChatHistory"),
    loadChatSession: (sessionId) =>
      ipcRenderer.invoke("agent:loadChatSession", sessionId),
    getUiMessages: (sessionId) =>
      ipcRenderer.invoke("agent:getUiMessages", sessionId),
    getSessionSnapshot: async (sessionId) => {
      const payload = await ipcRenderer.invoke("session:get", sessionId);
      return payload?.session ?? null;
    },
    deleteChatSession: (sessionId) =>
      ipcRenderer.invoke("agent:deleteChatSession", sessionId),
    deleteChatSessions: (sessionIds) =>
      ipcRenderer.invoke("agent:deleteChatSessions", sessionIds),
    rollbackToMessage: (sessionId, messageId) =>
      ipcRenderer.invoke("agent:rollbackToMessage", sessionId, messageId),
    branchFromMessage: (sessionId, messageId) =>
      ipcRenderer.invoke("agent:branchFromMessage", sessionId, messageId),
    replyMessage: (messageId, payload) =>
      ipcRenderer.invoke("agent:replyMessage", messageId, payload),
    onEvent: (callback) => {
      const handler = (
        _: IpcRendererEvent,
        data: { sessionId: string; event: AgentEvent },
      ) => callback(data);
      ipcRenderer.on("agent:event", handler);
      return () => ipcRenderer.off("agent:event", handler);
    },
    onUiUpdate: (callback) => {
      const handler = (_: IpcRendererEvent, action: any) => callback(action);
      ipcRenderer.on("agent:ui-update", handler);
      return () => ipcRenderer.off("agent:ui-update", handler);
    },
    exportHistory: (sessionId, mode) =>
      ipcRenderer.invoke("agent:exportHistory", sessionId, mode),
    formatMessagesMarkdown: (sessionId, messageIds) =>
      ipcRenderer.invoke("agent:formatMessagesMarkdown", sessionId, messageIds),
    renameSession: (sessionId, newTitle) =>
      ipcRenderer.invoke("agent:renameSession", sessionId, newTitle),
    replyCommandApproval: (approvalId, decision) =>
      ipcRenderer.invoke("agent:replyCommandApproval", approvalId, decision),
  },
  models: {
    probe: (model) => ipcRenderer.invoke("models:probe", model),
  },
  tools: {
    openMcpConfig: () => ipcRenderer.invoke("tools:openMcpConfig"),
    reloadMcp: () => ipcRenderer.invoke("tools:reloadMcp"),
    getMcp: () => ipcRenderer.invoke("tools:getMcp"),
    setMcpEnabled: (name, enabled) =>
      ipcRenderer.invoke("tools:setMcpEnabled", name, enabled),
    getBuiltIn: () => ipcRenderer.invoke("tools:getBuiltIn"),
    setBuiltInEnabled: (name, enabled, acknowledgedExperimentalToolNames) =>
      ipcRenderer.invoke(
        "tools:setBuiltInEnabled",
        name,
        enabled,
        acknowledgedExperimentalToolNames,
      ),
    onMcpUpdated: (callback) => {
      const handler = (_: IpcRendererEvent, data: McpToolSummary[]) =>
        callback(data);
      ipcRenderer.on("tools:mcpUpdated", handler);
      return () => ipcRenderer.off("tools:mcpUpdated", handler);
    },
    onBuiltInUpdated: (callback) => {
      const handler = (_: IpcRendererEvent, data: BuiltInToolSummary[]) =>
        callback(data);
      ipcRenderer.on("tools:builtInUpdated", handler);
      return () => ipcRenderer.off("tools:builtInUpdated", handler);
    },
  },
  themes: {
    openCustomConfig: () => ipcRenderer.invoke("themes:openCustomConfig"),
    reloadCustom: () => ipcRenderer.invoke("themes:reloadCustom"),
    getCustom: () => ipcRenderer.invoke("themes:getCustom"),
  },
  skills: {
    openFolder: () => ipcRenderer.invoke("skills:openFolder"),
    reload: () => ipcRenderer.invoke("skills:reload"),
    getAll: () => ipcRenderer.invoke("skills:getAll"),
    getEnabled: () => ipcRenderer.invoke("skills:getEnabled"),
    create: () => ipcRenderer.invoke("skills:create"),
    openFile: (fileName) => ipcRenderer.invoke("skills:openFile", fileName),
    delete: (fileName) => ipcRenderer.invoke("skills:delete", fileName),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke("skills:setEnabled", name, enabled),
    onUpdated: (callback: (data: SkillStatusSummary[]) => void) => {
      const handler = (_: IpcRendererEvent, data: SkillStatusSummary[]) =>
        callback(data);
      ipcRenderer.on("skills:updated", handler);
      return () => ipcRenderer.off("skills:updated", handler);
    },
  },
  memory: {
    get: () => ipcRenderer.invoke("memory:get"),
    setContent: (content: string) =>
      ipcRenderer.invoke("memory:setContent", content),
    openFile: () => ipcRenderer.invoke("memory:openFile"),
    onUpdated: (callback: (snapshot: MemorySnapshot) => void) => {
      const handler = (_: IpcRendererEvent, snapshot: MemorySnapshot) =>
        callback(snapshot);
      ipcRenderer.on("memory:updated", handler);
      return () => ipcRenderer.off("memory:updated", handler);
    },
  },
  agentSettings: {
    get: () => ipcRenderer.invoke("agentSettings:get"),
    saveCurrent: () => ipcRenderer.invoke("agentSettings:saveCurrent"),
    apply: (profileId, acknowledgedExperimentalToolNames) =>
      ipcRenderer.invoke(
        "agentSettings:apply",
        profileId,
        acknowledgedExperimentalToolNames,
      ),
    overwrite: (profileId: string) =>
      ipcRenderer.invoke("agentSettings:overwrite", profileId),
    delete: (profileId: string) =>
      ipcRenderer.invoke("agentSettings:delete", profileId),
  },
  version: {
    getState: () => ipcRenderer.invoke("version:getState"),
    check: () => ipcRenderer.invoke("version:check"),
  },
  mobileWeb: {
    getStatus: () => ipcRenderer.invoke("mobileWeb:getStatus"),
    start: () => ipcRenderer.invoke("mobileWeb:start"),
    stop: () => ipcRenderer.invoke("mobileWeb:stop"),
    setPort: (port) => ipcRenderer.invoke("mobileWeb:setPort", port),
  },
};

contextBridge.exposeInMainWorld("gyshell", api);
