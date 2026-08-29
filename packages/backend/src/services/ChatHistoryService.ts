import type { ChatSession } from "../types";
import type {
  ChatSessionSummaryRecord,
  StoredChatMessageRecord,
  StoredChatSessionRecord,
} from "./history/historyTypes";
import { HistorySqliteStore } from "./history/HistorySqliteStore";

export type StoredChatSession = StoredChatSessionRecord;

export interface StoredChatHistory {
  sessions: StoredChatSession[];
}

interface ChatHistoryServiceOptions {
  store?: HistorySqliteStore;
}

const isCompactionMarker = (message: StoredChatMessageRecord): boolean =>
  message.data?.data?.additional_kwargs?.last_compaction === true ||
  message.data?.additional_kwargs?.last_compaction === true;

const isSystemMessage = (message: StoredChatMessageRecord): boolean =>
  message.data?.type === "system";

const buildRuntimeMessageWindow = (
  messages: StoredChatMessageRecord[],
): StoredChatMessageRecord[] => {
  let markerIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactionMarker(messages[index])) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) return messages;

  let leadingSystemCount = 0;
  while (
    leadingSystemCount < messages.length &&
    isSystemMessage(messages[leadingSystemCount])
  ) {
    leadingSystemCount += 1;
  }
  return [
    ...messages.slice(0, leadingSystemCount),
    ...messages.slice(Math.max(markerIndex, leadingSystemCount)),
  ];
};

export class ChatHistoryService {
  private readonly store: HistorySqliteStore;

  constructor(options?: ChatHistoryServiceOptions) {
    this.store = options?.store || new HistorySqliteStore();
  }

  /**
   * Authoritative replacement used by explicit history rewrites such as
   * rollback and branch creation.
   */
  saveSession(session: ChatSession): void {
    const header = this.store.loadChatSessionHeader(session.id);
    const now = Date.now();
    const messages = this.serializeSessionMessages(session);
    this.store.saveChatSession({
      id: session.id,
      title: header?.title || session.title,
      messages,
      lastCheckpointOffset: session.lastCheckpointOffset,
      lastProfileMaxTokens: session.lastProfileMaxTokens,
      createdAt: header?.createdAt || now,
      updatedAt: now,
    });
  }

  /**
   * Merge a bounded runtime checkpoint into the append-preserving transcript,
   * then replace only the small runtime context materialization.
   */
  saveRuntimeSession(session: ChatSession, rawSession?: ChatSession): void {
    const header = this.store.loadChatSessionHeader(session.id);
    const now = Date.now();
    const runtimeMessages = this.serializeSessionMessages(session);
    const rawMessages = rawSession
      ? this.serializeSessionMessages(rawSession)
      : runtimeMessages;
    const record: StoredChatSessionRecord = {
      id: session.id,
      title: header?.title || session.title,
      messages: runtimeMessages,
      lastCheckpointOffset:
        session.lastCheckpointOffset ?? header?.lastCheckpointOffset ?? 0,
      lastProfileMaxTokens:
        session.lastProfileMaxTokens ?? header?.lastProfileMaxTokens,
      createdAt: header?.createdAt || now,
      updatedAt: now,
    };
    const rawRecord = { ...record, messages: rawMessages };
    this.store.mergeChatSessionTranscript(rawRecord);
  }

  private serializeSessionMessages(
    session: ChatSession,
  ): StoredChatMessageRecord[] {
    return Array.from(session.messages.entries()).map(([id, message]) => ({
      id,
      type:
        typeof (message as any)._getType === "function"
          ? (message as any)._getType()
          : typeof (message as any).type === "string"
            ? (message as any).type
            : typeof (message as any).data?.type === "string"
              ? (message as any).data.type
              : "unknown",
      data: message,
    }));
  }

  loadSession(sessionId: string): ChatSession | null {
    const storedSession = this.store.loadChatSession(sessionId);
    return storedSession ? this.mapStoredSession(storedSession) : null;
  }

  loadRuntimeSession(sessionId: string): ChatSession | null {
    const header = this.store.loadChatSessionHeader(sessionId);
    if (!header) return null;

    let runtimeMessages: StoredChatMessageRecord[];
    if (
      typeof header.runtimeStartPosition === "number" &&
      header.runtimeMarkerMessageId
    ) {
      runtimeMessages = [
        ...this.store.loadLeadingChatSystemMessages(
          sessionId,
          header.runtimeStartPosition,
        ),
        ...this.store.loadChatSessionMessagesFromPosition(
          sessionId,
          header.runtimeStartPosition,
        ),
      ];
    } else {
      // A legacy transcript without a compaction marker has no safe runtime
      // boundary. Load it in full so TokenManager can perform the first
      // compaction without silently dropping early user or tool context.
      const storedSession = this.store.loadChatSession(sessionId);
      if (!storedSession) return null;
      runtimeMessages = storedSession.messages;
    }

    return this.mapStoredSession({
      id: header.id,
      title: header.title,
      messages: buildRuntimeMessageWindow(runtimeMessages),
      lastCheckpointOffset: header.lastCheckpointOffset,
      lastProfileMaxTokens: header.lastProfileMaxTokens,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
    });
  }

  private mapStoredSession(storedSession: StoredChatSessionRecord): ChatSession {
    const messages = new Map<string, any>();
    for (const message of storedSession.messages) {
      messages.set(message.id, message.data);
    }
    return {
      id: storedSession.id,
      title: storedSession.title,
      messages,
      lastCheckpointOffset: storedSession.lastCheckpointOffset,
      lastProfileMaxTokens: storedSession.lastProfileMaxTokens,
    };
  }

  getAllSessions(): StoredChatSession[] {
    return this.store.listChatSessions();
  }

  getAllSessionSummaries(): ChatSessionSummaryRecord[] {
    return this.store.listChatSessionSummaries();
  }

  getSessionSummary(sessionId: string): ChatSessionSummaryRecord | null {
    return this.store.loadChatSessionSummary(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.store.deleteChatSessions([sessionId]);
  }

  deleteSessions(sessionIds: string[]): void {
    this.store.deleteChatSessions(sessionIds);
  }

  clearAll(): void {
    this.store.clearChatSessions();
  }

  renameSession(sessionId: string, newTitle: string): void {
    this.store.renameChatSession(sessionId, newTitle, Date.now());
  }

  exportSession(sessionId: string): StoredChatSession | null {
    return this.store.loadChatSession(sessionId);
  }
}
