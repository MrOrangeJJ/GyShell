import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { captureRawResponseChunk } from "./raw_response";
import { appendStreamedModelResponseChunk } from "./streamed_model_response";
import {
  STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY,
  buildToolArgumentContracts,
  reconcileStreamedToolCalls,
} from "./streamed_tool_call_integrity";

type ExpectedToolCall = {
  id: string;
  index: number;
  name: string;
  args: Record<string, unknown>;
  argumentJson: string;
};

type RawToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read one file.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
  },
} as const;

const NO_ARGUMENT_TOOL = {
  type: "function",
  function: {
    name: "no_argument_tool",
    description: "Return a fixed value.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
} as const;

const OTHER_READ_TOOL = {
  type: "function",
  function: {
    name: "other_read_tool",
    description: "Read through another adapter.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
} as const;

const EXPECTED_CALLS: ExpectedToolCall[] = Array.from(
  { length: 5 },
  (_, index) => {
    const args = {
      filePath: `/tmp/gyshell-stream-fixture-${index}.txt`,
    };
    return {
      id: `call-stream-${index}`,
      index,
      name: "read_file",
      args,
      argumentJson: JSON.stringify(args),
    };
  },
);

function runCase(
  name: string,
  test: () => Promise<void> | void,
): Promise<void> {
  return Promise.resolve()
    .then(test)
    .then(() => {
      console.log(`PASS ${name}`);
    });
}

function createRawChunk(options: {
  toolCalls?: RawToolCallDelta[];
  finishReason?: string | null;
  includeAssistantRole?: boolean;
}): Record<string, unknown> {
  return {
    id: "chatcmpl-gyshell-stream-integrity",
    object: "chat.completion.chunk",
    created: 1_750_000_000,
    model: "gyshell-stream-fixture",
    choices: [
      {
        index: 0,
        delta: {
          ...(options.includeAssistantRole ? { role: "assistant" } : {}),
          ...(options.toolCalls ? { tool_calls: options.toolCalls } : {}),
        },
        finish_reason: options.finishReason ?? null,
      },
    ],
  };
}

function createCompleteRawChunks(
  calls: ExpectedToolCall[] = EXPECTED_CALLS,
): Record<string, unknown>[] {
  const splitAtByIndex = calls.map((call) =>
    Math.max(1, Math.floor(call.argumentJson.length / 2)),
  );
  const continuationOrder = calls.map((_, ordinal) => ordinal).reverse();
  return [
    createRawChunk({
      includeAssistantRole: true,
      toolCalls: calls.map((call, index) => ({
        index: call.index,
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.argumentJson.slice(0, splitAtByIndex[index]),
        },
      })),
    }),
    createRawChunk({
      toolCalls: continuationOrder.map((callIndex) => {
        const call = calls[callIndex];
        return {
          index: call.index,
          function: {
            arguments: call.argumentJson.slice(splitAtByIndex[callIndex]),
          },
        };
      }),
    }),
    createRawChunk({ finishReason: "tool_calls" }),
  ];
}

function createDamagedLangChain112Aggregate(): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [
      { ...EXPECTED_CALLS[0], type: "tool_call" },
      {
        ...EXPECTED_CALLS[2],
        index: 8,
        args: {},
        type: "tool_call",
      },
      { ...EXPECTED_CALLS[3], index: 6, type: "tool_call" },
      {
        ...EXPECTED_CALLS[4],
        args: {},
        type: "tool_call",
      },
    ] as any,
    invalid_tool_calls: [
      {
        id: EXPECTED_CALLS[1].id,
        name: EXPECTED_CALLS[1].name,
        args:
          EXPECTED_CALLS[1].argumentJson +
          EXPECTED_CALLS[2].argumentJson +
          EXPECTED_CALLS[4].argumentJson,
        error: "Malformed tool call produced by the 1.1.12 numeric-index merge",
        type: "invalid_tool_call",
      },
    ],
    response_metadata: { finish_reason: "tool_calls" },
  } as any);
}

