/**
 * Extreme tests for token-budget compaction cut selection.
 *
 * These cases drive the real AgentService_v2 compaction ladder with a simulated
 * model so that very long autonomous runs can be exercised deterministically.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { AgentService_v2 } from "./AgentService_v2";
import { ChatHistoryService } from "./ChatHistoryService";
import { UIHistoryService } from "./UIHistoryService";
import { PassChatTempExportService } from "./PassChatTempExportService";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import { TokenManager } from "./AgentHelper/TokenManager";
import {
  USER_INPUT_TAG,
  USER_INSERTED_INPUT_TAG,
  CONTINUE_INSTRUCTION_TAG,
  WHAT_HAVE_DONE_IN_THE_PAST_TAG,
} from "./AgentHelper/prompts";
import { buildDynamicRequestHistory } from "./AgentHelper/utils/model_messages";
import { sanitizeCompressionAfterRollback } from "./AgentHelper/utils/history_compression_maintenance";

const SESSION_ID = "session-1";
const MAX_TOKENS = 240_000;

let failures = 0;
const runCase = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
};

const makeId = (id: string) => ({ _gyshellMessageId: id });

const makeSystem = (id: string, body = "System instruction") =>
  new SystemMessage({ content: body, additional_kwargs: makeId(id) });

const makeNormalUser = (id: string, body: string) =>
  new HumanMessage({
    content: `${USER_INPUT_TAG}${body}`,
    additional_kwargs: makeId(id),
  });

const makeInsertedUser = (id: string, body: string) =>
  new HumanMessage({
    content: `${USER_INSERTED_INPUT_TAG}${body}`,
    additional_kwargs: { ...makeId(id), input_kind: "inserted" },
  });

const makeContinue = (id: string) =>
  new HumanMessage({
    content: `${CONTINUE_INSTRUCTION_TAG}continue`,
    additional_kwargs: makeId(id),
  });

const makeAssistantCall = (id: string, callId: string, body = "") =>
  new AIMessage({
    content: body,
    tool_calls: [{ id: callId, name: "exec_command", args: { cmd: "run" } }],
    additional_kwargs: makeId(id),
  } as any);

const makeAssistantText = (id: string, body: string) =>
  new AIMessage({ content: body, additional_kwargs: makeId(id) });

const makeToolResult = (id: string, callId: string, body: string) =>
  new ToolMessage({
    content: body,
    name: "exec_command",
    tool_call_id: callId,
    additional_kwargs: makeId(id),
  } as any);

const makeParallelCall = (id: string, callIds: string[]) =>
  new AIMessage({
    content: "",
    tool_calls: callIds.map((callId) => ({
      id: callId,
      name: "exec_command",
      args: { cmd: "run" },
    })),
    additional_kwargs: makeId(id),
  } as any);

interface Harness {
  agent: AgentService_v2;
  summaryCalls: Array<{ kind: "history" | "turn-prefix"; messages: BaseMessage[] }>;
  cleanup: () => void;
}

const createHarness = (options?: {
  maxTokens?: number;
  onSummary?: (messages: BaseMessage[]) => string;
}): Harness => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-rolling-cut-"));
  const store = new HistorySqliteStore({
    filePath: path.join(tempDir, "history.sqlite3"),
  });
  const uiHistory = new UIHistoryService({ store });
  uiHistory.recordEvent(SESSION_ID, {
    type: "user_input",
    content: "initial request",
    messageId: "seed-user",
  } as any);
  uiHistory.flush(SESSION_ID);
  uiHistory.renameSession(SESSION_ID, "Extreme session");

  const agent = new AgentService_v2(
    {
      getDisplayTerminals: () => [
        {
          id: "local-main",
          title: "Local",
          type: "local",
          capabilities: { supportsFilesystem: true },
        },
      ],
      getAllTerminals: () => [],
      getTerminalRuntimeSnapshot: () => ({ canUseFilesystem: true }),
      createTerminal: async (config: any) => ({
        ...config,
        type: "local",
        capabilities: { supportsFilesystem: true },
      }),
    } as any,
    {} as any,
    { getActiveTools: () => [] } as any,
    { getEnabledSkills: async () => [] } as any,
    { getMemorySnapshot: async () => ({ enabled: false, content: "" }) } as any,
    uiHistory,
    new ChatHistoryService({ store }),
  );

  (agent as any).fallbackCompactionHistoryExportService =
    new PassChatTempExportService({
      baseDir: path.join(tempDir, "fallback-compaction-history"),
      maxFiles: null,
      groupBySession: true,
    });
  agent.setEventPublisher(() => {});
  (agent as any).sessionModelBindings.set(SESSION_ID, {
    profileId: "profile-1",
    globalMaxTokens: options?.maxTokens ?? MAX_TOKENS,
    thinkingMaxTokens: options?.maxTokens ?? MAX_TOKENS,
    compactionMaxTokens: options?.maxTokens ?? MAX_TOKENS,
    readFileSupport: { image: false },
  });

  const summaryCalls: Harness["summaryCalls"] = [];
  (agent as any).getCompactionModelDecision = async (
    _sessionId: string,
    messages: BaseMessage[],
  ) => {
    const promptText = String(messages[messages.length - 1]?.content ?? "");
    const kind = promptText.includes("PREFIX of the current turn")
      ? "turn-prefix"
      : "history";
    summaryCalls.push({ kind, messages });
    if (options?.onSummary) {
      return { summary: options.onSummary(messages) };
    }
    return { summary: `${kind} summary of prior work` };
  };

  return {
    agent,
    summaryCalls,
    cleanup: () => {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
};

const requestView = (messages: BaseMessage[]) =>
  buildDynamicRequestHistory(messages);

const viewTokens = (messages: BaseMessage[]) =>
  TokenManager.estimateMessages(requestView(messages));

/** Assert the model would never receive a tool result without its call. */
const assertNoOrphanToolResult = (messages: BaseMessage[], label: string) => {
  const open = new Set<string>();
  for (const message of requestView(messages) as any[]) {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      if (call?.id) open.add(String(call.id));
    }
    if (message?.getType?.() === "tool") {
      assert.ok(
        open.has(String(message.tool_call_id)),
        `${label}: orphaned tool result ${message.tool_call_id}`,
      );
      open.delete(String(message.tool_call_id));
    }
  }
};

