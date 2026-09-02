import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { AgentService_v2 } from "./AgentService_v2";
import {
  getToolCallExecutionMetadata,
  planToolCallBatch,
} from "./AgentHelper/tool_batch_planner";
import {
  NonPersistedLastValueChannel,
  TRANSIENT_GRAPH_CHANNEL_NAMES,
  TransientStateMemorySaver,
} from "./AgentHelper/transientState";

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

class CountingJsonSerializer {
  calls = 0;
  bytes = 0;
  payloads: string[] = [];
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  async dumpsTyped(data: any): Promise<[string, Uint8Array]> {
    const json = JSON.stringify(data);
    if (typeof json !== "string") {
      throw new Error("Checkpoint test serializer received undefined data.");
    }
    const encoded = this.encoder.encode(json);
    this.calls += 1;
    this.bytes += encoded.byteLength;
    this.payloads.push(json);
    return ["json", encoded];
  }

  async loadsTyped(_type: string, data: Uint8Array | string): Promise<any> {
    const json = typeof data === "string" ? data : this.decoder.decode(data);
    return JSON.parse(json);
  }
}

function createAgent(options?: {
  saveSession?: (session: any, rawSession?: any) => void;
}): AgentService_v2 {
  return new AgentService_v2(
    {
      getDisplayTerminals: () => [],
      getAllTerminals: () => [],
    } as any,
    {} as any,
    { getActiveTools: () => [] } as any,
    {} as any,
    {} as any,
    { flush: () => undefined } as any,
    {
      ...(options?.saveSession
        ? { saveRuntimeSession: options.saveSession }
        : {}),
      saveSession: options?.saveSession || (() => undefined),
      loadSession: () => null,
      getAllSessions: () => [],
      getAllSessionSummaries: () => [],
      deleteSession: () => undefined,
      deleteSessions: () => undefined,
      renameSession: () => undefined,
      exportSession: () => null,
    } as any,
  );
}

const PROCESS_LOCAL_MARKERS = [
  "PROCESS_LOCAL_CARRIER_MARKER",
  "PROCESS_LOCAL_TERMINAL_MARKER",
  "PROCESS_LOCAL_PTY_MARKER",
  "PROCESS_LOCAL_BACKEND_MARKER",
  "PROCESS_LOCAL_RUNTIME_GUARD_MARKER",
  "PROCESS_LOCAL_CREATION_RUNTIME_MARKER",
  "PROCESS_LOCAL_FILESYSTEM_RUNTIME_MARKER",
  "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
  "9876543210",
];

const TRANSIENT_PERSISTENCE_TOKENS = [
  ...PROCESS_LOCAL_MARKERS,
  "pendingToolCalls",
  "physicalRunId",
  "_gyshellExecution",
  "terminalRuntimeBindings",
  "sourceRuntimeGuard",
  "targetRuntimeGuard",
  "TerminalRuntimeGuard",
  "TerminalCreationRuntime",
  "TerminalFilesystemRuntime",
];

function assertNoTransientPersistence(
  serialized: string,
  label: string,
): void {
  for (const token of TRANSIENT_PERSISTENCE_TOKENS) {
    assert.equal(
      serialized.includes(token),
      false,
      `${label} persisted process-local token ${JSON.stringify(token)}`,
    );
  }
}

function getRawSaverText(saver: MemorySaver): string {
  return JSON.stringify(
    {
      storage: saver.storage,
      writes: saver.writes,
    },
    (_key, value) =>
      value instanceof Uint8Array
        ? Buffer.from(value).toString("utf8")
        : value,
  );
}

function createPlannedToolCall() {
  const [plannedCall] = planToolCallBatch(
    [
      {
        id: "checkpoint-visible-tool-call",
        name: "read_file",
        args: {
          terminalId: "checkpoint-visible-terminal",
          filePath: "/tmp/checkpoint-visible-file",
        },
      },
    ],
    {
      isToolEnabled: () => true,
      isMcpTool: () => false,
      isMcpToolReadOnly: () => false,
      resolveTerminalId: (reference) => reference,
      resolveTerminalRuntimeGeneration: () => 9_876_543_210,
      resolveMachineId: () => "checkpoint-visible-machine",
      createParallelGroupId: () => "checkpoint-visible-group",
    },
  );
  return plannedCall;
}

