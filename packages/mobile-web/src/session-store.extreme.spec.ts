import {
  applyRenameToUnloadedSession,
  applyUiUpdate,
  applyUiUpdateToUnloadedSession,
  autoTitle,
  createUnloadedRenamedSession,
  createSessionState,
  normalizeSessionPreview,
  normalizeDisplayText,
  previewFromSession,
  UiUpdateBootstrapBuffer,
} from "./session-store";
import type { ChatMessage } from "./types";

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

const makeMessage = (content: string): ChatMessage => ({
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
  "legacy paste label stays literal in mobile display normalization",
  () => {
    const token = "[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]";
    assertEqual(
      normalizeDisplayText(token),
      token,
      "legacy paste token should not collapse to preview",
    );
    assertEqual(
      autoTitle(token),
      token,
      "mobile auto title should keep short legacy paste token literal",
    );
  },
);

runCase(
  "mobile session preview does not collapse legacy paste label to preview",
  () => {
    const token = "[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]";
    const session = createSessionState("s1");
    session.messages.push(makeMessage(token));

    const preview = previewFromSession(session);
    assertEqual(
      preview,
      token,
      "mobile preview should keep legacy paste token literal",
    );
    assertCondition(
      preview !== "preview",
      "mobile preview should not use the old paste preview label",
    );
  },
);

runCase("mobile session preview unwraps typed command output", () => {
  const session = createSessionState("typed-command-preview");
  const contract = {
    contractVersion: 1 as const,
    terminalId: "terminal-1",
    historyCommandMatchId: "command-1",
    executionState: "finished" as const,
    exitCode: 0,
    capture: {
      state: "complete" as const,
      observedUtf8Bytes: 11,
      retainedUtf8Bytes: 11,
      availableLineCount: 1,
      revision: 1,
      terminalControlsObserved: false,
    },
    presentation: {
      state: "full" as const,
      returnedUtf8Bytes: 11,
      hasMoreCapturedOutput: false,
    },
  };
  session.messages.push({
    id: "typed-command-message",
    role: "assistant",
    type: "command",
    content: "printf preview",
    timestamp: 1,
    metadata: {
      output: [
        "<gyshell_command_result>",
        JSON.stringify(contract),
        "</gyshell_command_result>",
        "<terminal_content>",
        "human text",
        "</terminal_content>",
      ].join("\n"),
    },
  });

  const preview = previewFromSession(session);
  assertEqual(preview, "human text", "session rows should show terminal text");
  assertCondition(
    !preview.includes("gyshell_command_result"),
    "session rows must decode the envelope even when duplicate UI metadata is absent",
  );
  assertEqual(
    normalizeSessionPreview(session.messages[0]?.metadata?.output || ""),
    "human text",
    "unloaded remote summaries should use the same envelope decoding as loaded sessions",
  );
});

runCase(
  "mobile supported mention normalization still renders compact display names",
  () => {
    assertEqual(
      normalizeDisplayText("[MENTION_TAB:#main##tab-1#]"),
      "@main",
      "tab mention should normalize",
    );
    assertEqual(
      normalizeDisplayText("[MENTION_SKILL:#skill#]"),
      "@skill",
      "skill mention should normalize",
    );
    assertEqual(
      normalizeDisplayText("[MENTION_FILE:#/tmp/report.md#]"),
      "report.md",
      "file mention should normalize",
    );
    assertEqual(
      normalizeDisplayText("[MENTION_IMAGE:#/tmp/screenshot.png##Screenshot#]"),
      "Screenshot",
      "image mention should normalize",
    );
    assertEqual(
      normalizeDisplayText("[MENTION_PASS_CHAT:#s1##Previous%20Chat#]"),
      "@Pass Chat: Previous Chat",
      "pass-chat mention should normalize",
    );
  },
);

runCase(
  "mobile INSERT_MESSAGE keeps compaction boundary markers anchored after previous messages",
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
      session.messages[1]?.content,
      "",
      "stored boundary marker content should be display-neutral",
    );
    assertEqual(
      session.messages[1]?.streaming,
      false,
      "stored boundary marker must not stay streaming",
    );
  },
);