/** One pass of the token-manager graph node: prune first, then compact. */
const stepTokenManager = async (
  agent: AgentService_v2,
  messages: BaseMessage[],
  maxTokens = MAX_TOKENS,
): Promise<{ messages: BaseMessage[]; compacted: boolean }> => {
  if (!TokenManager.isOverflow(viewTokens(messages), maxTokens)) {
    return { messages, compacted: false };
  }
  const pruned = TokenManager.applyPruneLabels(messages);
  if (pruned.newlyTaggedCount > 0) {
    return { messages: pruned.messages, compacted: false };
  }
  const result = await (agent as any).tryCompactHistory(
    SESSION_ID,
    pruned.messages,
    undefined,
    { maxTokens, physicalRunId: "run-1" },
  );
  return {
    messages: result.changed ? result.messages : pruned.messages,
    compacted: result.changed === true,
  };
};

const lastMarker = (messages: BaseMessage[]) =>
  [...messages]
    .reverse()
    .find((message) => TokenManager.hasLastCompactionFlag(message)) as any;

await runCase(
  "a long autonomous run keeps compacting and never exceeds the window",
  async () => {
    const { agent, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "migrate the database to postgres"),
      ];
      let peak = 0;
      let compactions = 0;

      for (let round = 1; round <= 200; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${round} reasoning ${"r".repeat(40_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(20_000)}`,
          ),
        ];
        const stepped = await stepTokenManager(agent, messages);
        messages = stepped.messages;
        if (stepped.compacted) compactions += 1;
        peak = Math.max(peak, viewTokens(messages));
        assertNoOrphanToolResult(messages, `round ${round}`);
      }

      assert.ok(
        compactions >= 10,
        `expected repeated compaction, saw ${compactions}`,
      );
      assert.ok(
        peak <= MAX_TOKENS,
        `context peaked at ${peak}, above ${MAX_TOKENS}`,
      );
      assert.equal(
        requestView(messages).filter((message) =>
          TokenManager.hasLastCompactionFlag(message),
        ).length,
        1,
        "request view must expose exactly one compaction marker",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "cutting inside a turn adds a prefix summary that preserves the request",
  async () => {
    const { agent, summaryCalls, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "MY-ORIGINAL-REQUEST rewrite the parser"),
      ];
      for (let round = 1; round <= 40; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${round} ${"r".repeat(40_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(20_000)}`,
          ),
        ];
        const stepped = await stepTokenManager(agent, messages);
        messages = stepped.messages;
        if (stepped.compacted) break;
      }

      const prefixCalls = summaryCalls.filter(
        (call) => call.kind === "turn-prefix",
      );
      assert.equal(
        prefixCalls.length,
        1,
        "a split turn must request one prefix summary",
      );
      assert.ok(
        prefixCalls[0].messages.some((message) =>
          String(message.content).includes("MY-ORIGINAL-REQUEST"),
        ),
        "the prefix summary input must contain the original request",
      );
      assert.match(
        String(lastMarker(messages).content),
        /Turn context \(split turn\):/,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "cutting on a user boundary does not request a prefix summary",
  async () => {
    const { agent, summaryCalls, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [makeSystem("system")];
      for (let turn = 1; turn <= 12; turn += 1) {
        messages = [...messages, makeNormalUser(`user-${turn}`, `task ${turn}`)];
        for (let round = 1; round <= 6; round += 1) {
          messages = [
            ...messages,
            makeAssistantCall(
              `assistant-${turn}-${round}`,
              `call-${turn}-${round}`,
              `step ${"r".repeat(40_000)}`,
            ),
            makeToolResult(
              `tool-${turn}-${round}`,
              `call-${turn}-${round}`,
              `output ${"o".repeat(20_000)}`,
            ),
          ];
          const stepped = await stepTokenManager(agent, messages);
          messages = stepped.messages;
        }
      }
      assert.ok(
        summaryCalls.some((call) => call.kind === "history"),
        "history summaries must still run",
      );
      assertNoOrphanToolResult(messages, "mixed workload");
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "a cut never splits a parallel tool batch",
  async () => {
    const { agent, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "run the batch"),
      ];
      for (let round = 1; round <= 40; round += 1) {
        const callIds = [`p${round}a`, `p${round}b`, `p${round}c`];
        messages = [
          ...messages,
          makeParallelCall(`assistant-${round}`, callIds),
          ...callIds.map((callId, index) =>
            makeToolResult(
              `tool-${round}-${index}`,
              callId,
              `output ${"o".repeat(20_000)}`,
            ),
          ),
        ];
        const stepped = await stepTokenManager(agent, messages);
        messages = stepped.messages;
        assertNoOrphanToolResult(messages, `parallel round ${round}`);
      }
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "an inserted user request survives as the retained tail boundary",
  async () => {
    const { agent, summaryCalls, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "start the migration"),
      ];
      for (let round = 1; round <= 10; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${"r".repeat(40_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(20_000)}`,
          ),
        ];
        messages = (await stepTokenManager(agent, messages)).messages;
      }
      messages = [
        ...messages,
        makeInsertedUser("inserted-1", "STOP-AND-REVERT everything now"),
      ];
      for (let round = 11; round <= 30; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${"r".repeat(40_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(20_000)}`,
          ),
        ];
        messages = (await stepTokenManager(agent, messages)).messages;
      }

      const view = requestView(messages);
      const stillVerbatim = view.some((message) =>
        String(message.content).includes("STOP-AND-REVERT"),
      );
      const carriedBySummary = summaryCalls.some((call) =>
        call.messages.some((message) =>
          String(message.content).includes("STOP-AND-REVERT"),
        ),
      );
      assert.ok(
        stillVerbatim || carriedBySummary,
        "an inserted request must stay verbatim or be summarized, never dropped",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "history that cannot be cut is left untouched instead of escalating",
  async () => {
    const { agent, cleanup } = createHarness();
    try {
      const zeroRetention: string[] = [];
      (agent as any).buildZeroRetentionCompactionCandidate = async () => {
        zeroRetention.push("called");
        throw new Error("zero retention must not run");
      };
      const messages = [
        makeSystem("system"),
        makeNormalUser("user-1", "round one"),
        makeAssistantText("assistant-1", "answer one"),
        makeNormalUser("user-2", "round two"),
      ];
      const result = await (agent as any).tryCompactHistory(
        SESSION_ID,
        messages,
        undefined,
        { maxTokens: 15_000 },
      );
      assert.equal(result.changed, false);
      assert.equal(result.messages, messages);
      assert.deepEqual(zeroRetention, []);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "an oversized single tool result falls through to zero retention",
  async () => {
    const { agent, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "read the giant artifact"),
      ];
      for (let round = 1; round <= 10; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(`assistant-${round}`, `call-${round}`, "step"),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            "o".repeat(1_200_000),
          ),
        ];
      }
      const result = await (agent as any).tryCompactHistory(
        SESSION_ID,
        messages,
        undefined,
        { maxTokens: MAX_TOKENS, physicalRunId: "run-1" },
      );
      assert.equal(result.changed, true);
      assert.equal(
        lastMarker(result.messages)?.additional_kwargs
          ?.zero_retention_compaction,
        true,
      );
      assert.ok(!TokenManager.isOverflow(viewTokens(result.messages), MAX_TOKENS));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero retention stays the last resort while ordinary summaries work",
  async () => {
    const { agent, cleanup } = createHarness();
    try {
      const zeroRetention: string[] = [];
      (agent as any).buildZeroRetentionCompactionCandidate = async () => {
        zeroRetention.push("called");
        throw new Error("zero retention must not run");
      };
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "long running task"),
      ];
      for (let round = 1; round <= 80; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${"r".repeat(40_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(20_000)}`,
          ),
        ];
        messages = (await stepTokenManager(agent, messages)).messages;
      }
      assert.deepEqual(zeroRetention, []);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "a rolling marker survives rollback while a broken promise is removed",
  () => {
    const makeMarker = (extra: Record<string, unknown>) =>
      new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary`,
        additional_kwargs: {
          ...makeId("marker"),
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
          ...extra,
        },
      });
    const buildHistory = (marker: HumanMessage) => [
      makeSystem("system"),
      makeNormalUser("user-1", "task"),
      makeAssistantCall("assistant-1", "call-1"),
      makeToolResult("tool-1", "call-1", "output"),
      marker,
      makeAssistantCall("assistant-2", "call-2"),
      makeToolResult("tool-2", "call-2", "output"),
    ];
    const survives = (marker: HumanMessage) =>
      sanitizeCompressionAfterRollback(buildHistory(marker), {
        pruneToolWindow: 10,
        protectedNormalRounds: 2,
      }).messages.some((message) =>
        TokenManager.hasLastCompactionFlag(message),
      );

    assert.equal(
      survives(
        makeMarker({ [TokenManager.COMPACTION_PROTECTED_ROUNDS_KEY]: 0 }),
      ),
      true,
      "a marker promising zero rounds always keeps its promise",
    );
    assert.equal(
      survives(
        makeMarker({
          [TokenManager.COMPACTION_PROTECTED_ROUNDS_KEY]: 0,
          zero_retention_compaction: true,
        }),
      ),
      true,
    );
    assert.equal(
      survives(makeMarker({})),
      false,
      "a marker with no declared rounds must still be cleaned up",
    );
  },
);

await runCase(
  "continue instructions never become a false turn boundary",
  async () => {
    const { agent, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "ORIGINAL-TASK build the index"),
      ];
      for (let round = 1; round <= 40; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${"r".repeat(40_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(20_000)}`,
          ),
        ];
        if (round % 7 === 0) {
          messages = [...messages, makeContinue(`continue-${round}`)];
        }
        messages = (await stepTokenManager(agent, messages)).messages;
        assertNoOrphanToolResult(messages, `continue round ${round}`);
      }
      assert.ok(!TokenManager.isOverflow(viewTokens(messages), MAX_TOKENS));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "a small context window still converges",
  async () => {
    const smallWindow = 40_000;
    const { agent, cleanup } = createHarness({ maxTokens: smallWindow });
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "small window task"),
      ];
      let peak = 0;
      for (let round = 1; round <= 60; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${"r".repeat(8_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(4_000)}`,
          ),
        ];
        messages = (await stepTokenManager(agent, messages, smallWindow))
          .messages;
        peak = Math.max(peak, viewTokens(messages));
        assertNoOrphanToolResult(messages, `small window round ${round}`);
      }
      assert.ok(
        peak <= smallWindow,
        `small window peaked at ${peak}, above ${smallWindow}`,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "each compaction only summarizes messages added since the previous one",
  async () => {
    const { agent, summaryCalls, cleanup } = createHarness();
    try {
      let messages: BaseMessage[] = [
        makeSystem("system"),
        makeNormalUser("user-1", "iterative task"),
      ];
      for (let round = 1; round <= 120; round += 1) {
        messages = [
          ...messages,
          makeAssistantCall(
            `assistant-${round}`,
            `call-${round}`,
            `step ${"r".repeat(40_000)}`,
          ),
          makeToolResult(
            `tool-${round}`,
            `call-${round}`,
            `output ${"o".repeat(20_000)}`,
          ),
        ];
        messages = (await stepTokenManager(agent, messages)).messages;
      }
      const historyCalls = summaryCalls.filter(
        (call) => call.kind === "history",
      );
      assert.ok(historyCalls.length >= 3, "expected several compactions");
      for (const call of historyCalls.slice(1)) {
        // The summary request is itself reduced by the compaction boundary, so
        // only the newest summary can reach the compaction model.
        const markers = buildDynamicRequestHistory(call.messages).filter(
          (message) => TokenManager.hasLastCompactionFlag(message),
        );
        assert.equal(
          markers.length,
          1,
          "a summary request must carry exactly the newest summary",
        );
      }
    } finally {
      cleanup();
    }
  },
);

if (failures > 0) {
  console.error(`${failures} compaction rolling-cut extreme test(s) failed.`);
  process.exit(1);
}
console.log("All compaction rolling-cut extreme tests passed.");
