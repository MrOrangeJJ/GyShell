import {
  applyRenameToUnloadedSession,
  applyUiUpdate,
  applyUiUpdateToUnloadedSession,
  compactMessageSummary,
  createUnloadedRenamedSession,
  createSessionState,
  formatTuiCommandOutputStatus,
  getTuiCommandOutputStatus,
  getTuiDisplayOutput,
  getTuiHumanDisplayText,
  reorderSessionIdsByUpdatedAt,
  summarizeTuiTerminalOutput,
} from "./state";
import { GatewayClient } from "./gateway-client";
import { handleHeadlessUiUpdate } from "./index";
import type { ChatMessage } from "./protocol";
import { formatInitialCommandOutput } from "../../backend/src/services/AgentHelper/tools/command_output_contract";

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

runCase("TUI command rendering distinguishes capture loss from an excerpt", () => {
  const message: ChatMessage = {
    id: "command-1",
    role: "assistant",
    type: "command",
    content: "produce-output",
    timestamp: 1,
    metadata: {
      commandOutput: {
        contractVersion: 1,
        terminalId: "terminal-1",
        historyCommandMatchId: "history-1",
        executionState: "finished",
        exitCode: 0,
        capture: {
          state: "complete",
          observedUtf8Bytes: 100_000,
          retainedUtf8Bytes: 100_000,
          availableLineCount: 1_000,
          revision: 3,
          terminalControlsObserved: false,
        },
        presentation: {
          state: "excerpt",
          returnedUtf8Bytes: 50_000,
          hasMoreCapturedOutput: true,
          nextCursor: "next-page",
        },
      },
    },
  };

  const status = getTuiCommandOutputStatus(message);
  assertEqual(
    status?.parts.join(" | "),
    "execution=exit:0 | capture=complete | presentation=excerpt",
    "all command-output axes should stay explicit in a narrow terminal",
  );
  assertEqual(status?.tone, "neutral", "recoverable excerpt is not capture loss");
  assertCondition(
    compactMessageSummary(message, false).includes("capture=complete"),
    "compact and headless summaries should retain typed capture state",
  );
  const readPage: ChatMessage = {
    ...message,
    id: "read-page-1",
    type: "tool_call",
    content: '{"history_command_match_id":"history-1"}',
    metadata: {
      ...message.metadata,
      toolName: "read_command_output",
    },
  };
  assertCondition(
    compactMessageSummary(readPage, false).includes("presentation=excerpt"),
    "read_command_output pages should expose the same typed presentation state",
  );

  const commandOutput = message.metadata?.commandOutput;
  assertCondition(commandOutput, "typed fixture should include a command contract");
  const wrap = (output: string): string =>
    [
      "<gyshell_command_result>",
      JSON.stringify(commandOutput),
      "</gyshell_command_result>",
      "<terminal_content>",
      output,
      "</terminal_content>",
    ].join("\n");
  const firstDisplay = getTuiDisplayOutput({
    ...message.metadata,
    output: wrap("prefix"),
  });
  const nextDisplay = getTuiDisplayOutput({
    ...message.metadata,
    output: wrap("prefix-tail"),
  });
  assertEqual(
    firstDisplay,
    "prefix",
    "headless TUI output should hide the model-facing envelope",
  );
  assertEqual(
    nextDisplay.startsWith(firstDisplay) ? nextDisplay.slice(firstDisplay.length) : nextDisplay,
    "-tail",
    "headless replacement updates should diff decoded terminal text",
  );
});

runCase("TUI command rendering warns when capture is incomplete", () => {
  const message: ChatMessage = {
    id: "command-2",
    role: "assistant",
    type: "command",
    content: "chatty-output",
    timestamp: 1,
    metadata: {
      commandOutput: {
        contractVersion: 1,
        terminalId: "terminal-1",
        historyCommandMatchId: "history-2",
        executionState: "finished",
        exitCode: 0,
        capture: {
          state: "incomplete",
          reason: "retention_limit",
          observedUtf8Bytes: 20_000_000,
          retainedUtf8Bytes: 16_000_000,
          availableLineCount: 200_000,
          revision: 4,
          terminalControlsObserved: false,
        },
        presentation: {
          state: "full",
          returnedUtf8Bytes: 16_000_000,
          hasMoreCapturedOutput: false,
        },
      },
    },
  };

  const status = getTuiCommandOutputStatus(message);
  assertEqual(
    status?.parts.join(" | "),
    "execution=exit:0 | capture=incomplete(reason=retention_limit,retained=16000000/20000000B) | presentation=all-captured",
    "all retained output shown must not imply capture completeness",
  );
  assertEqual(status?.tone, "warning", "capture loss should be a warning");
  assertCondition(
    status !== null && formatTuiCommandOutputStatus(status).startsWith("WARN |"),
    "narrow-terminal output should make warning severity visible",
  );
});

