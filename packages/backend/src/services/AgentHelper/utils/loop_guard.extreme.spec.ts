import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { AgentService_v2 } from "../../AgentService_v2";
import { ChatHistoryService } from "../../ChatHistoryService";
import { UIHistoryService } from "../../UIHistoryService";
import { HistorySqliteStore } from "../../history/HistorySqliteStore";
import { LOOP_GUARD_INPUT_TAG } from "../prompts";
import { isEphemeral } from "./common";
import { ResponseLoopMonitor } from "./loop_guard";
import { STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY } from "./streamed_tool_call_integrity";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

// ---------------------------------------------------------------------------
// Scripted fake model: each stream call plays the next attempt's chunks.
// ---------------------------------------------------------------------------

type AttemptScript = () => Iterable<AIMessageChunk>;

const textChunk = (text: string): AIMessageChunk =>
  new AIMessageChunk({ content: text });

const reasoningChunk = (text: string): AIMessageChunk =>
  new AIMessageChunk({
    content: "",
    additional_kwargs: {
      __raw_response: {
        id: "chatcmpl-reasoning",
        choices: [{ index: 0, delta: { reasoning_content: text } }],
      },
    },
  });

const finishChunk = (reason = "stop"): AIMessageChunk =>
  new AIMessageChunk({
    content: "",
    response_metadata: { model_name: "fake-loop-model", finish_reason: reason },
  });

