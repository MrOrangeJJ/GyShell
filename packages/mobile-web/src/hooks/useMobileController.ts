import React from "react";
import { GatewayClient } from "../gateway-client";
import {
  loadGatewayAccessTokenFromStorage,
  loadGatewayAutoConnectFromStorage,
  loadGatewayUrlFromStorage,
  normalizeGatewayUrl,
  saveGatewayAccessTokenToStorage,
  saveGatewayAutoConnectToStorage,
  saveGatewayUrlToStorage,
  withGatewayAccessToken,
  withoutGatewayAccessToken,
} from "../lib/gateway-url";
import {
  applyMentionToInput,
  encodeMentions,
  getMentionSuggestions,
  type MentionOption,
} from "../lib/mentions";
import {
  buildChatTimeline,
  getLatestTokenUsage,
  type ChatTimelineItem,
} from "../lib/chat-timeline";
import {
  createImagePreviewDataUrl,
  isSupportedImageFile,
  readFileAsDataUrl,
} from "../lib/input-images";
import {
  applyRenameToUnloadedSession,
  applyUiUpdate,
  applyUiUpdateToUnloadedSession,
  cloneMessage,
  cloneSession,
  createUnloadedRenamedSession,
  createSessionState,
  normalizeSessionPreview,
  previewFromSession,
  reorderSessionIds,
  shouldReplayUiUpdateAfterSnapshot,
  type SessionMeta,
  type SessionState,
  UiUpdateBootstrapBuffer,
} from "../session-store";
import {
  buildSessionMeta,
  buildSshConnectionSummaries,
  collectEnabledSkillNames,
  compactStatusLabel,
  countPendingApprovals,
  deriveSessionStatus,
  fetchSkillsSnapshot,
  fetchToolsSnapshot,
  findFirstApprovalSession,
  mergeSkillsByName,
  normalizeAgentSettingState,
  normalizeBuiltInTool,
  normalizeConnectionsSnapshot,
  normalizeMemorySnapshot,
  normalizeMcpServer,
  normalizeSkillItem,
  normalizeCommandPolicyLists,
  readCommandPolicyModeFromSettings,
  readExperimentalToolConfirmationRequired,
  readMemoryEnabledFromSettings,
  readProfilesFromSettings,
  safeError,
  toSshConfig,
  type SessionStatusInfo,
} from "./mobileControllerHelpers";
import {
  useTerminalBuffer,
  type TerminalBufferEntry,
} from "./useTerminalBuffer";
import type {
  AgentSettingApplyOutcome,
  AgentSettingStateSummary,
  BuiltInToolSummary,
  ChatMessage,
  CommandPolicyLists,
  CommandPolicyMode,
  CreateTerminalTarget,
  GatewayConnectionsSnapshot,
  GatewayMemorySnapshot,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  GatewaySshConnectionSummary,
  McpServerSummary,
  SkillSummary,
  GatewayTerminalSummary,
  InputImageAttachment,
  UserInputPayload,
  UIUpdateAction,
} from "../types";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface ViewState {
  terminals: GatewayTerminalSummary[];
  connections: GatewayConnectionsSnapshot;
  sshConnections: GatewaySshConnectionSummary[];
  skills: SkillSummary[];
  mcpTools: McpServerSummary[];
  builtInTools: BuiltInToolSummary[];
  profiles: GatewayProfileSummary[];
  activeProfileId: string;
  agentSettings: AgentSettingStateSummary | null;
  memoryEnabled: boolean;
  commandPolicyMode: CommandPolicyMode;
  commandPolicyLists: CommandPolicyLists;
  memory: GatewayMemorySnapshot;
  sessions: Record<string, SessionState>;
  sessionMeta: Record<string, SessionMeta>;
  sessionOrder: string[];
  activeSessionId: string | null;
  statusLine: string;
  desktopActive: boolean;
  reconnectingTerminalId: string | null;
  reconnectError: string;
}

const INITIAL_VIEW_STATE: ViewState = {
  terminals: [],
  connections: { ssh: [], proxies: [], tunnels: [] },
  sshConnections: [],
  skills: [],
  mcpTools: [],
  builtInTools: [],
  profiles: [],
  activeProfileId: "",
  agentSettings: null,
  memoryEnabled: true,
  commandPolicyMode: "standard",
  commandPolicyLists: {
    allowlist: [],
    denylist: [],
    asklist: [],
  },
  memory: { filePath: "", content: "" },
  sessions: {},
  sessionMeta: {},
  sessionOrder: [],
  activeSessionId: null,
  statusLine: "Ready",
  desktopActive: false,
  reconnectingTerminalId: null,
  reconnectError: "",
};

const RECONNECT_BASE_DELAY_MS = 800;
const RECONNECT_MAX_DELAY_MS = 15000;
const RECONNECT_JITTER_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 3;
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_RPC_TIMEOUT_MS = 5000;
const HEARTBEAT_MAX_FAILURES = 2;

interface ComposerImageAttachment extends InputImageAttachment {
  id: string;
  previewUrl: string;
  localFile?: File;
}

function revokePreviewUrls(images: ComposerImageAttachment[]): void {
  images.forEach((item) => {
    if (!String(item.previewUrl || "").startsWith("blob:")) return;
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch {
      // ignore revoke errors
    }
  });
}

function computeReconnectDelayMs(attempt: number): number {
  const exponential = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
  const jitter = Math.floor(Math.random() * (RECONNECT_JITTER_MS + 1));
  return exponential + jitter;
}

export interface MobileControllerState {
  gatewayInput: string;
  accessTokenInput: string;
  connectionStatus: ConnectionStatus;
  connectionError: string;
  actionPending: boolean;
  composerValue: string;
  composerCursor: number;
  composerImages: ComposerImageAttachment[];
  mentionOptions: MentionOption[];
  terminals: GatewayTerminalSummary[];
  sshConnections: GatewaySshConnectionSummary[];
  skills: SkillSummary[];
  mcpTools: McpServerSummary[];
  builtInTools: BuiltInToolSummary[];
  profiles: GatewayProfileSummary[];
  activeProfileId: string;
  agentSettings: AgentSettingStateSummary | null;
  agentSettingsLoading: boolean;
  agentSettingsError: string;
  agentSettingsSaving: boolean;
  memoryEnabled: boolean;
  commandPolicyMode: CommandPolicyMode;
  commandPolicyLists: CommandPolicyLists;
  memoryFilePath: string;
  memoryContent: string;
  activeSession: SessionState | null;
  activeSessionId: string | null;
  chatTimeline: ChatTimelineItem[];
  sessionOrder: string[];
  sessionMeta: Record<string, SessionMeta>;
  sessions: Record<string, SessionState>;
  statusLine: string;
  isRunning: boolean;
  latestTokens: number;
  latestMaxTokens: number;
  tokenUsagePercent: number | null;
  pendingApprovalCount: number;
  firstApprovalSessionId: string | null;
  desktopActive: boolean;
  reconnectingTerminalId: string | null;
  reconnectError: string;
  sessionStatuses: Record<string, SessionStatusInfo>;
  sessionTokenPercents: Record<string, number | null>;
  terminalBuffers: Record<string, TerminalBufferEntry>;
}

export interface MobileControllerActions {
  setGatewayInput: (value: string) => void;
  setAccessTokenInput: (value: string) => void;
  setComposerValue: (value: string, cursor: number) => void;
  setComposerCursor: (cursor: number) => void;
  attachImages: (files: File[]) => Promise<void>;
  removeComposerImage: (imageId: string) => void;
  clearComposerImages: () => void;
  restoreComposerDraft: (
    value: string,
    images: InputImageAttachment[],
  ) => void;
  pickMention: (option: MentionOption) => void;
  connectGateway: () => Promise<void>;
  disconnectGateway: () => void;
  switchSession: (sessionId: string) => Promise<void>;
  createSession: () => Promise<string | null>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  sendMessage: () => Promise<void>;
  stopActiveSession: () => Promise<void>;
  updateProfile: (profileId: string) => Promise<void>;
  reloadSkills: () => Promise<void>;
  setSkillEnabled: (name: string, enabled: boolean) => Promise<void>;
  reloadMemory: () => Promise<void>;
  reloadTools: () => Promise<void>;
  setMcpEnabled: (name: string, enabled: boolean) => Promise<void>;
  setBuiltInToolEnabled: (
    name: string,
    enabled: boolean,
    acknowledgedExperimentalToolNames?: string[],
  ) => Promise<void>;
  replyAsk: (message: ChatMessage, decision: "allow" | "deny") => Promise<void>;
  rollbackToMessage: (sessionId: string, messageId: string) => Promise<boolean>;
  branchFromMessage: (
    sessionId: string,
    messageId: string,
  ) => Promise<string | null>;
  createTerminalTab: (target?: CreateTerminalTarget) => Promise<void>;
  closeTerminalTab: (terminalId: string) => Promise<void>;
  reconnectTerminalTab: (terminalId: string) => Promise<boolean>;
  clearReconnectError: () => void;
  refreshTerminalBuffers: () => void;
  markTerminalBufferSeen: (terminalId: string) => void;
  reloadAgentSettings: () => Promise<void>;
  saveCurrentAgentSetting: () => Promise<boolean>;
  applyAgentSetting: (
    profileId: string,
    acknowledgedExperimentalToolNames?: string[],
  ) => Promise<AgentSettingApplyOutcome>;
  deleteAgentSetting: (profileId: string) => Promise<boolean>;
}