function createProcessLocalCarrier() {
  const plannedCall = createPlannedToolCall();
  const pty = Object.freeze({
    marker: "PROCESS_LOCAL_PTY_MARKER",
  });
  const terminal = Object.freeze({
    id: "checkpoint-visible-terminal",
    marker: "PROCESS_LOCAL_TERMINAL_MARKER",
    pty,
  });
  const runtimeGuard = Object.freeze({
    marker: "PROCESS_LOCAL_RUNTIME_GUARD_MARKER",
    terminalId: terminal.id,
    expectedTerminal: terminal,
    expectedPtyId: "PROCESS_LOCAL_PTY_MARKER",
    expectedRuntimeGeneration: 9_876_543_210,
  });
  const creationRuntime = Object.freeze({
    marker: "PROCESS_LOCAL_CREATION_RUNTIME_MARKER",
    terminal,
    runtimeGuard,
  });
  const filesystemRuntime = Object.freeze({
    marker: "PROCESS_LOCAL_FILESYSTEM_RUNTIME_MARKER",
    terminal,
    backend: Object.freeze({ marker: "PROCESS_LOCAL_BACKEND_MARKER" }),
    runtimeGuard,
  });
  const carrier: any = {
    marker: "PROCESS_LOCAL_CARRIER_MARKER",
    plannedCall,
    pty,
    terminal,
    runtimeGuard,
    creationRuntime,
    filesystemRuntime,
  };
  carrier.self = carrier;
  return { carrier, plannedCall };
}

function createTransientStateAnnotation() {
  const Ann: any = Annotation;
  return Ann.Root({
    messages: Ann({
      reducer: (current: any[], update?: any[]) =>
        Array.isArray(update) ? update : current,
      default: (): any[] => [],
    }),
    pendingToolCalls: new NonPersistedLastValueChannel<any[]>(() => []),
    physicalRunId: new NonPersistedLastValueChannel<string>(() => ""),
  });
}

async function measureCheckpointSerialization(durability?: "exit"): Promise<{
  finalPayloadBytes: number;
  serializedBytes: number;
  serializerCalls: number;
}> {
  const Ann: any = Annotation;
  const State = Ann.Root({
    payload: Ann({
      reducer: (current: string, update?: string) => update ?? current,
      default: () => "",
    }),
    step: Ann({
      reducer: (current: number, update?: number) =>
        typeof update === "number" ? update : current,
      default: () => 0,
    }),
  });
  const steps = 32;
  const chunk = "x".repeat(8 * 1024);
  const serializer = new CountingJsonSerializer();
  const saver = new MemorySaver(serializer);
  const workflow = new StateGraph(State) as any;
  workflow.addNode("grow", (state: any) => ({
    payload: state.payload + chunk,
    step: state.step + 1,
  }));
  workflow.addEdge(START, "grow");
  workflow.addConditionalEdges(
    "grow",
    (state: any) => (state.step >= steps ? END : "grow"),
    ["grow", END],
  );
  const graph = workflow.compile({ checkpointer: saver });
  const result = await graph.invoke(
    { payload: "", step: 0 },
    {
      recursionLimit: steps + 5,
      configurable: {
        thread_id: `checkpoint-amplification-${durability || "async"}`,
      },
      ...(durability ? { durability } : {}),
    },
  );

  return {
    finalPayloadBytes: Buffer.byteLength(result.payload),
    serializedBytes: serializer.bytes,
    serializerCalls: serializer.calls,
  };
}

await runCase("agent runs use exit-only checkpoint durability", async () => {
  const agent = createAgent();
  let invokeConfig: any;
  (agent as any).ensureSessionModelBinding = () => ({
    globalMaxTokens: 200_000,
    thinkingMaxTokens: 200_000,
    compactionMaxTokens: 200_000,
  });
  (agent as any).graph = {
    invoke: async (_state: any, config: any) => {
      invokeConfig = config;
      return { messages: [] };
    },
  };

  await agent.run(
    {
      sessionId: "exit-durability-agent-run",
      lockedProfileId: "test-profile",
      metadata: {},
    },
    "test input",
    new AbortController().signal,
  );

  assert.equal(invokeConfig?.durability, "exit");
});

