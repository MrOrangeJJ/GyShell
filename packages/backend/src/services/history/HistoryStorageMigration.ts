import fs from "node:fs";
import path from "node:path";
import { setImmediate as setImmediateAsync } from "node:timers/promises";
import type { UIChatSession } from "../../types/ui-chat";
import type { StoredChatSessionRecord } from "./historyTypes";
import {
  LEGACY_CHAT_HISTORY_FILE_NAME,
  LEGACY_UI_HISTORY_FILE_NAME,
  resolveHistoryStoragePaths,
} from "./historyStoragePaths";
import { buildUiSessionSummary, sanitizeUiSession } from "./uiHistoryHelpers";

type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

interface LegacyChatHistoryFile {
  sessions?: StoredChatSessionRecord[];
}

interface LegacyUiHistoryFile {
  sessions?: Record<string, UIChatSession>;
}

export interface HistoryMigrationState {
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

export interface HistoryMigrationResult {
  migrated: boolean;
  detectedLegacy: boolean;
  sqliteDbPath: string;
  migratedChatSessions: number;
  migratedUiSessions: number;
}

interface HistoryStorageMigrationOptions {
  baseDir?: string;
  chunkSize?: number;
  onStateChange?: (state: HistoryMigrationState) => void;
}

const INITIAL_STATE: HistoryMigrationState = {
  status: "idle",
  ready: false,
  active: false,
  blocking: false,
  detectedLegacy: false,
  phase: "idle",
  title: "Preparing history storage",
  message: "Checking stored conversations.",
  completedUnits: 0,
  totalUnits: 0,
  percent: 0,
};

export class HistoryStorageMigration {
  private readonly baseDir?: string;
  private readonly chunkSize: number;
  private readonly onStateChange?: (state: HistoryMigrationState) => void;
  private state: HistoryMigrationState = INITIAL_STATE;

  constructor(options?: HistoryStorageMigrationOptions) {
    this.baseDir = options?.baseDir;
    this.chunkSize = Math.max(1, options?.chunkSize ?? 24);
    this.onStateChange = options?.onStateChange;
  }

  getState(): HistoryMigrationState {
    return { ...this.state };
  }

