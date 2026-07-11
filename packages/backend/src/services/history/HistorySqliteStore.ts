import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, UIChatSession } from "../../types/ui-chat";
import type {
  ChatSessionSummaryRecord,
  StoredChatMessageRecord,
  StoredChatSessionRecord,
  UISessionSummaryRecord,
} from "./historyTypes";
import { openBetterSqlite3Database } from "./betterSqlite3Runtime";
import { resolveHistoryStoragePaths } from "./historyStoragePaths";

type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

interface HistorySqliteStoreOptions {
  filePath?: string;
}

interface ChatSessionRow {
  id: string;
  title: string;
  last_checkpoint_offset: number;
  last_profile_max_tokens: number | null;
  created_at: number;
  updated_at: number;
}

interface ChatSessionMessageRow {
  message_id: string;
  message_type: string;
  message_data_json: string;
}

interface UiSessionRow {
  id: string;
  title: string;
  updated_at: number;
  messages_count: number;
  last_message_preview: string;
}

interface UiSessionMessageRow {
  ui_message_id: string;
  backend_message_id: string | null;
  role: ChatMessage["role"];
  message_type: ChatMessage["type"];
  content: string;
  metadata_json: string | null;
  timestamp: number;
  streaming: number;
}

export class HistorySqliteStore {
  private readonly filePath: string;
  private readonly db: DatabaseHandle;

  constructor(options?: HistorySqliteStoreOptions) {
    this.filePath =
      options?.filePath || resolveHistoryStoragePaths().sqliteDbPath;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = openBetterSqlite3Database(this.filePath);
    HistorySqliteStore.initializeDatabase(this.db);
  }

  static initializeDatabase(db: DatabaseHandle): void {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma("cache_size = -32000");

    db.exec(`
      CREATE TABLE IF NOT EXISTS history_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        last_checkpoint_offset INTEGER NOT NULL DEFAULT 0,
        last_profile_max_tokens INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, position),
        UNIQUE (session_id, message_id),
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_session_messages_session_id
      ON chat_session_messages(session_id, position);

      CREATE TABLE IF NOT EXISTS ui_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        messages_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS ui_session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        ui_message_id TEXT NOT NULL,
        backend_message_id TEXT,
        role TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        timestamp INTEGER NOT NULL,
        streaming INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, position),
        UNIQUE (ui_message_id),
        FOREIGN KEY (session_id) REFERENCES ui_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ui_session_messages_session_id
      ON ui_session_messages(session_id, position);

      CREATE INDEX IF NOT EXISTS idx_ui_session_messages_backend_message
      ON ui_session_messages(session_id, backend_message_id);

      CREATE INDEX IF NOT EXISTS idx_ui_sessions_updated_at
      ON ui_sessions(updated_at DESC);
    `);
  }

