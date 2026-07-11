import {
  applyRenameToUnloadedSession,
  applyUiUpdate,
  applyUiUpdateToUnloadedSession,
  compactMessageSummary,
  createUnloadedRenamedSession,
  createSessionState,
  reorderSessionIdsByUpdatedAt,
} from "./state";
import { GatewayClient } from "./gateway-client";
import type { ChatMessage } from "./protocol";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

const makeTextMessage = (content: string): ChatMessage => ({
  id: "m1",
  role: "user",
  type: "text",
  content,
  timestamp: 1,
});

const makeStoredMessage = (
  id: string,
  backendMessageId: string,
  content: string,
): ChatMessage => ({
  id,
  role: "assistant",
  type: "text",
  content,
  timestamp: 1,
  backendMessageId,
});

runCase(
  "legacy paste label is not collapsed to preview text in TUI compact summaries",
  () => {
    const token = "[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]";
    const summary = compactMessageSummary(makeTextMessage(token), true);

    assertCondition(
      summary.includes("MENTION USER PASTE"),
      "TUI summary should keep the legacy paste marker text",
    );
    assertCondition(
      summary.includes("/tmp/paste.txt"),
      "TUI summary should keep the legacy paste path",
    );
    assertCondition(
      summary !== "preview",
      "TUI summary should not collapse to the old preview text",
    );
  },
);

runCase(
  "TUI supported mention compact summaries still use display names",
  () => {
    assertEqual(
      compactMessageSummary(
        makeTextMessage("[MENTION_TAB:#main##tab-1#]"),
        true,
      ),
      "@main",
      "tab mention should normalize",
    );
    assertEqual(
      compactMessageSummary(makeTextMessage("[MENTION_SKILL:#skill#]"), true),
      "@skill",
      "skill mention should normalize",
    );
    assertEqual(
      compactMessageSummary(
        makeTextMessage("[MENTION_FILE:#/tmp/report.md#]"),
        true,
      ),
      "report.md",
      "file mention should normalize",
    );
    assertEqual(
      compactMessageSummary(
        makeTextMessage("[MENTION_PASS_CHAT:#s1##Previous%20Chat#]"),
        true,
      ),
      "@Pass Chat: Previous Chat",
      "pass-chat mention should normalize",
    );
  },
);

runCase(
  "TUI INSERT_MESSAGE keeps compaction boundary markers anchored after previous messages",
  () => {
    const session = createSessionState("s1");
    const previous = makeStoredMessage(
      "assistant-1",
      "backend-assistant-1",
      "done",
    );
    const next = makeStoredMessage("assistant-2", "backend-assistant-2", "next");
    const boundary: ChatMessage = {
      id: "boundary-1",
      role: "system",
      type: "compaction_boundary",
      content: "stale content should be cleared",
      timestamp: 2,
      backendMessageId: "backend-boundary-1",
      streaming: true,
      metadata: {
        compactionBoundaryPreviousBackendMessageId: previous.backendMessageId,
        compactionBoundarySummaryBackendMessageId: "backend-summary-1",
      },
    };
    session.messages.push(previous, next);

    applyUiUpdate(session, {
      type: "INSERT_MESSAGE",
      sessionId: session.id,
      message: boundary,
      anchorBackendMessageId: previous.backendMessageId,
      placement: "after",
    });

    assertEqual(
      session.messages.map((message) => message.id).join(","),
      "assistant-1,boundary-1,assistant-2",
      "previous-anchor boundary should remain after its previous message",
    );
    assertEqual(
      compactMessageSummary(session.messages[1], true),
      "[CTX COMPACTED]",
      "TUI boundary summary should remain visible after normalization",
    );
    assertEqual(
      session.messages[1]?.streaming,
      false,
      "stored boundary marker must not stay streaming",
    );
  },
);

runCase("TUI SESSION_RENAMED updates the session title", () => {
  const session = createSessionState("s1", "New Chat");

  applyUiUpdate(session, {
    type: "SESSION_RENAMED",
    sessionId: session.id,
    title: "Renamed Chat",
  });
  applyUiUpdate(session, {
    type: "ADD_MESSAGE",
    sessionId: session.id,
    message: {
      id: "first-user-message",
      role: "user",
      type: "text",
      content: "first prompt",
      timestamp: 1,
    },
  });

  assertEqual(
    session.title,
    "Renamed Chat",
    "TUI clients should preserve a rename through the first prompt",
  );
});

