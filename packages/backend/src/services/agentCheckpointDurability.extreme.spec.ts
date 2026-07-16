import assert from "node:assert/strict";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { AgentService_v2 } from "./AgentService_v2";

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
    return ["json", encoded];
  }

  async loadsTyped(_type: string, data: Uint8Array | string): Promise<any> {
    const json = typeof data === "string" ? data : this.decoder.decode(data);
    return JSON.parse(json);
  }
}

function createAgent(): AgentService_v2 {
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
      saveSession: () => undefined,
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