  async run(): Promise<HistoryMigrationResult> {
    const paths = resolveHistoryStoragePaths(this.baseDir);
    this.emitState({
      status: "running",
      ready: false,
      active: false,
      blocking: false,
      detectedLegacy: false,
      phase: "detecting",
      title: "Preparing history storage",
      message: "Checking stored conversations.",
      completedUnits: 0,
      totalUnits: 0,
      percent: 0,
    });

    // Fast path: check for legacy JSON files using fs only (no SQLite needed).
    // This ensures fresh installs never load the native SQLite module during migration,
    // which prevents startup crashes when the native binary is unavailable.
    const legacyChatExists = fs.existsSync(paths.legacyChatHistoryPath);
    const legacyUiExists = fs.existsSync(paths.legacyUiHistoryPath);

    if (!legacyChatExists && !legacyUiExists) {
      this.emitReady("History storage is ready.");
      return {
        migrated: false,
        detectedLegacy: false,
        sqliteDbPath: paths.sqliteDbPath,
        migratedChatSessions: 0,
        migratedUiSessions: 0,
      };
    }

    // SQLite DB already exists — legacy files are leftover backups or stale copies.
    if (fs.existsSync(paths.sqliteDbPath)) {
      this.emitReady("History storage is ready.");
      return {
        migrated: false,
        detectedLegacy: false,
        sqliteDbPath: paths.sqliteDbPath,
        migratedChatSessions: 0,
        migratedUiSessions: 0,
      };
    }

    this.emitState({
      status: "running",
      ready: false,
      active: true,
      blocking: true,
      detectedLegacy: true,
      phase: "reading",
      title: "Migrating conversation history",
      message: `Detected legacy chat history files (${LEGACY_CHAT_HISTORY_FILE_NAME}, ${LEGACY_UI_HISTORY_FILE_NAME}). Reading stored data.`,
      completedUnits: 0,
      totalUnits: 1,
      percent: 0,
    });

    try {
      const legacyChat = this.readLegacyJson<LegacyChatHistoryFile>(
        paths.legacyChatHistoryPath,
      );
      const legacyUi = this.readLegacyJson<LegacyUiHistoryFile>(
        paths.legacyUiHistoryPath,
      );
      const chatSessions = Array.isArray(legacyChat?.sessions)
        ? legacyChat.sessions
        : [];
      const uiSessions = Object.values(legacyUi?.sessions || {});
      const tempDbPath = `${paths.sqliteDbPath}.migrating`;

      const totalUnits = this.calculateTotalUnits(chatSessions, uiSessions);
      let completedUnits = 0;
      const advance = (
        delta: number,
        message: string,
        phase: HistoryMigrationState["phase"],
      ) => {
        completedUnits += delta;
        this.emitProgress({
          phase,
          message,
          completedUnits,
          totalUnits,
        });
      };

      this.emitProgress({
        phase: "migrating-backend",
        message: `Migrating ${chatSessions.length} backend conversation sessions.`,
        completedUnits,
        totalUnits,
      });

      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }

      // Lazy-load SQLite only when migration is actually needed.
      const { openBetterSqlite3Database } = await import(
        "./betterSqlite3Runtime"
      );
      const { HistorySqliteStore } = await import("./HistorySqliteStore");
      const db: DatabaseHandle = openBetterSqlite3Database(tempDbPath);
      try {
        HistorySqliteStore.initializeDatabase(db);
        await this.importChatSessions(db, chatSessions, advance);
        this.emitProgress({
          phase: "migrating-ui",
          message: `Migrating ${uiSessions.length} UI conversation sessions.`,
          completedUnits,
          totalUnits,
        });
        await this.importUiSessions(db, uiSessions, advance);
        this.emitProgress({
          phase: "finalizing",
          message: "Finalizing migrated history storage.",
          completedUnits,
          totalUnits,
        });
        db.prepare(
          `INSERT INTO history_meta (key, value)
           VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run("history_schema_version", "1");
        db.prepare(
          `INSERT INTO history_meta (key, value)
           VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run("storage_format", "sqlite");
        db.prepare(
          `INSERT INTO history_meta (key, value)
           VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run("legacy_json_migrated_at", String(Date.now()));
      } finally {
        db.close();
      }

      if (fs.existsSync(paths.sqliteDbPath)) {
        fs.unlinkSync(paths.sqliteDbPath);
      }
      fs.renameSync(tempDbPath, paths.sqliteDbPath);
      this.backupAndCleanupLegacy(paths.legacyChatHistoryPath);
      this.backupAndCleanupLegacy(paths.legacyUiHistoryPath);
      this.emitReady("Conversation history migration finished.");
      return {
        migrated: true,
        detectedLegacy: true,
        sqliteDbPath: paths.sqliteDbPath,
        migratedChatSessions: chatSessions.length,
        migratedUiSessions: uiSessions.length,
      };
    } catch (error) {
      const tempDbPath = `${paths.sqliteDbPath}.migrating`;
      if (fs.existsSync(tempDbPath)) {
        try {
          fs.unlinkSync(tempDbPath);
        } catch {
          // Ignore temp file cleanup failures and surface the migration error instead.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.emitState({
        status: "error",
        ready: false,
        active: false,
        blocking: true,
        detectedLegacy: true,
        phase: "error",
        title: "Conversation history migration failed",
        message: "The legacy chat history could not be migrated automatically.",
        completedUnits: this.state.completedUnits,
        totalUnits: this.state.totalUnits,
        percent: this.state.percent,
        error: message,
      });
      throw error;
    }
  }

  private calculateTotalUnits(
    chatSessions: StoredChatSessionRecord[],
    uiSessions: UIChatSession[],
  ): number {
    const chatMessageCount = chatSessions.reduce(
      (sum, session) => sum + session.messages.length,
      0,
    );
    const uiMessageCount = uiSessions.reduce(
      (sum, session) => sum + session.messages.length,
      0,
    );
    return Math.max(
      1,
      3 +
        chatSessions.length +
        chatMessageCount +
        uiSessions.length +
        uiMessageCount,
    );
  }

  private emitProgress(params: {
    phase: HistoryMigrationState["phase"];
    message: string;
    completedUnits: number;
    totalUnits: number;
  }): void {
    const percent =
      params.totalUnits > 0
        ? Math.max(
            0,
            Math.min(
              100,
              Math.round((params.completedUnits / params.totalUnits) * 100),
            ),
          )
        : 0;
    this.emitState({
      status: "running",
      ready: false,
      active: true,
      blocking: true,
      detectedLegacy: true,
      phase: params.phase,
      title: "Migrating conversation history",
      message: params.message,
      completedUnits: params.completedUnits,
      totalUnits: params.totalUnits,
      percent,
    });
  }

  private emitReady(message: string): void {
    this.emitState({
      status: "done",
      ready: true,
      active: false,
      blocking: false,
      detectedLegacy: this.state.detectedLegacy,
      phase: "done",
      title: "History storage ready",
      message,
      completedUnits: this.state.totalUnits,
      totalUnits: this.state.totalUnits,
      percent: this.state.totalUnits > 0 ? 100 : this.state.percent,
    });
  }

  private emitState(nextState: HistoryMigrationState): void {
    this.state = nextState;
    this.onStateChange?.(this.getState());
  }

  private readLegacyJson<T>(filePath: string): T | undefined {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const text = fs.readFileSync(filePath, "utf8").trim();
    if (!text) {
      return undefined;
    }
    return JSON.parse(text) as T;
  }

  private async importChatSessions(
    db: DatabaseHandle,
    sessions: StoredChatSessionRecord[],
    advance: (
      delta: number,
      message: string,
      phase: HistoryMigrationState["phase"],
    ) => void,
  ): Promise<void> {
    if (sessions.length === 0) {
      advance(
        1,
        "No backend conversation sessions required migration.",
        "migrating-backend",
      );
      return;
    }

    const upsertSession = db.prepare(
      `INSERT INTO chat_sessions (
         id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
       ) VALUES (
         @id, @title, @lastCheckpointOffset, @lastProfileMaxTokens, @createdAt, @updatedAt
       )`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO chat_session_messages (
         session_id, position, message_id, message_type, message_data_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const importBatch = db.transaction((batch: StoredChatSessionRecord[]) => {
      batch.forEach((session) => {
        upsertSession.run({
          id: session.id,
          title: session.title,
          lastCheckpointOffset: session.lastCheckpointOffset,
          lastProfileMaxTokens: session.lastProfileMaxTokens ?? null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        });
        session.messages.forEach((message, index) => {
          insertMessage.run(
            session.id,
            index,
            message.id,
            message.type,
            JSON.stringify(message.data),
          );
        });
      });
    });

    for (let index = 0; index < sessions.length; index += this.chunkSize) {
      const batch = sessions.slice(index, index + this.chunkSize);
      importBatch(batch);
      const unitDelta = batch.reduce(
        (sum, session) => sum + 1 + session.messages.length,
        0,
      );
      advance(
        unitDelta,
        `Migrated ${Math.min(index + batch.length, sessions.length)} of ${sessions.length} backend conversation sessions.`,
        "migrating-backend",
      );
      await setImmediateAsync();
    }
  }

  private async importUiSessions(
    db: DatabaseHandle,
    sessions: UIChatSession[],
    advance: (
      delta: number,
      message: string,
      phase: HistoryMigrationState["phase"],
    ) => void,
  ): Promise<void> {
    if (sessions.length === 0) {
      advance(
        1,
        "No UI conversation sessions required migration.",
        "migrating-ui",
      );
      return;
    }

    const upsertSession = db.prepare(
      `INSERT INTO ui_sessions (
         id, title, updated_at, messages_count, last_message_preview
       ) VALUES (
         @id, @title, @updatedAt, @messagesCount, @lastMessagePreview
       )`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role, message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const importBatch = db.transaction((batch: UIChatSession[]) => {
      batch.forEach((rawSession) => {
        const session = sanitizeUiSession(rawSession, {
          restoreLegacyAutoTitle: true,
        });
        const summary = buildUiSessionSummary(session);
        upsertSession.run(summary);
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
    });

    for (let index = 0; index < sessions.length; index += this.chunkSize) {
      const batch = sessions.slice(index, index + this.chunkSize);
      importBatch(batch);
      const unitDelta = batch.reduce(
        (sum, session) => sum + 1 + session.messages.length,
        0,
      );
      advance(
        unitDelta,
        `Migrated ${Math.min(index + batch.length, sessions.length)} of ${sessions.length} UI conversation sessions.`,
        "migrating-ui",
      );
      await setImmediateAsync();
    }
  }

  private backupAndCleanupLegacy(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const backupPath = this.buildBackupPath(filePath);
    fs.renameSync(filePath, backupPath);
  }

  private buildBackupPath(filePath: string): string {
    const ext = path.extname(filePath);
    const base = filePath.slice(0, filePath.length - ext.length);
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let candidate = `${base}.backup-${stamp}${ext}`;
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = `${base}.backup-${stamp}-${suffix}${ext}`;
      suffix += 1;
    }
    return candidate;
  }
}