runCase("TUI rename preserves unloaded summary metadata", () => {
  const session = createSessionState("lazy", "Old title");
  const meta = {
    id: session.id,
    title: "Old title",
    updatedAt: 10,
    messagesCount: 7,
    lastMessagePreview: "existing preview",
    loaded: false,
  };

  const handled = applyRenameToUnloadedSession(
    session,
    meta,
    "Renamed title",
    20,
  );

  assertEqual(handled, true, "unloaded summary rename should be specialized");
  assertEqual(session.title, "Renamed title", "placeholder title should update");
  assertEqual(meta.title, "Renamed title", "summary title should update");
  assertEqual(meta.updatedAt, 20, "summary timestamp should update");
  assertEqual(meta.loaded, false, "rename must preserve lazy loading state");
  assertEqual(meta.messagesCount, 7, "rename must preserve message count");
  assertEqual(
    meta.lastMessagePreview,
    "existing preview",
    "rename must preserve message preview",
  );
});

runCase("TUI live deltas preserve unloaded session placeholders", () => {
  const session = createSessionState("lazy-stream", "Existing chat");
  const meta = {
    title: session.title,
    updatedAt: 10,
    loaded: false,
    uiRevision: 5,
  };

  applyUiUpdateToUnloadedSession(
    session,
    meta,
    {
      type: "APPEND_CONTENT",
      sessionId: session.id,
      messageId: "not-loaded",
      content: "delta",
      uiRevision: 6,
    },
    20,
  );

  assertEqual(session.messages.length, 0, "lazy deltas must not create partial history");
  assertEqual(meta.loaded, false, "lazy deltas must not bypass session:get");
  assertEqual(meta.uiRevision, 6, "lazy metadata should advance its revision");
  assertEqual(session.isBusy, true, "lazy activity should still surface busy state");
});

runCase("TUI unknown rename creates an unloaded placeholder", () => {
  const created = createUnloadedRenamedSession(
    "remote-branch",
    "Remote branch",
    20,
  );

  assertEqual(
    created.session.title,
    "Remote branch",
    "placeholder should use rename",
  );
  assertEqual(created.meta.title, "Remote branch", "metadata should use rename");
  assertEqual(
    created.meta.loaded,
    false,
    "unknown renamed sessions must still load their backend snapshot",
  );
  assertEqual(
    created.meta.messagesCount,
    0,
    "unknown count should stay provisional",
  );
});

runCase("TUI rename ordering follows updatedAt", () => {
  const order = reorderSessionIdsByUpdatedAt(["old", "renamed"], {
    old: { updatedAt: 10 },
    renamed: { updatedAt: 20 },
  });
  assertEqual(
    order.join(","),
    "renamed,old",
    "renamed session should move to newest position",
  );
});

runCase("TUI gateway reconciles bootstrap updates at the snapshot boundary", () => {
  const client = new GatewayClient("ws://127.0.0.1:1");
  const messageEnvelope = Buffer.from(
    JSON.stringify({
      type: "gateway:ui-update",
      payload: {
        type: "ADD_MESSAGE",
        sessionId: "session-1",
        message: makeTextMessage("snapshot may already include this"),
        uiRevision: 4,
      },
    }),
  );
  const renameEnvelope = Buffer.from(
    JSON.stringify({
      type: "gateway:ui-update",
      payload: {
        type: "SESSION_RENAMED",
        sessionId: "session-1",
        title: "Renamed before mount",
        uiRevision: 5,
      },
    }),
  );
  (client as any).handleIncoming(messageEnvelope);
  (client as any).handleIncoming(renameEnvelope);
  client.discardBufferedUiUpdatesCoveredBySnapshot(5);
  (client as any).handleIncoming(
    Buffer.from(
      JSON.stringify({
        type: "gateway:ui-update",
        payload: {
          type: "ADD_MESSAGE",
          sessionId: "session-1",
          message: makeTextMessage("arrived after snapshot"),
          uiRevision: 6,
        },
      }),
    ),
  );
  (client as any).handleIncoming(
    Buffer.from(
      JSON.stringify({
        type: "gateway:ui-update",
        payload: {
          type: "SESSION_RENAMED",
          sessionId: "session-1",
          title: "Renamed after snapshot",
          uiRevision: 7,
        },
      }),
    ),
  );

  let receivedTitle = "";
  const receivedTypes: string[] = [];
  client.on("uiUpdate", (update) => {
    receivedTypes.push(update.type);
    if (update.type === "SESSION_RENAMED") {
      receivedTitle = update.title;
    }
  });

  assertEqual(
    receivedTitle,
    "Renamed after snapshot",
    "first listener should receive post-snapshot updates buffered before mount",
  );
  assertEqual(
    receivedTypes.join(","),
    "ADD_MESSAGE,SESSION_RENAMED",
    "pre-snapshot deltas should be dropped while post-snapshot deltas replay",
  );
});
