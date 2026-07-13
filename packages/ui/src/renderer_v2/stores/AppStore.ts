import {
  action,
  computed,
  makeObservable,
  observable,
  runInAction,
  toJS,
} from "mobx";
import { v4 as uuidv4 } from "uuid";
import type { ITheme } from "@xterm/xterm";
import {
  DEFAULT_PANEL_TAB_DISPLAY_MODE,
  type PanelTabDisplayModePreference,
} from "@gyshell/shared";
import type {
  AppSettings,
  TerminalConfig,
  AppLanguage,
  ModelDefinition,
  MonitorSnapshot,
  FileTransferTaskSnapshot,
  ProxyEntry,
  TunnelEntry,
} from "../lib/ipcTypes";
import { applyAppThemeFromTerminalScheme } from "../theme/appTheme";
import { resolveTheme } from "../theme/themes";
import { toXtermTheme } from "../theme/xtermTheme";
import type { TerminalColorScheme } from "../theme/terminalColorSchemes";
import type { TerminalConnectionCapabilities } from "@gyshell/shared";
import {
  createImagePreviewDataUrl,
  readFileAsDataUrl,
  type InputImageAttachment,
  type UserInputPayload,
} from "../lib/userInput";
import { I18nStore } from "./I18nStore";
import { ChatStore } from "./ChatStore";
import { LayoutStore } from "./LayoutStore";
import { FileEditorStore } from "./FileEditorStore";
import {
  buildLayoutTree,
  listPanels,
  type LayoutTree,
  type PanelKind,
} from "../layout";
import {
  buildDetachedLayoutTree,
  WINDOW_CONTEXT,
  openDetachedWindowState,
  readDetachedWindowState,
  type DetachedWindowState,
  type WindowingTerminalTabSnapshot,
} from "../lib/windowing";
import type { FileEditorSnapshot } from "../lib/fileEditorSnapshot";
import {
  canReconnectTerminalRuntime,
  resolveTerminalConnectionCapabilities,
  type TerminalConnectionRef,
} from "../lib/terminalConnectionModel";

const upsertById = <T extends { id: string }>(list: T[], entry: T): T[] => {
  const idx = list.findIndex((x) => x.id === entry.id);
  if (idx === -1) return [...list, entry];
  const next = list.slice();
  next[idx] = entry;
  return next;
};

const removeById = <T extends { id: string }>(list: T[], id: string): T[] =>
  list.filter((x) => x.id !== id);

const normalizeTerminalTitle = (value: unknown, fallback: string): string => {
  const title = String(value || "").trim();
  return title || fallback;
};

const resolveUniqueTerminalTitle = (
  baseTitle: string,
  existingTitles: Iterable<string>,
): string => {
  const usedTitles = new Set(
    Array.from(existingTitles)
      .map((title) => String(title || "").trim())
      .filter((title) => title.length > 0),
  );
  const normalizedBaseTitle = normalizeTerminalTitle(baseTitle, "Terminal");
  if (!usedTitles.has(normalizedBaseTitle)) {
    return normalizedBaseTitle;
  }

  const rootTitle = normalizedBaseTitle;
  let counter = 1;
  let nextTitle = `${rootTitle} (${counter})`;
  while (usedTitles.has(nextTitle)) {
    counter += 1;
    nextTitle = `${rootTitle} (${counter})`;
  }
  return nextTitle;
};

const FILE_TRANSFER_STATUS_RANK: Record<string, number> = {
  queued: 0,
  scanning: 1,
  running: 2,
  success: 3,
  error: 3,
  cancelled: 3,
};

const shouldApplyFileTransferTaskSnapshot = (
  existing: FileTransferTaskSnapshot | undefined,
  incoming: FileTransferTaskSnapshot,
): boolean => {
  if (!existing) return true;
  const existingUpdatedAt = Number(existing.updatedAt) || 0;
  const incomingUpdatedAt = Number(incoming.updatedAt) || 0;
  if (incomingUpdatedAt > existingUpdatedAt) return true;
  if (incomingUpdatedAt < existingUpdatedAt) return false;

  const existingRank = FILE_TRANSFER_STATUS_RANK[existing.status] ?? 0;
  const incomingRank = FILE_TRANSFER_STATUS_RANK[incoming.status] ?? 0;
  if (incomingRank > existingRank) return true;
  if (incomingRank < existingRank) return false;

  const existingBytesDone = Number(existing.bytesDone) || 0;
  const incomingBytesDone = Number(incoming.bytesDone) || 0;
  return incomingBytesDone >= existingBytesDone;
};

type WindowScopedTabKind = "chat" | "terminal" | "filesystem" | "monitor";
const MONITOR_HISTORY_LIMIT = 64;
const MONITOR_POLL_INTERVAL_MS = 3500;
const LOCAL_MONITOR_SOURCE_KEY = "local://default";

const normalizeMonitorIdentityPart = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase();

const deriveMonitorIdentityFromConfig = (
  config: Pick<TerminalConfig, "type"> | TerminalConfig,
): string | null => {
  if (config.type === "local") {
    return LOCAL_MONITOR_SOURCE_KEY;
  }
  if (config.type !== "ssh") {
    return null;
  }

  const host = normalizeMonitorIdentityPart((config as any).host);
  if (!host) {
    return null;
  }

  const rawPort = Number((config as any).port);
  const port =
    Number.isFinite(rawPort) && rawPort > 0 ? Math.floor(rawPort) : 22;
  const username = normalizeMonitorIdentityPart((config as any).username);
  return `ssh://${username}@${host}:${port}`;
};

const shouldInitializeLocalTerminalSilently = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  return window.gyshell?.system?.platform === "win32";
};

const toPlainTerminalConfig = (config: TerminalConfig): TerminalConfig =>
  JSON.parse(JSON.stringify(config)) as TerminalConfig;

const resolveSuppressionKinds = (kind: PanelKind): WindowScopedTabKind[] =>
  kind === "chat"
    ? ["chat"]
    : kind === "terminal"
      ? ["terminal"]
      : kind === "filesystem"
        ? ["filesystem"]
        : kind === "monitor"
          ? ["monitor"]
          : [];

export type AppView = "main" | "settings" | "connections";
export type SettingsSection =
  | "general"
  | "theme"
  | "models"
  | "security"
  | "tools"
  | "skills"
  | "memory"
  | "workflow"
  | "accessTokens"
  | "version";

export type McpToolSummary = Awaited<
  ReturnType<Window["gyshell"]["tools"]["getMcp"]>
>[number];
export type BuiltInToolSummary = Awaited<
  ReturnType<Window["gyshell"]["tools"]["getBuiltIn"]>
>[number];
export type SkillSummary = Awaited<
  ReturnType<Window["gyshell"]["skills"]["getAll"]>
>[number];
export type SkillStatusSummary = Awaited<
  ReturnType<Window["gyshell"]["skills"]["setEnabled"]>
>[number];
export type MemorySnapshot = Awaited<
  ReturnType<Window["gyshell"]["memory"]["get"]>
>;
export type AgentSettingState = Awaited<
  ReturnType<Window["gyshell"]["agentSettings"]["get"]>
>;
export type AgentSettingOperationResult = Awaited<
  ReturnType<Window["gyshell"]["agentSettings"]["saveCurrent"]>
>;
export type AgentSettingApplyResult = Awaited<
  ReturnType<Window["gyshell"]["agentSettings"]["apply"]>
>;
export type ExperimentalToolConfirmationRequired = Extract<
  AgentSettingApplyResult,
  { kind: "experimental_tool_confirmation_required" }
>;
export type AccessTokenSummary = Awaited<
  ReturnType<Window["gyshell"]["accessTokens"]["list"]>
>[number];
export type CommandPolicyLists = Awaited<
  ReturnType<Window["gyshell"]["settings"]["getCommandPolicyLists"]>
>;
export type VersionCheckResult = Awaited<
  ReturnType<Window["gyshell"]["version"]["check"]>
>;
export type HistoryMigrationSnapshot = Awaited<
  ReturnType<Window["gyshell"]["historyMigration"]["getState"]>
>;

export interface TerminalTabModel {
  id: string;
  title: string;
  config: TerminalConfig;
  capabilities: TerminalConnectionCapabilities;
  connectionRef?: TerminalConnectionRef;
  runtimeState?: "initializing" | "ready" | "exited";
  lastExitCode?: number;
  remoteOs?: TerminalListEntry["remoteOs"];
  systemInfo?: TerminalListEntry["systemInfo"];
  monitorIdentity?: string;
}
type TerminalListPayload = Awaited<
  ReturnType<Window["gyshell"]["terminal"]["list"]>
>;
type TerminalListEntry = TerminalListPayload["terminals"][number];

export type FileSystemClipboardMode = "copy" | "move";

export interface FileSystemClipboardState {
  mode: FileSystemClipboardMode;
  sourceTerminalId: string;
  sourcePaths: string[];
  itemNames: string[];
  sourceBasePath: string;
  createdAt: number;
}

const cloneFileSystemClipboardState = (
  payload: FileSystemClipboardState | null,
): FileSystemClipboardState | null => {
  if (!payload) {
    return null;
  }
  return {
    mode: payload.mode === "move" ? "move" : "copy",
    sourceTerminalId: String(payload.sourceTerminalId || ""),
    sourcePaths: Array.isArray(payload.sourcePaths)
      ? payload.sourcePaths
          .map((path) => String(path || ""))
          .filter((path) => path.length > 0)
      : [],
    itemNames: Array.isArray(payload.itemNames)
      ? payload.itemNames.map((name) => String(name || ""))
      : [],
    sourceBasePath:
      typeof payload.sourceBasePath === "string" &&
      payload.sourceBasePath.length > 0
        ? payload.sourceBasePath
        : ".",
    createdAt: Number.isFinite(payload.createdAt)
      ? Number(payload.createdAt)
      : Date.now(),
  };
};

export interface MonitorTerminalState {
  snapshot: MonitorSnapshot | null;
  lastError: string | null;
  cpuHistory: number[];
  memoryHistory: number[];
  rxHistory: number[];
  txHistory: number[];
}

const createMonitorTerminalState = (): MonitorTerminalState => ({
  snapshot: null,
  lastError: null,
  cpuHistory: [],
  memoryHistory: [],
  rxHistory: [],
  txHistory: [],
});

const appendMonitorHistoryValue = (
  history: number[],
  value: number,
): number[] => {
  if (!Number.isFinite(value)) {
    return history;
  }
  const next = [...history, value];
  return next.length > MONITOR_HISTORY_LIMIT
    ? next.slice(-MONITOR_HISTORY_LIMIT)
    : next;
};

export class AppStore {
  readonly windowRole = WINDOW_CONTEXT.role;
  readonly windowClientId = WINDOW_CONTEXT.clientId;
  readonly detachedSourceClientId = WINDOW_CONTEXT.sourceClientId;

  view: AppView = "main";
  settings: AppSettings | null = null;
  isBootstrapped = false;
  settingsSection: SettingsSection = "general";

  terminalTabs: TerminalTabModel[] = [];
  terminalTabsHydrated = false;
  activeTerminalId: string | null = null;
  monitorStateByTerminalId: Record<string, MonitorTerminalState> = {};
  monitorEnabledSources: string[] = [];
  terminalSelections: Record<string, string> = {};
  fileSystemClipboard: FileSystemClipboardState | null = null;
  fileTransferTasks: Record<string, FileTransferTaskSnapshot> = {};

  xtermTheme: ITheme = {};
  customThemes: TerminalColorScheme[] = [];
  i18n = new I18nStore();
  chat = new ChatStore();
  fileEditor = new FileEditorStore(this);
  layout = new LayoutStore(this);
  mcpTools: McpToolSummary[] = [];
  builtInTools: BuiltInToolSummary[] = [];
  skills: SkillSummary[] = [];
  memoryFilePath = "";
  memoryContent = "";
  agentSettingWarnings: string[] = [];
  accessTokens: AccessTokenSummary[] = [];
  commandPolicyLists: CommandPolicyLists = {
    allowlist: [],
    denylist: [],
    asklist: [],
  };
  versionInfo: VersionCheckResult | null = null;
  versionCheckInProgress = false;
  showVersionUpdateDialog = false;
  historyMigrationState: HistoryMigrationSnapshot | null = null;
  mobileWebStatus: { running: boolean; port?: number; urls?: string[] } = {
    running: false,
  };
  private detachedVisibleTabIdsByKind: Record<
    "chat" | "terminal" | "filesystem" | "monitor",
    Set<string>
  > | null = null;
  private lastKnownChatSessionIds = new Set<string>();
  private suppressedTabIdsByKind: Record<
    "chat" | "terminal" | "filesystem" | "monitor",
    Set<string>
  > = {
    chat: new Set<string>(),
    terminal: new Set<string>(),
    filesystem: new Set<string>(),
    monitor: new Set<string>(),
  };
  private layoutHiddenTabIdsByKind: Record<WindowScopedTabKind, Set<string>> = {
    chat: new Set<string>(),
    terminal: new Set<string>(),
    filesystem: new Set<string>(),
    monitor: new Set<string>(),
  };
  private monitorRetainedTabIds = new Set<string>();
  private monitorSubscribedTabIds = new Set<string>();
  private monitorSnapshotUnsubscribe: (() => void) | null = null;