export function useMobileController(): {
  state: MobileControllerState;
  actions: MobileControllerActions;
} {
  const clientRef = React.useRef<GatewayClient>();
  if (!clientRef.current) {
    clientRef.current = new GatewayClient();
  }
  const client = clientRef.current;

  const [gatewayInput, setGatewayInputRaw] = React.useState<string>(() =>
    loadGatewayUrlFromStorage(),
  );
  const [accessTokenInput, setAccessTokenInputRaw] = React.useState<string>(
    () => loadGatewayAccessTokenFromStorage(),
  );
  const [connectionStatus, setConnectionStatus] =
    React.useState<ConnectionStatus>("disconnected");
  const [connectionError, setConnectionError] = React.useState("");
  const [actionPending, setActionPending] = React.useState(false);

  const [composerValue, setComposerValueRaw] = React.useState("");
  const [composerCursor, setComposerCursor] = React.useState(0);
  const [composerImages, setComposerImagesRaw] = React.useState<
    ComposerImageAttachment[]
  >([]);

  const [agentSettingsLoading, setAgentSettingsLoading] =
    React.useState(false);
  const [agentSettingsSaving, setAgentSettingsSaving] = React.useState(false);
  const [agentSettingsError, setAgentSettingsError] = React.useState("");

  const [view, setView] = React.useState<ViewState>(INITIAL_VIEW_STATE);
  const uiUpdateBootstrapBufferRef = React.useRef(
    new UiUpdateBootstrapBuffer(),
  );
  const sessionLoadUpdateBuffersRef = React.useRef(
    new Map<string, UIUpdateAction[]>(),
  );
  const sessionLoadPromisesRef = React.useRef(
    new Map<string, Promise<void>>(),
  );
  const viewRef = React.useRef<ViewState>(INITIAL_VIEW_STATE);
  React.useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const gatewayInputRef = React.useRef(gatewayInput);
  React.useEffect(() => {
    gatewayInputRef.current = gatewayInput;
  }, [gatewayInput]);
  const accessTokenInputRef = React.useRef(accessTokenInput);
  React.useEffect(() => {
    accessTokenInputRef.current = accessTokenInput;
  }, [accessTokenInput]);
  const composerImagesRef = React.useRef(composerImages);
  React.useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reconnectInFlightRef = React.useRef(false);
  const reconnectAttemptRunnerRef = React.useRef<() => Promise<void>>(
    async () => {},
  );
  const reconnectAttemptRef = React.useRef(0);
  const autoConnectBootstrappedRef = React.useRef(false);
  const connectFlowRef = React.useRef<Promise<void> | null>(null);
  const heartbeatTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const heartbeatInFlightRef = React.useRef(false);
  const heartbeatFailuresRef = React.useRef(0);
  const manualDisconnectRef = React.useRef(false);
  const autoReconnectEnabledRef = React.useRef(false);
  const hasEverConnectedRef = React.useRef(false);
  const lastConnectedAtRef = React.useRef(0);

  const clearReconnectTimer = React.useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const setComposerImages = React.useCallback(
    (
      updater: (
        current: ComposerImageAttachment[],
      ) => ComposerImageAttachment[],
    ) => {
      setComposerImagesRaw((current) => {
        const next = updater(current);
        const nextIds = new Set(next.map((item) => item.id));
        const removed = current.filter((item) => !nextIds.has(item.id));
        revokePreviewUrls(removed);
        return next;
      });
    },
    [],
  );

  const stopHeartbeat = React.useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    heartbeatInFlightRef.current = false;
    heartbeatFailuresRef.current = 0;
  }, []);

  const buildGatewayTarget = React.useCallback((rawUrl: string): string => {
    const normalized = normalizeGatewayUrl(rawUrl);
    return withGatewayAccessToken(normalized, accessTokenInputRef.current);
  }, []);

  const activeSession = React.useMemo(() => {
    if (!view.activeSessionId) return null;
    return view.sessions[view.activeSessionId] || null;
  }, [view.activeSessionId, view.sessions]);

  const sessionMessages = activeSession?.messages || [];
  const chatTimeline = React.useMemo(
    () => buildChatTimeline(sessionMessages),
    [sessionMessages],
  );
  const tokenUsage = React.useMemo(
    () => getLatestTokenUsage(sessionMessages),
    [sessionMessages],
  );

  const terminalIds = React.useMemo(
    () => view.terminals.map((terminal) => terminal.id),
    [view.terminals],
  );
  const terminalBuffer = useTerminalBuffer(
    client,
    connectionStatus === "connected",
    terminalIds,
  );

  const mentionState = React.useMemo(() => {
    return getMentionSuggestions(
      composerValue,
      composerCursor,
      view.terminals,
      view.skills,
    );
  }, [composerCursor, composerValue, view.skills, view.terminals]);

  React.useEffect(() => {
    return () => {
      revokePreviewUrls(composerImagesRef.current);
    };
  }, []);

  const applyLiveUpdate = React.useCallback((update: UIUpdateAction) => {
    const loadBuffer = sessionLoadUpdateBuffersRef.current.get(
      update.sessionId,
    );
    if (loadBuffer) {
      loadBuffer.push(update);
      return;
    }
    setView((previous) => {
      const installedRevision =
        previous.sessionMeta[update.sessionId]?.uiRevision;
      if (
        typeof update.uiRevision === "number" &&
        Number.isFinite(update.uiRevision) &&
        typeof installedRevision === "number" &&
        Number.isFinite(installedRevision) &&
        update.uiRevision <= installedRevision
      ) {
        return previous;
      }
      const sessions = { ...previous.sessions };
      const sessionMeta = { ...previous.sessionMeta };
      const sessionOrder = [...previous.sessionOrder];

      const current = sessions[update.sessionId];
      if (update.type === "SESSION_RENAMED") {
        const nextSession = current ? cloneSession(current) : undefined;
        const currentMeta = sessionMeta[update.sessionId];
        const nextMeta = currentMeta ? { ...currentMeta } : undefined;
        if (
          applyRenameToUnloadedSession(
            nextSession,
            nextMeta,
            update.title,
            Date.now(),
          )
        ) {
          if (nextSession) {
            sessions[update.sessionId] = nextSession;
          }
          if (
            typeof update.uiRevision === "number" &&
            Number.isFinite(update.uiRevision)
          ) {
            nextMeta!.uiRevision = update.uiRevision;
          }
          sessionMeta[update.sessionId] = nextMeta!;
          return {
            ...previous,
            sessions,
            sessionMeta,
            sessionOrder: reorderSessionIds(sessionOrder, sessionMeta),
          };
        }
        if (!currentMeta) {
          const created = createUnloadedRenamedSession(
            update.sessionId,
            update.title,
            Date.now(),
            nextSession,
          );
          sessions[update.sessionId] = created.session;
          created.meta.uiRevision = update.uiRevision;
          sessionMeta[update.sessionId] = created.meta;
          if (!sessionOrder.includes(update.sessionId)) {
            sessionOrder.unshift(update.sessionId);
          }
          return {
            ...previous,
            sessions,
            sessionMeta,
            sessionOrder: reorderSessionIds(sessionOrder, sessionMeta),
          };
        }
      }
      const currentMeta = sessionMeta[update.sessionId];
      if (!currentMeta?.loaded) {
        const nextSession = current
          ? cloneSession(current)
          : createSessionState(update.sessionId, "New Chat");
        const nextMeta: SessionMeta = currentMeta
          ? { ...currentMeta }
          : {
              id: update.sessionId,
              title: nextSession.title,
              updatedAt: Date.now(),
              messagesCount: 0,
              loaded: false,
            };
        applyUiUpdateToUnloadedSession(
          nextSession,
          nextMeta,
          update,
          Date.now(),
        );
        sessions[update.sessionId] = nextSession;
        sessionMeta[update.sessionId] = nextMeta;
        if (!sessionOrder.includes(update.sessionId)) {
          sessionOrder.unshift(update.sessionId);
        }
        return {
          ...previous,
          sessions,
          sessionMeta,
          sessionOrder: reorderSessionIds(sessionOrder, sessionMeta),
        };
      }
      const nextSession = current
        ? cloneSession(current)
        : createSessionState(update.sessionId, "New Chat");
      const wasBusy = nextSession.isBusy;

      if (
        update.type === "ADD_MESSAGE" &&
        update.message.role === "user" &&
        !wasBusy &&
        !nextSession.lockedProfileId
      ) {
        nextSession.lockedProfileId = previous.activeProfileId || null;
      }

      applyUiUpdate(nextSession, update);
      sessions[update.sessionId] = nextSession;

      if (!sessionOrder.includes(update.sessionId)) {
        sessionOrder.unshift(update.sessionId);
      }

      const prevMeta = sessionMeta[update.sessionId];
      sessionMeta[update.sessionId] = buildSessionMeta(nextSession, prevMeta, {
        loaded: true,
        updatedAt: Date.now(),
        uiRevision:
          typeof update.uiRevision === "number" &&
          Number.isFinite(update.uiRevision)
            ? update.uiRevision
            : prevMeta?.uiRevision,
      });

      return {
        ...previous,
        sessions,
        sessionMeta,
        sessionOrder: reorderSessionIds(sessionOrder, sessionMeta),
        activeSessionId: previous.activeSessionId || update.sessionId,
      };
    });
  }, []);

  const bootstrapAfterConnect = React.useCallback(
    async (target: string, source: "manual" | "reconnect") => {
      const terminalPayload = await client.request<{
        terminals: GatewayTerminalSummary[];
      }>("terminal:list", {});
      const terminals = terminalPayload.terminals || [];
      if (terminals.length === 0) {
        throw new Error("No terminal is available on backend.");
      }

      let profiles: GatewayProfileSummary[] = [];
      let activeProfileId = "";
      let skills: SkillSummary[] = [];
      let skillsUnavailable = false;
      let mcpTools: McpServerSummary[] = [];
      let builtInTools: BuiltInToolSummary[] = [];
      let toolsUnavailable = false;
      let connections: GatewayConnectionsSnapshot = {
        ssh: [],
        proxies: [],
        tunnels: [],
      };
      let memoryEnabled = true;
      let commandPolicyMode: CommandPolicyMode = "standard";
      let memory: GatewayMemorySnapshot = {
        filePath: "",
        content: "",
      };
      let commandPolicyLists: CommandPolicyLists = {
        allowlist: [],
        denylist: [],
        asklist: [],
      };
      try {
        const profilePayload = await client.request<{
          activeProfileId: string;
          profiles: GatewayProfileSummary[];
        }>("models:getProfiles", {});
        profiles = profilePayload.profiles || [];
        activeProfileId = profilePayload.activeProfileId || "";
      } catch {
        profiles = [];
        activeProfileId = "";
      }

      try {
        skills = await fetchSkillsSnapshot(client);
      } catch {
        skills = [];
        skillsUnavailable = true;
      }

      try {
        const toolsSnapshot = await fetchToolsSnapshot(client);
        mcpTools = toolsSnapshot.mcpTools;
        builtInTools = toolsSnapshot.builtInTools;
      } catch {
        mcpTools = [];
        builtInTools = [];
        toolsUnavailable = true;
      }

      try {
        const settingsPayload = await client.request<unknown>(
          "settings:get",
          {},
        );
        connections = normalizeConnectionsSnapshot(settingsPayload);
        memoryEnabled = readMemoryEnabledFromSettings(settingsPayload);
        commandPolicyMode = readCommandPolicyModeFromSettings(settingsPayload);
        const profileSnapshot = readProfilesFromSettings(settingsPayload);
        if (profileSnapshot.profiles.length > 0) {
          profiles = profileSnapshot.profiles;
          activeProfileId = profileSnapshot.activeProfileId;
        }
      } catch {
        connections = { ssh: [], proxies: [], tunnels: [] };
      }

      try {
        const policyListsPayload = await client.request<unknown>(
          "settings:getCommandPolicyLists",
          {},
        );
        commandPolicyLists = normalizeCommandPolicyLists(policyListsPayload);
      } catch {
        commandPolicyLists = {
          allowlist: [],
          denylist: [],
          asklist: [],
        };
      }

      try {
        const memoryPayload = await client.request<unknown>("memory:get", {});
        memory = normalizeMemorySnapshot(memoryPayload);
      } catch {
        memory = { filePath: "", content: "" };
      }

      let agentSettings: AgentSettingStateSummary | null = null;
      try {
        const agentSettingsRaw = await client.request<unknown>(
          "agentSettings:get",
          {},
        );
        agentSettings = normalizeAgentSettingState(agentSettingsRaw);
      } catch {
        agentSettings = null;
      }

      const sessionPayload = await client.request<{
        sessions: GatewaySessionSummary[];
        uiRevision?: number;
      }>("session:list", {});
      let summaries = sessionPayload.sessions || [];
      const summaryRevision = summaries.reduce<number | undefined>(
        (latest, summary) =>
          typeof summary.uiRevision === "number" &&
          Number.isFinite(summary.uiRevision)
            ? Math.max(latest ?? summary.uiRevision, summary.uiRevision)
            : latest,
        undefined,
      );
      uiUpdateBootstrapBufferRef.current.discardCoveredBySnapshot(
        sessionPayload.uiRevision ?? summaryRevision,
      );

      if (summaries.length === 0) {
        const created = await client.request<{ sessionId: string }>(
          "gateway:createSession",
          {},
        );
        summaries = [
          {
            id: created.sessionId,
            title: "New Chat",
            updatedAt: Date.now(),
            messagesCount: 0,
            lastMessagePreview: "",
            isBusy: false,
            lockedProfileId: null,
          },
        ];
      }

      const sortedSummaries = [...summaries].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
      const previous = viewRef.current;
      const preferredSummary =
        sortedSummaries.find((item) => item.id === previous.activeSessionId) ||
        sortedSummaries[0];
      if (!preferredSummary) {
        throw new Error("No session available from gateway.");
      }

      const mustLoadSnapshotIds = new Set<string>([
        preferredSummary.id,
        ...sortedSummaries.filter((item) => item.isBusy).map((item) => item.id),
      ]);
      const loadedSnapshots = new Map<string, GatewaySessionSnapshot>();
      await Promise.all(
        [...mustLoadSnapshotIds].map(async (sessionId) => {
          try {
            const payload = await client.request<{
              session: GatewaySessionSnapshot;
            }>("session:get", { sessionId });
            uiUpdateBootstrapBufferRef.current.discardCoveredBySnapshot(
              payload.session.uiRevision,
              sessionId,
            );
            loadedSnapshots.set(sessionId, payload.session);
          } catch (error) {
            if (sessionId === preferredSummary.id) {
              throw error;
            }
          }
        }),
      );

      const sessions: Record<string, SessionState> = {};
      const sessionMeta: Record<string, SessionMeta> = {};
      const activeSessionId = loadedSnapshots.has(preferredSummary.id)
        ? preferredSummary.id
        : sortedSummaries[0]?.id || null;

      for (const summary of sortedSummaries) {
        const snapshot = loadedSnapshots.get(summary.id);
        const loaded = !!snapshot;
        const session = createSessionState(
          summary.id,
          summary.title || "Recovered Session",
        );
        if (snapshot) {
          session.title = snapshot.title || session.title;
          session.messages = (snapshot.messages || []).map(cloneMessage);
          session.isBusy = snapshot.isBusy === true;
          session.isThinking = snapshot.isBusy === true;
          session.lockedProfileId = snapshot.lockedProfileId || null;
        } else {
          session.isBusy = summary.isBusy === true;
          session.isThinking = summary.isBusy === true;
          session.lockedProfileId = summary.lockedProfileId || null;
        }
        sessions[summary.id] = session;
        sessionMeta[summary.id] = {
          id: summary.id,
          title: loaded ? session.title : summary.title || "Recovered Session",
          updatedAt: summary.updatedAt || Date.now(),
          messagesCount: loaded
            ? session.messages.length
            : summary.messagesCount,
          lastMessagePreview: loaded
            ? previewFromSession(session)
            : normalizeSessionPreview(summary.lastMessagePreview || ""),
          loaded,
          uiRevision: snapshot?.uiRevision ?? summary.uiRevision,
        };
      }

      const order = reorderSessionIds(
        sortedSummaries.map((summary) => summary.id),
        sessionMeta,
      );
      const statusLineTarget = withoutGatewayAccessToken(target);

      setView({
        terminals,
        connections,
        sshConnections: buildSshConnectionSummaries(connections),
        skills,
        mcpTools,
        builtInTools,
        profiles,
        activeProfileId,
        agentSettings,
        memoryEnabled,
        commandPolicyMode,
        commandPolicyLists,
        memory,
        sessions,
        sessionMeta,
        sessionOrder: order,
        activeSessionId,
        statusLine:
          source === "reconnect"
            ? `Recovered: ${statusLineTarget}`
            : skillsUnavailable || toolsUnavailable
              ? `Connected: ${statusLineTarget} (skills unavailable)`
              : `Connected: ${statusLineTarget}`,
        desktopActive: false,
        reconnectingTerminalId: null,
        reconnectError: "",
      });
    },
    [client],
  );

  const scheduleReconnect = React.useCallback(
    (reason: string, immediate = false) => {
      if (
        manualDisconnectRef.current ||
        !autoReconnectEnabledRef.current ||
        !hasEverConnectedRef.current
      )
        return;
      if (client.isConnected()) return;
      clearReconnectTimer();

      if (!window.navigator.onLine) {
        setView((previous) => ({
          ...previous,
          statusLine: "Offline. Waiting for network...",
        }));
        return;
      }

      const nextAttempt = reconnectAttemptRef.current + 1;
      if (nextAttempt > RECONNECT_MAX_ATTEMPTS) {
        const stopMessage = `Auto-reconnect stopped after ${RECONNECT_MAX_ATTEMPTS} failed attempts.`;
        reconnectAttemptRef.current = 0;
        reconnectInFlightRef.current = false;
        autoReconnectEnabledRef.current = false;
        clearReconnectTimer();
        setConnectionStatus("disconnected");
        setConnectionError(stopMessage);
        setView((previous) => ({
          ...previous,
          statusLine: `Disconnected: ${reason || "connection failed"}. ${stopMessage}`,
        }));
        return;
      }

      const delay = immediate ? 0 : computeReconnectDelayMs(nextAttempt);
      reconnectAttemptRef.current = nextAttempt;
      setView((previous) => ({
        ...previous,
        statusLine: immediate
          ? `Reconnecting now (${nextAttempt})...`
          : `Disconnected: ${reason}. Reconnecting in ${Math.max(1, Math.ceil(delay / 1000))}s (${nextAttempt})...`,
      }));

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        void reconnectAttemptRunnerRef.current();
      }, delay);
    },
    [clearReconnectTimer, client],
  );

  const startHeartbeat = React.useCallback(() => {
    stopHeartbeat();
    if (!client.isConnected()) return;

    heartbeatTimerRef.current = setInterval(() => {
      if (heartbeatInFlightRef.current || !client.isConnected()) return;
      heartbeatInFlightRef.current = true;
      void client
        .request("gateway:ping", {}, HEARTBEAT_RPC_TIMEOUT_MS)
        .then(() => {
          heartbeatFailuresRef.current = 0;
        })
        .catch(() => {
          heartbeatFailuresRef.current += 1;
          if (heartbeatFailuresRef.current >= HEARTBEAT_MAX_FAILURES) {
            stopHeartbeat();
            setConnectionError("Gateway heartbeat lost. Reconnecting...");
            try {
              client.disconnect();
            } catch {
              // ignore disconnect errors
            }
            scheduleReconnect("heartbeat lost", true);
          }
        })
        .finally(() => {
          heartbeatInFlightRef.current = false;
        });
    }, HEARTBEAT_INTERVAL_MS);
  }, [client, scheduleReconnect, stopHeartbeat]);

  const runConnectFlow = React.useCallback(
    async (target: string, source: "manual" | "reconnect") => {
      if (connectFlowRef.current) {
        await connectFlowRef.current;
        return;
      }
      const flow = (async () => {
        const uiUpdateBuffer = uiUpdateBootstrapBufferRef.current;
        uiUpdateBuffer.begin();
        let snapshotInstalled = false;
        try {
          await client.connect(target);
          if (source === "manual") {
            saveGatewayUrlToStorage(withoutGatewayAccessToken(target));
          }
          await bootstrapAfterConnect(target, source);
          snapshotInstalled = true;
        } finally {
          uiUpdateBuffer.end(applyLiveUpdate, { snapshotInstalled });
        }
        lastConnectedAtRef.current = Date.now();
        hasEverConnectedRef.current = true;
        reconnectAttemptRef.current = 0;
        clearReconnectTimer();
        reconnectInFlightRef.current = false;
        startHeartbeat();
      })();
      connectFlowRef.current = flow.finally(() => {
        connectFlowRef.current = null;
      });
      await connectFlowRef.current;
    },
    [
      applyLiveUpdate,
      bootstrapAfterConnect,
      clearReconnectTimer,
      client,
      startHeartbeat,
    ],
  );

  const runAutoReconnectAttempt = React.useCallback(async () => {
    if (reconnectInFlightRef.current) return;
    if (
      manualDisconnectRef.current ||
      !autoReconnectEnabledRef.current ||
      !hasEverConnectedRef.current
    )
      return;
    if (!window.navigator.onLine) {
      setView((previous) => ({
        ...previous,
        statusLine: "Offline. Waiting for network...",
      }));
      return;
    }

    reconnectInFlightRef.current = true;
    const target = buildGatewayTarget(gatewayInputRef.current);
    try {
      setConnectionError("");
      await runConnectFlow(target, "reconnect");
    } catch (error) {
      reconnectInFlightRef.current = false;
      scheduleReconnect(safeError(error));
    }
  }, [buildGatewayTarget, runConnectFlow, scheduleReconnect]);
  reconnectAttemptRunnerRef.current = runAutoReconnectAttempt;

  React.useEffect(() => {
    const unsubscribers = [
      client.on("status", (status, detail) => {
        const currentReconnectAttempt = reconnectAttemptRef.current;
        setConnectionStatus(status);
        if (status === "connecting") {
          setConnectionError("");
          setView((previous) => ({
            ...previous,
            statusLine:
              currentReconnectAttempt > 0
                ? `Reconnecting gateway... (${currentReconnectAttempt})`
                : "Connecting gateway...",
          }));
        }
        if (status === "connected") {
          setConnectionError("");
          setView((previous) => ({
            ...previous,
            statusLine:
              currentReconnectAttempt > 0
                ? `Gateway reconnected (${currentReconnectAttempt})`
                : "Gateway connected",
          }));
        }
        if (status === "disconnected") {
          stopHeartbeat();
          const reason = detail || "connection closed";
          if (manualDisconnectRef.current) {
            setView((previous) => ({
              ...previous,
              statusLine: "Disconnected by user",
            }));
            return;
          }
          if (!window.navigator.onLine) {
            setView((previous) => ({
              ...previous,
              statusLine: "Offline. Waiting for network...",
            }));
            return;
          }
          setView((previous) => ({
            ...previous,
            statusLine: `Disconnected: ${reason}`,
          }));
          scheduleReconnect(reason);
        }
      }),
      client.on("error", (message) => {
        setConnectionError(message);
      }),
      client.on("uiUpdate", (update) => {
        uiUpdateBootstrapBufferRef.current.handle(update, applyLiveUpdate);
      }),
      client.on("gatewayEvent", (event) => {
        if (event.type !== "system:notification") return;
        const text =
          typeof event.payload === "string"
            ? event.payload
            : JSON.stringify(event.payload);
        setView((previous) => ({ ...previous, statusLine: text }));
      }),
      client.on("raw", (channel, payload) => {
        if (channel === "terminal:tabs") {
          const terminals =
            payload &&
            typeof payload === "object" &&
            "terminals" in payload &&
            Array.isArray((payload as { terminals?: unknown[] }).terminals)
              ? (payload as { terminals: GatewayTerminalSummary[] })
                  .terminals || []
              : [];
          setView((previous) => ({
            ...previous,
            terminals,
            statusLine: `Terminal tabs: ${terminals.length}`,
          }));
          return;
        }

        if (channel === "tools:mcpUpdated") {
          const nextMcpTools = Array.isArray(payload)
            ? payload
                .map((item) => normalizeMcpServer(item))
                .filter((item): item is McpServerSummary => !!item)
            : [];
          setView((previous) => ({
            ...previous,
            mcpTools: nextMcpTools,
            statusLine: `MCP tools updated (${nextMcpTools.length})`,
          }));
          return;
        }

        if (channel === "tools:builtInUpdated") {
          const nextBuiltInTools = Array.isArray(payload)
            ? payload
                .map((item) => normalizeBuiltInTool(item))
                .filter((item): item is BuiltInToolSummary => !!item)
            : [];
          setView((previous) => ({
            ...previous,
            builtInTools: nextBuiltInTools,
            statusLine: `Built-in tools updated (${nextBuiltInTools.length})`,
          }));
          return;
        }

        if (channel === "skills:updated") {
          if (!Array.isArray(payload)) return;
          const enabledNames = collectEnabledSkillNames(payload);
          setView((previous) => {
            const nextSkills =
              previous.skills.length === 0
                ? payload
                    .map((item) => normalizeSkillItem(item, enabledNames))
                    .filter((item): item is SkillSummary => !!item)
                    .sort((left, right) => left.name.localeCompare(right.name))
                : previous.skills.map((skill) => ({
                    ...skill,
                    enabled: enabledNames.has(skill.name),
                  }));
            return {
              ...previous,
              skills: nextSkills,
              statusLine: `Skills updated (${enabledNames.size})`,
            };
          });
          return;
        }

        if (channel === "memory:updated") {
          const nextMemory = normalizeMemorySnapshot(payload);
          setView((previous) => ({
            ...previous,
            memory: nextMemory,
            statusLine: "Memory updated",
          }));
          return;
        }

        if (channel === "settings:updated") {
          const profileSnapshot = readProfilesFromSettings(payload);
          const nextConnections = normalizeConnectionsSnapshot(payload);
          const nextMemoryEnabled = readMemoryEnabledFromSettings(payload);
          const nextPolicyMode = readCommandPolicyModeFromSettings(payload);
          const nextAgentSettings = normalizeAgentSettingState(
            (payload as Record<string, unknown> | undefined)?.agentSettings,
          );
          setView((previous) => ({
            ...previous,
            connections: nextConnections,
            sshConnections: buildSshConnectionSummaries(nextConnections),
            profiles: profileSnapshot.profiles,
            activeProfileId: profileSnapshot.activeProfileId,
            memoryEnabled: nextMemoryEnabled,
            commandPolicyMode: nextPolicyMode,
            // Always apply the normalized snapshot, including the empty state.
            // Gating on profiles.length > 0 would hide a legitimate "last
            // profile deleted from another client" transition and leave stale
            // profiles visible here.
            agentSettings: nextAgentSettings,
            statusLine: "Settings updated",
          }));
          return;
        }

        if (channel === "settings:commandPolicyListsUpdated") {
          const nextLists = normalizeCommandPolicyLists(payload);
          setView((previous) => ({
            ...previous,
            commandPolicyLists: nextLists,
            statusLine: `Command policy updated (${nextLists.allowlist.length}/${nextLists.denylist.length}/${nextLists.asklist.length})`,
          }));
        }
      }),
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      clearReconnectTimer();
      stopHeartbeat();
      autoReconnectEnabledRef.current = false;
      manualDisconnectRef.current = true;
      client.disconnect();
    };
  }, [
    applyLiveUpdate,
    clearReconnectTimer,
    client,
    scheduleReconnect,
    stopHeartbeat,
  ]);

  React.useEffect(() => {
    const onOffline = () => {
      clearReconnectTimer();
      setView((previous) => ({
        ...previous,
        statusLine: "Offline. Waiting for network...",
      }));
    };
    const onOnline = () => {
      if (
        manualDisconnectRef.current ||
        !autoReconnectEnabledRef.current ||
        !hasEverConnectedRef.current
      )
        return;
      if (client.isConnected()) return;
      scheduleReconnect("network restored", true);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [clearReconnectTimer, client, scheduleReconnect]);

  React.useEffect(() => {
    if (autoConnectBootstrappedRef.current) return;
    autoConnectBootstrappedRef.current = true;
    if (!loadGatewayAutoConnectFromStorage()) return;

    const target = buildGatewayTarget(gatewayInputRef.current);
    setActionPending(true);
    setConnectionError("");
    manualDisconnectRef.current = false;
    autoReconnectEnabledRef.current = true;
    reconnectInFlightRef.current = false;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();

    void runConnectFlow(target, "reconnect")
      .catch((error) => {
        setConnectionError(safeError(error));
        scheduleReconnect(safeError(error));
      })
      .finally(() => {
        setActionPending(false);
      });
  }, [
    buildGatewayTarget,
    clearReconnectTimer,
    runConnectFlow,
    scheduleReconnect,
  ]);

  const connectGateway = React.useCallback(async () => {
    const target = buildGatewayTarget(gatewayInput);
    setActionPending(true);
    setConnectionError("");
    saveGatewayAutoConnectToStorage(true);
    manualDisconnectRef.current = false;
    autoReconnectEnabledRef.current = true;
    reconnectInFlightRef.current = false;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();

    try {
      await runConnectFlow(target, "manual");
    } catch (error) {
      setConnectionError(safeError(error));
      scheduleReconnect(safeError(error));
    } finally {
      setActionPending(false);
    }
  }, [
    buildGatewayTarget,
    clearReconnectTimer,
    gatewayInput,
    runConnectFlow,
    scheduleReconnect,
  ]);

  const disconnectGateway = React.useCallback(() => {
    saveGatewayAutoConnectToStorage(false);
    manualDisconnectRef.current = true;
    autoReconnectEnabledRef.current = false;
    reconnectInFlightRef.current = false;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    stopHeartbeat();
    client.disconnect();
    setConnectionStatus("disconnected");
    setConnectionError("");
    setView((previous) => ({
      ...previous,
      statusLine: "Disconnected by user",
    }));
  }, [clearReconnectTimer, client, stopHeartbeat]);

  const ensureSessionLoaded = React.useCallback(
    async (sessionId: string) => {
      const inFlight = sessionLoadPromisesRef.current.get(sessionId);
      if (inFlight) {
        await inFlight;
        return;
      }
      const snapshotState = viewRef.current;
      const currentMeta = snapshotState.sessionMeta[sessionId];
      if (currentMeta?.loaded) return;

      const bufferedUpdates: UIUpdateAction[] = [];
      sessionLoadUpdateBuffersRef.current.set(sessionId, bufferedUpdates);
      const loadPromise = (async () => {
        try {
          const payload = await client.request<{
            session: GatewaySessionSnapshot;
          }>("session:get", { sessionId });
          const snapshot = payload.session;

          setView((previous) => {
            const sessions = { ...previous.sessions };
            const sessionMeta = { ...previous.sessionMeta };

            const nextSession = createSessionState(
              sessionId,
              snapshot.title || "Recovered Session",
            );
            nextSession.messages = (snapshot.messages || []).map(cloneMessage);
            nextSession.isBusy = snapshot.isBusy === true;
            nextSession.isThinking = snapshot.isBusy === true;
            nextSession.lockedProfileId = snapshot.lockedProfileId || null;
            sessions[sessionId] = nextSession;

            sessionMeta[sessionId] = {
              id: sessionId,
              title: nextSession.title,
              updatedAt: snapshot.updatedAt || Date.now(),
              messagesCount: nextSession.messages.length,
              lastMessagePreview: previewFromSession(nextSession),
              loaded: true,
              uiRevision: snapshot.uiRevision,
            };

            return {
              ...previous,
              sessions,
              sessionMeta,
            };
          });
          sessionLoadUpdateBuffersRef.current.delete(sessionId);
          bufferedUpdates
            .filter((update) =>
              shouldReplayUiUpdateAfterSnapshot(
                update,
                snapshot.uiRevision,
              ),
            )
            .forEach(applyLiveUpdate);
        } catch (error) {
          sessionLoadUpdateBuffersRef.current.delete(sessionId);
          bufferedUpdates.forEach(applyLiveUpdate);
          throw error;
        }
      })();
      sessionLoadPromisesRef.current.set(sessionId, loadPromise);
      try {
        await loadPromise;
      } finally {
        if (sessionLoadPromisesRef.current.get(sessionId) === loadPromise) {
          sessionLoadPromisesRef.current.delete(sessionId);
        }
      }
    },
    [applyLiveUpdate, client],
  );

  const switchSession = React.useCallback(
    async (sessionId: string) => {
      try {
        await ensureSessionLoaded(sessionId);
        setView((previous) => ({
          ...previous,
          activeSessionId: sessionId,
          statusLine: `Session: ${compactStatusLabel(previous.sessionMeta[sessionId]?.title || sessionId)}`,
        }));
      } catch (error) {
        setConnectionError(`Failed to load session: ${safeError(error)}`);
      }
    },
    [ensureSessionLoaded],
  );

  const createSessionInternal = React.useCallback(async (): Promise<{
    sessionId: string;
  } | null> => {
    if (!client.isConnected()) {
      setConnectionError("Gateway is not connected");
      return null;
    }

    try {
      const payload = await client.request<{ sessionId: string }>(
        "gateway:createSession",
        {},
      );

      setView((previous) => {
        const sessions = { ...previous.sessions };
        const sessionMeta = { ...previous.sessionMeta };
        const sessionOrder = [
          payload.sessionId,
          ...previous.sessionOrder.filter((id) => id !== payload.sessionId),
        ];
        const nextSession = createSessionState(payload.sessionId);
        sessions[payload.sessionId] = nextSession;
        sessionMeta[payload.sessionId] = {
          id: payload.sessionId,
          title: nextSession.title,
          updatedAt: Date.now(),
          messagesCount: 0,
          lastMessagePreview: "",
          loaded: true,
        };
        return {
          ...previous,
          sessions,
          sessionMeta,
          sessionOrder,
          activeSessionId: payload.sessionId,
          statusLine: `Created session ${payload.sessionId.slice(0, 8)}`,
        };
      });

      return { sessionId: payload.sessionId };
    } catch (error) {
      setConnectionError(`Failed to create session: ${safeError(error)}`);
      return null;
    }
  }, [client]);

  const createSession = React.useCallback(async (): Promise<string | null> => {
    const result = await createSessionInternal();
    return result?.sessionId || null;
  }, [createSessionInternal]);

  const deleteSession = React.useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!sessionId) return false;
      if (!client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return false;
      }

      try {
        await client.request("agent:deleteChatSession", { sessionId });
        setView((previous) => {
          if (!previous.sessionOrder.includes(sessionId)) {
            return previous;
          }

          const sessions = { ...previous.sessions };
          const sessionMeta = { ...previous.sessionMeta };
          const sessionOrder = previous.sessionOrder.filter(
            (id) => id !== sessionId,
          );
          delete sessions[sessionId];
          delete sessionMeta[sessionId];

          const nextActiveSessionId =
            previous.activeSessionId === sessionId
              ? (sessionOrder[0] ?? null)
              : previous.activeSessionId;

          return {
            ...previous,
            sessions,
            sessionMeta,
            sessionOrder,
            activeSessionId: nextActiveSessionId,
            statusLine: `Deleted session ${sessionId.slice(0, 8)}`,
          };
        });
        return true;
      } catch (error) {
        setConnectionError(`Failed to delete session: ${safeError(error)}`);
        return false;
      }
    },
    [client],
  );

  const sanitizeImageAttachmentForSend = React.useCallback(
    (image: InputImageAttachment): InputImageAttachment => {
      const attachmentId = String(image.attachmentId || "").trim();
      const fileName = String(image.fileName || "").trim();
      const mimeType = String(image.mimeType || "").trim();
      const sha256 = String(image.sha256 || "").trim();
      const previewDataUrl = String(image.previewDataUrl || "").trim();
      const status = image.status === "ready" || image.status === "missing" ? image.status : undefined;
      return {
        ...(attachmentId ? { attachmentId } : {}),
        ...(fileName ? { fileName } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof image.sizeBytes === "number" && Number.isFinite(image.sizeBytes) ? { sizeBytes: image.sizeBytes } : {}),
        ...(sha256 ? { sha256 } : {}),
        ...(previewDataUrl ? { previewDataUrl } : {}),
        ...(status ? { status } : {}),
      };
    },
    [],
  );

  const resolveComposerImagesForSend = React.useCallback(
    async (images: ComposerImageAttachment[]): Promise<InputImageAttachment[]> => {
      if (!Array.isArray(images) || images.length === 0) return [];
      const out: InputImageAttachment[] = [];
      for (const image of images) {
        const attachmentId = String(image.attachmentId || "").trim();
        if (attachmentId) {
          const normalized = sanitizeImageAttachmentForSend(image);
          out.push(normalized);
          continue;
        }

        if (image.localFile instanceof File) {
          const dataBase64 = await readFileAsDataUrl(image.localFile);
          const previewDataUrl =
            String(image.previewDataUrl || "").trim() ||
            (await createImagePreviewDataUrl(image.localFile).catch(() => ""));
          const saved = await client.request<InputImageAttachment>(
            "system:saveImageAttachment",
            {
              payload: {
                dataBase64,
                fileName: image.fileName || image.localFile.name || undefined,
                mimeType: image.mimeType || image.localFile.type || undefined,
                ...(previewDataUrl ? { previewDataUrl } : {}),
              },
            },
          );
          const normalized = sanitizeImageAttachmentForSend({
            ...saved,
            fileName: image.fileName || saved.fileName,
            mimeType: image.mimeType || saved.mimeType,
            sizeBytes: image.sizeBytes || saved.sizeBytes,
            previewDataUrl: previewDataUrl || saved.previewDataUrl,
          });
          out.push(normalized);
          continue;
        }
      }
      return out;
    },
    [client, sanitizeImageAttachmentForSend],
  );

  const sendMessage = React.useCallback(async () => {
    const content = composerValue.trim();
    const pendingImages = composerImagesRef.current;
    if (!content && pendingImages.length === 0) return;

    if (!client.isConnected()) {
      setConnectionError(
        connectionStatus === "connecting"
          ? "Gateway is reconnecting. Please wait and retry."
          : "Gateway is disconnected. Please wait for reconnection.",
      );
      return;
    }

    let targetSessionId = viewRef.current.activeSessionId;

    if (!targetSessionId) {
      const created = await createSessionInternal();
      if (!created) return;
      targetSessionId = created.sessionId;
    }

    const snapshot = viewRef.current;
    const session = snapshot.sessions[targetSessionId];
    const encodedText = encodeMentions(
      content,
      snapshot.terminals,
      snapshot.skills,
    );
    let resolvedImages: InputImageAttachment[] = [];
    if (pendingImages.length > 0) {
      try {
        resolvedImages = await resolveComposerImagesForSend(pendingImages);
      } catch (error) {
        setConnectionError(`Failed to prepare images: ${safeError(error)}`);
        return;
      }
    }
    const userInput: UserInputPayload = {
      text: encodedText,
      ...(resolvedImages.length > 0
        ? {
            images: resolvedImages,
          }
        : {}),
    };

    setView((previous) => {
      const sessions = { ...previous.sessions };
      const current = sessions[targetSessionId!];
      if (current) {
        const copy = cloneSession(current);
        copy.isThinking = true;
        copy.isBusy = true;
        if (!current.isBusy) {
          copy.lockedProfileId = previous.activeProfileId || null;
        }
        sessions[targetSessionId!] = copy;
      }
      return {
        ...previous,
        sessions,
        statusLine: "Prompt sent",
      };
    });

    try {
      await client.request("agent:startTaskAsync", {
        sessionId: targetSessionId,
        userInput,
        options: {
          startMode: session?.isBusy ? "inserted" : "normal",
        },
      });
      setComposerValueRaw("");
      setComposerCursor(0);
      setComposerImages(() => []);
    } catch (error) {
      setConnectionError(`Failed to send prompt: ${safeError(error)}`);
      setView((previous) => {
        const sessions = { ...previous.sessions };
        const current = sessions[targetSessionId!];
        if (current) {
          const copy = cloneSession(current);
          copy.isThinking = false;
          copy.isBusy = false;
          copy.lockedProfileId = null;
          sessions[targetSessionId!] = copy;
        }
        return {
          ...previous,
          sessions,
        };
      });
    }
  }, [client, composerValue, connectionStatus, createSessionInternal, resolveComposerImagesForSend, setComposerImages]);

  const stopActiveSession = React.useCallback(async () => {
    const active = viewRef.current.activeSessionId;
    if (!active) return;
    try {
      await client.request("agent:stopTask", { sessionId: active });
      setView((previous) => ({ ...previous, statusLine: "Stop signal sent" }));
    } catch (error) {
      setConnectionError(`Failed to stop: ${safeError(error)}`);
    }
  }, [client]);

  const updateProfile = React.useCallback(
    async (profileId: string) => {
      if (!profileId) return;
      try {
        const payload = await client.request<{
          activeProfileId: string;
          profiles: GatewayProfileSummary[];
        }>("models:setActiveProfile", { profileId });

        setView((previous) => ({
          ...previous,
          profiles: payload.profiles,
          activeProfileId: payload.activeProfileId,
          statusLine: `Profile: ${payload.profiles.find((item) => item.id === payload.activeProfileId)?.name || profileId}`,
        }));
      } catch (error) {
        setConnectionError(`Failed to switch profile: ${safeError(error)}`);
      }
    },
    [client],
  );

  const setSkillEnabled = React.useCallback(
    async (name: string, enabled: boolean) => {
      if (!name || !client.isConnected()) return;
      try {
        const payload = await client.request<{ skills: SkillSummary[] }>(
          "skills:setEnabled",
          {
            name,
            enabled,
          },
        );
        const enabledNames = collectEnabledSkillNames(payload.skills || []);
        setView((previous) => ({
          ...previous,
          skills: previous.skills.map((skill) => ({
            ...skill,
            enabled: enabledNames.has(skill.name),
          })),
          statusLine: `${enabled ? "Enabled" : "Disabled"} skill: ${name}`,
        }));
      } catch (error) {
        setConnectionError(`Failed to update skill: ${safeError(error)}`);
      }
    },
    [client],
  );

  const reloadSkills = React.useCallback(async () => {
    if (!client.isConnected()) return;
    try {
      const nextSkills = await fetchSkillsSnapshot(client);
      setView((previous) => ({
        ...previous,
        skills: mergeSkillsByName(previous.skills, nextSkills),
        statusLine: `Skills refreshed (${nextSkills.length})`,
      }));
    } catch (error) {
      setConnectionError(`Failed to reload skills: ${safeError(error)}`);
    }
  }, [client]);

  const reloadMemory = React.useCallback(async () => {
    if (!client.isConnected()) return;
    try {
      const [settingsPayload, memoryPayload] = await Promise.all([
        client.request<unknown>("settings:get", {}),
        client.request<unknown>("memory:get", {}),
      ]);
      const nextMemoryEnabled = readMemoryEnabledFromSettings(settingsPayload);
      const nextMemory = normalizeMemorySnapshot(memoryPayload);
      setView((previous) => ({
        ...previous,
        memoryEnabled: nextMemoryEnabled,
        memory: nextMemory,
        statusLine: "Memory refreshed",
      }));
    } catch (error) {
      setConnectionError(`Failed to reload memory: ${safeError(error)}`);
    }
  }, [client]);

  const setMcpEnabled = React.useCallback(
    async (name: string, enabled: boolean) => {
      if (!name || !client.isConnected()) return;
      try {
        const payload = await client.request<unknown>("tools:setMcpEnabled", {
          name,
          enabled,
        });
        const nextMcpTools = Array.isArray(payload)
          ? payload
              .map((item) => normalizeMcpServer(item))
              .filter((item): item is McpServerSummary => !!item)
          : [];
        setView((previous) => ({
          ...previous,
          mcpTools: nextMcpTools,
          statusLine: `${enabled ? "Enabled" : "Disabled"} MCP: ${name}`,
        }));
      } catch (error) {
        setConnectionError(`Failed to update MCP server: ${safeError(error)}`);
      }
    },
    [client],
  );

  const setBuiltInToolEnabled = React.useCallback(
    async (
      name: string,
      enabled: boolean,
      acknowledgedExperimentalToolNames: string[] = [],
    ) => {
      if (!name || !client.isConnected()) return;
      try {
        const payload = await client.request<unknown>(
          "tools:setBuiltInEnabled",
          { name, enabled, acknowledgedExperimentalToolNames },
        );
        const confirmationToolNames =
          readExperimentalToolConfirmationRequired(payload);
        if (confirmationToolNames) {
          setConnectionError(
            `Experimental tool confirmation is required: ${confirmationToolNames.join(", ")}`,
          );
          return;
        }
        const nextBuiltInTools = Array.isArray(payload)
          ? payload
              .map((item) => normalizeBuiltInTool(item))
              .filter((item): item is BuiltInToolSummary => !!item)
          : [];
        setView((previous) => ({
          ...previous,
          builtInTools: nextBuiltInTools,
          statusLine: `${enabled ? "Enabled" : "Disabled"} built-in tool: ${name}`,
        }));
      } catch (error) {
        setConnectionError(
          `Failed to update built-in tool: ${safeError(error)}`,
        );
      }
    },
    [client],
  );

  const reloadTools = React.useCallback(async () => {
    if (!client.isConnected()) return;
    try {
      const snapshot = await fetchToolsSnapshot(client);
      setView((previous) => ({
        ...previous,
        mcpTools: snapshot.mcpTools,
        builtInTools: snapshot.builtInTools,
        statusLine: `Tools refreshed (${snapshot.mcpTools.length + snapshot.builtInTools.length})`,
      }));
    } catch (error) {
      setConnectionError(`Failed to reload tools: ${safeError(error)}`);
    }
  }, [client]);

  const replyAsk = React.useCallback(
    async (message: ChatMessage, decision: "allow" | "deny") => {
      const activeSessionId = viewRef.current.activeSessionId;
      if (!activeSessionId) return;

      try {
        if (message.metadata?.approvalId) {
          await client.request("agent:replyCommandApproval", {
            approvalId: message.metadata.approvalId,
            decision,
          });
        } else {
          await client.request("agent:replyMessage", {
            messageId: message.backendMessageId || message.id,
            payload: { decision },
          });
        }

        setView((previous) => {
          const sessions = { ...previous.sessions };
          const current = sessions[activeSessionId];
          if (!current) return previous;

          const copy = cloneSession(current);
          copy.messages = copy.messages.map((item) => {
            if (item.id !== message.id) return item;
            return {
              ...item,
              metadata: {
                ...(item.metadata ?? {}),
                decision,
              },
            };
          });
          sessions[activeSessionId] = copy;

          return {
            ...previous,
            sessions,
            statusLine: `Decision sent: ${decision}`,
          };
        });
      } catch (error) {
        setConnectionError(`Failed to send decision: ${safeError(error)}`);
      }
    },
    [client],
  );

  const rollbackToMessage = React.useCallback(
    async (sessionId: string, messageId: string): Promise<boolean> => {
      if (!sessionId || !messageId) return false;
      if (!client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return false;
      }

      try {
        const payload = await client.request<{
          ok: boolean;
          removedCount: number;
        }>("agent:rollbackToMessage", {
          sessionId,
          messageId,
        });
        if (!payload?.ok) {
          setConnectionError("Rollback target does not exist on backend");
          return false;
        }

        setView((previous) => {
          const current = previous.sessions[sessionId];
          if (!current) {
            return {
              ...previous,
              statusLine: "Rollback completed",
            };
          }

          const rollbackIndex = current.messages.findIndex(
            (item) => item.backendMessageId === messageId,
          );
          if (rollbackIndex === -1) {
            return {
              ...previous,
              statusLine: "Rollback completed",
            };
          }

          const sessions = { ...previous.sessions };
          const sessionMeta = { ...previous.sessionMeta };
          const copy = cloneSession(current);
          copy.messages = copy.messages.slice(0, rollbackIndex);
          copy.isThinking = false;
          copy.isBusy = false;
          copy.lockedProfileId = null;
          sessions[sessionId] = copy;

          const previousMeta = sessionMeta[sessionId];
          sessionMeta[sessionId] = buildSessionMeta(copy, previousMeta, {
            loaded: true,
            updatedAt: Date.now(),
          });

          return {
            ...previous,
            sessions,
            sessionMeta,
            sessionOrder: reorderSessionIds(previous.sessionOrder, sessionMeta),
            statusLine: "Rollback completed",
          };
        });
        return true;
      } catch (error) {
        setConnectionError(`Failed to rollback: ${safeError(error)}`);
        return false;
      }
    },
    [client],
  );

  const setComposerValue = React.useCallback(
    (value: string, cursor: number) => {
      setComposerValueRaw(value);
      setComposerCursor(cursor);
    },
    [],
  );

  const attachImages = React.useCallback(
    async (files: File[]) => {
      if (!Array.isArray(files) || files.length === 0) return;

      const candidates = files.filter((file) => isSupportedImageFile(file));
      if (candidates.length === 0) return;

      const created: ComposerImageAttachment[] = [];
      for (const file of candidates) {
        try {
          const previewDataUrl = await createImagePreviewDataUrl(file).catch(() => "");
          created.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            fileName: file.name || undefined,
            mimeType: file.type || undefined,
            sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
            previewUrl: previewDataUrl || URL.createObjectURL(file),
            ...(previewDataUrl ? { previewDataUrl } : {}),
            localFile: file,
          });
        } catch (error) {
          setConnectionError(`Failed to attach image: ${safeError(error)}`);
        }
      }

      if (created.length === 0) return;
      setComposerImages((current) => [...current, ...created]);
    },
    [setComposerImages],
  );

  const removeComposerImage = React.useCallback(
    (imageId: string) => {
      if (!imageId) return;
      setComposerImages((current) => current.filter((item) => item.id !== imageId));
    },
    [setComposerImages],
  );

  const clearComposerImages = React.useCallback(() => {
    setComposerImages(() => []);
  }, [setComposerImages]);

  const restoreComposerDraft = React.useCallback(
    (value: string, images: InputImageAttachment[]) => {
      const text = String(value || "");
      setComposerValueRaw(text);
      setComposerCursor(text.length);
      const mapped = (Array.isArray(images) ? images : [])
        .filter((item) => !!String(item?.attachmentId || "").trim())
        .map((item, index) => ({
          id: `rollback-${Date.now()}-${index}`,
          ...(item.attachmentId ? { attachmentId: item.attachmentId } : {}),
          fileName: item.fileName || `image-${item.attachmentId || index}`,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          sha256: item.sha256,
          previewDataUrl: item.previewDataUrl,
          status: item.status,
          previewUrl: item.previewDataUrl || "",
        }));
      setComposerImages(() => mapped);
    },
    [setComposerImages],
  );

  const pickMention = React.useCallback(
    (option: MentionOption) => {
      const context = mentionState.context;
      if (!context) return;
      const next = applyMentionToInput(composerValue, context, option);
      setComposerValueRaw(next.value);
      setComposerCursor(next.cursor);
    },
    [composerValue, mentionState.context],
  );

  const reconcileTerminals = React.useCallback(
    (terminals: GatewayTerminalSummary[], statusLine: string) => {
      setView((previous) => {
        return {
          ...previous,
          terminals,
          statusLine,
        };
      });
    },
    [],
  );

  const createTerminalTab = React.useCallback(
    async (target: CreateTerminalTarget = { type: "local" }) => {
      if (!client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return;
      }

      try {
        const snapshot = viewRef.current;
        if (target.type === "ssh") {
          const entry = snapshot.connections.ssh.find(
            (item) => item.id === target.connectionId,
          );
          if (!entry) {
            setConnectionError(
              "SSH connection not found. Please configure it in desktop settings first.",
            );
            return;
          }
          await client.request<{ id: string }>("terminal:createTab", {
            config: toSshConfig(entry, snapshot.connections),
          });
        } else {
          await client.request<{ id: string }>("terminal:createTab", {
            config: {
              type: "local",
              cols: 120,
              rows: 32,
            },
          });
        }

        const payload = await client.request<{
          terminals: GatewayTerminalSummary[];
        }>("terminal:list", {});
        const statusText =
          target.type === "ssh"
            ? "Created SSH terminal"
            : "Created local terminal";
        reconcileTerminals(payload.terminals || [], statusText);
      } catch (error) {
        setConnectionError(`Failed to create terminal: ${safeError(error)}`);
      }
    },
    [client, reconcileTerminals],
  );

  const closeTerminalTab = React.useCallback(
    async (terminalId: string) => {
      if (!terminalId) return;
      if (!client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return;
      }

      const snapshot = viewRef.current;
      if (snapshot.terminals.length <= 1) {
        setConnectionError("Cannot close the last terminal tab");
        return;
      }

      try {
        await client.request("terminal:kill", { terminalId });
        const payload = await client.request<{
          terminals: GatewayTerminalSummary[];
        }>("terminal:list", {});
        reconcileTerminals(payload.terminals || [], "Closed terminal tab");
      } catch (error) {
        setConnectionError(`Failed to close terminal: ${safeError(error)}`);
      }
    },
    [client, reconcileTerminals],
  );

  const setGatewayInput = React.useCallback((value: string) => {
    setGatewayInputRaw(value);
  }, []);

  const setAccessTokenInput = React.useCallback((value: string) => {
    setAccessTokenInputRaw(value);
    saveGatewayAccessTokenToStorage(value);
  }, []);

  const reloadAgentSettings = React.useCallback(async () => {
    if (!client.isConnected()) return;
    setAgentSettingsError("");
    setAgentSettingsLoading(true);
    try {
      const raw = await client.request<unknown>("agentSettings:get", {});
      const next = normalizeAgentSettingState(raw);
      setView((previous) => ({
        ...previous,
        agentSettings: next,
        statusLine: `Agent profiles loaded (${next.profiles.length})`,
      }));
    } catch (error) {
      // Set an empty-but-non-null state so the panel stops auto-retrying.
      // Leaving agentSettings === null would make AgentProfilesPanel's effect
      // call onReload() again immediately (loading flips to false on failure,
      // state is still null) → infinite retry loop on persistent failures.
      setView((previous) => ({
        ...previous,
        agentSettings: { profiles: [], activeProfileId: null },
      }));
      setAgentSettingsError(safeError(error));
    } finally {
      setAgentSettingsLoading(false);
    }
  }, [client]);

  const applyAgentSettingResult = React.useCallback(
    (raw: unknown, statusLine: string) => {
      const record =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const agentSettingsSource = record?.agentSettings ?? raw;
      const state = normalizeAgentSettingState(agentSettingsSource);
      setView((previous) => ({
        ...previous,
        agentSettings: state,
        statusLine,
        ...(record && "commandPolicyLists" in record
          ? {
              commandPolicyLists: normalizeCommandPolicyLists(
                record.commandPolicyLists,
              ),
            }
          : {}),
        ...(record && "commandPolicyMode" in record
          ? (() => {
              const mode = record.commandPolicyMode;
              return mode === "safe" || mode === "standard" || mode === "smart"
                ? { commandPolicyMode: mode }
                : {};
            })()
          : {}),
      }));
    },
    [],
  );

  const saveCurrentAgentSetting = React.useCallback(async (): Promise<boolean> => {
    if (!client.isConnected()) {
      setConnectionError("Gateway is not connected");
      return false;
    }
    setAgentSettingsSaving(true);
    setAgentSettingsError("");
    try {
      const raw = await client.request<unknown>(
        "agentSettings:saveCurrent",
        {},
      );
      applyAgentSettingResult(raw, "Agent profile saved");
      return true;
    } catch (error) {
      const message = safeError(error);
      setAgentSettingsError(
        message.includes("slots")
          ? message
          : `Failed to save agent profile: ${message}`,
      );
      return false;
    } finally {
      setAgentSettingsSaving(false);
    }
  }, [applyAgentSettingResult, client]);

  const applyAgentSetting = React.useCallback(
    async (
      profileId: string,
      acknowledgedExperimentalToolNames: string[] = [],
    ): Promise<AgentSettingApplyOutcome> => {
      if (!profileId || !client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return { applied: false, experimentalToolNames: [] };
      }
      setAgentSettingsSaving(true);
      setAgentSettingsError("");
      try {
        const raw = await client.request<unknown>("agentSettings:apply", {
          profileId,
          acknowledgedExperimentalToolNames,
        });
        const experimentalToolNames =
          readExperimentalToolConfirmationRequired(raw);
        if (experimentalToolNames) {
          return { applied: false, experimentalToolNames };
        }
        applyAgentSettingResult(raw, "Agent profile applied");
        return { applied: true, experimentalToolNames: [] };
      } catch (error) {
        setAgentSettingsError(`Failed to apply agent profile: ${safeError(error)}`);
        return { applied: false, experimentalToolNames: [] };
      } finally {
        setAgentSettingsSaving(false);
      }
    },
    [applyAgentSettingResult, client],
  );

  const deleteAgentSetting = React.useCallback(
    async (profileId: string): Promise<boolean> => {
      if (!profileId || !client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return false;
      }
      setAgentSettingsSaving(true);
      setAgentSettingsError("");
      try {
        const raw = await client.request<unknown>("agentSettings:delete", {
          profileId,
        });
        applyAgentSettingResult(raw, "Agent profile deleted");
        return true;
      } catch (error) {
        setAgentSettingsError(
          `Failed to delete agent profile: ${safeError(error)}`,
        );
        return false;
      } finally {
        setAgentSettingsSaving(false);
      }
    },
    [applyAgentSettingResult, client],
  );

  const branchFromMessage = React.useCallback(
    async (
      sessionId: string,
      messageId: string,
    ): Promise<string | null> => {
      if (!sessionId || !messageId) return null;
      if (!client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return null;
      }
      setActionPending(true);
      try {
        const payload = await client.request<{
          ok: boolean;
          sessionId?: string;
          title?: string;
          messageCount?: number;
          reason?: string;
        }>("agent:branchFromMessage", { sessionId, messageId });
        if (!payload?.ok || !payload.sessionId) {
          setConnectionError(payload?.reason || "Branch failed");
          return null;
        }
        const branchSessionId = payload.sessionId;
        // Load the branched session snapshot and surface it as the new active session.
        try {
          const snapshotPayload = await client.request<{
            session: GatewaySessionSnapshot;
          }>("session:get", { sessionId: branchSessionId });
          const snapshot = snapshotPayload.session;
          setView((previous) => {
            const sessions = { ...previous.sessions };
            const sessionMeta = { ...previous.sessionMeta };
            const nextSession = createSessionState(
              branchSessionId,
              snapshot.title || payload.title || "Branched Session",
            );
            nextSession.messages = (snapshot.messages || []).map(cloneMessage);
            nextSession.isBusy = snapshot.isBusy === true;
            nextSession.isThinking = snapshot.isBusy === true;
            nextSession.lockedProfileId = snapshot.lockedProfileId || null;
            sessions[branchSessionId] = nextSession;
            sessionMeta[branchSessionId] = {
              id: branchSessionId,
              title: nextSession.title,
              updatedAt: snapshot.updatedAt || Date.now(),
              messagesCount: nextSession.messages.length,
              lastMessagePreview: previewFromSession(nextSession),
              loaded: true,
              uiRevision: snapshot.uiRevision,
            };
            const sessionOrder = [
              branchSessionId,
              ...previous.sessionOrder.filter((id) => id !== branchSessionId),
            ];
            return {
              ...previous,
              sessions,
              sessionMeta,
              sessionOrder: reorderSessionIds(sessionOrder, sessionMeta),
              activeSessionId: branchSessionId,
              statusLine: `Branched session ${branchSessionId.slice(0, 8)}`,
            };
          });
        } catch {
          // Snapshot load failed; still switch active so user sees the branch attempt.
          setView((previous) => ({
            ...previous,
            activeSessionId: branchSessionId,
            sessionOrder: [
              branchSessionId,
              ...previous.sessionOrder.filter((id) => id !== branchSessionId),
            ],
            statusLine: `Branched session ${branchSessionId.slice(0, 8)}`,
          }));
        }
        return branchSessionId;
      } catch (error) {
        setConnectionError(`Failed to branch: ${safeError(error)}`);
        return null;
      } finally {
        setActionPending(false);
      }
    },
    [client],
  );

  const reconnectTerminalTab = React.useCallback(
    async (terminalId: string): Promise<boolean> => {
      if (!terminalId || !client.isConnected()) {
        setConnectionError("Gateway is not connected");
        return false;
      }
      setView((previous) => ({
        ...previous,
        reconnectingTerminalId: terminalId,
        reconnectError: "",
      }));
      try {
        await client.request<{ id: string }>("terminal:reconnect", {
          terminalId,
        });
        const payload = await client.request<{
          terminals: GatewayTerminalSummary[];
        }>("terminal:list", {});
        setView((previous) => ({
          ...previous,
          terminals: payload.terminals || [],
          reconnectingTerminalId: null,
          statusLine: "SSH terminal reconnected",
        }));
        return true;
      } catch (error) {
        setView((previous) => ({
          ...previous,
          reconnectingTerminalId: null,
          reconnectError: safeError(error),
        }));
        return false;
      }
    },
    [client],
  );

  const clearReconnectError = React.useCallback(() => {
    setView((previous) =>
      previous.reconnectError === "" && previous.reconnectingTerminalId === null
        ? previous
        : { ...previous, reconnectError: "", reconnectingTerminalId: null },
    );
  }, []);

  const pendingApprovalCount = React.useMemo(
    () => countPendingApprovals(view.sessions),
    [view.sessions],
  );
  const firstApprovalSessionId = React.useMemo(
    () =>
      findFirstApprovalSession(
        view.sessionOrder,
        view.sessionMeta,
        view.sessions,
      ),
    [view.sessionOrder, view.sessionMeta, view.sessions],
  );
  const sessionStatuses = React.useMemo(() => {
    const map: Record<string, SessionStatusInfo> = {};
    for (const [id, session] of Object.entries(view.sessions)) {
      map[id] = deriveSessionStatus(session);
    }
    return map;
  }, [view.sessions]);
  const sessionTokenPercents = React.useMemo(() => {
    const map: Record<string, number | null> = {};
    for (const [id, session] of Object.entries(view.sessions)) {
      const usage = getLatestTokenUsage(session.messages);
      map[id] = usage.percent;
    }
    return map;
  }, [view.sessions]);

  const state: MobileControllerState = {
    gatewayInput,
    accessTokenInput,
    connectionStatus,
    connectionError,
    actionPending,
    composerValue,
    composerCursor,
    composerImages,
    mentionOptions: mentionState.options,
    terminals: view.terminals,
    sshConnections: view.sshConnections,
    skills: view.skills,
    mcpTools: view.mcpTools,
    builtInTools: view.builtInTools,
    profiles: view.profiles,
    activeProfileId: view.activeProfileId,
    agentSettings: view.agentSettings,
    agentSettingsLoading,
    agentSettingsError,
    agentSettingsSaving,
    memoryEnabled: view.memoryEnabled,
    commandPolicyMode: view.commandPolicyMode,
    commandPolicyLists: view.commandPolicyLists,
    memoryFilePath: view.memory.filePath,
    memoryContent: view.memory.content,
    activeSession,
    activeSessionId: view.activeSessionId,
    chatTimeline,
    sessionOrder: view.sessionOrder,
    sessionMeta: view.sessionMeta,
    sessions: view.sessions,
    statusLine: view.statusLine,
    isRunning: !!(activeSession?.isBusy || activeSession?.isThinking),
    latestTokens: tokenUsage.totalTokens,
    latestMaxTokens: tokenUsage.maxTokens,
    tokenUsagePercent: tokenUsage.percent,
    pendingApprovalCount,
    firstApprovalSessionId,
    desktopActive: view.desktopActive,
    reconnectingTerminalId: view.reconnectingTerminalId,
    reconnectError: view.reconnectError,
    sessionStatuses,
    sessionTokenPercents,
    terminalBuffers: terminalBuffer.buffers,
  };

  const actions: MobileControllerActions = {
    setGatewayInput,
    setAccessTokenInput,
    setComposerValue,
    setComposerCursor,
    attachImages,
    removeComposerImage,
    clearComposerImages,
    restoreComposerDraft,
    pickMention,
    connectGateway,
    disconnectGateway,
    switchSession,
    createSession,
    deleteSession,
    sendMessage,
    stopActiveSession,
    updateProfile,
    reloadSkills,
    setSkillEnabled,
    reloadMemory,
    reloadTools,
    setMcpEnabled,
    setBuiltInToolEnabled,
    replyAsk,
    rollbackToMessage,
    branchFromMessage,
    createTerminalTab,
    closeTerminalTab,
    reconnectTerminalTab,
    clearReconnectError,
    refreshTerminalBuffers: terminalBuffer.refresh,
    markTerminalBufferSeen: terminalBuffer.markSeen,
    reloadAgentSettings,
    saveCurrentAgentSetting,
    applyAgentSetting,
    deleteAgentSetting,
  };

  return {
    state,
    actions,
  };
}
