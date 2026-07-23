import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatHistoryService } from "./ChatHistoryService";
import { UIHistoryService } from "./UIHistoryService";
import { HistorySqliteStore } from "./history/HistorySqliteStore";

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

const appendSimpleConversation = (uiHistory: UIHistoryService): void => {
  uiHistory.recordEvent("session-1", {
    type: "user_input",
    content: "first",
    messageId: "backend-user-1",
  } as any);
  uiHistory.recordEvent("session-1", {
    type: "say",
    content: "reply one",
    messageId: "backend-assistant-1",
  } as any);
  uiHistory.recordEvent("session-1", { type: "done" } as any);
  uiHistory.recordEvent("session-1", {
    type: "user_input",
    content: "second",
    messageId: "backend-user-2",
  } as any);
  uiHistory.recordEvent("session-1", {
    type: "say",
    content: "reply two",
    messageId: "backend-assistant-2",
  } as any);
  uiHistory.recordEvent("session-1", { type: "done" } as any);
  uiHistory.recordEvent("session-1", {
    type: "user_input",
    content: "third",
    messageId: "backend-user-3",
  } as any);
};

const run = (): void => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gyshell-ui-boundary-extreme-"),
  );
  const sqlitePath = path.join(tempDir, "history.sqlite3");
  const store = new HistorySqliteStore({ filePath: sqlitePath });
  const chatHistory = new ChatHistoryService({ store });
  const uiHistory = new UIHistoryService({ store });

  try {
    runCase(
      "renaming an empty session persists and survives the first user message",
      () => {
        chatHistory.renameSession("empty-renamed", "Investigate...");
        uiHistory.renameSession("empty-renamed", "Investigate...");

        assertEqual(
          chatHistory.loadSession("empty-renamed")?.title,
          "Investigate...",
          "agent history should upsert the renamed empty session",
        );
        assertEqual(
          uiHistory.getSession("empty-renamed")?.title,
          "Investigate...",
          "UI history should upsert the renamed empty session",
        );

        uiHistory.recordEvent("empty-renamed", {
          type: "user_input",
          content: "Investigate production issue",
          messageId: "empty-renamed-user-1",
        } as any);
        uiHistory.flush("empty-renamed");

        const reloadedUiHistory = new UIHistoryService({ store });
        assertEqual(
          reloadedUiHistory.getSession("empty-renamed")?.title,
          "Investigate...",
          "manual ellipsis title should survive the first prompt and a reload",
        );
      },
    );

    runCase("default empty sessions still receive an automatic title", () => {
      uiHistory.recordEvent("empty-default", {
        type: "user_input",
        content: "Automatic first prompt title",
        messageId: "empty-default-user-1",
      } as any);

      assertEqual(
        uiHistory.getSession("empty-default")?.title,
        "Automatic first prompt title",
        "untouched New Chat sessions should retain automatic title behavior",
      );
    });

    runCase("a stale active-run snapshot cannot overwrite a newer rename", () => {
      chatHistory.saveSession({
        id: "active-run-rename",
        title: "Old title",
        messages: new Map(),
        lastCheckpointOffset: 0,
      });
      const staleRunSnapshot = chatHistory.loadSession("active-run-rename");
      if (!staleRunSnapshot) {
        throw new Error("expected active-run snapshot to load");
      }

      chatHistory.renameSession("active-run-rename", "Renamed while running");
      chatHistory.saveSession(staleRunSnapshot);

      assertEqual(
        chatHistory.loadSession("active-run-rename")?.title,
        "Renamed while running",
        "run completion should merge the latest stored title",
      );
    });

    runCase(
      "compaction boundary inserts before the protected tail anchor",
      () => {
        appendSimpleConversation(uiHistory);

        const actions = uiHistory.recordEvent("session-1", {
          type: "compaction_boundary",
          messageId: "ui-boundary-1",
          boundaryTargetMessageId: "backend-user-2",
          boundaryPreviousMessageId: "backend-assistant-1",
          summaryMessageId: "backend-summary-1",
          protectedNormalRounds: 2,
        } as any);

        assertEqual(
          actions[0]?.type,
          "INSERT_MESSAGE",
          "boundary event should produce an insertion action",
        );
        assertEqual(
          (actions[0] as any)?.anchorBackendMessageId,
          "backend-user-2",
          "boundary action should anchor to the first protected message",
        );
        assertEqual(
          (actions[0] as any)?.placement,
          "before",
          "boundary action should insert before its protected tail anchor",
        );
        assertDeepEqual(
          uiHistory.getMessages("session-1").map((message) => message.type),
          ["text", "text", "compaction_boundary", "text", "text", "text"],
          "boundary marker should be persisted at the cutoff",
        );
        assertEqual(
          uiHistory.getMessages("session-1")[2]?.metadata
            ?.compactionBoundarySummaryBackendMessageId,
          "backend-summary-1",
          "boundary marker should retain the hidden summary id",
        );
      },
    );

    runCase(
      "compaction boundary survives flush and reload at the same cutoff",
      () => {
        uiHistory.flush("session-1");
        const reloaded = new UIHistoryService({ store });

        assertDeepEqual(
          reloaded
            .getMessages("session-1")
            .map(
              (message) => `${message.type}:${message.backendMessageId || ""}`,
            ),
          [
            "text:backend-user-1",
            "text:backend-assistant-1",
            "compaction_boundary:ui-boundary-1",
            "text:backend-user-2",
            "text:backend-assistant-2",
            "text:backend-user-3",
          ],
          "reloaded UI history should keep the boundary before the same backend anchor",
        );
      },
    );

    runCase("duplicate boundary events do not create duplicate markers", () => {
      const actions = uiHistory.recordEvent("session-1", {
        type: "compaction_boundary",
        messageId: "ui-boundary-duplicate",
        boundaryTargetMessageId: "backend-user-2",
        summaryMessageId: "backend-summary-1",
      } as any);

      assertEqual(
        actions.length,
        0,
        "duplicate boundary should not emit another insertion",
      );
      assertEqual(
        uiHistory
          .getMessages("session-1")
          .filter((message) => message.type === "compaction_boundary").length,
        1,
        "duplicate boundary should not be stored twice",
      );
    });

    runCase(
      "zero-retention boundary inserts after the final old message and survives reload",
      () => {
        uiHistory.recordEvent("zero-retention", {
          type: "user_input",
          content: "latest unfinished request",
          messageId: "zero-user-last",
        } as any);
        uiHistory.recordEvent("zero-retention", {
          type: "compaction_boundary",
          messageId: "zero-boundary",
          boundaryPreviousMessageId: "zero-user-last",
          summaryMessageId: "zero-summary",
          protectedNormalRounds: 0,
        } as any);
        uiHistory.recordEvent("zero-retention", {
          type: "sub_tool_started",
          messageId: "zero-progress",
          title: "Compaction...",
        } as any);

        assertDeepEqual(
          uiHistory
            .getMessages("zero-retention")
            .map((message) => message.type),
          ["text", "compaction_boundary", "compaction"],
          "zero-retention marker should sit after all old messages and before compaction progress",
        );
        assertEqual(
          uiHistory.getMessages("zero-retention")[1]?.metadata
            ?.compactionBoundaryProtectedNormalRounds,
          0,
          "zero retained rounds must remain explicit in UI metadata",
        );

        uiHistory.flush("zero-retention");
        const reloaded = new UIHistoryService({ store });
        assertDeepEqual(
          reloaded
            .getMessages("zero-retention")
            .map((message) => message.type),
          ["text", "compaction_boundary", "compaction"],
          "previous-only zero-retention placement should survive persistence",
        );
      },
    );

    runCase(
      "rollback removes a boundary whose protected tail anchor was cut",
      () => {
        uiHistory.recordEvent("session-1", {
          type: "rollback",
          messageId: "backend-user-2",
        } as any);

        assertDeepEqual(
          uiHistory
            .getMessages("session-1")
            .map(
              (message) => `${message.type}:${message.backendMessageId || ""}`,
            ),
          ["text:backend-user-1", "text:backend-assistant-1"],
          "rollback should remove the boundary when its target is removed",
        );
      },
    );

    runCase("missing boundary anchors are ignored instead of appended", () => {
      const beforeCount = uiHistory.getMessages("session-1").length;
      const actions = uiHistory.recordEvent("session-1", {
        type: "compaction_boundary",
        messageId: "ui-boundary-missing",
        boundaryTargetMessageId: "missing-user",
        summaryMessageId: "backend-summary-missing",
      } as any);

      assertEqual(
        actions.length,
        0,
        "missing anchor should not emit UI action",
      );
      assertEqual(
        uiHistory.getMessages("session-1").length,
        beforeCount,
        "missing anchor should not mutate persisted UI history",
      );
    });
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

run();
