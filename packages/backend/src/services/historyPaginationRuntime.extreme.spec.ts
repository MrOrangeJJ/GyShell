import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatHistoryService } from "./ChatHistoryService";
import { TokenManager } from "./AgentHelper/TokenManager";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import { loadBetterSqlite3 } from "./history/betterSqlite3Runtime";
import { buildUiSessionSummary } from "./history/uiHistoryHelpers";
import type { ChatSession } from "../types";
import { UIHistoryService } from "./UIHistoryService";
import type { ChatMessage, UIChatSession } from "../types/ui-chat";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-history-page-"));
  const store = new HistorySqliteStore({
    filePath: path.join(dir, "history.sqlite"),
  });
  try {
    await fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const uiMessage = (index: number, content = `message-${index}`): ChatMessage => ({
  id: `ui-${index}`,
  backendMessageId: `backend-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  type: "text",
  content,
  timestamp: index + 1,
});

await runCase("UI cursor pages preserve order and bounded list payloads", async () => {
  await withStore((store) => {
    const messages = Array.from({ length: 2_400 }, (_, index) =>
      uiMessage(index, index === 1_777 ? "needle-" + "x".repeat(30_000) : `message-${index}`),
    );
    const session: UIChatSession = {
      id: "ui-page-session",
      title: "Paged session",
      updatedAt: Date.now(),
      messages,
    };
    store.saveUiSessions([{ session, summary: buildUiSessionSummary(session) }]);

    const tail = store.loadUiMessagePage("ui-page-session", { limit: 300 });
    assert.ok(tail);
    assert.equal(tail?.entries.length, 300);
    assert.equal(tail?.entries[0]?.position, 2_100);
    assert.equal(tail?.entries[299]?.position, 2_399);
    assert.equal(tail?.hasOlder, true);
    assert.equal(tail?.hasNewer, false);

    const older = store.loadUiMessagePage("ui-page-session", {
      beforePosition: 2_100,
      limit: 300,
    });
    assert.ok(older);
    assert.equal(older?.entries[0]?.position, 1_800);
    assert.equal(older?.entries[299]?.position, 2_099);

    const around = store.loadUiMessagePage("ui-page-session", {
      aroundPosition: 1_777,
      limit: 80,
    });
    assert.ok(around);
    assert.ok(around?.entries.some((entry) => entry.position === 1_777));
    const projected = around?.entries.find((entry) => entry.position === 1_777)?.message;
    assert.ok(projected?.deferredPayload?.fields.includes("content"));
    assert.ok((projected?.content.length || 0) <= 12_000);
    assert.equal(
      projected?.content.includes("Large historical payload"),
      false,
      "bounded history projections must not add a new visible omission label",
    );

    const full = store.loadUiMessagesByIds("ui-page-session", ["ui-1777"]);
    assert.equal(full.length, 1);
    assert.equal(full[0].content.length, 30_007);
  });
});

await runCase("server search returns positions without hydrating the transcript", async () => {
  await withStore((store) => {
    const messages = Array.from({ length: 1_200 }, (_, index) =>
      uiMessage(index, index % 101 === 0 ? `needle-${index}` : `value-${index}`),
    );
    const session: UIChatSession = {
      id: "ui-search-session",
      title: "Search session",
      updatedAt: Date.now(),
      messages,
    };
    store.saveUiSessions([{ session, summary: buildUiSessionSummary(session) }]);
    const result = store.searchUiMessages("ui-search-session", "needle", 5);
    assert.equal(result.matches.length, 5);
    assert.equal(result.totalMatches, 12);
    assert.equal(result.matches[0].position, 0);
    assert.equal(result.truncated, true);
  });
});

await runCase("runtime checkpoints retain raw history while loading a bounded marker tail", async () => {
  await withStore((store) => {
    const history = new ChatHistoryService({ store });
    const rawMessages: BaseMessage[] = [
      new HumanMessage({
        content: "system-like prefix",
        additional_kwargs: { _gyshellMessageId: "raw-system" },
      }),
      new HumanMessage({
        content: "old request",
        additional_kwargs: { _gyshellMessageId: "raw-old-user" },
      }),
      new ToolMessage({
        content: "orphan audit output",
        name: "exec_command",
        tool_call_id: "audit-call",
        additional_kwargs: { _gyshellMessageId: "raw-orphan-tool" },
      } as any),
      new HumanMessage({
        content: "WHAT_HAVE_DONE_IN_THE_PAST: prior work",
        additional_kwargs: {
          _gyshellMessageId: "raw-marker",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
        },
      }),
      new HumanMessage({
        content: "USER_REQUEST_IS: current request",
        additional_kwargs: { _gyshellMessageId: "raw-current-user" },
      }),
      new AIMessage({
        content: "current answer",
        additional_kwargs: { _gyshellMessageId: "raw-current-ai" },
      }),
    ];
    const rawSession: ChatSession = {
      id: "runtime-session",
      title: "Runtime session",
      messages: new Map(
        (mapChatMessagesToStoredMessages(rawMessages) as any[]).map((stored) => [
          String(stored.data.additional_kwargs._gyshellMessageId),
          stored,
        ]),
      ),
      lastCheckpointOffset: 0,
    };
    const runtimeMessages = rawMessages.slice(3);
    const runtimeSession: ChatSession = {
      ...rawSession,
      messages: new Map(
        (mapChatMessagesToStoredMessages(runtimeMessages) as any[]).map((stored) => [
          String(stored.data.additional_kwargs._gyshellMessageId),
          stored,
        ]),
      ),
    };

    history.saveRuntimeSession(runtimeSession, rawSession);
    const exported = history.exportSession("runtime-session");
    assert.equal(exported?.messages.length, rawMessages.length);
    assert.ok(exported?.messages.some((message) => message.id === "raw-orphan-tool"));

    const loadedRuntime = history.loadRuntimeSession("runtime-session");
    assert.ok(loadedRuntime);
    assert.deepEqual(
      [...(loadedRuntime?.messages.keys() || [])],
      ["raw-marker", "raw-current-user", "raw-current-ai"],
    );
  });
});

await runCase("runtime loading keeps full legacy history until the first marker", async () => {
  await withStore((store) => {
    const history = new ChatHistoryService({ store });
    const messages = Array.from({ length: 900 }, (_, index) => ({
      id: `legacy-${index}`,
      type: "human",
      data: {
        type: "human",
        data: {
          content: `legacy-message-${index}`,
          additional_kwargs: { _gyshellMessageId: `legacy-${index}` },
          response_metadata: {},
        },
      },
    }));
    store.saveChatSession({
      id: "legacy-uncompacted-runtime",
      title: "Legacy uncompacted runtime",
      messages,
      lastCheckpointOffset: 0,
      createdAt: 1,
      updatedAt: 2,
    });

    const loaded = history.loadRuntimeSession("legacy-uncompacted-runtime");
    assert.equal(loaded?.messages.size, messages.length);
    assert.equal(loaded?.messages.has("legacy-0"), true);
    assert.equal(loaded?.messages.has("legacy-899"), true);
  });
});

await runCase("incremental UI tail append is idempotent", async () => {
  await withStore((store) => {
    const initial: UIChatSession = {
      id: "ui-append-session",
      title: "Append session",
      updatedAt: 1,
      messages: Array.from({ length: 500 }, (_, index) => uiMessage(index)),
    };
    store.saveUiSessions([{ session: initial, summary: buildUiSessionSummary(initial) }]);
    const tail = {
      ...initial,
      updatedAt: 2,
      messages: [uiMessage(498, "updated-498"), uiMessage(499), uiMessage(500), uiMessage(501)],
    };
    const summary = {
      ...buildUiSessionSummary(tail),
      messagesCount: 502,
    };
    store.appendUiSessionTail(tail, summary, 498);
    store.appendUiSessionTail(tail, summary, 498);
    const page = store.loadUiMessagePage("ui-append-session", { limit: 20 });
    assert.equal(page?.totalCount, 502);
    assert.equal(page?.entries.length, 20);
    assert.equal(page?.entries[0]?.position, 482);
    assert.equal(store.loadUiSession("ui-append-session")?.messages.length, 502);
    assert.equal(
      store
        .loadUiMessagePage("ui-append-session", {
          aroundPosition: 498,
          limit: 5,
        })
        ?.entries.find((entry) => entry.position === 498)?.message.content,
      "updated-498",
    );
  });
});

await runCase("legacy UI schemas backfill a durable monotonic revision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-history-revision-"));
  const filePath = path.join(dir, "history.sqlite");
  const BetterSqlite3 = loadBetterSqlite3();
  const legacy = new BetterSqlite3(filePath);
  legacy.exec(`
    CREATE TABLE ui_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      messages_count INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO ui_sessions (
      id, title, updated_at, messages_count, last_message_preview
    ) VALUES ('legacy-revision', 'Legacy', 1, 0, '');
  `);
  legacy.close();

  const store = new HistorySqliteStore({ filePath });
  try {
    assert.equal(store.getUiSessionSummary("legacy-revision")?.uiRevision, 0);
    assert.equal(store.updateUiSessionRevision("legacy-revision", 41), true);
    assert.equal(store.getUiSessionSummary("legacy-revision")?.uiRevision, 41);
    store.updateUiSessionRevision("legacy-revision", 7);
    assert.equal(
      store.getUiSessionSummary("legacy-revision")?.uiRevision,
      41,
      "an old writer must not lower the durable revision",
    );
    assert.equal(store.getMaxUiRevision(), 41);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await runCase("paged snapshots carry revision and live transient approvals", async () => {
  await withStore((store) => {
    const history = new UIHistoryService({ store });
    history.recordEvent("revision-session", {
      type: "user_input",
      messageId: "revision-user",
      content: "revision baseline",
    } as any);
    history.noteUiRevision("revision-session", 51);
    const baseline = history.getMessagePage("revision-session", { limit: 20 });
    assert.equal(baseline?.uiRevision, 51);
    assert.equal(baseline?.entries.length, 1);

    history.recordEvent("revision-session", {
      type: "command_ask",
      messageId: "revision-ask-backend",
      approvalId: "revision-approval",
      command: "dangerous-command",
    } as any);
    history.noteUiRevision("revision-session", 52);
    const live = history.getMessagePage("revision-session", { limit: 20 });
    const ask = live?.entries.find((entry) => entry.message.type === "ask");
    assert.ok(ask, "a renderer reload must recover a live pending approval");
    assert.equal(live?.uiRevision, 52);
    assert.equal(live?.totalCount, 2);
    assert.equal(
      store.loadUiMessagePage("revision-session", { limit: 20 })?.totalCount,
      1,
      "transient approvals must never become durable transcript rows",
    );

    const full = history.getFullMessagesByIds("revision-session", [
      ask!.message.id,
    ]);
    assert.equal(full.uiRevision, 52);
    assert.equal(full.messages[0]?.metadata?.approvalId, "revision-approval");

    const restarted = new UIHistoryService({ store });
    assert.equal(restarted.getUiRevision("revision-session"), 52);
    assert.equal(
      restarted
        .getMessagePage("revision-session", { limit: 20 })
        ?.entries.some((entry) => entry.message.type === "ask"),
      false,
      "a process restart must not resurrect an approval with no live waiter",
    );
  });
});

await runCase("raw transcript anchor merges are ordered, idempotent, and atomic", async () => {
  await withStore((store) => {
    const storedMessage = (id: string, marker = false): any => ({
      id,
      type: "human",
      data: {
        type: "human",
        data: {
          content: id,
          additional_kwargs: {
            _gyshellMessageId: id,
            ...(marker ? { [TokenManager.LAST_COMPACTION_FLAG_KEY]: true } : {}),
          },
          response_metadata: {},
        },
      },
    });
    const record = (messages: any[], title = "Anchors") => ({
      id: "anchor-session",
      title,
      messages,
      lastCheckpointOffset: 0,
      createdAt: 1,
      updatedAt: 2,
    });

    store.saveChatSession(record([storedMessage("a"), storedMessage("legacy"), storedMessage("d")]));
    store.mergeChatSessionTranscript(
      record([
        storedMessage("x"),
        storedMessage("a"),
        storedMessage("b"),
        storedMessage("b"),
        storedMessage("c", true),
        storedMessage("d"),
        storedMessage("e"),
      ]),
    );
    assert.deepEqual(
      store.loadChatSession("anchor-session")?.messages.map((message) => message.id),
      ["x", "a", "legacy", "b", "c", "d", "e"],
      "front, middle, and tail inserts must preserve unmentioned raw history",
    );
    assert.equal(
      store.loadChatSessionHeader("anchor-session")?.runtimeMarkerMessageId,
      "c",
    );

    const beforeFailure = store
      .loadChatSession("anchor-session")!
      .messages.map((message) => message.id);
    const circular: any = { type: "human" };
    circular.self = circular;
    assert.throws(() => {
      store.mergeChatSessionTranscript(
        record([
          storedMessage("x"),
          storedMessage("a"),
          { id: "broken", type: "human", data: circular },
          storedMessage("b"),
        ], "Must Roll Back"),
      );
    });
    assert.deepEqual(
      store.loadChatSession("anchor-session")?.messages.map((message) => message.id),
      beforeFailure,
      "a serialization failure after position shifts must roll back the transaction",
    );
    assert.equal(store.loadChatSession("anchor-session")?.title, "Anchors");

    store.mergeChatSessionTranscript(
      record([storedMessage("x"), storedMessage("a"), storedMessage("b")]),
    );
    assert.deepEqual(
      store.loadChatSession("anchor-session")?.messages.map((message) => message.id),
      beforeFailure,
      "replaying an older bounded checkpoint must not delete raw tail history",
    );
  });
});

await runCase("legacy null compaction markers backfill on runtime load", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-marker-backfill-"));
  const filePath = path.join(dir, "history.sqlite");
  let store = new HistorySqliteStore({ filePath });
  const marker: any = {
    id: "legacy-marker",
    type: "human",
    data: {
      type: "human",
      data: {
        content: "summary",
        additional_kwargs: {
          _gyshellMessageId: "legacy-marker",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
        },
        response_metadata: {},
      },
    },
  };
  store.saveChatSession({
    id: "legacy-marker-session",
    title: "Marker",
    messages: [marker],
    lastCheckpointOffset: 0,
    createdAt: 1,
    updatedAt: 2,
  });
  store.close();

  const BetterSqlite3 = loadBetterSqlite3();
  const legacy = new BetterSqlite3(filePath);
  legacy
    .prepare(
      "UPDATE chat_session_messages SET is_compaction_marker = NULL WHERE session_id = ?",
    )
    .run("legacy-marker-session");
  legacy.close();

  store = new HistorySqliteStore({ filePath });
  try {
    const header = store.loadChatSessionHeader("legacy-marker-session");
    assert.equal(header?.runtimeStartPosition, 0);
    assert.equal(header?.runtimeMarkerMessageId, "legacy-marker");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("All history pagination/runtime extreme tests passed.");
