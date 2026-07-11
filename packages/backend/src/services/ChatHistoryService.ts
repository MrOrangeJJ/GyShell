import type { ChatSession } from "../types";
import type {
  ChatSessionSummaryRecord,
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

export class ChatHistoryService {
  private readonly store: HistorySqliteStore;

  constructor(options?: ChatHistoryServiceOptions) {
    this.store = options?.store || new HistorySqliteStore();
  }

  saveSession(session: ChatSession): void {
    const existing = this.store.loadChatSession(session.id);
    const now = Date.now();

    this.store.saveChatSession({
      id: session.id,
      title: existing ? existing.title : session.title,
      messages: Array.from(session.messages.entries()).map(([id, message]) => ({
        id,
        type: (message as any)._getType
          ? (message as any)._getType()
          : "unknown",
        data: message,
      })),
      lastCheckpointOffset: session.lastCheckpointOffset,
      lastProfileMaxTokens: session.lastProfileMaxTokens,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
  }

  loadSession(sessionId: string): ChatSession | null {
    const storedSession = this.store.loadChatSession(sessionId);
    if (!storedSession) {
      return null;
    }

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