  constructor() {
    makeObservable(this, {
      view: observable,
      settings: observable,
      isBootstrapped: observable,
      settingsSection: observable,
      terminalTabs: observable,
      terminalTabsHydrated: observable,
      activeTerminalId: observable,
      monitorStateByTerminalId: observable,
      monitorEnabledSources: observable,
      terminalSelections: observable,
      fileSystemClipboard: observable.ref,
      fileTransferTasks: observable,
      xtermTheme: observable,
      customThemes: observable,
      i18n: observable,
      chat: observable,
      fileEditor: observable,
      layout: observable,
      mcpTools: observable,
      builtInTools: observable,
      skills: observable,
      memoryFilePath: observable,
      memoryContent: observable,
      agentSettingWarnings: observable,
      accessTokens: observable,
      commandPolicyLists: observable,
      versionInfo: observable,
      versionCheckInProgress: observable,
      showVersionUpdateDialog: observable,
      historyMigrationState: observable.ref,
      isDetachedWindow: computed,
      isSettings: computed,
      isConnections: computed,
      activeTerminal: computed,
      fileSystemTabs: computed,
      monitorTabs: computed,
      panelTabDisplayMode: computed,
      chatDisplayMode: computed,
      preventSleepWhileRunning: computed,
      agentSettingState: computed,
      commandDraftProfileId: computed,
      openSettings: action,
      closeSettings: action,
      toggleSettings: action,
      openConnections: action,
      closeOverlay: action,
      bootstrap: action,
      createLocalTab: action,
      createSshTab: action,
      saveSshConnection: action,
      deleteSshConnection: action,
      reconnectTerminal: action,
      closeTab: action,
      setActiveTerminal: action,
      setTerminalSelection: action,
      setFileSystemClipboard: action,
      clearFileSystemClipboard: action,
      applyFileTransferTasks: action,
      applyFileTransferTaskUpdate: action,
      removeFileTransferTask: action,
      startFileTransfer: action,
      cancelFileTransferTask: action,
      setSettingsSection: action,
      setThemeId: action,
      setLanguage: action,
      setTerminalSettings: action,
      setPanelTabDisplayMode: action,
      setChatDisplayMode: action,
      setPreventSleepWhileRunning: action,
      setCommandDraftProfileId: action,
      saveModel: action,
      deleteModel: action,
      saveProfile: action,
      deleteProfile: action,
      setActiveProfile: action,
      saveProxy: action,
      deleteProxy: action,
      saveTunnel: action,
      deleteTunnel: action,
      setCommandPolicyMode: action,
      openCommandPolicyFile: action,
      loadCommandPolicyLists: action,
      addCommandPolicyRule: action,
      deleteCommandPolicyRule: action,
      loadTools: action,
      loadSkills: action,
      openSkillsFolder: action,
      reloadSkills: action,
      createSkill: action,
      editSkill: action,
      deleteSkill: action,
      loadMemory: action,
      openMemoryFile: action,
      saveMemoryContent: action,
      loadAccessTokens: action,
      createAccessToken: action,
      deleteAccessToken: action,
      openCustomThemeFile: action,
      reloadCustomThemes: action,
      openMcpConfig: action,
      reloadMcpTools: action,
      setMcpToolEnabled: action,
      setBuiltInToolEnabled: action,
      setSkillEnabled: action,
      setMemoryEnabled: action,
      setRecursionLimit: action,
      setDebugMode: action,
      mobileWebStatus: observable,
      setMobileWebStatus: action,
      startMobileWeb: action,
      stopMobileWeb: action,
      setMobileWebPort: action,
      setWsGatewayAccess: action,
      setWsGatewayPort: action,
      setWsGatewayCidrs: action,
      setWsGatewayCustomCidrs: action,
      setRuntimeThinkingCorrectionEnabled: action,
      setTaskFinishGuardEnabled: action,
      setFirstTurnThinkingModelEnabled: action,
      setExecCommandActionModelEnabled: action,
      setWriteStdinActionModelEnabled: action,
      saveCurrentAgentSetting: action,
      applyAgentSetting: action,
      deleteAgentSetting: action,
      clearAgentSettingWarnings: action,
      sendChatMessage: action,
      materializeTransferredTabs: action,
      ensureTabInventoryEntry: action,
      hydrateTransferredTabs: action,
      hydrateTransferredTabEntry: action,
      openChatSessionFromHistory: action,
      openFileEditorFromFileSystem: action,
      onPanelRemoved: action,
      suppressTabs: action,
      unsuppressTabs: action,
      getUniqueTitle: action,
      loadVersionState: action,
      checkVersion: action,
      closeVersionUpdateDialog: action,
      openVersionDownload: action,
      reconcileTerminalTabs: action,
      setMonitorEnabled: action,
    });
    this.chat.setQueueRunner((sessionId, input) =>
      this.sendChatMessage(sessionId, input, { mode: "queue" }),
    );
    this.chat.setSessionsChangedListener((sessionIds) =>
      this.handleChatSessionsChanged(sessionIds),
    );
    this.lastKnownChatSessionIds = new Set(
      this.chat.sessions.map((session) => session.id),
    );
  }

  getMonitorTerminalState(terminalId: string): MonitorTerminalState | null {
    return this.monitorStateByTerminalId[terminalId] || null;
  }