  static hasInitializedStore(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const db = openBetterSqlite3Database(filePath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('history_meta', 'chat_sessions', 'ui_sessions')
           LIMIT 1`,
        )
        .get() as { name: string } | undefined;
      return Boolean(row?.name);
    } finally {
      db.close();
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM history_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO history_meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  loadChatSession(sessionId: string): StoredChatSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
         FROM chat_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as ChatSessionRow | undefined;
    if (!row) {
      return null;
    }

    const messageRows = this.db
      .prepare(
        `SELECT message_id, message_type, message_data_json
         FROM chat_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(sessionId) as ChatSessionMessageRow[];

    return {
      id: row.id,
      title: row.title,
      messages: messageRows.map<StoredChatMessageRecord>((message) => ({
        id: message.message_id,
        type: message.message_type,
        data: JSON.parse(message.message_data_json),
      })),
      lastCheckpointOffset: row.last_checkpoint_offset,
      lastProfileMaxTokens: row.last_profile_max_tokens ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listChatSessionSummaries(): ChatSessionSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT chat.id, chat.title, chat.updated_at, chat.created_at,
                chat.last_checkpoint_offset, chat.last_profile_max_tokens,
                COUNT(messages.message_id) AS messages_count
         FROM chat_sessions AS chat
         LEFT JOIN chat_session_messages AS messages
           ON messages.session_id = chat.id
         GROUP BY chat.id
         ORDER BY chat.updated_at DESC`,
      )
      .all() as Array<
      ChatSessionRow & {
        messages_count: number;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      messagesCount: row.messages_count,
      lastCheckpointOffset: row.last_checkpoint_offset,
      lastProfileMaxTokens: row.last_profile_max_tokens ?? undefined,
    }));
  }

  listChatSessions(): StoredChatSessionRecord[] {
    return this.listChatSessionSummaries()
      .map((summary) => this.loadChatSession(summary.id))
      .filter(
        (session): session is StoredChatSessionRecord => session !== null,
      );
  }

  saveChatSession(session: StoredChatSessionRecord): void {
    const existingCreatedAt = this.db
      .prepare("SELECT created_at FROM chat_sessions WHERE id = ?")
      .get(session.id) as { created_at: number } | undefined;
    const createdAt = existingCreatedAt?.created_at ?? session.createdAt;

    const upsertSession = this.db.prepare(
      `INSERT INTO chat_sessions (
         id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
       ) VALUES (
         @id, @title, @lastCheckpointOffset, @lastProfileMaxTokens, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         last_checkpoint_offset = excluded.last_checkpoint_offset,
         last_profile_max_tokens = excluded.last_profile_max_tokens,
         updated_at = excluded.updated_at`,
    );
    const deleteMessages = this.db.prepare(
      "DELETE FROM chat_session_messages WHERE session_id = ?",
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO chat_session_messages (
         session_id, position, message_id, message_type, message_data_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      upsertSession.run({
        id: session.id,
        title: session.title,
        lastCheckpointOffset: session.lastCheckpointOffset,
        lastProfileMaxTokens: session.lastProfileMaxTokens ?? null,
        createdAt,
        updatedAt: session.updatedAt,
      });
      deleteMessages.run(session.id);
      session.messages.forEach((message, index) => {
        insertMessage.run(
          session.id,
          index,
          message.id,
          message.type,
          JSON.stringify(message.data),
        );
      });
    })();
  }

  deleteChatSessions(sessionIds: string[]): void {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) return;
    const deleteSession = this.db.prepare(
      "DELETE FROM chat_sessions WHERE id = ?",
    );
    this.db.transaction(() => {
      ids.forEach((id) => deleteSession.run(id));
    })();
  }

  clearChatSessions(): void {
    this.db.prepare("DELETE FROM chat_sessions").run();
  }

  renameChatSession(
    sessionId: string,
    newTitle: string,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO chat_sessions (
           id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
         ) VALUES (?, ?, 0, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, newTitle, updatedAt, updatedAt);
  }

  loadUiSession(sessionId: string): UIChatSession | null {
    const row = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview
         FROM ui_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as UiSessionRow | undefined;
    if (!row) {
      return null;
    }

    const messageRows = this.db
      .prepare(
        `SELECT ui_message_id, backend_message_id, role, message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(sessionId) as UiSessionMessageRow[];

    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      messages: messageRows.map<ChatMessage>((message) => ({
        id: message.ui_message_id,
        backendMessageId: message.backend_message_id ?? undefined,
        role: message.role,
        type: message.message_type,
        content: message.content,
        metadata: message.metadata_json
          ? JSON.parse(message.metadata_json)
          : undefined,
        timestamp: message.timestamp,
        streaming: Boolean(message.streaming),
      })),
    };
  }

  listUiSessions(): UIChatSession[] {
    return this.listUiSessionSummaries()
      .map((summary) => this.loadUiSession(summary.id))
      .filter((session): session is UIChatSession => session !== null);
  }

  listUiSessionSummaries(): UISessionSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview
         FROM ui_sessions
         ORDER BY updated_at DESC`,
      )
      .all() as UiSessionRow[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      messagesCount: row.messages_count,
      lastMessagePreview: row.last_message_preview,
    }));
  }

  saveUiSessions(
    entries: Array<{ session: UIChatSession; summary: UISessionSummaryRecord }>,
  ): void {
    if (entries.length === 0) {
      return;
    }
    const upsertSession = this.db.prepare(
      `INSERT INTO ui_sessions (
         id, title, updated_at, messages_count, last_message_preview
       ) VALUES (
         @id, @title, @updatedAt, @messagesCount, @lastMessagePreview
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         messages_count = excluded.messages_count,
         last_message_preview = excluded.last_message_preview`,
    );
    const deleteMessages = this.db.prepare(
      "DELETE FROM ui_session_messages WHERE session_id = ?",
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role, message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      entries.forEach(({ session, summary }) => {
        upsertSession.run({
          id: session.id,
          title: summary.title,
          updatedAt: summary.updatedAt,
          messagesCount: summary.messagesCount,
          lastMessagePreview: summary.lastMessagePreview,
        });
        deleteMessages.run(session.id);
        session.messages.forEach((message, index) => {
          insertMessage.run(
            session.id,
            index,
            message.id,
            message.backendMessageId ?? null,
            message.role,
            message.type,
            message.content,
            message.metadata ? JSON.stringify(message.metadata) : null,
            message.timestamp,
            message.streaming ? 1 : 0,
          );
        });
      });
    })();
  }

  deleteUiSessions(sessionIds: string[]): void {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) return;
    const deleteSession = this.db.prepare(
      "DELETE FROM ui_sessions WHERE id = ?",
    );
    this.db.transaction(() => {
      ids.forEach((id) => deleteSession.run(id));
    })();
  }

  renameUiSession(
    sessionId: string,
    newTitle: string,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `UPDATE ui_sessions
         SET title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newTitle, updatedAt, sessionId);
  }
}
