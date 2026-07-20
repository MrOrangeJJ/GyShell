import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MessageList,
  areMessageListPropsEqual,
  type MessageListProps,
} from "./MessageList";
import {
  buildChatTimeline,
  type ChatTimelineItem,
} from "../../lib/chat-timeline";
import type { ChatMessage } from "../../types";
import { commandOutputDisplayStatus, messageDetail } from "../../format";
import { MobileI18nProvider } from "../../i18n/provider";
import { mobileTranslations } from "../../i18n/translations";
import type { CommandOutputContractV1 } from "@gyshell/shared";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

function runCase(name: string, fn: () => void): void {
  fn();
  console.log(`PASS ${name}`);
}

function assertCondition(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const noopAsk = (_message: ChatMessage, _decision: "allow" | "deny") => {};
const noopDetail = (_turnId: string) => {};
const noopMessage = (_message: ChatMessage) => {};
const listRef = React.createRef<HTMLDivElement>();

if (typeof window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      navigator: { language: "en" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    },
  });
}

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? "m1",
    role: overrides.role ?? "assistant",
    type: overrides.type ?? "text",
    content: overrides.content ?? "",
    timestamp: overrides.timestamp ?? 1,
    backendMessageId: overrides.backendMessageId,
    metadata: overrides.metadata,
    streaming: overrides.streaming,
  };
}

const userMessage = makeMessage({
  id: "user-1",
  role: "user",
  content: "hello",
  backendMessageId: "backend-user-1",
});
const assistantMessage = makeMessage({
  id: "assistant-1",
  role: "assistant",
  content: "world",
  backendMessageId: "backend-assistant-1",
});
const items: ChatTimelineItem[] = [
  {
    kind: "user",
    id: userMessage.id,
    message: userMessage,
    branchBlockedByUnsettledCommand: false,
  },
  {
    kind: "agent",
    id: `agent-${assistantMessage.id}`,
    latestMessage: assistantMessage,
    detailMessages: [assistantMessage],
    startedAt: assistantMessage.timestamp,
    streaming: false,
  },
];

function makeProps(overrides: Partial<MessageListProps> = {}): MessageListProps {
  return {
    items,
    onAskDecision: noopAsk,
    onOpenDetail: noopDetail,
    onRollback: noopMessage,
    onBranch: noopMessage,
    rollbackDisabled: false,
    branchDisabled: false,
    listRef,
    ...overrides,
  };
}

function makeCommandOutput(
  executionState: CommandOutputContractV1["executionState"],
  historyCommandMatchId: string,
): CommandOutputContractV1 {
  const running = executionState === "running";
  return {
    contractVersion: 1,
    terminalId: "terminal-1",
    historyCommandMatchId,
    executionState,
    exitCode: executionState === "finished" ? 0 : null,
    capture: {
      state: running ? "in_progress" : "complete",
      observedUtf8Bytes: 0,
      retainedUtf8Bytes: 0,
      availableLineCount: 0,
      revision: 1,
      terminalControlsObserved: false,
    },
    presentation: {
      state: "none",
      returnedUtf8Bytes: 0,
      hasMoreCapturedOutput: false,
    },
  };
}

function countRenderedBranchButtons(
  timelineItems: ChatTimelineItem[],
  branchDisabled = false,
): number {
  const html = renderToStaticMarkup(
    <MobileI18nProvider>
      <MessageList
        items={timelineItems}
        onAskDecision={noopAsk}
        onOpenDetail={noopDetail}
        onRollback={noopMessage}
        onBranch={noopMessage}
        rollbackDisabled={false}
        branchDisabled={branchDisabled}
        listRef={listRef}
      />
    </MobileI18nProvider>,
  );
  return html.match(/class="bubble-branch-btn"/g)?.length ?? 0;
}

runCase("message list props are equal across composer-only parent renders", () => {
  const previous = makeProps();
  const next = makeProps();

  assertEqual(
    areMessageListPropsEqual(previous, next),
    true,
    "stable message props should allow React.memo to skip rerender",
  );
});

runCase("message list props change when timeline identity changes", () => {
  const previous = makeProps();
  const next = makeProps({ items: [...items] });

  assertEqual(
    areMessageListPropsEqual(previous, next),
    false,
    "new timeline identity must rerender the list",
  );
});

runCase("message list props change when branch actions change", () => {
  const previous = makeProps();
  const next = makeProps({ onBranch: (_message) => {} });

  assertEqual(
    areMessageListPropsEqual(previous, next),
    false,
    "new branch callback must rerender actionable user bubbles",
  );
});

runCase("message list props change when command disabled state changes", () => {
  const previous = makeProps();
  const next = makeProps({ rollbackDisabled: true });

  assertEqual(
    areMessageListPropsEqual(previous, next),
    false,
    "rollback disabled state must refresh user bubble buttons",
  );
});