runCase("mobile SESSION_RENAMED updates the session title", () => {
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
    "mobile clients should preserve a rename through the first prompt",
  );
});

runCase("mobile loaded-session updates have one authoritative busy transition", () => {
  const session = createSessionState("mobile-loaded-busy");
  applyUiUpdate(session, {
    type: "ADD_MESSAGE",
    sessionId: session.id,
    message: {
      id: "assistant-activity",
      role: "assistant",
      type: "reasoning",
      content: "working",
      timestamp: 1,
      streaming: true,
    },
  });
  assertEqual(
    session.isBusy,
    true,
    "assistant activity should mark a loaded session busy without a controller pre-pass",
  );

  applyUiUpdate(session, { type: "SESSION_READY", sessionId: session.id });
  applyUiUpdate(session, {
    type: "ADD_MESSAGE",
    sessionId: session.id,
    message: {
      id: "token-count",
      role: "assistant",
      type: "tokens_count",
      content: "",
      timestamp: 2,
    },
  });
  assertEqual(
    session.isBusy,
    false,
    "trailing token accounting must not reopen a ready session",
  );
});

runCase("mobile late nowait completion does not reopen a ready session", () => {
  const session = createSessionState("mobile-nowait-ready");
  const finishedContract = {
    contractVersion: 1 as const,
    terminalId: "terminal-1",
    historyCommandMatchId: "history-1",
    executionState: "finished" as const,
    exitCode: 0,
    capture: {
      state: "complete" as const,
      observedUtf8Bytes: 0,
      retainedUtf8Bytes: 0,
      availableLineCount: 0,
      revision: 1,
      terminalControlsObserved: false,
    },
    presentation: {
      state: "none" as const,
      returnedUtf8Bytes: 0,
      hasMoreCapturedOutput: false,
    },
  };
  const runningContract = {
    ...finishedContract,
    executionState: "running" as const,
    exitCode: null,
    capture: {
      ...finishedContract.capture,
      state: "in_progress" as const,
    },
    presentation: {
      ...finishedContract.presentation,
      pollCursor: "mobile-running-poll",
    },
  };
  session.messages.push({
    id: "nowait-command",
    role: "assistant",
    type: "command",
    content: "true",
    timestamp: 1,
    streaming: false,
  });
  applyUiUpdate(session, {
    type: "SESSION_READY",
    sessionId: session.id,
  });
  applyUiUpdate(session, {
    type: "UPDATE_MESSAGE",
    sessionId: session.id,
    messageId: "nowait-command",
    patch: {
      streaming: false,
      metadata: { output: "", commandOutput: runningContract },
    },
  });
  assertEqual(
    session.isBusy,
    false,
    "a late running handoff after SESSION_READY is background lifecycle state, not a new agent run",
  );
  applyUiUpdate(session, {
    type: "UPDATE_MESSAGE",
    sessionId: session.id,
    messageId: "nowait-command",
    patch: {
      streaming: false,
      metadata: { output: "", commandOutput: finishedContract },
    },
  });

  assertEqual(
    session.isBusy,
    false,
    "a settled background command update after SESSION_READY must stay idle",
  );
  assertEqual(
    session.messages[0]?.metadata?.commandOutput?.executionState,
    "finished",
    "the late completion must still update the visible command contract",
  );

  const unloaded = createSessionState("mobile-nowait-unloaded");
  const unloadedMeta = {
    id: unloaded.id,
    title: unloaded.title,
    updatedAt: 1,
    messagesCount: 1,
    loaded: false,
  };
  applyUiUpdateToUnloadedSession(
    unloaded,
    unloadedMeta,
    {
      type: "UPDATE_MESSAGE",
      sessionId: unloaded.id,
      messageId: "nowait-command",
      patch: {
        streaming: false,
        metadata: { output: "", commandOutput: runningContract },
      },
    },
    2,
  );
  assertEqual(
    unloaded.isBusy,
    false,
    "an unloaded ready session must ignore a late running handoff for admission state",
  );
  applyUiUpdateToUnloadedSession(
    unloaded,
    unloadedMeta,
    {
      type: "UPDATE_MESSAGE",
      sessionId: unloaded.id,
      messageId: "nowait-command",
      patch: {
        streaming: false,
        metadata: { output: "", commandOutput: finishedContract },
      },
    },
    3,
  );
  assertEqual(
    unloaded.isBusy,
    false,
    "an unloaded ready session must also ignore background completion for busy state",
  );
});

