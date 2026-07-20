import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
} from "@langchain/core/messages";
import { AgentService_v2 } from "./AgentService_v2";
import { ChatHistoryService } from "./ChatHistoryService";
import { UIHistoryService } from "./UIHistoryService";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import { PassChatTempExportService } from "./PassChatTempExportService";
import {
  PASS_CHAT_HISTORY_TAG,
  USER_INPUT_TAG,
  WHAT_HAVE_DONE_IN_THE_PAST_TAG,
} from "./AgentHelper/prompts";
import { TokenManager } from "./AgentHelper/TokenManager";
import type { ChatSession } from "../types";
import {
  formatInitialCommandOutput,
  parseCommandOutputEnvelopeContract,
} from "./AgentHelper/tools/command_output_contract";

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

const createMessageId = (id: string): Record<string, unknown> => ({
  _gyshellMessageId: id,
});

const createRunningCommandOutput = () =>
  formatInitialCommandOutput({
    terminalId: "terminal-running",
    historyCommandMatchId: "history-running",
    executionState: "running",
    output: "started\n",
    capture: {
      state: "in_progress",
      observedUtf8Bytes: 8,
      retainedUtf8Bytes: 8,
      availableLineCount: 1,
      revision: 1,
      terminalControlsObserved: false,
    },
  });

const createAgent = (
  uiHistory: UIHistoryService,
  chatHistory: ChatHistoryService,
  getCommandOutputSnapshot: (
    terminalId: string,
    historyCommandMatchId: string,
  ) => any = () => undefined,
): AgentService_v2 =>
  new AgentService_v2(
    { getCommandOutputSnapshot } as any,
    {} as any,
    { getActiveTools: () => [] } as any,
    { getEnabledSkills: async () => [] } as any,
    { getMemorySnapshot: async () => ({ enabled: false, content: "" }) } as any,
    uiHistory,
    chatHistory,
  );

const saveSourceSession = (
  chatHistory: ChatHistoryService,
  uiHistory: UIHistoryService,
): void => {
  const source: ChatSession = {
    id: "source-session",
    title: "New Session",
    lastCheckpointOffset: 0,
    lastProfileMaxTokens: 64000,
    messages: new Map(),
  };
  const messages = mapChatMessagesToStoredMessages([
    new HumanMessage({
      content: "first user",
      additional_kwargs: createMessageId("backend-user-1"),
    }),
    new AIMessage({
      content: "first assistant",
      additional_kwargs: createMessageId("backend-assistant-1"),
    }),
    new HumanMessage({
      content: "second user",
      additional_kwargs: createMessageId("backend-user-2"),
    }),
    new AIMessage({
      content: "second assistant",
      additional_kwargs: createMessageId("backend-assistant-2"),
    }),
  ]) as any[];
  [
    "backend-user-1",
    "backend-assistant-1",
    "backend-user-2",
    "backend-assistant-2",
  ].forEach((id, index) => {
    source.messages.set(id, messages[index] as any);
  });
  chatHistory.saveSession(source);

  uiHistory.recordEvent("source-session", {
    type: "user_input",
    content: "first user",
    messageId: "backend-user-1",
  } as any);
  uiHistory.recordEvent("source-session", {
    type: "say",
    content: "first assistant",
    messageId: "backend-assistant-1",
  } as any);
  uiHistory.recordEvent("source-session", { type: "done" } as any);
  uiHistory.recordEvent("source-session", {
    type: "user_input",
    content: "second user",
    messageId: "backend-user-2",
  } as any);
  uiHistory.recordEvent("source-session", {
    type: "say",
    content: "second assistant",
    messageId: "backend-assistant-2",
  } as any);
  uiHistory.recordEvent("source-session", { type: "done" } as any);
  uiHistory.flush("source-session");
  uiHistory.renameSession("source-session", "Investigate outage");
};