const toolCallChunk = (opts: {
  index: number;
  id?: string;
  name?: string;
  args: string;
}): AIMessageChunk =>
  new AIMessageChunk({
    content: "",
    tool_call_chunks: [
      {
        index: opts.index,
        id: opts.id,
        name: opts.name,
        args: opts.args,
        type: "tool_call_chunk",
      },
    ],
    additional_kwargs: {
      __raw_response: {
        id: "chatcmpl-tool",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: opts.index,
                  ...(opts.id ? { id: opts.id, type: "function" } : {}),
                  function: {
                    ...(opts.name ? { name: opts.name } : {}),
                    arguments: opts.args,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    },
  });

/** Split text into deltas of `size` characters. */
function* deltas(text: string, size: number, make = textChunk) {
  for (let offset = 0; offset < text.length; offset += size) {
    yield make(text.slice(offset, offset + size));
  }
}

class ScriptedModel {
  public modelName = "fake-loop-model";
  public model = "fake-loop-model";
  public streamCalls = 0;
  public requests: BaseMessage[][] = [];
  /** Characters still unread when an attempt was cancelled mid-stream. */
  public cancelledAttempts = 0;
  public signalsAbortedAfterAttempt: boolean[] = [];
  public invokeCalls = 0;

  constructor(
    private readonly attempts: AttemptScript[],
    /** Replies of the non-stream fallback, in call order. */
    private readonly invokeReplies: Array<() => AIMessage> = [],
  ) {}

  bindTools() {
    const self = this;
    return {
      stream: async function* (messages: BaseMessage[], options?: any) {
        const attemptIndex = self.streamCalls;
        self.streamCalls += 1;
        self.requests.push(messages);
        const script = self.attempts[Math.min(attemptIndex, self.attempts.length - 1)];
        let finished = false;
        try {
          for (const chunk of script()) {
            if (options?.signal?.aborted) {
              throw Object.assign(new Error("AbortError"), { name: "AbortError" });
            }
            yield chunk;
          }
          finished = true;
        } finally {
          if (!finished) self.cancelledAttempts += 1;
          self.signalsAbortedAfterAttempt.push(Boolean(options?.signal?.aborted));
        }
      },
      invoke: async () => {
        const reply = self.invokeReplies[self.invokeCalls];
        self.invokeCalls += 1;
        if (!reply) {
          throw new Error("non-stream invoke should not run in this case");
        }
        return reply();
      },
    };
  }
}

class GuardShouldNotRunModel {
  public modelName = "guard";
  public model = "guard";
  bindTools() {
    return {
      stream: async function* () {
        throw new Error("auxiliary model should not run");
      },
      invoke: async () => {
        throw new Error("auxiliary model should not run");
      },
    };
  }
  withStructuredOutput() {
    return {
      invoke: async () => {
        throw new Error("auxiliary model should not run");
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Harness: real AgentService_v2 model_request node + real UIHistoryService.
// ---------------------------------------------------------------------------

interface Harness {
  agent: AgentService_v2;
  uiHistory: UIHistoryService;
  events: any[];
  sessionId: string;
  model: ScriptedModel;
  runNode: (opts?: {
    loopGuardEnabled?: boolean;
    signal?: AbortSignal;
  }) => Promise<any>;
}

let harnessCounter = 0;

const createHarness = (
  attempts: AttemptScript[],
  invokeReplies: Array<() => AIMessage> = [],
): Harness => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-loop-guard-"));
  const store = new HistorySqliteStore({
    filePath: path.join(tempDir, "history.sqlite3"),
  });
  const chatHistory = new ChatHistoryService({ store });
  const uiHistory = new UIHistoryService({ store });
  const agent = new AgentService_v2(
    { getAllTerminals: () => [], getRecentOutput: () => "" } as any,
    {} as any,
    { getActiveTools: () => [], isMcpToolName: () => false } as any,
    {
      reload: async () => {},
      getEnabledSkills: async () => [],
      readSkillContentByName: async () => {
        throw new Error("skill lookup should not run");
      },
    } as any,
    {
      getMemorySnapshot: async () => ({ enabled: false, filePath: "", content: "" }),
    } as any,
    uiHistory,
    chatHistory,
  );
  const events: any[] = [];
  const sessionId = `loop-guard-session-${(harnessCounter += 1)}`;
  agent.setEventPublisher((eventSessionId, event) => {
    events.push(event);
    uiHistory.recordEvent(eventSessionId, event);
  });
  const model = new ScriptedModel(attempts, invokeReplies);
  const guard = new GuardShouldNotRunModel();
  (agent as any).sessionModelBindings.set(sessionId, {
    profileId: "loop-guard-profile",
    model,
    actionModel: guard,
    thinkingModel: guard,
    compactionModel: guard,
    actionModelSupportsStructuredOutput: true,
    actionModelSupportsObjectToolChoice: false,
    thinkingModelSupportsStructuredOutput: true,
    thinkingModelSupportsObjectToolChoice: false,
    compactionModelSupportsStructuredOutput: true,
    compactionModelSupportsObjectToolChoice: false,
    readFileSupport: { image: false },
    toolsForModel: [],
    globalMaxTokens: 1000000,
    thinkingMaxTokens: 1000000,
    compactionMaxTokens: 1000000,
  });
  return {
    agent,
    uiHistory,
    events,
    sessionId,
    model,
    runNode: async (opts = {}) =>
      await (agent as any).createModelRequestNode().invoke(
        {
          sessionId,
          physicalRunId: `${sessionId}-run`,
          messages: [new HumanMessage("Summarize the deployment status.")],
          token_state: { current_tokens: 0, max_tokens: 1000000 },
          modelRequestPassCount: 0,
          runtimeThinkingCorrectionEnabled: false,
          firstTurnThinkingModelEnabled: false,
          loopGuardEnabled: opts.loopGuardEnabled ?? true,
        },
        { signal: opts.signal ?? new AbortController().signal },
      ),
  };
};

const LOOP_TEXT = "The deployment is still pending, let me check again. ";
const LOOP_REASONING = "I should check the deployment status one more time.\n";

const textLoopAttempt = (prefix = "Checking the rollout.\n"): AttemptScript =>
  function* () {
    yield* deltas(prefix, 9);
    // Far more than needed: the guard must stop the stream long before this.
    yield* deltas(LOOP_TEXT.repeat(400), 11);
    yield finishChunk();
  };

const cleanAttempt = (text: string): AttemptScript =>
  function* () {
    yield* deltas(text, 6);
    yield finishChunk();
  };

const textOf = (message: BaseMessage): string =>
  typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);

const loopGuardNotes = (messages: BaseMessage[]): BaseMessage[] =>
  messages.filter((message) => textOf(message).startsWith(LOOP_GUARD_INPUT_TAG));

const uiMessages = (harness: Harness) =>
  harness.uiHistory.getMessages(harness.sessionId);

const assertNoVisibleTrace = (harness: Harness, label: string): void => {
  const visible = JSON.stringify(uiMessages(harness));
  assertCondition(
    !visible.includes("let me check again") &&
      !visible.includes("one more time"),
    `${label}: looped text must not remain in the UI`,
  );
  assertEqual(
    harness.events.filter((event) => event.type === "alert" || event.type === "error").length,
    0,
    `${label}: recovery must be silent (no alert or error events)`,
  );
};

const run = async (): Promise<void> => {
  await runCase("content loop: discarded, retracted and silently re-requested", async () => {
    const harness = createHarness([
      textLoopAttempt(),
      cleanAttempt("The deployment finished successfully."),
    ]);
    const result = await harness.runNode();

    assertEqual(harness.model.streamCalls, 2, "one re-request after the loop");
    assertEqual(harness.model.cancelledAttempts, 1, "the looping stream is stopped early");
    assertEqual(
      harness.model.signalsAbortedAfterAttempt[0],
      true,
      "the looping attempt's request signal is aborted",
    );
    const looped = harness.events
      .filter((event) => event.type === "say")
      .map((event) => event.content)
      .join("");
    assertCondition(
      looped.length < 1500,
      `the guard must stop quickly (${looped.length} chars were shown)`,
    );

    const retry = harness.model.requests[1];
    const notes = loopGuardNotes(retry);
    assertEqual(notes.length, 1, "the re-request carries exactly one hidden note");
    assertCondition(isEphemeral(notes[0]), "the note is never persisted");
    assertEqual(retry.at(-1), notes[0], "the note is the last request message");
    assertCondition(
      !textOf(notes[0]).includes("let me check again"),
      "the note never quotes the looped text",
    );
    assertEqual(
      retry.length,
      harness.model.requests[0].length + 1,
      "the re-request is the same history plus the note",
    );

    const committed: BaseMessage[] = result.messages;
    assertEqual(loopGuardNotes(committed).length, 0, "the note is not committed to state");
    const reply = committed.at(-1) as AIMessage;
    assertEqual(textOf(reply), "The deployment finished successfully.", "the clean answer is committed");
    assertCondition(
      !committed.some((message) => textOf(message).includes("let me check again")),
      "the looping response never reaches state",
    );

    const assistantBubbles = uiMessages(harness).filter((message) => message.role === "assistant");
    assertEqual(assistantBubbles.length, 1, "exactly one assistant bubble remains");
    assertEqual(assistantBubbles[0].content, "The deployment finished successfully.", "the bubble shows only the clean answer");
    assertNoVisibleTrace(harness, "content loop");
    assertEqual(
      (harness.agent as any).abortedMessagesByRunId.has(`${harness.sessionId}-run`),
      false,
      "nothing from the discarded attempt is kept for stop persistence",
    );
  });

  await runCase("reasoning loop: every reasoning banner and text bubble is retracted", async () => {
    const harness = createHarness([
      function* () {
        yield* deltas("Let me think about the rollout.\n", 8, reasoningChunk);
        yield textChunk("First, a quick look. ");
        yield* deltas("Now, more careful reasoning.\n", 8, reasoningChunk);
        yield* deltas(LOOP_REASONING.repeat(300), 13, reasoningChunk);
        yield finishChunk();
      },
      cleanAttempt("All services are healthy."),
    ]);
    await harness.runNode();

    assertEqual(harness.model.streamCalls, 2, "the reasoning loop is re-requested");
    const startedBanners = harness.events.filter((event) => event.type === "sub_tool_started");
    assertEqual(startedBanners.length, 2, "the looping attempt opened two reasoning banners");
    const removed = new Set(
      harness.events.filter((event) => event.type === "remove_message").map((event) => event.messageId),
    );
    for (const banner of startedBanners) {
      assertCondition(removed.has(banner.messageId), "every banner of the attempt is retracted");
    }
    const remaining = uiMessages(harness).filter((message) => message.role === "assistant");
    assertEqual(remaining.length, 1, "only the clean answer bubble remains");
    assertEqual(remaining[0].type, "text", "no reasoning banner survives");
    assertEqual(remaining[0].content, "All services are healthy.", "the clean answer is shown");
    assertNoVisibleTrace(harness, "reasoning loop");
  });

  await runCase("text split by a banner: both text bubbles of the attempt are removed", async () => {
    const harness = createHarness([
      function* () {
        yield textChunk("Intro paragraph before thinking. ");
        yield reasoningChunk("Short thought.");
        yield textChunk("Second bubble after the banner. ");
        yield* deltas(LOOP_TEXT.repeat(300), 17);
        yield finishChunk();
      },
      cleanAttempt("Final status: green."),
    ]);
    await harness.runNode();
    const remaining = uiMessages(harness).filter((message) => message.role === "assistant");
    assertEqual(remaining.length, 1, "both bubbles of the looping attempt are gone");
    assertEqual(remaining[0].content, "Final status: green.", "only the clean answer remains");
    assertCondition(
      !JSON.stringify(remaining).includes("Intro paragraph"),
      "the clean prefix of a discarded attempt is discarded too",
    );
  });

  await runCase("tool-argument loop: the runaway call is discarded and re-requested", async () => {
    const runaway = '{"path":"/tmp/out.txt","content":"' + "row,same,value\\n".repeat(400);
    const harness = createHarness([
      function* () {
        yield toolCallChunk({ index: 0, id: "call-loop", name: "write_file", args: "" });
        for (let offset = 0; offset < runaway.length; offset += 23) {
          yield toolCallChunk({ index: 0, args: runaway.slice(offset, offset + 23) });
        }
        yield finishChunk("tool_calls");
      },
      function* () {
        yield toolCallChunk({
          index: 0,
          id: "call-ok",
          name: "write_file",
          args: '{"path":"/tmp/out.txt","content":"row,same,value\\n"}',
        });
        yield finishChunk("tool_calls");
      },
    ]);
    const result = await harness.runNode();
    assertEqual(harness.model.streamCalls, 2, "the runaway arguments are re-requested");
    assertEqual(harness.model.cancelledAttempts, 1, "the runaway stream is stopped early");
    const reply = result.messages.at(-1) as AIMessage;
    assertEqual(reply.tool_calls?.length, 1, "one tool call is committed");
    assertEqual(reply.tool_calls?.[0]?.id, "call-ok", "the committed call is from the re-request");
    assertCondition(
      textOf(loopGuardNotes(harness.model.requests[1])[0]).includes("write_file"),
      "the note names the tool whose arguments looped",
    );
  });

  await runCase("repeated identical calls in one response: three trip, two pass", async () => {
    const sameCall = (index: number, id: string) =>
      toolCallChunk({ index, id, name: "read_file", args: '{"filePath":"/etc/hosts","intent":"look ' + id + '"}' });
    const harness = createHarness([
      function* () {
        yield sameCall(0, "a");
        yield sameCall(1, "b");
        yield sameCall(2, "c");
        yield finishChunk("tool_calls");
      },
      function* () {
        yield sameCall(0, "d");
        yield sameCall(1, "e");
        yield finishChunk("tool_calls");
      },
    ]);
    const result = await harness.runNode();
    assertEqual(harness.model.streamCalls, 2, "three identical calls are re-requested");
    const reply = result.messages.at(-1) as AIMessage;
    assertEqual(reply.tool_calls?.length, 2, "two identical calls are allowed");
  });

  await runCase("exhaustion (text): three loops keep the clean prefix, no tool calls", async () => {
    const harness = createHarness([
      textLoopAttempt("Rollout status so far.\n"),
      textLoopAttempt("Rollout status so far.\n"),
      textLoopAttempt("Rollout status so far.\n"),
    ]);
    const result = await harness.runNode();
    assertEqual(harness.model.streamCalls, 3, "at most three attempts");
    const secondNotes = loopGuardNotes(harness.model.requests[1]);
    const thirdNotes = loopGuardNotes(harness.model.requests[2]);
    assertEqual(thirdNotes.length, 1, "notes are replaced, never stacked");
    assertCondition(
      !textOf(secondNotes[0]).includes("second interruption") &&
        textOf(thirdNotes[0]).includes("second interruption"),
      "the last attempt's note says it is the second interruption",
    );
    const reply = result.messages.at(-1) as AIMessage;
    const kept = textOf(reply);
    assertCondition(kept.startsWith("Rollout status so far."), "the clean prefix is kept");
    assertCondition(
      kept.split("let me check again").length - 1 <= 1,
      `at most one copy of the looping unit is kept (got: ${JSON.stringify(kept)})`,
    );
    assertEqual(reply.tool_calls?.length ?? 0, 0, "no tool calls are attached");
    const bubbles = uiMessages(harness).filter((message) => message.role === "assistant");
    assertEqual(bubbles.length, 1, "one bubble shows the kept text");
    assertEqual(bubbles[0].content, kept, "the UI matches the committed text");
    assertEqual(loopGuardNotes(result.messages).length, 0, "no note is committed");
  });

  await runCase("exhaustion (repeated calls): the final attempt collapses duplicates", async () => {
    const triple: AttemptScript = function* () {
      for (let index = 0; index < 3; index += 1) {
        yield toolCallChunk({ index, id: `call-${index}`, name: "read_file", args: '{"filePath":"/etc/hosts"}' });
      }
      yield finishChunk("tool_calls");
    };
    const harness = createHarness([triple, triple, triple]);
    const result = await harness.runNode();
    assertEqual(harness.model.streamCalls, 3, "three attempts");
    const reply = result.messages.at(-1) as AIMessage;
    assertEqual(reply.tool_calls?.length, 1, "duplicates collapse to one call");
    assertEqual(reply.tool_calls?.[0]?.id, "call-0", "the first copy is kept");
  });

  await runCase("disabled guard: a looping response passes through untouched", async () => {
    const harness = createHarness([
      function* () {
        yield* deltas(LOOP_TEXT.repeat(30), 11);
        yield finishChunk();
      },
    ]);
    const result = await harness.runNode({ loopGuardEnabled: false });
    assertEqual(harness.model.streamCalls, 1, "no re-request when disabled");
    assertEqual(textOf(result.messages.at(-1)), LOOP_TEXT.repeat(30), "the response is unchanged");
  });

  await runCase("ordinary answers with repetitive structure are not touched", async () => {
    const table = Array.from({ length: 60 }, (_, i) => `| svc-${i} | ok | ${i * 3}ms |\n`).join("");
    const answer = `Status:\n\n| service | state | latency |\n|---|---|---|\n${table}\n\`\`\`\n${"}\n".repeat(20)}\`\`\`\nDone.`;
    const harness = createHarness([cleanAttempt(answer)]);
    const result = await harness.runNode();
    assertEqual(harness.model.streamCalls, 1, "no re-request");
    assertEqual(textOf(result.messages.at(-1)), answer, "the answer is committed as-is");
  });

  await runCase("user stop during a loop retry stays a user stop", async () => {
    const controller = new AbortController();
    const harness = createHarness([
      function* () {
        // The loop trips within milliseconds; the stop lands inside the
        // guard's 500 ms backoff before the re-request.
        setTimeout(() => controller.abort(), 150);
        yield* deltas(LOOP_TEXT.repeat(300), 11);
        yield finishChunk();
      },
      cleanAttempt("should never be requested"),
    ]);
    let stopError: any = null;
    try {
      await harness.runNode({ signal: controller.signal });
    } catch (error) {
      stopError = error;
    }
    assertCondition(stopError, "the node must reject on a user stop");
    assertCondition(
      (harness.agent as any).helpers.isAbortError(stopError),
      `a user stop surfaces as an abort (${stopError?.message})`,
    );
    assertEqual(harness.model.streamCalls, 1, "no re-request after the user stopped");
  });

  await runCase("transport retry then loop: banners of every transport try are retracted", async () => {
    const harness = createHarness([
      function* () {
        yield* deltas("Checking the cluster first.\n", 8, reasoningChunk);
        throw new Error("socket hang up");
      },
      function* () {
        yield* deltas(LOOP_REASONING.repeat(300), 13, reasoningChunk);
        yield finishChunk();
      },
      cleanAttempt("Cluster is healthy."),
    ]);
    await harness.runNode();
    assertEqual(harness.model.streamCalls, 3, "one transport retry, then one loop re-request");
    const removed = new Set(
      harness.events.filter((event) => event.type === "remove_message").map((event) => event.messageId),
    );
    const banners = harness.events.filter((event) => event.type === "sub_tool_started");
    assertEqual(banners.length, 2, "each transport try opened one banner");
    for (const banner of banners) {
      assertCondition(removed.has(banner.messageId), "the banner of every transport try is retracted");
    }
    const reasoningLeft = uiMessages(harness).filter((message) => message.type === "reasoning");
    assertEqual(reasoningLeft.length, 0, "no reasoning banner of the discarded attempt survives");
  });

  await runCase("non-stream fallback: a looping fallback reply is guarded too", async () => {
    const emptyToolFinish: AttemptScript = function* () {
      yield finishChunk("tool_calls");
    };
    const harness = createHarness(
      [emptyToolFinish, cleanAttempt("Fallback recovered cleanly.")],
      [() => new AIMessage({ content: "Status:\n" + LOOP_TEXT.repeat(300) })],
    );
    const result = await harness.runNode();
    assertEqual(harness.model.invokeCalls, 1, "the fallback ran once");
    assertEqual(harness.model.streamCalls, 2, "the looping fallback reply is re-requested");
    assertEqual(textOf(result.messages.at(-1)), "Fallback recovered cleanly.", "the clean answer is committed");
    assertNoVisibleTrace(harness, "fallback loop");
  });

  await runCase("monitor: malformed calls are never treated as repeats", () => {
    const malformed = (id: string) => ({
      id,
      name: "write_file",
      args: {},
      type: "tool_call",
      [STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY]: { reason: "invalid_json" },
    });
    const response = new AIMessage({
      content: "",
      tool_calls: [malformed("a"), malformed("b"), malformed("c")] as any,
    });
    for (const finalAttempt of [false, true]) {
      const review = new ResponseLoopMonitor({ finalAttempt }).reviewToolCalls(response);
      assertCondition("response" in review, `malformed calls do not trip (finalAttempt=${finalAttempt})`);
      if ("response" in review) {
        assertEqual(review.response.tool_calls.length, 3, "malformed calls are never collapsed");
      }
    }
  });

  await runCase("monitor: a loop longer than the scan window keeps one copy only", () => {
    const monitor = new ResponseLoopMonitor({ finalAttempt: true });
    // One huge delta (non-streaming-style provider): the run spans far more
    // than the detector's trailing window.
    const trip = monitor.observeContent("Intro.\n" + LOOP_TEXT.repeat(400)) ?? monitor.finish();
    assertCondition(trip?.kind === "content", "the loop trips");
    assertEqual(trip?.cleanContent, "Intro.\n" + LOOP_TEXT, "the clean text is the prefix plus one unit");
  });

  await runCase("UI history: a new response never appends into another response's bubble", () => {
    const store = {
      listUiSessionSummaries: () => [],
      listUiSessions: () => [],
      loadUiSession: () => null,
      saveUiSessions: () => {},
      deleteUiSessions: () => {},
    } as any;
    const history = new UIHistoryService({ store });
    history.recordEvent("s", { type: "say", messageId: "attempt-1", content: "old " } as any);
    history.recordEvent("s", { type: "say", messageId: "attempt-2", content: "new" } as any);
    const bubbles = history.getMessages("s");
    assertEqual(bubbles.length, 2, "different responses get different bubbles");
    assertEqual(bubbles[1].content, "new", "the new bubble holds only its own text");
    history.recordEvent("s", { type: "say", messageId: "attempt-2", content: " more" } as any);
    assertEqual(history.getMessages("s")[1].content, "new more", "same-response deltas still append");
    const actions = history.recordEvent("s", { type: "remove_message", messageId: "attempt-1" } as any);
    assertEqual(actions.filter((action) => action.type === "REMOVE_MESSAGE").length, 1, "one removal action");
    assertEqual(history.getMessages("s").length, 1, "only the other response remains");
  });
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
