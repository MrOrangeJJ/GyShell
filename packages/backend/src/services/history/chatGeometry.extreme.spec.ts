import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HistorySqliteStore,
  projectUiMessageForList,
} from "./HistorySqliteStore";
import { buildUiSessionSummary } from "./uiHistoryHelpers";
import { UIHistoryService } from "../UIHistoryService";
import type { ChatMessage, UIChatSession } from "../../types/ui-chat";
import {
  CHAT_TEXT_GEOMETRY_MAX_BUCKET_PAIRS,
  createChatTextGeometryShape,
  type CommandOutputContractV1,
} from "@gyshell/shared";

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

const withStore = (fn: (store: HistorySqliteStore) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-chat-geometry-"));
  const store = new HistorySqliteStore({
    filePath: path.join(dir, "history.sqlite"),
  });
  try {
    fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const createMessage = (index: number): ChatMessage => ({
  id: `geometry-${index}`,
  backendMessageId: `backend-${index}`,
  role: index % 5 === 0 ? "user" : "assistant",
  type: index % 7 === 0 ? "command" : "text",
  content:
    index % 11 === 0
      ? `long-${index}\n${"x".repeat(20_000)}`
      : `message-${index}`,
  metadata:
    index % 7 === 0
      ? {
          tabName: "LOCAL",
          output: `${"output-line\n".repeat(2_000)}`,
          exitCode: 0,
        }
      : undefined,
  timestamp: index + 1,
});

runCase("geometry histograms stay bounded for adversarial line widths", () => {
  const distinctWidthText = Array.from(
    { length: 1_000 },
    (_, index) => "x".repeat(index + 1),
  ).join("\n");
  const shape = createChatTextGeometryShape(distinctWidthText);
  assert.ok(
    shape.lineBuckets.length <= CHAT_TEXT_GEOMETRY_MAX_BUCKET_PAIRS * 2,
  );
  const retainedLineCount = shape.lineBuckets.reduce(
    (total, value, index) => (index % 2 === 1 ? total + value : total),
    0,
  );
  assert.equal(retainedLineCount, 1_000);
});

runCase("re-projecting a preview preserves its deferred fields", () => {
  const projected = projectUiMessageForList({
    id: "already-projected",
    role: "assistant",
    type: "text",
    content: "bounded preview",
    timestamp: 1,
    deferredPayload: { fields: ["content"] },
  });
  assert.ok(projected.deferredPayload?.fields.includes("content"));
});

runCase(
  "geometry index preserves all positions while bounding previews",
  () => {
    withStore((store) => {
      const messages = Array.from({ length: 14_603 }, (_, index) =>
        createMessage(index),
      );
      const session: UIChatSession = {
        id: "geometry-session",
        title: "Geometry session",
        updatedAt: Date.now(),
        messages,
      };
      store.saveUiSessions([
        { session, summary: buildUiSessionSummary(session) },
      ]);

      const index = store.loadUiMessageGeometryIndex("geometry-session");
      assert.ok(index);
      assert.equal(index?.entries.length, 14_603);
      assert.equal(index?.entries[0]?.position, 0);
      assert.equal(index?.entries.at(-1)?.position, 14_602);
      const long = index?.entries.find((entry) => entry.position === 11);
      assert.ok(long);
      assert.ok((long?.projection.content?.length || 0) <= 512);
      assert.ok(long?.projection.deferredFields?.includes("content"));
      assert.ok((long?.geometry.contentShape.lineBuckets.length || 0) <= 4);
      const command = index?.entries.find((entry) => entry.type === "command");
      assert.ok(command?.geometry.outputShape);
      assert.ok(command?.projection.deferredFields?.includes("output"));
    });
  },
);

runCase(
  "geometry and page projections bound metadata without losing lazy recovery",
  () => {
    withStore((store) => {
      const longTitle = `Read File: ${"nested/".repeat(10_000)}target.ts`;
      const privateBlob = "private-command-output-data".repeat(20_000);
      const commandOutput = {
        contractVersion: 1,
        terminalId: "terminal-1",
        historyCommandMatchId: "history-1",
        executionState: "finished",
        exitCode: 0,
        capture: {
          state: "complete",
          observedUtf8Bytes: 0,
          retainedUtf8Bytes: 0,
          availableLineCount: 0,
          revision: 1,
          terminalControlsObserved: false,
        },
        presentation: {
          state: "none",
          returnedUtf8Bytes: 0,
          hasMoreCapturedOutput: false,
        },
        privateBlob,
      } as CommandOutputContractV1 & { privateBlob: string };
      const message: ChatMessage = {
        id: "bounded-metadata",
        backendMessageId: "backend-bounded-metadata",
        role: "assistant",
        type: "sub_tool",
        content: "Read a deeply nested file",
        metadata: {
          subToolTitle: longTitle,
          subToolLevel: "info",
          commandOutput,
          ...({ unknownPrivateBlob: privateBlob } as Record<string, unknown>),
        },
        timestamp: 1,
      };
      const session: UIChatSession = {
        id: "bounded-metadata-session",
        title: "Bounded metadata",
        updatedAt: 1,
        messages: [message],
      };
      store.saveUiSessions([
        { session, summary: buildUiSessionSummary(session) },
      ]);

      const geometry = store.loadUiMessageGeometryIndex(session.id);
      const entry = geometry?.entries[0];
      assert.ok(entry);
      assert.ok((entry?.metadata?.subToolTitle?.length || 0) <= 512);
      assert.ok(entry?.projection.deferredFields?.includes("metadata"));
      assert.equal(
        entry?.metadata?.commandOutput?.executionState,
        "finished",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          entry?.metadata?.commandOutput || {},
          "privateBlob",
        ),
        false,
      );
      assert.equal(JSON.stringify(geometry).includes(privateBlob), false);

      const page = store.loadUiMessagePage(session.id, {
        aroundPosition: 0,
        limit: 1,
      });
      const projected = page?.entries[0]?.message;
      assert.ok(projected?.deferredPayload?.fields.includes("metadata"));
      assert.ok((projected?.metadata?.subToolTitle?.length || 0) <= 12_000);
      assert.equal(
        projected?.metadata?.commandOutput?.executionState,
        "finished",
      );
      assert.equal(JSON.stringify(page).includes(privateBlob), false);

      const full = store.loadUiMessagesByIds(session.id, [message.id])[0];
      assert.equal(full?.metadata?.subToolTitle, longTitle);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          full?.metadata?.commandOutput || {},
          "privateBlob",
        ),
        false,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          full?.metadata || {},
          "unknownPrivateBlob",
        ),
        false,
      );
    });
  },
);

