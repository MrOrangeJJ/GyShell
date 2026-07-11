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
}

interface ChatHydrationPayload {
  id: string;
  exists: boolean;
  loaded: boolean;
  title: string | null;
  messages: ChatMessage[];
  isBusy: boolean;
  lockedProfileId: string | null;
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

  private createEmptySession(id: string, title: string): ChatSession {
    return {
      id,
      title,
      messagesById: observable.map<string, ChatMessage>(),
      messageIds: [],
      renderListVersion: 0,
      isThinking: false,
      isSessionBusy: false,
      lockedProfileId: null,
    };
  }

  private bumpSessionRenderListVersion(session: ChatSession): void {
    session.renderListVersion += 1;
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
      .then(() => window.gyshell.agent.registerSession(sessionId))
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
      (id) => existingById.get(id) || this.createEmptySession(id, "New Chat"),
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

  private async resolveHydrationPayload(
    sessionId: string,
    fallbackTitle?: string | null,
  ): Promise<ChatHydrationPayload> {
    let messages: ChatMessage[] = [];
    let runtimeSnapshot: Awaited<
      ReturnType<Window["gyshell"]["agent"]["getSessionSnapshot"]>
    > | null = null;

    try {
      const messagesRaw = await window.gyshell.agent.getUiMessages(sessionId);
      messages = Array.isArray(messagesRaw)
        ? (messagesRaw.filter(
            (item) => item && typeof item.id === "string",
          ) as ChatMessage[])
        : [];
    } catch (error) {
      console.warn(
        `Failed to read UI messages for chat session ${sessionId}:`,
        error,
      );
    }

    try {
      runtimeSnapshot =
        await window.gyshell.agent.getSessionSnapshot(sessionId);
    } catch (error) {
      console.warn(
        `Failed to read session snapshot for chat session ${sessionId}:`,
        error,
      );
    }

    const normalizedFallbackTitle =
      typeof fallbackTitle === "string" && fallbackTitle.trim().length > 0
        ? fallbackTitle.trim()
        : null;
    const resolvedTitle = runtimeSnapshot?.title || normalizedFallbackTitle;
    const exists = !!runtimeSnapshot || messages.length > 0 || !!resolvedTitle;

    return {
      id: sessionId,
      exists,
      loaded: !!runtimeSnapshot || messages.length > 0,
      title: resolvedTitle,
      messages,
      isBusy: runtimeSnapshot?.isBusy === true,
      lockedProfileId: runtimeSnapshot?.lockedProfileId || null,
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

    const allHistory = await this.getAllChatHistory();
    const titleById = new Map<string, string>();
    allHistory.forEach((item) => {
      if (!item || typeof item.id !== "string") return;
      if (typeof item.title !== "string" || item.title.length === 0) return;
      titleById.set(item.id, item.title);
    });

    const sessionPayloads = await Promise.all(
      ids.map((id) => this.resolveHydrationPayload(id, titleById.get(id))),
    );
    const payloadById = new Map(
      sessionPayloads.map((payload) => [payload.id, payload]),
    );
    sessionPayloads
      .filter((payload) => !payload.exists)
      .forEach((payload) => this.unregisterSessionWithBackend(payload.id));

    runInAction(() => {
      const existingById = new Map(
        this.sessions.map((session) => [session.id, session]),
      );
      const nextSessions = ids
        .map((id) => {
          const existing =
            existingById.get(id) || this.createEmptySession(id, "New Chat");
          const payload = payloadById.get(id);
          if (!payload) return existing;
          if (!payload.exists) {
            return null;
          }

          if (payload.loaded) {
            existing.messagesById.clear();
            existing.messageIds = [];
            payload.messages.forEach((message) => {
              existing.messagesById.set(message.id, message);
              existing.messageIds.push(message.id);
            });
            this.bumpSessionRenderListVersion(existing);
            existing.isThinking = payload.isBusy;
            existing.isSessionBusy = payload.isBusy;
            existing.lockedProfileId = payload.lockedProfileId;
          }

          if (payload.title && payload.title.length > 0) {
            existing.title = payload.title;
          }

          return existing;
        })
        .filter((session): session is ChatSession => session !== null);

      let resolvedSessions = nextSessions;
      if (resolvedSessions.length === 0) {
        const fallbackSessionId = uuidv4();
        resolvedSessions = [
          this.createEmptySession(fallbackSessionId, "New Chat"),
        ];
        this.registerSessionWithBackend(fallbackSessionId);
      }
      this.sessions = resolvedSessions;

      const normalizedPreferredActiveId =
        typeof preferredActiveSessionId === "string" &&
        preferredActiveSessionId.length > 0
          ? preferredActiveSessionId
          : null;
      const preferredExists =
        !!normalizedPreferredActiveId &&
        resolvedSessions.some(
          (session) => session.id === normalizedPreferredActiveId,
        );
      const currentExists =
        !!this.activeSessionId &&
        resolvedSessions.some((session) => session.id === this.activeSessionId);

      if (preferredExists) {
        this.activeSessionId = normalizedPreferredActiveId;
      } else if (!currentExists) {
        this.activeSessionId = resolvedSessions[0]?.id || null;
      }
      this.sessionInventoryHydrated = true;
    });
    this.emitSessionsChanged();

    if (this.activeSessionId) {
      try {
        await window.gyshell.agent.loadChatSession(this.activeSessionId);
      } catch (error) {
        console.warn(
          `Failed to load active chat session ${this.activeSessionId}:`,
          error,
        );
      }
    }
  }

  createSession(title: string = "New Chat"): string {
    const id = uuidv4();
    const session = this.createEmptySession(id, title);
    runInAction(() => {
      this.sessions.push(session);
      this.activeSessionId = id;
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

  setActiveSession(id: string) {
    this.activeSessionId = id;
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

  handleUiUpdate(update: any) {
    const { type, sessionId } = update;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      // Do not create a synthetic session from live updates.
      // If the session is not currently opened in the UI, keep UI stable and let
      // users load the real session explicitly from history.
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
            session.messageIds.push(msg.id);
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
          this.normalizeCompactionBoundaryMessages(session);
          this.bumpSessionRenderListVersion(session);
          break;
        }
        case "REMOVE_MESSAGE": {
          session.messagesById.delete(update.messageId);
          session.messageIds = session.messageIds.filter(
            (id) => id !== update.messageId,
          );
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
            this.normalizeCompactionBoundaryMessages(session);
            this.bumpSessionRenderListVersion(session);
          }
          session.isThinking = false;
          session.isSessionBusy = false;
          session.lockedProfileId = null;
          break;
        }
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

  async hydrateSessionFromBackend(
    sessionId: string,
    options?: {
      activate?: boolean;
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    try {
      // Get all history first to find the title
      const allHistory = await this.getAllChatHistory();
      const sessionInfo = allHistory.find((h) => h.id === sessionId);
      const payload = await this.resolveHydrationPayload(
        sessionId,
        sessionInfo?.title,
      );
      if (!payload.exists) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      runInAction(() => {
        const existingSession = this.sessions.find((s) => s.id === sessionId);
        if (existingSession) {
          // Convert array to Map + IDs
          existingSession.messagesById.clear();
          existingSession.messageIds = [];
          payload.messages.forEach((msg) => {
            existingSession.messagesById.set(msg.id, msg);
            existingSession.messageIds.push(msg.id);
          });
          this.bumpSessionRenderListVersion(existingSession);
          existingSession.isThinking = payload.isBusy;
          existingSession.isSessionBusy = payload.isBusy;
          existingSession.lockedProfileId = payload.lockedProfileId;
          if (payload.title) {
            existingSession.title = payload.title;
          }
        } else {
          const messagesById = observable.map<string, ChatMessage>();
          const messageIds: string[] = [];
          payload.messages.forEach((msg) => {
            messagesById.set(msg.id, msg);
            messageIds.push(msg.id);
          });
          this.sessions.push({
            id: sessionId,
            title: payload.title || "Loaded Session",
            messagesById,
            messageIds,
            renderListVersion: 0,
            isThinking: payload.isBusy,
            isSessionBusy: payload.isBusy,
            lockedProfileId: payload.lockedProfileId,
          });
        }

        if (options?.activate !== false) {
          this.activeSessionId = sessionId;
        }
      });
      this.emitSessionsChanged();

      if (options?.loadAgentContext !== false) {
        // Also load backend session for agent context when the caller is doing
        // a user-visible navigation to this session.
        await window.gyshell.agent.loadChatSession(sessionId);
      }
    } catch (error) {
      console.error("Failed to load chat history:", error);
      throw error;
    }
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
      // Get backend sessions for all available sessions
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
