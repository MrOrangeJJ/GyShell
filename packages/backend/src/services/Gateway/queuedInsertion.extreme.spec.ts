import { GatewayService } from "./GatewayService";
import { AgentService_v2 } from "../AgentService_v2";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  AGENT_NOTIFICATION_TAG,
  CONTINUE_INSTRUCTION_TAG,
  createBaseSystemPromptText,
} from "../AgentHelper/prompts";
import {
  buildExecCommandNowaitCompletedInsertion,
  buildFileTransferFinishedInsertion,
  EXEC_COMMAND_NOTIFICATION_MAX_UTF8_BYTES,
} from "../AgentHelper/queuedInsertions";
import type { StartTaskInput, StartTaskMode } from "./types";
import type {
  QueuedAgentInsertionAcknowledger,
  QueuedAgentInsertion,
  QueuedAgentInsertionAvailabilityWaiter,
  QueuedAgentInsertionEnqueuer,
  QueuedAgentInsertionProvider,
  RunBackgroundExecCommand,
  RunBackgroundExecCommandCompleter,
  RunBackgroundExecCommandRegistrar,
  UnfinishedRunBackgroundExecCommandProvider,
} from "../AgentHelper/queuedInsertions";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const assertTruthy = (value: unknown, message: string): void => {
  if (!value) {
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

class FakeAgentRuntime {
  public provider: QueuedAgentInsertionProvider | null = null;
  public acknowledger: QueuedAgentInsertionAcknowledger | null = null;
  public availabilityWaiter: QueuedAgentInsertionAvailabilityWaiter | null =
    null;
  public enqueuer: QueuedAgentInsertionEnqueuer | null = null;
  public registrar: RunBackgroundExecCommandRegistrar | null = null;
  public completer: RunBackgroundExecCommandCompleter | null = null;
  public unfinishedProvider: UnfinishedRunBackgroundExecCommandProvider | null =
    null;
  public runs: Array<{ input: StartTaskInput; startMode: StartTaskMode }> = [];
  public drainedDuringRun: QueuedAgentInsertion[][] = [];
  public unfinishedDuringRun: RunBackgroundExecCommand[][] = [];
  public onRun:
    | ((
        context: any,
        input: StartTaskInput,
        signal: AbortSignal,
        startMode: StartTaskMode,
      ) => Promise<void> | void)
    | null = null;

  setEventPublisher(): void {}

  setFeedbackWaiter(): void {}

  setQueuedInsertionProvider(provider: QueuedAgentInsertionProvider): void {
    this.provider = provider;
  }

  setQueuedInsertionAcknowledger(
    acknowledger: QueuedAgentInsertionAcknowledger,
  ): void {
    this.acknowledger = acknowledger;
  }

  setQueuedInsertionAvailabilityWaiter(
    waiter: QueuedAgentInsertionAvailabilityWaiter,
  ): void {
    this.availabilityWaiter = waiter;
  }

  setQueuedInsertionEnqueuer(enqueuer: QueuedAgentInsertionEnqueuer): void {
    this.enqueuer = enqueuer;
  }

  setBackgroundExecCommandRegistrar(
    registrar: RunBackgroundExecCommandRegistrar,
  ): void {
    this.registrar = registrar;
  }

  setBackgroundExecCommandCompleter(
    completer: RunBackgroundExecCommandCompleter,
  ): void {
    this.completer = completer;
  }

  setUnfinishedBackgroundExecCommandProvider(
    provider: UnfinishedRunBackgroundExecCommandProvider,
  ): void {
    this.unfinishedProvider = provider;
  }

  async run(
    context: any,
    input: StartTaskInput,
    signal: AbortSignal,
    startMode: StartTaskMode = "normal",
  ): Promise<void> {
    this.runs.push({ input, startMode });
    await this.onRun?.(context, input, signal, startMode);
  }

  isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  releaseSessionModelBinding(): void {}

  listStoredChatSessions(): any[] {
    return [];
  }

  listStoredChatSessionSummaries(): any[] {
    return [];
  }

  loadChatSession(): null {
    return null;
  }

  deleteChatSession(): void {}

  deleteChatSessions(): void {}

  renameChatSession(): void {}

  exportChatSession(): null {
    return null;
  }

  rollbackToMessage(): { ok: boolean; removedCount: number } {
    return { ok: false, removedCount: 0 };
  }

  branchFromMessage(): { ok: boolean } {
    return { ok: false };
  }
}

class FakeUIHistoryService {
  public events: any[] = [];

  recordEvent(_sessionId: string, event: any): any[] {
    this.events.push(event);
    return [];
  }

  flush(): void {}

  getAllSessionSummaries(): any[] {
    return [];
  }

  getSession(): null {
    return null;
  }
}

const createGateway = (): {
  gateway: GatewayService;
  agent: FakeAgentRuntime;
  uiHistory: FakeUIHistoryService;
} => {
  const agent = new FakeAgentRuntime();
  const uiHistory = new FakeUIHistoryService();
  const gateway = new GatewayService(
    {
      setRawEventPublisher: () => {},
      getAllTerminals: () => [],
    } as any,
    agent as any,
    uiHistory as any,
    {
      setFeedbackWaiter: () => {},
    } as any,
    {
      getSettings: () =>
        ({
          schemaVersion: 3,
          commandPolicyMode: "standard",
          model: "fake",
          baseUrl: "",
          apiKey: "",
          models: {
            items: [],
            profiles: [],
            activeProfileId: "fake-profile",
          },
          connections: {
            ssh: [],
            proxies: [],
            tunnels: [],
          },
          tools: {
            builtIn: {},
          },
          gateway: {
            ws: {
              access: "localhost",
              port: 17888,
            },
          },
        }) as any,
    } as any,
    {
      on: () => ({}),
    } as any,
  );
  return { gateway, agent, uiHistory };
};

const createAgentService = (
  terminalService: any = {},
  mcpToolService: any = {},
): AgentService_v2 =>
  new AgentService_v2(
    {
      resolveTerminal(tabIdOrName: string) {
        const terminal = {
          id: tabIdOrName,
          title: tabIdOrName,
          type: "local",
        };
        return { found: [terminal], bestMatch: terminal };
      },
      getTransferMachineIdentity() {
        return "local://default";
      },
      ...terminalService,
    } as any,
    {} as any,
    {
      isMcpToolName: () => false,
      getActiveTools: () => [],
      ...mcpToolService,
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

const run = async (): Promise<void> => {
  await runCase(
    "reconnect terminal tab is a model-visible tool-call boundary",
    async () => {
      const agent = createAgentService();
      const reconnectCall = {
        id: "call-reconnect",
        name: "reconnect_terminal_tab",
        args: { tabIdOrName: "ssh-disconnected" },
      };
      const editCall = {
        id: "call-edit",
        name: "edit_file",
        args: { filePath: "/tmp/stale.txt", instructions: "edit" },
      };
      const stdinCall = {
        id: "call-stdin",
        name: "write_stdin",
        args: { tabIdOrName: "ssh-disconnected", sequence: ["pwd\n"] },
      };
      const assistantMessage = new AIMessage({
        content: "",
        tool_calls: [reconnectCall, editCall, stdinCall],
      });

      const node = (agent as any).createBatchToolcallExecutorNode();
      const result = await node.invoke({
        sessionId: "session-reconnect-boundary",
        messages: [assistantMessage],
      });

      assertEqual(
        result.pendingToolCalls.length,
        3,
        "reconnect should preserve every later tool call in the planned batch",
      );
      assertEqual(
        result.pendingToolCalls[0]?.id,
        "call-reconnect",
        "reconnect should remain the first queued tool call",
      );
      assertEqual(
        result.pendingToolCalls[2]?._gyshellExecution?.mode,
        "not_executed",
        "later same-terminal input should be explicitly deferred",
      );

      const cleanedAssistantMessage = result.messages[0] as any;
      assertEqual(
        cleanedAssistantMessage.tool_calls.length,
        3,
        "reconnect boundary should preserve every original assistant tool call",
      );
      assertEqual(
        cleanedAssistantMessage.tool_calls[0]?.id,
        "call-reconnect",
        "assistant history should preserve the reconnect tool call at its original ordinal",
      );
      assertEqual(
        cleanedAssistantMessage.tool_calls[2]?.id,
        "call-stdin",
        "assistant history should retain the deferred stdin call id",
      );
    },
  );

  await runCase(
    "terminal inventory mutations are model-visible tool-call boundaries",
    async () => {
      for (const toolName of ["create_terminal_tab", "close_terminal_tab"]) {
        const agent = createAgentService();
        (agent as any).builtInToolEnabled[toolName] = true;
        const lifecycleCall = {
          id: `call-${toolName}`,
          name: toolName,
          args:
            toolName === "create_terminal_tab"
              ? { connectionId: "local" }
              : { tabIdOrName: "local-existing" },
        };
        const laterCall = {
          id: `call-after-${toolName}`,
          name: "read_terminal_tab",
          args: { tabIdOrName: "local-existing" },
        };
        const assistantMessage = new AIMessage({
          content: "",
          tool_calls: [lifecycleCall, laterCall],
        });

        const node = (agent as any).createBatchToolcallExecutorNode();
        const result = await node.invoke({
          sessionId: `session-${toolName}-boundary`,
          messages: [assistantMessage],
        });

        assertEqual(
          result.pendingToolCalls.length,
          2,
          `${toolName} should preserve every call while creating a model-visible boundary`,
        );
        assertEqual(
          result.pendingToolCalls[0]?.id,
          lifecycleCall.id,
          `${toolName} should remain the first pending tool call`,
        );
        assertEqual(
          result.pendingToolCalls[1]?.id,
          laterCall.id,
          `${toolName} should preserve the later call id`,
        );
        assertEqual(
          result.pendingToolCalls[1]?._gyshellExecution?.mode,
          "not_executed",
          `${toolName} should explicitly defer the later call`,
        );
        assertEqual(
          (result.messages[0] as any).tool_calls.length,
          2,
          `${toolName} should preserve every assistant tool call`,
        );
      }
    },
  );

  await runCase(
    "disabled experimental terminal mutation cannot execute after it was queued",
    async () => {
      let createCalls = 0;
      const agent = createAgentService({
        createTerminal: async () => {
          createCalls += 1;
          return null;
        },
      });
      agent.setEventPublisher(() => {});
      (agent as any).getSessionModelBinding = () => ({});

      assertEqual(
        (agent as any).routeModelOutput({
          pendingToolCalls: [
            {
              id: "call-disabled-create-terminal",
              name: "create_terminal_tab",
              args: { connectionId: "local" },
            },
          ],
        }),
        "tools",
        "disabled terminal mutation should route through the rejection node",
      );

      const node = (agent as any).createToolsNode();
      const result = await node.invoke({
        sessionId: "session-disabled-terminal-mutation",
        messages: [],
        pendingToolCalls: [
          {
            id: "call-disabled-create-terminal",
            name: "create_terminal_tab",
            args: { connectionId: "local" },
          },
        ],
      });

      assertEqual(
        createCalls,
        0,
        "execution-time permission check should block a queued create call",
      );
      const disabledResult = JSON.parse(
        String(result.messages[0]?.content || "{}"),
      );
      assertEqual(
        disabledResult.status,
        "not_executed",
        "blocked queued call should return a structured not_executed result",
      );
      assertTruthy(
        String(disabledResult.reason || "").includes("disabled before execution"),
        "blocked queued call should explain the execution-time permission change",
      );
    },
  );

  await runCase(
    "write_stdin disconnected precheck emits a normal tool event",
    async () => {
      const terminal = {
        id: "ssh-disconnected",
        title: "Disconnected SSH",
        type: "ssh",
      };
      const terminalService = {
        resolveTerminal(tabIdOrName: string) {
          return tabIdOrName === terminal.id
            ? { found: [terminal], bestMatch: terminal }
            : { found: [] };
        },
        getTerminalRuntimeSnapshot(terminalId: string) {
          if (terminalId !== terminal.id) return null;
          return {
            id: terminal.id,
            title: terminal.title,
            type: terminal.type,
            runtimeState: "exited",
            isInitializing: false,
            lastExitCode: 255,
            reconnectable: true,
            canRunCommand: false,
            canWrite: false,
            canUseFilesystem: false,
          };
        },
      };
      const agent = createAgentService(terminalService);
      const events: any[] = [];
      let actionModelCalls = 0;
      agent.setEventPublisher((_sessionId, event) => events.push(event));
      (agent as any).sessionModelBindings.set("session-write-stdin-precheck", {
        actionModel: {
          async invoke() {
            actionModelCalls += 1;
            throw new Error("write_stdin action model should not be called");
          },
        },
      });

      const writeCall = {
        id: "call-write-stdin",
        name: "write_stdin",
        args: { tabIdOrName: terminal.id, sequence: ["ETX"] },
      };
      const node = (agent as any).createToolsNode();
      const result = await node.invoke({
        sessionId: "session-write-stdin-precheck",
        writeStdinActionModelEnabled: true,
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [writeCall],
          }),
        ],
        pendingToolCalls: [writeCall],
      });

      const toolMessage = result.messages[result.messages.length - 1] as any;
      assertEqual(
        String(toolMessage.content).includes("terminal_status:"),
        true,
        "write_stdin tool message should include terminal status",
      );
      assertEqual(
        actionModelCalls,
        0,
        "write_stdin disconnected precheck should not call the action model",
      );

      const toolEvent = events.find(
        (event) =>
          event.type === "tool_call" && event.toolName === "write_stdin",
      );
      assertTruthy(
        toolEvent,
        "write_stdin disconnected precheck should emit a tool_call event",
      );
      assertEqual(
        toolEvent.input,
        JSON.stringify(["ETX"]),
        "write_stdin tool event input should match the normal tool implementation",
      );
      assertEqual(
        String(toolEvent.output).includes("terminal_status:"),
        true,
        "write_stdin tool event output should include terminal status",
      );
      assertEqual(
        toolEvent.output,
        toolMessage.content,
        "write_stdin tool event output should match the tool message",
      );
    },
  );

  await runCase(
    "nowait completion uses documented notification tag format",
    () => {
      const insertion = buildExecCommandNowaitCompletedInsertion({
        terminalId: "terminal-1",
        terminalName: "Local",
        historyCommandMatchId: "history-1",
        command: "printf '<not-xml>\\n'",
        exitCode: 0,
      });

      assertEqual(
        insertion.content.startsWith(AGENT_NOTIFICATION_TAG),
        true,
        "nowait completion should start with the generic notification tag",
      );
      assertEqual(
        insertion.content.includes("<exec_command_nowait_completed>"),
        false,
        "nowait completion should not use xml-style wrapper tags",
      );
      assertEqual(
        insertion.content.includes("EXEC_COMMAND_NOWAIT_COMPLETED:"),
        false,
        "nowait completion should not use an exec-command-specific top-level tag",
      );

      const payload = JSON.parse(
        insertion.content.slice(AGENT_NOTIFICATION_TAG.length),
      );
      assertEqual(
        payload.notification_type,
        "exec_command_nowait_completed",
        "nowait completion should put the concrete event type in the notification body",
      );
      assertEqual(
        payload.history_command_match_id,
        "history-1",
        "nowait completion should include the read_command_output id",
      );
      assertEqual(
        payload.instruction.includes("read_command_output"),
        true,
        "nowait completion should tell the agent how to inspect output",
      );

      const systemPrompt = createBaseSystemPromptText();
      assertEqual(
        systemPrompt.includes(AGENT_NOTIFICATION_TAG.trim()),
        true,
        "system prompt should document the generic notification tag",
      );
      assertEqual(
        systemPrompt.includes("exec_command_nowait_completed"),
        true,
        "system prompt should document the nowait completion notification type",
      );
    },
  );

  await runCase(
    "unknown nowait outcome never claims command completion",
    () => {
      const insertion = buildExecCommandNowaitCompletedInsertion({
        terminalId: "terminal-1",
        terminalName: "Local",
        historyCommandMatchId: "history-unknown",
        command: "long-running-command",
        exitCode: -1,
        runtimeBoundary: true,
      });
      const payload = JSON.parse(
        insertion.content.slice(AGENT_NOTIFICATION_TAG.length),
      );

      assertEqual(
        payload.notification_type,
        "exec_command_nowait_outcome_unknown",
        "tracking loss should emit an unknown-outcome notification",
      );
      assertEqual(
        payload.instruction.includes("Do not assume success"),
        true,
        "unknown outcome should prevent automatic success or replay assumptions",
      );
      assertEqual(
        insertion.kind,
        "exec_command_nowait_outcome_unknown",
        "the queue kind should preserve the unknown-outcome boundary",
      );
      assertEqual(
        Object.prototype.hasOwnProperty.call(payload, "exit_code"),
        false,
        "an unknown outcome must not expose a diagnostic sentinel as an authoritative exit code",
      );
    },
  );

  await runCase(
    "nowait notifications bound adversarial Unicode and JSON expansion",
    () => {
      const huge = "<\u0000😀".repeat(30_000);
      const insertion = buildExecCommandNowaitCompletedInsertion({
        terminalId: huge,
        terminalName: huge,
        historyCommandMatchId: huge,
        command: huge,
        exitCode: 0,
      });
      const payload = JSON.parse(
        insertion.content.slice(AGENT_NOTIFICATION_TAG.length),
      );

      assertEqual(
        Buffer.byteLength(insertion.content, "utf8") <=
          EXEC_COMMAND_NOTIFICATION_MAX_UTF8_BYTES,
        true,
        "the entire queued notification must remain inside its hard byte budget",
      );
      assertEqual(
        payload.command_truncated,
        true,
        "the payload must disclose a shortened command preview",
      );
      assertEqual(
        payload.command_utf8_bytes,
        Buffer.byteLength(huge, "utf8"),
        "the original command size must remain machine-readable",
      );
      assertEqual(
        payload.identifiers_truncated,
        true,
        "identifier JSON expansion must be bounded and disclosed",
      );
      assertEqual(
        payload.terminal_name_truncated,
        true,
        "terminal-name JSON expansion must be bounded and disclosed",
      );
    },
  );

  await runCase(
    "aborted nowait notifications never masquerade as completion",
    () => {
      const insertion = buildExecCommandNowaitCompletedInsertion({
        terminalId: "terminal-aborted",
        terminalName: "Aborted",
        historyCommandMatchId: "history-aborted",
        command: "dangerous-side-effect",
        exitCode: 0,
        executionState: "aborted",
      });
      const payload = JSON.parse(
        insertion.content.slice(AGENT_NOTIFICATION_TAG.length),
      );

      assertEqual(
        insertion.kind,
        "exec_command_nowait_aborted",
        "the queue kind must retain the aborted state",
      );
      assertEqual(
        payload.notification_type,
        "exec_command_nowait_aborted",
        "the Agent-facing payload must explicitly say aborted",
      );
      assertEqual(
        Object.prototype.hasOwnProperty.call(payload, "exit_code"),
        false,
        "an aborted lifecycle must not expose any exit code as authoritative",
      );
      assertEqual(
        payload.instruction.includes("do not assume success or automatically replay"),
        true,
        "aborted instructions must forbid success inference and unsafe replay",
      );
    },
  );

  await runCase(
    "indeterminate shell status uses the same unknown nowait notification",
    () => {
      const insertion = buildExecCommandNowaitCompletedInsertion({
        terminalId: "terminal-win",
        terminalName: "WIN",
        historyCommandMatchId: "history-ambiguous",
        command: "cmd /c exit 7; Write-Error ambiguous",
        executionState: "outcome_unknown",
      });
      const payload = JSON.parse(
        insertion.content.slice(AGENT_NOTIFICATION_TAG.length),
      );

      assertEqual(
        payload.notification_type,
        "exec_command_nowait_outcome_unknown",
        "PowerShell status ambiguity must not be announced as a completed known outcome",
      );
      assertEqual(
        payload.instruction.includes("Do not assume success"),
        true,
        "the queued Agent instruction must preserve safe unknown-outcome behavior",
      );
    },
  );

  await runCase(
    "file transfer failure notification warns about incomplete target output",
    () => {
      const insertion = buildFileTransferFinishedInsertion({
        transferId: "transfer-1",
        sourceTerminalId: "source-terminal",
        sourceTerminalName: "Source",
        targetTerminalId: "target-terminal",
        targetTerminalName: "Target",
        sourcePaths: ["/src/report.txt"],
        targetDirPath: "/dst",
        status: "error",
        error: "source terminal tab was closed",
      });

      const payload = JSON.parse(
        insertion.content.slice(AGENT_NOTIFICATION_TAG.length),
      );
      assertEqual(
        payload.notification_type,
        "file_transfer_finished",
        "file transfer notification should use the generic notification body",
      );
      assertEqual(
        payload.target_output_may_be_incomplete,
        true,
        "failed transfer notification should mark target output as potentially incomplete",
      );
      assertEqual(
        payload.instruction.includes("incomplete files"),
        true,
        "failed transfer notification should warn the agent before it reads target files",
      );
    },
  );

  await runCase("queued insertion messages persist in backend history", () => {
    const agent = createAgentService();
    const queuedMessage = new HumanMessage(
      "<test>hidden-but-persistent</test>",
    );
    (queuedMessage as any).additional_kwargs = {
      _gyshellMessageId: "queued-message-id",
      input_kind: "queued_insertion",
      _gyshellQueuedInsertion: true,
    };
    const ephemeralMessage = new HumanMessage("<test>ephemeral</test>");
    (agent as any).helpers.markEphemeral(ephemeralMessage);
    (ephemeralMessage as any).additional_kwargs = {
      ...(ephemeralMessage as any).additional_kwargs,
      _gyshellMessageId: "ephemeral-message-id",
    };

    const session = {
      id: "session-persist",
      title: "New Session",
      messages: new Map(),
      lastCheckpointOffset: 0,
    };

    (agent as any).updateSessionFromMessages(session, [
      queuedMessage,
      ephemeralMessage,
    ]);

    const persistedQueued = session.messages.get("queued-message-id") as any;
    assertTruthy(
      persistedQueued,
      "hidden queued insertion should persist in backend history",
    );
    assertEqual(
      persistedQueued?.data?.additional_kwargs?._gyshellQueuedInsertion,
      true,
      "persisted queued insertion should keep its marker",
    );
    assertEqual(
      persistedQueued?.data?.additional_kwargs?._gyshellEphemeral,
      undefined,
      "queued insertion should not be marked ephemeral",
    );
    assertEqual(
      session.messages.has("ephemeral-message-id"),
      false,
      "real ephemeral messages should still be excluded from backend history",
    );
  });

  await runCase(
    "unfinished background guard preempts task finish guard",
    async () => {
      const agent = createAgentService();
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => events.push(event));
      agent.setUnfinishedBackgroundExecCommandProvider(
        (_sessionId, _agentRunId) => [
          {
            id: "task-1",
            sessionId: "session-guard",
            agentRunId: "agent-run-1",
            terminalId: "terminal-1",
            terminalName: "Local",
            historyCommandMatchId: "task-1",
            command: "sleep 30",
            createdAt: Date.now(),
          },
        ],
      );
      (agent as any).activeAgentRunIdsBySession.set(
        "session-guard",
        "agent-run-1",
      );
      (agent as any).getThinkingModelDecision = async () => {
        throw new Error(
          "Task finish guard should not run when unfinished task guard fires",
        );
      };

      const node = (agent as any).createTaskCompletionGuardNode();
      const result = await node.invoke({
        sessionId: "session-guard",
        messages: [
          new AIMessage({
            content: "summary",
            additional_kwargs: { _gyshellMessageId: "ai-summary" },
          }),
        ],
      });
      const insertedContent = String(
        result.messages[result.messages.length - 1].content,
      );
      assertEqual(
        result.completionGuardDecision,
        "continue",
        "unfinished background guard should force another model pass",
      );
      assertEqual(
        insertedContent.startsWith(CONTINUE_INSTRUCTION_TAG),
        true,
        "unfinished background guard should use the same continue-instruction mechanism as task finish guard",
      );
      assertEqual(
        insertedContent.includes('history_command_match_id="task-1"'),
        true,
        "unfinished background guard should include the read_command_output id",
      );
      assertEqual(
        events.some(
          (event) =>
            event.type === "remove_message" && event.messageId === "ai-summary",
        ),
        true,
        "unfinished background guard should remove the previous final summary like task finish guard",
      );
    },
  );

  await runCase(
    "task finish guard continue instruction appends full-summary reminder",
    async () => {
      const agent = createAgentService();
      agent.setEventPublisher(() => {});
      (agent as any).activeAgentRunIdsBySession.set(
        "session-task-guard",
        "agent-run-1",
      );
      let decisionCall = 0;
      (agent as any).getThinkingModelDecision = async () => {
        decisionCall += 1;
        return decisionCall === 1
          ? { is_fully_completed: false, reason: "missing verification" }
          : { continue_instruction: "Verify the command output." };
      };

      const node = (agent as any).createTaskCompletionGuardNode();
      const result = await node.invoke({
        sessionId: "session-task-guard",
        messages: [
          new AIMessage({
            content: "premature summary",
            additional_kwargs: { _gyshellMessageId: "ai-summary-2" },
          }),
        ],
      });
      const insertedContent = String(
        result.messages[result.messages.length - 1].content,
      );
      assertEqual(
        insertedContent.endsWith(
          "- Once finished, please re-provide a full complete summary again, disregarding the previous summary.",
        ),
        true,
        "task finish guard continue instruction should end with the summary reminder",
      );
    },
  );

  await runCase(
    "idle queued insertion is ignored and does not wake the session",
    async () => {
      const { agent, uiHistory } = createGateway();
      if (!agent.enqueuer) {
        throw new Error("Gateway should register a queued insertion enqueuer");
      }

      agent.enqueuer("session-idle", {
        kind: "test",
        content: "<test>queued</test>",
        originAgentRunId: "not-active",
      });

      await sleep(25);
      assertEqual(
        agent.runs.length,
        0,
        "idle queued insertion should not start a hidden run",
      );
      assertEqual(
        agent.provider?.("session-idle", "not-active").length,
        0,
        "idle queued insertion should not be retained for a future run",
      );
      assertEqual(
        uiHistory.events.some((event) => event?.type === "user_input"),
        false,
        "ignored idle queued insertion should not emit a visible user_input event",
      );
    },
  );

  await runCase(
    "queued insertions enqueued during the same agent run can be drained",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer || !agent.provider) {
        throw new Error("Gateway should register queued insertion hooks");
      }

      let releaseRun!: () => void;
      const runHold = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      agent.onRun = async (context) => {
        agent.enqueuer?.(context.sessionId, {
          kind: "test",
          content: "<test>during-run</test>",
          originAgentRunId: context.metadata.agentRunId,
        });
        agent.drainedDuringRun.push(
          agent.provider?.(context.sessionId, context.metadata.agentRunId) ||
            [],
        );
        await runHold;
      };

      const dispatchPromise = gateway.dispatchTask(
        "session-active",
        "user task",
      );
      await waitUntil(
        () => agent.drainedDuringRun.length === 1,
        "active run should drain queued insertions through the provider",
      );
      assertEqual(
        agent.runs.length,
        1,
        "queued insertion should not start a nested run while active",
      );
      assertEqual(
        agent.drainedDuringRun[0][0]?.content,
        "<test>during-run</test>",
        "provider should drain the active-run queued insertion",
      );

      releaseRun();
      await dispatchPromise;
      await sleep(25);
      assertEqual(
        agent.runs.length,
        1,
        "drained active-run insertion should not dispatch again after idle",
      );
    },
  );

  await runCase("active queued insertions batch in FIFO order", async () => {
    const { gateway, agent } = createGateway();
    if (!agent.enqueuer) {
      throw new Error("Gateway should register a queued insertion enqueuer");
    }

    let releaseRun!: () => void;
    const runHold = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agent.onRun = async (context) => {
      agent.enqueuer?.(context.sessionId, {
        kind: "test",
        content: "<test>first</test>",
        originAgentRunId: context.metadata.agentRunId,
      });
      agent.enqueuer?.(context.sessionId, {
        kind: "test",
        content: "<test>second</test>",
        originAgentRunId: context.metadata.agentRunId,
      });
      agent.drainedDuringRun.push(
        agent.provider?.(context.sessionId, context.metadata.agentRunId) || [],
      );
      await runHold;
    };

    const dispatchPromise = gateway.dispatchTask("session-batch", "user task");
    await waitUntil(
      () => agent.drainedDuringRun.length === 1,
      "batched queued insertions should be drainable during the active run",
    );
    assertEqual(
      agent.drainedDuringRun[0].map((item) => item.content).join("\n\n"),
      "<test>first</test>\n\n<test>second</test>",
      "queued insertion batch should preserve FIFO order",
    );
    releaseRun();
    await dispatchPromise;
  });

  await runCase(
    "run-scoped queued insertion dedupeKey prevents duplicate pending items",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer) {
        throw new Error("Gateway should register a queued insertion enqueuer");
      }

      let releaseRun!: () => void;
      const runHold = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      agent.onRun = async (context) => {
        agent.enqueuer?.(context.sessionId, {
          kind: "test",
          content: "<test>same</test>",
          dedupeKey: "same-key",
          originAgentRunId: context.metadata.agentRunId,
        });
        agent.enqueuer?.(context.sessionId, {
          kind: "test",
          content: "<test>duplicate</test>",
          dedupeKey: "same-key",
          originAgentRunId: context.metadata.agentRunId,
        });
        agent.drainedDuringRun.push(
          agent.provider?.(context.sessionId, context.metadata.agentRunId) ||
            [],
        );
        await runHold;
      };

      const dispatchPromise = gateway.dispatchTask(
        "session-dedupe",
        "user task",
      );
      await waitUntil(
        () => agent.drainedDuringRun.length === 1,
        "deduped queued insertion should be drainable during the active run",
      );
      assertEqual(
        agent.drainedDuringRun[0][0]?.content,
        "<test>same</test>",
        "duplicate queued insertion content should not be batched",
      );
      assertEqual(
        agent.drainedDuringRun[0].length,
        1,
        "deduped queued insertion should only retain one item",
      );
      releaseRun();
      await dispatchPromise;
    },
  );

  await runCase(
    "manual stop drops queued insertions already pending for the stopped run",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer) {
        throw new Error("Gateway should register a queued insertion enqueuer");
      }

      let releaseRun!: () => void;
      const runHold = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      agent.onRun = async (context) => {
        agent.enqueuer?.(context.sessionId, {
          kind: "test",
          content: "<test>should-drop</test>",
          originAgentRunId: context.metadata.agentRunId,
        });
        await runHold;
      };

      const dispatchPromise = gateway.dispatchTask(
        "session-stop-pending",
        "user task",
      );
      await waitUntil(
        () => agent.runs.length === 1,
        "active run should have started before manual stop",
      );

      await gateway.stopTask("session-stop-pending");
      releaseRun();
      await dispatchPromise;
      await sleep(25);

      assertEqual(
        agent.runs.length,
        1,
        "pending queued insertion from a manually stopped run should not dispatch",
      );
    },
  );

  await runCase(
    "manual stop ignores late completion insertions from the stopped run",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer) {
        throw new Error("Gateway should register a queued insertion enqueuer");
      }

      let releaseRun!: () => void;
      let stoppedAgentRunId = "";
      const runHold = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      agent.onRun = async (context) => {
        stoppedAgentRunId = context.metadata.agentRunId;
        await runHold;
      };

      const dispatchPromise = gateway.dispatchTask(
        "session-stop-late",
        "user task",
      );
      await waitUntil(
        () => Boolean(stoppedAgentRunId),
        "active run should expose an agent run id before manual stop",
      );

      await gateway.stopTask("session-stop-late");
      releaseRun();
      await dispatchPromise;

      agent.enqueuer("session-stop-late", {
        kind: "test",
        content: "<test>late-after-stop</test>",
        originAgentRunId: stoppedAgentRunId,
      });
      await sleep(25);

      assertEqual(
        agent.runs.length,
        1,
        "late queued insertion from a manually stopped run should be ignored",
      );
    },
  );

  await runCase(
    "inserted restart preserves the logical agent run queue",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer || !agent.provider) {
        throw new Error("Gateway should register queued insertion hooks");
      }

      let firstAgentRunId = "";
      let secondAgentRunId = "";
      let firstSignal: AbortSignal | null = null;
      let releaseSecond!: () => void;
      const secondHold = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });

      agent.onRun = async (context, _input, signal, startMode) => {
        if (startMode === "normal") {
          firstAgentRunId = context.metadata.agentRunId;
          firstSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        secondAgentRunId = context.metadata.agentRunId;
        agent.enqueuer?.(context.sessionId, {
          kind: "test",
          content: "<test>same-logical-run</test>",
          originAgentRunId: firstAgentRunId,
        });
        agent.drainedDuringRun.push(
          agent.provider?.(context.sessionId, context.metadata.agentRunId) ||
            [],
        );
        await secondHold;
      };

      const firstDispatch = gateway.dispatchTask("session-inserted", "first");
      await waitUntil(
        () => Boolean(firstAgentRunId && firstSignal),
        "first run should expose an agent run id",
      );
      const secondDispatch = gateway.dispatchTask(
        "session-inserted",
        "second",
        {
          startMode: "inserted",
        },
      );
      await waitUntil(
        () => agent.drainedDuringRun.length === 1,
        "inserted run should drain queued insertion from the preserved agent run",
      );
      assertEqual(
        secondAgentRunId,
        firstAgentRunId,
        "inserted restart should preserve the logical agent run id",
      );
      assertEqual(
        agent.drainedDuringRun[0][0]?.content,
        "<test>same-logical-run</test>",
        "queued insertion from the previous physical run should survive inserted restart",
      );
      releaseSecond();
      await Promise.all([firstDispatch, secondDispatch]);
    },
  );

  await runCase(
    "peeked queued insertion survives inserted abort until acknowledged",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer || !agent.provider || !agent.acknowledger) {
        throw new Error("Gateway should register queued insertion hooks");
      }

      let firstAgentRunId = "";
      let secondAgentRunId = "";
      let peekedBeforeAbort: QueuedAgentInsertion[] = [];
      let peekedAfterInsertedRestart: QueuedAgentInsertion[] = [];
      let peekedAfterAck: QueuedAgentInsertion[] = [];
      let releaseSecond!: () => void;
      const secondHold = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });

      agent.onRun = async (context, _input, signal, startMode) => {
        if (startMode === "normal") {
          firstAgentRunId = context.metadata.agentRunId;
          agent.enqueuer?.(context.sessionId, {
            kind: "test",
            content: "<test>survives-unacked-peek</test>",
            originAgentRunId: firstAgentRunId,
          });
          peekedBeforeAbort =
            agent.provider?.(context.sessionId, firstAgentRunId) || [];
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

        secondAgentRunId = context.metadata.agentRunId;
        peekedAfterInsertedRestart =
          agent.provider?.(context.sessionId, context.metadata.agentRunId) ||
          [];
        agent.acknowledger?.(
          context.sessionId,
          context.metadata.agentRunId,
          peekedAfterInsertedRestart.map((item) => item.id),
        );
        peekedAfterAck =
          agent.provider?.(context.sessionId, context.metadata.agentRunId) ||
          [];
        await secondHold;
      };

      const firstDispatch = gateway.dispatchTask("session-peek-ack", "first");
      await waitUntil(
        () => peekedBeforeAbort.length === 1,
        "first physical run should peek the queued insertion",
      );
      const secondDispatch = gateway.dispatchTask(
        "session-peek-ack",
        "second",
        {
          startMode: "inserted",
        },
      );
      await waitUntil(
        () => peekedAfterInsertedRestart.length === 1,
        "inserted restart should still see the unacknowledged queued insertion",
      );

      assertEqual(
        secondAgentRunId,
        firstAgentRunId,
        "inserted restart should preserve the logical agent run id",
      );
      assertEqual(
        peekedAfterInsertedRestart[0]?.id,
        peekedBeforeAbort[0]?.id,
        "unacknowledged queued insertion should survive the physical-run abort",
      );
      assertEqual(
        peekedAfterAck.length,
        0,
        "acknowledged queued insertion should be removed from the pending queue",
      );
      releaseSecond();
      await Promise.all([firstDispatch, secondDispatch]);
    },
  );

  await runCase(
    "final output drains queued insertions when task finish guard is disabled",
    async () => {
      const agent = createAgentService();
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => events.push(event));
      (agent as any).activeAgentRunIdsBySession.set(
        "session-final-drain",
        "agent-run-final-drain",
      );
      agent.setQueuedInsertionProvider((_sessionId, agentRunId) =>
        agentRunId === "agent-run-final-drain"
          ? [
              {
                id: "queued-final-1",
                sessionId: "session-final-drain",
                agentRunId: "agent-run-final-drain",
                kind: "test",
                content: "<test>late-final-queue</test>",
                createdAt: Date.now(),
              },
            ]
          : [],
      );

      const node = (agent as any).createFinalOutputNode();
      const result = await node.invoke({
        sessionId: "session-final-drain",
        taskFinishGuardEnabled: false,
        completionGuardDecision: "end",
        pendingToolCalls: [],
        messages: [
          new AIMessage({
            content: "final answer before late queue",
            additional_kwargs: { _gyshellMessageId: "ai-final-drain" },
          }),
        ],
      });

      const inserted = result.messages[
        result.messages.length - 1
      ] as HumanMessage;
      assertEqual(
        result.completionGuardDecision,
        "continue",
        "final output should continue the graph when queued insertions arrive late",
      );
      assertEqual(
        String(inserted.content),
        "<test>late-final-queue</test>",
        "final output should append the queued insertion before ending",
      );
      assertEqual(
        (inserted as any).additional_kwargs?._gyshellQueuedInsertion,
        true,
        "final-output queued insertion should retain its ack marker",
      );
      assertEqual(
        (agent as any).routeFinalOutput(result),
        "token_pruner_runtime",
        "final output should route back to the model request pipeline after draining",
      );
      assertEqual(
        events.some((event) => event.type === "done"),
        false,
        "final output should not emit done while a queued insertion needs another model pass",
      );
      assertEqual(
        events.some(
          (event) =>
            event.type === "remove_message" &&
            event.messageId === "ai-final-drain",
        ),
        true,
        "final output should remove the previous visible final answer when forcing another pass",
      );
    },
  );

  await runCase(
    "active-run queued insertion waiter resolves on new queued content",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer || !agent.availabilityWaiter) {
        throw new Error("Gateway should register queued insertion hooks");
      }

      let waiterResolved: boolean | null = null;
      let releaseRun!: () => void;
      const runHold = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      agent.onRun = async (context) => {
        const waitPromise = agent.availabilityWaiter?.(
          context.sessionId,
          context.metadata.agentRunId,
        );
        agent.enqueuer?.(context.sessionId, {
          kind: "test",
          content: "<test>wake-wait-tool</test>",
          originAgentRunId: context.metadata.agentRunId,
        });
        waiterResolved = (await waitPromise) ?? null;
        await runHold;
      };

      const dispatchPromise = gateway.dispatchTask(
        "session-queue-waiter",
        "user task",
      );
      await waitUntil(
        () => waiterResolved === true,
        "queued insertion waiter should resolve when a queue item is added",
      );
      releaseRun();
      await dispatchPromise;
    },
  );

  await runCase(
    "time wait tool ends early and interrupts pending tools when queue is available",
    async () => {
      const agent = createAgentService();
      const events: any[] = [];
      agent.setEventPublisher((_sessionId, event) => events.push(event));
      (agent as any).sessionModelBindings.set("session-wait-interrupt", {
        actionModel: null,
      });
      (agent as any).activeAgentRunIdsBySession.set(
        "session-wait-interrupt",
        "agent-run-wait-interrupt",
      );
      agent.setQueuedInsertionAvailabilityWaiter(async () => true);

      const waitCall = {
        id: "call-wait",
        name: "wait",
        args: { seconds: 5 },
      };
      const trailingCall = {
        id: "call-read-terminal-tab",
        name: "read_terminal_tab",
        args: { tabIdOrName: "Local" },
      };
      const node = (agent as any).createToolsNode();
      const result = await node.invoke({
        sessionId: "session-wait-interrupt",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [waitCall, trailingCall],
          }),
        ],
        pendingToolCalls: [waitCall, trailingCall],
      });

      const waitToolMessage = result.messages[1] as any;
      assertEqual(
        String(waitToolMessage.content).includes("Wait ended early"),
        true,
        "time wait should return an early-ended result when queued content is available",
      );
      assertEqual(
        result.pendingToolCalls.length,
        0,
        "time wait should clear pending tool calls so queued insertions are inserted next",
      );
      const assistantMessage = result.messages[0] as any;
      assertEqual(
        Array.isArray(assistantMessage.tool_calls),
        true,
        "assistant tool calls should remain an array after interruption",
      );
      assertEqual(
        assistantMessage.tool_calls.length,
        2,
        "interrupted wait should preserve skipped tool calls in assistant history",
      );
      assertEqual(
        assistantMessage.tool_calls[0]?.id,
        "call-wait",
        "interrupted wait should keep only the executed wait tool call",
      );
      assertEqual(
        assistantMessage.tool_calls.some(
          (call: any) => call?.id === "call-read-terminal-tab",
        ),
        true,
        "interrupted wait should retain the trailing tool call id",
      );
      const deferredToolMessage = result.messages[2] as any;
      assertEqual(
        deferredToolMessage.tool_call_id,
        "call-read-terminal-tab",
        "interrupted wait should append a result for the trailing call",
      );
      assertEqual(
        JSON.parse(String(deferredToolMessage.content)).status,
        "not_executed",
        "interrupted wait should explicitly mark the trailing call as not executed",
      );
      assertEqual(
        (agent as any).routeAfterToolCall(result),
        "token_pruner_runtime",
        "interrupted wait should route directly back to the model request pipeline",
      );
      assertEqual(
        events.some(
          (event) =>
            event.type === "sub_tool_delta" &&
            String(event.outputDelta || "").includes(
              "queued agent notification",
            ),
        ),
        true,
        "time wait should emit the early-ended result to the tool UI",
      );
    },
  );

  await runCase(
    "new run after idle does not accept old agent run queue events",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.enqueuer || !agent.provider) {
        throw new Error("Gateway should register queued insertion hooks");
      }

      let firstAgentRunId = "";
      agent.onRun = async (context) => {
        firstAgentRunId = context.metadata.agentRunId;
      };
      await gateway.dispatchTask("session-new-run", "first");

      agent.onRun = async (context) => {
        agent.enqueuer?.(context.sessionId, {
          kind: "test",
          content: "<test>old-run-should-drop</test>",
          originAgentRunId: firstAgentRunId,
        });
        agent.drainedDuringRun.push(
          agent.provider?.(context.sessionId, context.metadata.agentRunId) ||
            [],
        );
      };
      await gateway.dispatchTask("session-new-run", "second");

      assertEqual(
        agent.drainedDuringRun[0]?.length || 0,
        0,
        "new user run after idle should not accept queued events from the previous agent run",
      );
    },
  );

  await runCase(
    "unfinished background exec commands are run-scoped and one-shot",
    async () => {
      const { gateway, agent } = createGateway();
      if (!agent.registrar || !agent.completer || !agent.unfinishedProvider) {
        throw new Error(
          "Gateway should register background exec command hooks",
        );
      }

      let releaseRun!: () => void;
      const runHold = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      agent.onRun = async (context) => {
        agent.registrar?.(context.sessionId, {
          terminalId: "terminal-1",
          terminalName: "Local",
          historyCommandMatchId: "task-1",
          command: "sleep 30",
          originAgentRunId: context.metadata.agentRunId,
        });
        agent.unfinishedDuringRun.push(
          agent.unfinishedProvider?.(
            context.sessionId,
            context.metadata.agentRunId,
          ) || [],
        );
        agent.unfinishedDuringRun.push(
          agent.unfinishedProvider?.(
            context.sessionId,
            context.metadata.agentRunId,
          ) || [],
        );
        agent.completer?.(context.sessionId, {
          terminalId: "terminal-1",
          terminalName: "Local",
          historyCommandMatchId: "task-1",
          command: "sleep 30",
          originAgentRunId: context.metadata.agentRunId,
          exitCode: 0,
        });
        agent.unfinishedDuringRun.push(
          agent.unfinishedProvider?.(
            context.sessionId,
            context.metadata.agentRunId,
          ) || [],
        );
        await runHold;
      };

      const dispatchPromise = gateway.dispatchTask(
        "session-unfinished",
        "user task",
      );
      await waitUntil(
        () => agent.unfinishedDuringRun.length === 3,
        "unfinished background command provider should be called three times",
      );
      assertEqual(
        agent.unfinishedDuringRun[0][0]?.historyCommandMatchId,
        "task-1",
        "first unfinished provider call should return the running task",
      );
      assertEqual(
        agent.unfinishedDuringRun[1].length,
        0,
        "unfinished guard should be one-shot for the same running task",
      );
      assertEqual(
        agent.unfinishedDuringRun[2].length,
        0,
        "completed background task should not be reported unfinished",
      );
      releaseRun();
      await dispatchPromise;
    },
  );
};

void run()
  .then(() => {
    console.log("All Gateway queued insertion extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