runCase("chat timeline preserves compaction boundary markers", () => {
  const boundary = makeMessage({
    id: "boundary-1",
    role: "system",
    type: "compaction_boundary",
    backendMessageId: "backend-boundary-1",
    metadata: {
      compactionBoundaryPreviousBackendMessageId: "backend-assistant-1",
      compactionBoundarySummaryBackendMessageId: "backend-summary-1",
    },
  });
  const nextUserMessage = makeMessage({
    id: "user-2",
    role: "user",
    content: "continue",
    backendMessageId: "backend-user-2",
  });

  const timeline = buildChatTimeline([
    userMessage,
    assistantMessage,
    boundary,
    nextUserMessage,
  ]);

  assertEqual(
    timeline.length,
    4,
    "boundary marker should occupy its own timeline slot",
  );
  assertEqual(
    timeline[2]?.kind,
    "boundary",
    "third timeline item should be boundary",
  );
  assertCondition(
    timeline[2]?.kind === "boundary" && timeline[2].message.id === boundary.id,
    "boundary timeline item should keep the original message",
  );
});

runCase("typed running command blocks every later user branch cut", () => {
  const firstUser = makeMessage({
    id: "typed-running-user-1",
    role: "user",
    content: "start",
    backendMessageId: "backend-typed-running-user-1",
  });
  const runningCommand = makeMessage({
    id: "typed-running-command",
    type: "command",
    content: "long task",
    streaming: false,
    metadata: {
      commandOutput: makeCommandOutput("running", "typed-running-command"),
    },
  });
  const settledText = makeMessage({
    id: "typed-running-explanation",
    content: "the task continues in the background",
    streaming: false,
  });
  const laterUser = makeMessage({
    id: "typed-running-user-2",
    role: "user",
    content: "continue",
    backendMessageId: "backend-typed-running-user-2",
  });

  const timeline = buildChatTimeline([
    firstUser,
    runningCommand,
    settledText,
    laterUser,
  ]);
  const userItems = timeline.filter((item) => item.kind === "user");
  const agentItem = timeline.find((item) => item.kind === "agent");

  assertEqual(
    userItems[0]?.branchBlockedByUnsettledCommand,
    false,
    "a user message before the command should remain branchable",
  );
  assertEqual(
    userItems[1]?.branchBlockedByUnsettledCommand,
    true,
    "a later user message must not clone a running command",
  );
  assertCondition(
    agentItem?.kind === "agent" &&
      agentItem.latestMessage.id === settledText.id &&
      agentItem.detailMessages.some(
        (message) => message.id === runningCommand.id,
      ),
    "the running command should remain detectable when hidden behind settled turn preview text",
  );
  assertEqual(
    countRenderedBranchButtons(timeline),
    1,
    "MessageList should expose only the branch cut before the running command",
  );
});

runCase("typed finished command leaves later user branch cuts available", () => {
  const timeline = buildChatTimeline([
    makeMessage({
      id: "typed-finished-user-1",
      role: "user",
      content: "start",
      backendMessageId: "backend-typed-finished-user-1",
    }),
    makeMessage({
      id: "typed-finished-command",
      type: "command",
      content: "quick task",
      streaming: false,
      metadata: {
        commandOutput: makeCommandOutput(
          "finished",
          "typed-finished-command",
        ),
      },
    }),
    makeMessage({
      id: "typed-finished-user-2",
      role: "user",
      content: "continue",
      backendMessageId: "backend-typed-finished-user-2",
    }),
  ]);

  assertEqual(
    timeline.filter((item) => item.kind === "user")[1]
      ?.branchBlockedByUnsettledCommand,
    false,
    "a finished typed command should not poison its later prefix",
  );
  assertEqual(
    countRenderedBranchButtons(timeline),
    2,
    "both user branch cuts should render after command settlement",
  );
});

runCase("running read-command-output snapshot does not block branches", () => {
  const timeline = buildChatTimeline([
    makeMessage({
      id: "poll-user-1",
      role: "user",
      content: "start",
      backendMessageId: "backend-poll-user-1",
    }),
    makeMessage({
      id: "running-poll-snapshot",
      type: "tool_call",
      content: '{"history_command_match_id":"settled-command"}',
      streaming: false,
      metadata: {
        toolName: "read_command_output",
        commandOutput: makeCommandOutput("running", "settled-command"),
      },
    }),
    makeMessage({
      id: "poll-user-2",
      role: "user",
      content: "continue",
      backendMessageId: "backend-poll-user-2",
    }),
  ]);

  assertEqual(
    timeline.filter((item) => item.kind === "user")[1]
      ?.branchBlockedByUnsettledCommand,
    false,
    "a historical poll is a point-in-time snapshot, not a live command owner",
  );
  assertEqual(
    countRenderedBranchButtons(timeline),
    2,
    "running tool-call snapshots should not hide later branch controls",
  );
});

