import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  AIMessageChunk,
  ChatMessageChunk,
  HumanMessage,
} from "@langchain/core/messages";
import { AgentService_v2 } from "../../AgentService_v2";
import { ChatHistoryService } from "../../ChatHistoryService";
import { UIHistoryService } from "../../UIHistoryService";
import { HistorySqliteStore } from "../../history/HistorySqliteStore";
import {
  EMPTY_MALFORMED_TOOL_CALL_FINISH_KEY,
  appendStreamedModelResponseChunk,
  extractStreamedResponseUsage,
  isEmptyMalformedToolCallFinish,
  isEmptyUnusableModelResponse,
} from "./streamed_model_response";
import { captureRawResponseChunk } from "./raw_response";

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

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const REASONING_ONLY_TEXT = "I should call a tool next.";

const createMalformedToolCallRawChunk = (): Record<string, any> => ({
  id: "chatcmpl-glm",
  model: "ZHIPU/GLM-5.2",
  choices: [
    {
      index: 0,
      delta: {
        role: "assistant",
        content: "",
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 219964,
    completion_tokens: 78,
    total_tokens: 220042,
  },
});

const createEmptyErrorRawChunk = (): Record<string, any> => ({
  id: "gen-gemini-empty-error",
  model: "google/gemini-3.5-flash-20260519",
  choices: [
    {
      index: 0,
      delta: {
        role: "assistant",
        content: "",
      },
      finish_reason: "error",
    },
  ],
  usage: {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  },
});

const createReasoningOnlyMalformedToolCallRawChunk = (): Record<
  string,
  any
> => ({
  id: "chatcmpl-glm-reasoning",
  model: "ZHIPU/GLM-5.2",
  choices: [
    {
      index: 0,
      delta: {
        role: "assistant",
        content: "",
        reasoning_content: REASONING_ONLY_TEXT,
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 219964,
    completion_tokens: 78,
    total_tokens: 220042,
  },
});

const createMalformedAssistantChunk = (): AIMessageChunk =>
  new AIMessageChunk({
    content: "",
    response_metadata: {
      model_name: "ZHIPU/GLM-5.2",
      finish_reason: "tool_calls",
    },
    additional_kwargs: {
      __raw_response: createMalformedToolCallRawChunk(),
    },
  });

const createEmptyErrorAssistantChunk = (): AIMessageChunk =>
  new AIMessageChunk({
    content: "",
    response_metadata: {
      model_name: "google/gemini-3.5-flash-20260519",
      finish_reason: "error",
    },
    additional_kwargs: {
      __raw_response: createEmptyErrorRawChunk(),
    },
  });

const createReasoningOnlyMalformedAssistantChunk = (): AIMessageChunk =>
  new AIMessageChunk({
    content: "",
    response_metadata: {
      model_name: "ZHIPU/GLM-5.2",
      finish_reason: "tool_calls",
    },
    additional_kwargs: {
      reasoning_content: REASONING_ONLY_TEXT,
      __raw_response: createReasoningOnlyMalformedToolCallRawChunk(),
    },
  });

const createMetadataOnlyGenericToolCallFinishChunk = (): ChatMessageChunk =>
  new ChatMessageChunk({
    content: "",
    role: "",
    response_metadata: {
      model_name: "ZHIPU/GLM-5.2",
      finish_reason: "tool_calls",
      usage: {
        prompt_tokens: 219964,
        completion_tokens: 78,
        total_tokens: 220042,
      },
    },
  } as any);

const createRawOnlyGenericToolCallFinishChunk = (): ChatMessageChunk =>
  new ChatMessageChunk({
    content: "",
    role: "",
    additional_kwargs: {
      __raw_response: createMalformedToolCallRawChunk(),
    },
  } as any);

const createMetadataOnlyGenericStopFinishChunk = (): ChatMessageChunk =>
  new ChatMessageChunk({
    content: "",
    role: "",
    response_metadata: {
      model_name: "ZHIPU/GLM-5.2",
      finish_reason: "stop",
      usage: {
        prompt_tokens: 219964,
        completion_tokens: 0,
        total_tokens: 219964,
      },
    },
  } as any);

const createTextAssistantMessage = (content: string): AIMessage =>
  new AIMessage({
    content,
    response_metadata: {
      model_name: "ZHIPU/GLM-5.2",
      finish_reason: "stop",
      usage: {
        prompt_tokens: 220000,
        completion_tokens: 12,
        total_tokens: 220012,
      },
    },
  });

const createReasoningOnlyMalformedAssistantMessage = (): AIMessage =>
  new AIMessage({
    content: "",
    response_metadata: {
      model_name: "ZHIPU/GLM-5.2",
      finish_reason: "tool_calls",
      usage: {
        prompt_tokens: 219964,
        completion_tokens: 78,
        total_tokens: 220042,
      },
    },
    additional_kwargs: {
      reasoning_content: REASONING_ONLY_TEXT,
    },
  });

class FakeStreamingModel {
  public modelName = "ZHIPU/GLM-5.2";
  public model = "ZHIPU/GLM-5.2";
  public streamCalls = 0;
  public invokeCalls = 0;
  public requests: any[][] = [];
  public invokeRequests: any[][] = [];

  bindTools(): {
    stream: () => AsyncGenerator<any>;
    invoke: () => Promise<any>;
  } {
    throw new Error("base streaming model should not run directly");
  }
}

class FakeGenericMetadataFinishStreamWithInvokeModel extends FakeStreamingModel {
  constructor(private readonly invokeResponse: AIMessage) {
    super();
  }

  bindTools(): {
    stream: (messages?: any[]) => AsyncGenerator<any>;
    invoke: (messages?: any[]) => Promise<any>;
  } {
    const self = this;
    return {
      stream: async function* (messages?: any[]) {
        self.streamCalls += 1;
        self.requests.push(Array.isArray(messages) ? messages : []);
        yield new AIMessageChunk({
          content: "",
          response_metadata: {
            model_name: "ZHIPU/GLM-5.2",
          },
        });
        yield createMetadataOnlyGenericToolCallFinishChunk();
      },
      invoke: async (messages?: any[]) => {
        self.invokeCalls += 1;
        self.invokeRequests.push(Array.isArray(messages) ? messages : []);
        return self.invokeResponse;
      },
    };
  }
}

class FakeRawOnlyFinishStreamWithInvokeModel extends FakeStreamingModel {
  constructor(private readonly invokeResponse: AIMessage) {
    super();
  }

  bindTools(): {
    stream: (messages?: any[]) => AsyncGenerator<any>;
    invoke: (messages?: any[]) => Promise<any>;
  } {
    const self = this;
    return {
      stream: async function* (messages?: any[]) {
        self.streamCalls += 1;
        self.requests.push(Array.isArray(messages) ? messages : []);
        yield createRawOnlyGenericToolCallFinishChunk();
      },
      invoke: async (messages?: any[]) => {
        self.invokeCalls += 1;
        self.invokeRequests.push(Array.isArray(messages) ? messages : []);
        return self.invokeResponse;
      },
    };
  }
}

class FakeMalformedStreamWithInvokeModel extends FakeStreamingModel {
  constructor(
    private readonly invokeResponse: AIMessage,
    private readonly streamChunkFactory: () => AIMessageChunk = createMalformedAssistantChunk,
  ) {
    super();
  }

  bindTools(): {
    stream: (messages?: any[]) => AsyncGenerator<any>;
    invoke: (messages?: any[]) => Promise<any>;
  } {
    const self = this;
    return {
      stream: async function* (messages?: any[]) {
        self.streamCalls += 1;
        self.requests.push(Array.isArray(messages) ? messages : []);
        yield new ChatMessageChunk({ content: "", role: "" });
        yield self.streamChunkFactory();
      },
      invoke: async (messages?: any[]) => {
        self.invokeCalls += 1;
        self.invokeRequests.push(Array.isArray(messages) ? messages : []);
        return self.invokeResponse;
      },
    };
  }
}

class FakeEmptyErrorThenTextModel extends FakeStreamingModel {
  bindTools(): {
    stream: (messages?: any[]) => AsyncGenerator<any>;
    invoke: () => Promise<never>;
  } {
    const self = this;
    return {
      stream: async function* (messages?: any[]) {
        self.streamCalls += 1;
        self.requests.push(Array.isArray(messages) ? messages : []);
        if (self.streamCalls === 1) {
          yield createEmptyErrorAssistantChunk();
          return;
        }
        yield new AIMessageChunk({
          content: "Recovered answer.",
          response_metadata: {
            model_name: "google/gemini-3.5-flash-20260519",
            finish_reason: "stop",
            usage: {
              prompt_tokens: 100,
              completion_tokens: 4,
              total_tokens: 104,
            },
          },
        });
      },
      invoke: async () => {
        self.invokeCalls += 1;
        throw new Error("empty error retry should not use non-stream invoke");
      },
    };
  }
}

class FakePartialToolFailureThenTextModel extends FakeStreamingModel {
  bindTools(): {
    stream: (messages?: any[]) => AsyncGenerator<any>;
    invoke: () => Promise<never>;
  } {
    const self = this;
    return {
      stream: async function* (messages?: any[]) {
        self.streamCalls += 1;
        self.requests.push(Array.isArray(messages) ? messages : []);
        if (self.streamCalls === 1) {
          yield new AIMessageChunk({
            content: "",
            tool_call_chunks: [
              {
                id: "stale-retry-call",
                name: "read_file",
                args: '{"filePath":"/tmp/stale-retry.txt"}',
                index: 0,
                type: "tool_call_chunk",
              },
            ],
            additional_kwargs: {
              __raw_response: {
                id: "chatcmpl-stale-retry",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "stale-retry-call",
                          type: "function",
                          function: {
                            name: "read_file",
                            arguments: '{"filePath":"/tmp/stale-retry.txt"}',
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
          throw new Error("synthetic stream transport failure");
        }

        yield new AIMessageChunk({
          content: "Accepted retry answer.",
          response_metadata: {
            model_name: "ZHIPU/GLM-5.2",
            finish_reason: "stop",
          },
        });
      },
      invoke: async () => {
        self.invokeCalls += 1;
        throw new Error("transport retry should remain on the stream path");
      },
    };
  }
}

const createUnidentifiedToolCallRawResponse = (): Record<string, any> => ({
  id: "chatcmpl-unidentified-tool-call",
  model: "ZHIPU/GLM-5.2",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"filePath":"/tmp/no-identity.txt"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
});

class FakeUnidentifiedToolCallFallbackModel extends FakeStreamingModel {
  bindTools(): {
    stream: (messages?: any[]) => AsyncGenerator<any>;
    invoke: (messages?: any[]) => Promise<any>;
  } {
    const self = this;
    return {
      stream: async function* (messages?: any[]) {
        self.streamCalls += 1;
        self.requests.push(Array.isArray(messages) ? messages : []);
        yield new AIMessageChunk({
          content: "",
          response_metadata: { finish_reason: "tool_calls" },
          additional_kwargs: {
            __raw_response: createUnidentifiedToolCallRawResponse(),
          },
        });
      },
      invoke: async (messages?: any[]) => {
        self.invokeCalls += 1;
        self.invokeRequests.push(Array.isArray(messages) ? messages : []);
        return new AIMessage({
          content: "",
          response_metadata: { finish_reason: "stop" },
        });
      },
    };
  }
}

class GuardShouldNotRunModel extends FakeStreamingModel {
  public streamCalls = 0;
  public invokeCalls = 0;

  bindTools(): {
    stream: () => AsyncGenerator<any>;
    invoke: () => Promise<any>;
  } {
    const self = this;
    return {
      stream: async function* () {
        self.streamCalls += 1;
        throw new Error("completion guard should not request a tool call");
      },
      invoke: async () => {
        self.invokeCalls += 1;
        throw new Error("completion guard should not invoke a tool call");
      },
    };
  }

  withStructuredOutput(): { invoke: () => Promise<never> } {
    const self = this;
    return {
      invoke: async () => {
        self.invokeCalls += 1;
        throw new Error("completion guard should not invoke structured output");
      },
    };
  }
}

const createAgentService = (
  chatHistory: ChatHistoryService,
  uiHistory: UIHistoryService,
): AgentService_v2 =>
  new AgentService_v2(
    {
      getAllTerminals: () => [],
      getRecentOutput: () => "",
    } as any,
    {} as any,
    {
      getActiveTools: () => [],
      isMcpToolName: () => false,
    } as any,
    {
      reload: async () => {},
      getEnabledSkills: async () => [],
      readSkillContentByName: async () => {
        throw new Error("skill lookup should not run");
      },
    } as any,
    {
      getMemorySnapshot: async () => ({
        enabled: false,
        filePath: "",
        content: "",
      }),
    } as any,
    uiHistory,
    chatHistory,
  );

const run = async (): Promise<void> => {
  await runCase(
    "empty generic stream chunks do not own the response type",
    () => {
      const skipped = appendStreamedModelResponseChunk(
        null,
        new ChatMessageChunk({ content: "", role: "" }),
      );
      assertEqual(
        skipped.response,
        null,
        "empty generic chunk should not initialize the aggregate response",
      );
      assertEqual(
        skipped.skippedEmptyGenericChunk,
        true,
        "empty generic chunk should be reported as skipped",
      );

      const appended = appendStreamedModelResponseChunk(
        skipped.response,
        createMalformedAssistantChunk(),
      );
      assertEqual(
        appended.response?._getType(),
        "ai",
        "assistant chunk should own the aggregate response type",
      );
    },
  );

  await runCase(
    "metadata-bearing empty generic chunks are merged into assistant responses",
    () => {
      const response = new AIMessageChunk({
        content: "",
        response_metadata: {
          model_name: "ZHIPU/GLM-5.2",
        },
      });

      const appended = appendStreamedModelResponseChunk(
        response,
        createMetadataOnlyGenericToolCallFinishChunk(),
      );

      assertEqual(
        appended.skippedEmptyGenericChunk,
        false,
        "metadata-bearing generic chunks should not be discarded",
      );
      assertEqual(
        appended.response?._getType(),
        "ai",
        "metadata-bearing generic chunks should preserve the assistant aggregate type",
      );
      assertEqual(
        appended.response?.response_metadata?.finish_reason,
        "tool_calls",
        "finish_reason should be merged from a metadata-only generic chunk",
      );
      assertEqual(
        extractStreamedResponseUsage(appended.response, [])?.totalTokens,
        220042,
        "usage should be merged from a metadata-only generic chunk",
      );
      assertEqual(
        isEmptyMalformedToolCallFinish(appended.response, []),
        true,
        "merged generic finish metadata should still trigger malformed detection",
      );
    },
  );

  await runCase(
    "metadata-bearing empty generic chunks initialize assistant metadata responses",
    () => {
      const appended = appendStreamedModelResponseChunk(
        null,
        createMetadataOnlyGenericToolCallFinishChunk(),
      );

      assertEqual(
        appended.response?._getType(),
        "ai",
        "metadata-only generic chunks should not own the aggregate response type",
      );
      assertEqual(
        isEmptyMalformedToolCallFinish(appended.response, []),
        true,
        "metadata-only generic tool_calls finishes should be detectable without raw chunks",
      );
    },
  );

  await runCase(
    "non-tool metadata-only generic chunks do not initialize assistant responses",
    () => {
      const appended = appendStreamedModelResponseChunk(
        null,
        createMetadataOnlyGenericStopFinishChunk(),
      );

      assertEqual(
        appended.response,
        null,
        "metadata-only non-tool generic chunks should not create empty assistant responses",
      );
      assertEqual(
        appended.skippedEmptyGenericChunk,
        true,
        "metadata-only non-tool generic chunks should retain the old skip behavior",
      );
    },
  );

  await runCase(
    "raw-only empty generic tool-call finishes initialize assistant metadata responses",
    () => {
      const chunk = createRawOnlyGenericToolCallFinishChunk();
      const rawChunks: any[] = [];
      const rawChunk = captureRawResponseChunk(chunk, rawChunks);

      assertEqual(
        chunk.additional_kwargs?.__raw_response,
        undefined,
        "raw response capture should remove the raw payload before append runs",
      );

      const appended = appendStreamedModelResponseChunk(
        null,
        chunk,
        rawChunk,
      );

      assertEqual(
        appended.skippedEmptyGenericChunk,
        false,
        "raw-only generic tool_calls finishes should not be discarded",
      );
      assertEqual(
        appended.response?._getType(),
        "ai",
        "raw-only generic tool_calls finishes should create an internal assistant aggregate",
      );
      assertEqual(
        appended.response?.response_metadata?.finish_reason,
        "tool_calls",
        "finish_reason should be recovered from raw response metadata",
      );
      assertEqual(
        extractStreamedResponseUsage(appended.response, rawChunks)?.totalTokens,
        220042,
        "usage should still be recoverable from captured raw chunks",
      );
      assertEqual(
        isEmptyMalformedToolCallFinish(appended.response, rawChunks),
        true,
        "raw-only generic tool_calls finishes should trigger malformed detection",
      );
    },
  );

  await runCase("raw usage and malformed tool-call finish are detected", () => {
    const raw = createMalformedToolCallRawChunk();
    const response = new AIMessageChunk({
      content: "",
      response_metadata: {
        finish_reason: "tool_calls",
      },
    });

    const usage = extractStreamedResponseUsage(response, [raw]);
    assertEqual(
      usage?.totalTokens,
      220042,
      "usage should fall back to the raw streamed chunk",
    );
    assertEqual(
      isEmptyMalformedToolCallFinish(response, [raw]),
      true,
      "empty tool_calls finish without tool call payload should be malformed",
    );
  });

  await runCase(
    "finish and payload checks ignore unselected streaming choices",
    () => {
      const raw = {
        id: "chatcmpl-multiple-choices",
        choices: [
          {
            index: 0,
            delta: { content: "Selected answer." },
            finish_reason: "stop",
          },
          {
            index: 1,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "unselected-tool-call",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/unselected.txt"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      const selectedResponse = new AIMessage({
        content: "Selected answer.",
        response_metadata: { finish_reason: "stop" },
      });

      assertEqual(
        isEmptyMalformedToolCallFinish(selectedResponse, [raw]),
        false,
        "an unselected tool_calls finish must not request fallback",
      );
      assertEqual(
        isEmptyUnusableModelResponse(selectedResponse, [raw]),
        false,
        "the selected answer must remain usable",
      );
      assertEqual(
        isEmptyUnusableModelResponse(
          new AIMessage({
            content: "",
            response_metadata: { finish_reason: "stop" },
          }),
          [raw],
        ),
        true,
        "an unselected tool payload must not make an empty selected response usable",
      );

      const rawOnlyGeneric = new ChatMessageChunk({
        content: "",
        role: "",
        additional_kwargs: { __raw_response: raw },
      } as any);
      const captured: any[] = [];
      const rawChunk = captureRawResponseChunk(rawOnlyGeneric, captured);
      const appended = appendStreamedModelResponseChunk(
        null,
        rawOnlyGeneric,
        rawChunk,
      );
      assertEqual(
        appended.response,
        null,
        "an unselected tool_calls finish must not initialize an assistant response",
      );
      assertEqual(appended.skippedEmptyGenericChunk, true, "chunk should skip");
    },
  );

  await runCase(
    "empty provider error finishes are treated as unusable model responses",
    () => {
      const rawChunks: any[] = [];
      const chunk = createEmptyErrorAssistantChunk();
      const rawChunk = captureRawResponseChunk(chunk, rawChunks);
      const appended = appendStreamedModelResponseChunk(null, chunk, rawChunk);

      assertEqual(
        isEmptyMalformedToolCallFinish(appended.response, rawChunks),
        false,
        "provider error finishes are not malformed tool-call finishes",
      );
      assertEqual(
        isEmptyUnusableModelResponse(appended.response, rawChunks),
        true,
        "empty provider error finishes should not be accepted as final assistant output",
      );
      assertEqual(
        extractStreamedResponseUsage(appended.response, rawChunks)?.totalTokens,
        0,
        "zero-usage provider error chunks should still expose usage for diagnostics",
      );
    },
  );

  await runCase(
    "valid empty tool calls are not treated as generic unusable responses",
    () => {
      const response = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-read",
            name: "read_file",
            args: { filePath: "README.md" },
          } as any,
        ],
        response_metadata: {
          finish_reason: "tool_calls",
        },
      } as any);

      assertEqual(
        isEmptyUnusableModelResponse(response, []),
        false,
        "tool-call payloads should stay routable even when assistant text is empty",
      );
    },
  );

  await runCase(
    "reasoning-only tool-call finish is still malformed",
    () => {
      const raw = createReasoningOnlyMalformedToolCallRawChunk();
      const response = createReasoningOnlyMalformedAssistantChunk();

      assertEqual(
        isEmptyMalformedToolCallFinish(response, [raw]),
        true,
        "reasoning metadata should not make an empty tool_calls finish usable",
      );
    },
  );

  await runCase(
    "generic finish metadata without raw response uses non-stream fallback once",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gyshell-stream-response-extreme-"),
      );
      const store = new HistorySqliteStore({
        filePath: path.join(tempDir, "history.sqlite3"),
      });
      const chatHistory = new ChatHistoryService({ store });
      const uiHistory = new UIHistoryService({ store });
      const agent = createAgentService(chatHistory, uiHistory);
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => {
        events.push(event);
      });

      const sessionId = "glm-generic-metadata-tool-call-finish";
      const profileId = "glm-profile";
      const mainModel = new FakeGenericMetadataFinishStreamWithInvokeModel(
        createTextAssistantMessage("Fallback answer."),
      );
      const guardModel = new GuardShouldNotRunModel();
      (agent as any).sessionModelBindings.set(sessionId, {
        profileId,
        model: mainModel,
        actionModel: guardModel,
        thinkingModel: guardModel,
        compactionModel: guardModel,
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

      await agent.run(
        {
          sessionId,
          lockedProfileId: profileId,
          metadata: {},
          lockedExperimentalFlags: {
            runtimeThinkingCorrectionEnabled: false,
            taskFinishGuardEnabled: false,
            firstTurnThinkingModelEnabled: false,
            execCommandActionModelEnabled: true,
            writeStdinActionModelEnabled: true,
          },
        } as any,
        "continue",
        new AbortController().signal,
      );

      assertEqual(
        mainModel.invokeCalls,
        1,
        "metadata-only generic finish should trigger one non-stream fallback",
      );
      assertCondition(
        events.some(
          (event) =>
            event.type === "say" && event.content === "Fallback answer.",
        ),
        "fallback text should be emitted after metadata-only generic finish",
      );
      assertEqual(
        events.some(
          (event) =>
            event.type === "alert" &&
            String(event.message).includes("non-stream fallback"),
        ),
        false,
        "successful fallback should not warn for metadata-only generic finish",
      );
    },
  );

  await runCase(
    "raw-only generic finish metadata uses non-stream fallback once",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gyshell-stream-response-extreme-"),
      );
      const store = new HistorySqliteStore({
        filePath: path.join(tempDir, "history.sqlite3"),
      });
      const chatHistory = new ChatHistoryService({ store });
      const uiHistory = new UIHistoryService({ store });
      const agent = createAgentService(chatHistory, uiHistory);
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => {
        events.push(event);
      });

      const sessionId = "glm-raw-only-tool-call-finish";
      const profileId = "glm-profile";
      const mainModel = new FakeRawOnlyFinishStreamWithInvokeModel(
        createTextAssistantMessage("Fallback answer."),
      );
      const guardModel = new GuardShouldNotRunModel();
      (agent as any).sessionModelBindings.set(sessionId, {
        profileId,
        model: mainModel,
        actionModel: guardModel,
        thinkingModel: guardModel,
        compactionModel: guardModel,
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

      await agent.run(
        {
          sessionId,
          lockedProfileId: profileId,
          metadata: {},
          lockedExperimentalFlags: {
            runtimeThinkingCorrectionEnabled: false,
            taskFinishGuardEnabled: false,
            firstTurnThinkingModelEnabled: false,
            execCommandActionModelEnabled: true,
            writeStdinActionModelEnabled: true,
          },
        } as any,
        "continue",
        new AbortController().signal,
      );

      assertEqual(
        mainModel.streamCalls,
        1,
        "raw-only generic finish should stream the original request once",
      );
      assertEqual(
        mainModel.invokeCalls,
        1,
        "raw-only generic finish should trigger one non-stream fallback",
      );
      assertEqual(
        events.some((event) => event.type === "error"),
        false,
        "raw-only generic finish should not throw before fallback",
      );
      assertCondition(
        events.some(
          (event) =>
            event.type === "say" && event.content === "Fallback answer.",
        ),
        "fallback text should be emitted after raw-only generic finish",
      );
      assertEqual(
        events.some(
          (event) =>
            event.type === "alert" &&
            String(event.message).includes("non-stream fallback"),
        ),
        false,
        "successful fallback should not warn for raw-only generic finish",
      );
    },
  );

  await runCase(
    "reasoning-only malformed tool-call finish uses non-stream fallback once",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gyshell-stream-response-extreme-"),
      );
      const store = new HistorySqliteStore({
        filePath: path.join(tempDir, "history.sqlite3"),
      });
      const chatHistory = new ChatHistoryService({ store });
      const uiHistory = new UIHistoryService({ store });
      const agent = createAgentService(chatHistory, uiHistory);
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => {
        events.push(event);
      });

      const sessionId = "glm-malformed-tool-call-finish";
      const profileId = "glm-profile";
      const mainModel = new FakeMalformedStreamWithInvokeModel(
        createTextAssistantMessage("Fallback answer."),
        createReasoningOnlyMalformedAssistantChunk,
      );
      const guardModel = new GuardShouldNotRunModel();
      (agent as any).sessionModelBindings.set(sessionId, {
        profileId,
        model: mainModel,
        actionModel: guardModel,
        thinkingModel: guardModel,
        compactionModel: guardModel,
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

      await agent.run(
        {
          sessionId,
          lockedProfileId: profileId,
          metadata: {},
          lockedExperimentalFlags: {
            runtimeThinkingCorrectionEnabled: false,
            taskFinishGuardEnabled: false,
            firstTurnThinkingModelEnabled: false,
            execCommandActionModelEnabled: true,
            writeStdinActionModelEnabled: true,
          },
        } as any,
        "continue",
        new AbortController().signal,
      );

      const tokenEvent = events.find((event) => event.type === "tokens_count");
      assertEqual(
        tokenEvent?.totalTokens,
        220012,
        "non-stream fallback usage should be emitted as the token count",
      );
      assertCondition(
        events.some(
          (event) =>
            event.type === "say" && event.content === "Fallback answer.",
        ),
        "the fallback response should be displayed as assistant text",
      );
      assertEqual(
        events.some(
          (event) =>
            event.type === "alert" &&
            String(event.message).includes("non-stream fallback"),
        ),
        false,
        "successful non-stream fallback should not warn the user",
      );
      assertCondition(
        events.some((event) => event.type === "done"),
        "run should complete cleanly",
      );
      assertEqual(
        events.some((event) => event.type === "error"),
        false,
        "malformed empty tool-call finish should not become a generic error",
      );
      assertEqual(
        mainModel.streamCalls,
        1,
        "main model should stream the original request once",
      );
      assertEqual(
        mainModel.invokeCalls,
        1,
        "main model should use one non-stream fallback invoke for the same request",
      );
      assertEqual(
        mainModel.invokeRequests[0]?.length,
        mainModel.requests[0]?.length,
        "fallback invoke should receive the same sanitized request messages",
      );

      const saved = chatHistory.loadSession(sessionId);
      const storedMessages = Array.from(saved?.messages.values() ?? []);
      const lastStored = storedMessages[storedMessages.length - 1] as any;
      assertEqual(
        lastStored?.type,
        "ai",
        "backend history should retain the fallback assistant response",
      );
      assertEqual(
        lastStored?.data?.content,
        "Fallback answer.",
        "backend history should persist the fallback assistant text",
      );
      assertEqual(
        storedMessages.some(
          (message: any) =>
            message?.data?.additional_kwargs?.[
              EMPTY_MALFORMED_TOOL_CALL_FINISH_KEY
            ],
        ),
        false,
        "backend history should not persist the internal malformed response",
      );
    },
  );

  await runCase(
    "empty provider error stream retries instead of ending the turn silently",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gyshell-stream-response-extreme-"),
      );
      const store = new HistorySqliteStore({
        filePath: path.join(tempDir, "history.sqlite3"),
      });
      const chatHistory = new ChatHistoryService({ store });
      const uiHistory = new UIHistoryService({ store });
      const agent = createAgentService(chatHistory, uiHistory);
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => {
        events.push(event);
      });

      const sessionId = "gemini-empty-error-retry";
      const profileId = "gemini-profile";
      const mainModel = new FakeEmptyErrorThenTextModel();
      const guardModel = new GuardShouldNotRunModel();
      (agent as any).sessionModelBindings.set(sessionId, {
        profileId,
        model: mainModel,
        actionModel: guardModel,
        thinkingModel: guardModel,
        compactionModel: guardModel,
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

      await agent.run(
        {
          sessionId,
          lockedProfileId: profileId,
          metadata: {},
          lockedExperimentalFlags: {
            runtimeThinkingCorrectionEnabled: false,
            taskFinishGuardEnabled: false,
            firstTurnThinkingModelEnabled: false,
            execCommandActionModelEnabled: true,
            writeStdinActionModelEnabled: true,
          },
        } as any,
        "continue",
        new AbortController().signal,
      );

      assertEqual(
        mainModel.streamCalls,
        2,
        "empty provider error finish should retry the streaming request",
      );
      assertEqual(
        mainModel.invokeCalls,
        0,
        "empty provider error finish should not use the tool-call fallback invoke path",
      );
      assertCondition(
        events.some(
          (event) =>
            event.type === "alert" &&
            String(event.message).includes("Retrying"),
        ),
        "retry should be visible to the UI",
      );
      assertCondition(
        events.some(
          (event) =>
            event.type === "say" && event.content === "Recovered answer.",
        ),
        "retry recovery should emit the successful assistant text",
      );
      assertEqual(
        guardModel.streamCalls + guardModel.invokeCalls,
        0,
        "completion guard should not be needed after retry recovery with task guard disabled",
      );

      const saved = chatHistory.loadSession(sessionId);
      const storedMessages = Array.from(saved?.messages.values() ?? []);
      const emptyErrorStored = storedMessages.some((message: any) => {
        const data = message?.data || message;
        return (
          data?.type === "ai" &&
          data?.content === "" &&
          String(data?.response_metadata?.finish_reason || "").includes(
            "error",
          )
        );
      });
      assertEqual(
        emptyErrorStored,
        false,
        "backend history should not persist the transient empty provider error response",
      );
    },
  );

  await runCase(
    "an unidentified call receives an error result when fallback is unusable",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gyshell-stream-response-extreme-"),
      );
      const store = new HistorySqliteStore({
        filePath: path.join(tempDir, "history.sqlite3"),
      });
      const chatHistory = new ChatHistoryService({ store });
      const uiHistory = new UIHistoryService({ store });
      const agent = createAgentService(chatHistory, uiHistory);
      agent.setEventPublisher(() => {});
      const sessionId = "unidentified-tool-call-fallback";
      const profileId = "unidentified-profile";
      const mainModel = new FakeUnidentifiedToolCallFallbackModel();
      const guardModel = new GuardShouldNotRunModel();
      (agent as any).sessionModelBindings.set(sessionId, {
        profileId,
        model: mainModel,
        actionModel: guardModel,
        thinkingModel: guardModel,
        compactionModel: guardModel,
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

      const modelState = await (
        agent as any
      ).createModelRequestNode().invoke(
        {
          sessionId,
          physicalRunId: "unidentified-physical-run",
          messages: [new HumanMessage("read the file")],
          token_state: { current_tokens: 0, max_tokens: 1000000 },
          modelRequestPassCount: 0,
          runtimeThinkingCorrectionEnabled: false,
          firstTurnThinkingModelEnabled: false,
        },
        { signal: new AbortController().signal },
      );

      assertEqual(mainModel.streamCalls, 1, "stream should run once");
      assertEqual(mainModel.invokeCalls, 1, "fallback should run once");
      const assistant = modelState.messages.at(-1) as AIMessage;
      assertEqual(
        assistant.tool_calls?.length,
        1,
        "the failed stream call must remain materialized",
      );

      const batch = await (
        agent as any
      ).createBatchToolcallExecutorNode().invoke(modelState);
      assertEqual(batch.pendingToolCalls.length, 1, "call must reach planner");
      assertEqual(
        batch.pendingToolCalls[0]._gyshellExecution.mode,
        "not_executed",
        "an unidentified call must never execute",
      );
      assertEqual(
        batch.pendingToolCalls[0]._gyshellExecution.outcomeStatus,
        "error",
        "integrity failure must use an error outcome",
      );

      const completed = await (agent as any).createToolsNode().invoke(batch);
      const toolResult = completed.messages.at(-1);
      assertCondition(
        typeof toolResult?.tool_call_id === "string" &&
          toolResult.tool_call_id.length > 0,
        "the repaired call and result must share a non-empty synthetic ID",
      );
      assertEqual(
        toolResult.tool_call_id,
        assistant.tool_calls?.[0]?.id,
        "assistant call and explicit result IDs must match",
      );
      assertEqual(
        JSON.parse(String(toolResult.content)).status,
        "error",
        "fallback failure must produce an explicit error result",
      );
    },
  );

  await runCase(
    "an accepted retry clears a failed stream attempt before later stop persistence",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gyshell-stream-response-extreme-"),
      );
      const store = new HistorySqliteStore({
        filePath: path.join(tempDir, "history.sqlite3"),
      });
      const chatHistory = new ChatHistoryService({ store });
      const uiHistory = new UIHistoryService({ store });
      const agent = createAgentService(chatHistory, uiHistory);
      agent.setEventPublisher(() => {});
      const sessionId = "accepted-stream-retry";
      const physicalRunId = "accepted-stream-retry-run";
      const profileId = "retry-profile";
      const mainModel = new FakePartialToolFailureThenTextModel();
      const guardModel = new GuardShouldNotRunModel();
      (agent as any).sessionModelBindings.set(sessionId, {
        profileId,
        model: mainModel,
        actionModel: guardModel,
        thinkingModel: guardModel,
        compactionModel: guardModel,
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
      (agent as any).activePhysicalRunIds.add(physicalRunId);

      let observedFailedAttempt = false;
      (agent as any).helpers.invokeWithRetry = async (operation: any) => {
        try {
          return await operation(0);
        } catch {
          const captured = (agent as any).abortedMessagesByRunId.get(
            physicalRunId,
          );
          assertEqual(
            captured?.length,
            2,
            "failed attempt should temporarily retain its assistant call and cancelled result",
          );
          assertEqual(
            captured?.[1]?.tool_call_id,
            "stale-retry-call",
            "temporary failed-attempt result should retain the original call ID",
          );
          observedFailedAttempt = true;
          return await operation(1);
        }
      };

      const result = await (agent as any).createModelRequestNode().invoke(
        {
          sessionId,
          physicalRunId,
          messages: [new HumanMessage("retry the failed request")],
          token_state: { current_tokens: 0, max_tokens: 1000000 },
          modelRequestPassCount: 0,
          runtimeThinkingCorrectionEnabled: false,
          firstTurnThinkingModelEnabled: false,
        },
        { signal: new AbortController().signal },
      );

      assertEqual(
        observedFailedAttempt,
        true,
        "the first failed stream should exercise interrupted-attempt capture",
      );
      assertEqual(
        mainModel.streamCalls,
        2,
        "the accepted response should come from the second stream attempt",
      );
      assertEqual(
        (agent as any).abortedMessagesByRunId.has(physicalRunId),
        false,
        "an accepted retry must clear the superseded failed-attempt bundle",
      );

      (agent as any).graph = {
        getState: async () => ({ values: { messages: result.messages } }),
      };
      await (agent as any).trySaveSessionFromCheckpoint(
        sessionId,
        physicalRunId,
      );
      const persisted = JSON.stringify(
        Array.from(chatHistory.loadSession(sessionId)?.messages.values() ?? []),
      );
      assertCondition(
        persisted.includes("Accepted retry answer."),
        "later stop persistence should retain the accepted retry response",
      );
      assertEqual(
        persisted.includes("stale-retry-call"),
        false,
        "later stop persistence must not resurrect the superseded attempt",
      );
    },
  );

  await runCase(
    "reasoning-only malformed tool-call finish warns when non-stream fallback is also malformed",
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gyshell-stream-response-extreme-"),
      );
      const store = new HistorySqliteStore({
        filePath: path.join(tempDir, "history.sqlite3"),
      });
      const chatHistory = new ChatHistoryService({ store });
      const uiHistory = new UIHistoryService({ store });
      const agent = createAgentService(chatHistory, uiHistory);
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => {
        events.push(event);
      });

      const sessionId = "glm-repeated-malformed-tool-call-finish";
      const profileId = "glm-profile";
      const mainModel = new FakeMalformedStreamWithInvokeModel(
        createReasoningOnlyMalformedAssistantMessage(),
        createReasoningOnlyMalformedAssistantChunk,
      );
      const guardModel = new GuardShouldNotRunModel();
      (agent as any).sessionModelBindings.set(sessionId, {
        profileId,
        model: mainModel,
        actionModel: guardModel,
        thinkingModel: guardModel,
        compactionModel: guardModel,
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

      await agent.run(
        {
          sessionId,
          lockedProfileId: profileId,
          metadata: {},
          lockedExperimentalFlags: {
            runtimeThinkingCorrectionEnabled: false,
            taskFinishGuardEnabled: false,
            firstTurnThinkingModelEnabled: false,
            execCommandActionModelEnabled: true,
            writeStdinActionModelEnabled: true,
          },
        } as any,
        "continue",
        new AbortController().signal,
      );

      assertEqual(
        mainModel.streamCalls,
        1,
        "malformed stream should not trigger another stream request",
      );
      assertEqual(
        mainModel.invokeCalls,
        1,
        "malformed stream should try exactly one non-stream fallback",
      );
      assertCondition(
        events.some(
          (event) =>
            event.type === "alert" &&
            String(event.message).includes("non-stream fallback"),
        ),
        "failed non-stream fallback should warn the user",
      );
      assertCondition(
        events.some((event) => event.type === "done"),
        "fallback failure should still end the turn cleanly",
      );
      assertEqual(
        guardModel.streamCalls + guardModel.invokeCalls,
        0,
        "completion guard should not run for malformed fallback failure",
      );

      const saved = chatHistory.loadSession(sessionId);
      const storedMessages = Array.from(saved?.messages.values() ?? []);
      assertEqual(
        storedMessages.some(
          (message: any) =>
            message?.data?.additional_kwargs?.[
              EMPTY_MALFORMED_TOOL_CALL_FINISH_KEY
            ],
        ),
        false,
        "backend history should not persist repeated internal malformed responses",
      );
    },
  );
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