function assertCalls(
  response: any,
  expected: ExpectedToolCall[],
  message: string,
): void {
  assert.ok(Array.isArray(response?.tool_calls), `${message}: tool_calls`);
  assert.equal(
    response.tool_calls.length,
    expected.length,
    `${message}: count`,
  );

  response.tool_calls.forEach((call: any, ordinal: number) => {
    const expectedCall = expected[ordinal];
    assert.equal(call.id, expectedCall.id, `${message}: call ${ordinal} id`);
    assert.equal(
      call.index,
      expectedCall.index,
      `${message}: call ${ordinal} index`,
    );
    assert.equal(
      call.name,
      expectedCall.name,
      `${message}: call ${ordinal} name`,
    );
    assert.deepEqual(
      call.args,
      expectedCall.args,
      `${message}: call ${ordinal} args`,
    );
  });
}

function assertNativeLangChainAggregate(response: any): void {
  assert.equal(
    response?.invalid_tool_calls?.length ?? 0,
    0,
    "the pinned LangChain core must not produce invalid calls",
  );
  assert.equal(
    response?.tool_calls?.length,
    EXPECTED_CALLS.length,
    "the pinned LangChain core must aggregate every streamed call",
  );
  response.tool_calls.forEach((call: any, ordinal: number) => {
    const expected = EXPECTED_CALLS[ordinal];
    assert.equal(call.id, expected.id, `native call ${ordinal} id`);
    assert.equal(call.name, expected.name, `native call ${ordinal} name`);
    assert.deepEqual(call.args, expected.args, `native call ${ordinal} args`);
  });
  assert.deepEqual(
    response.tool_call_chunks.map((chunk: any) => chunk.index),
    EXPECTED_CALLS.map((call) => call.index),
    "the pinned LangChain core must preserve every streamed index",
  );
}

function assertIntegrityFailure(call: any, expectedId: string): void {
  assert.equal(call.id, expectedId, "failed call must retain its provider ID");
  assert.ok(
    call?.[STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY],
    `call ${expectedId} must carry an integrity failure marker`,
  );
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runRealSseRegression(): Promise<void> {
  const rawEvents = createCompleteRawChunks();
  const requestBodies: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        requestBodies.push(JSON.parse(body));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const event of rawEvents) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });

  const port = await listen(server);
  try {
    const model = new ChatOpenAI({
      model: "gyshell-stream-fixture",
      apiKey: "fixture-api-key",
      configuration: {
        baseURL: `http://127.0.0.1:${port}/v1`,
      },
      __includeRawResponse: true,
      maxRetries: 0,
      temperature: 0,
    });
    const modelWithTools = model.bindTools([READ_FILE_TOOL as any]);
    const stream = await modelWithTools.stream([
      new HumanMessage("Read the five fixture files."),
    ]);
    const capturedRawChunks: any[] = [];
    let aggregate: any = null;

    for await (const chunk of stream) {
      const rawChunk = captureRawResponseChunk(chunk, capturedRawChunks);
      aggregate = appendStreamedModelResponseChunk(
        aggregate,
        chunk,
        rawChunk,
      ).response;
    }

    assert.equal(requestBodies.length, 1, "fixture must receive one request");
    assert.equal(requestBodies[0].stream, true, "request must use streaming");
    assert.equal(
      requestBodies[0].tools?.[0]?.function?.name,
      "read_file",
      "request must bind the read_file tool",
    );
    assert.equal(
      capturedRawChunks.length,
      rawEvents.length,
      "all raw SSE events must be captured",
    );
    assertNativeLangChainAggregate(aggregate);

    const contracts = buildToolArgumentContracts([READ_FILE_TOOL]);
    const reconciled = reconcileStreamedToolCalls(
      aggregate,
      capturedRawChunks,
      contracts,
    );
    assert.equal(reconciled.rawCallCount, 5);
    assert.equal(reconciled.requiresNonStreamingFallback, false);
    assertCalls(reconciled.response, EXPECTED_CALLS, "reconciled SSE calls");

    const results = EXPECTED_CALLS.map(
      (call) =>
        new ToolMessage({
          content: `fixture-result-${call.index}`,
          tool_call_id: call.id,
          name: call.name,
        }),
    );
    const stored = mapChatMessagesToStoredMessages([
      reconciled.response,
      ...results,
    ]);
    assertCalls(stored[0]?.data, EXPECTED_CALLS, "stored SSE calls");

    const restored = mapStoredMessagesToChatMessages(stored);
    assertCalls(restored[0], EXPECTED_CALLS, "restored SSE calls");
    assert.equal(
      restored.length,
      6,
      "assistant and all five results must survive",
    );
    restored.slice(1).forEach((message: any, ordinal: number) => {
      const expected = EXPECTED_CALLS[ordinal];
      assert.equal(message.getType(), "tool", `result ${ordinal} type`);
      assert.equal(message.tool_call_id, expected.id, `result ${ordinal} id`);
      assert.equal(message.name, expected.name, `result ${ordinal} name`);
      assert.equal(
        message.content,
        `fixture-result-${expected.index}`,
        `result ${ordinal} content`,
      );
    });
  } finally {
    await close(server);
  }
}

