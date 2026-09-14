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

  await runCase(
    "existing sqlite history repair removes duplicate read_file image supplements and is idempotent",
    async () => {
      await withTempDir(async (dir) => {
        const sqlitePath = path.join(dir, "gyshell-history.sqlite");
        const createImageContent = (url: string) => [
          {
            type: "text",
            text: "This is the image of the file that was read. Please Continue.",
          },
          {
            type: "image_url",
            image_url: { url },
          },
        ];
        const imageA = createImageContent("data:image/png;base64,AA==");
        const imageB = createImageContent("data:image/png;base64,BB==");
        const store = new HistorySqliteStore({ filePath: sqlitePath });
        store.saveChatSession({
          id: "duplicate-session",
          title: "Duplicate image session",
          messages: [
            { id: "system", type: "system", data: { content: "system" } },
            {
              id: "tool-a",
              type: "tool",
              data: {
                content: "Image read successfully.",
                name: "read_file",
              },
            },
            {
              id: "tool-b",
              type: "tool",
              data: {
                content: "Image read successfully.",
                name: "read_file",
              },
            },
            { id: "bridge-1", type: "ai", data: { content: "let me see" } },
            { id: "image-1", type: "human", data: { content: imageA } },
            { id: "bridge-2", type: "ai", data: { content: "let me see" } },
            { id: "image-2", type: "human", data: { content: imageA } },
            { id: "bridge-3", type: "ai", data: { content: "let me see" } },
            { id: "image-3", type: "human", data: { content: imageA } },
            { id: "bridge-4", type: "ai", data: { content: "let me see" } },
            { id: "image-4", type: "human", data: { content: imageB } },
            { id: "bridge-5", type: "ai", data: { content: "let me see" } },
            { id: "image-5", type: "human", data: { content: imageB } },
            { id: "bridge-6", type: "ai", data: { content: "let me see" } },
            { id: "image-6", type: "human", data: { content: imageB } },
            { id: "assistant", type: "ai", data: { content: "done" } },
          ],
          lastCheckpointOffset: 0,
          createdAt: 1,
          updatedAt: 1,
        });
        store.saveChatSession({
          id: "legitimate-same-image-wave",
          title: "Legitimate repeated reads",
          messages: [
            { id: "tool-a", type: "tool", data: { content: "Image read successfully.", name: "read_file" } },
            { id: "tool-b", type: "tool", data: { content: "Image read successfully.", name: "read_file" } },
            { id: "bridge-a", type: "ai", data: { content: "let me see" } },
            { id: "image-a", type: "human", data: { content: imageA } },
            { id: "bridge-b", type: "ai", data: { content: "let me see" } },
            { id: "image-b", type: "human", data: { content: imageA } },
          ],
          lastCheckpointOffset: 0,
          createdAt: 1,
          updatedAt: 1,
        });
        store.close();

        const migration = new HistoryStorageMigration({ baseDir: dir });
        await migration.run();

        const repairedStore = new HistorySqliteStore({ filePath: sqlitePath });
        try {
          const repaired = repairedStore.loadChatSession("duplicate-session");
          assertEqual(
            repaired?.messages.length ?? 0,
            8,
            "repair should keep tools, one image wave, and final assistant message",
          );
          const repairedMessages = repaired?.messages || [];
          assertEqual(
            repairedMessages[3]?.data.additional_kwargs?._gyshellMessageId,
            "bridge-1",
            "retained bridge should receive its existing durable row id",
          );
          assertEqual(
            repairedMessages[4]?.data.additional_kwargs?._gyshellMessageId,
            "image-1",
            "retained image should receive its existing durable row id",
          );
        } finally {
          repairedStore.close();
        }

        await migration.run();
        const secondStore = new HistorySqliteStore({ filePath: sqlitePath });
        try {
            assertEqual(
            secondStore.loadChatSession("duplicate-session")?.messages.length ??
              0,
            8,
            "a second migration run must not alter repaired history",
          );
          assertEqual(
            secondStore.loadChatSession("legitimate-same-image-wave")?.messages.length ??
              0,
            6,
            "a non-block repeated wave must not be deduplicated",
          );
        } finally {
          secondStore.close();
        }
        const negativeControlStore = new HistorySqliteStore({ filePath: sqlitePath });
        try {
          assertEqual(
            negativeControlStore.loadChatSession("legitimate-same-image-wave")?.messages.length ?? 0,
            6,
            "two distinct read_file calls with the same image must not be deduplicated",
          );
        } finally {
          negativeControlStore.close();
        }
      });
    },
  );

  await runCase(
    "existing sqlite repair failures publish an error state",
    async () => {
      await withTempDir(async (dir) => {
        fs.writeFileSync(path.join(dir, "gyshell-history.sqlite"), "not sqlite");
        const migration = new HistoryStorageMigration({ baseDir: dir });
        let failed = false;
        try {
          await migration.run();
        } catch {
          failed = true;
        }
        assertCondition(failed, "corrupt sqlite should reject migration");
        assertEqual(
          migration.getState().status,
          "error",
          "corrupt sqlite should publish an error state",
        );
        assertEqual(
          migration.getState().phase,
          "error",
          "corrupt sqlite should finish in the error phase",
        );
      });
    },
  );
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
