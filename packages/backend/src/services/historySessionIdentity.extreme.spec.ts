import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import { buildUiSessionSummary } from "./history/uiHistoryHelpers";
import type { StoredChatSessionRecord } from "./history/historyTypes";
import type { UIChatSession } from "../types/ui-chat";
import { UIHistoryService } from "./UIHistoryService";

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const withStore = async (
  fn: (store: HistorySqliteStore) => Promise<void> | void,
): Promise<void> => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gyshell-history-session-id-"),
  );
  const store = new HistorySqliteStore({
    filePath: path.join(directory, "history.sqlite"),
  });
  try {
    await fn(store);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const sessionIds = [
  " session ",
  "session",
  "Session",
  "session::part",
  "__proto__",
  "会话🙂",
] as const;

const createChatSession = (
  id: string,
  timestamp: number,
): StoredChatSessionRecord => ({
  id,
  title: `chat:${id}`,
  messages: [],
  lastCheckpointOffset: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const createUiSession = (id: string, timestamp: number): UIChatSession => ({
  id,
  title: `ui:${id}`,
  messages: [],
  updatedAt: timestamp,
  uiRevision: timestamp,
});

const sorted = (values: readonly string[]): string[] => [...values].sort();

await runCase(
  "SQLite preserves opaque session identities and deletes only exact selectors",
  async () => {
    await withStore((store) => {
      sessionIds.forEach((id, index) => {
        const timestamp = index + 1;
        store.saveChatSession(createChatSession(id, timestamp));
        const uiSession = createUiSession(id, timestamp);
        store.saveUiSessions([
          { session: uiSession, summary: buildUiSessionSummary(uiSession) },
        ]);
      });

      assert.deepEqual(
        sorted(store.listChatSessionSummaries().map((summary) => summary.id)),
        sorted(sessionIds),
      );
      assert.deepEqual(
        sorted(store.listUiSessionSummaries().map((summary) => summary.id)),
        sorted(sessionIds),
      );
      for (const id of sessionIds) {
        assert.equal(store.loadChatSession(id)?.id, id);
        assert.equal(store.loadUiSession(id)?.id, id);
      }

      store.deleteChatSessions([" session "]);
      store.deleteUiSessions(["__proto__"]);

      assert.equal(store.loadChatSession(" session "), null);
      assert.equal(store.loadChatSession("session")?.id, "session");
      assert.equal(store.loadChatSession("Session")?.id, "Session");
      assert.equal(store.loadUiSession("__proto__"), null);
      assert.equal(store.loadUiSession("session")?.id, "session");
      assert.equal(store.loadUiSession("session::part")?.id, "session::part");
    });
  },
);

await runCase(
  "SQLite batch deletion rejects malformed ids before any mutation",
  async () => {
    await withStore((store) => {
      for (const [index, id] of sessionIds.entries()) {
        const timestamp = index + 1;
        store.saveChatSession(createChatSession(id, timestamp));
        const uiSession = createUiSession(id, timestamp);
        store.saveUiSessions([
          { session: uiSession, summary: buildUiSessionSummary(uiSession) },
        ]);
      }

      assert.throws(
        () => store.deleteChatSessions(["session", "\ud800"]),
        /Session id is required/,
      );
      assert.throws(
        () => store.deleteUiSessions(["Session", 7 as unknown as string]),
        /Session id is required/,
      );

      assert.deepEqual(
        sorted(store.listChatSessionSummaries().map((summary) => summary.id)),
        sorted(sessionIds),
      );
      assert.deepEqual(
        sorted(store.listUiSessionSummaries().map((summary) => summary.id)),
        sorted(sessionIds),
      );
    });
  },
);

await runCase(
  "SQLite rejects malformed writes and mismatched UI summary identities",
  async () => {
    await withStore((store) => {
      assert.throws(
        () => store.saveChatSession(createChatSession("\ud800", 1)),
        /Session id is required/,
      );

      const valid = createUiSession(" valid ", 2);
      const malformed = createUiSession("\ud800", 3);
      assert.throws(
        () =>
          store.saveUiSessions([
            { session: valid, summary: buildUiSessionSummary(valid) },
            { session: malformed, summary: buildUiSessionSummary(malformed) },
          ]),
        /Session id is required/,
      );
      assert.equal(store.loadUiSession(" valid "), null);

      assert.throws(
        () =>
          store.saveUiSessions([
            {
              session: valid,
              summary: { ...buildUiSessionSummary(valid), id: "valid" },
            },
          ]),
        /summary id must match/,
      );
      assert.equal(store.loadUiSession(" valid "), null);
      assert.deepEqual(store.listChatSessionSummaries(), []);
      assert.deepEqual(store.listUiSessionSummaries(), []);
    });
  },
);

await runCase(
  "UI history caches prototype-shaped ids safely and rejects partial deletion",
  async () => {
    await withStore((store) => {
      for (const [index, id] of sessionIds.entries()) {
        const session = createUiSession(id, index + 1);
        store.saveUiSessions([
          { session, summary: buildUiSessionSummary(session) },
        ]);
      }
      const history = new UIHistoryService({ store });

      assert.equal(history.getSession("__proto__")?.id, "__proto__");
      assert.equal(history.getSession(" session ")?.id, " session ");
      assert.equal(history.getSession("session")?.id, "session");

      assert.throws(
        () =>
          history.deleteSessions([
            "Session",
            {} as unknown as string,
          ]),
        /Session id is required/,
      );
      assert.equal(history.getSession("Session")?.id, "Session");
      assert.equal(history.getSession("session")?.id, "session");

      history.deleteSession("__proto__");
      assert.equal(history.getSession("__proto__"), null);
      assert.equal(history.getSession("session::part")?.id, "session::part");
      assert.equal(history.getSession("会话🙂")?.id, "会话🙂");
    });
  },
);

console.log("__HISTORY_SESSION_ID_EXIT__=0");