runCase(
  "geometry and full payloads recover persisted running contracts",
  () => {
    withStore((store) => {
      const runningContract: CommandOutputContractV1 = {
        contractVersion: 1,
        terminalId: "expired-terminal",
        historyCommandMatchId: "expired-command",
        executionState: "running",
        exitCode: null,
        capture: {
          state: "in_progress",
          observedUtf8Bytes: 0,
          retainedUtf8Bytes: 0,
          availableLineCount: 0,
          revision: 1,
          terminalControlsObserved: false,
        },
        presentation: {
          state: "none",
          returnedUtf8Bytes: 0,
          hasMoreCapturedOutput: false,
        },
      };
      const message: ChatMessage = {
        id: "expired-running-command",
        backendMessageId: "backend-expired-running-command",
        role: "assistant",
        type: "tool_call",
        content: "read_command_output",
        metadata: {
          commandOutput: runningContract,
          output: "Historical output",
        },
        timestamp: 1,
        streaming: false,
      };
      const session: UIChatSession = {
        id: "running-recovery-session",
        title: "Running recovery",
        updatedAt: 1,
        messages: [message],
      };
      store.saveUiSessions([
        { session, summary: buildUiSessionSummary(session) },
      ]);
      const service = new UIHistoryService({ store });

      const geometry = service.getMessageGeometryIndex(session.id);
      assert.equal(
        geometry?.entries[0]?.metadata?.commandOutput?.executionState,
        "outcome_unknown",
      );
      assert.equal(geometry?.entries[0]?.streaming, false);

      const full = service.getFullMessagesByIds(session.id, [message.id]);
      assert.equal(
        full.messages[0]?.metadata?.commandOutput?.executionState,
        "outcome_unknown",
      );
      assert.equal(full.messages[0]?.streaming, false);
    });
  },
);

runCase("geometry index reflects a revision change", () => {
  withStore((store) => {
    const session: UIChatSession = {
      id: "geometry-revision-session",
      title: "Revision session",
      updatedAt: Date.now(),
      messages: [createMessage(0)],
    };
    store.saveUiSessions([
      { session, summary: buildUiSessionSummary(session) },
    ]);
    const first = store.loadUiMessageGeometryIndex(session.id);
    assert.ok(first);
    store.updateUiSessionRevision(session.id, 4);
    const second = store.loadUiMessageGeometryIndex(session.id);
    assert.ok(second);
    assert.equal(second?.uiRevision, 4);
  });
});

console.log("All chat geometry extreme tests passed.");
