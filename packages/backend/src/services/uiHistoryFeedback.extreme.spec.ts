import { extractCommandOutputDisplayText } from "@gyshell/shared";
import { UIHistoryService } from "./UIHistoryService";
import {
  buildUiSessionSummary,
  sanitizeUiSession,
} from "./history/uiHistoryHelpers";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

function assertCondition(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const sessions = new Map<string, any>();
const store = {
  listUiSessionSummaries: () => [],
  listUiSessions: () => [...sessions.values()],
  loadUiSession: (sessionId: string) => sessions.get(sessionId) || null,
  saveUiSessions: (
    entries: Array<{ session: { id: string }; summary: unknown }>,
  ) => {
    entries.forEach((entry) => sessions.set(entry.session.id, entry.session));
  },
  deleteUiSessions: () => {},
} as any;

const history = new UIHistoryService({ store });
history.recordEvent("session-1", {
  type: "command_ask",
  messageId: "message-1",
  approvalId: "approval-1",
  command: "git push",
} as any);

const action = history.recordFeedbackDecision("approval-1", "allow");
assertEqual(action?.type, "UPDATE_MESSAGE", "feedback should emit an update");
assertEqual(
  action?.type === "UPDATE_MESSAGE"
    ? action.patch.metadata?.decision
    : undefined,
  "allow",
  "feedback update should carry the decision",
);
assertEqual(
  history
    .getSession("session-1")
    ?.messages.some((message) => message.type === "ask"),
  false,
  "resolved transient asks should not reappear after history flush",
);
assertEqual(
  history.recordFeedbackDecision("approval-1", "allow"),
  null,
  "repeating the same decision should be idempotent",
);

history.recordEvent("session-2", {
  type: "command_ask",
  messageId: "message-2",
  approvalId: "approval-2",
  command: "rm file",
} as any);
const uiMessageId = history.getSession("session-2")?.messages[0]?.id || "";
assertEqual(
  history.recordFeedbackDecision(uiMessageId, "deny"),
  null,
  "UI message ids must not masquerade as backend feedback ids",
);
assertEqual(
  history.getSession("session-2")?.messages[0]?.metadata?.decision,
  undefined,
  "invalid feedback ids must leave the approval pending",
);

const commandOutputContract = {
  contractVersion: 1 as const,
  terminalId: "terminal-1",
  historyCommandMatchId: "history-1",
  executionState: "finished" as const,
  exitCode: 0,
  capture: {
    state: "complete" as const,
    observedUtf8Bytes: 13,
    retainedUtf8Bytes: 13,
    availableLineCount: 1,
    revision: 1,
    terminalControlsObserved: false,
  },
  presentation: {
    state: "full" as const,
    returnedUtf8Bytes: 13,
    hasMoreCapturedOutput: false,
  },
};
const wrappedOutput = [
  "<gyshell_command_result>",
  JSON.stringify(commandOutputContract),
  "</gyshell_command_result>",
  "<terminal_content>",
  "human &lt;output&gt;",
  "</terminal_content>",
].join("\n");
const historyWithLegacySummary = new UIHistoryService({
  store: {
    listUiSessionSummaries: () => [
      {
        id: "legacy-summary-session",
        title: "Legacy summary",
        updatedAt: 1,
        messagesCount: 1,
        lastMessagePreview: wrappedOutput,
      },
    ],
  } as any,
});
assertEqual(
  historyWithLegacySummary.getAllSessionSummaries()[0]?.lastMessagePreview,
  "human <output>",
  "persisted summary caches must decode old command envelopes before any client renders them",
);
const nonzeroCommandOutputContract = {
  ...commandOutputContract,
  exitCode: 17,
};
const wrappedNonzeroOutput = [
  "<gyshell_command_result>",
  JSON.stringify(nonzeroCommandOutputContract),
  "</gyshell_command_result>",
  "<terminal_content>",
  "human &lt;output&gt;",
  "</terminal_content>",
].join("\n");
const uncertainCommandOutputContract = {
  ...commandOutputContract,
  executionState: "outcome_unknown" as const,
  exitCode: null,
  capture: {
    ...commandOutputContract.capture,
    state: "unknown" as const,
    reason: "record_expired" as const,
    observedUtf8Bytes: 99,
    retainedUtf8Bytes: 13,
    revision: 2,
    terminalControlsObserved: true,
  },
  presentation: {
    state: "excerpt" as const,
    returnedUtf8Bytes: 13,
    hasMoreCapturedOutput: false,
  },
};
const wrappedUncertainOutput = [
  "<gyshell_command_result>",
  JSON.stringify(uncertainCommandOutputContract),
  "</gyshell_command_result>",
  "<terminal_content>",
  "uncertain output",
  "</terminal_content>",
].join("\n");
const readable = history.toReadableMarkdownFragment([
  {
    id: "readable-command",
    role: "assistant",
    type: "command",
    content: "printf output",
    timestamp: 1,
    metadata: {
      output: wrappedNonzeroOutput,
      commandOutput: nonzeroCommandOutputContract,
    },
  },
  {
    id: "readable-page",
    role: "assistant",
    type: "tool_call",
    content: '{"history_command_match_id":"history-1"}',
    timestamp: 2,
    metadata: {
      toolName: "read_command_output",
      output: wrappedUncertainOutput,
      commandOutput: uncertainCommandOutputContract,
    },
  },
]);
assertCondition(
  readable.includes("human <output>"),
  "readable copy and export should retain decoded terminal output",
);
assertCondition(
  !readable.includes("gyshell_command_result"),
  "readable copy and export must hide the model-facing command contract",
);
assertCondition(
  readable.includes("- Exit code: 17"),
  "readable copy and export must retain a verified nonzero exit code",
);
assertCondition(
  readable.includes("- Execution: outcome unknown") &&
    readable.includes("reason: record_expired") &&
    readable.includes("observed 99 UTF-8 bytes, retained 13") &&
    readable.includes("- Presentation: excerpt") &&
    readable.includes("Terminal controls: observed"),
  "readable copy and export must retain unknown outcome, capture loss, presentation, and terminal-control semantics",
);
const typedSummary = buildUiSessionSummary({
  id: "typed-summary",
  title: "Typed summary",
  updatedAt: 1,
  messages: [
    {
      id: "typed-summary-command",
      role: "assistant",
      type: "command",
      content: "printf output",
      timestamp: 1,
      metadata: {
        output: wrappedOutput,
        commandOutput: commandOutputContract,
      },
    },
  ],
});
assertEqual(
  typedSummary.lastMessagePreview,
  "human <output>",
  "persisted unloaded-session previews must decode typed command output",
);
assertCondition(
  !typedSummary.lastMessagePreview.includes("gyshell_command_result"),
  "persisted previews must never expose the model-facing command envelope",
);

const malformedContractSession = sanitizeUiSession({
  id: "malformed-command-contract",
  title: "Malformed contract",
  updatedAt: 1,
  messages: [
    {
      id: "malformed-command-message",
      role: "assistant",
      type: "command",
      content: "legacy-command",
      timestamp: 1,
      streaming: false,
      metadata: {
        output: "legacy output remains readable",
        commandOutput: { contractVersion: 1 } as any,
      },
    },
  ],
});
assertEqual(
  malformedContractSession.messages[0]?.metadata?.commandOutput,
  undefined,
  "malformed persisted command contracts must be removed at the history boundary",
);
assertEqual(
  malformedContractSession.messages[0]?.metadata?.output,
  "legacy output remains readable",
  "removing malformed metadata must preserve legacy human output",
);

const readableWithoutTypedMetadata = history.toReadableMarkdownFragment([
  {
    id: "readable-envelope-without-metadata",
    role: "assistant",
    type: "command",
    content: "printf output",
    timestamp: 1,
    metadata: { output: wrappedOutput },
  },
]);
assertCondition(
  readableWithoutTypedMetadata.includes("human <output>") &&
    !readableWithoutTypedMetadata.includes("gyshell_command_result"),
  "readable copy/export must decode valid envelopes even when old UI metadata is absent",
);

history.recordEvent("session-pending-ask", {
  type: "command_ask",
  messageId: "pending-ask-message",
  approvalId: "pending-ask-approval",
  command: "dangerous-command",
} as any);
history.flush("session-pending-ask", {
  preserveLiveTransientState: true,
});
assertCondition(
  history
    .getSession("session-pending-ask")
    ?.messages.some((message) => message.type === "ask") === true,
  "a background durability flush must not remove a live pending approval",
);
assertCondition(
  sessions
    .get("session-pending-ask")
    ?.messages.every((message: any) => message.type !== "ask") === true,
  "the persisted clone must still omit transient approval prompts",
);
assertCondition(
  history.recordFeedbackDecision("pending-ask-approval", "allow") !== null,
  "the live approval must remain resolvable after an unrelated flush",
);

history.recordEvent("session-stopped-ask", {
  type: "command_ask",
  messageId: "stopped-ask-message",
  approvalId: "stopped-ask-approval",
  command: "cancelled-command",
} as any);
history.flush("session-stopped-ask");
assertCondition(
  history
    .getSession("session-stopped-ask")
    ?.messages.every((message) => message.type !== "ask") === true,
  "a normal stop/run-boundary flush must remove approvals with no live waiter",
);

const runningContract = {
  ...commandOutputContract,
  executionState: "running" as const,
  exitCode: null,
  capture: {
    ...commandOutputContract.capture,
    state: "in_progress" as const,
  },
  presentation: {
    ...commandOutputContract.presentation,
    pollCursor: "process-local-running-cursor",
  },
};
const readableRunningSnapshot = history.toReadableMarkdownFragment([
  {
    id: "readable-running-snapshot",
    role: "assistant",
    type: "tool_call",
    content: "{}",
    timestamp: 1,
    metadata: {
      toolName: "exec_command",
      output: "current output",
      commandOutput: runningContract,
    },
  },
]);
assertCondition(
  readableRunningSnapshot.includes(
    "this is a running snapshot; poll the live session for newer output",
  ),
  "readable history must not describe a pollable running snapshot as final output",
);
history.recordEvent("session-live-nowait", {
  type: "command_started",
  messageId: "live-nowait-message",
  commandId: "live-nowait-command",
  command: "sleep 30",
  tabName: "Terminal",
  isNowait: true,
} as any);
history.recordEvent("session-live-nowait", {
  type: "command_finished",
  messageId: "live-nowait-message",
  commandId: "live-nowait-command",
  command: "sleep 30",
  outputDelta: "",
  outputMode: "replace",
  commandOutput: runningContract,
  isNowait: true,
} as any);
history.flush("session-live-nowait");
assertEqual(
  history.getSession("session-live-nowait")?.messages[0]?.metadata
    ?.commandOutput?.executionState,
  "running",
  "routine run-boundary persistence must not downgrade a live nowait command",
);
history.recordEvent("session-live-nowait", {
  type: "command_finished",
  messageId: "live-nowait-message",
  commandId: "live-nowait-command",
  command: "sleep 30",
  exitCode: 0,
  outputDelta: wrappedOutput,
  outputMode: "replace",
  commandOutput: commandOutputContract,
  isNowait: true,
} as any);
history.flush("session-live-nowait");
const reloadedHistory = new UIHistoryService({ store });
assertEqual(
  reloadedHistory.getSession("session-live-nowait")?.messages[0]?.metadata
    ?.commandOutput?.executionState,
  "finished",
  "a durably flushed late completion must survive service restart as finished",
);
assertCondition(
  reloadedHistory
    .getSession("session-live-nowait")
    ?.messages[0]?.metadata?.output?.includes("human &lt;output&gt;") === true,
  "restart must retain the final background command output",
);
const sanitizedRunningSession = sanitizeUiSession({
  id: "session-running-nowait",
  title: "Running nowait",
  updatedAt: 1,
  messages: [
    {
      id: "running-command",
      role: "assistant",
      type: "command",
      content: "sleep 30",
      timestamp: 1,
      // Initial nowait command_finished events are intentionally non-streaming;
      // the typed execution state is the durable source of truth.
      streaming: false,
      metadata: {
        output: [
          "<gyshell_command_result>",
          JSON.stringify(runningContract),
          "</gyshell_command_result>",
          "Execution note: the command is still running. Reaching the current captured tail is a snapshot, not End of output.",
          "<terminal_content>",
          "partial output",
          "</terminal_content>",
        ].join("\n"),
        commandOutput: runningContract,
        isNowait: true,
      },
    },
  ],
});
const interruptedMessage = sanitizedRunningSession.messages[0];
const interruptedContract = interruptedMessage?.metadata?.commandOutput;
const interruptedOutput = interruptedMessage?.metadata?.output || "";
assertEqual(
  interruptedContract?.executionState,
  "outcome_unknown",
  "persisted running nowait commands must become outcome-unknown after restart",
);
assertEqual(
  interruptedContract?.capture.state,
  "unknown",
  "in-progress capture must become explicitly unknown after restart",
);
assertEqual(
  interruptedContract?.capture.reason,
  "tracking_lost",
  "restart sanitization must record why capture completeness was lost",
);
assertEqual(
  interruptedContract?.presentation.hasMoreCapturedOutput,
  false,
  "process-local cursor continuation must not be advertised after restart",
);
assertCondition(
  interruptedContract?.presentation.pollCursor === undefined,
  "restart sanitization must remove a stale process-local poll cursor",
);
assertCondition(
  interruptedOutput.includes('"executionState":"outcome_unknown"'),
  "the persisted model-facing envelope must match typed UI metadata",
);
assertCondition(
  !interruptedOutput.includes("the command is still running"),
  "the persisted envelope must remove its stale running instruction",
);
assertCondition(
  interruptedOutput.includes("the command outcome is unknown"),
  "the rewritten envelope must explain the recovered unknown outcome",
);
const interruptedDisplay = extractCommandOutputDisplayText(interruptedOutput);
assertCondition(
  interruptedDisplay.includes("partial output"),
  "restart sanitization must preserve previously displayed terminal output",
);
assertCondition(
  interruptedDisplay.includes("Session closed before command finished"),
  "human display must retain the interrupted-session notice outside the envelope",
);

const runningIncompleteContract = {
  ...runningContract,
  capture: {
    ...runningContract.capture,
    state: "incomplete" as const,
    reason: "retention_limit" as const,
    observedUtf8Bytes: 200,
    retainedUtf8Bytes: 100,
  },
};
const finishedExcerptContract = {
  ...commandOutputContract,
  capture: {
    ...commandOutputContract.capture,
    observedUtf8Bytes: 500,
    retainedUtf8Bytes: 500,
  },
  presentation: {
    state: "excerpt" as const,
    returnedUtf8Bytes: 13,
    hasMoreCapturedOutput: true,
    nextCursor: "process-local-page-cursor",
  },
};
const recoveredTypedTools = sanitizeUiSession({
  id: "session-typed-tools",
  title: "Typed tools",
  updatedAt: 1,
  messages: [
    {
      id: "running-tool",
      role: "assistant",
      type: "tool_call",
      content: "{}",
      timestamp: 1,
      metadata: {
        toolName: "exec_command",
        output: [
          "<gyshell_command_result>",
          JSON.stringify(runningIncompleteContract),
          "</gyshell_command_result>",
          "<terminal_content>",
          "retained prefix",
          "</terminal_content>",
        ].join("\n"),
        commandOutput: runningIncompleteContract,
      },
    },
    {
      id: "finished-page",
      role: "assistant",
      type: "tool_call",
      content: "{}",
      timestamp: 2,
      metadata: {
        toolName: "read_command_output",
        output: [
          "<gyshell_command_result>",
          JSON.stringify(finishedExcerptContract),
          "</gyshell_command_result>",
          "<terminal_content>",
          "page excerpt",
          "</terminal_content>",
        ].join("\n"),
        commandOutput: finishedExcerptContract,
      },
    },
  ],
});
const recoveredRunningTool =
  recoveredTypedTools.messages[0]?.metadata?.commandOutput;
assertEqual(
  recoveredRunningTool?.executionState,
  "outcome_unknown",
  "restart recovery must cover typed exec_command tool messages, not only command rows",
);
assertEqual(
  recoveredRunningTool?.capture.state,
  "unknown",
  "a formerly incomplete but still-running capture cannot remain authoritative after tracking is lost",
);
assertEqual(
  recoveredRunningTool?.capture.reason,
  "tracking_lost",
  "lost runtime tracking is the primary post-restart uncertainty",
);
assertEqual(
  recoveredRunningTool?.capture.observedUtf8Bytes,
  200,
  "restart recovery must preserve the last observed byte count",
);
assertCondition(
  !(recoveredTypedTools.messages[0]?.metadata?.output || "").includes(
    "Session closed before command finished",
  ),
  "tool rows must not receive a command-row-only human session note",
);
const recoveredFinishedPage =
  recoveredTypedTools.messages[1]?.metadata?.commandOutput;
assertEqual(
  recoveredFinishedPage?.executionState,
  "finished",
  "expiring a stale page cursor must not erase a verified finished outcome",
);
assertEqual(
  recoveredFinishedPage?.capture.state,
  "unknown",
  "a persisted excerpt without its process-local record cannot claim recoverable completeness",
);
assertEqual(
  recoveredFinishedPage?.capture.reason,
  "record_expired",
  "stale excerpt recovery must identify record expiry",
);
assertCondition(
  recoveredFinishedPage?.presentation.nextCursor === undefined &&
    recoveredFinishedPage?.presentation.hasMoreCapturedOutput === false,
  "restart recovery must remove stale page cursors and false continuation promises",
);

console.log("PASS UI history feedback decisions resolve and remain idempotent");
