import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  mapChatMessagesToStoredMessages,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { AgentService_v2 } from "./AgentService_v2";
import { ChatHistoryService } from "./ChatHistoryService";
import { PassChatTempExportService } from "./PassChatTempExportService";
import { UIHistoryService } from "./UIHistoryService";
import { TokenManager } from "./AgentHelper/TokenManager";
import {
  PASS_CHAT_HISTORY_TAG,
  USER_INSERTED_INPUT_TAG,
  USER_INPUT_TAG,
  WHAT_HAVE_DONE_IN_THE_PAST_TAG,
} from "./AgentHelper/prompts";
import { buildDynamicRequestHistory } from "./AgentHelper/utils/model_messages";
import { buildDeterministicCompactionDigest } from "./AgentHelper/utils/deterministic_compaction_digest";
import { sanitizeCompressionAfterRollback } from "./AgentHelper/utils/history_compression_maintenance";
import {
  invokeWithRetry,
  isContextWindowExceededError,
} from "./AgentHelper/utils/runtime";
import { MAX_LINE_LENGTH, readTextFile } from "./AgentHelper/tools/read_tools";
import { HistorySqliteStore } from "./history/HistorySqliteStore";

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

class FakeTerminalService {
  createdLocalTerminals = 0;
  private localTerminalId = "local-main";

  constructor(private hasLocalTerminal: boolean = true) {}

  getDisplayTerminals(): any[] {
    if (!this.hasLocalTerminal) return [];
    return [
      {
        id: this.localTerminalId,
        title: "Local",
        type: "local",
        capabilities: { supportsFilesystem: true },
      },
    ];
  }

  getTerminalRuntimeSnapshot(): any {
    return this.hasLocalTerminal ? { canUseFilesystem: true } : null;
  }

  async createTerminal(config: any): Promise<any> {
    this.hasLocalTerminal = true;
    this.createdLocalTerminals += 1;
    this.localTerminalId = String(config.id);
    return {
      ...config,
      type: "local",
      capabilities: { supportsFilesystem: true },
    };
  }
}

const makeId = (id: string): Record<string, unknown> => ({
  _gyshellMessageId: id,
});

const makeUser = (id: string, content: string): HumanMessage =>
  new HumanMessage({
    content: `${USER_INPUT_TAG}${content}`,
    additional_kwargs: makeId(id),
  });

const makeAssistant = (id: string, content: string): AIMessage =>
  new AIMessage({
    content,
    additional_kwargs: makeId(id),
  });

const makeTool = (id: string, content: string): ToolMessage =>
  new ToolMessage({
    content,
    name: "exec_command",
    tool_call_id: `call-${id}`,
    additional_kwargs: makeId(id),
  } as any);

const makePrunedTool = (id: string, content: string): ToolMessage =>
  new ToolMessage({
    content,
    name: "exec_command",
    tool_call_id: `call-${id}`,
    additional_kwargs: {
      ...makeId(id),
      [TokenManager.PRUNE_FLAG_KEY]: true,
    },
  } as any);

const unwrapZeroRetentionExport = (wrapped: string): string => {
  const logicalLines: string[] = [];
  let pendingLogicalLine: string[] = [];
  let expectedPart = 0;
  let expectedParts = 0;

  const flushPending = (): void => {
    if (pendingLogicalLine.length === 0) return;
    assert.equal(expectedPart, expectedParts);
    logicalLines.push(pendingLogicalLine.join(""));
    pendingLogicalLine = [];
    expectedPart = 0;
    expectedParts = 0;
  };

  for (const line of wrapped.split("\n")) {
    const chunk = line.match(
      /^\[\[GYSHELL-WRAPPED-LINE-V1 logical=(\d+) part=(\d+)\/(\d+)\]\] (.*)$/,
    );
    if (!chunk) {
      flushPending();
      logicalLines.push(
        line.startsWith("[[GYSHELL-LITERAL-LINE-V1]]")
          ? line.slice("[[GYSHELL-LITERAL-LINE-V1]]".length)
          : line,
      );
      continue;
    }

    const part = Number(chunk[2]);
    const parts = Number(chunk[3]);
    if (part === 1) {
      flushPending();
      expectedParts = parts;
    }
    assert.equal(part, expectedPart + 1);
    assert.equal(parts, expectedParts);
    expectedPart = part;
    pendingLogicalLine.push(chunk[4]);
  }
  flushPending();
  return logicalLines.join("\n");
};

const makeMessages = (): BaseMessage[] => [
  new SystemMessage({
    content: "System instruction",
    additional_kwargs: makeId("backend-system"),
  }),
  makeUser("backend-user-1", "first historical request"),
  makeAssistant("backend-assistant-1", "first historical answer"),
  makeTool(
    "backend-tool-1",
    `command output head\n${"x".repeat(4_000)}\ncommand output tail`,
  ),
  makeUser("backend-user-2", "second historical request"),
  makeAssistant("backend-assistant-2", "second historical answer"),
  makeUser("backend-user-3", "third protected request"),
  makeAssistant("backend-assistant-3", "third protected answer"),
  makeUser("backend-user-4", "fourth protected request"),
];

const seedUiHistory = (
  uiHistory: UIHistoryService,
  options?: { omitProtectedAnchor?: boolean },
): void => {
  const sessionId = "session-1";
  uiHistory.recordEvent(sessionId, {
    type: "user_input",
    content: "first historical request",
    messageId: "backend-user-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "say",
    content: "first historical answer",
    messageId: "backend-assistant-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "command_started",
    command: "npm test",
    commandId: "cmd-1",
    messageId: "backend-tool-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "command_finished",
    commandId: "cmd-1",
    exitCode: 0,
    outputDelta: "command output tail",
    messageId: "backend-tool-1",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "user_input",
    content: "second historical request",
    messageId: "backend-user-2",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "say",
    content: "second historical answer",
    messageId: "backend-assistant-2",
  } as any);

  if (!options?.omitProtectedAnchor) {
    uiHistory.recordEvent(sessionId, {
      type: "user_input",
      content: "third protected request",
      messageId: "backend-user-3",
    } as any);
  }
  uiHistory.recordEvent(sessionId, {
    type: "say",
    content: "third protected answer",
    messageId: "backend-assistant-3",
  } as any);
  uiHistory.recordEvent(sessionId, {
    type: "user_input",
    content: "fourth protected request",
    messageId: "backend-user-4",
  } as any);
  uiHistory.flush(sessionId);
  uiHistory.renameSession(sessionId, "Fallback Session");
};