runCase("legacy streaming command remains blocking across compaction", () => {
  const timeline = buildChatTimeline([
    makeMessage({
      id: "legacy-user-1",
      role: "user",
      content: "start",
      backendMessageId: "backend-legacy-user-1",
    }),
    makeMessage({
      id: "legacy-streaming-command",
      type: "command",
      content: "legacy task",
      streaming: true,
    }),
    makeMessage({
      id: "legacy-boundary",
      role: "system",
      type: "compaction_boundary",
      backendMessageId: "backend-legacy-boundary",
    }),
    makeMessage({
      id: "legacy-user-2",
      role: "user",
      content: "continue",
      backendMessageId: "backend-legacy-user-2",
    }),
  ]);

  assertEqual(
    timeline.filter((item) => item.kind === "user")[1]
      ?.branchBlockedByUnsettledCommand,
    true,
    "compaction must not reset live state in the cloned prefix",
  );
  assertEqual(
    countRenderedBranchButtons(timeline),
    1,
    "legacy command streaming should retain only the pre-command branch control",
  );
});

runCase("global branch disable overrides otherwise safe timeline cuts", () => {
  const timeline = buildChatTimeline([
    makeMessage({
      id: "global-user-1",
      role: "user",
      content: "first",
      backendMessageId: "backend-global-user-1",
    }),
    makeMessage({
      id: "global-user-2",
      role: "user",
      content: "second",
      backendMessageId: "backend-global-user-2",
    }),
  ]);

  assertEqual(
    countRenderedBranchButtons(timeline, true),
    0,
    "global pending or busy state should suppress every branch control",
  );
});

runCase("mobile command-output status keeps execution, capture, and presentation separate", () => {
  const message = makeMessage({
    id: "command-status",
    type: "tool_call",
    content: '{"history_command_match_id":"command-1"}',
    metadata: {
      toolName: "read_command_output",
      commandOutput: {
        contractVersion: 1,
        terminalId: "terminal-1",
        historyCommandMatchId: "command-1",
        executionState: "finished",
        exitCode: 0,
        capture: {
          state: "complete",
          observedUtf8Bytes: 100_000,
          retainedUtf8Bytes: 100_000,
          availableLineCount: 500,
          revision: 2,
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
  });

  const status = commandOutputDisplayStatus(
    message,
    mobileTranslations.en.format,
  );
  assertEqual(status?.execution, "Execution: exit 0", "exit should be explicit");
  assertEqual(status?.capture, "Capture: complete", "capture should be explicit");
  assertEqual(
    status?.presentation,
    "Result: captured-output excerpt",
    "result excerpt should not be presented as capture loss",
  );
  assertEqual(status?.tone, "neutral", "recoverable excerpt is not a warning");
});

runCase("mobile command status warns for unknown capture independently of exit", () => {
  const message = makeMessage({
    id: "command-capture-unknown",
    type: "command",
    metadata: {
      commandOutput: {
        contractVersion: 1,
        terminalId: "terminal-1",
        historyCommandMatchId: "command-2",
        executionState: "finished",
        exitCode: 0,
        capture: {
          state: "unknown",
          reason: "tracking_lost",
          observedUtf8Bytes: 99,
          retainedUtf8Bytes: 13,
          availableLineCount: 0,
          revision: 1,
          terminalControlsObserved: true,
        },
        presentation: {
          state: "none",
          returnedUtf8Bytes: 0,
          hasMoreCapturedOutput: false,
        },
      },
    },
  });

  const status = commandOutputDisplayStatus(
    message,
    mobileTranslations.en.format,
  );
  assertEqual(status?.execution, "Execution: exit 0", "execution can succeed");
  assertEqual(
    status?.capture,
    "Capture: unknown (tracking lost; retained 13/99 UTF-8 bytes; terminal controls observed)",
    "capture diagnostics should expose why data is uncertain and what was retained",
  );
  assertEqual(status?.tone, "warning", "unknown capture should be a warning");
});

runCase("mobile command details hide the model-facing output envelope", () => {
  const commandOutput = {
    contractVersion: 1 as const,
    terminalId: "terminal-1",
    historyCommandMatchId: "command-envelope",
    executionState: "finished" as const,
    exitCode: 0,
    capture: {
      state: "complete" as const,
      observedUtf8Bytes: 14,
      retainedUtf8Bytes: 14,
      availableLineCount: 1,
      revision: 1,
      terminalControlsObserved: false,
    },
    presentation: {
      state: "full" as const,
      returnedUtf8Bytes: 14,
      hasMoreCapturedOutput: false,
    },
  };
  const message = makeMessage({
    id: "command-envelope",
    type: "command",
    content: "printf visible",
    metadata: {
      output: [
        "<gyshell_command_result>",
        JSON.stringify(commandOutput),
        "</gyshell_command_result>",
        "<terminal_content>",
        "visible output",
        "</terminal_content>",
      ].join("\n"),
      commandOutput,
    },
  });

  const detail = messageDetail(message, mobileTranslations.en.format);
  assertCondition(detail.includes("visible output"), "terminal text should remain visible");
  assertCondition(
    !detail.includes("gyshell_command_result"),
    "model metadata should not appear in mobile details",
  );
});
