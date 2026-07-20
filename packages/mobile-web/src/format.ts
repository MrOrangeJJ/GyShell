import type { ChatMessage } from "./types";
import { normalizeDisplayText, trimOuterBlankLines } from "./session-store";
import type { MobileTranslations } from "./i18n/types";
import {
  extractCommandOutputDisplayText,
  parseCommandOutputContractV1,
  type CommandCaptureReason,
} from "@gyshell/shared";

export interface CommandOutputDisplayStatus {
  execution: string;
  capture: string;
  presentation: string;
  tone: "neutral" | "warning" | "error";
  executionTone: "neutral" | "warning" | "error";
  captureTone: "neutral" | "warning";
}

export function commandOutputDisplayStatus(
  message: ChatMessage,
  t: MobileTranslations["format"],
): CommandOutputDisplayStatus | null {
  const contract = parseCommandOutputContractV1(
    message.metadata?.commandOutput,
  );
  if (!contract) return null;

  const execution = (() => {
    switch (contract.executionState) {
      case "running":
        return t.commandOutput.executionRunning;
      case "finished":
        return typeof contract.exitCode === "number"
          ? t.commandOutput.executionExit(contract.exitCode)
          : t.commandOutput.executionFinished;
      case "aborted":
        return t.commandOutput.executionAborted;
      case "outcome_unknown":
        return t.commandOutput.executionUnknown;
    }
  })();
  const captureBase = (() => {
    switch (contract.capture.state) {
      case "in_progress":
        return t.commandOutput.captureInProgress;
      case "complete":
        return t.commandOutput.captureComplete;
      case "incomplete":
        return t.commandOutput.captureIncomplete;
      case "unknown":
        return t.commandOutput.captureUnknown;
    }
  })();
  const captureDetails: string[] = [];
  if (contract.capture.reason) {
    captureDetails.push(
      commandCaptureReasonLabel(contract.capture.reason, t.commandOutput),
    );
  }
  if (
    contract.capture.observedUtf8Bytes !== contract.capture.retainedUtf8Bytes
  ) {
    captureDetails.push(
      t.commandOutput.retainedOfObserved(
        contract.capture.retainedUtf8Bytes,
        contract.capture.observedUtf8Bytes,
      ),
    );
  }
  if (contract.capture.terminalControlsObserved) {
    captureDetails.push(t.commandOutput.terminalControlsObserved);
  }
  const capture = `${captureBase}${
    captureDetails.length > 0 ? ` (${captureDetails.join("; ")})` : ""
  }`;
  const presentation = (() => {
    switch (contract.presentation.state) {
      case "none":
        return contract.executionState === "running"
          ? t.commandOutput.presentationNoneYet
          : t.commandOutput.presentationNone;
      case "full":
        return t.commandOutput.presentationFull;
      case "excerpt":
        return t.commandOutput.presentationExcerpt;
    }
  })();
  const hasFailedExit =
    contract.executionState === "finished" &&
    typeof contract.exitCode === "number" &&
    contract.exitCode !== 0;
  const hasUncertainState =
    contract.executionState === "aborted" ||
    contract.executionState === "outcome_unknown" ||
    contract.capture.state === "incomplete" ||
    contract.capture.state === "unknown";
  const executionTone = hasFailedExit
    ? "error"
    : contract.executionState === "aborted" ||
        contract.executionState === "outcome_unknown"
      ? "warning"
      : "neutral";
  const captureTone =
    contract.capture.state === "incomplete" ||
    contract.capture.state === "unknown"
      ? "warning"
      : "neutral";

  return {
    execution,
    capture,
    presentation,
    tone: hasFailedExit ? "error" : hasUncertainState ? "warning" : "neutral",
    executionTone,
    captureTone,
  };
}

const commandCaptureReasonLabel = (
  reason: CommandCaptureReason,
  t: MobileTranslations["format"]["commandOutput"],
): string => {
  switch (reason) {
    case "retention_limit":
      return t.reasonRetentionLimit;
    case "tracking_lost":
      return t.reasonTrackingLost;
    case "runtime_boundary":
      return t.reasonRuntimeBoundary;
    case "tracking_unavailable":
      return t.reasonTrackingUnavailable;
    case "projection_ambiguous":
      return t.reasonProjectionAmbiguous;
    case "record_expired":
      return t.reasonRecordExpired;
  }
};

export function formatClock(timestamp: number): string {
  if (!timestamp) return "--:--";
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatRelativeTime(
  timestamp: number,
  t: MobileTranslations["format"],
): string {
  if (!timestamp) return t.justNow;
  const delta = Date.now() - timestamp;
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;

  if (delta < minute) return t.justNow;
  if (delta < hour) return t.minutesAgo(Math.floor(delta / minute));
  if (delta < day) return t.hoursAgo(Math.floor(delta / hour));
  return t.daysAgo(Math.floor(delta / day));
}

export function messageTypeTitle(
  message: ChatMessage,
  t: MobileTranslations["format"],
): string {
  switch (message.type) {
    case "command":
      return t.commandRun;
    case "tool_call":
      return message.metadata?.toolName || t.toolCall;
    case "file_edit":
      return message.metadata?.action === "created"
        ? t.fileCreated
        : t.fileEdited;
    case "sub_tool":
      return message.metadata?.subToolTitle || t.subTool;
    case "reasoning":
      return message.metadata?.subToolTitle || t.reasoning;
    case "compaction":
      return message.metadata?.subToolTitle || t.compaction;
    case "alert":
      return t.alert;
    case "error":
      return t.error;
    case "ask":
      return t.permissionRequired;
    default:
      return t.message;
  }
}

export function messageDetail(
  message: ChatMessage,
  t: MobileTranslations["format"],
): string {
  if (message.type === "command") {
    const output = trimOuterBlankLines(
      normalizeDisplayText(
        extractCommandOutputDisplayText(message.metadata?.output || ""),
      ),
    );
    const command = trimOuterBlankLines(
      normalizeDisplayText(message.content || message.metadata?.command || ""),
    );
    if (output) return `${command}\n\n${output}`;
    return command;
  }

  if (message.type === "file_edit") {
    const path = message.metadata?.filePath || t.unknownFile;
    const diff = trimOuterBlankLines(
      normalizeDisplayText(message.metadata?.diff || ""),
    );
    const summary = message.content
      ? trimOuterBlankLines(normalizeDisplayText(message.content))
      : "";
    const head = `${path}${summary ? `\n${summary}` : ""}`;
    if (!diff) return head;
    return `${head}\n\n${diff}`;
  }

  if (message.type === "ask") {
    return trimOuterBlankLines(
      normalizeDisplayText(message.metadata?.command || message.content || ""),
    );
  }

  const rawOutput = message.metadata?.output || "";
  const displayOutput = extractCommandOutputDisplayText(rawOutput);
  const base = displayOutput || message.content || "";
  return trimOuterBlankLines(normalizeDisplayText(base));
}

export function clipMultilineWithLocale(
  text: string,
  maxLines: number,
  t: MobileTranslations["format"],
  maxChars = 420,
): string {
  const normalized = String(text || "");
  if (!normalized) return "";

  const lines = normalized.split("\n");
  if (lines.length > maxLines) {
    return `${lines.slice(0, maxLines).join("\n")}\n${t.moreLines(lines.length - maxLines)}`;
  }

  if (normalized.length > maxChars) {
    return `${normalized.slice(0, maxChars).trimEnd()}\n${t.moreChars(normalized.length - maxChars)}`;
  }

  return normalized;
}
