import {
  makeObservable,
  observable,
  action,
  runInAction,
  computed,
  ObservableMap,
} from "mobx";
import { v4 as uuidv4 } from "uuid";
import { ChatQueueStore, type QueueItem } from "./ChatQueueStore";
import type { InputImageAttachment, UserInputPayload } from "../lib/userInput";
import { WINDOW_CONTEXT } from "../lib/windowing";
import type { CommandOutputContractV1 } from "@gyshell/shared";

const SESSION_REGISTRATION_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_600];

const isSessionRegistrationHandlerUnavailable = (error: unknown): boolean =>
  /No handler registered for ['"]agent:registerSession['"]/i.test(
    error instanceof Error ? error.message : String(error),
  );

const waitForSessionRegistrationRetry = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const buildAutoSessionTitle = (content: string): string => {
  const normalized = String(content || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "New Chat";
};

export type MessageType =
  | "text"
  | "command"
  | "tool_call"
  | "file_edit"
  | "sub_tool"
  | "reasoning"
  | "compaction"
  | "compaction_boundary"
  | "alert"
  | "error"
  | "ask"
  | "tokens_count";

export interface ChatMessage {
  id: string;
  backendMessageId?: string;
  role: "user" | "assistant" | "system";
  type: MessageType;
  content: string;
  metadata?: {
    tabName?: string;
    commandId?: string;
    exitCode?: number;
    output?: string;
    diff?: string;
    filePath?: string;
    action?: "created" | "edited" | "error";
    collapsed?: boolean;
    isNowait?: boolean;
    commandOutput?: CommandOutputContractV1;
    toolName?: string;
    subToolTitle?: string;
    subToolHint?: string;
    subToolLevel?: "info" | "warning" | "error";
    approvalId?: string;
    decision?: "allow" | "deny";
    command?: string;
    modelName?: string;
    totalTokens?: number;
    maxTokens?: number;
    details?: string;
    inputKind?: "normal" | "inserted";
    inputImages?: InputImageAttachment[];
    compactionBoundaryTargetBackendMessageId?: string;
    compactionBoundaryPreviousBackendMessageId?: string;
    compactionBoundarySummaryBackendMessageId?: string;
    compactionBoundaryProtectedNormalRounds?: number;
  };
  timestamp: number;
  streaming?: boolean;
  deferredPayload?: {
    fields: Array<"content" | "output" | "diff" | "details" | "inputImages">;
  };
}

export interface ChatSession {
  id: string;
  title: string;
  messagesById: ObservableMap<string, ChatMessage>;
  messageIds: string[];
  renderListVersion: number;
  isThinking: boolean;
  isSessionBusy: boolean;
  lockedProfileId: string | null;
  totalMessageCount?: number;
  loadedStartPosition?: number | null;
  loadedEndPosition?: number | null;
  hasOlderMessages?: boolean;
  hasNewerMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  isLoadingNewerMessages?: boolean;
  hasLoadedMessagePage?: boolean;
  uiRevision?: number;
}

interface SessionMetadataPayload {
  id: string;
  title: string;
  updatedAt?: number;
  messagesCount?: number;
  isBusy?: boolean;
  lockedProfileId?: string | null;
  uiRevision?: number;
  revisionPresent?: boolean;
}

interface UiMessagePagePayload {
  sessionId: string;
  entries: Array<{ position: number; message: ChatMessage }>;
  totalCount: number;
  startPosition: number | null;
  endPosition: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  uiRevision: number;
  metadata?: SessionMetadataPayload | null;
  revisionPresent?: boolean;
}

interface ChatHydrationPayload {
  id: string;
  exists: boolean;
  loaded: boolean;
  title: string | null;
  messages: ChatMessage[];
  page?: UiMessagePagePayload | null;
  isBusy: boolean;
  lockedProfileId: string | null;
  totalMessageCount: number;
  uiRevision: number;
}

const normalizeBoundaryBackendId = (value: unknown): string => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
};

const normalizeCompactionBoundaryMessageOrder = (
  messages: ChatMessage[],
): ChatMessage[] => {
  if (messages.length === 0) return messages;

  const baseMessages: ChatMessage[] = [];
  const boundaryMessages: ChatMessage[] = [];
  messages.forEach((message) => {
    if (message.type === "compaction_boundary") {
      boundaryMessages.push({
        ...message,
        role: "system",
        content: "",
        streaming: false,
      });
      return;
    }
    baseMessages.push(message);
  });

  if (boundaryMessages.length === 0) return messages;

  const normalized = [...baseMessages];
  const seenBoundaryKeys = new Set<string>();

  boundaryMessages.forEach((boundary) => {
    const targetBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    const previousBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryPreviousBackendMessageId,
    );
    const summaryBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundarySummaryBackendMessageId,
    );
    const boundaryKey =
      summaryBackendId ||
      targetBackendId ||
      previousBackendId ||
      boundary.backendMessageId ||
      boundary.id;
    if (seenBoundaryKeys.has(boundaryKey)) return;

    if (targetBackendId) {
      const targetIndex = normalized.findIndex(
        (message) => message.backendMessageId === targetBackendId,
      );
      if (targetIndex < 0) return;
      normalized.splice(targetIndex, 0, boundary);
      seenBoundaryKeys.add(boundaryKey);
      return;
    }

    if (previousBackendId) {
      const previousIndex = normalized.findIndex(
        (message) => message.backendMessageId === previousBackendId,
      );
      if (previousIndex < 0) return;
      normalized.splice(previousIndex + 1, 0, boundary);
      seenBoundaryKeys.add(boundaryKey);
    }
  });

  return normalized;
};

export class ChatStore {
  sessions: ChatSession[] = [];
  sessionInventoryHydrated = false;
  activeSessionId: string | null = null;
  queue = new ChatQueueStore();
  private queueRunner?: (
    sessionId: string,
    input: UserInputPayload,
  ) => Promise<boolean>;
  private sessionsChangedListener?: (sessionIds: string[]) => void;
  private ownedBackendSessionIds = new Set<string>();
  private sessionOwnershipVersions = new Map<string, number>();
  private sessionRegistrationPromises = new Map<string, Promise<void>>();
  private pendingUiUpdatesBySession = new Map<
    string,
    Array<{ sequence: number; update: any }>
  >();
  private recentUiUpdatesBySession = new Map<
    string,
    Array<{ sequence: number; update: any }>
  >();
  private uiUpdateSequence = 0;
  private sessionLoadPromises = new Map<string, Promise<void>>();
  private fullMessageLoadPromises = new Map<string, Promise<ChatMessage[]>>();
  private readonly initialMessagePageSize = 300;
  private readonly maxLoadedMessagesPerSession = WINDOW_CONTEXT.safeMode
    ? 300
    : 600;

  constructor() {
    makeObservable(this, {
      sessions: observable,
      sessionInventoryHydrated: observable,
      activeSessionId: observable,
      activeSession: computed,
      activeSessionLatestTokens: computed,
      activeSessionLatestMaxTokens: computed,
      hydrateSessionInventoryFromLayout: action,
      hydrateSessionsFromBackend: action,
      createSession: action,
      ensureSession: action,
      setActiveSession: action,
      closeSession: action,
      addMessage: action,
      updateMessage: action,
      removeMessage: action,
      setThinking: action,
      setSessionBusy: action,
      clear: action,
      handleUiUpdate: action,
      hydrateSessionFromBackend: action,
      loadChatHistory: action,
      loadOlderMessages: action,
      loadNewerMessages: action,
      loadMessagesAroundPosition: action,
      loadFullMessages: action,
      searchMessages: action,
      deleteChatSession: action,
      deleteChatSessions: action,
      renameChatSession: action,
      branchFromMessage: action,
      rollbackToMessage: action,
      setSessionLockedProfile: action,
      setQueueRunner: action,
      setSessionsChangedListener: action,
      setQueueMode: action,
      startQueue: action,
      stopQueue: action,
      addQueueItem: action,
      removeQueueItem: action,
      moveQueueItem: action,
    });

    // Create default session
    this.createSession("New Chat");
  }

  private createEmptySession(
    id: string,
    title: string,
    options?: { loaded?: boolean },
  ): ChatSession {
    const loaded = options?.loaded === true;
    return {
      id,
      title,
      messagesById: observable.map<string, ChatMessage>(),
      messageIds: [],
      renderListVersion: 0,
      isThinking: false,
      isSessionBusy: false,
      lockedProfileId: null,
      totalMessageCount: 0,
      loadedStartPosition: loaded ? 0 : null,
      loadedEndPosition: loaded ? -1 : null,
      hasOlderMessages: false,
      hasNewerMessages: false,
      isLoadingOlderMessages: false,
      isLoadingNewerMessages: false,
      hasLoadedMessagePage: loaded,
      uiRevision: 0,
    };
  }