const run = async (): Promise<void> => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gyshell-branch-extreme-"),
  );
  const sqlitePath = path.join(tempDir, "history.sqlite3");
  const store = new HistorySqliteStore({ filePath: sqlitePath });
  const chatHistory = new ChatHistoryService({ store });
  const uiHistory = new UIHistoryService({ store });
  const terminalSnapshots = new Map<string, any>();
  const agent = createAgent(
    uiHistory,
    chatHistory,
    (terminalId, historyCommandMatchId) =>
      terminalSnapshots.get(`${terminalId}\u0000${historyCommandMatchId}`),
  );
  const fallbackExportDir = path.join(tempDir, "fallback-compaction-history");
  (agent as any).fallbackCompactionHistoryExportService =
    new PassChatTempExportService({
      baseDir: fallbackExportDir,
      maxFiles: null,
      groupBySession: true,
    });

  try {
    await runCase(
      "branch copies history through the selected assistant message",
      () => {
        saveSourceSession(chatHistory, uiHistory);
        const sourceUiBefore = uiHistory.getMessages("source-session");
        const result = agent.branchFromMessage(
          "source-session",
          "backend-assistant-2",
          "branch-session",
        );

        assertEqual(result.ok, true, "branch should succeed");
        assertEqual(
          result.sessionId,
          "branch-session",
          "branch should use the requested session id",
        );
        assertEqual(
          result.title,
          "Investigate outage_branch",
          "branch title should append _branch to the source session title",
        );

        const sourceStored = chatHistory.loadSession("source-session");
        const branchStored = chatHistory.loadSession("branch-session");
        assertEqual(
          sourceStored?.title,
          "New Session",
          "source agent history title intentionally stays stale in this regression case",
        );
        assertEqual(
          uiHistory.getSession("source-session")?.title,
          "Investigate outage",
          "source UI title should be the user-visible branch title source",
        );
        assertEqual(
          sourceStored?.messages.size,
          4,
          "source agent history must stay unchanged",
        );
        assertEqual(
          branchStored?.messages.size,
          4,
          "branch agent history should include the selected assistant",
        );
        assertCondition(
          branchStored?.messages.has("backend-assistant-2"),
          "selected assistant message must be included in branch agent history",
        );
        assertEqual(
          branchStored?.title,
          "Investigate outage_branch",
          "stored branch title should append _branch",
        );

        const sourceUiAfter = uiHistory.getMessages("source-session");
        const branchUi = uiHistory.getMessages("branch-session");
        assertEqual(
          sourceUiAfter.length,
          sourceUiBefore.length,
          "source UI history must stay unchanged",
        );
        assertEqual(
          branchUi.length,
          4,
          "branch UI history should include the selected assistant",
        );
        assertEqual(
          branchUi.some(
            (message) => message.backendMessageId === "backend-assistant-2",
          ),
          true,
          "selected assistant message must be included in branch UI history",
        );
        assertCondition(
          branchUi[0]?.id !== sourceUiBefore[0]?.id,
          "branch UI messages need fresh UI ids because ui_message_id is globally unique",
        );
        assertEqual(
          branchUi[0]?.backendMessageId,
          sourceUiBefore[0]?.backendMessageId,
          "branch UI messages should preserve backend message ids",
        );
      },
    );

    await runCase(
      "branch rejects a UI cut that would clone a running command",
      () => {
        const sourceSessionId = "source-running-ui-command";
        const source: ChatSession = {
          id: sourceSessionId,
          title: "Running UI command",
          lastCheckpointOffset: 0,
          messages: new Map(),
        };
        const stored = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: "start work",
            additional_kwargs: createMessageId("running-ui-user"),
          }),
          new AIMessage({
            content: "background work started",
            additional_kwargs: createMessageId("running-ui-target"),
          }),
        ]) as any[];
        source.messages.set("running-ui-user", stored[0] as any);
        source.messages.set("running-ui-target", stored[1] as any);
        chatHistory.saveSession(source);

        const running = createRunningCommandOutput();
        uiHistory.recordEvent(sourceSessionId, {
          type: "user_input",
          content: "start work",
          messageId: "running-ui-user",
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "command_started",
          command: "long-running",
          commandId: "running-ui-command",
          messageId: "running-ui-command",
          tabName: "Terminal",
          isNowait: true,
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "command_finished",
          command: "long-running",
          commandId: "running-ui-command",
          messageId: "running-ui-command",
          outputDelta: running.text,
          outputMode: "replace",
          commandOutput: running.contract,
          isNowait: true,
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "say",
          content: "background work started",
          messageId: "running-ui-target",
        } as any);
        uiHistory.recordEvent(sourceSessionId, { type: "done" } as any);

        const result = agent.branchFromMessage(
          sourceSessionId,
          "running-ui-target",
          "branch-running-ui-command",
        );
        assertEqual(result.ok, false, "a live UI contract must block branching");
        assertCondition(
          result.reason?.includes("running command"),
          "the rejection should explain which lifecycle must settle",
        );
        assertEqual(
          chatHistory.loadSession("branch-running-ui-command"),
          null,
          "a rejected live branch must not create agent history",
        );
        assertEqual(
          uiHistory.getSession("branch-running-ui-command"),
          null,
          "a rejected live branch must not create UI history",
        );
      },
    );

    await runCase(
      "branch rejects a model-history running contract missing from UI metadata",
      () => {
        const sourceSessionId = "source-running-model-command";
        const running = createRunningCommandOutput();
        terminalSnapshots.set("terminal-running\u0000history-running", {
          executionState: "running",
          output: "started\n",
          capture: running.contract.capture,
        });
        const source: ChatSession = {
          id: sourceSessionId,
          title: "Running model command",
          lastCheckpointOffset: 0,
          messages: new Map(),
        };
        const messages = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: "start work",
            additional_kwargs: createMessageId("running-model-user"),
          }),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "running-model-call",
                name: "exec_command",
                args: { command: "long-running" },
                type: "tool_call",
              },
            ] as any,
            additional_kwargs: createMessageId("running-model-assistant-call"),
          }),
          new ToolMessage({
            content: running.text,
            name: "exec_command",
            tool_call_id: "running-model-call",
            additional_kwargs: createMessageId("running-model-tool"),
          } as any),
          new AIMessage({
            content: "background work started",
            additional_kwargs: createMessageId("running-model-target"),
          }),
        ]) as any[];
        [
          "running-model-user",
          "running-model-assistant-call",
          "running-model-tool",
          "running-model-target",
        ].forEach((id, index) => source.messages.set(id, messages[index] as any));
        chatHistory.saveSession(source);

        uiHistory.recordEvent(sourceSessionId, {
          type: "user_input",
          content: "start work",
          messageId: "running-model-user",
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "say",
          content: "background work started",
          messageId: "running-model-target",
        } as any);
        uiHistory.recordEvent(sourceSessionId, { type: "done" } as any);

        const result = agent.branchFromMessage(
          sourceSessionId,
          "running-model-target",
          "branch-running-model-command",
        );
        assertEqual(
          result.ok,
          false,
          "model history must independently block cloning a live command",
        );
        assertCondition(
          result.reason?.includes("running command"),
          "model-history rejection should explain that the command must settle",
        );
        assertEqual(
          chatHistory.loadSession("branch-running-model-command"),
          null,
          "model-history rejection must happen before branch persistence",
        );
        terminalSnapshots.delete("terminal-running\u0000history-running");
      },
    );

    await runCase(
      "branch reconciles a stale running model contract that already finished",
      () => {
        const sourceSessionId = "source-settled-model-command";
        const staleRunning = createRunningCommandOutput();
        const source: ChatSession = {
          id: sourceSessionId,
          title: "Settled model command",
          lastCheckpointOffset: 0,
          messages: new Map(),
        };
        const messages = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: "start work",
            additional_kwargs: createMessageId("settled-model-user"),
          }),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "settled-model-call",
                name: "exec_command",
                args: { command: "long-running" },
                type: "tool_call",
              },
            ] as any,
            additional_kwargs: createMessageId("settled-model-assistant-call"),
          }),
          new ToolMessage({
            content: staleRunning.text,
            name: "exec_command",
            tool_call_id: "settled-model-call",
            additional_kwargs: createMessageId("settled-model-tool"),
          } as any),
          new AIMessage({
            content: "background work finished",
            additional_kwargs: createMessageId("settled-model-target"),
          }),
        ]) as any[];
        [
          "settled-model-user",
          "settled-model-assistant-call",
          "settled-model-tool",
          "settled-model-target",
        ].forEach((id, index) => source.messages.set(id, messages[index] as any));
        chatHistory.saveSession(source);

        uiHistory.recordEvent(sourceSessionId, {
          type: "user_input",
          content: "start work",
          messageId: "settled-model-user",
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "say",
          content: "background work finished",
          messageId: "settled-model-target",
        } as any);
        uiHistory.recordEvent(sourceSessionId, { type: "done" } as any);
        terminalSnapshots.set("terminal-running\u0000history-running", {
          executionState: "finished",
          exitCode: 0,
          output: "started\nfinished\n",
          capture: {
            state: "complete",
            observedUtf8Bytes: 17,
            retainedUtf8Bytes: 17,
            availableLineCount: 2,
            revision: 2,
            terminalControlsObserved: false,
          },
        });

        const result = agent.branchFromMessage(
          sourceSessionId,
          "settled-model-target",
          "branch-settled-model-command",
        );
        assertEqual(
          result.ok,
          true,
          "a physically settled command must not remain branch-blocking because model history is stale",
        );
        const branch = chatHistory.loadSession("branch-settled-model-command");
        const branchTool = [...(branch?.messages.values() || [])].find(
          (message: any) => message?.data?.name === "exec_command",
        ) as any;
        assertEqual(
          parseCommandOutputEnvelopeContract(branchTool?.data?.content || "")
            ?.executionState,
          "finished",
          "the branch must persist reconciled command truth instead of cloning stale running state",
        );
        terminalSnapshots.delete("terminal-running\u0000history-running");
      },
    );

    await runCase(
      "settled command can branch past an earlier running poll snapshot",
      () => {
        const sourceSessionId = "source-settled-command-with-running-poll";
        const source: ChatSession = {
          id: sourceSessionId,
          title: "Settled command with poll",
          lastCheckpointOffset: 0,
          messages: new Map(),
        };
        const messages = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: "start background work",
            additional_kwargs: createMessageId("poll-branch-user"),
          }),
          new AIMessage({
            content: "background work finished",
            additional_kwargs: createMessageId("poll-branch-target"),
          }),
        ]) as any[];
        source.messages.set("poll-branch-user", messages[0] as any);
        source.messages.set("poll-branch-target", messages[1] as any);
        chatHistory.saveSession(source);

        const running = createRunningCommandOutput();
        const finished = formatInitialCommandOutput({
          terminalId: running.contract.terminalId,
          historyCommandMatchId:
            running.contract.historyCommandMatchId,
          executionState: "finished",
          exitCode: 0,
          output: "started\nfinished\n",
          capture: {
            state: "complete",
            observedUtf8Bytes: 17,
            retainedUtf8Bytes: 17,
            availableLineCount: 2,
            revision: 2,
            terminalControlsObserved: false,
          },
        });
        uiHistory.recordEvent(sourceSessionId, {
          type: "user_input",
          content: "start background work",
          messageId: "poll-branch-user",
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "command_started",
          command: "long-running",
          commandId: "poll-branch-command-id",
          messageId: "poll-branch-command-message",
          commandOutput: running.contract,
          isNowait: true,
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "command_finished",
          commandId: "poll-branch-command-id",
          messageId: "poll-branch-command-message",
          outputDelta: running.text,
          outputMode: "replace",
          commandOutput: running.contract,
          isNowait: true,
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "tool_call",
          toolName: "read_command_output",
          input: JSON.stringify({
            tabIdOrName: running.contract.terminalId,
            history_command_match_id:
              running.contract.historyCommandMatchId,
          }),
          output: running.text,
          commandOutput: running.contract,
          messageId: "poll-branch-read-snapshot",
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "command_finished",
          commandId: "poll-branch-command-id",
          messageId: "poll-branch-command-message",
          outputDelta: finished.text,
          outputMode: "replace",
          commandOutput: finished.contract,
          isNowait: true,
        } as any);
        uiHistory.recordEvent(sourceSessionId, {
          type: "say",
          content: "background work finished",
          messageId: "poll-branch-target",
        } as any);
        uiHistory.recordEvent(sourceSessionId, { type: "done" } as any);

        const uiMessages = uiHistory.getMessages(sourceSessionId);
        const commandRow = uiMessages.find(
          (message) => message.type === "command",
        );
        const pollRow = uiMessages.find(
          (message) =>
            message.type === "tool_call" &&
            message.metadata?.toolName === "read_command_output",
        );
        assertEqual(
          commandRow?.metadata?.commandOutput?.executionState,
          "finished",
          "the live command row should receive its completion update",
        );
        assertEqual(
          pollRow?.metadata?.commandOutput?.executionState,
          "running",
          "a historical poll must remain an accurate point-in-time snapshot",
        );

        const result = agent.branchFromMessage(
          sourceSessionId,
          "poll-branch-target",
          "branch-after-running-poll-snapshot",
        );
        assertEqual(
          result.ok,
          true,
          "a settled command must not be blocked by an earlier poll snapshot",
        );
      },
    );

    await runCase(
      "branch through the first user message creates a one-message session",
      () => {
        const result = agent.branchFromMessage(
          "source-session",
          "backend-user-1",
          "empty-branch-session",
        );
        assertEqual(result.ok, true, "branch from first user should succeed");
        assertEqual(
          chatHistory.loadSession("empty-branch-session")?.messages.size,
          1,
          "agent history should include the first user message",
        );
        assertEqual(
          uiHistory.getMessages("empty-branch-session").length,
          1,
          "UI history should include the first user message",
        );
      },
    );

    await runCase(
      "branch through a UI-only user message keeps agent history through the previous anchor",
      () => {
        uiHistory.recordEvent("source-session", {
          type: "user_input",
          content: "third user only in UI",
          messageId: "backend-user-ui-only",
        } as any);
        uiHistory.flush("source-session");

        const result = agent.branchFromMessage(
          "source-session",
          "backend-user-ui-only",
          "ui-only-branch-session",
        );

        assertEqual(result.ok, true, "UI-only target branch should succeed");
        assertEqual(
          chatHistory.loadSession("ui-only-branch-session")?.messages.size,
          4,
          "agent history should include messages through the previous matching UI anchor",
        );
        assertEqual(
          uiHistory.getMessages("ui-only-branch-session").length,
          5,
          "UI branch should include the UI-only selected user message",
        );
        assertEqual(
          uiHistory
            .getMessages("ui-only-branch-session")
            .some(
              (message) => message.backendMessageId === "backend-user-ui-only",
            ),
          true,
          "UI-only selected user message must be included in branch UI history",
        );
      },
    );

    await runCase(
      "missing branch target does not create a partial session",
      () => {
        const result = agent.branchFromMessage(
          "source-session",
          "missing-message",
          "missing-target-branch",
        );
        assertEqual(result.ok, false, "missing target should fail");
        assertEqual(
          chatHistory.loadSession("missing-target-branch"),
          null,
          "failed branch must not create agent history",
        );
        assertEqual(
          uiHistory.getSession("missing-target-branch"),
          null,
          "failed branch must not create UI history",
        );
      },
    );

    await runCase(
      "branch rewrites fallback compaction history export ownership",
      async () => {
        const sourcePath = await (
          agent as any
        ).fallbackCompactionHistoryExportService.exportMarkdown({
          sessionId: "source-fallback-session",
          title: "Source fallback history",
          markdown: "# Source fallback history\nexact old detail",
        });
        const source: ChatSession = {
          id: "source-fallback-session",
          title: "Fallback Source",
          lastCheckpointOffset: 0,
          lastProfileMaxTokens: 64000,
          messages: new Map(),
        };
        const messages = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${sourcePath}\nInstruction: read if needed.\n`,
            additional_kwargs: {
              ...createMessageId("fallback-summary"),
              [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
              fallback_compaction: true,
            },
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user one`,
            additional_kwargs: createMessageId("fallback-user-1"),
          }),
          new AIMessage({
            content: "assistant one",
            additional_kwargs: createMessageId("fallback-assistant-1"),
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user two`,
            additional_kwargs: createMessageId("fallback-user-2"),
          }),
          new AIMessage({
            content: "assistant after fallback",
            additional_kwargs: createMessageId("fallback-assistant"),
          }),
        ]) as any[];
        source.messages.set("fallback-summary", messages[0] as any);
        source.messages.set("fallback-user-1", messages[1] as any);
        source.messages.set("fallback-assistant-1", messages[2] as any);
        source.messages.set("fallback-user-2", messages[3] as any);
        source.messages.set("fallback-assistant", messages[4] as any);
        chatHistory.saveSession(source);

        uiHistory.recordEvent("source-fallback-session", {
          type: "user_input",
          content: "protected user one",
          messageId: "fallback-user-1",
        } as any);
        uiHistory.recordEvent("source-fallback-session", {
          type: "say",
          content: "assistant one",
          messageId: "fallback-assistant-1",
        } as any);
        uiHistory.recordEvent("source-fallback-session", {
          type: "user_input",
          content: "protected user two",
          messageId: "fallback-user-2",
        } as any);
        uiHistory.recordEvent("source-fallback-session", {
          type: "say",
          content: "assistant after fallback",
          messageId: "fallback-assistant",
        } as any);
        uiHistory.flush("source-fallback-session");

        const result = agent.branchFromMessage(
          "source-fallback-session",
          "fallback-assistant",
          "branch-fallback-session",
        );

        assertEqual(
          result.ok,
          true,
          "branch from fallback session should work",
        );
        const branchStored = chatHistory.loadSession("branch-fallback-session");
        const branchSummary = Array.from(
          branchStored?.messages.values() || [],
        )[0] as any;
        const branchContent = String(
          branchSummary?.data?.content ?? branchSummary?.content ?? "",
        );
        const pathMatch = branchContent.match(/Markdown Export Path: (.+)/);
        assertCondition(
          pathMatch?.[1],
          "branch summary should keep an export path",
        );
        const branchPath = pathMatch![1].trim();
        assertCondition(
          branchPath !== sourcePath,
          "branch summary should point at a branch-owned export",
        );
        assertCondition(
          fs.existsSync(branchPath),
          "branch-owned export should exist after branching",
        );

        agent.deleteChatSession("source-fallback-session");

        assertEqual(
          fs.existsSync(sourcePath),
          false,
          "deleting source should remove source-owned export",
        );
        assertEqual(
          fs.existsSync(branchPath),
          true,
          "deleting source should not remove branch-owned export",
        );
      },
    );

    await runCase(
      "branch does not copy arbitrary markdown export paths",
      () => {
        const outsidePath = path.join(tempDir, "outside-secret.md");
        fs.writeFileSync(outsidePath, "outside secret", "utf8");
        const source: ChatSession = {
          id: "source-arbitrary-path-session",
          title: "Arbitrary Path Source",
          lastCheckpointOffset: 0,
          lastProfileMaxTokens: 64000,
          messages: new Map(),
        };
        const messages = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${outsidePath}\nInstruction: read if needed.\n`,
            additional_kwargs: {
              ...createMessageId("arbitrary-summary"),
              [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
              fallback_compaction: true,
            },
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user one`,
            additional_kwargs: createMessageId("arbitrary-user-1"),
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user two`,
            additional_kwargs: createMessageId("arbitrary-user-2"),
          }),
          new AIMessage({
            content: "assistant after arbitrary path",
            additional_kwargs: createMessageId("arbitrary-assistant"),
          }),
        ]) as any[];
        source.messages.set("arbitrary-summary", messages[0] as any);
        source.messages.set("arbitrary-user-1", messages[1] as any);
        source.messages.set("arbitrary-user-2", messages[2] as any);
        source.messages.set("arbitrary-assistant", messages[3] as any);
        chatHistory.saveSession(source);
        uiHistory.recordEvent("source-arbitrary-path-session", {
          type: "user_input",
          content: "protected user one",
          messageId: "arbitrary-user-1",
        } as any);
        uiHistory.recordEvent("source-arbitrary-path-session", {
          type: "user_input",
          content: "protected user two",
          messageId: "arbitrary-user-2",
        } as any);
        uiHistory.recordEvent("source-arbitrary-path-session", {
          type: "say",
          content: "assistant after arbitrary path",
          messageId: "arbitrary-assistant",
        } as any);
        uiHistory.flush("source-arbitrary-path-session");

        const result = agent.branchFromMessage(
          "source-arbitrary-path-session",
          "arbitrary-assistant",
          "branch-arbitrary-path-session",
        );

        assertEqual(result.ok, true, "branch with arbitrary path should work");
        const branchStored = chatHistory.loadSession(
          "branch-arbitrary-path-session",
        );
        const branchSummary = Array.from(
          branchStored?.messages.values() || [],
        )[0] as any;
        const branchContent = String(
          branchSummary?.data?.content ?? branchSummary?.content ?? "",
        );
        assertCondition(
          branchContent.includes(`Markdown Export Path: ${outsidePath}`),
          "unmanaged path should remain unchanged instead of being copied",
        );
      },
    );

    await runCase(
      "branch does not copy another session managed export path",
      async () => {
        const otherSessionPath = await (
          agent as any
        ).fallbackCompactionHistoryExportService.exportMarkdown({
          sessionId: "other-managed-session",
          title: "Other managed history",
          markdown: "# Other managed history\n",
        });
        const source: ChatSession = {
          id: "source-cross-managed-session",
          title: "Cross Managed Source",
          lastCheckpointOffset: 0,
          lastProfileMaxTokens: 64000,
          messages: new Map(),
        };
        const messages = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${otherSessionPath}\nInstruction: read if needed.\n`,
            additional_kwargs: {
              ...createMessageId("cross-managed-summary"),
              [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
              fallback_compaction: true,
            },
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user one`,
            additional_kwargs: createMessageId("cross-managed-user-1"),
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user two`,
            additional_kwargs: createMessageId("cross-managed-user-2"),
          }),
          new AIMessage({
            content: "assistant after cross managed path",
            additional_kwargs: createMessageId("cross-managed-assistant"),
          }),
        ]) as any[];
        source.messages.set("cross-managed-summary", messages[0] as any);
        source.messages.set("cross-managed-user-1", messages[1] as any);
        source.messages.set("cross-managed-user-2", messages[2] as any);
        source.messages.set("cross-managed-assistant", messages[3] as any);
        chatHistory.saveSession(source);
        uiHistory.recordEvent("source-cross-managed-session", {
          type: "user_input",
          content: "protected user one",
          messageId: "cross-managed-user-1",
        } as any);
        uiHistory.recordEvent("source-cross-managed-session", {
          type: "user_input",
          content: "protected user two",
          messageId: "cross-managed-user-2",
        } as any);
        uiHistory.recordEvent("source-cross-managed-session", {
          type: "say",
          content: "assistant after cross managed path",
          messageId: "cross-managed-assistant",
        } as any);
        uiHistory.flush("source-cross-managed-session");

        const result = agent.branchFromMessage(
          "source-cross-managed-session",
          "cross-managed-assistant",
          "branch-cross-managed-session",
        );

        assertEqual(
          result.ok,
          true,
          "branch with cross-session path should work",
        );
        const branchStored = chatHistory.loadSession(
          "branch-cross-managed-session",
        );
        const branchSummary = Array.from(
          branchStored?.messages.values() || [],
        )[0] as any;
        const branchContent = String(
          branchSummary?.data?.content ?? branchSummary?.content ?? "",
        );
        assertCondition(
          branchContent.includes(`Markdown Export Path: ${otherSessionPath}`),
          "another session's managed path should remain unchanged instead of being copied",
        );
      },
    );

    await runCase(
      "failed UI branch removes branch-owned fallback export",
      async () => {
        const sourcePath = await (
          agent as any
        ).fallbackCompactionHistoryExportService.exportMarkdown({
          sessionId: "source-failed-ui-branch",
          title: "Source failed UI branch",
          markdown: "# Failed UI branch source\n",
        });
        const filesBeforeBranch = fs
          .readdirSync(fallbackExportDir)
          .filter((name) => name.endsWith(".md"))
          .sort();
        const source: ChatSession = {
          id: "source-failed-ui-branch",
          title: "Failed UI Branch Source",
          lastCheckpointOffset: 0,
          lastProfileMaxTokens: 64000,
          messages: new Map(),
        };
        const messages = mapChatMessagesToStoredMessages([
          new HumanMessage({
            content: `${WHAT_HAVE_DONE_IN_THE_PAST_TAG}summary\n\n${PASS_CHAT_HISTORY_TAG}Markdown Export Path: ${sourcePath}\nInstruction: read if needed.\n`,
            additional_kwargs: {
              ...createMessageId("failed-ui-summary"),
              [TokenManager.LAST_COMPACTION_FLAG_KEY]: true,
              fallback_compaction: true,
            },
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user one`,
            additional_kwargs: createMessageId("failed-ui-user-1"),
          }),
          new HumanMessage({
            content: `${USER_INPUT_TAG}protected user two`,
            additional_kwargs: createMessageId("failed-ui-user-2"),
          }),
          new AIMessage({
            content: "assistant missing in UI",
            additional_kwargs: createMessageId("failed-ui-assistant"),
          }),
        ]) as any[];
        source.messages.set("failed-ui-summary", messages[0] as any);
        source.messages.set("failed-ui-user-1", messages[1] as any);
        source.messages.set("failed-ui-user-2", messages[2] as any);
        source.messages.set("failed-ui-assistant", messages[3] as any);
        chatHistory.saveSession(source);

        const result = agent.branchFromMessage(
          "source-failed-ui-branch",
          "failed-ui-assistant",
          "branch-failed-ui",
        );

        assertEqual(result.ok, false, "missing UI target should fail");
        const filesAfterBranch = fs
          .readdirSync(fallbackExportDir)
          .filter((name) => name.endsWith(".md"))
          .sort();
        assertEqual(
          JSON.stringify(filesAfterBranch),
          JSON.stringify(filesBeforeBranch),
          "failed branch should not leave a branch-owned fallback export",
        );
        assertEqual(
          fs.existsSync(sourcePath),
          true,
          "failed branch should keep the source-owned fallback export",
        );
      },
    );
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