runCase("headless TUI prints command status when output does not change", () => {
  const runStatusTransition = (
    executionState: "finished" | "outcome_unknown",
    exitCode: number | null,
    captureState: "complete" | "unknown",
  ): string => {
    const outputCache = new Map<string, string>();
    const messageTypes = new Map<string, ChatMessage["type"]>();
    const statusCache = new Map<string, string>();
    const written: string[] = [];
    const baseContract = {
      contractVersion: 1 as const,
      terminalId: "terminal-headless",
      historyCommandMatchId: "history-headless",
      executionState: "running" as const,
      exitCode: null,
      capture: {
        state: "in_progress" as const,
        observedUtf8Bytes: 0,
        retainedUtf8Bytes: 0,
        availableLineCount: 0,
        revision: 0,
        terminalControlsObserved: false,
      },
      presentation: {
        state: "none" as const,
        returnedUtf8Bytes: 0,
        hasMoreCapturedOutput: false,
      },
    };
    handleHeadlessUiUpdate(
      {} as GatewayClient,
      {
        type: "ADD_MESSAGE",
        sessionId: "session-headless",
        message: {
          id: "command-headless",
          role: "assistant",
          type: "command",
          content: "silent-command",
          timestamp: 1,
          metadata: { output: "", commandOutput: baseContract },
        },
      },
      outputCache,
      messageTypes,
      statusCache,
      (value) => written.push(value),
    );
    written.length = 0;
    handleHeadlessUiUpdate(
      {} as GatewayClient,
      {
        type: "UPDATE_MESSAGE",
        sessionId: "session-headless",
        messageId: "command-headless",
        patch: {
          metadata: {
            output: "",
            commandOutput: {
              ...baseContract,
              executionState,
              exitCode,
              capture: {
                ...baseContract.capture,
                state: captureState,
                ...(captureState === "unknown"
                  ? { reason: "tracking_lost" as const }
                  : {}),
                revision: 1,
              },
            },
          },
        },
      },
      outputCache,
      messageTypes,
      statusCache,
      (value) => written.push(value),
    );
    return written.join("");
  };

  assertCondition(
    runStatusTransition("finished", 0, "complete").includes(
      "execution=exit:0 | capture=complete | presentation=none",
    ),
    "silent successful commands must publish their final status",
  );
  assertCondition(
    runStatusTransition("finished", 7, "complete").includes(
      "ERROR | execution=exit:7",
    ),
    "silent failed commands must publish their nonzero exit status",
  );
  assertCondition(
    runStatusTransition("outcome_unknown", null, "unknown").includes(
      "WARN | execution=outcome-unknown | capture=unknown",
    ),
    "silent uncertain commands must publish their uncertainty",
  );
});

