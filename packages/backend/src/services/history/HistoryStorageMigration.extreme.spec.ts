import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryStorageMigration } from "./HistoryStorageMigration";
import { HistorySqliteStore } from "./HistorySqliteStore";

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const withTempDir = async (
  fn: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gyshell-history-extreme-"),
  );
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const run = async (): Promise<void> => {
  await runCase(
    "migration imports legacy backend and ui histories into sqlite and backs up json files",
    async () => {
      await withTempDir(async (dir) => {
        fs.writeFileSync(
          path.join(dir, "gyshell-chat-history.json"),
          JSON.stringify({
            sessions: [
              {
                id: "session-1",
                title: "Backend Title",
                messages: [
                  {
                    id: "message-1",
                    type: "human",
                    data: { content: "hello" },
                  },
                  {
                    id: "message-2",
                    type: "ai",
                    data: { content: "world" },
                  },
                ],
                lastCheckpointOffset: 7,
                lastProfileMaxTokens: 64000,
                createdAt: 111,
                updatedAt: 222,
              },
            ],
          }),
          "utf8",
        );
        fs.writeFileSync(
          path.join(dir, "gyshell-ui-history.json"),
          JSON.stringify({
            sessions: {
              "session-1": {
                id: "session-1",
                title: "This is a historical...",
                updatedAt: 333,
                messages: [
                  {
                    id: "ui-1",
                    backendMessageId: "message-1",
                    role: "user",
                    type: "text",
                    content: "This is a historical first prompt with details",
                    timestamp: 1001,
                  },
                  {
                    id: "ui-2",
                    backendMessageId: "message-2",
                    role: "assistant",
                    type: "text",
                    content: "world",
                    timestamp: 1002,
                  },
                ],
              },
            },
          }),
          "utf8",
        );

        const migration = new HistoryStorageMigration({
          baseDir: dir,
          chunkSize: 1,
        });
        const result = await migration.run();
        assertCondition(
          result.migrated,
          "migration should report migrated=true",
        );
        assertEqual(
          result.migratedChatSessions,
          1,
          "backend session count should match",
        );
        assertEqual(
          result.migratedUiSessions,
          1,
          "ui session count should match",
        );

        const store = new HistorySqliteStore({
          filePath: path.join(dir, "gyshell-history.sqlite"),
        });
        try {
          const chatSummary = store.listChatSessionSummaries()[0];
          const uiSummary = store.listUiSessionSummaries()[0];
          const chatSession = store.loadChatSession("session-1");
          const uiSession = store.loadUiSession("session-1");

          assertCondition(!!chatSummary, "chat summary should exist");
          assertCondition(!!uiSummary, "ui summary should exist");
          assertEqual(
            chatSummary.title,
            "Backend Title",
            "chat summary title should persist",
          );
          assertEqual(
            chatSummary.messagesCount,
            2,
            "chat summary message count should persist",
          );
          assertEqual(
            uiSummary.title,
            "This is a historical first prompt with details",
            "legacy truncated auto-title should expand during migration",
          );
          assertEqual(
            uiSummary.messagesCount,
            2,
            "ui summary message count should persist",
          );
          assertEqual(
            uiSummary.lastMessagePreview,
            "world",
            "ui summary preview should use the last visible message",
          );
          assertEqual(
            chatSession?.messages.length ?? 0,
            2,
            "chat messages should round-trip",
          );
          assertEqual(
            uiSession?.messages.length ?? 0,
            2,
            "ui messages should round-trip",
          );
        } finally {
          store.close();
        }

        const remainingJsonFiles = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith(".json"));
        assertCondition(
          remainingJsonFiles.some((name) =>
            name.startsWith("gyshell-chat-history.backup-"),
          ),
          "legacy backend json should be backed up after migration",
        );
        assertCondition(
          remainingJsonFiles.some((name) =>
            name.startsWith("gyshell-ui-history.backup-"),
          ),
          "legacy ui json should be backed up after migration",
        );
      });
    },
  );
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