async function main(): Promise<void> {
  await runCase(
    "real ChatOpenAI SSE preserves five fragmented calls and their results",
    runRealSseRegression,
  );

  await runCase(
    "the LangChain 1.1.12 corruption shape is fully rebuilt",
    () => {
      const result = reconcileStreamedToolCalls(
        createDamagedLangChain112Aggregate(),
        createCompleteRawChunks(),
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.rawCallCount, 5);
      assert.equal(result.requiresNonStreamingFallback, false);
      assertCalls(result.response, EXPECTED_CALLS, "rebuilt 1.1.12 calls");
      assert.deepEqual(result.response.invalid_tool_calls ?? [], []);
    },
  );

  await runCase(
    "unselected streaming choices never become executable tool calls",
    () => {
      const selected = EXPECTED_CALLS[0];
      const alternative = EXPECTED_CALLS[1];
      const response = new AIMessage({
        content: "",
        tool_calls: [{ ...selected, type: "tool_call" }] as any,
        response_metadata: { finish_reason: "tool_calls" },
      });
      const rawChunks = [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: selected.index,
                    id: selected.id,
                    type: "function",
                    function: {
                      name: selected.name,
                      arguments: selected.argumentJson,
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
            {
              index: 1,
              delta: {
                tool_calls: [
                  {
                    index: alternative.index,
                    id: alternative.id,
                    type: "function",
                    function: {
                      name: alternative.name,
                      arguments: alternative.argumentJson,
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ];

      const result = reconcileStreamedToolCalls(
        response,
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.rawCallCount, 1);
      assertCalls(result.response, [selected], "selected streaming choice");
      assert.equal(
        result.response.tool_calls[0][STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY],
        undefined,
      );
    },
  );

  await runCase(
    "an unselected tool_calls finish never triggers non-stream fallback",
    () => {
      const alternative = EXPECTED_CALLS[1];
      const response = new AIMessage({
        content: "Selected answer.",
        response_metadata: { finish_reason: "stop" },
      });
      const rawChunks = [
        {
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
                    index: alternative.index,
                    id: alternative.id,
                    type: "function",
                    function: {
                      name: alternative.name,
                      arguments: alternative.argumentJson,
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ];

      const result = reconcileStreamedToolCalls(
        response,
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "pass_through");
      assert.equal(result.rawCallCount, 0);
      assert.equal(result.requiresNonStreamingFallback, false);
      assert.equal(result.response, response);
    },
  );

  await runCase(
    "inferred and explicit raw calls colliding at one index both fail closed",
    () => {
      const inferred = EXPECTED_CALLS[0];
      const explicit = { ...EXPECTED_CALLS[1], index: 0 };
      const rawChunks = [
        createRawChunk({
          toolCalls: [
            {
              id: inferred.id,
              type: "function",
              function: {
                name: inferred.name,
                arguments: inferred.argumentJson,
              },
            },
          ],
        }),
        createRawChunk({
          toolCalls: [
            {
              index: explicit.index,
              id: explicit.id,
              type: "function",
              function: {
                name: explicit.name,
                arguments: explicit.argumentJson,
              },
            },
          ],
          finishReason: "tool_calls",
        }),
      ];
      const result = reconcileStreamedToolCalls(
        new AIMessage({
          content: "",
          response_metadata: { finish_reason: "tool_calls" },
        }),
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      assert.equal(result.response.tool_calls.length, 2);
      assert.deepEqual(
        result.response.tool_calls.map((call: any) => call.id),
        [inferred.id, explicit.id],
      );
      result.response.tool_calls.forEach((call: any) => {
        assertIntegrityFailure(call, call.id);
        assert.equal(call.index, 0);
      });
    },
  );

  await runCase("recoverable invalid_tool_calls are never discarded", () => {
    const expected = EXPECTED_CALLS[0];
    const response = new AIMessage({
      content: "",
      invalid_tool_calls: [
        {
          id: expected.id,
          name: expected.name,
          args: expected.argumentJson,
          error: "Synthetic parser failure",
          type: "invalid_tool_call",
        },
      ],
      response_metadata: { finish_reason: "tool_calls" },
    } as any);
    const result = reconcileStreamedToolCalls(
      response,
      createCompleteRawChunks([expected]),
      buildToolArgumentContracts([READ_FILE_TOOL]),
    );

    assert.equal(result.requiresNonStreamingFallback, false);
    assertCalls(result.response, [expected], "recovered invalid call");
    assert.deepEqual(result.response.invalid_tool_calls ?? [], []);
  });

  await runCase(
    "aggregate valid and invalid entries sharing an ID fail closed without raw SSE",
    () => {
      const expected = EXPECTED_CALLS[0];
      const response = new AIMessage({
        content: "",
        tool_calls: [{ ...expected, type: "tool_call" }] as any,
        invalid_tool_calls: [
          {
            id: expected.id,
            name: expected.name,
            args: '{"filePath":',
            error: "Conflicting aggregate parser output",
            type: "invalid_tool_call",
          },
        ],
        response_metadata: { finish_reason: "tool_calls" },
      } as any);
      const result = reconcileStreamedToolCalls(
        response,
        [],
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      assert.equal(result.response.tool_calls.length, 1);
      assertIntegrityFailure(result.response.tool_calls[0], expected.id);
      assert.deepEqual(result.response.invalid_tool_calls ?? [], []);
    },
  );

  await runCase(
    "an invalid aggregate entry marks every valid entry sharing its duplicate ID",
    () => {
      const first = EXPECTED_CALLS[0];
      const second = { ...EXPECTED_CALLS[1], id: first.id };
      const response = new AIMessage({
        content: "",
        tool_calls: [
          { ...first, type: "tool_call" },
          { ...second, type: "tool_call" },
        ] as any,
        invalid_tool_calls: [
          {
            id: first.id,
            name: first.name,
            args: '{"filePath":',
            error: "Duplicate-ID parser conflict",
            type: "invalid_tool_call",
          },
        ],
        response_metadata: { finish_reason: "tool_calls" },
      } as any);
      const result = reconcileStreamedToolCalls(
        response,
        [],
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      assert.equal(result.response.tool_calls.length, 2);
      result.response.tool_calls.forEach((call: any) =>
        assertIntegrityFailure(call, first.id),
      );
    },
  );

  await runCase(
    "duplicate aggregate IDs fail closed when raw SSE is unavailable",
    () => {
      const first = EXPECTED_CALLS[0];
      const second = { ...EXPECTED_CALLS[1], id: first.id };
      const result = reconcileStreamedToolCalls(
        new AIMessage({
          content: "",
          tool_calls: [
            { ...first, type: "tool_call" },
            { ...second, type: "tool_call" },
          ] as any,
          response_metadata: { finish_reason: "tool_calls" },
        }),
        [],
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      result.response.tool_calls.forEach((call: any) =>
        assertIntegrityFailure(call, first.id),
      );
    },
  );

  await runCase(
    "conflicting aggregate calls at one index fail closed without raw SSE",
    () => {
      const first = EXPECTED_CALLS[0];
      const second = { ...EXPECTED_CALLS[1], index: first.index };
      const result = reconcileStreamedToolCalls(
        new AIMessage({
          content: "",
          tool_calls: [
            { ...first, type: "tool_call" },
            { ...second, type: "tool_call" },
          ] as any,
          response_metadata: { finish_reason: "tool_calls" },
        }),
        [],
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      assertIntegrityFailure(result.response.tool_calls[0], first.id);
      assertIntegrityFailure(result.response.tool_calls[1], second.id);
    },
  );

  await runCase(
    "non-empty raw arguments repair an anomalous empty object",
    () => {
      const expected = EXPECTED_CALLS[0];
      const response = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: expected.id,
            index: expected.index,
            name: expected.name,
            args: {},
            type: "tool_call",
          },
        ] as any,
        response_metadata: { finish_reason: "tool_calls" },
      });
      const result = reconcileStreamedToolCalls(
        response,
        createCompleteRawChunks([expected]),
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.requiresNonStreamingFallback, false);
      assertCalls(result.response, [expected], "repaired empty arguments");
    },
  );

  await runCase(
    "a legitimate zero-argument call is not a false positive",
    () => {
      const expected: ExpectedToolCall = {
        id: "call-no-arguments",
        index: 0,
        name: "no_argument_tool",
        args: {},
        argumentJson: "{}",
      };
      const response = new AIMessage({
        content: "",
        tool_calls: [{ ...expected, type: "tool_call" }] as any,
        response_metadata: { finish_reason: "tool_calls" },
      });
      const result = reconcileStreamedToolCalls(
        response,
        createCompleteRawChunks([expected]),
        buildToolArgumentContracts([NO_ARGUMENT_TOOL]),
      );

      assert.equal(result.requiresNonStreamingFallback, false);
      assert.equal(result.issues.length, 0);
      assertCalls(result.response, [expected], "zero-argument call");
      assert.equal(
        result.response.tool_calls[0][STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY],
        undefined,
      );
    },
  );

  await runCase(
    "unsupported raw argument value types never masquerade as legal empty objects",
    () => {
      for (const [label, malformedArguments] of [
        ["array", []],
        ["null", null],
      ] as const) {
        const id = `call-unsupported-${label}`;
        const rawChunks = [
          createRawChunk({
            toolCalls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: "no_argument_tool",
                  arguments: malformedArguments,
                },
              },
            ],
          }),
          createRawChunk({ finishReason: "tool_calls" }),
        ];
        const result = reconcileStreamedToolCalls(
          new AIMessage({
            content: "",
            response_metadata: { finish_reason: "tool_calls" },
          }),
          rawChunks,
          buildToolArgumentContracts([NO_ARGUMENT_TOOL]),
        );

        assert.equal(result.status, "malformed_with_identity");
        assert.equal(result.response.tool_calls.length, 1);
        assertIntegrityFailure(result.response.tool_calls[0], id);
      }
    },
  );

  await runCase(
    "malformed JSON retains its call ID as an explicit failure",
    () => {
      const rawChunks = [
        createRawChunk({
          toolCalls: [
            {
              index: 0,
              id: "call-malformed-json",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"filePath":',
              },
            },
          ],
        }),
        createRawChunk({ finishReason: "tool_calls" }),
      ];
      const response = new AIMessage({
        content: "",
        invalid_tool_calls: [
          {
            id: "call-malformed-json",
            name: "read_file",
            args: '{"filePath":',
            error: "Malformed JSON",
            type: "invalid_tool_call",
          },
        ],
        response_metadata: { finish_reason: "tool_calls" },
      } as any);
      const result = reconcileStreamedToolCalls(
        response,
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.requiresNonStreamingFallback, false);
      assert.equal(result.response.tool_calls.length, 1);
      assertIntegrityFailure(
        result.response.tool_calls[0],
        "call-malformed-json",
      );
      assert.equal(result.response.tool_calls[0].index, 0);
      assert.deepEqual(
        Object.keys(
          result.response.tool_calls[0][STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY],
        ).sort(),
        ["rawIndex", "reason"],
        "non-debug persisted markers must not retain raw argument fragments",
      );
    },
  );

  await runCase(
    "a raw call without a provider ID is retained but never executable",
    () => {
      const rawChunks = [
        createRawChunk({
          toolCalls: [
            {
              index: 0,
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"filePath":"/tmp/missing-id.txt"}',
              },
            },
          ],
        }),
        createRawChunk({ finishReason: "tool_calls" }),
      ];
      const result = reconcileStreamedToolCalls(
        new AIMessage({
          content: "",
          response_metadata: { finish_reason: "tool_calls" },
        }),
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      assert.equal(result.requiresNonStreamingFallback, false);
      assert.equal(result.response.tool_calls.length, 1);
      assertIntegrityFailure(result.response.tool_calls[0], "");
      assert.equal(result.response.tool_calls[0].index, 0);
      assert.equal(result.response.tool_calls[0].name, "read_file");
      assert.deepEqual(result.response.tool_calls[0].args, {
        filePath: "/tmp/missing-id.txt",
      });
    },
  );

  await runCase(
    "a call without ID or index remains an explicit failure during fallback",
    () => {
      const rawChunks = [
        createRawChunk({
          toolCalls: [
            {
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"filePath":"/tmp/no-identity.txt"}',
              },
            },
          ],
          finishReason: "tool_calls",
        }),
      ];
      const result = reconcileStreamedToolCalls(
        new AIMessage({
          content: "",
          response_metadata: { finish_reason: "tool_calls" },
        }),
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      assert.equal(result.requiresNonStreamingFallback, true);
      assert.equal(result.rawCallCount, 1);
      assert.equal(result.response.tool_calls.length, 1);
      assertIntegrityFailure(result.response.tool_calls[0], "");
      assert.equal(result.response.tool_calls[0].index, 0);
      assert.equal(result.response.tool_calls[0].name, "read_file");
      assert.deepEqual(result.response.tool_calls[0].args, {
        filePath: "/tmp/no-identity.txt",
      });
    },
  );

  await runCase(
    "a non-object raw call entry is materialized instead of silently dropped",
    () => {
      const rawChunks = [
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [null] },
              finish_reason: "tool_calls",
            },
          ],
        },
      ];
      const result = reconcileStreamedToolCalls(
        new AIMessage({
          content: "",
          response_metadata: { finish_reason: "tool_calls" },
        }),
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.status, "malformed_with_identity");
      assert.equal(result.requiresNonStreamingFallback, true);
      assert.equal(result.rawCallCount, 1);
      assert.equal(result.response.tool_calls.length, 1);
      assertIntegrityFailure(result.response.tool_calls[0], "");
      assert.equal(result.response.tool_calls[0].index, 0);
    },
  );

  await runCase(
    "conflicting IDs at one index are both retained as failures",
    () => {
      const rawChunks = [
        createRawChunk({
          toolCalls: [
            {
              index: 0,
              id: "call-conflict-a",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"filePath":"/tmp/a.txt"}',
              },
            },
          ],
        }),
        createRawChunk({
          toolCalls: [
            {
              index: 0,
              id: "call-conflict-b",
              type: "function",
              function: {
                name: "other_read_tool",
                arguments: '{"path":"/tmp/b.txt"}',
              },
            },
          ],
        }),
        createRawChunk({ finishReason: "tool_calls" }),
      ];
      const result = reconcileStreamedToolCalls(
        new AIMessage({
          content: "",
          response_metadata: { finish_reason: "tool_calls" },
        }),
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL, OTHER_READ_TOOL]),
      );

      assert.equal(result.requiresNonStreamingFallback, false);
      assert.equal(result.rawCallCount, 2);
      assert.deepEqual(
        result.response.tool_calls.map((call: any) => ({
          id: call.id,
          index: call.index,
          name: call.name,
          args: call.args,
        })),
        [
          {
            id: "call-conflict-a",
            index: 0,
            name: "read_file",
            args: { filePath: "/tmp/a.txt" },
          },
          {
            id: "call-conflict-b",
            index: 0,
            name: "other_read_tool",
            args: { path: "/tmp/b.txt" },
          },
        ],
      );
      assertIntegrityFailure(result.response.tool_calls[0], "call-conflict-a");
      assertIntegrityFailure(result.response.tool_calls[1], "call-conflict-b");
    },
  );

  await runCase(
    "a tool-call finish without payload requests safe fallback",
    () => {
      const rawChunks = [createRawChunk({ finishReason: "tool_calls" })];
      const response = new AIMessage({
        content: "",
        response_metadata: { finish_reason: "tool_calls" },
      });
      const result = reconcileStreamedToolCalls(
        response,
        rawChunks,
        buildToolArgumentContracts([READ_FILE_TOOL]),
      );

      assert.equal(result.rawCallCount, 0);
      assert.equal(result.requiresNonStreamingFallback, true);
      assert.deepEqual(result.response.tool_calls ?? [], []);
    },
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