  private markEmptySessionLoaded(session: ChatSession): void {
    session.totalMessageCount = 0;
    session.loadedStartPosition = 0;
    session.loadedEndPosition = -1;
    session.hasOlderMessages = false;
    session.hasNewerMessages = false;
    session.hasLoadedMessagePage = true;
  }

  private bumpSessionRenderListVersion(session: ChatSession): void {
    session.renderListVersion += 1;
  }

  private async invokeSessionRegistrationWithRetry(
    sessionId: string,
    ownershipVersion: number,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= SESSION_REGISTRATION_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      if (
        attempt > 0 &&
        (!this.ownedBackendSessionIds.has(sessionId) ||
          this.sessionOwnershipVersions.get(sessionId) !== ownershipVersion)
      ) {
        return;
      }
      try {
        await window.gyshell.agent.registerSession(sessionId);
        return;
      } catch (error) {
        const retryDelay = SESSION_REGISTRATION_RETRY_DELAYS_MS[attempt];
        if (
          retryDelay === undefined ||
          !isSessionRegistrationHandlerUnavailable(error)
        ) {
          throw error;
        }
        await waitForSessionRegistrationRetry(retryDelay);
      }
    }
  }

  private registerSessionWithBackend(sessionId: string): void {
    if (
      typeof window === "undefined" ||
      typeof window.gyshell?.agent?.registerSession !== "function"
    ) {
      return;
    }
    if (this.ownedBackendSessionIds.has(sessionId)) {
      return;
    }
    this.ownedBackendSessionIds.add(sessionId);
    const ownershipVersion =
      (this.sessionOwnershipVersions.get(sessionId) || 0) + 1;
    this.sessionOwnershipVersions.set(sessionId, ownershipVersion);
    const previous = this.sessionRegistrationPromises.get(sessionId);
    const registration = (previous || Promise.resolve())
      .then(() =>
        this.invokeSessionRegistrationWithRetry(sessionId, ownershipVersion),
      )
      .catch((error) => {
        if (
          this.sessionOwnershipVersions.get(sessionId) === ownershipVersion
        ) {
          this.ownedBackendSessionIds.delete(sessionId);
        }
        console.error(`Failed to register chat session ${sessionId}:`, error);
      });
    this.sessionRegistrationPromises.set(sessionId, registration);
    void registration.then(() => {
      if (this.sessionRegistrationPromises.get(sessionId) === registration) {
        this.sessionRegistrationPromises.delete(sessionId);
      }
    });
  }

  private unregisterSessionWithBackend(sessionId: string): void {
    if (!this.ownedBackendSessionIds.delete(sessionId)) {
      return;
    }
    this.sessionOwnershipVersions.set(
      sessionId,
      (this.sessionOwnershipVersions.get(sessionId) || 0) + 1,
    );
    if (
      typeof window === "undefined" ||
      typeof window.gyshell?.agent?.unregisterSession !== "function"
    ) {
      this.sessionRegistrationPromises.delete(sessionId);
      return;
    }
    const previous = this.sessionRegistrationPromises.get(sessionId);
    const unregister = (previous || Promise.resolve())
      .then(() => window.gyshell.agent.unregisterSession(sessionId))
      .catch((error) => {
        console.error(`Failed to unregister chat session ${sessionId}:`, error);
      });
    this.sessionRegistrationPromises.set(sessionId, unregister);
    void unregister.then(() => {
      if (this.sessionRegistrationPromises.get(sessionId) === unregister) {
        this.sessionRegistrationPromises.delete(sessionId);
      }
    });
  }

  registerSessionOwnership(sessionId: string): void {
    this.registerSessionWithBackend(sessionId);
  }

  unregisterSessionOwnership(sessionId: string): void {
    this.unregisterSessionWithBackend(sessionId);
  }

  private async ensureSessionOwnershipRegistered(
    sessionId: string,
  ): Promise<boolean> {
    let failedStableRegistrations = 0;
    while (failedStableRegistrations < 2) {
      this.registerSessionWithBackend(sessionId);
      const ownershipVersion = this.sessionOwnershipVersions.get(sessionId);
      const pendingOperation = this.sessionRegistrationPromises.get(sessionId);
      await pendingOperation;

      if (
        this.sessionOwnershipVersions.get(sessionId) !== ownershipVersion ||
        (this.sessionRegistrationPromises.get(sessionId) &&
          this.sessionRegistrationPromises.get(sessionId) !== pendingOperation)
      ) {
        continue;
      }
      if (this.ownedBackendSessionIds.has(sessionId)) {
        return true;
      }
      failedStableRegistrations += 1;
    }
    return false;
  }

  get activeSession(): ChatSession | null {
    return this.sessions.find((s) => s.id === this.activeSessionId) || null;
  }

  get activeSessionLatestTokens(): number {
    return this.getLatestTokens(this.activeSessionId);
  }

  get activeSessionLatestMaxTokens(): number {
    return this.getLatestMaxTokens(this.activeSessionId);
  }

  getLatestTokens(sessionId: string | null): number {
    const session = this.getSessionById(sessionId);
    if (!session) return 0;
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i]);
      if (msg && msg.type === "tokens_count") {
        return msg.metadata?.totalTokens || 0;
      }
    }
    return 0;
  }

  getLatestMaxTokens(sessionId: string | null): number {
    const session = this.getSessionById(sessionId);
    if (!session) return 0;
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i]);
      if (msg && msg.type === "tokens_count") {
        return msg.metadata?.maxTokens || 0;
      }
    }
    return 0;
  }

  getSessionById(sessionId: string | null): ChatSession | null {
    if (!sessionId) return null;
    return this.sessions.find((session) => session.id === sessionId) || null;
  }

  setSessionsChangedListener(listener?: (sessionIds: string[]) => void): void {
    this.sessionsChangedListener = listener;
  }

  private emitSessionsChanged(): void {
    this.sessionsChangedListener?.(this.sessions.map((session) => session.id));
  }

  hydrateSessionInventoryFromLayout(
    sessionIds: string[],
    preferredActiveSessionId?: string | null,
  ): void {
    const ids = Array.from(
      new Set(
        (sessionIds || []).filter(
          (id) => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (ids.length === 0) {
      this.sessionInventoryHydrated = true;
      return;
    }

    const existingById = new Map(
      this.sessions.map((session) => [session.id, session]),
    );
    this.sessions
      .filter((session) => !ids.includes(session.id))
      .forEach((session) => this.unregisterSessionWithBackend(session.id));
    const nextSessions = ids.map(
      (id) =>
        existingById.get(id) ||
        this.createEmptySession(id, "New Chat", { loaded: false }),
    );
    nextSessions.forEach((session) =>
      this.registerSessionWithBackend(session.id),
    );
    this.sessions = nextSessions;
    const normalizedPreferredActiveId =
      typeof preferredActiveSessionId === "string" &&
      preferredActiveSessionId.length > 0
        ? preferredActiveSessionId
        : null;
    const preferredActiveExists =
      !!normalizedPreferredActiveId &&
      nextSessions.some(
        (session) => session.id === normalizedPreferredActiveId,
      );
    const currentActiveExists =
      !!this.activeSessionId &&
      nextSessions.some((session) => session.id === this.activeSessionId);

    if (preferredActiveExists) {
      this.activeSessionId = normalizedPreferredActiveId;
    } else if (!currentActiveExists) {
      this.activeSessionId = nextSessions[0]?.id || null;
    }
    this.sessionInventoryHydrated = true;
  }

  private isTranscriptUiUpdate(updateType: unknown): boolean {
    return new Set([
      "ADD_MESSAGE",
      "INSERT_MESSAGE",
      "REMOVE_MESSAGE",
      "APPEND_CONTENT",
      "APPEND_OUTPUT",
      "UPDATE_MESSAGE",
      "ROLLBACK",
    ]).has(String(updateType || ""));
  }

  private normalizeUiRevision(value: unknown): number {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }

  private isUiRevisionStale(
    incomingRevision: number,
    currentRevision: number,
  ): boolean {
    return (
      currentRevision > 0 &&
      (incomingRevision === 0 || incomingRevision < currentRevision)
    );
  }

  private getPageRevision(page: UiMessagePagePayload): number {
    return Math.max(
      this.normalizeUiRevision(page.uiRevision),
      this.normalizeUiRevision(page.metadata?.uiRevision),
    );
  }

  private isVersionedResponseStale(
    response: unknown,
    currentRevision: number,
  ): boolean {
    if (!response || typeof response !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(response, "uiRevision")) {
      // Older mobile/TUI/CLI-compatible transports do not expose revisions.
      return false;
    }
    return this.isUiRevisionStale(
      this.normalizeUiRevision((response as any).uiRevision),
      currentRevision,
    );
  }

  private recordUiUpdate(sessionId: string, update: any): {
    sequence: number;
    update: any;
  } {
    const recorded = { sequence: ++this.uiUpdateSequence, update };
    const recent = this.recentUiUpdatesBySession.get(sessionId) || [];
    recent.push(recorded);
    const maxRecent = 1_000;
    if (recent.length > maxRecent) {
      recent.splice(0, recent.length - maxRecent);
    }
    this.recentUiUpdatesBySession.set(sessionId, recent);
    return recorded;
  }

  private queuePendingUiUpdate(
    sessionId: string,
    recorded: { sequence: number; update: any },
  ): void {
    const pending = this.pendingUiUpdatesBySession.get(sessionId) || [];
    pending.push(recorded);
    const maxPending = 1_000;
    if (pending.length > maxPending) {
      pending.splice(0, pending.length - maxPending);
    }
    this.pendingUiUpdatesBySession.set(sessionId, pending);
  }

  private normalizeUiMessagePage(
    raw: unknown,
    sessionId: string,
  ): UiMessagePagePayload | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as any;
    if (!Array.isArray(value.entries)) return null;
    const entries = value.entries
      .map((entry: any) => {
        const position = Number(entry?.position);
        const message = entry?.message;
        if (
          !Number.isFinite(position) ||
          !message ||
          typeof message.id !== "string" ||
          message.id.length === 0
        ) {
          return null;
        }
        return { position: Math.floor(position), message: message as ChatMessage };
      })
      .filter(
        (entry: { position: number; message: ChatMessage } | null):
          entry is { position: number; message: ChatMessage } => !!entry,
      )
      .sort(
        (
          left: { position: number; message: ChatMessage },
          right: { position: number; message: ChatMessage },
        ) => left.position - right.position,
      );
    const totalCount = Math.max(
      entries.length,
      Number.isFinite(Number(value.totalCount))
        ? Math.floor(Number(value.totalCount))
        : entries.length,
    );
    return {
      sessionId,
      entries,
      totalCount,
      startPosition:
        value.startPosition === null || value.startPosition === undefined
          ? entries[0]?.position ?? null
          : Math.max(0, Math.floor(Number(value.startPosition))),
      endPosition:
        value.endPosition === null || value.endPosition === undefined
          ? entries[entries.length - 1]?.position ?? null
          : Math.max(0, Math.floor(Number(value.endPosition))),
      hasOlder: value.hasOlder === true,
      hasNewer: value.hasNewer === true,
      uiRevision: Math.max(
        this.normalizeUiRevision(value.uiRevision),
        this.normalizeUiRevision(value.metadata?.uiRevision),
      ),
      metadata:
        value.metadata && typeof value.metadata === "object"
          ? {
              ...(value.metadata as SessionMetadataPayload),
              revisionPresent:
                Object.prototype.hasOwnProperty.call(value.metadata, "uiRevision"),
            }
          : null,
      revisionPresent:
        Object.prototype.hasOwnProperty.call(value, "uiRevision") ||
        (value.metadata &&
          typeof value.metadata === "object" &&
          Object.prototype.hasOwnProperty.call(value.metadata, "uiRevision")),
    };
  }

  private applySessionMetadata(
    session: ChatSession,
    metadata: SessionMetadataPayload | null,
    fallbackTitle?: string | null,
  ): void {
    const incomingRevision = this.normalizeUiRevision(metadata?.uiRevision);
    const currentRevision = session.uiRevision || 0;
    const revisionPresent =
      metadata?.revisionPresent ?? metadata?.uiRevision !== undefined;
    if (
      revisionPresent &&
      this.isUiRevisionStale(incomingRevision, currentRevision)
    ) {
      return;
    }
    const title = String(metadata?.title || fallbackTitle || "").trim();
    if (title) session.title = title;
    if (typeof metadata?.messagesCount === "number") {
      session.totalMessageCount = Math.max(0, Math.floor(metadata.messagesCount));
    }
    if (metadata?.isBusy !== undefined) {
      session.isThinking = metadata.isBusy === true;
      session.isSessionBusy = metadata.isBusy === true;
    }
    if (metadata?.lockedProfileId !== undefined) {
      session.lockedProfileId = metadata.lockedProfileId || null;
    }
    session.uiRevision = Math.max(currentRevision, incomingRevision);
  }

  private applyMessagePage(
    session: ChatSession,
    page: UiMessagePagePayload,
    mode: "replace" | "prepend" | "append" = "replace",
  ): boolean {
    const incomingRevision = this.getPageRevision(page);
    if (
      page.revisionPresent !== false &&
      this.isUiRevisionStale(incomingRevision, session.uiRevision || 0)
    ) {
      return false;
    }

    this.applySessionMetadata(session, page.metadata || null);
    const incomingIds = page.entries.map((entry) => entry.message.id);
    const incomingIdSet = new Set(incomingIds);
    page.entries.forEach((entry) => {
      session.messagesById.set(entry.message.id, entry.message);
    });

    if (mode === "replace") {
      session.messagesById.clear();
      page.entries.forEach((entry) => {
        session.messagesById.set(entry.message.id, entry.message);
      });
      session.messageIds = [...incomingIds];
    } else if (mode === "prepend") {
      session.messageIds = [
        ...incomingIds,
        ...session.messageIds.filter((id) => !incomingIdSet.has(id)),
      ];
    } else {
      session.messageIds = [
        ...session.messageIds.filter((id) => !incomingIdSet.has(id)),
        ...incomingIds,
      ];
    }

    const previousStart = session.loadedStartPosition;
    const previousEnd = session.loadedEndPosition;
    session.totalMessageCount =
      mode === "replace"
        ? page.totalCount
        : Math.max(page.totalCount, session.totalMessageCount || 0);
    if (mode === "replace") {
      session.loadedStartPosition = page.startPosition;
      session.loadedEndPosition = page.endPosition;
    } else {
      session.loadedStartPosition =
        previousStart === null || previousStart === undefined
          ? page.startPosition
          : page.startPosition === null || page.startPosition === undefined
            ? previousStart
            : Math.min(previousStart, page.startPosition);
      session.loadedEndPosition =
        previousEnd === null || previousEnd === undefined
          ? page.endPosition
          : page.endPosition === null || page.endPosition === undefined
            ? previousEnd
            : Math.max(previousEnd, page.endPosition);
    }
    session.hasOlderMessages = page.hasOlder || (session.loadedStartPosition ?? 0) > 0;
    session.hasNewerMessages =
      page.hasNewer ||
      (session.loadedEndPosition ?? -1) < (session.totalMessageCount || 0) - 1;
    session.hasLoadedMessagePage = true;
    session.uiRevision = Math.max(session.uiRevision || 0, incomingRevision);
    this.enforceLoadedMessageCap(
      session,
      mode === "prepend" ? "newest" : mode === "append" ? "oldest" : "oldest",
    );
    this.bumpSessionRenderListVersion(session);
    return true;
  }

  private enforceLoadedMessageCap(
    session: ChatSession,
    evictSide: "oldest" | "newest",
  ): void {
    let removedCount = 0;
    while (session.messageIds.length > this.maxLoadedMessagesPerSession) {
      removedCount += 1;
      if (evictSide === "oldest") {
        const removedId = session.messageIds.shift();
        if (removedId) session.messagesById.delete(removedId);
      } else {
        const removedId = session.messageIds.pop();
        if (removedId) session.messagesById.delete(removedId);
      }
    }
    if (removedCount > 0) {
      if (
        evictSide === "oldest" &&
        typeof session.loadedStartPosition === "number"
      ) {
        session.loadedStartPosition += removedCount;
      }
      if (
        evictSide === "newest" &&
        typeof session.loadedEndPosition === "number"
      ) {
        session.loadedEndPosition -= removedCount;
      }
    }
    if (session.messageIds.length === 0) {
      session.loadedStartPosition = null;
      session.loadedEndPosition = null;
    }
    session.hasOlderMessages =
      typeof session.loadedStartPosition === "number" &&
      session.loadedStartPosition > 0;
    if (typeof session.totalMessageCount === "number") {
      session.hasNewerMessages =
        typeof session.loadedEndPosition === "number" &&
        session.loadedEndPosition < session.totalMessageCount - 1;
    }
  }

  private replayUiUpdatesAfterRevision(
    baselineRevision: number,
    updates: Array<{ sequence: number; update: any }>,
  ): void {
    updates
      .sort((left, right) => left.sequence - right.sequence)
      .forEach(({ update }) => {
        const revision = this.normalizeUiRevision(update?.uiRevision);
        if (revision > 0 && revision <= baselineRevision) return;
        this.applyUiUpdateNow(update);
      });
  }

  private replayPendingUiUpdates(
    sessionId: string,
    baselineRevision: number,
  ): void {
    const pending = this.pendingUiUpdatesBySession.get(sessionId);
    if (!pending || pending.length === 0) return;
    this.pendingUiUpdatesBySession.delete(sessionId);
    this.replayUiUpdatesAfterRevision(baselineRevision, pending);
  }

  private replayRecentUiUpdates(
    sessionId: string,
    baselineRevision: number,
  ): void {
    const recent = this.recentUiUpdatesBySession.get(sessionId) || [];
    this.replayUiUpdatesAfterRevision(baselineRevision, [...recent]);
  }

  private async resolveHydrationPayload(
    sessionId: string,
    fallbackTitle?: string | null,
    loadMessages = true,
  ): Promise<ChatHydrationPayload> {
    let metadata: SessionMetadataPayload | null = null;
    let legacySnapshot: Awaited<
      ReturnType<Window["gyshell"]["agent"]["getSessionSnapshot"]>
    > | null = null;
    let page: UiMessagePagePayload | null = null;

    const getMetadata = window.gyshell.agent.getSessionMetadata;
    if (typeof getMetadata === "function") {
      try {
        metadata = await getMetadata(sessionId);
      } catch (error) {
        console.warn(`Failed to read chat metadata for ${sessionId}:`, error);
      }
    }

    // Keep the old snapshot contract as a compatibility fallback for older
    // preload clients and non-desktop transports. Desktop never reaches this
    // path once the metadata API is available.
    if (!metadata) {
      try {
        legacySnapshot = await window.gyshell.agent.getSessionSnapshot(sessionId);
      } catch (error) {
        console.warn(
          `Failed to read legacy session snapshot for ${sessionId}:`,
          error,
        );
      }
    }

    if (loadMessages) {
      const getPage = window.gyshell.agent.getUiMessagePage;
      if (typeof getPage === "function") {
        try {
          page = this.normalizeUiMessagePage(
            await getPage(sessionId, { limit: this.initialMessagePageSize }),
            sessionId,
          );
        } catch (error) {
          console.warn(`Failed to read chat message page for ${sessionId}:`, error);
        }
      }
      if (!page) {
        try {
          const messagesRaw = await window.gyshell.agent.getUiMessages(sessionId);
          const messages = Array.isArray(messagesRaw)
            ? (messagesRaw.filter(
                (item) => item && typeof item.id === "string",
              ) as ChatMessage[])
            : [];
          page = {
            sessionId,
            entries: messages.map((message, position) => ({ position, message })),
            totalCount: messages.length,
            startPosition: messages.length > 0 ? 0 : null,
            endPosition: messages.length > 0 ? messages.length - 1 : null,
            hasOlder: false,
            hasNewer: false,
            uiRevision: this.normalizeUiRevision(
              metadata?.uiRevision || legacySnapshot?.uiRevision,
            ),
            revisionPresent: false,
          };
        } catch (error) {
          console.warn(`Failed to read UI messages for ${sessionId}:`, error);
        }
      }
    }

    const normalizedFallbackTitle =
      typeof fallbackTitle === "string" && fallbackTitle.trim().length > 0
        ? fallbackTitle.trim()
        : null;
    const resolvedTitle =
      page?.metadata?.title ||
      metadata?.title ||
      legacySnapshot?.title ||
      normalizedFallbackTitle;
    const legacyMessageCount = Array.isArray(legacySnapshot?.messages)
      ? legacySnapshot.messages.length
      : 0;
    const totalMessageCount = Math.max(
      page?.totalCount || 0,
      Number(metadata?.messagesCount || 0),
      page?.entries.length || 0,
      legacyMessageCount,
    );
    const exists =
      !!metadata ||
      !!legacySnapshot ||
      !!resolvedTitle ||
      (page?.entries.length || 0) > 0;
    const messages = page?.entries.map((entry) => entry.message) || [];

    return {
      id: sessionId,
      exists,
      loaded: loadMessages && !!page,
      title: resolvedTitle || null,
      messages,
      page,
      isBusy:
        page?.metadata?.isBusy === true ||
        metadata?.isBusy === true ||
        legacySnapshot?.isBusy === true,
      lockedProfileId:
        page?.metadata?.lockedProfileId ||
        metadata?.lockedProfileId ||
        legacySnapshot?.lockedProfileId ||
        null,
      totalMessageCount,
      uiRevision: Math.max(
        this.normalizeUiRevision(page?.metadata?.uiRevision),
        this.normalizeUiRevision(metadata?.uiRevision),
        this.normalizeUiRevision(legacySnapshot?.uiRevision),
        this.normalizeUiRevision(page?.uiRevision),
      ),
    };
  }

  async hydrateSessionsFromBackend(
    sessionIds: string[],
    preferredActiveSessionId?: string | null,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        (sessionIds || []).filter(
          (id) => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (ids.length === 0) return;

    let summaries: any[] = [];
    if (typeof window.gyshell.agent.listSessionSummaries === "function") {
      try {
        summaries = await window.gyshell.agent.listSessionSummaries();
      } catch (error) {
        console.warn("Failed to load session summaries:", error);
      }
    }
    if (summaries.length === 0) {
      summaries = await this.getAllChatHistory();
    }
    const summaryById = new Map<string, SessionMetadataPayload>();
    summaries.forEach((item) => {
      if (!item || typeof item.id !== "string") return;
      summaryById.set(item.id, item as SessionMetadataPayload);
    });

    // A layout can legitimately contain a session created by this renderer
    // before the backend inventory has flushed. Keep those ids as candidates;
    // validate missing entries with the lightweight metadata API below rather
    // than dropping them solely because the summary snapshot raced a write.
    const candidateIds = [...ids];
    const missingIds = candidateIds.filter((id) => !summaryById.has(id));
    if (missingIds.length > 0) {
      const getMetadata = window.gyshell.agent.getSessionMetadata;
      if (typeof getMetadata === "function") {
        const metadataResults = await Promise.all(
          missingIds.map(async (id) => {
            try {
              return [id, await getMetadata(id)] as const;
            } catch {
              return [id, null] as const;
            }
          }),
        );
        metadataResults.forEach(([id, metadata]) => {
          if (metadata) summaryById.set(id, metadata);
        });
      }
    }

    let validIds = candidateIds.filter((id) => summaryById.has(id));
    // Older transports do not expose summaries or metadata. Resolve their
    // inventory through the legacy snapshot contract as a compatibility path.
    if (validIds.length === 0 && candidateIds.length > 0) {
      const legacyPayloads = await Promise.all(
        candidateIds.map((id) => this.resolveHydrationPayload(id, null, false)),
      );
      legacyPayloads.forEach((payload) => {
        if (!payload.exists) return;
        summaryById.set(payload.id, {
          id: payload.id,
          title: payload.title || "New Chat",
          messagesCount: payload.totalMessageCount,
          isBusy: payload.isBusy,
          lockedProfileId: payload.lockedProfileId,
          uiRevision: payload.uiRevision,
        });
      });
      validIds = candidateIds.filter((id) => summaryById.has(id));
    }
    const validIdSet = new Set(validIds);
    this.sessions
      .filter((session) => !validIdSet.has(session.id))
      .forEach((session) => this.unregisterSessionWithBackend(session.id));

    const normalizedPreferredActiveId =
      typeof preferredActiveSessionId === "string" &&
      preferredActiveSessionId.length > 0
        ? preferredActiveSessionId
        : null;
    const existingActiveId =
      this.activeSessionId && validIds.includes(this.activeSessionId)
        ? this.activeSessionId
        : null;
    const activeId =
      (normalizedPreferredActiveId && validIds.includes(normalizedPreferredActiveId)
        ? normalizedPreferredActiveId
        : existingActiveId) || validIds[0] || null;

    runInAction(() => {
      const existingById = new Map(
        this.sessions.map((session) => [session.id, session]),
      );
      let resolvedSessions = validIds.map((id) => {
        const session =
          existingById.get(id) ||
          this.createEmptySession(id, "New Chat", { loaded: false });
        this.applySessionMetadata(session, summaryById.get(id) || null);
        return session;
      });
      if (resolvedSessions.length === 0) {
        const fallbackSessionId = uuidv4();
        const fallback = this.createEmptySession(fallbackSessionId, "New Chat");
        this.markEmptySessionLoaded(fallback);
        resolvedSessions = [fallback];
        this.registerSessionWithBackend(fallbackSessionId);
      }
      this.sessions
        .filter((session) => !resolvedSessions.some((next) => next.id === session.id))
        .forEach((session) => this.unregisterSessionWithBackend(session.id));
      this.sessions = resolvedSessions;
      this.activeSessionId =
        activeId && resolvedSessions.some((session) => session.id === activeId)
          ? activeId
          : resolvedSessions[0]?.id || null;
      this.sessionInventoryHydrated = true;
    });
    this.emitSessionsChanged();

    if (this.activeSessionId && !this.sessionLoadPromises.has(this.activeSessionId)) {
      await this.hydrateSessionFromBackend(this.activeSessionId, {
        activate: false,
        loadAgentContext: true,
      });
    }
  }

  createSession(
    title: string = "New Chat",
    options?: { activate?: boolean },
  ): string {
    const id = uuidv4();
    const session = this.createEmptySession(id, title, { loaded: true });
    runInAction(() => {
      this.sessions.push(session);
      if (options?.activate !== false) {
        this.activeSessionId = id;
      }
    });
    this.registerSessionWithBackend(id);
    this.emitSessionsChanged();
    return id;
  }

  ensureSession(id: string, title: string = "New Chat"): void {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return;
    }
    if (this.getSessionById(normalizedId)) {
      this.registerSessionWithBackend(normalizedId);
      return;
    }
    const normalizedTitle = String(title || "").trim() || "New Chat";
    const session = this.createEmptySession(normalizedId, normalizedTitle);
    runInAction(() => {
      this.sessions.push(session);
    });
    this.registerSessionWithBackend(normalizedId);
    this.emitSessionsChanged();
  }

  setActiveSession(id: string): void {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return;
    this.activeSessionId = normalizedId;
    const session = this.getSessionById(normalizedId);
    if (!session || session.hasLoadedMessagePage || this.sessionLoadPromises.has(normalizedId)) {
      return;
    }
    void this.hydrateSessionFromBackend(normalizedId, {
      activate: false,
      loadAgentContext: true,
    }).catch((error) => {
      console.warn(`Failed to hydrate active chat session ${normalizedId}:`, error);
    });
  }

  closeSession(id: string) {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;

    this.unregisterSessionWithBackend(id);

    const nextSessions = this.sessions.filter((s) => s.id !== id);
    let nextActiveId = this.activeSessionId;

    if (this.activeSessionId === id) {
      nextActiveId = nextSessions[idx - 1]?.id || nextSessions[0]?.id || null;
    }

    runInAction(() => {
      this.sessions = nextSessions;
      this.activeSessionId = nextActiveId;
    });
    this.queue.clearSession(id);

    if (this.sessions.length === 0) {
      this.createSession();
      return;
    }
    this.emitSessionsChanged();
  }

  addMessage(
    msg: Omit<ChatMessage, "id" | "timestamp">,
    sessionId: string,
  ): string {
    const id = uuidv4();
    const fullMsg: ChatMessage = {
      ...msg,
      id,
      timestamp: Date.now(),
    };

    runInAction(() => {
      const session = this.sessions.find((s) => s.id === sessionId);
      if (session) {
        session.messagesById.set(id, fullMsg);
        session.messageIds.push(id);
        this.bumpSessionRenderListVersion(session);
        // Auto-update title based on first user message if title is default
        if (msg.role === "user") {
          const userMsgCount = session.messageIds.filter((msgId) => {
            const m = session.messagesById.get(msgId);
            return m && m.role === "user";
          }).length;
          const currentTitle = String(session.title || "").trim();
          if (
            userMsgCount === 1 &&
            (!currentTitle || currentTitle === "New Chat")
          ) {
            session.title = buildAutoSessionTitle(msg.content);
          }
        }
      }
    });
    return id;
  }

  updateMessage(id: string, patch: Partial<ChatMessage>, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const msg = session.messagesById.get(id);
    if (msg) {
      runInAction(() => {
        Object.assign(msg, patch);
        this.bumpSessionRenderListVersion(session);
      });
    }
  }

  removeMessage(id: string, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    runInAction(() => {
      session.messagesById.delete(id);
      session.messageIds = session.messageIds.filter((msgId) => msgId !== id);
      this.bumpSessionRenderListVersion(session);
    });
  }

  private normalizeCompactionBoundaryMessages(session: ChatSession): void {
    const orderedMessages = session.messageIds
      .map((messageId) => session.messagesById.get(messageId))
      .filter((message): message is ChatMessage => !!message);
    const normalized = normalizeCompactionBoundaryMessageOrder(orderedMessages);
    const normalizedIds = new Set(normalized.map((message) => message.id));

    orderedMessages.forEach((message) => {
      if (!normalizedIds.has(message.id)) {
        session.messagesById.delete(message.id);
      }
    });
    normalized.forEach((message) => {
      session.messagesById.set(message.id, message);
    });
    session.messageIds = normalized.map((message) => message.id);
  }

  private resolveInsertAnchorIndex(
    session: ChatSession,
    update: {
      anchorMessageId?: string;
      anchorBackendMessageId?: string;
    },
  ): number {
    if (typeof update.anchorMessageId === "string") {
      const byUiId = session.messageIds.indexOf(update.anchorMessageId);
      if (byUiId >= 0) return byUiId;
    }

    if (typeof update.anchorBackendMessageId === "string") {
      return session.messageIds.findIndex((messageId) => {
        const message = session.messagesById.get(messageId);
        return message?.backendMessageId === update.anchorBackendMessageId;
      });
    }

    return -1;
  }

  setThinking(thinking: boolean, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      runInAction(() => {
        session.isThinking = thinking;
      });
    }
  }

  setSessionBusy(busy: boolean, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      runInAction(() => {
        session.isSessionBusy = busy;
      });
    }
  }

  setSessionLockedProfile(sessionId: string, profileId: string | null) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    runInAction(() => {
      session.lockedProfileId = profileId;
    });
  }

  clear() {
    if (!this.activeSessionId) return;
    const session = this.sessions.find((s) => s.id === this.activeSessionId);
    if (session) {
      runInAction(() => {
        session.messagesById.clear();
        session.messageIds = [];
        this.bumpSessionRenderListVersion(session);
      });
    }
  }

  handleUiUpdate(update: any): void {
    const sessionId = String(update?.sessionId || "").trim();
    if (!sessionId) return;
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;

    const recorded = this.recordUiUpdate(sessionId, update);
    const isHydrating = this.sessionLoadPromises.has(sessionId);
    const isUnloadedTranscriptUpdate =
      this.isTranscriptUiUpdate(update?.type) && !session.hasLoadedMessagePage;
    if (isHydrating || isUnloadedTranscriptUpdate) {
      this.queuePendingUiUpdate(sessionId, recorded);
      if (update.type === "ADD_MESSAGE" && update.message?.role === "user") {
        session.isThinking = true;
        session.isSessionBusy = true;
      }
      return;
    }
    this.applyUiUpdateNow(update);
  }

  private applyUiUpdateNow(update: any): void {
    const { type, sessionId } = update;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      // Do not create a synthetic session from live updates.
      // If the session is not currently opened in the UI, keep UI stable and let
      // users load the real session explicitly from history.
      return;
    }
    const uiRevision = this.normalizeUiRevision(update?.uiRevision);
    const currentRevision = session.uiRevision || 0;
    // Versioned live actions are idempotent: equal revisions are replayed
    // duplicates, while unversioned actions remain compatible with legacy
    // transports that predate the revision contract.
    if (
      uiRevision > 0 &&
      currentRevision > 0 &&
      uiRevision <= currentRevision
    ) {
      return;
    }

    runInAction(() => {
      switch (type) {
        case "SESSION_RENAMED": {
          if (typeof update.title === "string") {
            session.title = update.title;
          }
          break;
        }
        case "ADD_MESSAGE": {
          const msg = update.message;
          if (!msg || typeof msg.id !== "string" || msg.id.length === 0) {
            break;
          }
          const existed = session.messagesById.has(msg.id);
          session.messagesById.set(msg.id, msg);
          if (!existed) {
            const previousTotal = Math.max(
              session.totalMessageCount || 0,
              session.messageIds.length,
            );
            session.messageIds.push(msg.id);
            session.totalMessageCount = previousTotal + 1;
            if (session.hasNewerMessages !== true) {
              session.loadedEndPosition = previousTotal;
              session.hasNewerMessages = false;
            }
            this.bumpSessionRenderListVersion(session);
          }
          // Auto-update title logic if needed (backend also does this, but for UX we can do it here too)
          if (!existed && msg.role === "user") {
            const userMsgCount = session.messageIds.filter((msgId) => {
              const m = session.messagesById.get(msgId);
              return m && m.role === "user";
            }).length;
            const currentTitle = String(session.title || "").trim();
            if (
              userMsgCount === 1 &&
              (!currentTitle || currentTitle === "New Chat")
            ) {
              session.title = buildAutoSessionTitle(msg.content);
            }
          }
          break;
        }
        case "INSERT_MESSAGE": {
          const msg = update.message;
          if (!msg || typeof msg.id !== "string" || msg.id.length === 0) {
            break;
          }
          const anchorIndex = this.resolveInsertAnchorIndex(session, update);
          if (anchorIndex < 0) {
            break;
          }

          const existingIndex = session.messageIds.indexOf(msg.id);
          if (existingIndex >= 0) {
            session.messageIds.splice(existingIndex, 1);
          }
          session.messagesById.set(msg.id, msg);

          const adjustedAnchorIndex =
            existingIndex >= 0 && existingIndex < anchorIndex
              ? anchorIndex - 1
              : anchorIndex;
          const insertIndex =
            update.placement === "after"
              ? adjustedAnchorIndex + 1
              : adjustedAnchorIndex;
          session.messageIds.splice(insertIndex, 0, msg.id);
          if (existingIndex < 0) {
            session.totalMessageCount =
              Math.max(session.totalMessageCount || 0, session.messageIds.length - 1) + 1;
            if (typeof session.loadedEndPosition === "number") {
              session.loadedEndPosition += 1;
            }
          }
          this.normalizeCompactionBoundaryMessages(session);
          this.bumpSessionRenderListVersion(session);
          break;
        }
        case "REMOVE_MESSAGE": {
          const existed = session.messagesById.delete(update.messageId);
          session.messageIds = session.messageIds.filter(
            (id) => id !== update.messageId,
          );
          if (existed) {
            session.totalMessageCount = Math.max(
              0,
              (session.totalMessageCount || 1) - 1,
            );
            if (typeof session.loadedEndPosition === "number") {
              session.loadedEndPosition = Math.max(
                (session.loadedStartPosition || 0) - 1,
                session.loadedEndPosition - 1,
              );
            }
          }
          this.bumpSessionRenderListVersion(session);
          break;
        }
        case "APPEND_CONTENT": {
          const msg = session.messagesById.get(update.messageId);
          if (msg) {
            msg.content += update.content;
          }
          break;
        }
        case "APPEND_OUTPUT": {
          const msg = session.messagesById.get(update.messageId);
          if (msg) {
            msg.metadata = {
              ...(msg.metadata || {}),
              output: (msg.metadata?.output || "") + (update.outputDelta || ""),
            };
          }
          break;
        }
        case "UPDATE_MESSAGE": {
          const msg = session.messagesById.get(update.messageId);
          if (msg) {
            Object.assign(msg, update.patch);
            this.bumpSessionRenderListVersion(session);
          }
          break;
        }
        case "DONE":
          session.isThinking = false;
          break;
        case "SESSION_PROFILE_LOCKED":
          session.isSessionBusy = true;
          session.lockedProfileId = update.lockedProfileId || null;
          break;
        case "SESSION_READY":
          session.isSessionBusy = false;
          session.lockedProfileId = null;
          if (this.queue.shouldDispatchNextOnSessionReady(sessionId)) {
            void this.runNextQueueItem(sessionId);
          }
          break;
        case "ROLLBACK": {
          const rollbackIndex = session.messageIds.findIndex((messageId) => {
            const message = session.messagesById.get(messageId);
            return message?.backendMessageId === update.messageId;
          });
          if (rollbackIndex !== -1) {
            const removedIds = session.messageIds.slice(rollbackIndex);
            removedIds.forEach((messageId) =>
              session.messagesById.delete(messageId),
            );
            session.messageIds = session.messageIds.slice(0, rollbackIndex);
            const nextTotal =
              Math.max(0, session.loadedStartPosition || 0) + rollbackIndex;
            session.totalMessageCount = nextTotal;
            session.loadedEndPosition = nextTotal - 1;
            session.hasNewerMessages = false;
            this.normalizeCompactionBoundaryMessages(session);
            this.bumpSessionRenderListVersion(session);
          }
          session.isThinking = false;
          session.isSessionBusy = false;
          session.lockedProfileId = null;
          break;
        }
      }
      if (uiRevision > 0) {
        session.uiRevision = Math.max(session.uiRevision || 0, uiRevision);
      }
    });

    if (type === "ADD_MESSAGE" && update.message?.role === "user") {
      runInAction(() => {
        session.isThinking = true;
        session.isSessionBusy = true;
      });
    }

    if (type === "ADD_MESSAGE" && update.message?.type === "error") {
      this.stopQueue(sessionId);
      return;
    }
  }

  private async hydrateSessionFromBackendInternal(
    sessionId: string,
    options?: {
      activate?: boolean;
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    const existing = this.sessions.find((session) => session.id === sessionId);
    const payload = await this.resolveHydrationPayload(
      sessionId,
      existing?.title || null,
      true,
    );
    if (!payload.exists) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const pending = this.pendingUiUpdatesBySession.get(sessionId) || [];
    const pendingMessageIds = Array.from(
      new Set(
        pending.flatMap(({ update }) => {
          const ids: string[] = [];
          if (typeof update?.messageId === "string") ids.push(update.messageId);
          if (typeof update?.message?.id === "string") ids.push(update.message.id);
          return ids;
        }),
      ),
    );

    runInAction(() => {
      let session = this.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        session = this.createEmptySession(
          sessionId,
          payload.title || "Loaded Session",
        );
        this.sessions.push(session);
      }
      if (payload.page) {
        this.applyMessagePage(session, payload.page, "replace");
      }
      if (!payload.page) {
        this.applySessionMetadata(session, {
          id: payload.id,
          title: payload.title || session.title,
          messagesCount: payload.totalMessageCount,
          isBusy: payload.isBusy,
          lockedProfileId: payload.lockedProfileId,
          uiRevision: payload.uiRevision,
        });
      }
      if (!payload.page && payload.totalMessageCount === 0) {
        this.markEmptySessionLoaded(session);
      }
      if (options?.activate !== false) {
        this.activeSessionId = sessionId;
      }
    });

    // The page is now the baseline. Allow live events to apply while replaying
    // only updates that are newer than the returned snapshot.
    this.sessionLoadPromises.delete(sessionId);
    this.replayPendingUiUpdates(sessionId, payload.uiRevision);
    if (pendingMessageIds.length > 0) {
      await this.loadFullMessages(sessionId, pendingMessageIds);
    }
    this.emitSessionsChanged();

    if (options?.loadAgentContext !== false) {
      const runtimeLoader = window.gyshell.agent.loadChatRuntimeSession;
      if (typeof runtimeLoader === "function") {
        await runtimeLoader(sessionId);
      } else {
        // Compatibility fallback for older preload bundles.
        await window.gyshell.agent.loadChatSession(sessionId);
      }
    }
  }

  async hydrateSessionFromBackend(
    sessionId: string,
    options?: {
      activate?: boolean;
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return;
    if (options?.activate !== false) {
      this.activeSessionId = normalizedSessionId;
    }
    const existingLoad = this.sessionLoadPromises.get(normalizedSessionId);
    if (existingLoad) {
      await existingLoad;
      return;
    }

    const loadPromise = this.hydrateSessionFromBackendInternal(
      normalizedSessionId,
      options,
    );
    this.sessionLoadPromises.set(normalizedSessionId, loadPromise);
    try {
      await loadPromise;
    } finally {
      if (this.sessionLoadPromises.get(normalizedSessionId) === loadPromise) {
        this.sessionLoadPromises.delete(normalizedSessionId);
      }
    }
  }

  async loadOlderMessages(
    sessionId: string,
    limit = 300,
  ): Promise<boolean> {
    const session = this.getSessionById(sessionId);
    if (
      !session ||
      session.isLoadingOlderMessages ||
      session.hasOlderMessages !== true ||
      typeof session.loadedStartPosition !== "number"
    ) {
      return false;
    }
    const beforePosition = session.loadedStartPosition;
    runInAction(() => {
      session.isLoadingOlderMessages = true;
    });
    try {
      const page = this.normalizeUiMessagePage(
        await window.gyshell.agent.getUiMessagePage(sessionId, {
          beforePosition,
          limit,
        }),
        sessionId,
      );
      if (!page) return false;
      let applied = false;
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (!current) return;
        applied = this.applyMessagePage(current, page, "prepend");
      });
      return applied;
    } finally {
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (current) current.isLoadingOlderMessages = false;
      });
    }
  }

  async loadNewerMessages(
    sessionId: string,
    limit = 300,
  ): Promise<boolean> {
    const session = this.getSessionById(sessionId);
    if (
      !session ||
      session.isLoadingNewerMessages ||
      session.hasNewerMessages !== true ||
      typeof session.loadedEndPosition !== "number"
    ) {
      return false;
    }
    const afterPosition = session.loadedEndPosition;
    runInAction(() => {
      session.isLoadingNewerMessages = true;
    });
    try {
      const page = this.normalizeUiMessagePage(
        await window.gyshell.agent.getUiMessagePage(sessionId, {
          afterPosition,
          limit,
        }),
        sessionId,
      );
      if (!page) return false;
      let applied = false;
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (!current) return;
        applied = this.applyMessagePage(current, page, "append");
      });
      return applied;
    } finally {
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (current) current.isLoadingNewerMessages = false;
      });
    }
  }

  async loadMessagesAroundPosition(
    sessionId: string,
    position: number,
    limit = 300,
  ): Promise<boolean> {
    const page = this.normalizeUiMessagePage(
      await window.gyshell.agent.getUiMessagePage(sessionId, {
        aroundPosition: Math.max(0, Math.floor(position)),
        limit,
      }),
      sessionId,
    );
    if (!page) return false;
    let applied = false;
    runInAction(() => {
      const session = this.getSessionById(sessionId);
      if (!session) return;
      applied = this.applyMessagePage(session, page, "replace");
      if (applied) this.replayRecentUiUpdates(sessionId, this.getPageRevision(page));
    });
    return applied;
  }

  private reconcileFullMessageWithRecentUpdates(
    sessionId: string,
    currentMessage: ChatMessage,
    incomingMessage: ChatMessage,
    responseRevision: number,
    requestSequence: number,
    responseRevisionPresent: boolean,
  ): ChatMessage | null {
    const currentRevision = this.getSessionById(sessionId)?.uiRevision || 0;
    const recent = this.recentUiUpdatesBySession.get(sessionId) || [];
    const newerUpdates = recent.filter(({ sequence, update }) => {
      const targetsMessage =
        update?.messageId === currentMessage.id ||
        (update?.type === "ROLLBACK" &&
          update.messageId === currentMessage.backendMessageId);
      if (!targetsMessage) return false;
      const revision = this.normalizeUiRevision(update?.uiRevision);
      return responseRevisionPresent
        ? revision > responseRevision ||
            (revision === 0 && sequence > requestSequence)
        : sequence > requestSequence;
    });

    // A full-payload response hydrates only fields that were deferred in the
    // current row. It must never replace live status, streaming, or unrelated
    // metadata from a newer renderer revision. Even when the response is old
    // because an unrelated session update raced it, the deferred fields remain
    // safe to hydrate; only message-targeted newer actions are replayed below.
    const deferredFields = new Set(currentMessage.deferredPayload?.fields || []);
    const staleVersionedResponse =
      responseRevisionPresent &&
      currentRevision > 0 &&
      this.isUiRevisionStale(responseRevision, currentRevision);
    const unsafeUnversionedStreamingResponse =
      currentMessage.streaming === true &&
      !responseRevisionPresent &&
      newerUpdates.length === 0;
    if (unsafeUnversionedStreamingResponse) {
      return currentMessage;
    }
    const canHydrateStaleRow =
      !staleVersionedResponse ||
      newerUpdates.length > 0 ||
      currentMessage.streaming !== true;
    const hydratedFields = new Set<string>();
    let reconciled: ChatMessage = {
      ...currentMessage,
      metadata: currentMessage.metadata
        ? { ...currentMessage.metadata }
        : undefined,
    };
    const metadata = { ...(reconciled.metadata || {}) };

    if (
      deferredFields.has("content") &&
      canHydrateStaleRow &&
      typeof incomingMessage.content === "string"
    ) {
      reconciled.content = incomingMessage.content;
      hydratedFields.add("content");
    }
    for (const field of ["output", "diff", "details", "inputImages"] as const) {
      if (!deferredFields.has(field) || !canHydrateStaleRow) continue;
      const incomingValue = incomingMessage.metadata?.[
        field as keyof NonNullable<ChatMessage["metadata"]>
      ];
      if (incomingValue !== undefined) {
        metadata[field] = incomingValue as never;
        hydratedFields.add(field);
      }
    }
    reconciled.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    const remainingFields = [...deferredFields].filter(
      (field) => !hydratedFields.has(field),
    ) as Array<NonNullable<ChatMessage["deferredPayload"]>["fields"][number]>;
    reconciled.deferredPayload =
      remainingFields.length > 0 ? { fields: remainingFields } : undefined;

    // If the response is older than the current session, the newer live
    // actions above are replayed only when their sequence/revision is still
    // available in the bounded event log.
    for (const { update } of newerUpdates) {
      if (
        update?.type === "REMOVE_MESSAGE" &&
        update.messageId === reconciled.id
      ) {
        return null;
      }
      if (update?.messageId !== reconciled.id) continue;
      if (update.type === "APPEND_CONTENT") {
        reconciled.content += String(update.content || "");
      } else if (update.type === "APPEND_OUTPUT") {
        reconciled.metadata = {
          ...(reconciled.metadata || {}),
          output:
            (reconciled.metadata?.output || "") +
            String(update.outputDelta || ""),
        };
      } else if (update.type === "UPDATE_MESSAGE") {
        const patch = update.patch || {};
        reconciled = {
          ...reconciled,
          ...patch,
          metadata:
            patch.metadata === undefined
              ? reconciled.metadata
              : {
                  ...(reconciled.metadata || {}),
                  ...(patch.metadata || {}),
                },
        };
      }
    }
    return reconciled;
  }

  async loadFullMessages(
    sessionId: string,
    messageIds: string[],
  ): Promise<ChatMessage[]> {
    const session = this.getSessionById(sessionId);
    const ids = Array.from(
      new Set(
        messageIds.filter((messageId) => {
          if (!messageId) return false;
          return session?.messagesById.get(messageId)?.deferredPayload !== undefined;
        }),
      ),
    ).sort();
    if (ids.length === 0) return [];
    const loadKey = `${sessionId}:${ids.join(":")}`;
    const existingLoad = this.fullMessageLoadPromises.get(loadKey);
    if (existingLoad) return existingLoad;
    const requestSequence = this.uiUpdateSequence;

    const loadPromise = (async (): Promise<ChatMessage[]> => {
      const getFullMessages = window.gyshell.agent.getFullUiMessages;
      const full =
        typeof getFullMessages === "function"
          ? await getFullMessages(sessionId, ids)
          : await window.gyshell.agent.getUiMessages(sessionId);
      const rawMessages = Array.isArray(full)
        ? full
        : Array.isArray((full as any)?.messages)
          ? (full as any).messages
          : [];
      const responseRevisionPresent =
        !Array.isArray(full) &&
        Object.prototype.hasOwnProperty.call(full, "uiRevision");
      const responseRevision = this.normalizeUiRevision(
        responseRevisionPresent ? (full as any)?.uiRevision : 0,
      );
      const current = this.getSessionById(sessionId);
      if (!current) return [];
      const messages: ChatMessage[] = [];
      for (const rawMessage of rawMessages as unknown[]) {
        if (
          !rawMessage ||
          typeof rawMessage !== "object" ||
          typeof (rawMessage as ChatMessage).id !== "string"
        ) {
          continue;
        }
        const incoming = rawMessage as ChatMessage;
        const existing = current.messagesById.get(incoming.id);
        if (!existing) continue;
        const reconciled = this.reconcileFullMessageWithRecentUpdates(
          sessionId,
          existing,
          incoming,
          responseRevision,
          requestSequence,
          responseRevisionPresent,
        );
        if (reconciled) messages.push(reconciled);
      }
      runInAction(() => {
        const latest = this.getSessionById(sessionId);
        if (!latest) return;
        messages.forEach((message) => {
          if (latest.messagesById.has(message.id)) {
            latest.messagesById.set(message.id, message);
          }
        });
        latest.uiRevision = Math.max(
          latest.uiRevision || 0,
          responseRevision,
        );
        if (messages.length > 0) this.bumpSessionRenderListVersion(latest);
      });
      return messages;
    })();
    this.fullMessageLoadPromises.set(loadKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (this.fullMessageLoadPromises.get(loadKey) === loadPromise) {
        this.fullMessageLoadPromises.delete(loadKey);
      }
    }
  }

  async searchMessages(
    sessionId: string,
    query: string,
    limit = 500,
  ): Promise<any> {
    const search = window.gyshell.agent.searchUiMessages;
    if (typeof search === "function") {
      const requestedRevision = this.getSessionById(sessionId)?.uiRevision || 0;
      const first = await search(sessionId, query, limit);
      const firstResponseRevision =
        this.getSessionById(sessionId)?.uiRevision || requestedRevision;
      if (!this.isVersionedResponseStale(first, firstResponseRevision)) {
        return first;
      }

      // Search is synchronous in the backend but its IPC response can arrive
      // after a live update. Retry once without showing a loading/error state;
      // if the second answer is still old, the caller keeps its current result.
      const currentRevision =
        this.getSessionById(sessionId)?.uiRevision || firstResponseRevision;
      const retry = await search(sessionId, query, limit);
      return this.isVersionedResponseStale(retry, currentRevision)
        ? null
        : retry;
    }
    const session = this.getSessionById(sessionId);
    const normalized = String(query || "").trim().toLowerCase();
    const matches = session
      ? session.messageIds
          .map((id, position) => ({ id, position, message: session.messagesById.get(id) }))
          .filter(
            (entry) =>
              !!entry.message &&
              normalized.length > 0 &&
              String(entry.message.content || "").toLowerCase().includes(normalized),
          )
          .slice(0, limit)
          .map((entry) => ({
            messageId: entry.id,
            position: entry.position,
            preview: entry.message?.content || "",
          }))
      : [];
    return {
      sessionId,
      query: String(query || ""),
      matches,
      totalMatches: matches.length,
      truncated: false,
    };
  }

  async loadChatHistory(
    sessionId: string,
    options?: {
      activate?: boolean;
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    await this.hydrateSessionFromBackend(sessionId, {
      activate: options?.activate !== false,
      loadAgentContext: options?.loadAgentContext !== false,
    });
  }

  async getAllChatHistory(): Promise<any[]> {
    try {
      // Desktop history pickers only need summaries. Keep the legacy full
      // transcript endpoint as a fallback for older preload clients.
      if (typeof window.gyshell.agent.listSessionSummaries === "function") {
        return await window.gyshell.agent.listSessionSummaries();
      }
      return await window.gyshell.agent.getAllChatHistory();
    } catch (error) {
      console.error("Failed to get chat history:", error);
      return [];
    }
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    await this.deleteChatSessions([sessionId]);
  }

  async deleteChatSessions(sessionIds: string[]): Promise<void> {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) {
      return;
    }
    try {
      if (ids.length === 1) {
        await window.gyshell.agent.deleteChatSession(ids[0]);
      } else {
        await window.gyshell.agent.deleteChatSessions(ids);
      }

      runInAction(() => {
        const deletedIds = new Set(ids);
        const wasActive = this.activeSessionId
          ? deletedIds.has(this.activeSessionId)
          : false;
        this.sessions = this.sessions.filter(
          (session) => !deletedIds.has(session.id),
        );

        if (wasActive) {
          if (this.sessions.length > 0) {
            this.activeSessionId = this.sessions[0].id;
          }
        }
      });
      ids.forEach((id) => {
        this.ownedBackendSessionIds.delete(id);
        this.sessionOwnershipVersions.delete(id);
        this.sessionRegistrationPromises.delete(id);
        this.pendingUiUpdatesBySession.delete(id);
        this.recentUiUpdatesBySession.delete(id);
      });
      ids.forEach((id) => this.queue.clearSession(id));
      if (this.sessions.length === 0) {
        this.createSession();
        return;
      }
      this.emitSessionsChanged();
    } catch (error) {
      console.error("Failed to delete chat session(s):", error);
      throw error;
    }
  }

  async renameChatSession(sessionId: string, newTitle: string): Promise<void> {
    try {
      if (!(await this.ensureSessionOwnershipRegistered(sessionId))) {
        throw new Error(`Failed to register chat session ${sessionId}`);
      }
      await window.gyshell.agent.renameSession(sessionId, newTitle);
      runInAction(() => {
        const session = this.sessions.find((s) => s.id === sessionId);
        if (session) {
          session.title = newTitle;
        }
      });
    } catch (error) {
      console.error("Failed to rename chat session:", error);
      throw error;
    }
  }

  async branchFromMessage(
    sessionId: string,
    backendMessageId: string,
  ): Promise<{
    ok: boolean;
    sessionId?: string;
    title?: string;
    messageCount?: number;
    reason?: string;
  }> {
    const result = await window.gyshell.agent.branchFromMessage(
      sessionId,
      backendMessageId,
    );
    if (!result?.ok || !result.sessionId) {
      throw new Error(result?.reason || "Failed to branch chat session.");
    }
    await this.hydrateSessionFromBackend(result.sessionId, {
      activate: true,
      loadAgentContext: true,
    });
    return result;
  }

  rollbackToMessage(sessionId: string, backendMessageId: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    // Find the index of the message to rollback to
    const idx = session.messageIds.findIndex((msgId) => {
      const msg = session.messagesById.get(msgId);
      return msg && msg.backendMessageId === backendMessageId;
    });
    if (idx === -1) return;

    runInAction(() => {
      // Remove messages after the rollback point
      const keptIds = session.messageIds.slice(0, idx);
      const removedIds = session.messageIds.slice(idx);

      // Delete from Map
      removedIds.forEach((msgId) => session.messagesById.delete(msgId));

      // Update IDs array
      session.messageIds = keptIds;
      this.normalizeCompactionBoundaryMessages(session);
      this.bumpSessionRenderListVersion(session);
      session.isThinking = false;
    });
  }

  setQueueRunner(
    runner: (sessionId: string, input: UserInputPayload) => Promise<boolean>,
  ): void {
    this.queueRunner = runner;
  }

  setQueueMode(sessionId: string, enabled: boolean): void {
    this.queue.setQueueMode(enabled, sessionId);
    const session = this.sessions.find((s) => s.id === sessionId);
    const isBusy = !!session?.isSessionBusy;
    if (enabled) {
      if (isBusy) {
        // Inherit active run from normal mode; queue continues seamlessly after current run.
        this.queue.startRun(sessionId);
      } else {
        this.queue.stopRun(sessionId);
      }
      return;
    }
    if (isBusy && this.queue.isRunning(sessionId)) {
      // Switching to normal while queue is running: finish current run, then stop queue dispatch.
      this.queue.requestStopAfterCurrent(sessionId);
    } else {
      this.queue.stopRun(sessionId);
    }
  }

  addQueueItem(
    sessionId: string,
    content: string,
    images?: InputImageAttachment[],
  ): QueueItem | null {
    const trimmed = String(content || "").trim();
    const normalizedImages = Array.isArray(images)
      ? images.filter((item) => {
          const hasAttachmentId = !!String(item?.attachmentId || "").trim();
          const hasLocalFile = (item as any)?.localFile instanceof File;
          return hasAttachmentId || hasLocalFile;
        })
      : [];
    if (!trimmed && normalizedImages.length === 0) return null;
    return this.queue.addItem(sessionId, trimmed, normalizedImages);
  }

  removeQueueItem(sessionId: string, itemId: string): void {
    this.queue.removeItem(sessionId, itemId);
  }

  moveQueueItem(sessionId: string, fromIndex: number, toIndex: number): void {
    this.queue.moveItem(sessionId, fromIndex, toIndex);
  }

  startQueue(sessionId: string): void {
    if (this.queue.isRunning(sessionId)) return;
    if (this.queue.getQueue(sessionId).length === 0) return;
    this.queue.startRun(sessionId);
    void this.runNextQueueItem(sessionId);
  }

  stopQueue(sessionId: string): void {
    if (!sessionId) return;
    this.queue.stopRun(sessionId);
  }

  private async runNextQueueItem(sessionId: string): Promise<void> {
    const next = this.queue.shiftItem(sessionId);
    if (!next) {
      this.queue.stopRun(sessionId);
      return;
    }
    if (!this.queue.isRunning(sessionId)) {
      this.queue.unshiftItem(sessionId, next);
      return;
    }
    if (
      !this.queueRunner ||
      !(await this.queueRunner(sessionId, {
        text: next.content,
        ...(Array.isArray(next.images) && next.images.length > 0
          ? { images: next.images }
          : {}),
      }))
    ) {
      this.queue.unshiftItem(sessionId, next);
      this.queue.stopRun(sessionId);
      return;
    }
  }
}