  private normalizeMonitorEnabledSources(keys: unknown[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    keys.forEach((value) => {
      const rawKey = typeof value === "string" ? value.trim() : "";
      if (!rawKey) {
        return;
      }
      const key = rawKey === "local" ? LOCAL_MONITOR_SOURCE_KEY : rawKey;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      normalized.push(key);
    });
    return normalized;
  }

  private persistMonitorEnabledSources(): void {
    void window.gyshell?.uiSettings
      ?.set({
        monitorEnabledSources: [...this.monitorEnabledSources],
      })
      .catch(() => {});
  }

  resolveMonitorSourceKey(tab: TerminalTabModel): string {
    if (tab.monitorIdentity) return tab.monitorIdentity;
    const derivedIdentity = deriveMonitorIdentityFromConfig(tab.config);
    if (derivedIdentity) return derivedIdentity;
    return tab.connectionRef?.entryId || tab.id;
  }

  isMonitorSourceEnabled(terminalId: string): boolean {
    const tab = this.terminalTabs.find((entry) => entry.id === terminalId);
    if (!tab) return false;
    const key = this.resolveMonitorSourceKey(tab);
    return this.monitorEnabledSources.includes(key);
  }

  setMonitorEnabled(terminalId: string, enabled: boolean): void {
    const tab = this.terminalTabs.find((entry) => entry.id === terminalId);
    if (!tab) return;
    const key = this.resolveMonitorSourceKey(tab);

    if (enabled && !this.monitorEnabledSources.includes(key)) {
      this.monitorEnabledSources = [...this.monitorEnabledSources, key];
    } else if (!enabled) {
      this.monitorEnabledSources = this.monitorEnabledSources.filter(
        (k) => k !== key,
      );
    }
    this.monitorEnabledSources = this.normalizeMonitorEnabledSources(
      this.monitorEnabledSources,
    );

    this.syncMonitorSessions();
    this.persistMonitorEnabledSources();
  }

  private getAssignedMonitorTabIds(): string[] {
    const availableMonitorIds = new Set(this.monitorTabs.map((tab) => tab.id));
    const suppressedMonitorIds = this.suppressedTabIdsByKind.monitor;
    return (this.collectAssignedTabsByKind().monitor || []).filter(
      (terminalId) =>
        availableMonitorIds.has(terminalId) &&
        !suppressedMonitorIds.has(terminalId),
    );
  }

  private ensureMonitorListener(): void {
    if (
      this.monitorSnapshotUnsubscribe ||
      typeof window === "undefined" ||
      !window.gyshell?.monitor
    ) {
      return;
    }
    this.monitorSnapshotUnsubscribe = window.gyshell.monitor.onSnapshot(
      (snapshot: MonitorSnapshot) => {
        runInAction(() => {
          this.applyMonitorSnapshot(snapshot);
        });
      },
    );
  }

  private syncMonitorSnapshotSubscriptions(): void {
    if (
      !this.isBootstrapped ||
      typeof window === "undefined" ||
      !window.gyshell?.monitor
    ) {
      return;
    }

    const desiredSubscriptionIds = new Set(this.getAssignedMonitorTabIds());

    const nextMonitorState = { ...this.monitorStateByTerminalId };
    let stateChanged = false;
    Object.keys(nextMonitorState).forEach((terminalId) => {
      if (desiredSubscriptionIds.has(terminalId)) {
        return;
      }
      delete nextMonitorState[terminalId];
      stateChanged = true;
    });
    if (stateChanged) {
      this.monitorStateByTerminalId = nextMonitorState;
    }

    Array.from(this.monitorSubscribedTabIds).forEach((terminalId) => {
      if (desiredSubscriptionIds.has(terminalId)) {
        return;
      }
      this.monitorSubscribedTabIds.delete(terminalId);
      void window.gyshell.monitor.unsubscribe(terminalId).catch(() => {
        // Ignore unsubscribe failures; window-scoped delivery is best-effort.
      });
    });

    desiredSubscriptionIds.forEach((terminalId) => {
      if (this.monitorSubscribedTabIds.has(terminalId)) {
        return;
      }
      this.monitorSubscribedTabIds.add(terminalId);
      void window.gyshell.monitor.subscribe(terminalId).catch(() => {
        this.monitorSubscribedTabIds.delete(terminalId);
      });
    });
  }

  private syncMonitorSessions(): void {
    if (
      !this.isBootstrapped ||
      typeof window === "undefined" ||
      !window.gyshell?.monitor
    ) {
      return;
    }

    this.syncMonitorSnapshotSubscriptions();

    const enabledSourceSet = new Set(this.monitorEnabledSources);
    const assignedTabsBySource = new Map<string, TerminalTabModel[]>();

    this.getAssignedMonitorTabIds().forEach((terminalId) => {
      const tab = this.terminalTabs.find((entry) => entry.id === terminalId);
      if (!tab) {
        return;
      }
      const sourceKey = this.resolveMonitorSourceKey(tab);
      if (!enabledSourceSet.has(sourceKey)) {
        return;
      }
      const existingTabs = assignedTabsBySource.get(sourceKey);
      if (existingTabs) {
        existingTabs.push(tab);
      } else {
        assignedTabsBySource.set(sourceKey, [tab]);
      }
    });

    const desiredMonitorIdOrder: string[] = [];
    const desiredMonitorIdSet = new Set<string>();
    const addDesiredMonitorId = (terminalId: string): void => {
      if (desiredMonitorIdSet.has(terminalId)) {
        return;
      }
      desiredMonitorIdSet.add(terminalId);
      desiredMonitorIdOrder.push(terminalId);
    };

    assignedTabsBySource.forEach((assignedTabs, sourceKey) => {
      const readyRepresentative =
        assignedTabs.find((tab) => tab.runtimeState === "ready") ||
        this.monitorTabs.find(
          (tab) =>
            tab.runtimeState === "ready" &&
            this.resolveMonitorSourceKey(tab) === sourceKey,
        );
      if (!readyRepresentative) {
        return;
      }
      addDesiredMonitorId(readyRepresentative.id);
      assignedTabs.forEach((tab) => {
        addDesiredMonitorId(tab.id);
      });
    });

    Array.from(this.monitorRetainedTabIds).forEach((terminalId) => {
      if (desiredMonitorIdSet.has(terminalId)) {
        return;
      }
      this.monitorRetainedTabIds.delete(terminalId);
      void window.gyshell.monitor.stop(terminalId).catch(() => {
        // Ignore stop failures; the backend session is best-effort.
      });
    });

    desiredMonitorIdOrder.forEach((terminalId) => {
      if (this.monitorRetainedTabIds.has(terminalId)) {
        return;
      }
      this.monitorRetainedTabIds.add(terminalId);
      void window.gyshell.monitor
        .start(terminalId, MONITOR_POLL_INTERVAL_MS)
        .catch(() => {
          this.monitorRetainedTabIds.delete(terminalId);
        });
    });
  }

  private applyMonitorSnapshot(snapshot: MonitorSnapshot): void {
    const terminalId = String(snapshot?.terminalId || "").trim();
    if (!terminalId) {
      return;
    }
    if (!this.monitorSubscribedTabIds.has(terminalId)) {
      return;
    }

    const currentState =
      this.monitorStateByTerminalId[terminalId] || createMonitorTerminalState();
    const nextState: MonitorTerminalState = {
      ...currentState,
      lastError: snapshot.error || null,
    };

    if (!snapshot.error) {
      nextState.snapshot = snapshot;
      if (typeof snapshot.cpu?.usagePercent === "number") {
        nextState.cpuHistory = appendMonitorHistoryValue(
          nextState.cpuHistory,
          snapshot.cpu.usagePercent,
        );
      }
      if (typeof snapshot.memory?.usagePercent === "number") {
        nextState.memoryHistory = appendMonitorHistoryValue(
          nextState.memoryHistory,
          snapshot.memory.usagePercent,
        );
      }
      if (snapshot.network && snapshot.network.length > 0) {
        const totals = snapshot.network.reduce(
          (
            acc: { rx: number; tx: number },
            entry: NonNullable<MonitorSnapshot["network"]>[number],
          ) => {
            acc.rx += Number.isFinite(entry.rxBytesPerSec)
              ? entry.rxBytesPerSec
              : 0;
            acc.tx += Number.isFinite(entry.txBytesPerSec)
              ? entry.txBytesPerSec
              : 0;
            return acc;
          },
          { rx: 0, tx: 0 },
        );
        nextState.rxHistory = appendMonitorHistoryValue(
          nextState.rxHistory,
          totals.rx,
        );
        nextState.txHistory = appendMonitorHistoryValue(
          nextState.txHistory,
          totals.tx,
        );
      }
    }

    this.monitorStateByTerminalId = {
      ...this.monitorStateByTerminalId,
      [terminalId]: nextState,
    };
  }

  getUniqueTitle(baseTitle: string): string {
    return this.getUniqueTerminalTitle(baseTitle);
  }

  private getUniqueTerminalTitle(
    baseTitle: string,
    options?: { excludeTabId?: string },
  ): string {
    const existingTitles = this.terminalTabs
      .filter((tab) => tab.id !== options?.excludeTabId)
      .map((tab) => tab.title);
    return resolveUniqueTerminalTitle(baseTitle, existingTitles);
  }

  get isDetachedWindow(): boolean {
    return this.windowRole === "detached";
  }

  shouldPersistLayout(): boolean {
    return !this.isDetachedWindow;
  }

  private getTerminalTabById(tabId: string): TerminalTabModel | null {
    return this.terminalTabs.find((tab) => tab.id === tabId) ?? null;
  }

  private supportsFilesystemForTabId(tabId: string): boolean {
    const terminalTab = this.getTerminalTabById(tabId);
    if (!terminalTab) {
      return false;
    }
    return terminalTab.capabilities.supportsFilesystem;
  }

  private getVisibilityLinkedKindsForTab(
    kind: PanelKind,
    tabId: string,
  ): WindowScopedTabKind[] {
    if (kind === "chat") {
      return ["chat"];
    }
    if (kind === "filesystem") {
      return ["terminal", "filesystem"];
    }
    if (kind === "monitor") {
      return ["terminal", "monitor"];
    }
    if (kind !== "terminal") {
      return [];
    }
    const linkedKinds: WindowScopedTabKind[] = ["terminal"];
    if (this.supportsFilesystemForTabId(tabId)) {
      linkedKinds.push("filesystem");
    }
    const tab = this.terminalTabs.find((t) => t.id === tabId);
    if (tab?.capabilities.supportsMonitor) {
      linkedKinds.push("monitor");
    }
    return linkedKinds;
  }

  getOwnedTabIds(kind: PanelKind): string[] {
    const filterByDetachedVisibility = (
      tabIds: string[],
      scopedKind: WindowScopedTabKind,
    ): string[] => {
      if (!this.isDetachedWindow || !this.detachedVisibleTabIdsByKind) {
        return tabIds;
      }
      const visibleSet = this.detachedVisibleTabIdsByKind[scopedKind];
      return tabIds.filter((tabId) => visibleSet.has(tabId));
    };

    if (kind === "terminal") {
      const hidden = this.suppressedTabIdsByKind.terminal;
      const tabIds = this.terminalTabs
        .map((tab) => tab.id)
        .filter((id) => !hidden.has(id));
      return filterByDetachedVisibility(tabIds, "terminal");
    }
    if (kind === "filesystem") {
      const hidden = this.suppressedTabIdsByKind.filesystem;
      const tabIds = this.fileSystemTabs
        .map((tab) => tab.id)
        .filter((id) => !hidden.has(id));
      return filterByDetachedVisibility(tabIds, "filesystem");
    }
    if (kind === "monitor") {
      const hidden = this.suppressedTabIdsByKind.monitor;
      const tabIds = this.monitorTabs
        .map((tab) => tab.id)
        .filter((id) => !hidden.has(id));
      return filterByDetachedVisibility(tabIds, "monitor");
    }
    if (kind === "chat") {
      const hidden = this.suppressedTabIdsByKind.chat;
      const tabIds = this.chat.sessions
        .map((session) => session.id)
        .filter((id) => !hidden.has(id));
      return filterByDetachedVisibility(tabIds, "chat");
    }
    return [];
  }

  getLayoutBindableTabIds(kind: PanelKind): string[] {
    const tabIds = this.getOwnedTabIds(kind);
    const scopedKind =
      kind === "chat" ||
      kind === "terminal" ||
      kind === "filesystem" ||
      kind === "monitor"
        ? kind
        : null;
    if (!scopedKind) {
      return tabIds;
    }
    const hidden = this.layoutHiddenTabIdsByKind[scopedKind];
    return tabIds.filter((tabId) => !hidden.has(tabId));
  }

  hideTabsFromLayout(kind: PanelKind, tabIds: string[]): void {
    const normalizedIds = tabIds
      .map((tabId) => String(tabId || "").trim())
      .filter((tabId) => tabId.length > 0);
    if (normalizedIds.length === 0) {
      return;
    }
    normalizedIds.forEach((tabId) => {
      this.getVisibilityLinkedKindsForTab(kind, tabId).forEach((targetKind) => {
        this.layoutHiddenTabIdsByKind[targetKind].add(tabId);
      });
    });
  }

  private hideTabsFromLayoutKinds(
    kinds: Iterable<WindowScopedTabKind>,
    tabIds: string[],
  ): void {
    const normalizedIds = tabIds
      .map((tabId) => String(tabId || "").trim())
      .filter((tabId) => tabId.length > 0);
    const targetKinds = Array.from(new Set(kinds));
    if (normalizedIds.length === 0 || targetKinds.length === 0) {
      return;
    }
    normalizedIds.forEach((tabId) => {
      targetKinds.forEach((targetKind) => {
        this.layoutHiddenTabIdsByKind[targetKind].add(tabId);
      });
    });
  }

  showTabsInLayout(kind: PanelKind, tabIds: string[]): void {
    const normalizedIds = tabIds
      .map((tabId) => String(tabId || "").trim())
      .filter((tabId) => tabId.length > 0);
    if (normalizedIds.length === 0) {
      return;
    }
    normalizedIds.forEach((tabId) => {
      this.getVisibilityLinkedKindsForTab(kind, tabId).forEach((targetKind) => {
        this.layoutHiddenTabIdsByKind[targetKind].delete(tabId);
      });
    });
  }

  private collectDetachedVisibleTabIdsByKind(
    layoutTree: LayoutTree | null | undefined,
  ): Record<WindowScopedTabKind, Set<string>> | null {
    if (!this.isDetachedWindow) {
      return null;
    }
    if (!layoutTree) {
      return {
        chat: new Set<string>(),
        terminal: new Set<string>(),
        filesystem: new Set<string>(),
        monitor: new Set<string>(),
      };
    }

    const sets: Record<WindowScopedTabKind, Set<string>> = {
      chat: new Set<string>(),
      terminal: new Set<string>(),
      filesystem: new Set<string>(),
      monitor: new Set<string>(),
    };
    const panelKindById = new Map(
      listPanels(layoutTree).map(
        (panel) => [panel.panel.id, panel.panel.kind] as const,
      ),
    );

    Object.entries(layoutTree.panelTabs || {}).forEach(([panelId, binding]) => {
      const panelKind = panelKindById.get(panelId);
      if (!panelKind) {
        return;
      }
      const tabIds = Array.isArray(binding?.tabIds) ? binding.tabIds : [];
      tabIds.forEach((tabId) => {
        const normalized = typeof tabId === "string" ? tabId.trim() : "";
        if (!normalized) return;
        this.getVisibilityLinkedKindsForTab(panelKind, normalized).forEach(
          (targetKind) => {
            sets[targetKind].add(normalized);
          },
        );
      });
    });

    return sets;
  }

  private updateDetachedVisibleTabIds(
    kind: PanelKind,
    tabIds: string[],
    mode: "add" | "delete",
  ): boolean {
    if (!this.isDetachedWindow || !this.detachedVisibleTabIdsByKind) {
      return false;
    }

    const normalizedIds = tabIds
      .map((tabId) => String(tabId || "").trim())
      .filter((tabId) => tabId.length > 0);
    if (normalizedIds.length === 0) {
      return false;
    }

    let changed = false;
    normalizedIds.forEach((tabId) => {
      this.getVisibilityLinkedKindsForTab(kind, tabId).forEach((targetKind) => {
        const setRef = this.detachedVisibleTabIdsByKind?.[targetKind];
        if (!setRef) return;
        if (mode === "add") {
          if (setRef.has(tabId)) return;
          setRef.add(tabId);
          changed = true;
          return;
        }
        if (!setRef.delete(tabId)) return;
        changed = true;
      });
    });
    return changed;
  }

  private handleChatSessionsChanged(sessionIds: string[]): void {
    const normalizedIds = sessionIds
      .map((sessionId) => String(sessionId || "").trim())
      .filter((sessionId) => sessionId.length > 0);
    const nextIds = new Set(normalizedIds);
    const addedIds = normalizedIds.filter(
      (sessionId) => !this.lastKnownChatSessionIds.has(sessionId),
    );
    const removedIds = Array.from(this.lastKnownChatSessionIds).filter(
      (sessionId) => !nextIds.has(sessionId),
    );

    // Detached chat windows keep a visibility filter separate from the global
    // chat inventory. Newly created sessions must be added here immediately or
    // the window creates the tab and then hides it from itself.
    if (addedIds.length > 0) {
      this.updateDetachedVisibleTabIds("chat", addedIds, "add");
    }
    if (removedIds.length > 0) {
      this.updateDetachedVisibleTabIds("chat", removedIds, "delete");
    }

    this.lastKnownChatSessionIds = nextIds;
    this.layout.syncPanelBindings();
  }

  private upsertTransferredTerminalTab(
    snapshot: WindowingTerminalTabSnapshot,
  ): void {
    const normalizedId = String(snapshot.id || "").trim();
    if (!normalizedId) {
      return;
    }
    const title = this.getUniqueTerminalTitle(
      normalizeTerminalTitle(snapshot.title, normalizedId),
      { excludeTabId: normalizedId },
    );
    const config = {
      ...snapshot.config,
      title,
    } as TerminalConfig;
    const nextTab: TerminalTabModel = {
      id: normalizedId,
      title,
      config,
      capabilities: resolveTerminalConnectionCapabilities(config),
      ...(snapshot.connectionRef
        ? { connectionRef: snapshot.connectionRef }
        : {}),
      ...(snapshot.runtimeState ? { runtimeState: snapshot.runtimeState } : {}),
      ...(typeof snapshot.lastExitCode === "number"
        ? { lastExitCode: snapshot.lastExitCode }
        : {}),
    };
    this.terminalTabs = upsertById(this.terminalTabs, nextTab);
    if (!this.activeTerminalId) {
      this.activeTerminalId = normalizedId;
    }
  }

  ensureTabInventoryEntry(
    kind: PanelKind,
    tabId: string,
    options?: {
      terminalTab?: WindowingTerminalTabSnapshot;
    },
  ): void {
    const normalizedTabId = String(tabId || "").trim();
    if (!normalizedTabId) {
      return;
    }
    if (kind === "chat") {
      // Chat sessions are not backed by a shared runtime inventory like terminal
      // tabs. When a newly created chat tab crosses into another window, materialize
      // a placeholder session immediately so the target layout can render it before
      // any later backend/history hydration happens.
      this.chat.ensureSession(normalizedTabId);
      return;
    }
    if (
      (kind === "terminal" || kind === "filesystem" || kind === "monitor") &&
      options?.terminalTab?.id === normalizedTabId
    ) {
      // Terminal/filesystem tabs share backend inventory, but a target renderer
      // may still be one onTabsUpdated tick behind when a tab is dragged across
      // windows. Seed a lightweight placeholder so syncPanelBindings() does not
      // strip the transferred tab before backend state catches up.
      this.upsertTransferredTerminalTab(options.terminalTab);
    }
  }

  materializeTransferredTabs(
    kind: PanelKind,
    tabIds: string[],
    options?: {
      terminalTabs?: WindowingTerminalTabSnapshot[];
    },
  ): string[] {
    const normalizedTabIds = Array.from(
      new Set(
        (tabIds || [])
          .map((tabId) => String(tabId || "").trim())
          .filter((tabId) => tabId.length > 0),
      ),
    );
    if (normalizedTabIds.length === 0) {
      return normalizedTabIds;
    }
    const terminalTabById = new Map(
      (options?.terminalTabs || [])
        .map(
          (terminalTab) =>
            [String(terminalTab.id || "").trim(), terminalTab] as const,
        )
        .filter(([tabId]) => tabId.length > 0),
    );
    // Cross-window transferred tabs must create owner inventory entries before
    // any layout sync runs, otherwise syncPanelBindings() can strip them back
    // out of the restored binding as "unknown" ids.
    normalizedTabIds.forEach((tabId) => {
      this.ensureTabInventoryEntry(kind, tabId, {
        terminalTab: terminalTabById.get(tabId),
      });
    });
    return normalizedTabIds;
  }

  hydrateTransferredTabEntry(kind: PanelKind, tabId: string): void {
    const normalizedTabId = String(tabId || "").trim();
    if (!normalizedTabId || kind !== "chat") {
      return;
    }
    const session = this.chat.getSessionById(normalizedTabId);
    if (session && session.messageIds.length > 0) {
      return;
    }
    this.chat.ensureSession(normalizedTabId);
    void this.chat
      .hydrateSessionFromBackend(normalizedTabId, {
        activate: false,
        loadAgentContext: false,
      })
      .catch(() => {
        // A brand-new local chat may not exist in backend history yet. Keep the
        // placeholder session so cross-window tab/panel moves still succeed.
      });
  }

  hydrateTransferredTabs(kind: PanelKind, tabIds: string[]): string[] {
    const normalizedTabIds = Array.from(
      new Set(
        (tabIds || [])
          .map((tabId) => String(tabId || "").trim())
          .filter((tabId) => tabId.length > 0),
      ),
    );
    normalizedTabIds.forEach((tabId) => {
      this.hydrateTransferredTabEntry(kind, tabId);
    });
    return normalizedTabIds;
  }

  suppressTabs(
    kind: PanelKind,
    tabIds: string[],
    options?: { syncLayout?: boolean },
  ): void {
    if (!Array.isArray(tabIds) || tabIds.length === 0) return;
    const shouldSyncLayout = options?.syncLayout !== false;
    const targetKinds = resolveSuppressionKinds(kind);
    if (targetKinds.length === 0) return;

    let changed = false;
    const normalizedIds = tabIds
      .map((tabId) => String(tabId || "").trim())
      .filter((tabId) => tabId.length > 0);
    if (normalizedIds.length === 0) return;

    targetKinds.forEach((targetKind) => {
      const setRef = this.suppressedTabIdsByKind[targetKind];
      normalizedIds.forEach((tabId) => {
        if (setRef.has(tabId)) return;
        setRef.add(tabId);
        changed = true;
      });
    });
    if (this.updateDetachedVisibleTabIds(kind, normalizedIds, "delete")) {
      changed = true;
    }
    if (changed && kind === "chat") {
      normalizedIds.forEach((tabId) =>
        this.chat.unregisterSessionOwnership(tabId),
      );
    }
    if (changed && shouldSyncLayout) {
      this.layout.syncPanelBindings();
    }
    if (changed) {
      this.syncMonitorSessions();
    }
  }

  unsuppressTabs(
    kind: PanelKind,
    tabIds: string[],
    options?: { syncLayout?: boolean },
  ): void {
    if (!Array.isArray(tabIds) || tabIds.length === 0) return;
    const shouldSyncLayout = options?.syncLayout !== false;
    const targetKinds = resolveSuppressionKinds(kind);
    if (targetKinds.length === 0) return;

    let changed = false;
    const normalizedIds = tabIds
      .map((tabId) => String(tabId || "").trim())
      .filter((tabId) => tabId.length > 0);
    if (normalizedIds.length === 0) return;

    targetKinds.forEach((targetKind) => {
      const setRef = this.suppressedTabIdsByKind[targetKind];
      normalizedIds.forEach((tabId) => {
        if (!setRef.delete(tabId)) return;
        changed = true;
      });
    });
    if (this.updateDetachedVisibleTabIds(kind, normalizedIds, "add")) {
      changed = true;
    }
    if (changed && kind === "chat") {
      normalizedIds.forEach((tabId) =>
        this.chat.registerSessionOwnership(tabId),
      );
    }
    if (changed && shouldSyncLayout) {
      this.layout.syncPanelBindings();
    }
    if (changed) {
      this.syncMonitorSessions();
    }
  }

  collectAssignedTabsByKind(): Partial<
    Record<"chat" | "terminal" | "filesystem" | "monitor", string[]>
  > {
    const collectForKind = (
      kind: Extract<PanelKind, "chat" | "terminal" | "filesystem" | "monitor">,
    ): string[] => {
      const ids = new Set<string>();
      this.layout.getPanelIdsByKind(kind).forEach((panelId) => {
        this.layout.getPanelTabIds(panelId).forEach((tabId) => {
          const normalized = String(tabId || "").trim();
          if (!normalized) return;
          ids.add(normalized);
        });
      });
      return Array.from(ids);
    };

    return {
      chat: collectForKind("chat"),
      terminal: collectForKind("terminal"),
      filesystem: collectForKind("filesystem"),
      monitor: collectForKind("monitor"),
    };
  }

  get isSettings(): boolean {
    return this.view === "settings";
  }

  get isConnections(): boolean {
    return this.view === "connections";
  }

  get activeTerminal(): TerminalTabModel | null {
    if (!this.activeTerminalId) return null;
    return (
      this.terminalTabs.find((t) => t.id === this.activeTerminalId) ?? null
    );
  }

  get fileSystemTabs(): TerminalTabModel[] {
    return this.terminalTabs.filter(
      (tab) => tab.capabilities.supportsFilesystem,
    );
  }

  get monitorTabs(): TerminalTabModel[] {
    return this.terminalTabs.filter((tab) => tab.capabilities.supportsMonitor);
  }

  get panelTabDisplayMode(): PanelTabDisplayModePreference {
    return (
      this.settings?.panelTabs?.displayMode ?? DEFAULT_PANEL_TAB_DISPLAY_MODE
    );
  }

  get chatDisplayMode(): "classic" | "seamless" {
    return this.settings?.chat?.displayMode ?? "classic";
  }

  get preventSleepWhileRunning(): boolean {
    return this.settings?.runtime?.preventSleepWhileRunning !== false;
  }

  get agentSettingState(): AgentSettingState {
    return (
      this.settings?.agentSettings ?? {
        profiles: [],
        activeProfileId: null,
      }
    );
  }

  get commandDraftProfileId(): string {
    const profiles = this.settings?.models?.profiles ?? [];
    const storedId = String(
      this.settings?.commandDraft?.profileId || "",
    ).trim();
    if (storedId && profiles.some((profile) => profile.id === storedId)) {
      return storedId;
    }
    return profiles[0]?.id || "";
  }

  private collectPersistedChatInventoryState(
    layout: AppSettings["layout"] | undefined,
  ): {
    tabIds: string[];
    preferredActiveTabId: string | null;
  } {
    const emptyState = {
      tabIds: [],
      preferredActiveTabId: null,
    };

    try {
      const tree = buildLayoutTree(layout);
      const chatPanels = listPanels(tree).filter(
        (panel) => panel.panel.kind === "chat",
      );
      const chatPanelIds = chatPanels.map((panel) => panel.panel.id);
      if (chatPanelIds.length === 0) {
        return emptyState;
      }

      const chatPanelSet = new Set(chatPanelIds);
      const chatBindings = chatPanelIds.map((panelId) => {
        const binding = tree.panelTabs?.[panelId];
        const tabIds = Array.isArray(binding?.tabIds)
          ? binding.tabIds.filter(
              (tabId): tabId is string =>
                typeof tabId === "string" && tabId.length > 0,
            )
          : [];
        const activeTabId =
          typeof binding?.activeTabId === "string" &&
          tabIds.includes(binding.activeTabId)
            ? binding.activeTabId
            : null;
        return {
          panelId,
          tabIds,
          activeTabId,
        };
      });
      const seen = new Set<string>();
      const tabIds: string[] = [];

      chatBindings.forEach(({ tabIds: bindingTabIds }) => {
        bindingTabIds.forEach((tabId) => {
          if (seen.has(tabId)) return;
          seen.add(tabId);
          tabIds.push(tabId);
        });
      });

      const focusedActiveTabId = (() => {
        const focusedPanelId = tree.focusedPanelId;
        if (!focusedPanelId || !chatPanelSet.has(focusedPanelId)) {
          return null;
        }
        return (
          chatBindings.find((binding) => binding.panelId === focusedPanelId)
            ?.activeTabId || null
        );
      })();

      const fallbackActiveTabId =
        chatBindings.find((binding) => !!binding.activeTabId)?.activeTabId ||
        null;
      const preferredActiveTabId =
        focusedActiveTabId || fallbackActiveTabId || tabIds[0] || null;

      return {
        tabIds,
        preferredActiveTabId,
      };
    } catch {
      return emptyState;
    }
  }

  private isFirstLaunchDefaultLayout(
    layout: AppSettings["layout"] | undefined,
  ): boolean {
    if (!layout) return true;
    if (layout.v2) return false;
    const panelOrder = Array.isArray(layout.panelOrder)
      ? layout.panelOrder
      : [];
    if (panelOrder.length === 0) {
      return true;
    }
    if (panelOrder.length !== 2) {
      return false;
    }
    return panelOrder[0] === "chat" && panelOrder[1] === "terminal";
  }

  private toTerminalConfig(item: {
    id: string;
    title: string;
    type: TerminalConfig["type"];
    cols: number;
    rows: number;
  }): TerminalConfig {
    return {
      type: item.type,
      id: item.id,
      title: item.title,
      cols: item.cols > 0 ? item.cols : 80,
      rows: item.rows > 0 ? item.rows : 24,
    } as TerminalConfig;
  }

  reconcileTerminalTabs(payload: TerminalListPayload): void {
    const firstHydration = this.terminalTabsHydrated !== true;
    const incoming = payload?.terminals || [];
    const incomingIds = incoming
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (firstHydration) {
      const unresolvedPanelIds = this.layout.getPanelsWithMissingTabBindings(
        "terminal",
        incomingIds,
      );
      this.layout.pinPanelsAsRestorePlaceholder(unresolvedPanelIds);
    }
    const existingById = new Map(this.terminalTabs.map((tab) => [tab.id, tab]));
    let nextMonitorEnabledSources = this.monitorEnabledSources;
    const usedTitles = new Set<string>();
    const allocateIncomingTitle = (
      item: TerminalListEntry,
      existing: TerminalTabModel | undefined,
    ): string => {
      const backendTitle = normalizeTerminalTitle(item.title, item.id);
      if (!usedTitles.has(backendTitle)) {
        usedTitles.add(backendTitle);
        return backendTitle;
      }

      const existingTitle = existing
        ? normalizeTerminalTitle(existing.title, "")
        : "";
      if (existingTitle && !usedTitles.has(existingTitle)) {
        usedTitles.add(existingTitle);
        return existingTitle;
      }

      const uniqueTitle = resolveUniqueTerminalTitle(backendTitle, usedTitles);
      usedTitles.add(uniqueTitle);
      return uniqueTitle;
    };
    const nextTabs: TerminalTabModel[] = incoming.map((item) => {
      const existing = existingById.get(item.id);
      const title = allocateIncomingTitle(item, existing);
      if (existing) {
        if (item.monitorIdentity) {
          const previousSourceKey = this.resolveMonitorSourceKey(existing);
          if (previousSourceKey !== item.monitorIdentity) {
            const remappedMonitorSources = nextMonitorEnabledSources.map(
              (key) =>
                key === previousSourceKey ? item.monitorIdentity! : key,
            );
            nextMonitorEnabledSources = this.normalizeMonitorEnabledSources(
              remappedMonitorSources,
            );
          }
        }
        return {
          ...existing,
          title,
          runtimeState: item.runtimeState,
          lastExitCode: item.lastExitCode,
          remoteOs: item.remoteOs ?? existing.remoteOs,
          systemInfo: item.systemInfo ?? existing.systemInfo,
          monitorIdentity: item.monitorIdentity ?? existing.monitorIdentity,
          capabilities: resolveTerminalConnectionCapabilities({
            type: item.type,
          }),
          config: {
            ...existing.config,
            title,
            cols: item.cols > 0 ? item.cols : existing.config.cols,
            rows: item.rows > 0 ? item.rows : existing.config.rows,
          },
        };
      }
      return {
        id: item.id,
        title,
        config: this.toTerminalConfig({ ...item, title }),
        capabilities: resolveTerminalConnectionCapabilities({
          type: item.type,
        }),
        connectionRef: item.type === "local" ? { type: "local" } : undefined,
        monitorIdentity: item.monitorIdentity,
        runtimeState: item.runtimeState,
        lastExitCode: item.lastExitCode,
        remoteOs: item.remoteOs,
        systemInfo: item.systemInfo,
      };
    });

    let nextActive = this.activeTerminalId;
    if (!nextActive || !nextTabs.some((tab) => tab.id === nextActive)) {
      nextActive = nextTabs[0]?.id || null;
    }

    this.terminalTabs = nextTabs;
    this.terminalTabsHydrated = true;
    this.activeTerminalId = nextActive;
    if (nextMonitorEnabledSources !== this.monitorEnabledSources) {
      this.monitorEnabledSources = nextMonitorEnabledSources;
      this.persistMonitorEnabledSources();
    }
    this.layout.syncPanelBindings();
    this.syncMonitorSessions();
  }

  private async fetchCombinedSettings(): Promise<AppSettings> {
    const [backendSettings, uiSettings] = await Promise.all([
      window.gyshell.settings.get(),
      window.gyshell.uiSettings.get(),
    ]);
    return {
      ...backendSettings,
      ...uiSettings,
    };
  }

  private applySkillStatusUpdate(updates: SkillStatusSummary[]): void {
    const enabledByName = new Map<string, boolean>();
    updates.forEach((item) => {
      if (!item?.name) return;
      enabledByName.set(item.name, item.enabled !== false);
    });
    if (enabledByName.size === 0) return;

    this.skills = this.skills.map((skill) =>
      enabledByName.has(skill.name)
        ? {
            ...skill,
            enabled: enabledByName.get(skill.name),
          }
        : skill,
    );

    if (!this.settings) return;
    const nextToolsSkills = { ...(this.settings.tools?.skills ?? {}) };
    enabledByName.forEach((enabled, name) => {
      nextToolsSkills[name] = enabled;
    });
    this.settings = {
      ...this.settings,
      tools: {
        builtIn: this.settings.tools?.builtIn ?? {},
        skills: nextToolsSkills,
      },
    };
  }

  private applyBuiltInToolStatusUpdate(tools: BuiltInToolSummary[]): void {
    this.builtInTools = tools;
    if (!this.settings) return;
    const nextToolsBuiltIn = { ...(this.settings.tools?.builtIn ?? {}) };
    tools.forEach((tool) => {
      nextToolsBuiltIn[tool.name] = tool.enabled;
    });
    this.settings = {
      ...this.settings,
      tools: {
        builtIn: nextToolsBuiltIn,
        skills: this.settings.tools?.skills ?? {},
      },
    };
  }

  private applyAgentSettingOperationResult(
    result: AgentSettingOperationResult,
  ): void {
    runInAction(() => {
      this.applyBackendSettingsUpdate(result.settings);
      this.commandPolicyLists = result.commandPolicyLists;
      this.mcpTools = result.mcpTools;
      this.memoryFilePath = result.memory.filePath;
      this.memoryContent = result.memory.content;
      this.agentSettingWarnings = Array.isArray(result.warnings)
        ? [...result.warnings]
        : [];
      this.applyBuiltInToolStatusUpdate(result.builtInTools);
      this.applySkillStatusUpdate(result.skills);
    });
  }

  private applyBackendSettingsUpdate(settings: Partial<AppSettings>): void {
    this.settings = {
      ...(this.settings || ({} as AppSettings)),
      ...settings,
    };
  }

  private applyCommandPolicyListsUpdate(lists: CommandPolicyLists): void {
    this.commandPolicyLists = lists;
  }

  private applyMemorySnapshotUpdate(snapshot: MemorySnapshot): void {
    this.memoryFilePath = snapshot.filePath;
    this.memoryContent = snapshot.content;
  }

  clearAgentSettingWarnings(): void {
    this.agentSettingWarnings = [];
  }

  async saveCurrentAgentSetting(): Promise<AgentSettingOperationResult> {
    const result = await window.gyshell.agentSettings.saveCurrent();
    this.applyAgentSettingOperationResult(result);
    return result;
  }

  async applyAgentSetting(
    profileId: string,
    acknowledgedExperimentalToolNames: string[] = [],
  ): Promise<AgentSettingApplyResult> {
    const result = await window.gyshell.agentSettings.apply(
      profileId,
      acknowledgedExperimentalToolNames,
    );
    if (!("kind" in result)) {
      this.applyAgentSettingOperationResult(result);
    }
    return result;
  }

  async deleteAgentSetting(
    profileId: string,
  ): Promise<AgentSettingOperationResult> {
    const result = await window.gyshell.agentSettings.delete(profileId);
    this.applyAgentSettingOperationResult(result);
    return result;
  }

  openSettings(): void {
    this.view = "settings";
  }

  closeSettings(): void {
    this.view = "main";
  }

  toggleSettings(): void {
    this.view = this.view === "settings" ? "main" : "settings";
  }

  openConnections(): void {
    this.view = "connections";
  }

  closeOverlay(): void {
    this.view = "main";
  }

  setSettingsSection(section: SettingsSection): void {
    this.settingsSection = section;
  }

  async loadVersionState(): Promise<void> {
    try {
      const state = await window.gyshell.version.getState();
      runInAction(() => {
        this.versionInfo = state;
      });
    } catch (err) {
      console.error("Failed to load version state", err);
    }
  }

  async checkVersion(options?: {
    showPopupOnVersionChange?: boolean;
  }): Promise<void> {
    if (this.versionCheckInProgress) return;
    runInAction(() => {
      this.versionCheckInProgress = true;
    });
    try {
      const result = await window.gyshell.version.check();
      runInAction(() => {
        this.versionInfo = result;
        const hasVersionDifference =
          result.status !== "error" &&
          typeof result.latestVersion === "string" &&
          result.latestVersion.length > 0 &&
          result.latestVersion !== result.currentVersion;
        const shouldShowPopup = options?.showPopupOnVersionChange ?? true;
        if (hasVersionDifference && shouldShowPopup) {
          this.showVersionUpdateDialog = true;
        }
      });
    } catch (err) {
      console.error("Failed to check version", err);
    } finally {
      runInAction(() => {
        this.versionCheckInProgress = false;
      });
    }
  }

  closeVersionUpdateDialog(): void {
    this.showVersionUpdateDialog = false;
  }

  async openVersionDownload(): Promise<void> {
    const url = this.versionInfo?.downloadUrl;
    if (!url) return;
    await window.gyshell.system.openExternal(url);
  }

  async setLanguage(lang: AppLanguage): Promise<void> {
    this.i18n.setLocale(lang);
    runInAction(() => {
      if (this.settings) {
        this.settings = { ...this.settings, language: lang };
      }
    });
    await window.gyshell.uiSettings.set({ language: lang });
  }

  async setTerminalSettings(
    terminal: Partial<AppSettings["terminal"]>,
  ): Promise<void> {
    let nextTerminal: AppSettings["terminal"] | undefined;
    runInAction(() => {
      if (this.settings) {
        this.settings.terminal = {
          ...this.settings.terminal,
          ...terminal,
        };
        nextTerminal = toJS(this.settings.terminal);
      }
    });
    if (nextTerminal) {
      await window.gyshell.uiSettings.set({ terminal: nextTerminal });
    }
  }

  async setPanelTabDisplayMode(
    displayMode: PanelTabDisplayModePreference,
  ): Promise<void> {
    const nextPanelTabs = { displayMode };
    runInAction(() => {
      if (!this.settings) return;
      this.settings = {
        ...this.settings,
        panelTabs: nextPanelTabs,
      };
    });
    await window.gyshell.uiSettings.set({ panelTabs: nextPanelTabs });
  }

  async setChatDisplayMode(displayMode: "classic" | "seamless"): Promise<void> {
    const nextChat = { displayMode };
    runInAction(() => {
      if (!this.settings) return;
      this.settings = {
        ...this.settings,
        chat: nextChat,
      };
    });
    await window.gyshell.uiSettings.set({ chat: nextChat });
  }

  async setPreventSleepWhileRunning(enabled: boolean): Promise<void> {
    const nextRuntime = {
      ...(this.settings?.runtime || {}),
      preventSleepWhileRunning: enabled,
    };
    runInAction(() => {
      if (!this.settings) return;
      this.settings = {
        ...this.settings,
        runtime: nextRuntime,
      };
    });
    await window.gyshell.uiSettings.set({ runtime: nextRuntime });
  }

  async setCommandDraftProfileId(profileId: string): Promise<void> {
    const nextCommandDraft = {
      profileId,
    };
    runInAction(() => {
      if (!this.settings) return;
      this.settings = {
        ...this.settings,
        commandDraft: nextCommandDraft,
      };
    });
    await window.gyshell.uiSettings.set({ commandDraft: nextCommandDraft });
  }

  async setThemeId(themeId: string): Promise<void> {
    // optimistic UI: apply immediately
    const theme = resolveTheme(themeId, this.customThemes);
    applyAppThemeFromTerminalScheme(theme.terminal);
    const xtermTheme = toXtermTheme(theme.terminal, {
      transparentBackground: true,
    });
    runInAction(() => {
      this.xtermTheme = xtermTheme;
      if (this.settings) {
        this.settings = { ...this.settings, themeId };
      }
    });

    try {
      await window.gyshell.uiSettings.set({ themeId });
    } catch (err) {
      console.error("Failed to persist themeId", err);
      // best-effort rollback by reloading
      try {
        const [backendSettings, uiSettings] = await Promise.all([
          window.gyshell.settings.get(),
          window.gyshell.uiSettings.get(),
        ]);
        const settings = {
          ...backendSettings,
          ...uiSettings,
        };
        const t = resolveTheme(settings.themeId, this.customThemes);
        applyAppThemeFromTerminalScheme(t.terminal);
        runInAction(() => {
          this.settings = settings;
          this.xtermTheme = toXtermTheme(t.terminal, {
            transparentBackground: true,
          });
        });
      } catch {
        // ignore
      }
    }
  }

  async setCommandPolicyMode(
    mode: AppSettings["commandPolicyMode"],
  ): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings = { ...this.settings, commandPolicyMode: mode };
      }
    });
    await window.gyshell.settings.set({ commandPolicyMode: mode });
  }

  async openCommandPolicyFile(): Promise<void> {
    await window.gyshell.settings.openCommandPolicyFile();
  }

  async loadCommandPolicyLists(): Promise<void> {
    try {
      const lists = await window.gyshell.settings.getCommandPolicyLists();
      runInAction(() => {
        this.commandPolicyLists = lists;
      });
    } catch (err) {
      console.error("Failed to load command policy lists", err);
    }
  }

  async addCommandPolicyRule(
    listName: "allowlist" | "denylist" | "asklist",
    rule: string,
  ): Promise<void> {
    const lists = await window.gyshell.settings.addCommandPolicyRule(
      listName,
      rule,
    );
    runInAction(() => {
      this.commandPolicyLists = lists;
    });
  }

  async deleteCommandPolicyRule(
    listName: "allowlist" | "denylist" | "asklist",
    rule: string,
  ): Promise<void> {
    const lists = await window.gyshell.settings.deleteCommandPolicyRule(
      listName,
      rule,
    );
    runInAction(() => {
      this.commandPolicyLists = lists;
    });
  }

  async loadTools(): Promise<void> {
    try {
      const [mcpTools, builtInTools] = await Promise.all([
        window.gyshell.tools.getMcp(),
        window.gyshell.tools.getBuiltIn(),
      ]);
      runInAction(() => {
        this.mcpTools = mcpTools;
        this.builtInTools = builtInTools;
      });
    } catch (err) {
      console.error("Failed to load tools status", err);
    }
  }

  async loadSkills(): Promise<void> {
    try {
      const [skills, enabledSkills, settings] = await Promise.all([
        window.gyshell.skills.getAll(),
        window.gyshell.skills.getEnabled(),
        this.fetchCombinedSettings(),
      ]);
      const enabledByName = new Set(enabledSkills.map((skill) => skill.name));
      runInAction(() => {
        this.settings = settings;
        this.skills = skills.map((skill) => ({
          ...skill,
          enabled: enabledByName.has(skill.name),
        }));
      });
    } catch (err) {
      console.error("Failed to load skills", err);
    }
  }

  async openSkillsFolder(): Promise<void> {
    await window.gyshell.skills.openFolder();
  }

  async reloadSkills(): Promise<void> {
    const [skills, enabledSkills, settings] = await Promise.all([
      window.gyshell.skills.reload(),
      window.gyshell.skills.getEnabled(),
      this.fetchCombinedSettings(),
    ]);
    const enabledByName = new Set(enabledSkills.map((skill) => skill.name));
    runInAction(() => {
      this.settings = settings;
      this.skills = skills.map((skill) => ({
        ...skill,
        enabled: enabledByName.has(skill.name),
      }));
    });
  }

  async createSkill(): Promise<void> {
    await window.gyshell.skills.create();
    await this.reloadSkills();
  }

  async editSkill(fileName: string): Promise<void> {
    await window.gyshell.skills.openFile(fileName);
  }

  async deleteSkill(fileName: string): Promise<void> {
    const skills = await window.gyshell.skills.delete(fileName);
    runInAction(() => {
      this.skills = skills;
    });
  }

  async loadMemory(): Promise<MemorySnapshot | null> {
    try {
      const snapshot = await window.gyshell.memory.get();
      runInAction(() => {
        this.memoryFilePath = snapshot.filePath;
        this.memoryContent = snapshot.content;
      });
      return snapshot;
    } catch (err) {
      console.error("Failed to load memory.md", err);
      return null;
    }
  }

  async openMemoryFile(): Promise<void> {
    await window.gyshell.memory.openFile();
  }

  async saveMemoryContent(content: string): Promise<MemorySnapshot | null> {
    try {
      const snapshot = await window.gyshell.memory.setContent(content);
      runInAction(() => {
        this.memoryFilePath = snapshot.filePath;
        this.memoryContent = snapshot.content;
      });
      return snapshot;
    } catch (err) {
      console.error("Failed to save memory.md", err);
      return null;
    }
  }

  async loadAccessTokens(): Promise<void> {
    try {
      const items = await window.gyshell.accessTokens.list();
      runInAction(() => {
        this.accessTokens = [...items].sort(
          (left, right) => right.createdAt - left.createdAt,
        );
      });
    } catch (error) {
      console.error("Failed to load access tokens", error);
    }
  }

  async createAccessToken(
    name: string,
  ): Promise<Awaited<ReturnType<Window["gyshell"]["accessTokens"]["create"]>>> {
    const created = await window.gyshell.accessTokens.create(name);
    runInAction(() => {
      this.accessTokens = [
        { id: created.id, name: created.name, createdAt: created.createdAt },
        ...this.accessTokens.filter((item) => item.id !== created.id),
      ];
    });
    return created;
  }

  async deleteAccessToken(id: string): Promise<boolean> {
    const deleted = await window.gyshell.accessTokens.delete(id);
    if (!deleted) return false;
    runInAction(() => {
      this.accessTokens = this.accessTokens.filter((item) => item.id !== id);
    });
    return true;
  }

  async openMcpConfig(): Promise<void> {
    await window.gyshell.tools.openMcpConfig();
  }

  async reloadMcpTools(): Promise<void> {
    const mcpTools = await window.gyshell.tools.reloadMcp();
    runInAction(() => {
      this.mcpTools = mcpTools;
    });
  }

  async setMcpToolEnabled(name: string, enabled: boolean): Promise<void> {
    const mcpTools = await window.gyshell.tools.setMcpEnabled(name, enabled);
    runInAction(() => {
      this.mcpTools = mcpTools;
    });
  }

  async setBuiltInToolEnabled(
    name: string,
    enabled: boolean,
    acknowledgedExperimentalToolNames: string[] = [],
  ): Promise<
    BuiltInToolSummary[] | ExperimentalToolConfirmationRequired
  > {
    const result = await window.gyshell.tools.setBuiltInEnabled(
      name,
      enabled,
      acknowledgedExperimentalToolNames,
    );
    if (Array.isArray(result)) {
      runInAction(() => {
        this.applyBuiltInToolStatusUpdate(result);
      });
    }
    return result;
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    const skills = await window.gyshell.skills.setEnabled(name, enabled);
    const settings = await this.fetchCombinedSettings();
    runInAction(() => {
      this.settings = settings;
      this.applySkillStatusUpdate(skills);
    });
  }

  async setMemoryEnabled(enabled: boolean): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings = {
          ...this.settings,
          memory: {
            enabled,
          },
        };
      }
    });
    await window.gyshell.settings.set({
      memory: {
        enabled,
      },
    });
  }

  async setRecursionLimit(limit: number): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings.recursionLimit = limit;
      }
    });
    await window.gyshell.settings.set({ recursionLimit: limit });
  }

  async setDebugMode(enabled: boolean): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings.debugMode = enabled;
      }
    });
    await window.gyshell.settings.set({ debugMode: enabled });
  }

  setMobileWebStatus(status: {
    running: boolean;
    port?: number;
    urls?: string[];
  }): void {
    this.mobileWebStatus = status;
  }

  async loadMobileWebStatus(): Promise<void> {
    try {
      const status = await window.gyshell.mobileWeb.getStatus();
      runInAction(() => {
        this.mobileWebStatus = status;
      });
    } catch (error) {
      console.error("Failed to load mobile web status", error);
    }
  }

  async startMobileWeb(): Promise<void> {
    try {
      const status = await window.gyshell.mobileWeb.start();
      runInAction(() => {
        this.mobileWebStatus = status;
      });
    } catch (error) {
      console.error("Failed to start mobile web server", error);
    }
  }

  async stopMobileWeb(): Promise<void> {
    try {
      await window.gyshell.mobileWeb.stop();
      runInAction(() => {
        this.mobileWebStatus = { running: false };
      });
    } catch (error) {
      console.error("Failed to stop mobile web server", error);
    }
  }

  async setMobileWebPort(port: number | null): Promise<void> {
    const current = this.settings?.gateway?.mobileWeb;
    runInAction(() => {
      if (this.settings) {
        this.settings = {
          ...this.settings,
          gateway: {
            ...this.settings.gateway,
            mobileWeb: { port },
          },
        };
      }
    });
    try {
      await window.gyshell.mobileWeb.setPort(port);
    } catch (error) {
      runInAction(() => {
        if (this.settings && current !== undefined) {
          this.settings = {
            ...this.settings,
            gateway: {
              ...this.settings.gateway,
              mobileWeb: current,
            },
          };
        }
      });
      console.error("Failed to set mobile web port", error);
    }
  }

  private async updateWsGatewaySettings(
    nextWs: NonNullable<AppSettings["gateway"]>["ws"],
  ): Promise<void> {
    const previous = this.settings?.gateway?.ws;
    runInAction(() => {
      if (this.settings) {
        this.settings = {
          ...this.settings,
          gateway: {
            ...this.settings.gateway,
            ws: nextWs,
          },
        };
      }
    });
    try {
      const plainNextWs = {
        access: nextWs.access,
        port: nextWs.port,
        allowedCidrs: Array.from(nextWs.allowedCidrs ?? []),
      };
      const next =
        await window.gyshell.settings.setWsGatewayConfig(plainNextWs);
      runInAction(() => {
        if (this.settings) {
          this.settings = {
            ...this.settings,
            gateway: {
              ...this.settings.gateway,
              ws: next,
            },
          };
        }
      });
    } catch (error) {
      runInAction(() => {
        if (this.settings && previous) {
          this.settings = {
            ...this.settings,
            gateway: {
              ...this.settings.gateway,
              ws: previous,
            },
          };
        }
      });
      console.error("Failed to update websocket gateway settings", error);
    }
  }

  async setWsGatewayAccess(
    access: NonNullable<AppSettings["gateway"]>["ws"]["access"],
  ): Promise<void> {
    const current = this.settings?.gateway?.ws || {
      access: "localhost" as const,
      port: 17888,
      allowedCidrs: [] as string[],
    };
    await this.updateWsGatewaySettings({
      access,
      port: current.port,
      allowedCidrs: current.allowedCidrs ?? [],
    });
  }

  async setWsGatewayPort(port: number): Promise<void> {
    const current = this.settings?.gateway?.ws || {
      access: "localhost" as const,
      port: 17888,
      allowedCidrs: [] as string[],
    };
    const rounded = Math.floor(port);
    if (!Number.isInteger(rounded) || rounded <= 0 || rounded >= 65536) {
      return;
    }
    await this.updateWsGatewaySettings({
      access: current.access,
      port: rounded,
      allowedCidrs: current.allowedCidrs ?? [],
    });
  }

  private parseWsGatewayCidrsInput(cidrs: string): string[] {
    return cidrs
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async setWsGatewayCidrs(cidrs: string): Promise<boolean> {
    const parsed = this.parseWsGatewayCidrsInput(cidrs);
    const current = this.settings?.gateway?.ws || {
      access: "localhost" as const,
      port: 17888,
      allowedCidrs: [] as string[],
    };
    if (current.access === "custom" && parsed.length === 0) {
      return false;
    }
    await this.updateWsGatewaySettings({
      access: current.access,
      port: current.port,
      allowedCidrs: parsed,
    });
    return true;
  }

  async setWsGatewayCustomCidrs(cidrs: string): Promise<boolean> {
    const parsed = this.parseWsGatewayCidrsInput(cidrs);
    if (parsed.length === 0) {
      return false;
    }
    const current = this.settings?.gateway?.ws || {
      access: "localhost" as const,
      port: 17888,
      allowedCidrs: [] as string[],
    };
    await this.updateWsGatewaySettings({
      access: "custom",
      port: current.port,
      allowedCidrs: parsed,
    });
    return true;
  }

  private getExperimentalSettingsSnapshot(): NonNullable<
    AppSettings["experimental"]
  > {
    return {
      runtimeThinkingCorrectionEnabled:
        this.settings?.experimental?.runtimeThinkingCorrectionEnabled !== false,
      taskFinishGuardEnabled:
        this.settings?.experimental?.taskFinishGuardEnabled !== false,
      firstTurnThinkingModelEnabled:
        this.settings?.experimental?.firstTurnThinkingModelEnabled === true,
      execCommandActionModelEnabled:
        this.settings?.experimental?.execCommandActionModelEnabled !== false,
      writeStdinActionModelEnabled:
        this.settings?.experimental?.writeStdinActionModelEnabled !== false,
    };
  }

  private async updateExperimentalSettings(
    patch: Partial<NonNullable<AppSettings["experimental"]>>,
  ): Promise<void> {
    const next = {
      ...this.getExperimentalSettingsSnapshot(),
      ...patch,
    };
    runInAction(() => {
      if (this.settings) {
        this.settings.experimental = next;
      }
    });
    await window.gyshell.settings.set({
      experimental: next,
    });
  }

  async setRuntimeThinkingCorrectionEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      runtimeThinkingCorrectionEnabled: enabled,
    });
  }

  async setTaskFinishGuardEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      taskFinishGuardEnabled: enabled,
    });
  }

  async setFirstTurnThinkingModelEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      firstTurnThinkingModelEnabled: enabled,
    });
  }

  async setExecCommandActionModelEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      execCommandActionModelEnabled: enabled,
    });
  }

  async setWriteStdinActionModelEnabled(enabled: boolean): Promise<void> {
    await this.updateExperimentalSettings({
      writeStdinActionModelEnabled: enabled,
    });
  }

  async openCustomThemeFile(): Promise<void> {
    await window.gyshell.themes.openCustomConfig();
  }

  async reloadCustomThemes(): Promise<void> {
    const themes = await window.gyshell.themes.reloadCustom();
    runInAction(() => {
      this.customThemes = themes;
    });
    this.ensureThemeExists();
  }

  async bootstrap(): Promise<void> {
    if (this.isBootstrapped) return;
    const deferredUiUpdates: any[] = [];
    let deferUiUpdates = false;
    const flushDeferredUiUpdates = () => {
      if (!deferUiUpdates) return;
      deferUiUpdates = false;
      if (deferredUiUpdates.length === 0) return;
      const pending = deferredUiUpdates.splice(0, deferredUiUpdates.length);
      pending.forEach((action) => {
        this.chat.handleUiUpdate(action);
      });
    };
    try {
      window.gyshell.historyMigration.onStateChanged((state) => {
        runInAction(() => {
          this.historyMigrationState = state;
        });
      });
      const initialHistoryMigrationState =
        await window.gyshell.historyMigration.getState();
      runInAction(() => {
        this.historyMigrationState = initialHistoryMigrationState;
      });
      const settledHistoryMigrationState =
        await window.gyshell.historyMigration.waitUntilSettled();
      runInAction(() => {
        this.historyMigrationState = settledHistoryMigrationState;
      });
      if (settledHistoryMigrationState.status === "error") {
        return;
      }

      const [backendSettings, uiSettings, customThemes] = await Promise.all([
        window.gyshell.settings.get(),
        window.gyshell.uiSettings.get(),
        window.gyshell.themes.getCustom(),
      ]);
      const settings = {
        ...backendSettings,
        ...uiSettings,
      };
      const detachedWindowState: DetachedWindowState | null =
        this.windowRole === "detached" && WINDOW_CONTEXT.detachedStateToken
          ? readDetachedWindowState(WINDOW_CONTEXT.detachedStateToken)
          : null;
      const detachedTerminalSnapshots = Array.from(
        new Map(
          (detachedWindowState?.terminalTabs || [])
            .map((snapshot) => {
              const id = String(snapshot.id || "").trim();
              return id ? ([id, snapshot] as const) : null;
            })
            .filter(
              (
                entry,
              ): entry is readonly [string, WindowingTerminalTabSnapshot] =>
                !!entry,
            ),
        ).values(),
      );
      const buildTerminalSnapshotForBootstrap = (
        snapshot: TerminalListPayload,
      ): TerminalListPayload => {
        if (detachedTerminalSnapshots.length === 0) {
          return snapshot;
        }
        const incomingIds = new Set(
          snapshot.terminals
            .map((entry) => entry.id)
            .filter((id): id is string => typeof id === "string"),
        );
        const placeholderEntries = detachedTerminalSnapshots
          .filter((entry) => !incomingIds.has(entry.id))
          .map((entry) => {
            const configType = String(
              (entry.config as { type?: string }).type || "local",
            );
            return {
              id: entry.id,
              title: entry.title,
              type: configType,
              cols: entry.config.cols > 0 ? entry.config.cols : 80,
              rows: entry.config.rows > 0 ? entry.config.rows : 24,
              runtimeState: entry.runtimeState || "initializing",
              ...(typeof entry.lastExitCode === "number"
                ? { lastExitCode: entry.lastExitCode }
                : {}),
            } as TerminalListEntry;
          });
        if (placeholderEntries.length === 0) {
          return snapshot;
        }
        return {
          ...snapshot,
          terminals: [...snapshot.terminals, ...placeholderEntries],
        };
      };
      const effectiveLayout = detachedWindowState
        ? {
            ...(settings.layout || {}),
            v2: detachedWindowState.layoutTree,
          }
        : settings.layout;
      const normalizedSettings = effectiveLayout
        ? {
            ...settings,
            layout: effectiveLayout,
          }
        : settings;
      const persistedChatInventoryState =
        this.collectPersistedChatInventoryState(effectiveLayout);
      const detachedVisibleTabIdsByKind =
        this.collectDetachedVisibleTabIdsByKind(
          detachedWindowState?.layoutTree,
        );
      const theme = resolveTheme(settings.themeId, customThemes);
      applyAppThemeFromTerminalScheme(theme.terminal);
      const xtermTheme = toXtermTheme(theme.terminal, {
        transparentBackground: true,
      });
      deferUiUpdates = persistedChatInventoryState.tabIds.length > 0;

      const persistedMonitorSources = Array.isArray(
        uiSettings.monitorEnabledSources,
      )
        ? this.normalizeMonitorEnabledSources(uiSettings.monitorEnabledSources)
        : [];

      runInAction(() => {
        this.settings = normalizedSettings;
        this.xtermTheme = xtermTheme;
        this.isBootstrapped = true;
        this.detachedVisibleTabIdsByKind = detachedVisibleTabIdsByKind;
        this.monitorEnabledSources = persistedMonitorSources;
        this.i18n.setLocale(normalizedSettings.language);
        this.customThemes = customThemes;
        this.chat.hydrateSessionInventoryFromLayout(
          persistedChatInventoryState.tabIds,
          persistedChatInventoryState.preferredActiveTabId,
        );
        this.layout.bootstrap();
        if (detachedWindowState?.fileEditorSnapshot) {
          this.fileEditor.restoreSnapshot(
            detachedWindowState.fileEditorSnapshot,
          );
        }
      });

      // Setup deterministic UI update listener (backend is the source of truth).
      // Register before awaiting hydration to avoid dropping updates emitted during startup.
      window.gyshell.agent.onUiUpdate((action) => {
        runInAction(() => {
          if (deferUiUpdates) {
            deferredUiUpdates.push(action);
            return;
          }
          this.chat.handleUiUpdate(action);
        });
      });

      if (persistedChatInventoryState.tabIds.length > 0) {
        await this.chat.hydrateSessionsFromBackend(
          persistedChatInventoryState.tabIds,
          persistedChatInventoryState.preferredActiveTabId,
        );
      }
      runInAction(() => {
        flushDeferredUiUpdates();
      });

      // Terminal exit should not auto-close tabs. UI tab lifecycle is user-driven.
      window.gyshell.terminal.onExit(() => {
        // No-op: runtime state is synchronized through terminal:tabs updates.
      });

      window.gyshell.terminal.onTabsUpdated((payload) => {
        runInAction(() => {
          this.reconcileTerminalTabs(payload);
        });
      });
      this.ensureMonitorListener();

      window.gyshell.settings.onUpdated?.((settings) => {
        runInAction(() => {
          this.applyBackendSettingsUpdate(settings);
        });
      });

      window.gyshell.settings.onCommandPolicyListsUpdated?.((lists) => {
        runInAction(() => {
          this.applyCommandPolicyListsUpdate(lists);
        });
      });

      // MCP tool status updates
      window.gyshell.tools.onMcpUpdated((mcpTools) => {
        runInAction(() => {
          this.mcpTools = mcpTools;
        });
      });

      window.gyshell.tools.onBuiltInUpdated((tools) => {
        runInAction(() => {
          this.applyBuiltInToolStatusUpdate(tools);
        });
      });

      // Skill status updates
      window.gyshell.skills.onUpdated((skills) => {
        runInAction(() => {
          this.applySkillStatusUpdate(skills);
        });
      });

      window.gyshell.memory.onUpdated?.((snapshot) => {
        runInAction(() => {
          this.applyMemorySnapshotUpdate(snapshot);
        });
      });

      window.gyshell.filesystem.onTransferTaskUpdated((task) => {
        runInAction(() => {
          this.applyFileTransferTaskUpdate(task);
        });
      });

      window.gyshell.filesystem.onTransferTaskRemoved(({ transferId }) => {
        runInAction(() => {
          this.removeFileTransferTask(transferId);
        });
      });

      const transferTasks = await window.gyshell.filesystem.listTransfers({
        includeCompleted: true,
      });
      runInAction(() => {
        this.applyFileTransferTasks(transferTasks);
      });

      const terminalSnapshot = buildTerminalSnapshotForBootstrap(
        await window.gyshell.terminal.list(),
      );
      if (terminalSnapshot.terminals.length > 0) {
        runInAction(() => {
          if (detachedTerminalSnapshots.length > 0) {
            this.materializeTransferredTabs(
              "terminal",
              detachedTerminalSnapshots.map((snapshot) => snapshot.id),
              { terminalTabs: detachedTerminalSnapshots },
            );
          }
          this.reconcileTerminalTabs(terminalSnapshot);
          if (this.isDetachedWindow && detachedWindowState?.layoutTree) {
            this.detachedVisibleTabIdsByKind =
              this.collectDetachedVisibleTabIdsByKind(
                detachedWindowState.layoutTree,
              );
            this.layout.syncPanelBindings();
          }
        });
      } else {
        runInAction(() => {
          this.terminalTabs = [];
          this.terminalTabsHydrated = true;
          this.activeTerminalId = null;
        });
        this.syncMonitorSessions();
        const ensurePanelForDefault =
          this.windowRole === "main" &&
          this.isFirstLaunchDefaultLayout(effectiveLayout);
        const targetPanelId =
          this.layout.getPrimaryPanelId("terminal") ||
          (ensurePanelForDefault
            ? this.layout.ensurePrimaryPanelForKind("terminal")
            : null) ||
          undefined;
        this.createLocalTab(targetPanelId, {
          ensurePanel: ensurePanelForDefault,
        });
      }

      // Load tools status
      void this.loadTools();
      void this.loadSkills();
      void this.loadMemory();
      void this.loadCommandPolicyLists();
      void this.loadAccessTokens();
      void this.loadVersionState();
      void this.loadMobileWebStatus();
      void this.checkVersion({ showPopupOnVersionChange: true });
    } catch (err) {
      runInAction(() => {
        flushDeferredUiUpdates();
        if (
          this.historyMigrationState &&
          (this.historyMigrationState.blocking ||
            this.historyMigrationState.status === "error")
        ) {
          this.historyMigrationState = {
            ...this.historyMigrationState,
            status: "error",
            ready: false,
            active: false,
            blocking: true,
            phase: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
      console.error("Failed to bootstrap settings", err);
      runInAction(() => {
        this.isBootstrapped = true;
        this.chat.hydrateSessionInventoryFromLayout([]);
      });
      if (this.terminalTabs.length === 0) {
        this.createLocalTab(undefined, { ensurePanel: true });
      }
      void this.loadTools();
      void this.loadSkills();
      void this.loadMemory();
      void this.loadCommandPolicyLists();
      void this.loadAccessTokens();
      void this.loadVersionState();
      void this.loadMobileWebStatus();
      void this.checkVersion({ showPopupOnVersionChange: true });
    }
  }

  createLocalTab(
    targetPanelId?: string,
    options?: { ensurePanel?: boolean; startRuntime?: boolean },
  ): string {
    const id = `local-${uuidv4()}`;
    const title = this.getUniqueTitle("Local");
    const shouldStartRuntime = options?.startRuntime === true;
    const cfg: TerminalConfig = {
      type: "local",
      id,
      title,
      cols: 80,
      rows: 24,
    };
    const tab: TerminalTabModel = {
      id,
      title,
      config: cfg,
      capabilities: resolveTerminalConnectionCapabilities(cfg),
      connectionRef: { type: "local" },
      runtimeState: shouldStartRuntime || shouldInitializeLocalTerminalSilently()
        ? "initializing"
        : "ready",
    };
    this.terminalTabs.push(tab);
    this.terminalTabsHydrated = true;
    this.activeTerminalId = id;
    this.unsuppressTabs("terminal", [id], { syncLayout: false });
    const shouldEnsurePanel = options?.ensurePanel === true;
    const resolvedPanelId =
      targetPanelId ||
      this.layout.getPrimaryPanelId("terminal") ||
      (shouldEnsurePanel
        ? this.layout.ensurePrimaryPanelForKind("terminal")
        : null) ||
      undefined;
    if (resolvedPanelId) {
      this.layout.attachTabToPanel("terminal", id, resolvedPanelId);
    } else {
      this.layout.syncPanelBindings();
    }
    if (shouldStartRuntime) {
      void this.startTerminalRuntime(tab);
    }
    return id;
  }

  createSshTab(
    entryId: string,
    targetPanelId?: string,
    options?: {
      ensurePanel?: boolean;
      attachToPanel?: boolean;
      startRuntime?: boolean;
    },
  ): string | null {
    const entry = this.settings?.connections?.ssh?.find(
      (x) => x.id === entryId,
    );
    if (!entry) {
      console.warn("SSH entry not found", entryId);
      return null;
    }
    const proxy = entry.proxyId
      ? this.settings?.connections?.proxies?.find((p) => p.id === entry.proxyId)
      : undefined;
    const tunnels = (entry.tunnelIds ?? [])
      .map((id) =>
        this.settings?.connections?.tunnels?.find((t) => t.id === id),
      )
      .filter(Boolean) as any[];
    const id = `ssh-${uuidv4()}`;
    const baseTitle = entry.name || `${entry.username}@${entry.host}`;
    const title = this.getUniqueTitle(baseTitle);
    const jumpHost = (entry as any).jumpHost
      ? (toJS((entry as any).jumpHost) as any)
      : undefined;
    const cfg: TerminalConfig = {
      type: "ssh",
      id,
      title,
      cols: 80,
      rows: 24,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      authMethod: entry.authMethod,
      password: entry.password,
      privateKey: entry.privateKey,
      privateKeyPath: entry.privateKeyPath,
      passphrase: entry.passphrase,
      proxy,
      tunnels,
      jumpHost,
    } as any;
    const tab: TerminalTabModel = {
      id,
      title,
      config: cfg,
      capabilities: resolveTerminalConnectionCapabilities(cfg),
      connectionRef: { type: "ssh", entryId },
      runtimeState: "initializing",
    };
    this.terminalTabs.push(tab);
    this.terminalTabsHydrated = true;
    this.activeTerminalId = id;
    this.unsuppressTabs("terminal", [id], { syncLayout: false });
    const shouldAttachToPanel = options?.attachToPanel !== false;
    if (shouldAttachToPanel) {
      this.showTabsInLayout("terminal", [id]);
    } else {
      const panelIdsByHiddenKind = new Map<WindowScopedTabKind, string[]>();
      this.getVisibilityLinkedKindsForTab("terminal", id).forEach(
        (linkedKind) => {
          if (linkedKind === "terminal") {
            return;
          }
          const panelIds = this.layout.getPanelIdsByKind(linkedKind);
          panelIdsByHiddenKind.set(linkedKind, panelIds);
        },
      );
      this.hideTabsFromLayoutKinds(panelIdsByHiddenKind.keys(), [id]);
      this.layout.pinPanelsAsRestorePlaceholder(
        Array.from(panelIdsByHiddenKind.values()).flat(),
      );
    }
    if (options?.startRuntime === true) {
      void this.startTerminalRuntime(tab);
    }
    const shouldEnsurePanel = options?.ensurePanel !== false;
    const resolvedPanelId = shouldAttachToPanel
      ? targetPanelId ||
        this.layout.getPrimaryPanelId("terminal") ||
        (shouldEnsurePanel
          ? this.layout.ensurePrimaryPanelForKind("terminal")
          : null) ||
        undefined
      : undefined;
    if (resolvedPanelId) {
      this.layout.attachTabToPanel("terminal", id, resolvedPanelId);
    } else {
      this.layout.syncPanelBindings();
    }
    return id;
  }

  private async startTerminalRuntime(tab: TerminalTabModel): Promise<void> {
    if (typeof window === "undefined") {
      return;
    }
    const terminalApi = window.gyshell?.terminal;
    if (typeof terminalApi?.createTab !== "function") {
      return;
    }
    try {
      await terminalApi.createTab(toPlainTerminalConfig(tab.config));
      const snapshot = await terminalApi.list();
      runInAction(() => {
        this.reconcileTerminalTabs(snapshot);
      });
    } catch (error) {
      console.error("Failed to start terminal runtime", error);
      runInAction(() => {
        const current = this.terminalTabs.find((entry) => entry.id === tab.id);
        if (!current) return;
        current.runtimeState = "exited";
      });
    }
  }

  async saveSshConnection(
    entry: AppSettings["connections"]["ssh"][number],
  ): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const plainEntry = toJS(entry);
    const list = current.connections.ssh.slice().map((x) => toJS(x));
    const nextList = upsertById(list, plainEntry);

    const nextConnections = { ...toJS(current.connections), ssh: nextList };

    runInAction(() => {
      if (this.settings) {
        this.settings.connections.ssh = nextList as any;
      }
    });

    await window.gyshell.settings.set({ connections: nextConnections });
  }

  async deleteSshConnection(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const list = removeById(current.connections.ssh, id).map((x) => toJS(x));
    const nextConnections = { ...toJS(current.connections), ssh: list };
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.ssh = list as any;
      }
    });
    await window.gyshell.settings.set({ connections: nextConnections });
  }

  async saveModel(model: ModelDefinition): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const items = current.models.items.slice().map((x) => toJS(x));
    const modelSnapshot = toJS(model);
    const structuredOutputMode: "auto" | "on" | "off" =
      modelSnapshot.structuredOutputMode === "on" ||
      modelSnapshot.structuredOutputMode === "off"
        ? modelSnapshot.structuredOutputMode
        : "auto";
    const plainModel: ModelDefinition = {
      ...modelSnapshot,
      structuredOutputMode,
      supportsStructuredOutput: structuredOutputMode === "on",
      supportsObjectToolChoice: false,
      // Ensure profile is a plain object for IPC cloning
      profile: modelSnapshot.profile ? toJS(modelSnapshot.profile) : undefined,
    };
    let nextProfile: ModelDefinition["profile"] = {
      imageInputs: false,
      textOutputs: false,
      supportsStructuredOutput: false,
      supportsObjectToolChoice: false,
      testedAt: Date.now(),
      ok: false,
      error: "Probe failed",
    };
    try {
      const probeResult = await window.gyshell.models.probe(plainModel);
      nextProfile = {
        imageInputs: probeResult.imageInputs,
        textOutputs: probeResult.textOutputs,
        supportsStructuredOutput: probeResult.supportsStructuredOutput,
        supportsObjectToolChoice: probeResult.supportsObjectToolChoice,
        testedAt: probeResult.testedAt,
        ok: probeResult.ok,
        error: probeResult.error,
      };
    } catch (err) {
      nextProfile = {
        imageInputs: false,
        textOutputs: false,
        supportsStructuredOutput: false,
        supportsObjectToolChoice: false,
        testedAt: Date.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const nextModel: ModelDefinition = {
      ...plainModel,
      supportsStructuredOutput:
        structuredOutputMode === "auto"
          ? nextProfile.supportsStructuredOutput === true
          : structuredOutputMode === "on",
      supportsObjectToolChoice: nextProfile.supportsObjectToolChoice === true,
      profile: nextProfile,
    };
    const nextItems = upsertById(items, nextModel);

    const nextModels = { ...toJS(current.models), items: nextItems };

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any;
      }
    });
    await window.gyshell.settings.set({ models: nextModels });
  }

  async deleteModel(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const items = removeById(current.models.items, id).map((x) => toJS(x));
    const nextModels = { ...toJS(current.models), items };

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any;
      }
    });
    await window.gyshell.settings.set({ models: nextModels });
  }

  async saveProfile(
    profile: AppSettings["models"]["profiles"][number],
  ): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const profiles = current.models.profiles.slice().map((x) => toJS(x));
    const plainProfile = toJS(profile);
    const nextProfiles = upsertById(profiles, plainProfile);

    const nextModels = { ...toJS(current.models), profiles: nextProfiles };

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any;
      }
    });
    await window.gyshell.settings.set({ models: nextModels });
  }

  async deleteProfile(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const profiles = removeById(current.models.profiles, id).map((x) =>
      toJS(x),
    );
    const currentCommandDraftProfileId = String(
      current.commandDraft?.profileId || "",
    ).trim();
    // If active profile is deleted, reset to first available or default
    let activeProfileId = current.models.activeProfileId;
    if (activeProfileId === id) {
      activeProfileId = profiles[0]?.id || "";
    }

    const nextModels = { ...toJS(current.models), profiles, activeProfileId };
    const nextCommandDraftProfileId =
      currentCommandDraftProfileId === id
        ? profiles[0]?.id || ""
        : currentCommandDraftProfileId;

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any;
        this.settings.commandDraft = {
          profileId: nextCommandDraftProfileId,
        };
      }
    });
    await Promise.all([
      window.gyshell.settings.set({ models: nextModels }),
      window.gyshell.uiSettings.set({
        commandDraft: {
          profileId: nextCommandDraftProfileId,
        },
      }),
    ]);
  }

  async setActiveProfile(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const nextModels = { ...toJS(current.models), activeProfileId: id };

    runInAction(() => {
      if (this.settings) {
        this.settings.models.activeProfileId = id;
      }
    });
    await window.gyshell.settings.set({ models: nextModels });
  }

  async saveProxy(entry: ProxyEntry): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const plainEntry = toJS(entry);
    const list = current.connections.proxies.slice().map((x) => toJS(x));
    const nextList = upsertById(list, plainEntry);

    const nextConnections = { ...toJS(current.connections), proxies: nextList };
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.proxies = nextList as any;
      }
    });
    await window.gyshell.settings.set({ connections: nextConnections });
  }

  async deleteProxy(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const list = removeById(current.connections.proxies, id).map((x) =>
      toJS(x),
    );
    const nextConnections = { ...toJS(current.connections), proxies: list };
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.proxies = list as any;
      }
    });
    await window.gyshell.settings.set({ connections: nextConnections });
  }

  async saveTunnel(entry: TunnelEntry): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const plainEntry = toJS(entry);
    const list = current.connections.tunnels.slice().map((x) => toJS(x));
    const nextList = upsertById(list, plainEntry);

    const nextConnections = { ...toJS(current.connections), tunnels: nextList };
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.tunnels = nextList as any;
      }
    });
    await window.gyshell.settings.set({ connections: nextConnections });
  }

  async deleteTunnel(id: string): Promise<void> {
    const current = this.settings ?? (await this.fetchCombinedSettings());
    const list = removeById(current.connections.tunnels, id).map((x) =>
      toJS(x),
    );
    const nextConnections = { ...toJS(current.connections), tunnels: list };
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.tunnels = list as any;
      }
    });
    await window.gyshell.settings.set({ connections: nextConnections });
  }

  async reconnectTerminal(tabId: string): Promise<boolean> {
    const tab = this.terminalTabs.find((entry) => entry.id === tabId);
    if (!tab || !canReconnectTerminalRuntime(tab.config, tab.runtimeState)) {
      return false;
    }

    runInAction(() => {
      const current = this.terminalTabs.find((entry) => entry.id === tabId);
      if (!current) return;
      current.runtimeState = "initializing";
      current.lastExitCode = undefined;
    });

    try {
      await window.gyshell.terminal.reconnect(tabId);
      const snapshot = await window.gyshell.terminal.list();
      runInAction(() => {
        this.reconcileTerminalTabs(snapshot);
      });
      return true;
    } catch (error) {
      console.error("Failed to reconnect terminal", error);
      try {
        const snapshot = await window.gyshell.terminal.list();
        runInAction(() => {
          this.reconcileTerminalTabs(snapshot);
        });
      } catch {
        runInAction(() => {
          const current = this.terminalTabs.find((entry) => entry.id === tabId);
          if (!current) return;
          current.runtimeState = "exited";
        });
      }
      return false;
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const idx = this.terminalTabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;

    const wasActive = this.activeTerminalId === tabId;
    const nextTabs = this.terminalTabs.slice();
    nextTabs.splice(idx, 1);

    let nextActive: string | null = this.activeTerminalId;
    if (wasActive) {
      nextActive = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null;
    }

    this.showTabsInLayout("terminal", [tabId]);
    runInAction(() => {
      this.terminalTabs = nextTabs;
      this.activeTerminalId = nextActive;
    });
    this.unsuppressTabs("terminal", [tabId], { syncLayout: false });
    this.layout.syncPanelBindings();
    this.syncMonitorSessions();

    // Kill backend session (best-effort)
    try {
      await window.gyshell.terminal.kill(tabId);
    } catch {
      // ignore
    }
  }

  async openFileEditorFromFileSystem(
    terminalId: string,
    filePath: string,
  ): Promise<boolean> {
    const hasTerminal = this.fileSystemTabs.some(
      (tab) => tab.id === terminalId,
    );
    if (!hasTerminal) {
      return false;
    }
    this.setActiveTerminal(terminalId);
    return await this.fileEditor.openFromFileSystem(terminalId, filePath);
  }

  async openChatSessionFromHistory(
    sessionId: string,
    options?: {
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      return;
    }

    this.chat.ensureSession(normalizedSessionId);
    if (!this.layout.getPrimaryPanelId("chat")) {
      this.layout.ensurePrimaryPanelForKind("chat");
    }
    this.unsuppressTabs("chat", [normalizedSessionId]);
    await this.chat.loadChatHistory(normalizedSessionId, {
      activate: true,
      loadAgentContext: options?.loadAgentContext !== false,
    });
  }

  async openDetachedFileEditorForPath(
    terminalId: string,
    filePath: string,
  ): Promise<boolean> {
    const snapshot: FileEditorSnapshot = {
      terminalId,
      filePath,
      mode: "loading",
      content: "",
      dirty: false,
      errorMessage: null,
      statusMessage: null,
    };

    return await openDetachedWindowState({
      sourceClientId: this.windowClientId,
      layoutTree: buildDetachedLayoutTree("fileEditor"),
      createdAt: Date.now(),
      fileEditorSnapshot: snapshot,
    });
  }

  canClosePanel(kind: PanelKind): boolean {
    // This guard is intentionally scoped to explicit in-workspace panel removal
    // flows (close, detach, cross-window move). Full window/app shutdown does
    // not block on dirty file editors.
    if (kind !== "fileEditor") {
      return true;
    }
    if (this.fileEditor.mode !== "text" || !this.fileEditor.dirty) {
      return true;
    }
    return window.confirm(this.i18n.t.fileEditor.unsavedChangesConfirm);
  }

  onPanelRemoved(kind: PanelKind): void {
    if (kind === "fileEditor") {
      this.fileEditor.clear();
    }
  }

  private sanitizeImageAttachmentForSend(
    image: InputImageAttachment,
  ): InputImageAttachment {
    const attachmentId = String(image.attachmentId || "").trim();
    const fileName = String(image.fileName || "").trim();
    const mimeType = String(image.mimeType || "").trim();
    const previewDataUrl = String(image.previewDataUrl || "").trim();
    const sha256 = String(image.sha256 || "").trim();
    const status =
      image.status === "ready" || image.status === "missing"
        ? image.status
        : undefined;
    return {
      ...(attachmentId ? { attachmentId } : {}),
      ...(fileName ? { fileName } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(typeof image.sizeBytes === "number" &&
      Number.isFinite(image.sizeBytes)
        ? { sizeBytes: image.sizeBytes }
        : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(previewDataUrl ? { previewDataUrl } : {}),
      ...(status ? { status } : {}),
    };
  }

  private async resolveInputImagesForSend(
    images: InputImageAttachment[] | undefined,
  ): Promise<InputImageAttachment[]> {
    if (!Array.isArray(images) || images.length === 0) return [];
    const resolved: InputImageAttachment[] = [];
    for (const image of images) {
      const attachmentId = String(image.attachmentId || "").trim();
      if (attachmentId) {
        resolved.push(this.sanitizeImageAttachmentForSend(image));
        continue;
      }

      const localFile = (image as any).localFile;
      if (localFile instanceof File) {
        const dataBase64 = await readFileAsDataUrl(localFile);
        const previewDataUrl =
          String(image.previewDataUrl || "").trim() ||
          (await createImagePreviewDataUrl(localFile).catch(() => ""));
        const saved = await window.gyshell.system.saveImageAttachment({
          dataBase64,
          fileName: image.fileName || localFile.name || undefined,
          mimeType: image.mimeType || localFile.type || undefined,
          ...(previewDataUrl ? { previewDataUrl } : {}),
        });
        resolved.push(
          this.sanitizeImageAttachmentForSend({
            ...saved,
            fileName: image.fileName || saved.fileName,
            mimeType: image.mimeType || saved.mimeType,
            sizeBytes: image.sizeBytes || saved.sizeBytes,
            previewDataUrl: previewDataUrl || saved.previewDataUrl,
          }),
        );
        continue;
      }
    }
    return resolved;
  }

  private async resolveUserInputPayloadForSend(
    content: string | UserInputPayload,
  ): Promise<string | UserInputPayload> {
    if (typeof content === "string") return content;
    const text = typeof content?.text === "string" ? content.text : "";
    const images = await this.resolveInputImagesForSend(content?.images);
    return {
      text,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  async sendChatMessage(
    sessionId: string,
    content: string | UserInputPayload,
    options?: { mode?: "normal" | "queue" },
  ): Promise<boolean> {
    const mode = options?.mode || "normal";
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      targetSessionId = this.chat.createSession();
    }

    const session = this.chat.sessions.find((s) => s.id === targetSessionId);
    const wasBusy = !!session?.isSessionBusy;
    if (mode === "queue" && session?.isSessionBusy) {
      console.warn("[AppStore] Session is busy, ignoring message.");
      return false;
    }

    let resolvedContent: string | UserInputPayload;
    try {
      resolvedContent = await this.resolveUserInputPayloadForSend(content);
    } catch (error) {
      console.error(
        "[AppStore] Failed to resolve image attachments before send:",
        error,
      );
      return false;
    }

    this.chat.setThinking(true, targetSessionId);
    this.chat.setSessionBusy(true, targetSessionId);
    if (!wasBusy) {
      const activeProfileId = this.settings?.models.activeProfileId || "";
      this.chat.setSessionLockedProfile(
        targetSessionId,
        activeProfileId || null,
      );
    }

    const startMode = wasBusy && mode === "normal" ? "inserted" : "normal";
    window.gyshell.agent.startTask(targetSessionId, resolvedContent, {
      startMode,
    });
    return true;
  }

  setActiveTerminal(id: string): void {
    this.activeTerminalId = id;
  }

  getPreferredLocalTerminalId(): string | null {
    const active = this.activeTerminal;
    if (active?.config?.type === "local") {
      return active.id;
    }
    const fallback = this.terminalTabs.find(
      (tab) => tab.config?.type === "local",
    );
    return fallback?.id || null;
  }

  setFileSystemClipboard(payload: FileSystemClipboardState | null): void {
    this.fileSystemClipboard = cloneFileSystemClipboardState(payload);
  }

  clearFileSystemClipboard(): void {
    this.fileSystemClipboard = null;
  }

  applyFileTransferTasks(tasks: FileTransferTaskSnapshot[]): void {
    const next: Record<string, FileTransferTaskSnapshot> = {
      ...this.fileTransferTasks,
    };
    tasks.forEach((task) => {
      if (shouldApplyFileTransferTaskSnapshot(next[task.id], task)) {
        next[task.id] = task;
      }
    });
    this.fileTransferTasks = next;
  }

  applyFileTransferTaskUpdate(task: FileTransferTaskSnapshot): void {
    if (
      !shouldApplyFileTransferTaskSnapshot(
        this.fileTransferTasks[task.id],
        task,
      )
    ) {
      return;
    }
    this.fileTransferTasks = {
      ...this.fileTransferTasks,
      [task.id]: task,
    };
  }

  removeFileTransferTask(transferId: string): void {
    if (!this.fileTransferTasks[transferId]) return;
    const next = { ...this.fileTransferTasks };
    delete next[transferId];
    this.fileTransferTasks = next;
  }

  async startFileTransfer(
    input: Parameters<Window["gyshell"]["filesystem"]["startTransfer"]>[0],
  ): Promise<FileTransferTaskSnapshot> {
    const task = await window.gyshell.filesystem.startTransfer(input);
    runInAction(() => {
      this.applyFileTransferTaskUpdate(task);
    });
    return task;
  }

  async cancelFileTransferTask(
    transferId: string,
  ): Promise<FileTransferTaskSnapshot | null> {
    const task = await window.gyshell.filesystem.cancelTransferTask(transferId);
    if (task) {
      runInAction(() => {
        this.applyFileTransferTaskUpdate(task);
      });
    }
    return task;
  }

  setTerminalSelection(terminalId: string, selectionText: string): void {
    this.terminalSelections = {
      ...this.terminalSelections,
      [terminalId]: selectionText,
    };
  }

  getTerminalSelection(terminalId: string): string {
    return this.terminalSelections[terminalId] || "";
  }

  private ensureThemeExists(): void {
    if (!this.settings) return;
    const themeId = this.settings.themeId;
    const theme = resolveTheme(themeId, this.customThemes);
    if (theme.id !== themeId) {
      void this.setThemeId(theme.id);
    } else {
      applyAppThemeFromTerminalScheme(theme.terminal);
      runInAction(() => {
        this.xtermTheme = toXtermTheme(theme.terminal, {
          transparentBackground: true,
        });
      });
    }
  }
}