await runCase(
  "exit durability avoids checkpoint serialization amplification",
  async () => {
    const defaultRun = await measureCheckpointSerialization();
    const exitRun = await measureCheckpointSerialization("exit");

    assert.equal(defaultRun.finalPayloadBytes, exitRun.finalPayloadBytes);
    assert.ok(
      defaultRun.serializedBytes > exitRun.serializedBytes * 10,
      `expected default checkpointing to serialize far more data (${defaultRun.serializedBytes} vs ${exitRun.serializedBytes})`,
    );
    assert.ok(
      exitRun.serializedBytes < exitRun.finalPayloadBytes * 2,
      `expected exit checkpointing to stay near final state size (${exitRun.serializedBytes} vs ${exitRun.finalPayloadBytes})`,
    );
    assert.ok(
      defaultRun.serializerCalls > exitRun.serializerCalls * 10,
      `expected exit checkpointing to avoid intermediate writes (${defaultRun.serializerCalls} vs ${exitRun.serializerCalls})`,
    );
  },
);

await runCase(
  "exit durability preserves the last successful state on node failure",
  async () => {
    const Ann: any = Annotation;
    const State = Ann.Root({
      messages: Ann({
        reducer: (current: string[], update?: string[]) =>
          Array.isArray(update) ? update : current,
        default: (): string[] => [],
      }),
    });
    const saver = new MemorySaver();
    const workflow = new StateGraph(State) as any;
    workflow.addNode("commit", (state: any) => ({
      messages: [...state.messages, "committed-before-error"],
    }));
    workflow.addNode("fail", () => {
      throw new Error("simulated node failure");
    });
    workflow.addEdge(START, "commit");
    workflow.addEdge("commit", "fail");
    const graph = workflow.compile({ checkpointer: saver });
    const config = {
      durability: "exit" as const,
      configurable: { thread_id: "exit-error-recovery" },
    };

    await assert.rejects(
      graph.invoke({ messages: ["base"] }, config),
      /simulated node failure/,
    );
    const snapshot = await graph.getState(config);

    assert.deepEqual(snapshot.values.messages, [
      "base",
      "committed-before-error",
    ]);
    assert.deepEqual(snapshot.next, ["fail"]);
    assert.equal(snapshot.tasks[0]?.error?.message, "simulated node failure");
  },
);

