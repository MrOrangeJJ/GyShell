import { WebSocketGatewayAdapter } from "./WebSocketGatewayAdapter";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}. expected=${expectedJson} actual=${actualJson}`,
    );
  }
};

const assertRejects = async (
  fn: () => Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<void> => {
  try {
    await fn();
    throw new Error(`${message}: expected rejection`);
  } catch (error) {
    const actualMessage =
      error instanceof Error ? error.message : String(error);
    if (!pattern.test(actualMessage)) {
      throw new Error(
        `${message}: unexpected error message "${actualMessage}"`,
      );
    }
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const createAdapter = (
  transferEntries: NonNullable<
    NonNullable<
      ConstructorParameters<typeof WebSocketGatewayAdapter>[1]["filesystemBridge"]
    >["transferEntries"]
  >,
): WebSocketGatewayAdapter =>
  new WebSocketGatewayAdapter({} as any, {
    host: "127.0.0.1",
    port: 0,
    filesystemBridge: {
      transferEntries,
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

const executeTransferEntries = async (
  adapter: WebSocketGatewayAdapter,
  params: Record<string, unknown>,
): Promise<unknown> =>
  await (adapter as any).executeRequest(
    {
      method: "filesystem:transferEntries",
      params,
    },
    {},
  );

const createAdapterWithFilesystemBridge = (
  filesystemBridge: NonNullable<
    ConstructorParameters<typeof WebSocketGatewayAdapter>[1]["filesystemBridge"]
  >,
): WebSocketGatewayAdapter =>
  new WebSocketGatewayAdapter({} as any, {
    host: "127.0.0.1",
    port: 0,
    filesystemBridge,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

const executeFilesystemMethod = async (
  adapter: WebSocketGatewayAdapter,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> =>
  await (adapter as any).executeRequest(
    {
      method,
      params,
    },
    {},
  );

const run = async (): Promise<void> => {
  await runCase(
    "filesystem transfer forwards keep-both conflict strategy",
    async () => {
      let captured: unknown = null;
      const adapter = createAdapter(
        async (
          sourceTerminalId,
          sourcePaths,
          targetTerminalId,
          targetDirPath,
          options,
        ) => {
          captured = {
            sourceTerminalId,
            sourcePaths,
            targetTerminalId,
            targetDirPath,
            options,
          };
          return {
            mode: "copy",
            totalBytes: 0,
            transferredFiles: 0,
            totalFiles: 0,
          };
        },
      );

      const result = await executeTransferEntries(adapter, {
        sourceTerminalId: "source-terminal",
        sourcePaths: ["/src/report.txt"],
        targetTerminalId: "target-terminal",
        targetDirPath: "/dst",
        mode: "copy",
        transferId: "transfer-1",
        overwrite: false,
        conflictStrategy: "rename",
        chunkSize: 65536,
      });

      assertDeepEqual(
        captured,
        {
          sourceTerminalId: "source-terminal",
          sourcePaths: ["/src/report.txt"],
          targetTerminalId: "target-terminal",
          targetDirPath: "/dst",
          options: {
            mode: "copy",
            transferId: "transfer-1",
            overwrite: false,
            conflictStrategy: "rename",
            chunkSize: 65536,
          },
        },
        "websocket transfer should preserve conflictStrategy",
      );
      assertDeepEqual(
        result,
        {
          mode: "copy",
          totalBytes: 0,
          transferredFiles: 0,
          totalFiles: 0,
        },
        "websocket transfer should return bridge result",
      );
    },
  );

  await runCase(
    "filesystem transfer rejects invalid conflict strategies",
    async () => {
      let callCount = 0;
      const adapter = createAdapter(async () => {
        callCount += 1;
        return {
          mode: "copy",
          totalBytes: 0,
          transferredFiles: 0,
          totalFiles: 0,
        };
      });

      await assertRejects(
        async () => {
          await executeTransferEntries(adapter, {
            sourceTerminalId: "source-terminal",
            sourcePaths: ["/src/report.txt"],
            targetTerminalId: "target-terminal",
            targetDirPath: "/dst",
            conflictStrategy: "duplicate",
          });
        },
        /conflictStrategy must be "error", "overwrite", or "rename"/,
        "invalid conflictStrategy should be rejected",
      );
      assertEqual(callCount, 0, "invalid requests should not call the bridge");
    },
  );

  await runCase(
    "filesystem async transfer RPCs forward normalized task parameters",
    async () => {
      const calls: unknown[] = [];
      const adapter = createAdapterWithFilesystemBridge({
        startTransfer: async (input: any) => {
          calls.push({ method: "start", input });
          return {
            id: "transfer-123",
            origin: input.origin,
            mode: input.mode || "copy",
            sourceTerminalId: input.sourceTerminalId,
            sourceTerminalName: "Source",
            sourceMachineIdentity: "local://default",
            sourcePaths: input.sourcePaths,
            targetTerminalId: input.targetTerminalId,
            targetTerminalName: "Target",
            targetMachineIdentity: "ssh://target:22",
            targetDirPath: input.targetDirPath,
            itemNames: ["report.txt"],
            conflictStrategy: input.conflictStrategy || "rename",
            status: "queued",
            bytesDone: 0,
            totalBytes: 0,
            transferredFiles: 0,
            totalFiles: 0,
            percent: 0,
            message: "queued",
            errorMessage: null,
            cancelRequested: false,
            createdAt: 1,
            updatedAt: 1,
          };
        },
        listTransfers: async (options: any) => {
          calls.push({ method: "list", options });
          return [];
        },
        cancelTransfer: async (transferId) => {
          calls.push({ method: "cancel", transferId });
          return null;
        },
      });

      const started = await executeFilesystemMethod(
        adapter,
        "filesystem:startTransfer",
        {
          origin: "agent",
          mode: "copy",
          sourceTerminalId: "source-terminal",
          sourcePaths: ["/src/report.txt"],
          targetTerminalId: "target-terminal",
          targetDirPath: "/dst",
          conflictStrategy: "rename",
          requireDistinctMachine: true,
          sessionId: "session-a",
          agentRunId: "run-a",
        },
      );
      await executeFilesystemMethod(adapter, "filesystem:listTransfers", {
        includeCompleted: true,
        origin: "agent",
        sessionId: "session-a",
        agentRunId: "run-a",
      });
      await executeFilesystemMethod(adapter, "filesystem:cancelTransfer", {
        transferId: "transfer-123",
      });

      assertDeepEqual(
        calls,
        [
          {
            method: "start",
            input: {
              origin: "agent",
              sourceTerminalId: "source-terminal",
              sourcePaths: ["/src/report.txt"],
              targetTerminalId: "target-terminal",
              targetDirPath: "/dst",
              mode: "copy",
              requireDistinctMachine: true,
              conflictStrategy: "rename",
              sessionId: "session-a",
              agentRunId: "run-a",
            },
          },
          {
            method: "list",
            options: {
              includeCompleted: true,
              origin: "agent",
              sessionId: "session-a",
              agentRunId: "run-a",
            },
          },
          { method: "cancel", transferId: "transfer-123" },
        ],
        "async transfer websocket RPCs should forward normalized parameters",
      );
      assertEqual(
        (started as any).id,
        "transfer-123",
        "startTransfer should return the bridge snapshot",
      );
    },
  );

  await runCase(
    "filesystem cancelTransferTask RPC cancels async transfer tasks",
    async () => {
      const calls: unknown[] = [];
      const adapter = createAdapterWithFilesystemBridge({
        cancelTransferTask: async (transferId) => {
          calls.push({ method: "cancelTask", transferId });
          return null;
        },
      });

      await executeFilesystemMethod(adapter, "filesystem:cancelTransferTask", {
        transferId: "transfer-123",
      });

      assertDeepEqual(
        calls,
        [{ method: "cancelTask", transferId: "transfer-123" }],
        "cancelTransferTask websocket RPC should call the async task cancel bridge",
      );
    },
  );

  await runCase("empty session lists retain the UI revision boundary", async () => {
    const adapter = new WebSocketGatewayAdapter(
      {
        listSessionSummaries: () => [],
        getUiRevision: () => 42,
      } as any,
      {
        host: "127.0.0.1",
        port: 0,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      },
    );

    const result = await (adapter as any).executeRequest(
      { method: "session:list", params: {} },
      {},
    );
    assertDeepEqual(
      result,
      { sessions: [], uiRevision: 42 },
      "an empty list response still needs an authoritative replay boundary",
    );
  });
};

void run()
  .then(() => {
    console.log("All WebSocketGatewayAdapter extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