const createAgentHarness = (options?: {
  hasLocalTerminal?: boolean;
  omitProtectedAnchor?: boolean;
}): {
  agent: AgentService_v2;
  terminalService: FakeTerminalService;
  chatHistory: ChatHistoryService;
  tempDir: string;
  events: any[];
  cleanup: () => void;
} => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gyshell-compaction-fallback-"),
  );
  const store = new HistorySqliteStore({
    filePath: path.join(tempDir, "history.sqlite3"),
  });
  const chatHistory = new ChatHistoryService({ store });
  const uiHistory = new UIHistoryService({ store });
  seedUiHistory(uiHistory, {
    omitProtectedAnchor: options?.omitProtectedAnchor,
  });

  const terminalService = new FakeTerminalService(
    options?.hasLocalTerminal !== false,
  );

  const agent = new AgentService_v2(
    terminalService as any,
    {} as any,
    { getActiveTools: () => [] } as any,
    { getEnabledSkills: async () => [] } as any,
    { getMemorySnapshot: async () => ({ enabled: false, content: "" }) } as any,
    uiHistory,
    chatHistory,
  );
  (agent as any).passChatTempExportService = new PassChatTempExportService({
    baseDir: path.join(tempDir, "pass-chat-exports"),
    maxFiles: 20,
  });
  (agent as any).fallbackCompactionHistoryExportService =
    new PassChatTempExportService({
      baseDir: path.join(tempDir, "fallback-compaction-history"),
      maxFiles: null,
      groupBySession: true,
    });
  const events: any[] = [];
  agent.setEventPublisher((_sessionId, event) => {
    events.push(event);
  });

  return {
    agent,
    terminalService,
    chatHistory,
    tempDir,
    events,
    cleanup: () => {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
};

const runFallbackCompaction = async (
  agent: AgentService_v2,
  messages: BaseMessage[],
  mode: "throw" | "empty" = "throw",
): Promise<{ changed: boolean; messages: BaseMessage[] }> => {
  (agent as any).getCompactionModelDecision = async () => {
    if (mode === "empty") return { summary: "" };
    throw new Error("compaction input exceeded context");
  };
  return await (agent as any).tryCompactHistory(
    "session-1",
    messages,
    undefined,
  );
};

const forceOrdinaryCompactionFailure = (agent: AgentService_v2): void => {
  (agent as any).getCompactionModelDecision = async () => {
    throw new Error("ordinary compaction unavailable");
  };
  (agent as any).buildDeterministicFallbackSummary = async () => {
    throw new Error("deterministic emergency unavailable");
  };
};

await runCase("legacy token estimation contract remains exact", () => {
  const toolCall = new AIMessage({
    content: "",
    tool_calls: [
      {
        id: "large-command",
        name: "exec_command",
        args: { cmd: `printf %s ${"A".repeat(120_000)}` },
      },
    ],
  });
  assert.equal(TokenManager.estimate("x".repeat(40_003)), 10_001);
  assert.equal(TokenManager.estimate("界".repeat(16_000)), 4_000);
  assert.equal(TokenManager.estimateMessages([toolCall]), 0);
  assert.equal(TokenManager.isOverflow(70_000, 80_000), false);
  assert.equal(TokenManager.isOverflow(70_001, 80_000), true);
});

await runCase(
  "token estimation excludes typed image_url parts without changing text estimation",
  () => {
    const textPart = { type: "text" as const, text: "x".repeat(4_000) };
    const textOnly = new HumanMessage({ content: [textPart] as any });
    const withLargeImage = new HumanMessage({
      content: [
        textPart,
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${"A".repeat(1_000_000)}`,
          },
        },
      ] as any,
    });

    assert.equal(
      TokenManager.estimateMessages([withLargeImage]),
      TokenManager.estimateMessages([textOnly]),
    );
    assert.equal(
      TokenManager.estimateMessages([
        new HumanMessage("data:image/png;base64," + "A".repeat(4_000)),
      ]),
      TokenManager.estimate("data:image/png;base64," + "A".repeat(4_000)),
      "plain text that happens to contain a data URI must keep the legacy estimator",
    );
  },
);

await runCase(
  "context overflow classification is high-confidence and skips generic retry",
  async () => {
    const positives = [
      { status: 400, error: { code: "context_length_exceeded" } },
      {
        error: {
          metadata: {
            raw: JSON.stringify({
              error: { type: "context_window_exceeded" },
            }),
          },
        },
      },
      { errors: [{ code: "input_too_long" }] },
      new Error(
        "This endpoint's maximum context length is 262144 tokens. However, you requested about 1536517 tokens.",
      ),
      { message: "Your input exceeds the context window of this model." },
      { response: { data: { message: "Prompt is too long: 9001 tokens" } } },
    ];
    const negatives = [
      { status: 400 },
      { status: 413, type: "invalid_request_error" },
      { status: 400, error: { message: "Invalid tool schema" } },
      { status: 400, message: "max_tokens must be at least 1" },
      { status: 429, message: "Too many requests" },
      { response_metadata: { finish_reason: "length" } },
    ];

    positives.forEach((error) =>
      assert.equal(isContextWindowExceededError(error), true),
    );
    negatives.forEach((error) =>
      assert.equal(isContextWindowExceededError(error), false),
    );

    let attempts = 0;
    await assert.rejects(
      () =>
        invokeWithRetry(
          async () => {
            attempts += 1;
            throw positives[0];
          },
          4,
          [0, 0, 0, 0],
        ),
      (error) => error === positives[0],
    );
    assert.equal(attempts, 1);
  },
);

await runCase(
  "main-request limits ignore the compaction model and switch after first-turn thinking",
  () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const binding = {
        globalMaxTokens: 240_000,
        thinkingMaxTokens: 80_000,
        compactionMaxTokens: 16_000,
      };
      assert.equal(
        (agent as any).getNextMainRequestMaxTokens(binding, {
          firstTurnThinkingModelEnabled: false,
          modelRequestPassCount: 0,
        }),
        240_000,
      );
      assert.equal(
        (agent as any).getNextMainRequestMaxTokens(binding, {
          firstTurnThinkingModelEnabled: true,
          modelRequestPassCount: 0,
        }),
        80_000,
      );
      assert.equal(
        (agent as any).getNextMainRequestMaxTokens(binding, {
          firstTurnThinkingModelEnabled: true,
          modelRequestPassCount: 1,
        }),
        240_000,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "provider context overflow compacts once and retries the main request once",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const trace: string[] = [];
      const contextError = {
        status: 400,
        error: { code: "context_length_exceeded" },
      };
      const compactedMarker = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}provider recovery`,
        additional_kwargs: {
          _gyshellMessageId: "provider-recovery-marker",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
        },
      });
      (agent as any).tryCompactHistory = async (
        _sessionId: string,
        messages: BaseMessage[],
      ) => {
        trace.push("compact");
        return { changed: true, messages: [...messages, compactedMarker] };
      };

      let requests = 0;
      const result = await (agent as any).invokeMainModelWithContextRecovery({
        sessionId: "session-1",
        historyMessages: makeMessages(),
        modelSupportsImage: true,
        maxTokens: 80_000,
        canRecover: () => true,
        request: async (messages: BaseMessage[]) => {
          requests += 1;
          trace.push(
            messages.some((message) =>
              TokenManager.hasLastCompactionFlag(message),
            )
              ? "request-compacted"
              : "request-original",
          );
          if (requests === 1) throw contextError;
          return "accepted";
        },
      });

      assert.deepEqual(trace, [
        "request-original",
        "compact",
        "request-compacted",
      ]);
      assert.equal(result.response, "accepted");
      assert.ok(result.historyMessages.includes(compactedMarker));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "main-request context recovery is bounded and ignores unrelated 400 errors",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const contextError = {
        status: 400,
        error: { code: "context_length_exceeded" },
      };
      const secondContextError = {
        status: 400,
        message: "Your input exceeds the context window of this model.",
      };
      let compactions = 0;
      (agent as any).tryCompactHistory = async (
        _sessionId: string,
        messages: BaseMessage[],
      ) => {
        compactions += 1;
        const marker = new HumanMessage({
          content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}bounded recovery`,
          additional_kwargs: {
            [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
          },
        });
        return { changed: true, messages: [...messages, marker] };
      };

      let requests = 0;
      await assert.rejects(
        () =>
          (agent as any).invokeMainModelWithContextRecovery({
            sessionId: "session-1",
            historyMessages: makeMessages(),
            modelSupportsImage: true,
            maxTokens: 80_000,
            canRecover: () => true,
            request: async () => {
              requests += 1;
              throw requests === 1 ? contextError : secondContextError;
            },
          }),
        (error) => error === secondContextError,
      );
      assert.equal(requests, 2);
      assert.equal(compactions, 1);

      const unrelatedError = {
        status: 400,
        error: { message: "Invalid tool schema" },
      };
      await assert.rejects(
        () =>
          (agent as any).invokeMainModelWithContextRecovery({
            sessionId: "session-1",
            historyMessages: makeMessages(),
            modelSupportsImage: true,
            maxTokens: 80_000,
            canRecover: () => true,
            request: async () => {
              throw unrelatedError;
            },
          }),
        (error) => error === unrelatedError,
      );
      assert.equal(compactions, 1);

      await assert.rejects(
        () =>
          (agent as any).invokeMainModelWithContextRecovery({
            sessionId: "session-1",
            historyMessages: makeMessages(),
            modelSupportsImage: true,
            maxTokens: 80_000,
            canRecover: () => false,
            request: async () => {
              throw contextError;
            },
          }),
        (error) => error === contextError,
      );
      assert.equal(
        compactions,
        1,
        "a context error after any streamed chunk must fail closed",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "an encoded image does not trigger compaction far below an 80k window",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      let compactionCalls = 0;
      (agent as any).tryCompactHistory = async () => {
        compactionCalls += 1;
        return { changed: false, messages: [] };
      };

      const node = (agent as any).createTokenManagerNode();
      await node.invoke({
        sessionId: "session-1",
        messages: [
          new HumanMessage({
            content: [
              { type: "text", text: `${USER_INPUT_TAG}continue` },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${"A".repeat(1_000_000)}`,
                },
              },
            ] as any,
          }),
        ],
        token_state: { current_tokens: 47_463, max_tokens: 80_000 },
        pendingToolCalls: [],
        pendingToolSupplementMessages: [],
      });
      assert.equal(compactionCalls, 0);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "ordinary model compaction succeeds before deterministic or zero-retention fallback",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const trace: string[] = [];
      (agent as any).getCompactionModelDecision = async () => {
        trace.push("ordinary-model");
        return { summary: "ordinary model summary" };
      };
      (agent as any).buildDeterministicFallbackSummary = async () => {
        trace.push("deterministic-emergency");
        throw new Error("deterministic fallback must not run");
      };
      (agent as any).buildZeroRetentionCompactionCandidate = async () => {
        trace.push("zero-retention");
        throw new Error("zero-retention must not run");
      };

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        makeMessages(),
        undefined,
        { maxTokens: 80_000 },
      );
      const marker = result.messages.find((message: BaseMessage) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      assert.deepEqual(trace, ["ordinary-model"]);
      assert.equal(
        marker.additional_kwargs?.zero_retention_compaction,
        undefined,
      );
      assert.equal(
        marker.additional_kwargs?.[
          TokenManager.COMPACTION_PROTECTED_ROUNDS_KEY
        ],
        undefined,
      );
      assert.equal(
        events.find((event) => event.type === "compaction_boundary")
          ?.protectedNormalRounds,
        2,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "deterministic emergency succeeds before zero-retention fallback",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const trace: string[] = [];
      (agent as any).getCompactionModelDecision = async () => {
        trace.push("ordinary-model");
        throw new Error("ordinary model unavailable");
      };
      (agent as any).buildDeterministicFallbackSummary = async () => {
        trace.push("deterministic-emergency");
        return "deterministic emergency summary";
      };
      (agent as any).buildZeroRetentionCompactionCandidate = async () => {
        trace.push("zero-retention");
        throw new Error("zero-retention must not run");
      };

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        makeMessages(),
        undefined,
        { maxTokens: 80_000 },
      );
      const marker = result.messages.find((message: BaseMessage) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      assert.deepEqual(trace, ["ordinary-model", "deterministic-emergency"]);
      assert.equal(marker.additional_kwargs?.fallback_compaction, true);
      assert.equal(
        marker.additional_kwargs?.zero_retention_compaction,
        undefined,
      );
      assert.equal(
        events.find((event) => event.type === "compaction_boundary")
          ?.protectedNormalRounds,
        2,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "deterministic digest stays inside a hard character budget",
  () => {
    const messages = [
      makeUser("u1", "first request " + "a".repeat(20_000)),
      makeAssistant("a1", "answer " + "b".repeat(20_000)),
      makeTool("t1", "tool " + "c".repeat(20_000)),
    ];
    const result = buildDeterministicCompactionDigest({
      messages,
      totalMessageCount: messages.length,
      protectedTailMessageCount: 2,
      maxChars: 4_000,
    });

    assert.ok(result.digest.length <= 4_000);
    assert.ok(result.digest.includes("Emergency deterministic compaction"));
    assert.ok(result.digest.includes("Selected digest entries"));
  },
);

await runCase(
  "model failure inserts fallback compaction with exported prefix history",
  async () => {
    const { agent, tempDir, events, cleanup } = createAgentHarness();
    try {
      const messages = makeMessages();
      const result = await runFallbackCompaction(agent, messages);

      assert.equal(result.changed, true);
      assert.equal(result.messages.length, messages.length + 1);
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      assert.ok(summary, "fallback summary should be inserted");
      assert.equal(summary.additional_kwargs?.fallback_compaction, true);
      assert.match(String(summary.content), /^WHAT_HAVE_DONE_IN_THE_PAST:/);
      assert.ok(String(summary.content).includes(PASS_CHAT_HISTORY_TAG));
      assert.ok(
        String(summary.content).includes("Markdown Export Path:"),
        "summary should include a hidden exported-history path",
      );

      const pathMatch = String(summary.content).match(
        /Markdown Export Path: (.+)/,
      );
      assert.ok(pathMatch?.[1], "export path should be present");
      const exportPath = pathMatch![1].trim();
      assert.ok(
        exportPath.startsWith(
          path.join(tempDir, "fallback-compaction-history"),
        ),
      );
      assert.match(
        path.basename(exportPath),
        /^pass-chat_[a-f0-9]{12}_[a-f0-9]{12}\.md$/,
      );
      assert.ok(fs.existsSync(exportPath));
      const exported = fs.readFileSync(exportPath, "utf8");
      assert.ok(exported.includes("first historical request"));
      assert.ok(exported.includes("second historical request"));
      assert.ok(!exported.includes("third protected request"));
      assert.ok(!exported.includes("fourth protected request"));

      const insertionIndex = (agent as any).findCompactionInsertionIndex(
        messages,
      );
      assert.equal(
        result.messages[insertionIndex + 1],
        messages[insertionIndex],
        "first protected backend message should remain exact after the summary",
      );
      assert.equal(
        result.messages[result.messages.length - 1],
        messages[messages.length - 1],
        "last protected backend message should remain exact",
      );

      const view = buildDynamicRequestHistory(result.messages);
      assert.ok(TokenManager.estimateMessages(view) < 20_000);
      assert.ok(
        view.some((message) =>
          String(message.content).includes("third protected request"),
        ),
        "protected tail should be model-visible",
      );
      assert.ok(events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
    } finally {
      cleanup();
    }
  },
);

await runCase("fallback exported history title stays single-line", async () => {
  const { agent, cleanup } = createAgentHarness();
  try {
    (agent as any).uiHistoryService.renameSession(
      "session-1",
      `long fallback title ${"word ".repeat(500)}`,
    );

    const result = await runFallbackCompaction(agent, makeMessages());
    const summary = result.messages.find((message) =>
      TokenManager.hasLastCompactionFlag(message),
    ) as any;
    const lines = String(summary.content).split("\n");
    const titleIndex = lines.findIndex((line) =>
      line.startsWith("Chat Title:"),
    );

    assert.notEqual(titleIndex, -1, "summary should include a chat title");
    assert.equal(
      lines[titleIndex + 1]?.startsWith("Chat Session ID:"),
      true,
      "a clipped chat title must not spill onto unlabeled lines",
    );
    assert.ok(lines[titleIndex].includes("...[truncated "));
  } finally {
    cleanup();
  }
});

await runCase(
  "deleting a session removes durable fallback history exports",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const result = await runFallbackCompaction(agent, makeMessages());
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      const pathMatch = String(summary.content).match(
        /Markdown Export Path: (.+)/,
      );
      assert.ok(pathMatch?.[1], "export path should be present");
      const exportPath = pathMatch![1].trim();
      assert.ok(fs.existsSync(exportPath));

      agent.deleteChatSession("session-1");

      assert.equal(fs.existsSync(exportPath), false);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "rollback removes only unreferenced fallback history exports",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const exportPath = await (
        agent as any
      ).fallbackCompactionHistoryExportService.exportMarkdown({
        sessionId: "rollback-session",
        title: "Rollback fallback history",
        markdown: "# Rollback fallback history\nexact old detail",
      });
      const summary = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${exportPath}\nInstruction: read if needed.\n`,
        additional_kwargs: {
          _gyshellMessageId: "rollback-summary",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
          fallback_compaction: true,
        },
      });
      const userOne = makeUser("rollback-user-1", "protected one");
      const assistantOne = makeAssistant("rollback-assistant-1", "answer one");
      const userTwo = makeUser("rollback-user-2", "protected two");
      const assistantTwo = makeAssistant("rollback-assistant-2", "answer two");
      const storedMessages = mapChatMessagesToStoredMessages([
        summary,
        userOne,
        assistantOne,
        userTwo,
        assistantTwo,
      ]) as any[];
      (agent as any).chatHistoryService.saveSession({
        id: "rollback-session",
        title: "Rollback Session",
        lastCheckpointOffset: 0,
        messages: new Map([
          ["rollback-summary", storedMessages[0]],
          ["rollback-user-1", storedMessages[1]],
          ["rollback-assistant-1", storedMessages[2]],
          ["rollback-user-2", storedMessages[3]],
          ["rollback-assistant-2", storedMessages[4]],
        ]),
      });

      assert.ok(fs.existsSync(exportPath));
      const keepResult = agent.rollbackToMessage(
        "rollback-session",
        "rollback-assistant-2",
      );
      assert.equal(keepResult.ok, true);
      assert.ok(
        fs.existsSync(exportPath),
        "rollback that keeps the summary should keep its export",
      );

      const removeResult = agent.rollbackToMessage(
        "rollback-session",
        "rollback-summary",
      );
      assert.equal(removeResult.ok, true);
      assert.equal(
        fs.existsSync(exportPath),
        false,
        "rollback that removes the fallback summary should delete its export",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "rollback ignores fallback export paths owned by another session",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const otherSessionPath = await (
        agent as any
      ).fallbackCompactionHistoryExportService.exportMarkdown({
        sessionId: "other-rollback-session",
        title: "Other rollback fallback history",
        markdown: "# Other rollback fallback history\n",
      });
      const summary = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${otherSessionPath}\nInstruction: read if needed.\n`,
        additional_kwargs: {
          _gyshellMessageId: "cross-rollback-summary",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
          fallback_compaction: true,
        },
      });
      const user = makeUser("cross-rollback-user", "protected one");
      const assistant = makeAssistant("cross-rollback-assistant", "answer one");
      const storedMessages = mapChatMessagesToStoredMessages([
        summary,
        user,
        assistant,
      ]) as any[];
      (agent as any).chatHistoryService.saveSession({
        id: "rollback-cross-session",
        title: "Rollback Cross Session",
        lastCheckpointOffset: 0,
        messages: new Map([
          ["cross-rollback-summary", storedMessages[0]],
          ["cross-rollback-user", storedMessages[1]],
          ["cross-rollback-assistant", storedMessages[2]],
        ]),
      });

      assert.ok(fs.existsSync(otherSessionPath));

      const removeResult = agent.rollbackToMessage(
        "rollback-cross-session",
        "cross-rollback-summary",
      );

      assert.equal(removeResult.ok, true);
      assert.equal(
        fs.existsSync(otherSessionPath),
        true,
        "rollback must not delete a fallback export owned by another session",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase("empty model summary also uses fallback compaction", async () => {
  const { agent, cleanup } = createAgentHarness();
  try {
    const result = await runFallbackCompaction(agent, makeMessages(), "empty");
    const summary = result.messages.find((message) =>
      TokenManager.hasLastCompactionFlag(message),
    ) as any;

    assert.equal(result.changed, true);
    assert.equal(summary.additional_kwargs?.fallback_compaction, true);
    assert.ok(
      String(summary.content).includes(
        "Compaction model failure reason: empty compaction summary",
      ),
    );
  } finally {
    cleanup();
  }
});

await runCase(
  "fallback compaction survives missing UI anchor without exporting tail",
  async () => {
    const { agent, cleanup } = createAgentHarness({
      omitProtectedAnchor: true,
    });
    try {
      const result = await runFallbackCompaction(agent, makeMessages());
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;

      assert.equal(result.changed, true);
      assert.ok(
        String(summary.content).includes(
          "protected-tail UI anchor was not found",
        ),
      );
      assert.ok(
        !String(summary.content).includes("Markdown Export Path:"),
        "missing anchor should not export an imprecise history slice",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "fallback digest respects previous compaction and pruned tool materialization",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const previousSummary = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}previous compacted safe summary`,
        additional_kwargs: {
          _gyshellMessageId: "backend-previous-summary",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
        },
      });
      const messages: BaseMessage[] = [
        new SystemMessage({
          content: "System instruction",
          additional_kwargs: makeId("backend-system"),
        }),
        makeUser("backend-old-hidden-user", "RAW_BEFORE_LAST_COMPACTION"),
        makePrunedTool(
          "backend-old-hidden-tool",
          "RAW_PRUNED_BEFORE_LAST_COMPACTION",
        ),
        previousSummary,
        makeUser("backend-visible-user-1", "visible historical request 1"),
        makePrunedTool(
          "backend-visible-pruned-tool",
          "RAW_PRUNED_AFTER_LAST_COMPACTION",
        ),
        makeAssistant("backend-visible-assistant-1", "visible answer 1"),
        makeUser("backend-visible-user-2", "visible historical request 2"),
        makeAssistant("backend-visible-assistant-2", "visible answer 2"),
        makeUser("backend-protected-user-1", "protected request 1"),
        makeAssistant("backend-protected-assistant-1", "protected answer 1"),
        makeUser("backend-protected-user-2", "protected request 2"),
      ];

      const result = await runFallbackCompaction(agent, messages);
      const summary = [...result.messages]
        .reverse()
        .find((message) => TokenManager.hasLastCompactionFlag(message)) as any;
      const content = String(summary.content);

      assert.ok(content.includes("previous compacted safe summary"));
      assert.ok(content.includes(TokenManager.PRUNED_CONTENT_PLACEHOLDER));
      assert.ok(!content.includes("RAW_BEFORE_LAST_COMPACTION"));
      assert.ok(!content.includes("RAW_PRUNED_BEFORE_LAST_COMPACTION"));
      assert.ok(!content.includes("RAW_PRUNED_AFTER_LAST_COMPACTION"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "fallback summary stays under hard cap with huge failure diagnostics",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      (agent as any).uiHistoryService.renameSession(
        "session-1",
        "huge title ".repeat(30_000),
      );
      (agent as any).getCompactionModelDecision = async () => {
        throw new Error("huge provider error ".repeat(30_000));
      };

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        makeMessages(),
        undefined,
      );
      const summary = result.messages.find((message: BaseMessage) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      const content = String(summary.content);

      assert.equal(result.changed, true);
      assert.ok(
        content.length <= 60_000 + WHAT_HAVE_DONE_IN_THE_PAST_TAG.length,
      );
      assert.ok(content.includes("Markdown Export Path:"));
      assert.ok(content.includes("huge provider error"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "fallback guidance handles unavailable local terminal",
  async () => {
    const { agent, cleanup } = createAgentHarness({
      hasLocalTerminal: false,
    });
    try {
      const result = await runFallbackCompaction(agent, makeMessages());
      const summary = result.messages.find((message) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;

      assert.ok(
        String(summary.content).includes(
          "Recommended Local Terminal Tab: unavailable",
        ),
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "emergency fallback cannot bypass the ordinary minimum-round guard",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const trace: string[] = [];
      (agent as any).getCompactionModelDecision = async () => {
        trace.push("ordinary-model");
        throw new Error("must not run");
      };
      (agent as any).buildDeterministicFallbackSummary = async () => {
        trace.push("deterministic-emergency");
        throw new Error("must not run");
      };
      (agent as any).buildZeroRetentionCompactionCandidate = async () => {
        trace.push("zero-retention");
        throw new Error("must not run");
      };

      const messages = [
        new SystemMessage("system"),
        makeUser("guard-user-1", "round one"),
        makeAssistant("guard-assistant-1", "answer one"),
        makeUser("guard-user-2", "round two"),
      ];
      const result = await (agent as any).tryCompactHistory(
        "session-1",
        messages,
        undefined,
        { maxTokens: 15_000 },
      );

      assert.equal(result.changed, false);
      assert.equal(result.messages, messages);
      assert.deepEqual(trace, []);
      assert.ok(
        !events.some(
          (event) =>
            event.type === "sub_tool_started" &&
            event.title === "Compaction...",
        ),
      );
      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "emergency fallback cannot bypass an ordinary marker collision",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const trace: string[] = [];
      (agent as any).getCompactionModelDecision = async () => {
        trace.push("ordinary-model");
        throw new Error("must not run");
      };
      (agent as any).buildDeterministicFallbackSummary = async () => {
        trace.push("deterministic-emergency");
        throw new Error("must not run");
      };
      (agent as any).buildZeroRetentionCompactionCandidate = async () => {
        trace.push("zero-retention");
        throw new Error("must not run");
      };

      const messages = makeMessages();
      (messages[5] as any).additional_kwargs = {
        ...((messages[5] as any).additional_kwargs || {}),
        [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
      };
      const result = await (agent as any).tryCompactHistory(
        "session-1",
        messages,
        undefined,
        { maxTokens: 15_000 },
      );

      assert.equal(result.changed, false);
      assert.equal(result.messages, messages);
      assert.deepEqual(trace, []);
      assert.ok(
        !events.some(
          (event) =>
            event.type === "sub_tool_started" &&
            event.title === "Compaction...",
        ),
      );
      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "abort errors do not trigger deterministic fallback",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const abortError = new Error("AbortError");
      abortError.name = "AbortError";
      (agent as any).getCompactionModelDecision = async () => {
        throw abortError;
      };

      await assert.rejects(
        () =>
          (agent as any).tryCompactHistory(
            "session-1",
            makeMessages(),
            undefined,
          ),
        /AbortError/,
      );
      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "abort during deterministic fallback does not insert compaction marker",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const controller = new AbortController();
      (agent as any).getCompactionModelDecision = async () => {
        throw new Error("compaction input exceeded context");
      };
      const exportService = (agent as any)
        .fallbackCompactionHistoryExportService;
      const originalExportMarkdown =
        exportService.exportMarkdown.bind(exportService);
      let exportedPath: string | null = null;
      exportService.exportMarkdown = async (input: any) => {
        exportedPath = await originalExportMarkdown(input);
        controller.abort();
        return exportedPath;
      };

      await assert.rejects(
        () =>
          (agent as any).tryCompactHistory(
            "session-1",
            makeMessages(),
            controller.signal,
          ),
        /AbortError/,
      );

      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
      assert.ok(exportedPath, "the abort test should write an export first");
      assert.equal(
        fs.existsSync(exportedPath),
        false,
        "aborting after export must clean up the unreferenced export",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "abort after model summary success finishes compaction progress",
  async () => {
    const { agent, events, cleanup } = createAgentHarness();
    try {
      const controller = new AbortController();
      (agent as any).getCompactionModelDecision = async () => {
        controller.abort();
        return { summary: "model summary" };
      };

      await assert.rejects(
        () =>
          (agent as any).tryCompactHistory(
            "session-1",
            makeMessages(),
            controller.signal,
          ),
        /AbortError/,
      );

      assert.ok(!events.some((event) => event.type === "compaction_boundary"));
      assert.ok(events.some((event) => event.type === "sub_tool_finished"));
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "existing compaction marker still compacts request view after profile max increase",
  () => {
    const messages = makeMessages();
    const summary = new HumanMessage({
      content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}previous summary`,
      additional_kwargs: {
        _gyshellMessageId: "backend-summary",
        [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
      },
    });
    const withMarker = [...messages.slice(0, 4), summary, ...messages.slice(4)];
    const view = buildDynamicRequestHistory(withMarker);

    assert.ok(
      view.some((message) => TokenManager.hasLastCompactionFlag(message)),
    );
    assert.ok(
      !view.some((message) =>
        String(message.content).includes("first historical request"),
      ),
      "request view should keep the last compaction boundary instead of expanding old history",
    );
    assert.ok(
      view.some((message) =>
        String(message.content).includes("third protected request"),
      ),
    );
  },
);

await runCase(
  "token node sends a newly pruned view normally before any compaction",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const oldLargeTool = makeTool("old-large", "x".repeat(120_000));
      const recentTools = Array.from({ length: 10 }, (_, index) =>
        makeTool(`recent-${index}`, "ok"),
      );
      const messages = [
        makeUser("large-user", "y".repeat(100_000)),
        oldLargeTool,
        ...recentTools,
      ];
      let compactionCalls = 0;
      (agent as any).tryCompactHistory = async (
        _sessionId: string,
        nextMessages: BaseMessage[],
      ) => {
        compactionCalls += 1;
        assert.equal(
          TokenManager.hasPruneLabel(nextMessages[1]),
          true,
          "compaction must receive the newly pruned history",
        );
        return { changed: false, messages: nextMessages };
      };

      const node = (agent as any).createTokenManagerNode();
      const prunedResult = await node.invoke({
        sessionId: "session-1",
        messages,
        token_state: { current_tokens: 100_000, max_tokens: 30_000 },
        pendingToolCalls: [],
        pendingToolSupplementMessages: [],
      });
      assert.equal(
        compactionCalls,
        0,
        "a local post-prune estimate must not trigger compaction",
      );
      assert.equal(
        TokenManager.hasPruneLabel(prunedResult.messages[1]),
        true,
        "the labeled history must continue to the normal model request",
      );

      compactionCalls = 0;
      await node.invoke({
        sessionId: "session-1",
        messages: [
          makeUser("small-user", "continue"),
          oldLargeTool,
          ...recentTools,
        ],
        token_state: { current_tokens: 100_000, max_tokens: 40_000 },
        pendingToolCalls: [],
        pendingToolSupplementMessages: [],
      });
      assert.equal(
        compactionCalls,
        0,
        "the stale pre-prune usage count must not force compaction after the materialized request fits",
      );

      compactionCalls = 0;
      await node.invoke({
        sessionId: "session-1",
        messages: [
          makeUser("usage-only-user", "继续"),
          makePrunedTool("already-pruned", "old output"),
        ],
        token_state: { current_tokens: 100_000, max_tokens: 40_000 },
        pendingToolCalls: [],
        pendingToolSupplementMessages: [],
      });
      assert.equal(
        compactionCalls,
        1,
        "an overflow reported by the provider must remain authoritative when prune changed nothing",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero-retention runs only after ordinary and deterministic compaction fail",
  async () => {
    const { agent, tempDir, events, cleanup } = createAgentHarness();
    try {
      const messages = makeMessages().map((message, index) => {
        if (index === 6) {
          return makeUser(
            "backend-user-3",
            `third protected request ${"p".repeat(40_000)}`,
          );
        }
        if (index === 8) {
          return makeUser(
            "backend-user-4",
            `fourth protected request ${"q".repeat(40_000)}`,
          );
        }
        return message;
      });
      forceOrdinaryCompactionFailure(agent);

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        messages,
        undefined,
        { maxTokens: 15_000 },
      );
      assert.equal(result.changed, true);
      const summary = result.messages[result.messages.length - 1] as any;
      assert.equal(summary.additional_kwargs?.zero_retention_compaction, true);
      assert.equal(
        summary.additional_kwargs?.[
          TokenManager.COMPACTION_PROTECTED_ROUNDS_KEY
        ],
        0,
      );

      const view = buildDynamicRequestHistory(result.messages);
      assert.equal(
        view.includes(messages[1]),
        false,
        "no original historical turn may remain in the active request view",
      );
      assert.equal(
        view.some((message) =>
          String(message.content).includes(
            "Zero-retention emergency context recovery is active",
          ),
        ),
        true,
      );

      const pathMatch = String(summary.content).match(
        /Markdown Export Path: (.+)/,
      );
      assert.ok(pathMatch?.[1]);
      const exported = fs.readFileSync(pathMatch![1].trim(), "utf8");
      assert.ok(exported.includes("first historical request"));
      assert.ok(exported.includes("fourth protected request"));
      assert.ok(exported.includes("BEGIN_GYSHELL_BACKEND_HISTORY_JSON"));
      assert.ok(exported.includes("backend-user-4"));
      assert.ok(
        exported.includes("[[GYSHELL-WRAPPED-LINE-V1"),
        "oversized stored-message fields must use reversible physical-line chunks",
      );
      assert.ok(
        exported.split("\n").every((line) => line.length <= MAX_LINE_LENGTH),
        "every physical export line must stay below read_file's irreversible clipping limit",
      );
      const unwrapped = unwrapZeroRetentionExport(exported);
      assert.ok(
        unwrapped.includes(`third protected request ${"p".repeat(40_000)}`),
        "the reversible export must retain the complete oversized request",
      );
      assert.ok(
        unwrapped.includes(`fourth protected request ${"q".repeat(40_000)}`),
      );
      const firstReadPage = readTextFile({
        filePath: pathMatch![1].trim(),
        bytes: fs.readFileSync(pathMatch![1].trim()),
        offset: 0,
        limit: 5,
      });
      assert.match(firstReadPage, /File has more lines/);
      assert.ok(!firstReadPage.includes(`${"x".repeat(MAX_LINE_LENGTH)}...`));
      assert.equal(
        fs
          .readdirSync(path.join(tempDir, "fallback-compaction-history"))
          .filter((name) => name.endsWith(".md")).length,
        1,
        "zero-retention recovery should create exactly one managed export",
      );

      const boundary = events.find(
        (event) =>
          event.type === "compaction_boundary" &&
          event.protectedNormalRounds === 0,
      );
      assert.ok(boundary);
      assert.equal(boundary.boundaryTargetMessageId, undefined);
      assert.equal(boundary.boundaryPreviousMessageId, "backend-user-4");
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero-retention capsule fits the legacy estimate without truncating its export",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const messages = makeMessages().map((message, index) =>
        index === 8
          ? makeUser("backend-user-4", `继续未完成任务 ${"界".repeat(40_000)}`)
          : message,
      );
      forceOrdinaryCompactionFailure(agent);

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        messages,
        undefined,
        { maxTokens: 15_000 },
      );
      const marker = result.messages[result.messages.length - 1] as any;
      const requestView = buildDynamicRequestHistory(result.messages);
      assert.equal(marker.additional_kwargs?.zero_retention_compaction, true);
      assert.equal(
        TokenManager.isOverflow(
          TokenManager.estimateMessages(requestView),
          15_000,
        ),
        false,
      );
      const pathMatch = String(marker.content).match(
        /Markdown Export Path: (.+)/,
      );
      assert.ok(pathMatch?.[1]);
      const exported = unwrapZeroRetentionExport(
        fs.readFileSync(pathMatch![1].trim(), "utf8"),
      );
      assert.ok(
        exported.includes("界".repeat(4_000)),
        "adaptive prompt shrinking must not truncate the complete exported history",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "a committed zero-retention boundary recovers its exact marker after node failure",
  async () => {
    const { agent, chatHistory, events, cleanup } = createAgentHarness();
    try {
      const physicalRunId = "failed-model-run";
      const oldMarker = makeUser("old-compaction-marker", "old summary");
      (oldMarker as any).additional_kwargs = {
        ...(oldMarker as any).additional_kwargs,
        [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
      };
      const checkpointMessages = [...makeMessages(), oldMarker];
      const candidate = (agent as any).buildCompactionCandidate({
        messages: checkpointMessages,
        insertionIndex: checkpointMessages.length,
        summaryText: "zero-retention recovery bridge",
        logLabel: "test zero-retention compaction",
        protectedNormalRounds: 0,
        additionalKwargs: {
          fallback_compaction: true,
          zero_retention_compaction: true,
        },
      });
      (agent as any).activePhysicalRunIds.add(physicalRunId);
      (agent as any).commitCompactionCandidate(
        "session-1",
        candidate,
        "test-progress",
        physicalRunId,
      );
      (agent as any).graph = {
        getState: async () => ({
          values: {
            messages: checkpointMessages,
            pendingToolSupplementMessages: [],
          },
        }),
      };

      await (agent as any).trySaveSessionFromCheckpoint(
        "session-1",
        physicalRunId,
      );
      const boundary = events.find(
        (event) => event.type === "compaction_boundary",
      );
      const saved = chatHistory.loadSession("session-1");
      const savedIds = new Set(
        Array.from(saved?.messages.values() || []).map(
          (message: any) => message?.data?.additional_kwargs?._gyshellMessageId,
        ),
      );
      assert.equal(
        boundary.summaryMessageId,
        candidate.summaryMessageBackendId,
      );
      assert.equal(savedIds.has(candidate.summaryMessageBackendId), true);
      assert.equal(savedIds.has("old-compaction-marker"), true);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "checkpoint state newer than the exact zero-retention marker is never overwritten",
  async () => {
    const { agent, chatHistory, cleanup } = createAgentHarness();
    try {
      const physicalRunId = "completed-model-node-run";
      const candidate = (agent as any).buildCompactionCandidate({
        messages: makeMessages(),
        insertionIndex: makeMessages().length,
        summaryText: "zero-retention recovery bridge",
        logLabel: "test zero-retention compaction",
        protectedNormalRounds: 0,
        additionalKwargs: {
          fallback_compaction: true,
          zero_retention_compaction: true,
        },
      });
      const newerAssistant = makeAssistant(
        "assistant-after-compaction",
        "newer checkpoint content",
      );
      (agent as any).activePhysicalRunIds.add(physicalRunId);
      (agent as any).commitCompactionCandidate(
        "session-1",
        candidate,
        "test-progress",
        physicalRunId,
      );
      (agent as any).graph = {
        getState: async () => ({
          values: {
            messages: [...candidate.messages, newerAssistant],
            pendingToolSupplementMessages: [],
          },
        }),
      };

      await (agent as any).trySaveSessionFromCheckpoint(
        "session-1",
        physicalRunId,
      );
      const saved = chatHistory.loadSession("session-1");
      const savedIds = new Set(
        Array.from(saved?.messages.values() || []).map(
          (message: any) => message?.data?.additional_kwargs?._gyshellMessageId,
        ),
      );
      assert.equal(savedIds.has(candidate.summaryMessageBackendId), true);
      assert.equal(savedIds.has("assistant-after-compaction"), true);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero-retention recovery creates a local reader when only SSH tabs exist",
  async () => {
    const { agent, terminalService, cleanup } = createAgentHarness({
      hasLocalTerminal: false,
    });
    try {
      const messages = makeMessages().map((message, index) =>
        index === 8
          ? makeUser(
              "backend-user-4",
              `fourth protected request ${"q".repeat(80_000)}`,
            )
          : message,
      );
      forceOrdinaryCompactionFailure(agent);

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        messages,
        undefined,
        { maxTokens: 15_000 },
      );
      const marker = result.messages[result.messages.length - 1] as any;
      assert.equal(marker.additional_kwargs?.zero_retention_compaction, true);
      assert.equal(terminalService.createdLocalTerminals, 1);
      assert.match(
        String(
          marker.additional_kwargs?.zero_retention_local_terminal_id || "",
        ),
        /^local-/,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "ordinary compaction model is attempted without a local summary-request gate",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const messages = makeMessages().map((message, index) =>
        index === 1
          ? makeUser(
              "backend-user-1",
              `first historical request ${"x".repeat(120_000)}`,
            )
          : message,
      );
      let modelCalls = 0;
      (agent as any).getCompactionModelDecision = async () => {
        modelCalls += 1;
        return { summary: "ordinary summary" };
      };

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        messages,
        undefined,
        { maxTokens: 30_000 },
      );
      assert.equal(result.changed, true);
      assert.equal(modelCalls, 1);
      const marker = result.messages.find((message: BaseMessage) =>
        TokenManager.hasLastCompactionFlag(message),
      ) as any;
      assert.equal(
        marker.additional_kwargs?.zero_retention_compaction,
        undefined,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero-retention recovery rolls over the same export and only advances through model-consumed pages",
  async () => {
    const { agent, tempDir, cleanup } = createAgentHarness();
    try {
      const messages = makeMessages().map((message, index) => {
        if (index === 6) {
          return makeUser(
            "backend-user-3",
            `third protected request ${"p".repeat(40_000)}`,
          );
        }
        if (index === 8) {
          return makeUser(
            "backend-user-4",
            `fourth protected request ${"q".repeat(40_000)}`,
          );
        }
        return message;
      });
      forceOrdinaryCompactionFailure(agent);

      const initial = await (agent as any).tryCompactHistory(
        "session-1",
        messages,
        undefined,
        { maxTokens: 15_000 },
      );
      const initialMarker = initial.messages[
        initial.messages.length - 1
      ] as any;
      const filePath = String(initialMarker.content)
        .match(/Markdown Export Path: (.+)/)?.[1]
        ?.trim();
      assert.ok(filePath);
      const bytes = fs.readFileSync(filePath!);

      const makeReadCall = (
        id: string,
        offset: number,
        limit: number,
        recoveryReasoning?: string,
      ): AIMessage =>
        new AIMessage({
          content: recoveryReasoning
            ? ""
            : `Recovery page request at offset ${offset}`,
          tool_calls: [
            {
              id,
              name: "read_file",
              args: {
                tabIdOrName: "local-main",
                filePath,
                offset,
                limit,
              },
            },
          ],
          additional_kwargs: {
            ...makeId(`assistant-${id}`),
            ...(recoveryReasoning
              ? { reasoning_content: recoveryReasoning }
              : {}),
          },
        });
      const makeReadResult = (
        id: string,
        offset: number,
        limit: number,
      ): ToolMessage =>
        new ToolMessage({
          content: readTextFile({ filePath: filePath!, bytes, offset, limit }),
          name: "read_file",
          tool_call_id: id,
          additional_kwargs: makeId(`tool-${id}`),
        } as any);

      const firstPageCall = makeReadCall("recovery-page-1", 0, 5);
      const firstPageResult = makeReadResult("recovery-page-1", 0, 5);
      const secondPageCall = makeReadCall(
        "recovery-page-2",
        5,
        5,
        "DURABLE_REASONING_ONLY_RECOVERY reconstructed the header and first page",
      );
      const secondPageResult = makeReadResult("recovery-page-2", 5, 5);
      const firstRollover = await (agent as any).tryCompactHistory(
        "session-1",
        [
          ...initial.messages,
          firstPageCall,
          firstPageResult,
          secondPageCall,
          secondPageResult,
        ],
        undefined,
        { maxTokens: 15_000 },
      );
      const firstRolloverMarker = firstRollover.messages[
        firstRollover.messages.length - 1
      ] as any;
      assert.equal(
        firstRolloverMarker.additional_kwargs?.zero_retention_rollover,
        true,
      );
      assert.equal(
        firstRolloverMarker.additional_kwargs?.zero_retention_history_path,
        filePath,
      );
      assert.equal(
        firstRolloverMarker.additional_kwargs?.zero_retention_resume_after_line,
        5,
        "only page 1 had a later AI pass proving it was consumed",
      );
      assert.equal(
        firstRolloverMarker.additional_kwargs?.zero_retention_read_limit,
        2,
      );
      assert.ok(String(firstRolloverMarker.content).includes("offset=5"));
      assert.ok(
        String(firstRolloverMarker.content).includes(
          "DURABLE_REASONING_ONLY_RECOVERY",
        ),
        "reasoning-only recovery state must be copied into the next durable capsule before advancing the frontier",
      );
      assert.ok(
        String(firstRolloverMarker.content).includes(
          "before any model pass could consume it",
        ),
      );

      const retriedSecondPageCall = makeReadCall("recovery-page-2-retry", 5, 2);
      const retriedSecondPageResult = makeReadResult(
        "recovery-page-2-retry",
        5,
        2,
      );
      const thirdPageCall = makeReadCall("recovery-page-3", 7, 2);
      const thirdPageResult = makeReadResult("recovery-page-3", 7, 2);
      const secondRollover = await (agent as any).tryCompactHistory(
        "session-1",
        [
          ...firstRollover.messages,
          retriedSecondPageCall,
          retriedSecondPageResult,
          thirdPageCall,
          thirdPageResult,
        ],
        undefined,
        { maxTokens: 15_000 },
      );
      const secondRolloverMarker = secondRollover.messages[
        secondRollover.messages.length - 1
      ] as any;
      assert.equal(
        secondRolloverMarker.additional_kwargs
          ?.zero_retention_resume_after_line,
        7,
      );
      assert.equal(
        secondRolloverMarker.additional_kwargs?.zero_retention_read_limit,
        1,
        "an unconsumed retry must eventually back off to one physical line",
      );
      assert.equal(
        secondRolloverMarker.additional_kwargs?.zero_retention_history_path,
        filePath,
      );
      assert.equal(
        fs
          .readdirSync(path.join(tempDir, "fallback-compaction-history"))
          .filter((name) => name.endsWith(".md")).length,
        1,
        "rolling recovery must reuse the exact verified export",
      );
      assert.equal(
        buildDynamicRequestHistory(secondRollover.messages).some(
          (message) => message === thirdPageResult,
        ),
        false,
        "the unconsumed oversized page must be rolled out before the next model call",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "an inactive zero-retention marker restores ordinary compaction for new rounds",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      forceOrdinaryCompactionFailure(agent);
      const initial = await (agent as any).tryCompactHistory(
        "session-1",
        makeMessages(),
        undefined,
        { maxTokens: 15_000 },
      );
      const continuedMessages = [
        ...initial.messages,
        makeUser("post-zero-user-1", "new task round one"),
        makeAssistant("post-zero-assistant-1", "round one result"),
        makeUser("post-zero-user-2", "new task round two"),
        makeAssistant("post-zero-assistant-2", "round two result"),
        makeUser("post-zero-user-3", "new task round three"),
      ];
      const trace: string[] = [];
      (agent as any).getCompactionModelDecision = async () => {
        trace.push("ordinary-model");
        return { summary: "new rounds ordinary summary" };
      };
      (agent as any).buildZeroRetentionCompactionCandidate = async () => {
        trace.push("zero-retention");
        throw new Error("zero-retention must not replace new ordinary rounds");
      };

      const result = await (agent as any).tryCompactHistory(
        "session-1",
        continuedMessages,
        undefined,
        { maxTokens: 80_000 },
      );
      const latestMarker = [...result.messages]
        .reverse()
        .find((message) => TokenManager.hasLastCompactionFlag(message)) as any;
      assert.deepEqual(trace, ["ordinary-model"]);
      assert.equal(
        latestMarker.additional_kwargs?.zero_retention_compaction,
        undefined,
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero-retention frontier accepts only a verified opaque wrapped-line jump",
  () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const filePath = "/tmp/managed-zero-retention.md";
      const readCall = (id: string, offset: number): AIMessage =>
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id,
              name: "read_file",
              args: {
                tabIdOrName: "local-main",
                filePath,
                offset,
                limit: 1,
              },
            },
          ],
          additional_kwargs: makeId(`assistant-${id}`),
        });
      const firstResult = new ToolMessage({
        content: [
          "<file>",
          `00001| [[GYSHELL-WRAPPED-LINE-V1 logical=1 part=1/4]] {\"image\":\"data:image/png;base64,${"Ab9+".repeat(80)}`,
          "",
          "(File has more lines. Use 'offset' parameter to read beyond line 1)",
          "</file>",
        ].join("\n"),
        name: "read_file",
        tool_call_id: "opaque-first",
      } as any);
      const durableReasoning = new AIMessage({
        content: "",
        additional_kwargs: {
          reasoning_content:
            "Recorded that logical line 1 is an opaque PNG data URI.",
        },
      });
      const finalResult = new ToolMessage({
        content: [
          "<file>",
          "00005| semantic history resumes here",
          "",
          "(End of file - total 5 lines)",
          "</file>",
        ].join("\n"),
        name: "read_file",
        tool_call_id: "opaque-after",
      } as any);
      const durableCompletion = new AIMessage("Recovered unfinished task");
      const progress = (agent as any).resolveZeroRetentionReadProgress(
        [
          new HumanMessage("zero marker"),
          readCall("opaque-first", 0),
          firstResult,
          durableReasoning,
          readCall("opaque-after", 4),
          finalResult,
          durableCompletion,
        ],
        {
          markerIndex: 0,
          filePath,
          localTerminalId: "local-main",
          physicalLineCount: 5,
          progressDigest: "",
          resumeAfterLine: 0,
          recommendedReadLimit: 1,
          historyReadComplete: false,
        },
      );
      assert.equal(progress.resumeAfterLine, 5);
      assert.equal(progress.historyReadComplete, true);
      assert.equal(progress.safeSkipAfterLine, undefined);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero-retention capsule prioritizes the latest real user request over large system history",
  () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const latestRequest =
        "LATEST_AUTHORITATIVE_REQUEST preserve this exact unfinished constraint";
      const capsule = (agent as any).buildZeroRetentionRecoveryCapsule(
        [
          new SystemMessage("system-a " + "a".repeat(20_000)),
          new SystemMessage("system-b " + "b".repeat(20_000)),
          new SystemMessage("system-c " + "c".repeat(20_000)),
          makeUser("old-user", "old request " + "d".repeat(20_000)),
          makeAssistant("old-assistant", "old answer"),
          makeUser("latest-user", latestRequest),
          makeAssistant("latest-assistant", "unfinished current state"),
        ],
        8_000,
      );
      assert.ok(capsule.includes(latestRequest));
      assert.ok(capsule.includes("Authoritative latest real user request"));
      assert.ok(capsule.length <= 8_000);
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "zero-retention export reuse stops after inserted user input or a substantive tool call",
  async () => {
    const { agent, cleanup } = createAgentHarness();
    try {
      const exportService = (agent as any)
        .fallbackCompactionHistoryExportService as PassChatTempExportService;
      const filePath = await exportService.exportMarkdown({
        sessionId: "session-1",
        title: "recovery baseline",
        markdown: "baseline\n",
      });
      const marker = new HumanMessage({
        content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${filePath}`,
        additional_kwargs: {
          _gyshellMessageId: "zero-baseline",
          [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
          [TokenManager.COMPACTION_PROTECTED_ROUNDS_KEY]: 0,
          fallback_compaction: true,
          zero_retention_compaction: true,
          zero_retention_history_path: filePath,
          zero_retention_progress_digest: "baseline capsule",
          zero_retention_resume_after_line: 0,
          zero_retention_history_read_complete: false,
          zero_retention_physical_line_count: 2,
          zero_retention_local_terminal_id: "local-main",
          zero_retention_read_limit: 5,
        },
      });
      const insertedUser = new HumanMessage(
        `${USER_INSERTED_INPUT_TAG}change the active task`,
      );
      assert.equal(
        (agent as any).findActiveZeroRetentionRecovery("session-1", [
          marker,
          insertedUser,
        ]),
        null,
      );

      const mutationCall = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "mutation-call",
            name: "exec_command",
            args: { cmd: "touch changed-after-baseline" },
          },
        ],
      });
      const mutationResult = new ToolMessage({
        content: "exit code 0",
        name: "exec_command",
        tool_call_id: "mutation-call",
      } as any);
      assert.equal(
        (agent as any).findActiveZeroRetentionRecovery("session-1", [
          marker,
          mutationCall,
          mutationResult,
        ]),
        null,
        "a reused baseline must never omit exact post-baseline side effects",
      );
    } finally {
      cleanup();
    }
  },
);

await runCase(
  "rollback maintenance preserves a zero-retention marker with no later user round",
  () => {
    const zeroMarker = new HumanMessage({
      content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}recovery bridge`,
      additional_kwargs: {
        _gyshellMessageId: "zero-marker",
        [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
        [TokenManager.COMPACTION_PROTECTED_ROUNDS_KEY]: 0,
        zero_retention_compaction: true,
      },
    });
    const messages = [...makeMessages(), zeroMarker];
    const sanitized = sanitizeCompressionAfterRollback(messages, {
      pruneToolWindow: 10,
      protectedNormalRounds: 2,
    });
    assert.equal(
      sanitized.messages.includes(zeroMarker),
      true,
      "marker-specific zero protection must override the legacy two-round default",
    );
    assert.equal(
      buildDynamicRequestHistory(sanitized.messages).some((message) =>
        String(message.content).includes("first historical request"),
      ),
      false,
      "old history must stay hidden after rollback maintenance",
    );
  },
);
