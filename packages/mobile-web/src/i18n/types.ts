export type MobileLocale = "en" | "zh-CN";

export interface MobileTranslations {
  appName: string;
  tabs: {
    sessions: string;
    terminals: string;
    settings: string;
    /** Legacy chat/skills/tools labels kept for Settings sub-pages and helpers. */
    chat: string;
    terminal: string;
    skills: string;
    tools: string;
    navLabel: string;
  };
  topBar: {
    backToSessions: string;
    sessions: string;
    sessionLabel: (id: string) => string;
    noActiveSession: string;
    desktopActive: string;
  };
  app: {
    chats: string;
    rollingBack: string;
    rollback: string;
    rollbackConfirmTitle: string;
    rollbackConfirmMessage: string;
    noSession: string;
    untitled: string;
    branching: string;
    branch: string;
    branchFailed: string;
    taskCompleted: (title: string) => string;
  };
  common: {
    connect: string;
    connecting: string;
    disconnect: string;
    cancel: string;
    details: string;
    allow: string;
    deny: string;
    decision: (value: string) => string;
    streaming: string;
    on: string;
    off: string;
    tool: string;
    expand: string;
    collapse: string;
    notConnected: string;
    save: string;
    delete: string;
    overwrite: string;
    apply: string;
    close: string;
    refresh: string;
    reconnect: string;
    empty: string;
  };
  composer: {
    placeholder: string;
    stopRun: string;
    send: string;
    sendMessage: string;
    attachImage: string;
    removeImage: string;
    clearImages: string;
    mentionSkill: string;
    mentionTerminal: string;
    steerHint: string;
    selectProfile: string;
  };
  sessionBrowser: {
    searchPlaceholder: string;
    createChat: string;
    deleteChat: (title: string) => string;
    deleteConfirm: (title: string) => string;
    empty: string;
    emptyHint: string;
    noUpdates: string;
    approvalBadge: (count: number) => string;
    approvalJump: string;
    statusApproval: string;
    statusApprovalWithTool: (toolName: string) => string;
    statusError: string;
    statusThinking: string;
    statusReplying: string;
    statusTool: string;
    statusToolWithName: (toolName: string) => string;
    statusFileEdit: string;
    statusSubTool: string;
    statusCommand: string;
    statusCommandAsync: string;
    statusCompacting: string;
    statusRunning: string;
    statusDone: string;
    tokensProgress: (used: number, max: number) => string;
  };
  messageList: {
    rollbackAndEdit: string;
    rollback: string;
    branchFromHere: string;
    emptyTitle: string;
    emptyHint: string;
    insertedBadge: string;
    nowaitBadge: string;
  };
  detail: {
    closeDetail: string;
    title: string;
    events: (count: number) => string;
    empty: string;
    assistantText: string;
    systemText: string;
  };
  settings: {
    title: string;
    connectionSection: string;
    gateway: string;
    memory: string;
    language: string;
    languageHint: string;
    gatewayHint: string;
    gatewayPlaceholder: string;
    tokenPlaceholder: string;
    memoryHint: string;
    memoryEnabled: string;
    memoryDisabled: string;
    memoryReload: string;
    memoryPathLabel: string;
    memoryContentLabel: string;
    memoryReadOnlyHint: string;
    english: string;
    chinese: string;
    skillsSection: string;
    toolsSection: string;
    agentProfilesSection: string;
    agentProfilesHint: string;
    agentProfilesEmpty: string;
    agentProfileActive: string;
    agentProfileSlot: (slot: number) => string;
    agentProfileModel: string;
    agentProfilePolicy: string;
    agentProfileUnknownPolicy: string;
    agentProfileSaveCurrent: string;
    agentProfileSaveCurrentConfirm: string;
    agentProfileOverwriteConfirm: string;
    agentProfileDeleteConfirm: (slot: number) => string;
    agentProfileApplyFailed: string;
    agentProfileSaveFailed: string;
    agentProfileNoSlots: string;
    agentProfileUnsaved: string;
    backToSettings: string;
  };
  skills: {
    enabledCount: (enabled: number, total: number) => string;
    empty: string;
    noDescription: string;
    reload: string;
    groups: {
      codex: string;
      agents: string;
      claude: string;
      custom: string;
      other: string;
    };
  };
  tools: {
    summary: (
      mcpEnabled: number,
      mcpTotal: number,
      builtInEnabled: number,
      builtInTotal: number,
    ) => string;
    mcpServers: string;
    builtInTools: string;
    mcpEmpty: string;
    builtInEmpty: string;
    noDescription: string;
    experimentalLabel: string;
    experimentalEnableWarning: (toolNames: string) => string;
    status: {
      connected: string;
      connecting: string;
      error: string;
      disabled: string;
    };
    toolCount: (count: number) => string;
    reload: string;
  };
  terminal: {
    localTerminal: string;
    selectTerminalType: string;
    noSavedSsh: string;
    noActiveTerminals: string;
    noActiveTerminalsHint: string;
    state: (value: string) => string;
    close: (title: string) => string;
    newTerminal: string;
    outputLabel: string;
    outputEmpty: string;
    outputUnsupported: string;
    refresh: string;
    reconnect: string;
    reconnecting: string;
    reconnectFailed: string;
    sshExited: string;
    newItem: string;
  };
  format: {
    justNow: string;
    minutesAgo: (n: number) => string;
    hoursAgo: (n: number) => string;
    daysAgo: (n: number) => string;
    commandRun: string;
    toolCall: string;
    fileCreated: string;
    fileEdited: string;
    subTool: string;
    reasoning: string;
    compaction: string;
    alert: string;
    error: string;
    permissionRequired: string;
    message: string;
    unknownFile: string;
    moreLines: (n: number) => string;
    moreChars: (n: number) => string;
  };
}
