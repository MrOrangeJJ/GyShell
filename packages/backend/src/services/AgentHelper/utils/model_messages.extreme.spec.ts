import assert from "node:assert/strict";
import {
  COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES,
  COMMAND_TOOL_RESULT_MAX_UTF8_BYTES,
  type CommandOutputContractV1,
} from "@gyshell/shared";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import {
  buildDynamicRequestHistory,
  expireUnbackedStoredCommandOutputEnvelopes,
  prepareModelInputMessagesForInvocation,
  sanitizeStoredMessagesForChatRuntime,
} from "./model_messages";
import {
  formatCommandOutputPage,
  parseCommandOutputEnvelopeContract,
} from "../tools/command_output_contract";
import { TokenManager } from "../TokenManager";

function runCase(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

runCase("sanitizeStoredMessagesForChatRuntime drops invalid generic history messages", () => {
  const validStoredMessages = mapChatMessagesToStoredMessages([
    new SystemMessage("system"),
    new HumanMessage("user"),
    new ToolMessage({
      content: "tool output",
      tool_call_id: "call-1",
      name: "exec_command",
    }),
  ]) as any[];

  const invalidGenericStoredMessage = {
    type: "generic",
    data: {
      content: "",
      additional_kwargs: {},
      response_metadata: {},
      id: "bad-generic-message",
    },
  };

  const result = sanitizeStoredMessagesForChatRuntime([
    ...validStoredMessages,
    invalidGenericStoredMessage,
  ]);

  assert.equal(result.removedCount, 1);
  assert.equal(result.messages.length, validStoredMessages.length);

  const restored = mapStoredMessagesToChatMessages(result.messages as any[]);
  assert.equal(restored.length, validStoredMessages.length);
  assert.equal(restored[0]?.type, "system");
  assert.equal(restored[1]?.type, "human");
  assert.equal(restored[2]?.type, "tool");
});

runCase("unbacked persisted command cursors and running claims expire before model restore", () => {
  const envelope = (contract: Record<string, unknown>): string =>
    [
      "<gyshell_command_result>",
      JSON.stringify(contract),
      "</gyshell_command_result>",
      "<terminal_content>",
      "partial",
      "</terminal_content>",
    ].join("\n");
  const baseContract = {
    contractVersion: 1,
    terminalId: "terminal-history",
    historyCommandMatchId: "command-history",
    executionState: "running",
    exitCode: null,
    capture: {
      state: "in_progress",
      observedUtf8Bytes: 7,
      retainedUtf8Bytes: 7,
      availableLineCount: 1,
      revision: 1,
      terminalControlsObserved: false,
    },
    presentation: {
      state: "full",
      returnedUtf8Bytes: 7,
      hasMoreCapturedOutput: false,
      pollCursor: "process-local-poll",
    },
  };
  const running = mapChatMessagesToStoredMessages([
    new ToolMessage({
      content: envelope(baseContract),
      tool_call_id: "call-running",
      name: "exec_command",
    }),
  ]) as any[];
  assert.equal(
    expireUnbackedStoredCommandOutputEnvelopes(running, () => undefined),
    true,
  );
  const recoveredRunning = parseCommandOutputEnvelopeContract(
    running[0]?.data?.content,
  );
  assert.equal(recoveredRunning?.executionState, "outcome_unknown");
  assert.equal(recoveredRunning?.capture.state, "unknown");
  assert.equal(recoveredRunning?.capture.reason, "tracking_lost");
  assert.equal(recoveredRunning?.presentation.pollCursor, undefined);

  const excerpt = mapChatMessagesToStoredMessages([
    new ToolMessage({
      content: envelope({
        ...baseContract,
        executionState: "finished",
        exitCode: 0,
        capture: { ...baseContract.capture, state: "complete" },
        presentation: {
          state: "excerpt",
          returnedUtf8Bytes: 7,
          hasMoreCapturedOutput: true,
          nextCursor: "process-local-next",
        },
      }),
      tool_call_id: "call-excerpt",
      name: "read_command_output",
    }),
  ]) as any[];
  expireUnbackedStoredCommandOutputEnvelopes(excerpt, () => undefined);
  const recoveredExcerpt = parseCommandOutputEnvelopeContract(
    excerpt[0]?.data?.content,
  );
  assert.equal(recoveredExcerpt?.executionState, "finished");
  assert.equal(recoveredExcerpt?.capture.state, "unknown");
  assert.equal(recoveredExcerpt?.capture.reason, "record_expired");
  assert.equal(recoveredExcerpt?.presentation.nextCursor, undefined);
  assert.equal(recoveredExcerpt?.presentation.hasMoreCapturedOutput, false);

  const backed = mapChatMessagesToStoredMessages([
    new ToolMessage({
      content: envelope({
        ...baseContract,
        executionState: "finished",
        exitCode: 0,
        capture: { ...baseContract.capture, state: "complete" },
        presentation: {
          state: "full",
          returnedUtf8Bytes: 7,
          hasMoreCapturedOutput: false,
        },
      }),
      tool_call_id: "call-backed",
      name: "exec_command",
    }),
  ]) as any[];
  const backedBefore = JSON.stringify(backed);
  assert.equal(
    expireUnbackedStoredCommandOutputEnvelopes(backed, () => ({
      terminalId: "terminal-history",
      historyCommandMatchId: "command-history",
      executionState: "finished",
      exitCode: 0,
      output: "partial",
      capture: {
        state: "complete",
        observedUtf8Bytes: 7,
        retainedUtf8Bytes: 7,
        availableLineCount: 1,
        revision: 1,
        terminalControlsObserved: false,
      },
    })),
    false,
  );
  assert.equal(JSON.stringify(backed), backedBefore);

  const staleRunning = mapChatMessagesToStoredMessages([
    new ToolMessage({
      content: envelope(baseContract),
      tool_call_id: "call-finished-later",
      name: "exec_command",
    }),
  ]) as any[];
  assert.equal(
    expireUnbackedStoredCommandOutputEnvelopes(staleRunning, () => ({
      terminalId: "terminal-history",
      historyCommandMatchId: "command-history",
      executionState: "finished",
      exitCode: 7,
      output: "final output",
      capture: {
        state: "complete",
        observedUtf8Bytes: 12,
        retainedUtf8Bytes: 12,
        availableLineCount: 1,
        revision: 3,
        terminalControlsObserved: false,
      },
    })),
    true,
  );
  const finishedLater = parseCommandOutputEnvelopeContract(
    staleRunning[0]?.data?.content,
  );
  assert.equal(finishedLater?.executionState, "finished");
  assert.equal(finishedLater?.exitCode, 7);
  assert.equal(finishedLater?.capture.revision, 3);
  assert.match(staleRunning[0]?.data?.content, /final output/);

  const tombstonedPage = mapChatMessagesToStoredMessages([
    new ToolMessage({
      content: envelope({
        ...baseContract,
        executionState: "finished",
        exitCode: 0,
        capture: { ...baseContract.capture, state: "complete" },
        presentation: {
          state: "excerpt",
          returnedUtf8Bytes: 7,
          hasMoreCapturedOutput: true,
          nextCursor: "process-local-next",
        },
      }),
      tool_call_id: "call-tombstoned",
      name: "read_command_output",
    }),
  ]) as any[];
  expireUnbackedStoredCommandOutputEnvelopes(tombstonedPage, () => ({
    terminalId: "terminal-history",
    historyCommandMatchId: "command-history",
    executionState: "finished",
    exitCode: 0,
    output: "",
    capture: {
      state: "unknown",
      reason: "record_expired",
      observedUtf8Bytes: 7,
      retainedUtf8Bytes: 0,
      availableLineCount: 0,
      revision: 2,
      terminalControlsObserved: false,
    },
  }));
  const tombstoned = parseCommandOutputEnvelopeContract(
    tombstonedPage[0]?.data?.content,
  );
  assert.equal(tombstoned?.capture.reason, "record_expired");
  assert.equal(tombstoned?.capture.retainedUtf8Bytes, 0);
  assert.equal(tombstoned?.presentation.nextCursor, undefined);
  assert.equal(tombstoned?.presentation.hasMoreCapturedOutput, false);
  assert.match(
    tombstonedPage[0]?.data?.content,
    /partial/,
    "already-presented durable text should remain readable after transcript eviction",
  );

  const untrustedLookalikes = mapChatMessagesToStoredMessages([
    new HumanMessage(envelope(baseContract)),
    new ToolMessage({
      content: envelope(baseContract),
      tool_call_id: "call-unrelated",
      name: "read_file",
    }),
  ]) as any[];
  const lookalikesBefore = JSON.stringify(untrustedLookalikes);
  assert.equal(
    expireUnbackedStoredCommandOutputEnvelopes(
      untrustedLookalikes,
      () => undefined,
    ),
    false,
  );
  assert.equal(
    JSON.stringify(untrustedLookalikes),
    lookalikesBefore,
    "literal user text and unrelated tool output must not gain command-result provenance from a matching prefix",
  );
});

runCase("dynamic pruning preserves typed command truth while removing only terminal bodies", () => {
  const envelope = (
    contract: CommandOutputContractV1,
    body: string,
  ): string =>
    [
      "<gyshell_command_result>",
      JSON.stringify(contract),
      "</gyshell_command_result>",
      "<terminal_content>",
      body,
      "</terminal_content>",
    ].join("\n");
  const runningContract: CommandOutputContractV1 = {
    contractVersion: 1,
    terminalId: "terminal-pruned-running",
    historyCommandMatchId: "command-pruned-running",
    executionState: "running",
    exitCode: null,
    capture: {
      state: "in_progress",
      observedUtf8Bytes: 1024 * 1024,
      retainedUtf8Bytes: 1024 * 1024,
      availableLineCount: 1,
      revision: 9,
      terminalControlsObserved: true,
    },
    presentation: {
      state: "full",
      returnedUtf8Bytes: 1024 * 1024,
      hasMoreCapturedOutput: false,
      pollCursor: "poll-cursor-must-survive-pruning",
    },
  };
  const pagedContract: CommandOutputContractV1 = {
    ...runningContract,
    terminalId: "terminal-pruned-page",
    historyCommandMatchId: "command-pruned-page",
    executionState: "finished",
    exitCode: 17,
    capture: {
      ...runningContract.capture,
      state: "incomplete",
      reason: "retention_limit",
      revision: 11,
    },
    presentation: {
      state: "excerpt",
      returnedUtf8Bytes: 4096,
      hasMoreCapturedOutput: true,
      nextCursor: "next-cursor-must-survive-pruning",
    },
  };
  const makePrunedToolMessage = (
    name: "exec_command" | "read_command_output",
    contract: CommandOutputContractV1,
    body: string,
  ): ToolMessage =>
    new ToolMessage({
      content: envelope(contract, body),
      tool_call_id: `call-${name}`,
      name,
      additional_kwargs: {
        [TokenManager.PRUNE_FLAG_KEY]: true,
      },
    });

  const sourceMessages = [
    makePrunedToolMessage(
      "exec_command",
      runningContract,
      `secret-head-${"x".repeat(1024 * 1024)}-secret-tail`,
    ),
    makePrunedToolMessage(
      "read_command_output",
      pagedContract,
      `page-secret-${"😀".repeat(64 * 1024)}`,
    ),
  ];
  const materialized = buildDynamicRequestHistory(sourceMessages);

  assert.equal(materialized.length, 2);
  [runningContract, pagedContract].forEach((expected, index) => {
    const content = String(materialized[index]?.content || "");
    assert.deepEqual(
      parseCommandOutputEnvelopeContract(content),
      expected,
      "pruning must preserve every declared v1 contract field exactly",
    );
    assert.equal(content.includes("secret-head"), false);
    assert.equal(content.includes("secret-tail"), false);
    assert.equal(content.includes("page-secret"), false);
    assert.equal(content.includes("<terminal_content>"), false);
    assert.match(content, /"contractScope":"original_tool_result"/);
    assert.match(content, /"bodyState":"pruned_from_model_context"/);
    assert.match(content, /"modelContextBodyUtf8Bytes":0/);
    assert.match(content, /"automaticReplayAllowed":false/);
    assert.match(content, /Do not automatically replay/);
    assert.ok(
      Buffer.byteLength(content, "utf8") <=
        COMMAND_TOOL_RESULT_MAX_UTF8_BYTES,
      "pruned command context must remain within the tool-result envelope budget",
    );
  });
  assert.equal(
    parseCommandOutputEnvelopeContract(String(materialized[0]?.content))
      ?.presentation.pollCursor,
    runningContract.presentation.pollCursor,
  );
  assert.equal(
    parseCommandOutputEnvelopeContract(String(materialized[1]?.content))
      ?.presentation.nextCursor,
    pagedContract.presentation.nextCursor,
  );
  assert.match(
    String(materialized[0]?.content),
    /"originalApproximateTokens":[1-9][0-9]*/,
  );

  assert.match(
    String(sourceMessages[0]?.content),
    /secret-head/,
    "dynamic materialization must not mutate durable history messages",
  );
});

runCase("invocation refresh preserves a pruned command body boundary", () => {
  const runningContract: CommandOutputContractV1 = {
    contractVersion: 1,
    terminalId: "terminal-pruned-refresh",
    historyCommandMatchId: "command-pruned-refresh",
    executionState: "running",
    exitCode: null,
    capture: {
      state: "in_progress",
      observedUtf8Bytes: 12,
      retainedUtf8Bytes: 12,
      availableLineCount: 1,
      revision: 1,
      terminalControlsObserved: false,
    },
    presentation: {
      state: "full",
      returnedUtf8Bytes: 12,
      hasMoreCapturedOutput: false,
      pollCursor: "pruned-refresh-poll",
    },
  };
  const source = new ToolMessage({
    content: [
      "<gyshell_command_result>",
      JSON.stringify(runningContract),
      "</gyshell_command_result>",
      "<terminal_content>",
      `old-secret-${"x".repeat(256 * 1024)}`,
      "</terminal_content>",
    ].join("\n"),
    tool_call_id: "call-pruned-refresh",
    name: "exec_command",
    additional_kwargs: { [TokenManager.PRUNE_FLAG_KEY]: true },
  });
  const pruned = buildDynamicRequestHistory([source]);
  const prepared = prepareModelInputMessagesForInvocation(pruned, {
    getCommandOutputBackingSource: () => ({
      terminalId: runningContract.terminalId,
      historyCommandMatchId: runningContract.historyCommandMatchId,
      executionState: "finished",
      exitCode: 0,
      output: `new-secret-${"y".repeat(80 * 1024)}`,
      capture: {
        state: "complete",
        observedUtf8Bytes: 80 * 1024 + 11,
        retainedUtf8Bytes: 80 * 1024 + 11,
        availableLineCount: 1,
        revision: 2,
        terminalControlsObserved: false,
      },
    }),
  });
  const content = String(prepared[0]?.content || "");

  assert.equal(
    parseCommandOutputEnvelopeContract(content)?.executionState,
    "finished",
    "invocation refresh must still update command lifecycle truth",
  );
  assert.match(content, /"bodyState":"pruned_from_model_context"/);
  assert.equal(content.includes("old-secret"), false);
  assert.equal(content.includes("new-secret"), false);
  assert.equal(content.includes("<terminal_content>"), false);
  assert.ok(
    Buffer.byteLength(content, "utf8") < 8 * 1024,
    "refreshing backing truth must not reinflate a pruned historical result",
  );
});

runCase("invocation refresh preserves read_command_output page progress", () => {
  const runningOutput = "zero\none\ntwo";
  const finalOutput = `${runningOutput}\nfinal`;
  const runningSource = {
    terminalId: "terminal-page-refresh",
    historyCommandMatchId: "command-page-refresh",
    executionState: "running" as const,
    output: runningOutput,
    capture: {
      state: "in_progress" as const,
      observedUtf8Bytes: Buffer.byteLength(runningOutput, "utf8"),
      retainedUtf8Bytes: Buffer.byteLength(runningOutput, "utf8"),
      availableLineCount: 3,
      revision: 1,
      terminalControlsObserved: false,
    },
  };
  const historicalPage = formatCommandOutputPage({
    source: runningSource,
    options: { offset: 2, limit: 10 },
  });
  const pollCursor = historicalPage.contract.presentation.pollCursor;
  assert.ok(pollCursor, "a running page at the captured tail needs a poll cursor");

  const settledSource = {
    ...runningSource,
    executionState: "finished" as const,
    exitCode: 0,
    output: finalOutput,
    capture: {
      ...runningSource.capture,
      state: "complete" as const,
      observedUtf8Bytes: Buffer.byteLength(finalOutput, "utf8"),
      retainedUtf8Bytes: Buffer.byteLength(finalOutput, "utf8"),
      availableLineCount: 4,
      revision: 2,
    },
  };
  const pageMessage = new ToolMessage({
    content: historicalPage.text,
    tool_call_id: "call-page-refresh",
    name: "read_command_output",
  });
  const prepare = (message: ToolMessage): string =>
    String(
      prepareModelInputMessagesForInvocation([message], {
        getCommandOutputBackingSource: () => settledSource,
      })[0]?.content || "",
    );

  const refreshed = prepare(pageMessage);
  const refreshedContract = parseCommandOutputEnvelopeContract(refreshed);
  assert.equal(refreshedContract?.executionState, "finished");
  assert.equal(refreshedContract?.presentation.state, "excerpt");
  assert.equal(refreshedContract?.presentation.hasMoreCapturedOutput, true);
  assert.equal(refreshedContract?.presentation.nextCursor, pollCursor);
  assert.equal(refreshedContract?.presentation.pollCursor, undefined);
  assert.match(refreshed, /<terminal_content>\ntwo\n<\/terminal_content>/);
  assert.equal(refreshed.includes("zero\none"), false);
  assert.equal(refreshed.includes("\nfinal\n</terminal_content>"), false);

  const continuation = formatCommandOutputPage({
    source: settledSource,
    options: { cursor: refreshedContract?.presentation.nextCursor },
  });
  assert.match(
    continuation.text,
    /<terminal_content>\n\nfinal\n<\/terminal_content>/,
    "the promoted poll cursor must continue after the historical page",
  );

  const prunedPage = buildDynamicRequestHistory([
    new ToolMessage({
      content: historicalPage.text,
      tool_call_id: "call-pruned-page-refresh",
      name: "read_command_output",
      additional_kwargs: { [TokenManager.PRUNE_FLAG_KEY]: true },
    }),
  ])[0] as ToolMessage;
  const refreshedPruned = prepare(prunedPage);
  assert.match(refreshedPruned, /"bodyState":"pruned_from_model_context"/);
  assert.equal(refreshedPruned.includes("<terminal_content>"), false);
  assert.equal(
    parseCommandOutputEnvelopeContract(refreshedPruned)?.presentation
      .nextCursor,
    pollCursor,
    "pruned historical pages must retain the same paging continuation",
  );

  const runningAtFinalTailSource = {
    ...settledSource,
    executionState: "running" as const,
    exitCode: undefined,
    capture: {
      ...settledSource.capture,
      state: "in_progress" as const,
      revision: 1,
    },
  };
  const runningAtFinalTail = formatCommandOutputPage({
    source: runningAtFinalTailSource,
    options: { offset: 3, limit: 10 },
  });
  const unchangedTail = prepare(
    new ToolMessage({
      content: runningAtFinalTail.text,
      tool_call_id: "call-page-no-growth",
      name: "read_command_output",
    }),
  );
  const unchangedTailContract =
    parseCommandOutputEnvelopeContract(unchangedTail);
  assert.equal(unchangedTailContract?.presentation.nextCursor, undefined);
  assert.equal(unchangedTailContract?.presentation.pollCursor, undefined);
  assert.match(unchangedTail, /<terminal_content>\nfinal\n<\/terminal_content>/);
});

runCase("pruned command lookalikes do not gain trusted command provenance", () => {
  const message = new ToolMessage({
    content:
      '<gyshell_command_result>\n{"contractVersion":1}\n</gyshell_command_result>\nuntrusted',
    tool_call_id: "call-malformed-command-lookalike",
    name: "exec_command",
    additional_kwargs: {
      [TokenManager.PRUNE_FLAG_KEY]: true,
    },
  });
  const materialized = buildDynamicRequestHistory([message]);
  const content = String(materialized[0]?.content || "");
  assert.match(content, /^\[Content Pruned by TokenManager\]/);
  assert.equal(parseCommandOutputEnvelopeContract(content), undefined);
  assert.equal(content.includes("untrusted"), false);
});

runCase("pruned command materialization is bounded at maximum contract field sizes", () => {
  const terminalId = "<".repeat(
    COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES,
  );
  const historyCommandMatchId = "&".repeat(
    COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES,
  );
  const nextCursor = "A".repeat(4096);
  const contract: CommandOutputContractV1 = {
    contractVersion: 1,
    terminalId,
    historyCommandMatchId,
    executionState: "finished",
    exitCode: 0,
    capture: {
      state: "complete",
      observedUtf8Bytes: 1,
      retainedUtf8Bytes: 1,
      availableLineCount: 1,
      revision: Number.MAX_SAFE_INTEGER,
      terminalControlsObserved: false,
    },
    presentation: {
      state: "excerpt",
      returnedUtf8Bytes: 0,
      hasMoreCapturedOutput: true,
      nextCursor,
    },
  };
  const message = new ToolMessage({
    content: [
      "<gyshell_command_result>",
      JSON.stringify(contract),
      "</gyshell_command_result>",
      "<terminal_content>",
      "x",
      "</terminal_content>",
    ].join("\n"),
    tool_call_id: "call-maximum-contract",
    name: "read_command_output",
    additional_kwargs: {
      [TokenManager.PRUNE_FLAG_KEY]: true,
    },
  });

  const content = String(buildDynamicRequestHistory([message])[0]?.content);
  assert.deepEqual(parseCommandOutputEnvelopeContract(content), contract);
  assert.ok(
    Buffer.byteLength(content, "utf8") <=
      COMMAND_TOOL_RESULT_MAX_UTF8_BYTES,
  );
  assert.equal(content.includes("<terminal_content>"), false);
  assert.match(content, /"automaticReplayAllowed":false/);
});