await runCase(
  "production graph wiring and direct saver APIs exclude every transient channel before serialization",
  async () => {
    const agent = createAgent();
    const productionChannels = (agent as any).graph.channels;
    assert.equal(
      productionChannels.pendingToolCalls instanceof
        NonPersistedLastValueChannel,
      true,
    );
    assert.equal(
      productionChannels.physicalRunId instanceof
        NonPersistedLastValueChannel,
      true,
    );
    assert.deepEqual(
      [...TRANSIENT_GRAPH_CHANNEL_NAMES].sort(),
      ["pendingToolCalls", "physicalRunId"],
    );

    const serializer = new CountingJsonSerializer();
    const saver = new TransientStateMemorySaver(serializer as any);
    const { carrier } = createProcessLocalCarrier();
    const checkpoint: any = {
      v: 4,
      id: "direct-transient-checkpoint",
      ts: new Date(0).toISOString(),
      channel_values: {
        messages: ["direct durable checkpoint value"],
        pendingToolCalls: [carrier],
        physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      },
      channel_versions: {
        messages: 1,
        pendingToolCalls: 2,
        physicalRunId: 3,
      },
      versions_seen: {
        direct: {
          messages: 1,
          pendingToolCalls: 2,
          physicalRunId: 3,
        },
      },
    };
    const config = await saver.put(
      { configurable: { thread_id: "direct-transient-saver" } },
      checkpoint,
      {
        source: "input",
        step: -1,
        parents: {},
        writes: {
          messages: "direct durable metadata",
          pendingToolCalls: carrier,
          physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
        },
      } as any,
    );
    await saver.putWrites(
      config,
      [
        ["pendingToolCalls", [carrier]],
        ["physicalRunId", "PROCESS_LOCAL_PHYSICAL_RUN_MARKER"],
        ["messages", ["direct durable pending write"]],
      ],
      "direct-transient-task",
    );

    assert.equal(checkpoint.channel_values.pendingToolCalls[0], carrier);
    assert.equal(
      checkpoint.channel_versions.physicalRunId,
      3,
      "saver filtering must not mutate the caller-owned checkpoint",
    );

    const tuple = await saver.getTuple(config);
    assert.deepEqual(tuple?.checkpoint.channel_values.messages, [
      "direct durable checkpoint value",
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        tuple?.checkpoint.channel_values || {},
        "pendingToolCalls",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        tuple?.checkpoint.channel_values || {},
        "physicalRunId",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        tuple?.checkpoint.channel_versions || {},
        "pendingToolCalls",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        tuple?.checkpoint.channel_versions || {},
        "physicalRunId",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        tuple?.checkpoint.versions_seen.direct || {},
        "pendingToolCalls",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        tuple?.checkpoint.versions_seen.direct || {},
        "physicalRunId",
      ),
      false,
    );
    assert.deepEqual((tuple?.metadata as any)?.writes, {
      messages: "direct durable metadata",
    });
    assert.deepEqual(tuple?.pendingWrites, [
      [
        "direct-transient-task",
        "messages",
        ["direct durable pending write"],
      ],
    ]);

    assertNoTransientPersistence(
      serializer.payloads.join("\n"),
      "direct serializer payloads",
    );
    assertNoTransientPersistence(
      getRawSaverText(saver),
      "direct MemorySaver storage/writes",
    );
  },
);