runCase("headless TUI labels a refreshed captured-output excerpt", () => {
  const runningOutput = Array.from(
    { length: 1_200 },
    (_, index) => `running-${index.toString().padStart(4, "0")}-${"x".repeat(64)}`,
  ).join("\n");
  const finishedOutput = `${runningOutput}\n${Array.from(
    { length: 100 },
    (_, index) => `finished-${index.toString().padStart(4, "0")}-${"y".repeat(64)}`,
  ).join("\n")}`;
  const format = (
    output: string,
    executionState: "running" | "finished",
  ) =>
    formatInitialCommandOutput({
      terminalId: "terminal-excerpt",
      historyCommandMatchId: "history-excerpt",
      executionState,
      ...(executionState === "finished" ? { exitCode: 0 } : {}),
      output,
      capture: {
        state: executionState === "running" ? "in_progress" : "complete",
        observedUtf8Bytes: Buffer.byteLength(output, "utf8"),
        retainedUtf8Bytes: Buffer.byteLength(output, "utf8"),
        availableLineCount: output.split("\n").length,
        revision: executionState === "running" ? 1 : 2,
        terminalControlsObserved: false,
      },
    });
  const running = format(runningOutput, "running");
  const finished = format(finishedOutput, "finished");
  assertEqual(
    running.contract.presentation.state,
    "excerpt",
    "fixture must exercise the bounded running excerpt path",
  );
  assertEqual(
    finished.contract.presentation.state,
    "excerpt",
    "fixture must exercise the bounded final excerpt path",
  );

  const outputCache = new Map<string, string>();
  const messageTypes = new Map<string, ChatMessage["type"]>();
  const statusCache = new Map<string, string>();
  const written: string[] = [];
  handleHeadlessUiUpdate(
    {} as GatewayClient,
    {
      type: "ADD_MESSAGE",
      sessionId: "session-excerpt",
      message: {
        id: "command-excerpt",
        role: "assistant",
        type: "command",
        content: "large-output-command",
        timestamp: 1,
        metadata: {
          output: running.text,
          commandOutput: running.contract,
        },
      },
    },
    outputCache,
    messageTypes,
    statusCache,
    (value) => written.push(value),
  );
  written.length = 0;
  handleHeadlessUiUpdate(
    {} as GatewayClient,
    {
      type: "UPDATE_MESSAGE",
      sessionId: "session-excerpt",
      messageId: "command-excerpt",
      patch: {
        streaming: false,
        metadata: {
          output: finished.text,
          commandOutput: finished.contract,
        },
      },
    },
    outputCache,
    messageTypes,
    statusCache,
    (value) => written.push(value),
  );
  const refreshed = written.join("");
  assertCondition(
    refreshed.startsWith("\n[COMMAND OUTPUT REFRESHED]"),
    "a moving excerpt tail must be labeled as replacement rather than append-only output",
  );
  assertCondition(
    refreshed.includes("finished-0099"),
    "the refreshed excerpt must still expose the newest captured tail",
  );
});

runCase("TUI summaries hide the model contract envelope from humans", () => {
  const message: ChatMessage = {
    id: "command-envelope",
    role: "assistant",
    type: "command",
    content: "printf alpha",
    timestamp: 1,
    metadata: {
      output:
        '<gyshell_command_result>\n' +
        '{"contractVersion":1,"terminalId":"t","historyCommandMatchId":"h","executionState":"finished","exitCode":0,"capture":{"state":"complete","observedUtf8Bytes":5,"retainedUtf8Bytes":5,"availableLineCount":1,"revision":1,"terminalControlsObserved":false},"presentation":{"state":"full","returnedUtf8Bytes":5,"hasMoreCapturedOutput":false}}' +
        '\n</gyshell_command_result>\n' +
        '<terminal_content>\nalpha\n</terminal_content>',
    },
  };

  const summary = compactMessageSummary(message, false);
  assertCondition(summary.includes("alpha"), "terminal output should remain visible");
  assertCondition(
    !summary.includes("gyshell_command_result"),
    "model-facing metadata must not appear in TUI output",
  );
});

runCase("TUI terminal summaries retain legacy terminal-content extraction", () => {
  assertEqual(
    summarizeTuiTerminalOutput(
      "Terminal snapshot follows:\n<terminal_content>\nlegacy visible line\nsecond line\n</terminal_content>",
    ),
    "legacy visible line",
    "legacy tool output should summarize terminal content instead of wrapper prose",
  );
  const envelopeWithoutUiMetadata =
    '<gyshell_command_result>\n' +
    '{"contractVersion":1,"terminalId":"t","historyCommandMatchId":"h","executionState":"finished","exitCode":0,"capture":{"state":"complete","observedUtf8Bytes":5,"retainedUtf8Bytes":5,"availableLineCount":1,"revision":1,"terminalControlsObserved":false},"presentation":{"state":"full","returnedUtf8Bytes":5,"hasMoreCapturedOutput":false}}' +
    '\n</gyshell_command_result>\n' +
    '<terminal_content>\nalpha\n</terminal_content>';
  assertEqual(
    getTuiDisplayOutput({ output: envelopeWithoutUiMetadata }),
    "alpha",
    "TUI output caches and diffs must decode envelopes without relying on duplicate UI metadata",
  );
  assertEqual(
    getTuiHumanDisplayText(envelopeWithoutUiMetadata),
    "alpha",
    "unloaded TUI session-index previews must use human command output",
  );
});

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

runCase("TUI late nowait completion does not reopen a ready session", () => {
  const session = createSessionState("tui-nowait-ready");
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
      pollCursor: "tui-running-poll",
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

  const unloaded = createSessionState("tui-nowait-unloaded");
  const unloadedMeta = {
    title: unloaded.title,
    updatedAt: 1,
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
