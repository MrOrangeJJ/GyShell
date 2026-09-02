import { v4 as uuidv4 } from "uuid";
import {
  extractCommandOutputDisplayText,
  parseCommandOutputContractV1,
  readOpaqueNonBlankWellFormedString,
  type CommandOutputContractV1,
} from "@gyshell/shared";
import type { AgentEvent, AgentEventType } from "../types";
import type {
  ChatMessage,
  UIChatSession,
  UIUpdateAction,
} from "../types/ui-chat";
import type {
  UiFullMessagesResult,
  UiMessageGeometryIndex,
  UiMessagePage,
  UiMessagePageRequest,
  UiMessageSearchResult,
  UISessionSummaryRecord,
} from "./history/historyTypes";
import {
  HistorySqliteStore,
  projectUiMessageForList,
} from "./history/HistorySqliteStore";
import { expireUnbackedCommandOutputContract } from "./AgentHelper/tools/command_output_contract";
import {
  buildAutoSessionTitle,
  buildUiSessionSummary,
  normalizeCompactionBoundaryMarkers,
  sanitizeUiSession,
} from "./history/uiHistoryHelpers";

export type HistoryExportMode = "simple" | "detailed";
export type UISessionSummary = UISessionSummaryRecord;

interface UIHistoryServiceOptions {
  store?: HistorySqliteStore;
}

interface CachedUiSession {
  session: UIChatSession;
  startPosition: number;
  totalCount: number;
  lastAccessedAt: number;
  dirtyMessageIds: Set<string>;
  requiresFullRewrite: boolean;
}

const UI_HISTORY_LIVE_TAIL_LIMIT = 500;
const UI_HISTORY_MAX_CACHED_SESSIONS = 4;
const UI_HISTORY_FULL_MESSAGE_REQUEST_LIMIT = 16;

const readUiHistorySessionId = (value: unknown): string | undefined =>
  readOpaqueNonBlankWellFormedString(value);

const requireUiHistorySessionId = (value: unknown): string => {
  const sessionId = readUiHistorySessionId(value);
  if (sessionId === undefined) throw new Error("Session id is required.");
  return sessionId;
};

const requireUiHistorySessionIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("Session ids must be an array.");
  const sessionIds = value.map((candidate) =>
    requireUiHistorySessionId(candidate),
  );
  return Array.from(new Set(sessionIds));
};

const createSessionRecord = <T>(): Record<string, T> =>
  Object.create(null) as Record<string, T>;

const UI_HISTORY_STRUCTURAL_METADATA_STRING_FIELDS = [
  "tabName",
  "commandId",
  "filePath",
  "toolName",
  "subToolTitle",
  "subToolHint",
  "approvalId",
  "command",
  "modelName",
  "compactionBoundaryTargetBackendMessageId",
  "compactionBoundaryPreviousBackendMessageId",
  "compactionBoundarySummaryBackendMessageId",
] as const;

export class UIHistoryService {
  private readonly store: HistorySqliteStore;
  private sessionsCache: Record<string, CachedUiSession> =
    createSessionRecord<CachedUiSession>();
  private sessionSummaryCache: Record<string, UISessionSummary> =
    createSessionRecord<UISessionSummary>();
  private dirtySessions: Set<string> = new Set();
  private revisionDirtySessions: Set<string> = new Set();
  private sessionUiRevisionById: Map<string, number> = new Map();

  constructor(options?: UIHistoryServiceOptions) {
    this.store = options?.store || new HistorySqliteStore();
    this.sessionSummaryCache = this.buildSessionSummaryCache(
      this.store.listUiSessionSummaries(),
    );
    Object.values(this.sessionSummaryCache).forEach((summary) => {
      this.sessionUiRevisionById.set(summary.id, summary.uiRevision);
    });
  }

  private buildSessionSummaryCache(
    summaries: UISessionSummary[],
  ): Record<string, UISessionSummary> {
    const cache = createSessionRecord<UISessionSummary>();
    for (const summary of summaries) {
      const sessionId = readUiHistorySessionId(summary?.id);
      if (sessionId === undefined) continue;
      cache[sessionId] = {
        ...summary,
        id: sessionId,
        uiRevision: Math.max(0, Math.floor(summary.uiRevision || 0)),
        lastMessagePreview: extractCommandOutputDisplayText(
          summary.lastMessagePreview || "",
        ),
      };
    }
    return cache;
  }

  private getOrLoadSession(sessionId: string): UIChatSession | null {
    const cached = this.sessionsCache[sessionId];
    if (cached) {
      cached.lastAccessedAt = Date.now();
      return cached.session;
    }
    const loadTail = (this.store as any).loadUiSessionTail;
    const loaded =
      typeof loadTail === "function"
        ? loadTail.call(this.store, sessionId, UI_HISTORY_LIVE_TAIL_LIMIT)
        : (() => {
            const session = this.store.loadUiSession(sessionId);
            return session
              ? {
                  session,
                  startPosition: 0,
                  totalCount: session.messages.length,
                }
              : null;
          })();
    if (!loaded) {
      return null;
    }
    const sanitized = sanitizeUiSession(loaded.session, {
      normalizeCompactionBoundaries: loaded.startPosition === 0,
    });
    sanitized.uiRevision = Math.max(
      sanitized.uiRevision || 0,
      this.getUiRevision(sessionId),
    );
    const entry: CachedUiSession = {
      session: sanitized,
      startPosition: loaded.startPosition,
      totalCount: loaded.totalCount,
      lastAccessedAt: Date.now(),
      dirtyMessageIds: new Set(),
      requiresFullRewrite: false,
    };
    this.sessionsCache[sessionId] = entry;
    this.syncSessionSummary(sessionId);
    this.evictInactiveSessionCaches(sessionId);
    return entry.session;
  }

  private getCachedSessionEntry(sessionId: string): CachedUiSession | null {
    return this.sessionsCache[sessionId] || null;
  }

