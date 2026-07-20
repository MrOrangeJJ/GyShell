import {
  extractCommandOutputDisplayText,
  parseCommandOutputContractV1,
} from "@gyshell/shared";
import type { ChatMessage, UIChatSession } from "../../types/ui-chat";
import {
  expireUnbackedCommandOutputContract,
  rewriteCommandOutputEnvelopeContract,
} from "../AgentHelper/tools/command_output_contract";
import type { UISessionSummaryRecord } from "./historyTypes";

const SESSION_CLOSED_COMMAND_NOTE = "[Session closed before command finished]";

const normalizeBoundaryBackendId = (value: unknown): string => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
};

export const buildAutoSessionTitle = (content: string): string => {
  const normalized = String(content || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "New Chat";
};

export function cloneUiSession(session: UIChatSession): UIChatSession {
  return JSON.parse(JSON.stringify(session)) as UIChatSession;
}

export function restoreLegacyAutoTitleIfTruncated(
  session: UIChatSession,
): void {
  const firstUserText = session.messages.find(
    (message) => message.role === "user",
  )?.content;
  if (!firstUserText) return;

  const fullAutoTitle = buildAutoSessionTitle(firstUserText);
  const currentTitle = String(session.title || "").trim();
  if (!currentTitle || currentTitle === "New Chat") {
    session.title = fullAutoTitle;
    return;
  }

  if (currentTitle.endsWith("...")) {
    const prefix = currentTitle.slice(0, -3);
    if (prefix && fullAutoTitle.startsWith(prefix)) {
      session.title = fullAutoTitle;
    }
  }
}

export function sanitizeUiSession(
  session: UIChatSession,
  options?: {
    restoreLegacyAutoTitle?: boolean;
    recoverInterruptedCommands?: boolean;
  },
): UIChatSession {
  const sanitized = cloneUiSession(session);
  sanitized.messages = sanitized.messages.filter(
    (message) => message.type !== "ask",
  );
  sanitized.messages.forEach((message) => {
    const rawContract = message.metadata?.commandOutput as unknown;
    const previousContract = parseCommandOutputContractV1(rawContract);
    if (rawContract !== undefined) {
      const metadata = message.metadata || (message.metadata = {});
      if (previousContract) {
        metadata.commandOutput = previousContract;
      } else {
        delete metadata.commandOutput;
      }
    }

    if (options?.recoverInterruptedCommands !== false) {
      const lostTypedRunningCommand =
        previousContract?.executionState === "running";
      const lostLegacyRunningCommand =
        message.type === "command" && message.streaming === true;
      if (!previousContract && !lostLegacyRunningCommand) {
        return;
      }
      const metadata = message.metadata || (message.metadata = {});

      if (previousContract) {
        const recoveredContract =
          expireUnbackedCommandOutputContract(previousContract);
        if (recoveredContract !== previousContract) {
          metadata.commandOutput = recoveredContract;
          metadata.output = rewriteCommandOutputEnvelopeContract(
            metadata.output || "",
            recoveredContract,
          );
        }
      }

      if (lostTypedRunningCommand || lostLegacyRunningCommand) {
        message.streaming = false;
        if (message.type === "command" && metadata.exitCode === undefined) {
          metadata.exitCode = -1;
        }
        if (message.type === "command") {
          const output = metadata.output || "";
          if (!output.endsWith(SESSION_CLOSED_COMMAND_NOTE)) {
            metadata.output = `${output}${output ? "\n" : ""}${SESSION_CLOSED_COMMAND_NOTE}`;
          }
        }
      }
    }
  });
  sanitized.messages = normalizeCompactionBoundaryMarkers(sanitized.messages);
  if (options?.restoreLegacyAutoTitle) {
    restoreLegacyAutoTitleIfTruncated(sanitized);
  }
  return sanitized;
}

export function normalizeCompactionBoundaryMarkers(
  messages: ChatMessage[],
): ChatMessage[] {
  if (messages.length === 0) return messages;

  const baseMessages: ChatMessage[] = [];
  const boundaryMessages: ChatMessage[] = [];
  for (const message of messages) {
    if (message.type === "compaction_boundary") {
      boundaryMessages.push({
        ...message,
        role: "system",
        content: "",
        streaming: false,
      });
      continue;
    }
    baseMessages.push(message);
  }

  if (boundaryMessages.length === 0) return messages;

  const normalized = [...baseMessages];
  const seenBoundaryKeys = new Set<string>();

  for (const boundary of boundaryMessages) {
    const targetBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    const previousBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryPreviousBackendMessageId,
    );
    const summaryBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundarySummaryBackendMessageId,
    );
    const boundaryKey =
      summaryBackendId ||
      targetBackendId ||
      previousBackendId ||
      boundary.backendMessageId ||
      boundary.id;

    if (seenBoundaryKeys.has(boundaryKey)) {
      continue;
    }

    if (targetBackendId) {
      const targetIndex = normalized.findIndex(
        (message) => message.backendMessageId === targetBackendId,
      );
      if (targetIndex < 0) {
        continue;
      }
      normalized.splice(targetIndex, 0, boundary);
      seenBoundaryKeys.add(boundaryKey);
      continue;
    }

    if (previousBackendId) {
      const previousIndex = normalized.findIndex(
        (message) => message.backendMessageId === previousBackendId,
      );
      if (previousIndex < 0) {
        continue;
      }
      normalized.splice(previousIndex + 1, 0, boundary);
      seenBoundaryKeys.add(boundaryKey);
    }
  }

  return normalized;
}

export function getLastVisiblePreview(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === "tokens_count") continue;
    if (message.type === "compaction_boundary") continue;
    const imagePreview =
      Array.isArray(message.metadata?.inputImages) &&
      message.metadata.inputImages.length > 0
        ? message.metadata.inputImages
            .map((item) => item.fileName || item.attachmentId || "image")
            .join(", ")
        : "";
    const rawOutput = message.metadata?.output || "";
    const displayOutput = extractCommandOutputDisplayText(rawOutput);
    const hasDecodedCommandEnvelope = displayOutput !== rawOutput;
    const hasCommandOutputContract =
      parseCommandOutputContractV1(message.metadata?.commandOutput) !==
      undefined;
    const preview = String(
      hasCommandOutputContract || hasDecodedCommandEnvelope
        ? displayOutput || message.content || imagePreview || ""
        : message.content || displayOutput || imagePreview || "",
    );
    if (preview) {
      return preview;
    }
    return "";
  }
  return "";
}

export function buildUiSessionSummary(
  session: UIChatSession,
): UISessionSummaryRecord {
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    messagesCount: session.messages.length,
    lastMessagePreview: getLastVisiblePreview(session.messages),
  };
}