await runCase(
  "normal exit keeps transient state live but restores empty process-local channels",
  async () => {
    const serializer = new CountingJsonSerializer();
    const saver = new TransientStateMemorySaver(serializer as any);
    const State = createTransientStateAnnotation();
    const { carrier, plannedCall } = createProcessLocalCarrier();
    const workflow = new StateGraph(State) as any;
    workflow.addNode("commit", (state: any) => {
      assert.equal(state.pendingToolCalls[0], carrier);
      assert.equal(
        state.physicalRunId,
        "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      );
      assert.equal(
        getToolCallExecutionMetadata(state.pendingToolCalls[0].plannedCall)
          ?.terminalRuntimeBindings?.[0]?.runtimeGeneration,
        9_876_543_210,
      );
      return {
        messages: [...state.messages, "normal durable commit"],
        pendingToolCalls: [carrier],
        physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      };
    });
    workflow.addEdge(START, "commit");
    workflow.addEdge("commit", END);
    const graph = workflow.compile({ checkpointer: saver });
    const config = {
      durability: "exit" as const,
      configurable: { thread_id: "normal-transient-restore" },
    };

    const result = await graph.invoke(
      {
        messages: ["normal base"],
        pendingToolCalls: [carrier],
        physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      },
      config,
    );
    assert.equal(result.pendingToolCalls[0], carrier);
    assert.equal(result.physicalRunId, "PROCESS_LOCAL_PHYSICAL_RUN_MARKER");
    assert.equal(
      getToolCallExecutionMetadata(plannedCall)?.terminalRuntimeBindings?.[0]
        ?.runtimeGeneration,
      9_876_543_210,
    );

    const tuple = await saver.getTuple(config);
    assert.deepEqual(tuple?.checkpoint.channel_values.messages, [
      "normal base",
      "normal durable commit",
    ]);
    const restoredGraph = workflow.compile({ checkpointer: saver });
    const restored = await restoredGraph.getState(config);
    assert.deepEqual(restored.values.messages, [
      "normal base",
      "normal durable commit",
    ]);
    assert.deepEqual(restored.values.pendingToolCalls, []);
    assert.equal(restored.values.physicalRunId, "");
    assertNoTransientPersistence(
      serializer.payloads.join("\n"),
      "normal-exit serializer payloads",
    );
    assertNoTransientPersistence(
      getRawSaverText(saver),
      "normal-exit MemorySaver storage/writes",
    );
  },
);

await runCase(
  "error exit preserves durable progress without checkpointing its live runtime carrier",
  async () => {
    const serializer = new CountingJsonSerializer();
    const saver = new TransientStateMemorySaver(serializer as any);
    const State = createTransientStateAnnotation();
    const { carrier } = createProcessLocalCarrier();
    const workflow = new StateGraph(State) as any;
    workflow.addNode("commit", (state: any) => ({
      messages: [...state.messages, "durable before transient failure"],
      pendingToolCalls: [carrier],
      physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
    }));
    workflow.addNode("fail", (state: any) => {
      assert.equal(state.pendingToolCalls[0], carrier);
      assert.equal(
        state.physicalRunId,
        "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      );
      throw new Error("simulated transient-state failure");
    });
    workflow.addEdge(START, "commit");
    workflow.addEdge("commit", "fail");
    const graph = workflow.compile({ checkpointer: saver });
    const config = {
      durability: "exit" as const,
      configurable: { thread_id: "error-transient-restore" },
    };

    await assert.rejects(
      graph.invoke(
        {
          messages: ["error base"],
          pendingToolCalls: [carrier],
          physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
        },
        config,
      ),
      /simulated transient-state failure/,
    );
    const snapshot = await graph.getState(config);
    assert.deepEqual(snapshot.values.messages, [
      "error base",
      "durable before transient failure",
    ]);
    assert.deepEqual(snapshot.values.pendingToolCalls, []);
    assert.equal(snapshot.values.physicalRunId, "");
    assert.deepEqual(snapshot.next, ["fail"]);
    assert.equal(
      snapshot.tasks[0]?.error?.message,
      "simulated transient-state failure",
    );
    assertNoTransientPersistence(
      serializer.payloads.join("\n"),
      "error-exit serializer payloads",
    );
    assertNoTransientPersistence(
      getRawSaverText(saver),
      "error-exit MemorySaver storage/writes",
    );
  },
);

await runCase(
  "AbortController exit flushes durable progress but no transient graph state",
  async () => {
    const serializer = new CountingJsonSerializer();
    const saver = new TransientStateMemorySaver(serializer as any);
    const State = createTransientStateAnnotation();
    const { carrier } = createProcessLocalCarrier();
    let markWaitNodeEntered: () => void = () => undefined;
    const waitNodeEntered = new Promise<void>((resolve) => {
      markWaitNodeEntered = resolve;
    });
    const workflow = new StateGraph(State) as any;
    workflow.addNode("commit", (state: any) => ({
      messages: [...state.messages, "durable before abort"],
      pendingToolCalls: [carrier],
      physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
    }));
    workflow.addNode("wait", (state: any, config: any) => {
      assert.equal(state.pendingToolCalls[0], carrier);
      assert.equal(
        state.physicalRunId,
        "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      );
      markWaitNodeEntered();
      return new Promise((_resolve, reject) => {
        const rejectForAbort = () => {
          const error = new Error("AbortError");
          error.name = "AbortError";
          reject(error);
        };
        if (config?.signal?.aborted) {
          rejectForAbort();
          return;
        }
        config?.signal?.addEventListener("abort", rejectForAbort, {
          once: true,
        });
      });
    });
    workflow.addEdge(START, "commit");
    workflow.addEdge("commit", "wait");
    workflow.addEdge("wait", END);
    const graph = workflow.compile({ checkpointer: saver });
    const controller = new AbortController();
    const config = {
      durability: "exit" as const,
      signal: controller.signal,
      configurable: { thread_id: "abort-transient-restore" },
    };
    const invocation = graph.invoke(
      {
        messages: ["abort base"],
        pendingToolCalls: [carrier],
        physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      },
      config,
    );

    await waitNodeEntered;
    controller.abort();
    await assert.rejects(invocation);

    const snapshot = await graph.getState(config);
    assert.deepEqual(snapshot.values.messages, [
      "abort base",
      "durable before abort",
    ]);
    assert.deepEqual(snapshot.values.pendingToolCalls, []);
    assert.equal(snapshot.values.physicalRunId, "");
    assert.deepEqual(snapshot.next, ["wait"]);
    assertNoTransientPersistence(
      serializer.payloads.join("\n"),
      "abort serializer payloads",
    );
    assertNoTransientPersistence(
      getRawSaverText(saver),
      "abort MemorySaver storage/writes",
    );
  },
);

await runCase(
  "checkpoint session recovery ignores runtime carriers and never coerces a physical run identity",
  async () => {
    const saved = new Map<string, { session: any; rawSession?: any }>();
    const agent = createAgent({
      saveSession: (session, rawSession) => {
        saved.set(session.id, { session, rawSession });
      },
    });
    const { carrier, plannedCall } = createProcessLocalCarrier();
    const accepted = new AIMessage({
      content: "accepted durable assistant response",
      tool_calls: [plannedCall as any],
    });
    const snapshots = new Map<string, any>([
      [
        "checkpoint-session-save",
        {
          values: {
            messages: [
              new HumanMessage("durable user request"),
              accepted,
            ],
            pendingToolCalls: [carrier],
            physicalRunId: "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
            runtimeGuard: carrier.runtimeGuard,
            creationRuntime: carrier.creationRuntime,
            filesystemRuntime: carrier.filesystemRuntime,
            terminal: carrier.terminal,
            pty: carrier.pty,
          },
        },
      ],
      [
        "wrong-type-physical-run",
        {
          values: {
            messages: [new HumanMessage("wrong-type durable request")],
            pendingToolCalls: [carrier],
            physicalRunId: 123,
          },
        },
      ],
    ]);
    (agent as any).graph = {
      getState: async (config: any) =>
        snapshots.get(config.configurable.thread_id),
    };
    (agent as any).abortedMessagesByRunId.set(
      "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
      [new AIMessage("exact-run interrupted durable response")],
    );
    (agent as any).abortedMessagesByRunId.set("123", [
      new AIMessage("wrong-type run identity must not match this message"),
    ]);

    await (agent as any).trySaveSessionFromCheckpoint(
      "checkpoint-session-save",
      "PROCESS_LOCAL_PHYSICAL_RUN_MARKER",
    );
    await (agent as any).trySaveSessionFromCheckpoint(
      "wrong-type-physical-run",
      123,
    );

    const exactSaved = saved.get("checkpoint-session-save");
    const wrongTypeSaved = saved.get("wrong-type-physical-run");
    assert.ok(exactSaved);
    assert.ok(wrongTypeSaved);
    const exactSerialized = JSON.stringify({
      id: exactSaved.session.id,
      messages: [...exactSaved.session.messages.values()],
      rawMessages: exactSaved.rawSession
        ? [...exactSaved.rawSession.messages.values()]
        : [],
    });
    const wrongTypeSerialized = JSON.stringify({
      id: wrongTypeSaved.session.id,
      messages: [...wrongTypeSaved.session.messages.values()],
      rawMessages: wrongTypeSaved.rawSession
        ? [...wrongTypeSaved.rawSession.messages.values()]
        : [],
    });
    assert.equal(
      exactSerialized.includes("accepted durable assistant response"),
      true,
    );
    assert.equal(
      exactSerialized.includes("exact-run interrupted durable response"),
      true,
    );
    assert.equal(
      wrongTypeSerialized.includes(
        "wrong-type run identity must not match this message",
      ),
      false,
    );
    assert.equal(
      (agent as any).abortedMessagesByRunId.has("123"),
      true,
      "a numeric physicalRunId must not be coerced into an existing string map key",
    );
    assert.equal(
      getToolCallExecutionMetadata(plannedCall)?.terminalRuntimeBindings?.[0]
        ?.runtimeGeneration,
      9_876_543_210,
      "the live tool call must retain its process-local runtime binding",
    );
    assertNoTransientPersistence(
      exactSerialized,
      "checkpoint-derived chat session",
    );
    assertNoTransientPersistence(
      wrongTypeSerialized,
      "wrong-type-run chat session",
    );
  },
);