  private evictInactiveSessionCaches(protectedSessionId?: string): void {
    const entries = Object.entries(this.sessionsCache);
    if (entries.length <= UI_HISTORY_MAX_CACHED_SESSIONS) return;
    entries
      .filter(([sessionId]) => sessionId !== protectedSessionId)
      .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt)
      .forEach(([sessionId]) => {
        if (
          Object.keys(this.sessionsCache).length <=
          UI_HISTORY_MAX_CACHED_SESSIONS
        ) {
          return;
        }
        if (this.dirtySessions.has(sessionId)) {
          this.flush(sessionId);
        }
        delete this.sessionsCache[sessionId];
      });
  }

  private trimCachedSession(sessionId: string): void {
    const entry = this.getCachedSessionEntry(sessionId);
    if (!entry || entry.session.messages.length <= UI_HISTORY_LIVE_TAIL_LIMIT) {
      return;
    }
    const removeCount = entry.session.messages.length - UI_HISTORY_LIVE_TAIL_LIMIT;
    entry.session.messages = entry.session.messages.slice(removeCount);
    entry.startPosition += removeCount;
  }

  private syncSessionSummary(sessionId: string): void {
    const entry = this.sessionsCache[sessionId];
    if (!entry) {
      return;
    }
    const uiRevision = this.getUiRevision(sessionId);
    entry.session.uiRevision = uiRevision;
    const tailSummary = buildUiSessionSummary(entry.session);
    this.sessionSummaryCache[sessionId] = {
      ...tailSummary,
      messagesCount: entry.totalCount,
      uiRevision,
    };
  }

  getMaxUiRevision(): number {
    const storedMaximum =
      typeof (this.store as any).getMaxUiRevision === "function"
        ? Number((this.store as any).getMaxUiRevision())
        : 0;
    let maximum = Number.isFinite(storedMaximum) ? storedMaximum : 0;
    this.sessionUiRevisionById.forEach((revision) => {
      maximum = Math.max(maximum, revision);
    });
    return Math.max(0, Math.floor(maximum));
  }

  getUiRevision(sessionId: string): number {
    const exactSessionId = readUiHistorySessionId(sessionId);
    if (exactSessionId === undefined) return 0;
    return Math.max(
      0,
      Math.floor(
        this.sessionUiRevisionById.get(exactSessionId) ||
          this.sessionsCache[exactSessionId]?.session.uiRevision ||
          this.sessionSummaryCache[exactSessionId]?.uiRevision ||
          0,
      ),
    );
  }

  noteUiRevision(sessionId: string, uiRevision: number): void {
    const exactSessionId = readUiHistorySessionId(sessionId);
    const normalizedRevision = Math.max(0, Math.floor(uiRevision));
    if (
      exactSessionId === undefined ||
      !Number.isSafeInteger(normalizedRevision) ||
      normalizedRevision <= this.getUiRevision(exactSessionId)
    ) {
      return;
    }
    this.sessionUiRevisionById.set(exactSessionId, normalizedRevision);
    const entry = this.sessionsCache[exactSessionId];
    if (entry) entry.session.uiRevision = normalizedRevision;
    const summary = this.sessionSummaryCache[exactSessionId];
    if (summary) {
      this.sessionSummaryCache[exactSessionId] = {
        ...summary,
        uiRevision: normalizedRevision,
      };
    }

    // A summary-only session may not have a live tail cache. Persist its
    // revision immediately so a restart cannot replay an older snapshot before
    // that session is opened again. Cached live sessions stay batched with the
    // normal durability flush to avoid a synchronous SQLite write per stream
    // delta.
    const updateRevision = (this.store as any).updateUiSessionRevision;
    if (
      !entry &&
      typeof updateRevision === "function" &&
      updateRevision.call(this.store, exactSessionId, normalizedRevision)
    ) {
      this.revisionDirtySessions.delete(exactSessionId);
      return;
    }
    this.revisionDirtySessions.add(exactSessionId);
  }

  private hydrateProjectedMessagesForEvent(
    sessionId: string,
    session: UIChatSession,
    event: AgentEvent,
  ): void {
    const loadMessages = (this.store as any).loadUiMessagesByIds;
    if (typeof loadMessages !== "function") return;
    const candidateIds = new Set<string>();
    const addMessage = (message: ChatMessage | undefined): void => {
      if (!message || !message.deferredPayload?.fields.length) return;
      candidateIds.add(message.id);
    };

    if (event.type === "say") {
      addMessage(
        [...session.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.type === "text" &&
              message.streaming,
          ),
      );
    } else if (event.type === "command_finished") {
      addMessage(
        session.messages.find(
          (message) => message.metadata?.commandId === event.commandId,
        ),
      );
    } else if (
      event.type === "sub_tool_delta" ||
      event.type === "sub_tool_finished"
    ) {
      addMessage(
        event.messageId
          ? session.messages.find(
              (message) => message.backendMessageId === event.messageId,
            )
          : [...session.messages]
              .reverse()
              .find(
                (message) =>
                  (message.type === "sub_tool" ||
                    message.type === "reasoning" ||
                    message.type === "compaction") &&
                  message.streaming,
              ),
      );
    } else if (event.type === "done") {
      session.messages.filter((message) => message.streaming).forEach(addMessage);
    }

    if (candidateIds.size === 0) return;
    const fullMessages = loadMessages.call(
      this.store,
      sessionId,
      [...candidateIds],
    ) as ChatMessage[];
    for (const fullMessage of fullMessages || []) {
      const index = session.messages.findIndex(
        (message) => message.id === fullMessage.id,
      );
      if (index >= 0) session.messages[index] = fullMessage;
    }
  }

  recordEvent(sessionId: string, event: AgentEvent): UIUpdateAction[] {
    const exactSessionId = readUiHistorySessionId(sessionId);
    if (exactSessionId === undefined) return [];
    sessionId = exactSessionId;
    let session = this.getOrLoadSession(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        title: "New Chat",
        messages: [],
        updatedAt: Date.now(),
      };
      this.sessionsCache[sessionId] = {
        session,
        startPosition: 0,
        totalCount: 0,
        lastAccessedAt: Date.now(),
        dirtyMessageIds: new Set(),
        requiresFullRewrite: false,
      };
    }
    const cacheEntry = this.sessionsCache[sessionId];
    cacheEntry.lastAccessedAt = Date.now();
    session.updatedAt = Date.now();

    this.hydrateProjectedMessagesForEvent(sessionId, session, event);
    const previousMessageIds = new Set(
      session.messages.map((message) => message.id),
    );
    const streamingMessageIdsBeforeEvent =
      event.type === "done"
        ? session.messages
            .filter((message) => message.streaming)
            .map((message) => message.id)
        : [];
    const previousDurableCount = session.messages.filter(
      (message) => message.type !== "ask",
    ).length;
    const actions = this.processEvent(session, event, sessionId);
    const nextDurableCount = session.messages.filter(
      (message) => message.type !== "ask",
    ).length;
    cacheEntry.totalCount += nextDurableCount - previousDurableCount;

    for (const action of actions) {
      if (
        action.type === "ADD_MESSAGE" ||
        action.type === "INSERT_MESSAGE"
      ) {
        cacheEntry.dirtyMessageIds.add(action.message.id);
      } else if (
        action.type === "UPDATE_MESSAGE" ||
        action.type === "APPEND_CONTENT" ||
        action.type === "APPEND_OUTPUT"
      ) {
        cacheEntry.dirtyMessageIds.add(action.messageId);
      } else if (
        action.type === "REMOVE_MESSAGE" ||
        action.type === "ROLLBACK"
      ) {
        cacheEntry.requiresFullRewrite = true;
      }
    }
    const nextMessageIds = new Set(session.messages.map((message) => message.id));
    if ([...previousMessageIds].some((id) => !nextMessageIds.has(id))) {
      cacheEntry.requiresFullRewrite = true;
    }
    if (event.type === "compaction_boundary") {
      cacheEntry.requiresFullRewrite = true;
    }
    if (event.type === "done") {
      // DONE settles every streaming row, not just the last row returned by
      // stopLatestStreaming. Only those rows need an incremental write.
      streamingMessageIdsBeforeEvent.forEach((messageId) =>
        cacheEntry.dirtyMessageIds.add(messageId),
      );
    }
    this.syncSessionSummary(sessionId);
    this.dirtySessions.add(sessionId);
    if (
      session.messages.length >= UI_HISTORY_LIVE_TAIL_LIMIT + 250 &&
      !session.messages.some((message) => message.type === "ask")
    ) {
      this.flush(sessionId, { preserveLiveTransientState: true });
      this.trimCachedSession(sessionId);
    }
    return actions.map((action) => this.projectUiUpdateForTransport(action));
  }

  flush(
    sessionId?: string,
    options?: { preserveLiveTransientState?: boolean },
  ): void {
    const exactSessionId =
      sessionId === undefined ? undefined : readUiHistorySessionId(sessionId);
    if (sessionId !== undefined && exactSessionId === undefined) return;
    const pendingSessionIds = new Set([
      ...this.dirtySessions,
      ...this.revisionDirtySessions,
    ]);
    const sessionIds =
      exactSessionId !== undefined
        ? pendingSessionIds.has(exactSessionId)
          ? [exactSessionId]
          : []
        : Array.from(pendingSessionIds);
    if (sessionIds.length === 0) {
      return;
    }

    sessionIds.forEach((id) => {
      const entry = this.sessionsCache[id];
      if (!entry) {
        const updateRevision = (this.store as any).updateUiSessionRevision;
        if (typeof updateRevision === "function") {
          updateRevision.call(this.store, id, this.getUiRevision(id));
        }
        this.dirtySessions.delete(id);
        this.revisionDirtySessions.delete(id);
        return;
      }
      if (!this.dirtySessions.has(id)) {
        const updateRevision = (this.store as any).updateUiSessionRevision;
        if (typeof updateRevision === "function") {
          updateRevision.call(this.store, id, this.getUiRevision(id));
        }
        this.revisionDirtySessions.delete(id);
        return;
      }
      this.hydrateDirtyMessagesForPersistence(id, entry);
      const sanitized = sanitizeUiSession(entry.session, {
        recoverInterruptedCommands: false,
        normalizeCompactionBoundaries: entry.startPosition === 0,
      });
      const persistedTotalCount = entry.startPosition + sanitized.messages.length;
      const summary: UISessionSummary = {
        ...buildUiSessionSummary(sanitized),
        messagesCount: persistedTotalCount,
      };
      this.sessionSummaryCache[id] = summary;

      let persisted = false;
      const incrementalStore = (this.store as any).upsertUiMessagesIncremental;
      if (
        !entry.requiresFullRewrite &&
        typeof incrementalStore === "function"
      ) {
        persisted = incrementalStore.call(
          this.store,
          sanitized,
          summary,
          entry.startPosition,
          entry.dirtyMessageIds,
        ) === true;
      }

      if (!persisted) {
        let rewriteSession = sanitized;
        let rewriteStartPosition = entry.startPosition;
        if (entry.requiresFullRewrite && entry.startPosition > 0) {
          const durable = this.store.loadUiSession(id);
          if (durable) {
            const durableById = new Map(
              durable.messages.map((message) => [message.id, message] as const),
            );
            rewriteSession = {
              ...durable,
              messages: [
                ...durable.messages.slice(0, entry.startPosition),
                ...sanitized.messages.map((message) =>
                  this.mergeProjectedMessageWithDurable(
                    message,
                    durableById.get(message.id),
                  ),
                ),
              ],
            };
            rewriteStartPosition = 0;
          }
        }
        if (typeof (this.store as any).saveUiSessionWindow === "function") {
          this.store.saveUiSessionWindow(
            rewriteSession,
            summary,
            rewriteStartPosition,
          );
        } else {
          this.store.saveUiSessions([{ session: rewriteSession, summary }]);
        }
      }

      entry.dirtyMessageIds.clear();
      entry.requiresFullRewrite = false;
      entry.totalCount = persistedTotalCount;
      if (options?.preserveLiveTransientState === true) {
        entry.session = {
          ...entry.session,
          messages: entry.session.messages.map((message) =>
            message.type === "ask" || message.streaming === true
              ? message
              : projectUiMessageForList(message),
          ),
        };
      } else {
        entry.session = sanitized;
        this.trimCachedSession(id);
      }
      this.dirtySessions.delete(id);
      this.revisionDirtySessions.delete(id);
    });
  }

  private hydrateDirtyMessagesForPersistence(
    sessionId: string,
    entry: CachedUiSession,
  ): void {
    if (entry.dirtyMessageIds.size === 0) return;
    const loadFullMessages = (this.store as any).loadUiMessagesByIds;
    if (typeof loadFullMessages !== "function") return;
    const fullMessages = loadFullMessages.call(
      this.store,
      sessionId,
      [...entry.dirtyMessageIds],
    ) as ChatMessage[];
    if (fullMessages.length === 0) return;
    const fullById = new Map(fullMessages.map((message) => [message.id, message]));
    entry.session.messages = entry.session.messages.map((message) => {
      const durable = fullById.get(message.id);
      return durable && message.deferredPayload?.fields.length
        ? this.mergeProjectedMessageWithDurable(message, durable)
        : message;
    });
  }

  private mergeProjectedMessageWithDurable(
    projected: ChatMessage,
    durable: ChatMessage | undefined,
  ): ChatMessage {
    if (!durable || !projected.deferredPayload?.fields.length) {
      return projected;
    }
    const deferredFields = new Set(projected.deferredPayload.fields);
    const metadata = {
      ...(durable.metadata || {}),
      ...(projected.metadata || {}),
    };
    if (deferredFields.has("metadata")) {
      for (const field of UI_HISTORY_STRUCTURAL_METADATA_STRING_FIELDS) {
        const durableValue = durable.metadata?.[field];
        if (durableValue === undefined) {
          delete metadata[field];
        } else {
          metadata[field] = durableValue as never;
        }
      }
    }
    for (const field of deferredFields) {
      if (field === "content" || field === "metadata") continue;
      const durableValue =
        durable.metadata?.[
          field as keyof NonNullable<ChatMessage["metadata"]>
        ];
      if (durableValue === undefined) {
        delete metadata[field as keyof typeof metadata];
      } else {
        metadata[field as keyof typeof metadata] = durableValue as never;
      }
    }
    return {
      ...projected,
      content: deferredFields.has("content") ? durable.content : projected.content,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      deferredPayload: undefined,
    };
  }

  private projectUiUpdateForTransport(action: UIUpdateAction): UIUpdateAction {
    if (action.type === "ADD_MESSAGE" || action.type === "INSERT_MESSAGE") {
      return {
        ...action,
        message: projectUiMessageForList(action.message),
      };
    }
    if (action.type !== "UPDATE_MESSAGE") return action;
    const patchMessage: ChatMessage = {
      id: action.messageId,
      role: action.patch.role || "assistant",
      type: action.patch.type || "text",
      content: action.patch.content || "",
      metadata: action.patch.metadata,
      timestamp: action.patch.timestamp || Date.now(),
      streaming: action.patch.streaming,
    };
    const projected = projectUiMessageForList(patchMessage);
    return {
      ...action,
      patch: {
        ...action.patch,
        ...(action.patch.content !== undefined
          ? { content: projected.content }
          : {}),
        ...(action.patch.metadata !== undefined
          ? { metadata: projected.metadata }
          : {}),
        ...(projected.deferredPayload
          ? { deferredPayload: projected.deferredPayload }
          : {}),
      },
    };
  }

  private processEvent(
    session: UIChatSession,
    event: AgentEvent,
    sessionId: string,
  ): UIUpdateAction[] {
    const type = event.type as AgentEventType;
    const actions: UIUpdateAction[] = [];

    if (type === "user_input") {
      const message = this.createMessage(
        {
          role: "user",
          type: "text",
          content: event.content || "",
          metadata: {
            inputKind: event.inputKind || "normal",
            ...(Array.isArray(event.inputImages) && event.inputImages.length > 0
              ? { inputImages: event.inputImages }
              : {}),
          },
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      this.checkAutoTitle(session, "user", event.content || "");
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "say") {
      const lastMessage = session.messages[session.messages.length - 1];
      const delta = event.content || event.outputDelta || "";
      if (
        lastMessage &&
        lastMessage.role === "assistant" &&
        lastMessage.type === "text" &&
        lastMessage.streaming
      ) {
        lastMessage.content += delta;
        actions.push({
          type: "APPEND_CONTENT",
          sessionId,
          messageId: lastMessage.id,
          content: delta,
        });
      } else {
        const stopAction = this.stopLatestStreaming(session, sessionId);
        if (stopAction) actions.push(stopAction);

        const message = this.createMessage(
          {
            role: "assistant",
            type: "text",
            content: delta,
            streaming: true,
            backendMessageId: event.messageId,
          },
          sessionId,
        );
        session.messages.push(message);
        actions.push({ type: "ADD_MESSAGE", sessionId, message });
      }
    } else if (type === "command_started") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const existingIndex = session.messages.findIndex(
        (message) =>
          message.backendMessageId === event.messageId &&
          message.type === "ask",
      );
      if (existingIndex !== -1) {
        session.messages.splice(existingIndex, 1);
      }

      const message = this.createMessage(
        {
          role: "assistant",
          type: "command",
          content: event.command || "",
          metadata: {
            commandId: event.commandId,
            tabName: event.tabName || "Terminal",
            output: "",
            isNowait: event.isNowait === true,
            commandOutput: event.commandOutput,
            collapsed: false,
          },
          streaming: true,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "command_finished") {
      const existingIndex = session.messages.findIndex(
        (message) =>
          message.backendMessageId === event.messageId &&
          message.type === "ask",
      );
      if (existingIndex !== -1) {
        session.messages.splice(existingIndex, 1);
      }

      const message = event.commandId
        ? session.messages.find(
            (entry) => entry.metadata?.commandId === event.commandId,
          )
        : [...session.messages]
            .reverse()
            .find((entry) => entry.type === "command" && entry.streaming);

      if (message) {
        const patch = {
          metadata: {
            ...message.metadata,
            exitCode: event.exitCode,
            output:
              event.outputMode === "replace"
                ? (event.outputDelta || "") +
                  (event.message ? `\nError: ${event.message}` : "")
                : (message.metadata?.output || "") +
                  (event.outputDelta || "") +
                  (event.message ? `\nError: ${event.message}` : ""),
            isNowait: event.isNowait ?? message.metadata?.isNowait,
            commandOutput:
              event.commandOutput ?? message.metadata?.commandOutput,
          },
          streaming: false,
        };
        Object.assign(message, patch);
        actions.push({
          type: "UPDATE_MESSAGE",
          sessionId,
          messageId: message.id,
          patch,
        });
      }
    } else if (type === "tool_call") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "assistant",
          type: "tool_call",
          content: event.input || "",
          metadata: {
            output: event.output || "",
            toolName: event.toolName || "Tool Call",
            subToolLevel: event.level,
            commandOutput: event.commandOutput,
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "file_edit") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "assistant",
          type: "file_edit",
          content: event.output || "",
          metadata: {
            toolName: event.toolName || "create_or_edit",
            filePath: event.filePath,
            action: event.action || "edited",
            diff: event.diff || "",
            output: event.output || "",
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "file_read") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "assistant",
          type: "sub_tool",
          content: event.output || "",
          metadata: {
            subToolTitle: `Read: ${event.filePath || "unknown"}`,
            subToolLevel:
              event.level ||
              (String(event.output || "").startsWith("Error:")
                ? "warning"
                : "info"),
            output: event.output || "",
            collapsed: true,
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "command_ask") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "system",
          type: "ask",
          content: event.command || "",
          metadata: {
            approvalId: event.approvalId,
            toolName: event.toolName || "Command",
            command: event.command || "",
            decision: (event as any).decision,
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "sub_tool_started") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);
      const messageType = this.getSubToolMessageType(event);

      const message = this.createMessage(
        {
          role: "assistant",
          type: messageType,
          content: "",
          metadata: {
            subToolTitle: event.title || event.toolName || "Sub Tool",
            subToolHint: event.hint,
            output: "",
            subToolLevel: event.level || "info",
            collapsed: true,
          },
          streaming: true,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "sub_tool_delta") {
      const message = event.messageId
        ? session.messages.find(
            (entry) => entry.backendMessageId === event.messageId,
          )
        : [...session.messages]
            .reverse()
            .find(
              (entry) =>
                (entry.type === "sub_tool" ||
                  entry.type === "reasoning" ||
                  entry.type === "compaction") &&
                entry.streaming,
            );

      if (message) {
        const delta = event.outputDelta || "";
        message.metadata = {
          ...message.metadata,
          output: (message.metadata?.output || "") + delta,
        };
        actions.push({
          type: "APPEND_OUTPUT",
          sessionId,
          messageId: message.id,
          outputDelta: delta,
        });
      }
    } else if (type === "sub_tool_finished") {
      const message = event.messageId
        ? session.messages.find(
            (entry) => entry.backendMessageId === event.messageId,
          )
        : [...session.messages]
            .reverse()
            .find(
              (entry) =>
                (entry.type === "sub_tool" ||
                  entry.type === "reasoning" ||
                  entry.type === "compaction") &&
                entry.streaming,
            );
      if (message) {
        const patch = {
          ...(event.level
            ? {
                metadata: {
                  ...message.metadata,
                  subToolLevel: event.level,
                },
              }
            : {}),
          streaming: false,
        };
        Object.assign(message, patch);
        actions.push({
          type: "UPDATE_MESSAGE",
          sessionId,
          messageId: message.id,
          patch,
        });
      }
    } else if (type === "compaction_boundary") {
      const boundaryTargetBackendMessageId = this.normalizeBackendMessageId(
        event.boundaryTargetMessageId,
      );
      const boundaryPreviousBackendMessageId = this.normalizeBackendMessageId(
        event.boundaryPreviousMessageId,
      );
      const boundarySummaryBackendMessageId = this.normalizeBackendMessageId(
        event.summaryMessageId,
      );
      if (
        !boundaryTargetBackendMessageId &&
        !boundaryPreviousBackendMessageId
      ) {
        return actions;
      }

      const message = this.createMessage(
        {
          role: "system",
          type: "compaction_boundary",
          content: "",
          metadata: {
            ...(boundaryTargetBackendMessageId
              ? {
                  compactionBoundaryTargetBackendMessageId:
                    boundaryTargetBackendMessageId,
                }
              : {}),
            ...(boundaryPreviousBackendMessageId
              ? {
                  compactionBoundaryPreviousBackendMessageId:
                    boundaryPreviousBackendMessageId,
                }
              : {}),
            ...(boundarySummaryBackendMessageId
              ? {
                  compactionBoundarySummaryBackendMessageId:
                    boundarySummaryBackendMessageId,
                }
              : {}),
            ...(typeof event.protectedNormalRounds === "number"
              ? {
                  compactionBoundaryProtectedNormalRounds:
                    event.protectedNormalRounds,
                }
              : {}),
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );

      const insertion = this.insertCompactionBoundaryMessage(session, message);
      if (insertion) {
        actions.push({
          type: "INSERT_MESSAGE",
          sessionId,
          message,
          anchorMessageId: insertion.anchorMessageId,
          anchorBackendMessageId: insertion.anchorBackendMessageId,
          placement: insertion.placement,
        });
      }
    } else if (type === "remove_message") {
      const message = event.messageId
        ? [...session.messages]
            .reverse()
            .find(
              (entry) =>
                entry.backendMessageId === event.messageId &&
                entry.role === "assistant",
            )
        : [...session.messages]
            .reverse()
            .find((entry) => entry.role === "assistant");
      if (message) {
        session.messages = session.messages.filter(
          (entry) => entry.id !== message.id,
        );
        actions.push({
          type: "REMOVE_MESSAGE",
          sessionId,
          messageId: message.id,
        });
      }
    } else if (type === "done") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);
      actions.push({ type: "DONE", sessionId });
      session.messages.forEach((message) => {
        message.streaming = false;
      });
    } else if (type === "alert") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "system",
          type: "alert",
          content: event.message || "Unknown alert",
          metadata: {
            subToolLevel: event.level || "warning",
          },
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "error") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "system",
          type: "error",
          content: event.message || "Unknown error",
          metadata: {
            details: (event as any).details || "",
          },
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
      actions.push({ type: "DONE", sessionId });
    } else if (type === "tokens_count") {
      const message = this.createMessage(
        {
          role: "system",
          type: "tokens_count",
          content: "",
          metadata: {
            modelName: event.modelName,
            totalTokens: event.totalTokens,
            maxTokens: event.maxTokens,
          },
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if ((type as string) === "rollback") {
      const backendMessageId = (event as any).messageId;
      const index = session.messages.findIndex(
        (message) => message.backendMessageId === backendMessageId,
      );
      if (index !== -1) {
        session.messages = normalizeCompactionBoundaryMarkers(
          session.messages.slice(0, index),
        );
        this.dirtySessions.add(sessionId);
        actions.push({
          type: "ROLLBACK" as any,
          sessionId,
          messageId: backendMessageId,
        } as any);
      }
    }
    return actions;
  }

  private stopLatestStreaming(
    session: UIChatSession,
    sessionId: string,
  ): UIUpdateAction | null {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      if (!session.messages[index].streaming) {
        continue;
      }
      session.messages[index].streaming = false;
      return {
        type: "UPDATE_MESSAGE",
        sessionId,
        messageId: session.messages[index].id,
        patch: { streaming: false },
      };
    }
    return null;
  }

  private createMessage(
    message: Omit<ChatMessage, "id" | "timestamp">,
    _sessionId?: string,
  ): ChatMessage {
    return {
      ...message,
      id: uuidv4(),
      timestamp: Date.now(),
    };
  }

  private normalizeBackendMessageId(value: unknown): string {
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : "";
  }

  private findExistingCompactionBoundaryIndex(
    messages: ChatMessage[],
    boundary: ChatMessage,
  ): number {
    const summaryBackendId = this.normalizeBackendMessageId(
      boundary.metadata?.compactionBoundarySummaryBackendMessageId,
    );
    const targetBackendId = this.normalizeBackendMessageId(
      boundary.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    return messages.findIndex((message) => {
      if (message.type !== "compaction_boundary") return false;
      if (
        boundary.backendMessageId &&
        message.backendMessageId === boundary.backendMessageId
      ) {
        return true;
      }
      if (
        summaryBackendId &&
        message.metadata?.compactionBoundarySummaryBackendMessageId ===
          summaryBackendId
      ) {
        return true;
      }
      return (
        !!targetBackendId &&
        message.metadata?.compactionBoundaryTargetBackendMessageId ===
          targetBackendId
      );
    });
  }

  private insertCompactionBoundaryMessage(
    session: UIChatSession,
    message: ChatMessage,
  ): {
    anchorMessageId: string;
    anchorBackendMessageId: string;
    placement: "before" | "after";
  } | null {
    if (
      this.findExistingCompactionBoundaryIndex(session.messages, message) >= 0
    ) {
      session.messages = normalizeCompactionBoundaryMarkers(session.messages);
      return null;
    }

    const targetBackendId = this.normalizeBackendMessageId(
      message.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    const previousBackendId = this.normalizeBackendMessageId(
      message.metadata?.compactionBoundaryPreviousBackendMessageId,
    );

    if (targetBackendId) {
      const targetIndex = session.messages.findIndex(
        (entry) => entry.backendMessageId === targetBackendId,
      );
      if (targetIndex >= 0) {
        const anchor = session.messages[targetIndex];
        session.messages.splice(targetIndex, 0, message);
        return {
          anchorMessageId: anchor.id,
          anchorBackendMessageId: targetBackendId,
          placement: "before",
        };
      }
    }

    if (previousBackendId && !targetBackendId) {
      const previousIndex = session.messages.findIndex(
        (entry) => entry.backendMessageId === previousBackendId,
      );
      if (previousIndex >= 0) {
        const anchor = session.messages[previousIndex];
        session.messages.splice(previousIndex + 1, 0, message);
        return {
          anchorMessageId: anchor.id,
          anchorBackendMessageId: previousBackendId,
          placement: "after",
        };
      }
    }

    console.warn(
      `[UIHistoryService] Dropped compaction boundary marker because its UI anchor was not found (target=${targetBackendId || "none"}, previous=${previousBackendId || "none"}).`,
    );
    return null;
  }

  private getSubToolMessageType(event: AgentEvent): ChatMessage["type"] {
    const rawTitle = String(event.title || event.toolName || "")
      .trim()
      .toLowerCase();
    if (rawTitle.startsWith("reasoning")) return "reasoning";
    if (rawTitle.startsWith("compaction")) return "compaction";
    return "sub_tool";
  }

  private checkAutoTitle(
    session: UIChatSession,
    role: string,
    content: string,
  ): void {
    const currentTitle = String(session.title || "").trim();
    if (
      role === "user" &&
      session.messages.filter((message) => message.role === "user").length ===
        1 &&
      (!currentTitle || currentTitle === "New Chat")
    ) {
      session.title = buildAutoSessionTitle(content);
    }
  }

  getMessagePage(
    sessionId: string,
    request?: UiMessagePageRequest,
  ): UiMessagePage | null {
    const exactSessionId = readUiHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    // Initialize the bounded live tail before reading a page. This applies the
    // same interrupted-command recovery that the legacy full-session path used,
    // while later live events can still replace recovered rows in the cache.
    this.getOrLoadSession(sessionId);
    this.flush(sessionId, { preserveLiveTransientState: true });
    const page = this.store.loadUiMessagePage(sessionId, request);
    if (!page || page.sessionId !== sessionId) return null;

    const entry = this.getCachedSessionEntry(sessionId);
    const cachedById = new Map(
      (entry?.session.messages || []).map(
        (message) => [message.id, message] as const,
      ),
    );
    const recoveredPage = sanitizeUiSession(
      {
        id: sessionId,
        title: "",
        updatedAt: 0,
        messages: page.entries.map((item) => item.message),
      },
      {
        recoverInterruptedCommands: true,
        normalizeCompactionBoundaries: false,
      },
    );
    const recoveredById = new Map(
      recoveredPage.messages.map((message) => [message.id, message] as const),
    );
    const durableEntries = page.entries.map((item) => ({
      ...item,
      message: projectUiMessageForList(
        cachedById.get(item.message.id) ||
          recoveredById.get(item.message.id) ||
          item.message,
      ),
    }));
    const transientMessages = (entry?.session.messages || []).filter(
      (message) => message.type === "ask",
    );
    const isTailRequest =
      request?.beforePosition === undefined &&
      request?.aroundPosition === undefined &&
      (request?.afterPosition === undefined || page.hasNewer === false);
    if (!isTailRequest || transientMessages.length === 0) {
      return {
        ...page,
        entries: durableEntries,
        uiRevision: this.getUiRevision(sessionId),
      };
    }

    const durableCount = page.totalCount;
    const entries = [
      ...durableEntries,
      ...transientMessages.map((message, index) => ({
        position: durableCount + index,
        message: projectUiMessageForList(message),
      })),
    ];
    return {
      ...page,
      entries,
      totalCount: durableCount + transientMessages.length,
      startPosition: entries[0]?.position ?? null,
      endPosition: entries[entries.length - 1]?.position ?? null,
      hasNewer: false,
      uiRevision: this.getUiRevision(sessionId),
    };
  }

  getMessageGeometryIndex(sessionId: string): UiMessageGeometryIndex | null {
    const exactSessionId = readUiHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    // Materialize the bounded live tail first so persisted process-local
    // running/cursor state receives the same restart recovery as page reads.
    this.getOrLoadSession(sessionId);
    this.flush(sessionId, { preserveLiveTransientState: true });
    const loadGeometry = (this.store as any).loadUiMessageGeometryIndex;
    if (typeof loadGeometry !== "function") return null;
    const index = loadGeometry.call(
      this.store,
      sessionId,
    ) as UiMessageGeometryIndex | null;
    if (!index || index.sessionId !== sessionId) return null;

    const cachedById = new Map(
      (this.getCachedSessionEntry(sessionId)?.session.messages || []).map(
        (message) => [message.id, message] as const,
      ),
    );
    return {
      ...index,
      uiRevision: this.getUiRevision(sessionId),
      entries: index.entries.map((entry) => {
        const cached = cachedById.get(entry.id);
        const persistedContract = parseCommandOutputContractV1(
          entry.metadata?.commandOutput,
        );
        const cachedContract = parseCommandOutputContractV1(
          cached?.metadata?.commandOutput,
        );
        const commandOutput = cached
          ? cachedContract
          : persistedContract
            ? expireUnbackedCommandOutputContract(persistedContract)
            : undefined;
        const metadata = {
          ...(entry.metadata || {}),
          ...(cached?.metadata?.exitCode !== undefined
            ? { exitCode: cached.metadata.exitCode }
            : {}),
          ...(cached?.metadata?.isNowait !== undefined
            ? { isNowait: cached.metadata.isNowait }
            : {}),
          ...(commandOutput ? { commandOutput } : {}),
        };
        if (!commandOutput) delete metadata.commandOutput;
        const streaming = cached?.streaming === true;
        if (!cached && entry.streaming && entry.type === "command") {
          metadata.exitCode ??= -1;
        }
        return {
          ...entry,
          streaming,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        };
      }),
    };
  }

  getFullMessagesByIds(
    sessionId: string,
    messageIds: string[],
  ): UiFullMessagesResult {
    sessionId = requireUiHistorySessionId(sessionId);
    this.flush(sessionId, { preserveLiveTransientState: true });
    const ids = new Set(
      Array.from(new Set(messageIds.filter(Boolean))).slice(
        0,
        UI_HISTORY_FULL_MESSAGE_REQUEST_LIMIT,
      ),
    );
    const durable = this.store.loadUiMessagesByIds(sessionId, [...ids]);
    const recoveredDurable = sanitizeUiSession(
      {
        id: sessionId,
        title: "",
        updatedAt: 0,
        messages: durable,
      },
      {
        recoverInterruptedCommands: true,
        normalizeCompactionBoundaries: false,
      },
    ).messages;
    const durableById = new Map(
      recoveredDurable.map((message) => [message.id, message] as const),
    );
    const cached = this.getCachedSessionEntry(sessionId);
    cached?.session.messages.forEach((message) => {
      if (!ids.has(message.id)) return;
      durableById.set(
        message.id,
        this.mergeProjectedMessageWithDurable(
          message,
          durableById.get(message.id),
        ),
      );
    });
    return {
      sessionId,
      messages: [...durableById.values()],
      uiRevision: this.getUiRevision(sessionId),
    };
  }

  searchMessages(
    sessionId: string,
    query: string,
    limit?: number,
  ): UiMessageSearchResult {
    sessionId = requireUiHistorySessionId(sessionId);
    this.flush(sessionId, { preserveLiveTransientState: true });
    return {
      ...this.store.searchUiMessages(sessionId, query, limit),
      uiRevision: this.getUiRevision(sessionId),
    };
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.getSession(sessionId)?.messages || [];
  }

  getSession(sessionId: string): UIChatSession | null {
    const exactSessionId = readUiHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const cached = this.getCachedSessionEntry(sessionId);
    if (!cached) {
      const loaded = this.store.loadUiSession(sessionId);
      return loaded?.id === sessionId ? sanitizeUiSession(loaded) : null;
    }

    cached.lastAccessedAt = Date.now();
    const loaded = this.store.loadUiSession(sessionId);
    if (!loaded) return cached.session;
    if (loaded.id !== sessionId) return null;

    const durableById = new Map(
      loaded.messages.map((message) => [message.id, message] as const),
    );
    if (cached.requiresFullRewrite) {
      return {
        ...loaded,
        messages: [
          ...loaded.messages.slice(0, cached.startPosition),
          ...cached.session.messages.map((message) =>
            this.mergeProjectedMessageWithDurable(
              message,
              durableById.get(message.id),
            ),
          ),
        ],
      };
    }

    const cachedById = new Map(
      cached.session.messages.map((message) => [message.id, message] as const),
    );
    const dirtyIds = cached.dirtyMessageIds;
    const mergedMessages = loaded.messages.map((message) =>
      dirtyIds.has(message.id)
        ? this.mergeProjectedMessageWithDurable(
            cachedById.get(message.id) || message,
            message,
          )
        : message,
    );
    const loadedIds = new Set(loaded.messages.map((message) => message.id));
    cached.session.messages.forEach((message) => {
      if (!loadedIds.has(message.id)) mergedMessages.push(message);
    });
    return {
      ...loaded,
      messages: mergedMessages,
    };
  }

  getAllSessions(): UIChatSession[] {
    return this.store
      .listUiSessions()
      .map((session) => sanitizeUiSession(session));
  }

  getAllSessionSummaries(): UISessionSummary[] {
    return Object.values(this.sessionSummaryCache).sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }

  recordFeedbackDecision(
    feedbackId: string,
    decision: "allow" | "deny",
  ): UIUpdateAction | null {
    const normalizedId = String(feedbackId || "").trim();
    if (!normalizedId) return null;

    for (const [sessionId, entry] of Object.entries(this.sessionsCache)) {
      const message = [...entry.session.messages].reverse().find((candidate) => {
        if (candidate.type !== "ask") return false;
        return (
          candidate.backendMessageId === normalizedId ||
          candidate.metadata?.approvalId === normalizedId
        );
      });
      if (!message) continue;
      if (message.metadata?.decision === decision) return null;
      message.metadata = { ...(message.metadata || {}), decision };
      entry.session.updatedAt = Date.now();
      this.syncSessionSummary(sessionId);
      this.dirtySessions.add(sessionId);
      this.flush(sessionId);
      return {
        type: "UPDATE_MESSAGE",
        sessionId,
        messageId: message.id,
        patch: { metadata: { ...message.metadata } },
      };
    }

    const findStoredFeedback = (this.store as any).findUiMessageByFeedbackId;
    if (typeof findStoredFeedback !== "function") return null;
    const stored = findStoredFeedback.call(this.store, normalizedId) as
      | { sessionId: string; message: ChatMessage }
      | null;
    const storedSessionId = readUiHistorySessionId(stored?.sessionId);
    if (
      !stored ||
      storedSessionId === undefined ||
      stored.message.metadata?.decision === decision
    ) {
      return null;
    }
    stored.message.metadata = {
      ...(stored.message.metadata || {}),
      decision,
    };
    const updatedAt = Date.now();
    const updateStoredMessage = (this.store as any).updateUiMessage;
    if (
      typeof updateStoredMessage !== "function" ||
      !updateStoredMessage.call(
        this.store,
        storedSessionId,
        stored.message,
        updatedAt,
      )
    ) {
      return null;
    }
    const summary = this.sessionSummaryCache[storedSessionId];
    if (summary) {
      this.sessionSummaryCache[storedSessionId] = { ...summary, updatedAt };
    }
    return {
      type: "UPDATE_MESSAGE",
      sessionId: storedSessionId,
      messageId: stored.message.id,
      patch: { metadata: { ...stored.message.metadata } },
    };
  }

  deleteSession(sessionId: string): void {
    this.deleteSessions([sessionId]);
  }

  deleteSessions(sessionIds: string[]): void {
    const ids = requireUiHistorySessionIds(sessionIds);
    if (ids.length === 0) {
      return;
    }
    ids.forEach((id) => {
      delete this.sessionsCache[id];
      delete this.sessionSummaryCache[id];
      this.sessionUiRevisionById.delete(id);
      this.dirtySessions.delete(id);
      this.revisionDirtySessions.delete(id);
    });
    this.store.deleteUiSessions(ids);
  }

  renameSession(sessionId: string, newTitle: string): void {
    sessionId = requireUiHistorySessionId(sessionId);
    const updatedAt = Date.now();
    const session = this.getOrLoadSession(sessionId);
    if (session) {
      session.title = newTitle;
      session.updatedAt = updatedAt;
      this.syncSessionSummary(sessionId);
      this.dirtySessions.add(sessionId);
      this.flush(sessionId);
      return;
    }

    const summary = this.sessionSummaryCache[sessionId];
    if (!summary) {
      const createdSession: UIChatSession = {
        id: sessionId,
        title: newTitle,
        messages: [],
        updatedAt,
      };
      this.sessionsCache[sessionId] = {
        session: createdSession,
        startPosition: 0,
        totalCount: 0,
        lastAccessedAt: updatedAt,
        dirtyMessageIds: new Set(),
        requiresFullRewrite: false,
      };
      this.syncSessionSummary(sessionId);
      this.dirtySessions.add(sessionId);
      this.flush(sessionId);
      return;
    }
    this.sessionSummaryCache[sessionId] = {
      ...summary,
      title: newTitle,
      updatedAt,
    };
    this.store.renameUiSession(sessionId, newTitle, updatedAt);
  }

  rollbackToMessage(sessionId: string, backendMessageId: string): number {
    const exactSessionId = readUiHistorySessionId(sessionId);
    if (exactSessionId === undefined) return 0;
    sessionId = exactSessionId;
    const result = this.store.truncateUiSessionBeforeBackendMessage(
      sessionId,
      backendMessageId,
      Date.now(),
    );
    if (!result) return 0;

    delete this.sessionsCache[sessionId];
    this.dirtySessions.delete(sessionId);
    const storedSummary = this.store.getUiSessionSummary(sessionId);
    if (storedSummary) {
      this.sessionSummaryCache[sessionId] = {
        ...storedSummary,
        lastMessagePreview: extractCommandOutputDisplayText(
          storedSummary.lastMessagePreview || "",
        ),
      };
    }
    return result.removedCount;
  }

  validateBranchFromMessage(
    sourceSessionId: string,
    backendMessageId: string,
  ): { ok: boolean; reason?: string } {
    const exactSourceSessionId = readUiHistorySessionId(sourceSessionId);
    if (exactSourceSessionId === undefined) {
      return { ok: false, reason: "Source UI session not found." };
    }
    sourceSessionId = exactSourceSessionId;
    const source = this.getSession(sourceSessionId);
    if (!source) {
      return { ok: false, reason: "Source UI session not found." };
    }
    const index = source.messages.findIndex(
      (message) => message.backendMessageId === backendMessageId,
    );
    if (index === -1) {
      return { ok: false, reason: "Branch target UI message not found." };
    }

    const containsUnsettledMessage = source.messages
      .slice(0, index + 1)
      .some((message) => {
        const commandOutput = parseCommandOutputContractV1(
          message.metadata?.commandOutput,
        );
        return (
          message.type === "command" &&
          (commandOutput?.executionState === "running" ||
            message.streaming === true)
        );
      });
    if (containsUnsettledMessage) {
      return {
        ok: false,
        reason:
          "Cannot branch through an unfinished message or running command. Wait for it to settle, then try again.",
      };
    }
    return { ok: true };
  }

  branchFromMessage(
    sourceSessionId: string,
    branchSessionId: string,
    backendMessageId: string,
    title: string,
  ): {
    ok: boolean;
    sessionId?: string;
    title?: string;
    messageCount?: number;
    reason?: string;
  } {
    const exactSourceSessionId = readUiHistorySessionId(sourceSessionId);
    const exactBranchSessionId = readUiHistorySessionId(branchSessionId);
    if (
      exactSourceSessionId === undefined ||
      exactBranchSessionId === undefined
    ) {
      return { ok: false, reason: "Invalid UI session id." };
    }
    sourceSessionId = exactSourceSessionId;
    branchSessionId = exactBranchSessionId;
    const validation = this.validateBranchFromMessage(
      sourceSessionId,
      backendMessageId,
    );
    if (!validation.ok) return validation;

    const source = this.getSession(sourceSessionId)!;
    const index = source.messages.findIndex(
      (message) => message.backendMessageId === backendMessageId,
    );

    const updatedAt = Date.now();
    const branch: UIChatSession = {
      id: branchSessionId,
      title: title.trim() || "Branch",
      updatedAt,
      messages: normalizeCompactionBoundaryMarkers(
        source.messages.slice(0, index + 1).map((message) => ({
          ...JSON.parse(JSON.stringify(message)),
          id: uuidv4(),
          streaming: false,
        })),
      ),
    };
    this.sessionsCache[branchSessionId] = {
      session: branch,
      startPosition: 0,
      totalCount: branch.messages.length,
      lastAccessedAt: updatedAt,
      dirtyMessageIds: new Set(branch.messages.map((message) => message.id)),
      requiresFullRewrite: true,
    };
    this.syncSessionSummary(branchSessionId);
    this.dirtySessions.add(branchSessionId);
    this.flush(branchSessionId);

    return {
      ok: true,
      sessionId: branchSessionId,
      title: branch.title,
      messageCount: branch.messages.length,
    };
  }

  toReadableMarkdown(messages: ChatMessage[], title: string): string {
    const lines: string[] = [];
    lines.push(`# ${title || "Conversation"}`);
    lines.push("");
    lines.push(`Exported at: ${new Date().toISOString()}`);
    lines.push("");

    let visibleCount = 0;

    for (const message of messages) {
      const body = this.getReadableMessageBody(message);
      if (!body) continue;

      visibleCount += 1;
      lines.push(
        `## ${visibleCount}. ${message.role === "user" ? "User" : "Assistant"}`,
      );
      lines.push("");
      lines.push(body);
      lines.push("");
    }

    if (visibleCount === 0) {
      lines.push("No user/assistant content found in frontend UI history.");
      lines.push("");
    }

    return lines.join("\n");
  }

  toReadableMarkdownFragment(messages: ChatMessage[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      const body = this.getReadableMessageBody(message);
      if (body) parts.push(body);
    }
    return this.normalizeText(parts.join("\n\n"));
  }

  toReadableMarkdownFragmentByMessageIds(
    sessionId: string,
    messageIds: string[],
  ): string {
    const exactSessionId = readUiHistorySessionId(sessionId);
    if (exactSessionId === undefined) return "";
    const selected = this.store.loadUiMessagesByIds(
      exactSessionId,
      messageIds,
    );
    return this.toReadableMarkdownFragment(selected);
  }

  private getReadableMessageBody(message: ChatMessage): string {
    if (message.role !== "user" && message.role !== "assistant") return "";
    if (message.role === "user") {
      const normalized = this.normalizeText(message.content);
      if (normalized) return normalized;
      if (
        Array.isArray(message.metadata?.inputImages) &&
        message.metadata.inputImages.length > 0
      ) {
        const lines = [
          "Attached images:",
          ...message.metadata.inputImages.map(
            (item) => `- ${item.fileName || item.attachmentId || "image"}`,
          ),
        ];
        return this.normalizeText(lines.join("\n"));
      }
      return "";
    }
    return this.extractAssistantRichContent(message);
  }

  private extractAssistantRichContent(message: ChatMessage): string {
    const chunks: string[] = [];

    switch (message.type) {
      case "text": {
        const text = this.normalizeText(message.content);
        if (text) chunks.push(text);
        break;
      }
      case "command": {
        const commandOutput = parseCommandOutputContractV1(
          message.metadata?.commandOutput,
        );
        const commandText = this.normalizeText(
          message.content || message.metadata?.command || "",
        );
        const outputText = this.normalizeText(
          extractCommandOutputDisplayText(message.metadata?.output || ""),
        );
        if (commandText) {
          chunks.push("Command:");
          chunks.push("```bash");
          chunks.push(commandText);
          chunks.push("```");
        }
        if (commandOutput) {
          chunks.push(
            this.formatReadableCommandOutputStatus(commandOutput),
          );
        }
        if (outputText) {
          chunks.push("Output:");
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      case "tool_call": {
        const commandOutput = parseCommandOutputContractV1(
          message.metadata?.commandOutput,
        );
        const inputText = this.normalizeText(message.content || "");
        const outputText = this.normalizeText(
          extractCommandOutputDisplayText(message.metadata?.output || ""),
        );
        const toolName = this.normalizeText(
          message.metadata?.toolName || "Tool Call",
        );
        chunks.push(`Tool: ${toolName}`);
        if (inputText) {
          chunks.push("Input:");
          chunks.push("```text");
          chunks.push(inputText);
          chunks.push("```");
        }
        if (commandOutput) {
          chunks.push(
            this.formatReadableCommandOutputStatus(commandOutput),
          );
        }
        if (outputText) {
          chunks.push("Output:");
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      case "file_edit": {
        const filePath = this.normalizeText(message.metadata?.filePath || "");
        const outputText = this.normalizeText(
          message.metadata?.output || message.content || "",
        );
        const diffText = this.normalizeText(message.metadata?.diff || "");
        const action = this.normalizeText(message.metadata?.action || "edited");
        chunks.push(`File Edit (${action})${filePath ? `: ${filePath}` : ""}`);
        if (outputText) {
          chunks.push("Result:");
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        if (diffText) {
          chunks.push("Diff:");
          chunks.push("```diff");
          chunks.push(diffText);
          chunks.push("```");
        }
        break;
      }
      case "sub_tool": {
        const title = this.normalizeText(
          message.metadata?.subToolTitle || "Sub Tool",
        );
        const outputText = this.normalizeText(
          message.metadata?.output || message.content || "",
        );
        chunks.push(`Sub Tool: ${title}`);
        if (outputText) {
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      case "compaction": {
        const title = this.normalizeText(
          message.metadata?.subToolTitle || "Compaction",
        );
        const outputText = this.normalizeText(
          message.metadata?.output || message.content || "",
        );
        chunks.push(`Compaction: ${title}`);
        if (outputText) {
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      default: {
        const text = this.normalizeText(message.content);
        if (text) chunks.push(text);
      }
    }

    return this.normalizeText(chunks.join("\n\n"));
  }

  private formatReadableCommandOutputStatus(
    contract: CommandOutputContractV1,
  ): string {
    const executionLabel =
      contract.executionState === "outcome_unknown"
        ? "outcome unknown"
        : contract.executionState;
    const exitLabel =
      contract.executionState === "finished" &&
      typeof contract.exitCode === "number"
        ? String(contract.exitCode)
        : "not verified";
    const captureReason = contract.capture.reason
      ? `; reason: ${contract.capture.reason}`
      : "";
    const continuationLabel = contract.presentation.pollCursor
      ? "this is a running snapshot; poll the live session for newer output"
      : contract.presentation.hasMoreCapturedOutput
        ? contract.presentation.nextCursor
          ? "more retained output is available in the live session"
          : "more output was reported, but no continuation is available"
        : "no further retained output is advertised";
    const lines = [
      "Command result status:",
      `- Execution: ${executionLabel}`,
      `- Exit code: ${exitLabel}`,
      `- Capture: ${contract.capture.state}${captureReason}; observed ${contract.capture.observedUtf8Bytes} UTF-8 bytes, retained ${contract.capture.retainedUtf8Bytes}, ${contract.capture.availableLineCount} available lines`,
      `- Presentation: ${contract.presentation.state}; returned ${contract.presentation.returnedUtf8Bytes} UTF-8 bytes; ${continuationLabel}`,
    ];
    if (contract.capture.terminalControlsObserved) {
      lines.push(
        "- Terminal controls: observed and projected into the append-only transcript",
      );
    }
    return lines.join("\n");
  }

  private normalizeText(input: string): string {
    return String(input || "")
      .replace(/\r\n?/g, "\n")
      .trim();
  }
}