runCase("mobile rename preserves unloaded summary metadata", () => {
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

runCase("mobile live deltas preserve unloaded session placeholders", () => {
  const session = createSessionState("lazy-stream", "Existing chat");
  const meta = {
    id: session.id,
    title: session.title,
    updatedAt: 10,
    messagesCount: 7,
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
  assertEqual(meta.messagesCount, 7, "lazy deltas must preserve summary counts");
  assertEqual(meta.uiRevision, 6, "lazy metadata should advance its revision");
  assertEqual(session.isBusy, true, "lazy activity should still surface busy state");
});

runCase("mobile unknown rename creates an unloaded placeholder", () => {
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

runCase("mobile bootstrap reconciles updates at snapshot install", () => {
  const buffer = new UiUpdateBootstrapBuffer();
  const applied: string[] = [];
  const update = {
    type: "SESSION_RENAMED" as const,
    sessionId: "session-1",
    title: "Renamed during bootstrap",
    uiRevision: 5,
  };
  const messageUpdate = {
    type: "ADD_MESSAGE" as const,
    sessionId: "session-1",
    message: makeMessage("snapshot may already include this"),
    uiRevision: 4,
  };

  buffer.begin();
  buffer.handle(messageUpdate, (item) => applied.push(item.type));
  buffer.handle(update, (item) => applied.push(item.type));
  assertEqual(
    applied.join(","),
    "",
    "all live updates should wait while the snapshot is loading",
  );

  buffer.discardCoveredBySnapshot(5);
  buffer.handle(
    {
      ...messageUpdate,
      message: makeMessage("arrived after snapshot"),
      uiRevision: 6,
    },
    (item) => applied.push(item.type),
  );
  buffer.handle(
    {
      ...update,
      title: "Renamed after snapshot",
      uiRevision: 7,
    },
    (item) => applied.push(item.type),
  );
  buffer.end((item) => applied.push(`${item.type}:${item.sessionId}`));
  assertEqual(
    applied.join(","),
    "ADD_MESSAGE:session-1,SESSION_RENAMED:session-1",
    "pre-snapshot deltas should be dropped while post-snapshot deltas replay",
  );
});

runCase("mobile bootstrap failure replays covered updates in order", () => {
  const buffer = new UiUpdateBootstrapBuffer();
  const applied: string[] = [];
  const firstMessage = {
    type: "ADD_MESSAGE" as const,
    sessionId: "session-1",
    message: makeMessage("covered message"),
    uiRevision: 4,
  };
  const rename = {
    type: "SESSION_RENAMED" as const,
    sessionId: "session-1",
    title: "Covered rename",
    uiRevision: 5,
  };
  const laterMessage = {
    ...firstMessage,
    message: makeMessage("post-boundary message"),
    uiRevision: 6,
  };

  buffer.begin();
  buffer.handle(firstMessage, () => {});
  buffer.handle(rename, () => {});
  buffer.discardCoveredBySnapshot(5);
  buffer.handle(laterMessage, () => {});
  buffer.end(
    (update) => applied.push(`${update.type}:${update.uiRevision}`),
    { snapshotInstalled: false },
  );

  assertEqual(
    applied.join(","),
    "ADD_MESSAGE:4,SESSION_RENAMED:5,ADD_MESSAGE:6",
    "failed bootstrap should restore every buffered update in arrival order",
  );
});
