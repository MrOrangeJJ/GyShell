import fs from "node:fs";
import path from "node:path";
import type {
  ChatMessage,
  DeferredUiMessageField,
  UIChatSession,
} from "../../types/ui-chat";
import type {
  ChatSessionSummaryRecord,
  PositionedUiMessage,
  StoredChatMessageRecord,
  StoredChatSessionHeader,
  StoredChatSessionRecord,
  UiMessagePage,
  UiMessagePageRequest,
  UiMessageSearchResult,
  UISessionSummaryRecord,
} from "./historyTypes";
import {
  createChatTextGeometryShape,
  extractCommandOutputDisplayText,
  parseCommandOutputContractV1,
  readOpaqueNonBlankWellFormedString,
  type ChatGeometryDeferredField,
  type CommandOutputContractV1,
  type ChatMessageGeometryMetadata,
  type ChatMessageGeometryProjection,
  type UiMessageGeometryEntry,
  type UiMessageGeometryIndex,
} from "@gyshell/shared";
import { openBetterSqlite3Database } from "./betterSqlite3Runtime";
import { resolveHistoryStoragePaths } from "./historyStoragePaths";

type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

const readHistorySessionId = (value: unknown): string | undefined =>
  readOpaqueNonBlankWellFormedString(value);

const requireHistorySessionId = (value: unknown): string => {
  const sessionId = readHistorySessionId(value);
  if (sessionId === undefined) throw new Error("Session id is required.");
  return sessionId;
};

const requireHistorySessionIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("Session ids must be an array.");
  const sessionIds = value.map((candidate) => {
    return requireHistorySessionId(candidate);
  });
  return Array.from(new Set(sessionIds));
};

interface HistorySqliteStoreOptions {
  filePath?: string;
}

interface ChatSessionRow {
  id: string;
  title: string;
  last_checkpoint_offset: number;
  last_profile_max_tokens: number | null;
  created_at: number;
  updated_at: number;
}

interface ChatSessionMessageRow {
  position?: number;
  message_id: string;
  message_type: string;
  message_data_json: string;
  is_compaction_marker?: number | null;
}

interface UiSessionRow {
  id: string;
  title: string;
  updated_at: number;
  messages_count: number;
  last_message_preview: string;
  ui_revision: number;
}

interface UiSessionMessageRow {
  position?: number;
  ui_message_id: string;
  backend_message_id: string | null;
  role: ChatMessage["role"];
  message_type: ChatMessage["type"];
  content: string;
  metadata_json: string | null;
  timestamp: number;
  streaming: number;
}

interface UiCommandOutputProjectionFields {
  metadata_command_output_contract_version: unknown;
  metadata_command_output_terminal_id: unknown;
  metadata_command_output_history_command_match_id: unknown;
  metadata_command_output_execution_state: unknown;
  metadata_command_output_exit_code: unknown;
  metadata_command_output_capture_state: unknown;
  metadata_command_output_capture_reason: unknown;
  metadata_command_output_observed_utf8_bytes: unknown;
  metadata_command_output_retained_utf8_bytes: unknown;
  metadata_command_output_available_line_count: unknown;
  metadata_command_output_capture_revision: unknown;
  metadata_command_output_terminal_controls_observed: unknown;
  metadata_command_output_presentation_state: unknown;
  metadata_command_output_returned_utf8_bytes: unknown;
  metadata_command_output_has_more_captured_output: unknown;
  metadata_command_output_next_cursor: unknown;
  metadata_command_output_poll_cursor: unknown;
}

interface UiSessionMessageProjectionRow
  extends Omit<UiSessionMessageRow, "content" | "metadata_json">,
    UiCommandOutputProjectionFields {
  content_length: number;
  content_head: string | null;
  content_tail: string | null;
  metadata_tab_name: string | null;
  metadata_command_id: string | null;
  metadata_exit_code: number | null;
  metadata_output_length: number | null;
  metadata_output_head: string | null;
  metadata_output_tail: string | null;
  metadata_diff_length: number | null;
  metadata_diff_head: string | null;
  metadata_diff_tail: string | null;
  metadata_file_path: string | null;
  metadata_action: string | null;
  metadata_collapsed: number | null;
  metadata_is_nowait: number | null;
  metadata_tool_name: string | null;
  metadata_sub_tool_title: string | null;
  metadata_sub_tool_hint: string | null;
  metadata_sub_tool_level: string | null;
  metadata_approval_id: string | null;
  metadata_decision: string | null;
  metadata_command: string | null;
  metadata_model_name: string | null;
  metadata_total_tokens: number | null;
  metadata_max_tokens: number | null;
  metadata_details_length: number | null;
  metadata_details_head: string | null;
  metadata_details_tail: string | null;
  metadata_input_kind: string | null;
  metadata_input_images_json: string | null;
  metadata_input_images_length: number | null;
  metadata_compaction_target: string | null;
  metadata_compaction_previous: string | null;
  metadata_compaction_summary: string | null;
  metadata_compaction_rounds: number | null;
}

interface UiSessionMessageGeometryRow
  extends Omit<UiSessionMessageRow, "metadata_json">,
    UiCommandOutputProjectionFields {
  metadata_tab_name: unknown;
  metadata_command_id: unknown;
  metadata_exit_code: unknown;
  metadata_output: unknown;
  metadata_diff: unknown;
  metadata_file_path: unknown;
  metadata_action: unknown;
  metadata_collapsed: unknown;
  metadata_is_nowait: unknown;
  metadata_tool_name: unknown;
  metadata_sub_tool_title: unknown;
  metadata_sub_tool_hint: unknown;
  metadata_sub_tool_level: unknown;
  metadata_approval_id: unknown;
  metadata_decision: unknown;
  metadata_command: unknown;
  metadata_model_name: unknown;
  metadata_total_tokens: unknown;
  metadata_max_tokens: unknown;
  metadata_details: unknown;
  metadata_input_kind: unknown;
  metadata_input_image_count: number | null;
  metadata_compaction_target: unknown;
  metadata_compaction_previous: unknown;
  metadata_compaction_summary: unknown;
  metadata_compaction_rounds: unknown;
  metadata_deferred: number | null;
}

const UI_MESSAGE_PAGE_DEFAULT_LIMIT = 300;
const UI_MESSAGE_PAGE_MAX_LIMIT = 1_000;
const UI_MESSAGE_LIST_FIELD_LIMIT = 12_000;
const UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT = 512;
const UI_GEOMETRY_OUTPUT_MESSAGE_TYPES: ReadonlySet<ChatMessage["type"]> =
  new Set(["command", "tool_call", "file_edit", "sub_tool", "reasoning"]);
const UI_MESSAGE_STRUCTURAL_METADATA_STRING_FIELDS = [
  "tabName",
  "commandId",
  "filePath",
  "toolName",
  "subToolTitle",
  "subToolHint",
  "approvalId",
  "command",
  "modelName",
  "compactionBoundaryTargetBackendMessageId",
  "compactionBoundaryPreviousBackendMessageId",
  "compactionBoundarySummaryBackendMessageId",
] as const;

const isHighSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xd800 && codeUnit <= 0xdbff;
const isLowSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

const sliceFromStartAtUnicodeBoundary = (
  value: string,
  maxCodeUnits: number,
): string => {
  let end = Math.min(value.length, Math.max(0, maxCodeUnits));
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1;
  }
  return value.slice(0, end);
};

const sliceFromEndAtUnicodeBoundary = (
  value: string,
  maxCodeUnits: number,
): string => {
  let start = Math.max(0, value.length - Math.max(0, maxCodeUnits));
  if (
    start > 0 &&
    start < value.length &&
    isHighSurrogate(value.charCodeAt(start - 1)) &&
    isLowSurrogate(value.charCodeAt(start))
  ) {
    start += 1;
  }
  return value.slice(start);
};

const normalizePageLimit = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return UI_MESSAGE_PAGE_DEFAULT_LIMIT;
  return Math.min(UI_MESSAGE_PAGE_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
};

// Keep the projection textually silent. The deferredPayload flag is an
// internal hydration hint; it must not introduce a new transcript label.
const createBoundedListPreview = (value: string): string => {
  if (value.length <= UI_MESSAGE_LIST_FIELD_LIMIT) return value;
  const headLength = Math.ceil(UI_MESSAGE_LIST_FIELD_LIMIT / 2);
  const tailLength = Math.floor(UI_MESSAGE_LIST_FIELD_LIMIT / 2);
  return `${sliceFromStartAtUnicodeBoundary(value, headLength)}${sliceFromEndAtUnicodeBoundary(value, tailLength)}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const sanitizeUiMessageMetadata = (
  value: unknown,
): ChatMessage["metadata"] => {
  if (!isRecord(value)) return undefined;
  const metadata: NonNullable<ChatMessage["metadata"]> = {};
  const assignString = <K extends keyof typeof metadata>(key: K): void => {
    const candidate = value[key];
    if (typeof candidate === "string") {
      metadata[key] = candidate as (typeof metadata)[K];
    }
  };
  for (const field of [
    ...UI_MESSAGE_STRUCTURAL_METADATA_STRING_FIELDS,
    "output",
    "diff",
    "details",
  ] as const) {
    assignString(field);
  }
  if (
    value.action === "created" ||
    value.action === "edited" ||
    value.action === "error"
  ) {
    metadata.action = value.action;
  }
  if (
    value.subToolLevel === "info" ||
    value.subToolLevel === "warning" ||
    value.subToolLevel === "error"
  ) {
    metadata.subToolLevel = value.subToolLevel;
  }
  if (value.decision === "allow" || value.decision === "deny") {
    metadata.decision = value.decision;
  }
  if (value.inputKind === "normal" || value.inputKind === "inserted") {
    metadata.inputKind = value.inputKind;
  }
  for (const field of ["collapsed", "isNowait"] as const) {
    if (typeof value[field] === "boolean") {
      metadata[field] = value[field];
    }
  }
  if (Number.isSafeInteger(value.exitCode)) {
    metadata.exitCode = Number(value.exitCode);
  }
  for (const field of [
    "totalTokens",
    "maxTokens",
    "compactionBoundaryProtectedNormalRounds",
  ] as const) {
    if (Number.isSafeInteger(value[field]) && Number(value[field]) >= 0) {
      metadata[field] = Number(value[field]);
    }
  }
  const commandOutput = parseCommandOutputContractV1(value.commandOutput);
  if (commandOutput) metadata.commandOutput = commandOutput;
  if (Array.isArray(value.inputImages)) {
    const images = value.inputImages.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const image: NonNullable<
        NonNullable<ChatMessage["metadata"]>["inputImages"]
      >[number] = {};
      for (const field of [
        "attachmentId",
        "fileName",
        "mimeType",
        "sha256",
        "previewDataUrl",
      ] as const) {
        if (typeof candidate[field] === "string") {
          image[field] = candidate[field];
        }
      }
      if (
        Number.isSafeInteger(candidate.sizeBytes) &&
        Number(candidate.sizeBytes) >= 0
      ) {
        image.sizeBytes = Number(candidate.sizeBytes);
      }
      if (candidate.status === "ready" || candidate.status === "missing") {
        image.status = candidate.status;
      }
      return Object.keys(image).length > 0 ? [image] : [];
    });
    if (images.length > 0) metadata.inputImages = images;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const parseUiMessageMetadata = (
  rawMetadata: string | null,
): ChatMessage["metadata"] => {
  if (!rawMetadata) return undefined;
  try {
    return sanitizeUiMessageMetadata(JSON.parse(rawMetadata));
  } catch {
    return undefined;
  }
};

const parseUiMessageRow = (row: UiSessionMessageRow): ChatMessage => ({
  id: row.ui_message_id,
  backendMessageId: row.backend_message_id ?? undefined,
  role: row.role,
  type: row.message_type,
  content: row.content,
  metadata: parseUiMessageMetadata(row.metadata_json),
  timestamp: row.timestamp,
  streaming: Boolean(row.streaming),
});

const combineProjectedText = (
  head: string | null,
  tail: string | null,
  length: number | null | undefined,
): { value: string; deferred: boolean } => {
  const normalizedLength = Number(length || 0);
  const headValue = String(head || "");
  if (
    !Number.isFinite(normalizedLength) ||
    normalizedLength <= UI_MESSAGE_LIST_FIELD_LIMIT
  ) {
    return { value: headValue, deferred: false };
  }
  const tailValue = String(tail || "");
  const expectedHeadLength = Math.ceil(UI_MESSAGE_LIST_FIELD_LIMIT / 2);
  const expectedTailLength = Math.floor(UI_MESSAGE_LIST_FIELD_LIMIT / 2);
  return {
    value: `${sliceFromStartAtUnicodeBoundary(headValue, expectedHeadLength)}${sliceFromEndAtUnicodeBoundary(tailValue, expectedTailLength)}`,
    deferred: true,
  };
};

const parseUiMessageProjectionRow = (
  row: UiSessionMessageProjectionRow,
): ChatMessage => {
  const content = combineProjectedText(
    row.content_head,
    row.content_tail,
    row.content_length,
  );
  const output = combineProjectedText(
    row.metadata_output_head,
    row.metadata_output_tail,
    row.metadata_output_length,
  );
  const diff = combineProjectedText(
    row.metadata_diff_head,
    row.metadata_diff_tail,
    row.metadata_diff_length,
  );
  const details = combineProjectedText(
    row.metadata_details_head,
    row.metadata_details_tail,
    row.metadata_details_length,
  );
  const deferredFields: DeferredUiMessageField[] = [];
  const defer = (field: DeferredUiMessageField): void => {
    if (!deferredFields.includes(field)) deferredFields.push(field);
  };
  if (content.deferred) defer("content");
  if (output.deferred) defer("output");
  if (diff.deferred) defer("diff");
  if (details.deferred) defer("details");
  if (
    Number(row.metadata_input_images_length || 0) > UI_MESSAGE_LIST_FIELD_LIMIT
  ) {
    defer("inputImages");
  }
  const metadata: Record<string, any> = {};
  const assign = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined && value !== "") {
      metadata[key] = value;
    }
  };
  const assignBoundedString = (key: string, value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    const bounded = createBoundedListPreview(value);
    metadata[key] = bounded;
    if (bounded !== value) defer("metadata");
  };
  assignBoundedString("tabName", row.metadata_tab_name);
  assignBoundedString("commandId", row.metadata_command_id);
  assign("exitCode", row.metadata_exit_code);
  if (output.value) assign("output", output.value);
  if (diff.value) assign("diff", diff.value);
  assignBoundedString("filePath", row.metadata_file_path);
  assignBoundedString("action", row.metadata_action);
  if (row.metadata_collapsed !== null) {
    metadata.collapsed = Boolean(row.metadata_collapsed);
  }
  if (row.metadata_is_nowait !== null) {
    metadata.isNowait = Boolean(row.metadata_is_nowait);
  }
  const commandOutput = readProjectedCommandOutput(row);
  if (commandOutput) metadata.commandOutput = commandOutput;
  assignBoundedString("toolName", row.metadata_tool_name);
  assignBoundedString("subToolTitle", row.metadata_sub_tool_title);
  assignBoundedString("subToolHint", row.metadata_sub_tool_hint);
  assignBoundedString("subToolLevel", row.metadata_sub_tool_level);
  assignBoundedString("approvalId", row.metadata_approval_id);
  assignBoundedString("decision", row.metadata_decision);
  assignBoundedString("command", row.metadata_command);
  assignBoundedString("modelName", row.metadata_model_name);
  assign("totalTokens", row.metadata_total_tokens);
  assign("maxTokens", row.metadata_max_tokens);
  if (details.value) assign("details", details.value);
  assignBoundedString("inputKind", row.metadata_input_kind);
  if (
    row.metadata_input_images_json &&
    !deferredFields.includes("inputImages")
  ) {
    try {
      metadata.inputImages = JSON.parse(row.metadata_input_images_json);
    } catch {
      // Ignore malformed optional metadata in the bounded list projection.
    }
  }
  assignBoundedString(
    "compactionBoundaryTargetBackendMessageId",
    row.metadata_compaction_target,
  );
  assignBoundedString(
    "compactionBoundaryPreviousBackendMessageId",
    row.metadata_compaction_previous,
  );
  assignBoundedString(
    "compactionBoundarySummaryBackendMessageId",
    row.metadata_compaction_summary,
  );
  assign(
    "compactionBoundaryProtectedNormalRounds",
    row.metadata_compaction_rounds,
  );

  const message: ChatMessage = {
    id: row.ui_message_id,
    backendMessageId: row.backend_message_id ?? undefined,
    role: row.role,
    type: row.message_type,
    content: content.value,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    timestamp: row.timestamp,
    streaming: Boolean(row.streaming),
  };
  if (deferredFields.length > 0) {
    message.deferredPayload = { fields: deferredFields };
  }
  return message;
};

const SQL_JSON_TEXT_FIELD = (field: string): string =>
  `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json, '$.${field}') = 'text' THEN json_extract(metadata_json, '$.${field}') END`;

const SQL_JSON_INTEGER_FIELD = (field: string): string =>
  `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json, '$.${field}') = 'integer' THEN json_extract(metadata_json, '$.${field}') END`;

const SQL_JSON_BOOLEAN_FIELD = (field: string): string =>
  `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json, '$.${field}') IN ('true', 'false') THEN json_extract(metadata_json, '$.${field}') END`;

const SQL_JSON_ARRAY_FIELD = (field: string): string =>
  `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json, '$.${field}') = 'array' THEN json_extract(metadata_json, '$.${field}') END`;

const SQL_JSON_TEXT_PATH_FIELD = (path: string): string =>
  `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json, '$.${path}') = 'text' THEN json_extract(metadata_json, '$.${path}') END`;

const SQL_JSON_INTEGER_PATH_FIELD = (path: string): string =>
  `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json, '$.${path}') = 'integer' THEN json_extract(metadata_json, '$.${path}') END`;

const SQL_JSON_BOOLEAN_PATH_FIELD = (path: string): string =>
  `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json, '$.${path}') IN ('true', 'false') THEN json_extract(metadata_json, '$.${path}') END`;

const SQL_JSON_BOUNDED_TEXT_PATH_FIELD = (
  path: string,
  maximumLength: number,
): string => {
  const expression = SQL_JSON_TEXT_PATH_FIELD(path);
  return `CASE WHEN length(${expression}) <= ${maximumLength} THEN ${expression} END`;
};

const UI_COMMAND_OUTPUT_IDENTIFIER_LIMIT = 1_024;
const UI_COMMAND_OUTPUT_CURSOR_LIMIT = 4_096;
const UI_COMMAND_OUTPUT_ENUM_LIMIT = 64;

const UI_COMMAND_OUTPUT_PROJECTION_COLUMNS = `
  ${SQL_JSON_INTEGER_PATH_FIELD("commandOutput.contractVersion")} AS metadata_command_output_contract_version,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.terminalId",
    UI_COMMAND_OUTPUT_IDENTIFIER_LIMIT,
  )} AS metadata_command_output_terminal_id,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.historyCommandMatchId",
    UI_COMMAND_OUTPUT_IDENTIFIER_LIMIT,
  )} AS metadata_command_output_history_command_match_id,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.executionState",
    UI_COMMAND_OUTPUT_ENUM_LIMIT,
  )} AS metadata_command_output_execution_state,
  ${SQL_JSON_INTEGER_PATH_FIELD("commandOutput.exitCode")} AS metadata_command_output_exit_code,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.capture.state",
    UI_COMMAND_OUTPUT_ENUM_LIMIT,
  )} AS metadata_command_output_capture_state,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.capture.reason",
    UI_COMMAND_OUTPUT_ENUM_LIMIT,
  )} AS metadata_command_output_capture_reason,
  ${SQL_JSON_INTEGER_PATH_FIELD("commandOutput.capture.observedUtf8Bytes")} AS metadata_command_output_observed_utf8_bytes,
  ${SQL_JSON_INTEGER_PATH_FIELD("commandOutput.capture.retainedUtf8Bytes")} AS metadata_command_output_retained_utf8_bytes,
  ${SQL_JSON_INTEGER_PATH_FIELD("commandOutput.capture.availableLineCount")} AS metadata_command_output_available_line_count,
  ${SQL_JSON_INTEGER_PATH_FIELD("commandOutput.capture.revision")} AS metadata_command_output_capture_revision,
  ${SQL_JSON_BOOLEAN_PATH_FIELD("commandOutput.capture.terminalControlsObserved")} AS metadata_command_output_terminal_controls_observed,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.presentation.state",
    UI_COMMAND_OUTPUT_ENUM_LIMIT,
  )} AS metadata_command_output_presentation_state,
  ${SQL_JSON_INTEGER_PATH_FIELD("commandOutput.presentation.returnedUtf8Bytes")} AS metadata_command_output_returned_utf8_bytes,
  ${SQL_JSON_BOOLEAN_PATH_FIELD("commandOutput.presentation.hasMoreCapturedOutput")} AS metadata_command_output_has_more_captured_output,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.presentation.nextCursor",
    UI_COMMAND_OUTPUT_CURSOR_LIMIT,
  )} AS metadata_command_output_next_cursor,
  ${SQL_JSON_BOUNDED_TEXT_PATH_FIELD(
    "commandOutput.presentation.pollCursor",
    UI_COMMAND_OUTPUT_CURSOR_LIMIT,
  )} AS metadata_command_output_poll_cursor`;

const readSqlBoolean = (value: unknown): unknown => {
  if (value === 0 || value === 1) return Boolean(value);
  return value;
};

const readProjectedCommandOutput = (
  row: UiCommandOutputProjectionFields,
): CommandOutputContractV1 | undefined => {
  const captureReason = row.metadata_command_output_capture_reason;
  const nextCursor = row.metadata_command_output_next_cursor;
  const pollCursor = row.metadata_command_output_poll_cursor;
  return parseCommandOutputContractV1({
    contractVersion: row.metadata_command_output_contract_version,
    terminalId: row.metadata_command_output_terminal_id,
    historyCommandMatchId:
      row.metadata_command_output_history_command_match_id,
    executionState: row.metadata_command_output_execution_state,
    exitCode:
      row.metadata_command_output_exit_code === null ||
      row.metadata_command_output_exit_code === undefined
        ? null
        : row.metadata_command_output_exit_code,
    capture: {
      state: row.metadata_command_output_capture_state,
      ...(captureReason !== null && captureReason !== undefined
        ? { reason: captureReason }
        : {}),
      observedUtf8Bytes: row.metadata_command_output_observed_utf8_bytes,
      retainedUtf8Bytes: row.metadata_command_output_retained_utf8_bytes,
      availableLineCount: row.metadata_command_output_available_line_count,
      revision: row.metadata_command_output_capture_revision,
      terminalControlsObserved: readSqlBoolean(
        row.metadata_command_output_terminal_controls_observed,
      ),
    },
    presentation: {
      state: row.metadata_command_output_presentation_state,
      returnedUtf8Bytes: row.metadata_command_output_returned_utf8_bytes,
      hasMoreCapturedOutput: readSqlBoolean(
        row.metadata_command_output_has_more_captured_output,
      ),
      ...(nextCursor !== null && nextCursor !== undefined
        ? { nextCursor }
        : {}),
      ...(pollCursor !== null && pollCursor !== undefined
        ? { pollCursor }
        : {}),
    },
  });
};

const UI_MESSAGE_LIST_COLUMNS = `
  position, ui_message_id, backend_message_id, role, message_type,
  length(content) AS content_length,
  CASE WHEN length(content) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN content ELSE substr(content, 1, ${Math.ceil(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS content_head,
  CASE WHEN length(content) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN '' ELSE substr(content, -${Math.floor(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS content_tail,
  timestamp, streaming,
  ${SQL_JSON_TEXT_FIELD("tabName")} AS metadata_tab_name,
  ${SQL_JSON_TEXT_FIELD("commandId")} AS metadata_command_id,
  ${SQL_JSON_INTEGER_FIELD("exitCode")} AS metadata_exit_code,
  length(${SQL_JSON_TEXT_FIELD("output")}) AS metadata_output_length,
  CASE WHEN length(${SQL_JSON_TEXT_FIELD("output")}) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN ${SQL_JSON_TEXT_FIELD("output")}
       ELSE substr(${SQL_JSON_TEXT_FIELD("output")}, 1, ${Math.ceil(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS metadata_output_head,
  CASE WHEN length(${SQL_JSON_TEXT_FIELD("output")}) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN '' ELSE substr(${SQL_JSON_TEXT_FIELD("output")}, -${Math.floor(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS metadata_output_tail,
  length(${SQL_JSON_TEXT_FIELD("diff")}) AS metadata_diff_length,
  CASE WHEN length(${SQL_JSON_TEXT_FIELD("diff")}) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN ${SQL_JSON_TEXT_FIELD("diff")}
       ELSE substr(${SQL_JSON_TEXT_FIELD("diff")}, 1, ${Math.ceil(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS metadata_diff_head,
  CASE WHEN length(${SQL_JSON_TEXT_FIELD("diff")}) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN '' ELSE substr(${SQL_JSON_TEXT_FIELD("diff")}, -${Math.floor(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS metadata_diff_tail,
  ${SQL_JSON_TEXT_FIELD("filePath")} AS metadata_file_path,
  ${SQL_JSON_TEXT_FIELD("action")} AS metadata_action,
  ${SQL_JSON_BOOLEAN_FIELD("collapsed")} AS metadata_collapsed,
  ${SQL_JSON_BOOLEAN_FIELD("isNowait")} AS metadata_is_nowait,
  ${UI_COMMAND_OUTPUT_PROJECTION_COLUMNS},
  ${SQL_JSON_TEXT_FIELD("toolName")} AS metadata_tool_name,
  ${SQL_JSON_TEXT_FIELD("subToolTitle")} AS metadata_sub_tool_title,
  ${SQL_JSON_TEXT_FIELD("subToolHint")} AS metadata_sub_tool_hint,
  ${SQL_JSON_TEXT_FIELD("subToolLevel")} AS metadata_sub_tool_level,
  ${SQL_JSON_TEXT_FIELD("approvalId")} AS metadata_approval_id,
  ${SQL_JSON_TEXT_FIELD("decision")} AS metadata_decision,
  ${SQL_JSON_TEXT_FIELD("command")} AS metadata_command,
  ${SQL_JSON_TEXT_FIELD("modelName")} AS metadata_model_name,
  ${SQL_JSON_INTEGER_FIELD("totalTokens")} AS metadata_total_tokens,
  ${SQL_JSON_INTEGER_FIELD("maxTokens")} AS metadata_max_tokens,
  length(${SQL_JSON_TEXT_FIELD("details")}) AS metadata_details_length,
  CASE WHEN length(${SQL_JSON_TEXT_FIELD("details")}) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN ${SQL_JSON_TEXT_FIELD("details")}
       ELSE substr(${SQL_JSON_TEXT_FIELD("details")}, 1, ${Math.ceil(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS metadata_details_head,
  CASE WHEN length(${SQL_JSON_TEXT_FIELD("details")}) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN '' ELSE substr(${SQL_JSON_TEXT_FIELD("details")}, -${Math.floor(
         UI_MESSAGE_LIST_FIELD_LIMIT / 2,
       )}) END AS metadata_details_tail,
  ${SQL_JSON_TEXT_FIELD("inputKind")} AS metadata_input_kind,
  CASE WHEN length(CAST(${SQL_JSON_ARRAY_FIELD("inputImages")} AS TEXT)) <= ${UI_MESSAGE_LIST_FIELD_LIMIT}
       THEN CAST(${SQL_JSON_ARRAY_FIELD("inputImages")} AS TEXT) END AS metadata_input_images_json,
  length(CAST(${SQL_JSON_ARRAY_FIELD("inputImages")} AS TEXT)) AS metadata_input_images_length,
  ${SQL_JSON_TEXT_FIELD("compactionBoundaryTargetBackendMessageId")} AS metadata_compaction_target,
  ${SQL_JSON_TEXT_FIELD("compactionBoundaryPreviousBackendMessageId")} AS metadata_compaction_previous,
  ${SQL_JSON_TEXT_FIELD("compactionBoundarySummaryBackendMessageId")} AS metadata_compaction_summary,
  ${SQL_JSON_INTEGER_FIELD("compactionBoundaryProtectedNormalRounds")} AS metadata_compaction_rounds`;

const SQL_GEOMETRY_BOUNDED_STRING_FIELD = (field: string): string => {
  const expression = SQL_JSON_TEXT_FIELD(field);
  const headLength = Math.ceil(UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT / 2);
  const tailLength = Math.floor(UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT / 2);
  return `CASE WHEN length(${expression}) <= ${UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT}
               THEN ${expression}
               ELSE substr(${expression}, 1, ${headLength}) || substr(${expression}, -${tailLength}) END`;
};

const SQL_GEOMETRY_METADATA_DEFERRED = [
  ...UI_MESSAGE_STRUCTURAL_METADATA_STRING_FIELDS,
  "action",
  "subToolLevel",
  "decision",
  "inputKind",
]
  .map(
    (field) =>
      `length(${SQL_JSON_TEXT_FIELD(field)}) > ${UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT}`,
  )
  .join(" OR ");

const UI_MESSAGE_GEOMETRY_COLUMNS = `
  position, ui_message_id, backend_message_id, role, message_type, content,
  timestamp, streaming,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("tabName")} AS metadata_tab_name,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("commandId")} AS metadata_command_id,
  ${SQL_JSON_INTEGER_FIELD("exitCode")} AS metadata_exit_code,
  ${SQL_JSON_TEXT_FIELD("output")} AS metadata_output,
  ${SQL_JSON_TEXT_FIELD("diff")} AS metadata_diff,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("filePath")} AS metadata_file_path,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("action")} AS metadata_action,
  ${SQL_JSON_BOOLEAN_FIELD("collapsed")} AS metadata_collapsed,
  ${SQL_JSON_BOOLEAN_FIELD("isNowait")} AS metadata_is_nowait,
  ${UI_COMMAND_OUTPUT_PROJECTION_COLUMNS},
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("toolName")} AS metadata_tool_name,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("subToolTitle")} AS metadata_sub_tool_title,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("subToolHint")} AS metadata_sub_tool_hint,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("subToolLevel")} AS metadata_sub_tool_level,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("approvalId")} AS metadata_approval_id,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("decision")} AS metadata_decision,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("command")} AS metadata_command,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("modelName")} AS metadata_model_name,
  ${SQL_JSON_INTEGER_FIELD("totalTokens")} AS metadata_total_tokens,
  ${SQL_JSON_INTEGER_FIELD("maxTokens")} AS metadata_max_tokens,
  ${SQL_JSON_TEXT_FIELD("details")} AS metadata_details,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("inputKind")} AS metadata_input_kind,
  CASE WHEN json_valid(metadata_json)
             AND json_type(metadata_json, '$.inputImages') = 'array'
       THEN json_array_length(metadata_json, '$.inputImages') ELSE 0 END AS metadata_input_image_count,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("compactionBoundaryTargetBackendMessageId")} AS metadata_compaction_target,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("compactionBoundaryPreviousBackendMessageId")} AS metadata_compaction_previous,
  ${SQL_GEOMETRY_BOUNDED_STRING_FIELD("compactionBoundarySummaryBackendMessageId")} AS metadata_compaction_summary,
  ${SQL_JSON_INTEGER_FIELD("compactionBoundaryProtectedNormalRounds")} AS metadata_compaction_rounds,
  CASE WHEN ${SQL_GEOMETRY_METADATA_DEFERRED} THEN 1 ELSE 0 END AS metadata_deferred`;

export const projectUiMessageForList = (message: ChatMessage): ChatMessage => {
  const deferredFields: DeferredUiMessageField[] = Array.from(
    new Set(message.deferredPayload?.fields || []),
  );
  const defer = (field: DeferredUiMessageField): void => {
    if (!deferredFields.includes(field)) deferredFields.push(field);
  };
  const boundedContent = createBoundedListPreview(message.content);
  if (boundedContent !== message.content) defer("content");

  let metadata = sanitizeUiMessageMetadata(message.metadata);
  if (metadata) {
    for (const field of ["output", "diff", "details"] as const) {
      const current = metadata[field];
      if (typeof current !== "string") continue;
      const bounded = createBoundedListPreview(current);
      if (bounded !== current) {
        metadata[field] = bounded;
        defer(field);
      }
    }
    for (const field of UI_MESSAGE_STRUCTURAL_METADATA_STRING_FIELDS) {
      const current = metadata[field];
      if (typeof current !== "string") continue;
      const bounded = createBoundedListPreview(current);
      if (bounded !== current) {
        metadata[field] = bounded as never;
        defer("metadata");
      }
    }
    const commandOutput = parseCommandOutputContractV1(metadata.commandOutput);
    if (commandOutput) {
      metadata.commandOutput = commandOutput;
    } else {
      delete metadata.commandOutput;
    }
    if (Array.isArray(metadata.inputImages)) {
      let serializedImagesLength = Number.POSITIVE_INFINITY;
      try {
        serializedImagesLength = JSON.stringify(metadata.inputImages).length;
      } catch {
        // Cyclic or otherwise non-serializable attachment metadata is deferred.
      }
      if (serializedImagesLength > UI_MESSAGE_LIST_FIELD_LIMIT) {
        delete metadata.inputImages;
        defer("inputImages");
      }
    }
  }

  return {
    ...message,
    content: boundedContent,
    metadata,
    ...(deferredFields.length > 0
      ? { deferredPayload: { fields: deferredFields } }
      : {}),
  };
};

const serializeUiMessageMetadata = (message: ChatMessage): string | null =>
  message.metadata ? JSON.stringify(message.metadata) : null;

const isStoredCompactionMarker = (message: StoredChatMessageRecord): boolean =>
  message.data?.data?.additional_kwargs?.last_compaction === true ||
  message.data?.additional_kwargs?.last_compaction === true;

const mapStoredChatMessageRow = (
  message: ChatSessionMessageRow,
): StoredChatMessageRecord => ({
  id: message.message_id,
  type: message.message_type,
  data: JSON.parse(message.message_data_json),
});

const createGeometryPreview = (
  value: string,
): { value: string; deferred: boolean } => {
  if (value.length <= UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT) {
    return { value, deferred: false };
  }
  const head = Math.ceil(UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT / 2);
  const tail = Math.floor(UI_MESSAGE_GEOMETRY_PREVIEW_LIMIT / 2);
  return {
    // Keep the bounded geometry projection textually silent, matching the
    // existing list projection contract. The full field is loaded on demand.
    value: `${sliceFromStartAtUnicodeBoundary(value, head)}${sliceFromEndAtUnicodeBoundary(value, tail)}`,
    deferred: true,
  };
};

const readGeometryMetadata = (
  row: UiSessionMessageGeometryRow,
): {
  metadata?: ChatMessageGeometryMetadata;
  output: string;
  diff: string;
  details: string;
  inputImageCount: number;
  deferred: boolean;
} => {
  const output = extractCommandOutputDisplayText(
    typeof row.metadata_output === "string" ? row.metadata_output : "",
  );
  const diff =
    typeof row.metadata_diff === "string" ? row.metadata_diff : "";
  const details =
    typeof row.metadata_details === "string" ? row.metadata_details : "";
  const inputImageCount = Math.max(
    0,
    Math.floor(Number(row.metadata_input_image_count || 0)),
  );
  const metadata: ChatMessageGeometryMetadata = {};
  let deferred = row.metadata_deferred === 1;
  const assignBoundedString = <
    K extends keyof ChatMessageGeometryMetadata,
  >(
    key: K,
    value: unknown,
  ): void => {
    if (typeof value !== "string" || value.length === 0) return;
    const bounded = createGeometryPreview(value);
    metadata[key] = bounded.value as ChatMessageGeometryMetadata[K];
    deferred ||= bounded.deferred;
  };
  assignBoundedString("tabName", row.metadata_tab_name);
  assignBoundedString("commandId", row.metadata_command_id);
  assignBoundedString("filePath", row.metadata_file_path);
  assignBoundedString("toolName", row.metadata_tool_name);
  assignBoundedString("subToolTitle", row.metadata_sub_tool_title);
  assignBoundedString("subToolHint", row.metadata_sub_tool_hint);
  assignBoundedString("approvalId", row.metadata_approval_id);
  assignBoundedString("command", row.metadata_command);
  assignBoundedString("modelName", row.metadata_model_name);
  assignBoundedString(
    "compactionBoundaryTargetBackendMessageId",
    row.metadata_compaction_target,
  );
  assignBoundedString(
    "compactionBoundaryPreviousBackendMessageId",
    row.metadata_compaction_previous,
  );
  assignBoundedString(
    "compactionBoundarySummaryBackendMessageId",
    row.metadata_compaction_summary,
  );

  if (Number.isSafeInteger(row.metadata_exit_code)) {
    metadata.exitCode = Number(row.metadata_exit_code);
  }
  if (typeof row.metadata_collapsed === "boolean") {
    metadata.collapsed = row.metadata_collapsed;
  } else if (row.metadata_collapsed === 0 || row.metadata_collapsed === 1) {
    metadata.collapsed = Boolean(row.metadata_collapsed);
  }
  if (typeof row.metadata_is_nowait === "boolean") {
    metadata.isNowait = row.metadata_is_nowait;
  } else if (row.metadata_is_nowait === 0 || row.metadata_is_nowait === 1) {
    metadata.isNowait = Boolean(row.metadata_is_nowait);
  }
  if (
    row.metadata_action === "created" ||
    row.metadata_action === "edited" ||
    row.metadata_action === "error"
  ) {
    metadata.action = row.metadata_action;
  }
  if (
    row.metadata_sub_tool_level === "info" ||
    row.metadata_sub_tool_level === "warning" ||
    row.metadata_sub_tool_level === "error"
  ) {
    metadata.subToolLevel = row.metadata_sub_tool_level;
  }
  if (
    row.metadata_decision === "allow" ||
    row.metadata_decision === "deny"
  ) {
    metadata.decision = row.metadata_decision;
  }
  if (
    row.metadata_input_kind === "normal" ||
    row.metadata_input_kind === "inserted"
  ) {
    metadata.inputKind = row.metadata_input_kind;
  }
  for (const [key, value] of [
    ["totalTokens", row.metadata_total_tokens],
    ["maxTokens", row.metadata_max_tokens],
    [
      "compactionBoundaryProtectedNormalRounds",
      row.metadata_compaction_rounds,
    ],
  ] as const) {
    if (Number.isSafeInteger(value) && Number(value) >= 0) {
      metadata[key] = Number(value);
    }
  }
  const commandOutput = readProjectedCommandOutput(row);
  if (commandOutput) metadata.commandOutput = commandOutput;
  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    output,
    diff,
    details,
    inputImageCount,
    deferred,
  };
};

const createUiMessageGeometryEntry = (
  row: UiSessionMessageGeometryRow,
): UiMessageGeometryEntry => {
  const metadata = readGeometryMetadata(row);
  const needsContent =
    row.message_type !== "tokens_count" &&
    row.message_type !== "compaction_boundary";
  const needsOutput = UI_GEOMETRY_OUTPUT_MESSAGE_TYPES.has(row.message_type);
  const needsDiff = row.message_type === "file_edit";
  const needsDetails = row.message_type === "error";
  const contentPreview = createGeometryPreview(needsContent ? row.content : "");
  const outputPreview = createGeometryPreview(
    needsOutput ? metadata.output : "",
  );
  const diffPreview = createGeometryPreview(needsDiff ? metadata.diff : "");
  const detailsPreview = createGeometryPreview(
    needsDetails ? metadata.details : "",
  );
  const deferredFields: ChatGeometryDeferredField[] = [];
  if (contentPreview.deferred) deferredFields.push("content");
  if (outputPreview.deferred) deferredFields.push("output");
  if (diffPreview.deferred) deferredFields.push("diff");
  if (detailsPreview.deferred) deferredFields.push("details");
  if (metadata.inputImageCount > 0) deferredFields.push("inputImages");
  if (metadata.deferred) deferredFields.push("metadata");
  const projection: ChatMessageGeometryProjection = {
    content: contentPreview.value,
    ...(outputPreview.value ? { output: outputPreview.value } : {}),
    ...(diffPreview.value ? { diff: diffPreview.value } : {}),
    ...(detailsPreview.value ? { details: detailsPreview.value } : {}),
    ...(deferredFields.length > 0 ? { deferredFields } : {}),
  };
  return {
    position: Number(row.position),
    id: row.ui_message_id,
    ...(row.backend_message_id
      ? { backendMessageId: row.backend_message_id }
      : {}),
    role: row.role,
    type: row.message_type,
    timestamp: row.timestamp,
    streaming: Boolean(row.streaming),
    ...(metadata.metadata ? { metadata: metadata.metadata } : {}),
    geometry: {
      contentShape: needsContent
        ? createChatTextGeometryShape(row.content)
        : { lineBuckets: [], blankLineCount: 1 },
      ...(needsOutput && metadata.output
        ? { outputShape: createChatTextGeometryShape(metadata.output) }
        : {}),
      ...(needsDiff && metadata.diff
        ? { diffShape: createChatTextGeometryShape(metadata.diff) }
        : {}),
      ...(needsDetails && metadata.details
        ? { detailsShape: createChatTextGeometryShape(metadata.details) }
        : {}),
      inputImageCount: metadata.inputImageCount,
    },
    projection,
  };
};

export class HistorySqliteStore {
  private readonly filePath: string;
  private readonly db: DatabaseHandle;
  constructor(options?: HistorySqliteStoreOptions) {
    this.filePath =
      options?.filePath || resolveHistoryStoragePaths().sqliteDbPath;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = openBetterSqlite3Database(this.filePath);
    HistorySqliteStore.initializeDatabase(this.db);
  }

  static initializeDatabase(db: DatabaseHandle): void {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma("cache_size = -32000");

    db.exec(`
      CREATE TABLE IF NOT EXISTS history_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        last_checkpoint_offset INTEGER NOT NULL DEFAULT 0,
        last_profile_max_tokens INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_data_json TEXT NOT NULL,
        is_compaction_marker INTEGER,
        PRIMARY KEY (session_id, position),
        UNIQUE (session_id, message_id),
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_session_messages_session_id
      ON chat_session_messages(session_id, position);

      CREATE TABLE IF NOT EXISTS ui_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        messages_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT '',
        ui_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS ui_session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        ui_message_id TEXT NOT NULL,
        backend_message_id TEXT,
        role TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        timestamp INTEGER NOT NULL,
        streaming INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, position),
        UNIQUE (ui_message_id),
        FOREIGN KEY (session_id) REFERENCES ui_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ui_session_messages_session_id
      ON ui_session_messages(session_id, position);

      CREATE INDEX IF NOT EXISTS idx_ui_session_messages_backend_message
      ON ui_session_messages(session_id, backend_message_id);

      CREATE INDEX IF NOT EXISTS idx_ui_sessions_updated_at
      ON ui_sessions(updated_at DESC);
    `);

    const chatMessageColumns = db.pragma(
      "table_info(chat_session_messages)",
    ) as Array<{ name: string }>;
    if (
      !chatMessageColumns.some(
        (column) => column.name === "is_compaction_marker",
      )
    ) {
      db.exec(
        "ALTER TABLE chat_session_messages ADD COLUMN is_compaction_marker INTEGER",
      );
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_session_messages_compaction
      ON chat_session_messages(session_id, is_compaction_marker, position);
    `);

    const uiSessionColumns = db.pragma("table_info(ui_sessions)") as Array<{
      name: string;
    }>;
    if (!uiSessionColumns.some((column) => column.name === "ui_revision")) {
      db.exec(
        "ALTER TABLE ui_sessions ADD COLUMN ui_revision INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  static hasInitializedStore(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const db = openBetterSqlite3Database(filePath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('history_meta', 'chat_sessions', 'ui_sessions')
           LIMIT 1`,
        )
        .get() as { name: string } | undefined;
      return Boolean(row?.name);
    } finally {
      db.close();
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  close(): void {
    this.db.close();
  }

  getMaxUiRevision(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(ui_revision), 0) AS value FROM ui_sessions")
      .get() as { value: number };
    return Math.max(0, Math.floor(Number(row?.value || 0)));
  }

  updateUiSessionRevision(sessionId: string, uiRevision: number): boolean {
    sessionId = requireHistorySessionId(sessionId);
    const normalizedRevision = Math.max(0, Math.floor(uiRevision));
    const result = this.db
      .prepare(
        `UPDATE ui_sessions
         SET ui_revision = MAX(ui_revision, ?)
         WHERE id = ?`,
      )
      .run(normalizedRevision, sessionId);
    return result.changes > 0;
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM history_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO history_meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  loadChatSession(sessionId: string): StoredChatSessionRecord | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const row = this.db
      .prepare(
        `SELECT id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
         FROM chat_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as ChatSessionRow | undefined;
    if (!row || row.id !== sessionId) {
      return null;
    }

    const messageRows = this.db
      .prepare(
        `SELECT message_id, message_type, message_data_json
         FROM chat_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(sessionId) as ChatSessionMessageRow[];

    return {
      id: row.id,
      title: row.title,
      messages: messageRows.map(mapStoredChatMessageRow),
      lastCheckpointOffset: row.last_checkpoint_offset,
      lastProfileMaxTokens: row.last_profile_max_tokens ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  loadChatSessionHeader(sessionId: string): StoredChatSessionHeader | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const row = this.db
      .prepare(
        `SELECT chat.id, chat.title, chat.last_checkpoint_offset,
                chat.last_profile_max_tokens, chat.created_at, chat.updated_at,
                COUNT(messages.message_id) AS messages_count
         FROM chat_sessions AS chat
         LEFT JOIN chat_session_messages AS messages
           ON messages.session_id = chat.id
         WHERE chat.id = ?
         GROUP BY chat.id`,
      )
      .get(sessionId) as
      | (ChatSessionRow & { messages_count: number })
      | undefined;
    if (!row || row.id !== sessionId) return null;

    this.backfillChatCompactionMarkers(sessionId);
    const marker = this.db
      .prepare(
        `SELECT position, message_id
         FROM chat_session_messages
         WHERE session_id = ? AND is_compaction_marker = 1
         ORDER BY position DESC
         LIMIT 1`,
      )
      .get(sessionId) as { position: number; message_id: string } | undefined;

    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      messagesCount: row.messages_count,
      lastCheckpointOffset: row.last_checkpoint_offset,
      lastProfileMaxTokens: row.last_profile_max_tokens ?? undefined,
      ...(marker
        ? {
            runtimeStartPosition: marker.position,
            runtimeMarkerMessageId: marker.message_id,
          }
        : {}),
    };
  }

  loadChatSessionTail(
    sessionId: string,
    limit = 768,
  ): {
    messages: StoredChatMessageRecord[];
    startPosition: number;
    totalCount: number;
  } | null {
    const header = this.loadChatSessionHeader(sessionId);
    if (!header) return null;
    const safeLimit = Math.min(2_000, Math.max(1, Math.floor(limit)));
    const rows = (
      this.db
        .prepare(
          `SELECT position, message_id, message_type, message_data_json,
                  is_compaction_marker
           FROM chat_session_messages
           WHERE session_id = ?
           ORDER BY position DESC
           LIMIT ?`,
        )
        .all(sessionId, safeLimit) as ChatSessionMessageRow[]
    ).reverse();
    return {
      messages: rows.map(mapStoredChatMessageRow),
      startPosition: rows[0]?.position ?? header.messagesCount,
      totalCount: header.messagesCount,
    };
  }

  loadChatSessionMessagesFromPosition(
    sessionId: string,
    startPosition: number,
  ): StoredChatMessageRecord[] {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return [];
    sessionId = exactSessionId;
    const rows = this.db
      .prepare(
        `SELECT position, message_id, message_type, message_data_json,
                is_compaction_marker
         FROM chat_session_messages
         WHERE session_id = ? AND position >= ?
         ORDER BY position ASC`,
      )
      .all(
        sessionId,
        Math.max(0, Math.floor(startPosition)),
      ) as ChatSessionMessageRow[];
    return rows.map(mapStoredChatMessageRow);
  }

  loadLeadingChatSystemMessages(
    sessionId: string,
    beforePosition: number,
  ): StoredChatMessageRecord[] {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return [];
    sessionId = exactSessionId;
    const boundary = Math.max(0, Math.floor(beforePosition));
    if (boundary === 0) return [];

    const pageSize = 64;
    const leading: StoredChatMessageRecord[] = [];
    for (let offset = 0; offset < boundary; offset += pageSize) {
      const rows = this.db
        .prepare(
          `SELECT position, message_id, message_type, message_data_json,
                  is_compaction_marker
           FROM chat_session_messages
           WHERE session_id = ? AND position >= ? AND position < ?
           ORDER BY position ASC
           LIMIT ?`,
        )
        .all(sessionId, offset, boundary, pageSize) as ChatSessionMessageRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const message = mapStoredChatMessageRow(row);
        if (message.data?.type !== "system") return leading;
        leading.push(message);
      }
      if (rows.length < pageSize) break;
    }
    return leading;
  }

  private backfillChatCompactionMarkers(sessionId: string): void {
    const pending = this.db
      .prepare(
        `SELECT 1
         FROM chat_session_messages
         WHERE session_id = ? AND is_compaction_marker IS NULL
         LIMIT 1`,
      )
      .get(sessionId);
    if (!pending) return;

    this.db
      .prepare(
        `UPDATE chat_session_messages
         SET is_compaction_marker = CASE
           WHEN json_extract(
             message_data_json,
             '$.data.additional_kwargs.last_compaction'
           ) = 1 THEN 1
           ELSE 0
         END
         WHERE session_id = ? AND is_compaction_marker IS NULL`,
      )
      .run(sessionId);
  }

  listChatSessionSummaries(): ChatSessionSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT chat.id, chat.title, chat.updated_at, chat.created_at,
                chat.last_checkpoint_offset, chat.last_profile_max_tokens,
                COUNT(messages.message_id) AS messages_count
         FROM chat_sessions AS chat
         LEFT JOIN chat_session_messages AS messages
           ON messages.session_id = chat.id
         GROUP BY chat.id
         ORDER BY chat.updated_at DESC`,
      )
      .all() as Array<
      ChatSessionRow & {
        messages_count: number;
      }
    >;

    return rows
      .filter((row) => readHistorySessionId(row.id) !== undefined)
      .map((row) => this.toChatSessionSummary(row));
  }

  loadChatSessionSummary(sessionId: string): ChatSessionSummaryRecord | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    // Counting through a correlated subquery keeps this on the session index
    // instead of aggregating every message row like the list query does.
    const row = this.db
      .prepare(
        `SELECT chat.id, chat.title, chat.updated_at, chat.created_at,
                chat.last_checkpoint_offset, chat.last_profile_max_tokens,
                (SELECT COUNT(*)
                   FROM chat_session_messages AS messages
                  WHERE messages.session_id = chat.id) AS messages_count
         FROM chat_sessions AS chat
         WHERE chat.id = ?`,
      )
      .get(sessionId) as
      | (ChatSessionRow & { messages_count: number })
      | undefined;

    return row?.id === sessionId ? this.toChatSessionSummary(row) : null;
  }

  private toChatSessionSummary(
    row: ChatSessionRow & { messages_count: number },
  ): ChatSessionSummaryRecord {
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      messagesCount: row.messages_count,
      lastCheckpointOffset: row.last_checkpoint_offset,
      lastProfileMaxTokens: row.last_profile_max_tokens ?? undefined,
    };
  }

  listChatSessions(): StoredChatSessionRecord[] {
    return this.listChatSessionSummaries()
      .map((summary) => this.loadChatSession(summary.id))
      .filter(
        (session): session is StoredChatSessionRecord => session !== null,
      );
  }

  saveChatSession(session: StoredChatSessionRecord): void {
    requireHistorySessionId(session?.id);
    this.saveChatSessionWindow(session);
  }

  mergeChatSessionTranscript(session: StoredChatSessionRecord): void {
    requireHistorySessionId(session?.id);
    const existingRows = this.db
      .prepare(
        `SELECT position, message_id
         FROM chat_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(session.id) as Array<{ position: number; message_id: string }>;
    const positionById = new Map(
      existingRows.map((row) => [row.message_id, row.position] as const),
    );
    const incomingIds = session.messages.map((message) => message.id);
    const incomingById = new Map(
      session.messages.map((message) => [message.id, message] as const),
    );

    const upsertSession = this.db.prepare(
      `INSERT INTO chat_sessions (
         id, title, last_checkpoint_offset, last_profile_max_tokens,
         created_at, updated_at
       ) VALUES (
         @id, @title, @lastCheckpointOffset, @lastProfileMaxTokens,
         @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         last_checkpoint_offset = excluded.last_checkpoint_offset,
         last_profile_max_tokens = excluded.last_profile_max_tokens,
         updated_at = excluded.updated_at`,
    );
    const updateIncomingMessage = this.db.prepare(
      `UPDATE chat_session_messages
       SET message_type = ?, message_data_json = ?, is_compaction_marker = ?
       WHERE session_id = ? AND message_id = ?`,
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO chat_session_messages (
         session_id, position, message_id, message_type, message_data_json,
         is_compaction_marker
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      const existingCreatedAt = this.db
        .prepare("SELECT created_at FROM chat_sessions WHERE id = ?")
        .get(session.id) as { created_at: number } | undefined;
      upsertSession.run({
        id: session.id,
        title: session.title,
        lastCheckpointOffset: session.lastCheckpointOffset,
        lastProfileMaxTokens: session.lastProfileMaxTokens ?? null,
        createdAt: existingCreatedAt?.created_at ?? session.createdAt,
        updatedAt: session.updatedAt,
      });

      let incomingIndex = 0;
      while (incomingIndex < incomingIds.length) {
        const currentId = incomingIds[incomingIndex];
        if (positionById.has(currentId)) {
          incomingIndex += 1;
          continue;
        }

        const missingIds: string[] = [];
        while (
          incomingIndex < incomingIds.length &&
          !positionById.has(incomingIds[incomingIndex])
        ) {
          const id = incomingIds[incomingIndex];
          if (id && !missingIds.includes(id)) missingIds.push(id);
          incomingIndex += 1;
        }
        if (missingIds.length === 0) continue;

        const nextKnownId = incomingIds[incomingIndex];
        const nextKnownPosition = nextKnownId
          ? positionById.get(nextKnownId)
          : undefined;
        let insertionPosition: number;
        if (nextKnownPosition !== undefined) {
          insertionPosition = nextKnownPosition;
        } else {
          let previousKnownPosition: number | undefined;
          for (
            let previous = incomingIndex - missingIds.length - 1;
            previous >= 0;
            previous -= 1
          ) {
            const candidatePosition = positionById.get(incomingIds[previous]);
            if (candidatePosition !== undefined) {
              previousKnownPosition = candidatePosition;
              break;
            }
          }
          insertionPosition =
            previousKnownPosition !== undefined
              ? previousKnownPosition + 1
              : positionById.size;
        }

        this.shiftChatMessagePositions(
          session.id,
          insertionPosition,
          missingIds.length,
        );
        for (const [messageId, position] of positionById) {
          if (position >= insertionPosition) {
            positionById.set(messageId, position + missingIds.length);
          }
        }
        missingIds.forEach((messageId, offset) => {
          const message = incomingById.get(messageId);
          if (!message) return;
          const position = insertionPosition + offset;
          insertMessage.run(
            session.id,
            position,
            message.id,
            message.type,
            JSON.stringify(message.data),
            isStoredCompactionMarker(message) ? 1 : 0,
          );
          positionById.set(message.id, position);
        });
      }

      for (const message of session.messages) {
        updateIncomingMessage.run(
          message.type,
          JSON.stringify(message.data),
          isStoredCompactionMarker(message) ? 1 : 0,
          session.id,
          message.id,
        );
      }
    })();
  }

  private shiftChatMessagePositions(
    sessionId: string,
    startPosition: number,
    amount: number,
  ): void {
    if (amount <= 0) return;
    this.db
      .prepare(
        `UPDATE chat_session_messages
         SET position = -position - 1
         WHERE session_id = ? AND position >= ?`,
      )
      .run(sessionId, startPosition);
    this.db
      .prepare(
        `UPDATE chat_session_messages
         SET position = -position + ?
         WHERE session_id = ? AND position < 0`,
      )
      .run(amount - 1, sessionId);
  }

  saveChatSessionWindow(
    session: StoredChatSessionRecord,
    options?: {
      startPosition?: number;
      leadingMessages?: StoredChatMessageRecord[];
    },
  ): void {
    requireHistorySessionId(session?.id);
    const existingCreatedAt = this.db
      .prepare("SELECT created_at FROM chat_sessions WHERE id = ?")
      .get(session.id) as { created_at: number } | undefined;
    const createdAt = existingCreatedAt?.created_at ?? session.createdAt;
    const requestedStartPosition = options?.startPosition;
    const startPosition =
      typeof requestedStartPosition === "number" &&
      Number.isFinite(requestedStartPosition)
        ? Math.max(0, Math.floor(requestedStartPosition))
        : 0;

    const upsertSession = this.db.prepare(
      `INSERT INTO chat_sessions (
         id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
       ) VALUES (
         @id, @title, @lastCheckpointOffset, @lastProfileMaxTokens, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         last_checkpoint_offset = excluded.last_checkpoint_offset,
         last_profile_max_tokens = excluded.last_profile_max_tokens,
         updated_at = excluded.updated_at`,
    );
    const deleteMessages = this.db.prepare(
      `DELETE FROM chat_session_messages
       WHERE session_id = ? AND position >= ?`,
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO chat_session_messages (
         session_id, position, message_id, message_type, message_data_json,
         is_compaction_marker
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const updateLeadingMessage = this.db.prepare(
      `UPDATE chat_session_messages
       SET message_type = ?, message_data_json = ?, is_compaction_marker = ?
       WHERE session_id = ? AND message_id = ?`,
    );

    this.db.transaction(() => {
      upsertSession.run({
        id: session.id,
        title: session.title,
        lastCheckpointOffset: session.lastCheckpointOffset,
        lastProfileMaxTokens: session.lastProfileMaxTokens ?? null,
        createdAt,
        updatedAt: session.updatedAt,
      });
      for (const message of options?.leadingMessages || []) {
        updateLeadingMessage.run(
          message.type,
          JSON.stringify(message.data),
          isStoredCompactionMarker(message) ? 1 : 0,
          session.id,
          message.id,
        );
      }
      deleteMessages.run(session.id, startPosition);
      session.messages.forEach((message, index) => {
        insertMessage.run(
          session.id,
          startPosition + index,
          message.id,
          message.type,
          JSON.stringify(message.data),
          isStoredCompactionMarker(message) ? 1 : 0,
        );
      });
    })();
  }

  loadChatMessagesByIds(
    sessionId: string,
    messageIds: string[],
  ): StoredChatMessageRecord[] {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return [];
    sessionId = exactSessionId;
    const ids = Array.from(new Set(messageIds.filter(Boolean)));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT position, message_id, message_type, message_data_json,
                is_compaction_marker
         FROM chat_session_messages
         WHERE session_id = ? AND message_id IN (${placeholders})
         ORDER BY position ASC`,
      )
      .all(sessionId, ...ids) as ChatSessionMessageRow[];
    return rows.map(mapStoredChatMessageRow);
  }

  updateChatMessage(
    sessionId: string,
    message: StoredChatMessageRecord,
    updatedAt: number,
  ): boolean {
    sessionId = requireHistorySessionId(sessionId);
    const result = this.db
      .prepare(
        `UPDATE chat_session_messages
         SET message_type = ?, message_data_json = ?, is_compaction_marker = ?
         WHERE session_id = ? AND message_id = ?`,
      )
      .run(
        message.type,
        JSON.stringify(message.data),
        isStoredCompactionMarker(message) ? 1 : 0,
        sessionId,
        message.id,
      );
    if (result.changes === 0) return false;
    this.db
      .prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?")
      .run(updatedAt, sessionId);
    return true;
  }

  deleteChatSessions(sessionIds: string[]): void {
    const ids = requireHistorySessionIds(sessionIds);
    if (ids.length === 0) return;
    const deleteSession = this.db.prepare(
      "DELETE FROM chat_sessions WHERE id = ?",
    );
    this.db.transaction(() => {
      ids.forEach((id) => deleteSession.run(id));
    })();
  }

  clearChatSessions(): void {
    this.db.prepare("DELETE FROM chat_sessions").run();
  }

  renameChatSession(
    sessionId: string,
    newTitle: string,
    updatedAt: number,
  ): void {
    sessionId = requireHistorySessionId(sessionId);
    this.db
      .prepare(
        `INSERT INTO chat_sessions (
           id, title, last_checkpoint_offset, last_profile_max_tokens, created_at, updated_at
         ) VALUES (?, ?, 0, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, newTitle, updatedAt, updatedAt);
  }

  loadUiSession(sessionId: string): UIChatSession | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const row = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview,
                ui_revision
         FROM ui_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as UiSessionRow | undefined;
    if (!row || row.id !== sessionId) {
      return null;
    }

    const messageRows = this.db
      .prepare(
        `SELECT ui_message_id, backend_message_id, role, message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE session_id = ?
         ORDER BY position ASC`,
      )
      .all(sessionId) as UiSessionMessageRow[];

    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      uiRevision: row.ui_revision,
      messages: messageRows.map<ChatMessage>((message) => ({
        id: message.ui_message_id,
        backendMessageId: message.backend_message_id ?? undefined,
        role: message.role,
        type: message.message_type,
        content: message.content,
        metadata: parseUiMessageMetadata(message.metadata_json),
        timestamp: message.timestamp,
        streaming: Boolean(message.streaming),
      })),
    };
  }

  loadUiSessionTail(
    sessionId: string,
    limit = UI_MESSAGE_PAGE_DEFAULT_LIMIT,
  ): {
    session: UIChatSession;
    startPosition: number;
    totalCount: number;
  } | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const row = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview,
                ui_revision
         FROM ui_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as UiSessionRow | undefined;
    if (!row || row.id !== sessionId) return null;
    const safeLimit = normalizePageLimit(limit);
    const rows = (
      this.db
        .prepare(
          `SELECT ${UI_MESSAGE_LIST_COLUMNS}
           FROM ui_session_messages
           WHERE session_id = ?
           ORDER BY position DESC
           LIMIT ?`,
        )
        .all(sessionId, safeLimit) as UiSessionMessageProjectionRow[]
    ).reverse();
    return {
      session: {
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        uiRevision: row.ui_revision,
        messages: rows.map(parseUiMessageProjectionRow),
      },
      startPosition:
        rows.length > 0
          ? Number(rows[0].position)
          : Math.max(0, row.messages_count),
      totalCount: row.messages_count,
    };
  }

  getUiSessionSummary(sessionId: string): UISessionSummaryRecord | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const row = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview,
                ui_revision
         FROM ui_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as UiSessionRow | undefined;
    if (!row || row.id !== sessionId) return null;
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      messagesCount: row.messages_count,
      lastMessagePreview: row.last_message_preview,
      uiRevision: row.ui_revision,
    };
  }

  loadUiMessagePage(
    sessionId: string,
    request?: UiMessagePageRequest,
  ): UiMessagePage | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const summary = this.db
      .prepare(
        `SELECT id, messages_count, ui_revision
         FROM ui_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as
      | Pick<UiSessionRow, "id" | "messages_count" | "ui_revision">
      | undefined;
    if (!summary || summary.id !== sessionId) return null;

    const limit = normalizePageLimit(request?.limit);
    let rows: UiSessionMessageProjectionRow[];
    if (
      typeof request?.aroundPosition === "number" &&
      Number.isFinite(request.aroundPosition)
    ) {
      const center = Math.max(0, Math.floor(request.aroundPosition));
      const start = Math.max(0, center - Math.floor(limit / 2));
      rows = this.db
        .prepare(
          `SELECT ${UI_MESSAGE_LIST_COLUMNS}
           FROM ui_session_messages
           WHERE session_id = ? AND position >= ?
           ORDER BY position ASC
           LIMIT ?`,
        )
        .all(sessionId, start, limit) as UiSessionMessageProjectionRow[];
    } else if (
      typeof request?.beforePosition === "number" &&
      Number.isFinite(request.beforePosition)
    ) {
      const before = Math.max(0, Math.floor(request.beforePosition));
      rows = (
        this.db
          .prepare(
            `SELECT ${UI_MESSAGE_LIST_COLUMNS}
             FROM ui_session_messages
             WHERE session_id = ? AND position < ?
             ORDER BY position DESC
             LIMIT ?`,
          )
          .all(sessionId, before, limit) as UiSessionMessageProjectionRow[]
      ).reverse();
    } else if (
      typeof request?.afterPosition === "number" &&
      Number.isFinite(request.afterPosition)
    ) {
      const after = Math.floor(request.afterPosition);
      rows = this.db
        .prepare(
          `SELECT ${UI_MESSAGE_LIST_COLUMNS}
           FROM ui_session_messages
           WHERE session_id = ? AND position > ?
           ORDER BY position ASC
           LIMIT ?`,
        )
        .all(sessionId, after, limit) as UiSessionMessageProjectionRow[];
    } else {
      rows = (
        this.db
          .prepare(
            `SELECT ${UI_MESSAGE_LIST_COLUMNS}
             FROM ui_session_messages
             WHERE session_id = ?
             ORDER BY position DESC
             LIMIT ?`,
          )
          .all(sessionId, limit) as UiSessionMessageProjectionRow[]
      ).reverse();
    }

    const entries: PositionedUiMessage[] = rows.map((row) => ({
      position: Number(row.position),
      message: parseUiMessageProjectionRow(row),
    }));
    const startPosition = entries[0]?.position ?? null;
    const endPosition = entries[entries.length - 1]?.position ?? null;
    return {
      sessionId,
      entries,
      totalCount: summary.messages_count,
      startPosition,
      endPosition,
      hasOlder: startPosition !== null && startPosition > 0,
      hasNewer:
        endPosition !== null && endPosition < summary.messages_count - 1,
      uiRevision: summary.ui_revision,
    };
  }

  loadUiMessageGeometryIndex(sessionId: string): UiMessageGeometryIndex | null {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return null;
    sessionId = exactSessionId;
    const summary = this.db
      .prepare(
        `SELECT messages_count, ui_revision
         FROM ui_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as
      | { messages_count: number; ui_revision: number }
      | undefined;
    if (!summary) return null;

    const entries: UiMessageGeometryEntry[] = [];
    const statement = this.db.prepare(
      `SELECT ${UI_MESSAGE_GEOMETRY_COLUMNS}
       FROM ui_session_messages
       WHERE session_id = ?
       ORDER BY position ASC`,
    );
    for (const row of statement.iterate(
      sessionId,
    ) as Iterable<UiSessionMessageGeometryRow>) {
      entries.push(createUiMessageGeometryEntry(row));
    }
    const index: UiMessageGeometryIndex = {
      sessionId,
      entries,
      totalCount: Math.max(summary.messages_count, entries.length),
      uiRevision: Math.max(0, Math.floor(Number(summary.ui_revision || 0))),
    };
    return index;
  }

  loadUiMessagesByIds(sessionId: string, messageIds: string[]): ChatMessage[] {
    const exactSessionId = readHistorySessionId(sessionId);
    if (exactSessionId === undefined) return [];
    sessionId = exactSessionId;
    const ids = Array.from(new Set(messageIds.filter(Boolean)));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT position, ui_message_id, backend_message_id, role,
                message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE session_id = ? AND ui_message_id IN (${placeholders})
         ORDER BY position ASC`,
      )
      .all(sessionId, ...ids) as UiSessionMessageRow[];
    return rows.map(parseUiMessageRow);
  }

  loadUiMessageByBackendId(
    sessionId: string,
    backendMessageId: string,
  ): PositionedUiMessage | null {
    const row = this.db
      .prepare(
        `SELECT position, ui_message_id, backend_message_id, role,
                message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE session_id = ? AND backend_message_id = ?
         ORDER BY position DESC
         LIMIT 1`,
      )
      .get(sessionId, backendMessageId) as UiSessionMessageRow | undefined;
    if (!row) return null;
    return {
      position: Number(row.position),
      message: parseUiMessageRow(row),
    };
  }

  loadUiMessageByCommandId(
    sessionId: string,
    commandId: string,
  ): PositionedUiMessage | null {
    const row = this.db
      .prepare(
        `SELECT position, ui_message_id, backend_message_id, role,
                message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE session_id = ?
           AND json_extract(metadata_json, '$.commandId') = ?
         ORDER BY position DESC
         LIMIT 1`,
      )
      .get(sessionId, commandId) as UiSessionMessageRow | undefined;
    if (!row) return null;
    return {
      position: Number(row.position),
      message: parseUiMessageRow(row),
    };
  }

  hasUiUserMessage(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM ui_session_messages
           WHERE session_id = ? AND role = 'user'
           LIMIT 1`,
        )
        .get(sessionId),
    );
  }

  loadUiMessage(
    sessionId: string,
    messageId: string,
  ): PositionedUiMessage | null {
    const row = this.db
      .prepare(
        `SELECT position, ui_message_id, backend_message_id, role,
                message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE session_id = ? AND ui_message_id = ?`,
      )
      .get(sessionId, messageId) as UiSessionMessageRow | undefined;
    if (!row) return null;
    return {
      position: Number(row.position),
      message: parseUiMessageRow(row),
    };
  }

  deleteUiMessage(
    sessionId: string,
    messageId: string,
    updatedAt: number,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT position
         FROM ui_session_messages
         WHERE session_id = ? AND ui_message_id = ?`,
      )
      .get(sessionId, messageId) as { position: number } | undefined;
    if (!row) return false;
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM ui_session_messages
           WHERE session_id = ? AND ui_message_id = ?`,
        )
        .run(sessionId, messageId);
      this.db
        .prepare(
          `UPDATE ui_session_messages
           SET position = position - 1
           WHERE session_id = ? AND position > ?`,
        )
        .run(sessionId, row.position);
      this.db
        .prepare(
          `UPDATE ui_sessions
           SET updated_at = ?, messages_count = MAX(0, messages_count - 1)
           WHERE id = ?`,
        )
        .run(updatedAt, sessionId);
    })();
    return true;
  }

  updateUiMessage(
    sessionId: string,
    message: ChatMessage,
    updatedAt: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE ui_session_messages
         SET backend_message_id = ?, role = ?, message_type = ?, content = ?,
             metadata_json = ?, timestamp = ?, streaming = ?
         WHERE session_id = ? AND ui_message_id = ?`,
      )
      .run(
        message.backendMessageId ?? null,
        message.role,
        message.type,
        message.content,
        serializeUiMessageMetadata(message),
        message.timestamp,
        message.streaming ? 1 : 0,
        sessionId,
        message.id,
      );
    if (result.changes === 0) return false;
    this.db
      .prepare("UPDATE ui_sessions SET updated_at = ? WHERE id = ?")
      .run(updatedAt, sessionId);
    return true;
  }

  findUiMessageByFeedbackId(
    feedbackId: string,
  ): { sessionId: string; position: number; message: ChatMessage } | null {
    const row = this.db
      .prepare(
        `SELECT session_id, position, ui_message_id, backend_message_id, role,
                message_type, content, metadata_json, timestamp, streaming
         FROM ui_session_messages
         WHERE message_type = 'ask'
           AND (
             backend_message_id = ? OR
             json_extract(metadata_json, '$.approvalId') = ?
           )
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(feedbackId, feedbackId) as
      | (UiSessionMessageRow & { session_id: string; position: number })
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      position: row.position,
      message: parseUiMessageRow(row),
    };
  }

  truncateUiSessionBeforeBackendMessage(
    sessionId: string,
    backendMessageId: string,
    updatedAt: number,
  ): { removedCount: number; remainingCount: number } | null {
    const row = this.db
      .prepare(
        `SELECT position
         FROM ui_session_messages
         WHERE session_id = ? AND backend_message_id = ?
         ORDER BY position ASC
         LIMIT 1`,
      )
      .get(sessionId, backendMessageId) as { position: number } | undefined;
    if (!row) return null;
    const currentSummary = this.getUiSessionSummary(sessionId);
    if (!currentSummary) return null;
    const remainingCount = Math.max(0, row.position);
    const removedCount = Math.max(
      0,
      currentSummary.messagesCount - remainingCount,
    );
    const lastMessage =
      remainingCount > 0
        ? (this.db
            .prepare(
            `SELECT position, ui_message_id, backend_message_id, role,
                    message_type, content, metadata_json, timestamp, streaming
             FROM ui_session_messages
             WHERE session_id = ? AND position < ?
             ORDER BY position DESC
             LIMIT 1`,
            )
            .get(sessionId, row.position) as UiSessionMessageRow | undefined)
        : undefined;
    const lastPreview = lastMessage
      ? String(
          parseUiMessageRow(lastMessage).content ||
            parseUiMessageRow(lastMessage).metadata?.output ||
            "",
        )
      : "";
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM ui_session_messages
           WHERE session_id = ? AND position >= ?`,
        )
        .run(sessionId, row.position);
      this.db
        .prepare(
          `UPDATE ui_sessions
           SET updated_at = ?, messages_count = ?, last_message_preview = ?
           WHERE id = ?`,
        )
        .run(updatedAt, remainingCount, lastPreview, sessionId);
    })();
    return { removedCount, remainingCount };
  }

  searchUiMessages(
    sessionId: string,
    query: string,
    limit = 500,
  ): UiMessageSearchResult {
    const normalizedQuery = String(query || "").trim();
    const safeLimit = Math.min(2_000, Math.max(1, Math.floor(limit || 500)));
    const uiRevision = this.getUiSessionSummary(sessionId)?.uiRevision || 0;
    if (!normalizedQuery) {
      return {
        sessionId,
        query: "",
        matches: [],
        totalMatches: 0,
        truncated: false,
        uiRevision,
      };
    }
    const escaped = normalizedQuery.replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ui_session_messages
         WHERE session_id = ?
           AND message_type = 'text'
           AND content LIKE ? ESCAPE '\\' COLLATE NOCASE`,
      )
      .get(sessionId, pattern) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT position, ui_message_id, substr(content, 1, 240) AS content
         FROM ui_session_messages
         WHERE session_id = ?
           AND message_type = 'text'
           AND content LIKE ? ESCAPE '\\' COLLATE NOCASE
         ORDER BY position ASC
         LIMIT ?`,
      )
      .all(sessionId, pattern, safeLimit) as Array<{
      position: number;
      ui_message_id: string;
      content: string;
    }>;
    const totalMatches = Number(totalRow?.count || 0);
    return {
      sessionId,
      query: normalizedQuery,
      matches: rows.map((row) => ({
        messageId: row.ui_message_id,
        position: row.position,
        preview: row.content,
      })),
      totalMatches,
      truncated: totalMatches > rows.length,
      uiRevision,
    };
  }

  listUiSessions(): UIChatSession[] {
    return this.listUiSessionSummaries()
      .map((summary) => this.loadUiSession(summary.id))
      .filter((session): session is UIChatSession => session !== null);
  }

  listUiSessionSummaries(): UISessionSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, updated_at, messages_count, last_message_preview,
                ui_revision
         FROM ui_sessions
         ORDER BY updated_at DESC`,
      )
      .all() as UiSessionRow[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      messagesCount: row.messages_count,
      lastMessagePreview: row.last_message_preview,
      uiRevision: row.ui_revision,
    }));
  }

  saveUiSessions(
    entries: Array<{ session: UIChatSession; summary: UISessionSummaryRecord }>,
  ): void {
    entries.forEach(({ session, summary }) => {
      const sessionId = requireHistorySessionId(session?.id);
      if (summary?.id !== sessionId) {
        throw new Error("UI session summary id must match the session id.");
      }
    });
    entries.forEach(({ session, summary }) => {
      this.saveUiSessionWindow(session, summary, 0);
    });
  }

  upsertUiMessagesIncremental(
    session: UIChatSession,
    summary: UISessionSummaryRecord,
    startPosition: number,
    dirtyMessageIds?: ReadonlySet<string>,
  ): boolean {
    const sessionId = requireHistorySessionId(session?.id);
    if (summary?.id !== sessionId) {
      throw new Error("UI session summary id must match the session id.");
    }
    const normalizedStart = Math.max(0, Math.floor(startPosition));
    const upsertSession = this.db.prepare(
      `INSERT INTO ui_sessions (
         id, title, updated_at, messages_count, last_message_preview, ui_revision
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         messages_count = excluded.messages_count,
         last_message_preview = excluded.last_message_preview,
         ui_revision = MAX(ui_sessions.ui_revision, excluded.ui_revision)`,
    );
    const findPosition = this.db.prepare(
      `SELECT position
       FROM ui_session_messages
       WHERE session_id = ? AND ui_message_id = ?`,
    );
    const updateMessage = this.db.prepare(
      `UPDATE ui_session_messages
       SET position = ?, backend_message_id = ?, role = ?, message_type = ?,
           content = ?, metadata_json = ?, timestamp = ?, streaming = ?
       WHERE session_id = ? AND ui_message_id = ?`,
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role,
         message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    try {
      this.db.transaction(() => {
        upsertSession.run(
          session.id,
          summary.title,
          summary.updatedAt,
          summary.messagesCount,
          summary.lastMessagePreview,
          summary.uiRevision,
        );
        const messageIndexById = new Map(
          session.messages.map(
            (message, index) => [message.id, index] as const,
          ),
        );
        const messagesToPersist =
          dirtyMessageIds !== undefined
            ? session.messages.filter((message) =>
                dirtyMessageIds.has(message.id),
              )
            : session.messages;
        messagesToPersist.forEach((message) => {
          const index = messageIndexById.get(message.id);
          if (index === undefined) return;
          const position = normalizedStart + index;
          const existing = findPosition.get(session.id, message.id) as
            | { position: number }
            | undefined;
          if (existing) {
            updateMessage.run(
              position,
              message.backendMessageId ?? null,
              message.role,
              message.type,
              message.content,
              serializeUiMessageMetadata(message),
              message.timestamp,
              message.streaming ? 1 : 0,
              session.id,
              message.id,
            );
            return;
          }
          insertMessage.run(
            session.id,
            position,
            message.id,
            message.backendMessageId ?? null,
            message.role,
            message.type,
            message.content,
            serializeUiMessageMetadata(message),
            message.timestamp,
            message.streaming ? 1 : 0,
          );
        });
      })();
      return true;
    } catch (error) {
      // A position collision means the cached tail no longer describes the
      // durable ordering (for example after rollback). The caller can safely
      // fall back to the authoritative tail rewrite transaction.
      if (String((error as any)?.code || "").startsWith("SQLITE_CONSTRAINT")) {
        return false;
      }
      throw error;
    }
  }

  appendUiSessionTail(
    session: UIChatSession,
    summary: UISessionSummaryRecord,
    startPosition: number,
  ): void {
    const sessionId = requireHistorySessionId(session?.id);
    if (summary?.id !== sessionId) {
      throw new Error("UI session summary id must match the session id.");
    }
    const normalizedStart = Math.max(0, Math.floor(startPosition));
    const upsertSession = this.db.prepare(
      `INSERT INTO ui_sessions (
         id, title, updated_at, messages_count, last_message_preview, ui_revision
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         messages_count = excluded.messages_count,
         last_message_preview = excluded.last_message_preview,
         ui_revision = MAX(ui_sessions.ui_revision, excluded.ui_revision)`,
    );
    const upsertMessage = this.db.prepare(
      `INSERT INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role,
         message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ui_message_id) DO UPDATE SET
         position = excluded.position,
         backend_message_id = excluded.backend_message_id,
         role = excluded.role,
         message_type = excluded.message_type,
         content = excluded.content,
         metadata_json = excluded.metadata_json,
         timestamp = excluded.timestamp,
         streaming = excluded.streaming`,
    );

    this.db.transaction(() => {
      upsertSession.run(
        session.id,
        summary.title,
        summary.updatedAt,
        summary.messagesCount,
        summary.lastMessagePreview,
        summary.uiRevision,
      );
      session.messages.forEach((message, index) => {
        upsertMessage.run(
          session.id,
          normalizedStart + index,
          message.id,
          message.backendMessageId ?? null,
          message.role,
          message.type,
          message.content,
          serializeUiMessageMetadata(message),
          message.timestamp,
          message.streaming ? 1 : 0,
        );
      });
    })();
  }

  saveUiSessionWindow(
    session: UIChatSession,
    summary: UISessionSummaryRecord,
    startPosition: number,
  ): void {
    const sessionId = requireHistorySessionId(session?.id);
    if (summary?.id !== sessionId) {
      throw new Error("UI session summary id must match the session id.");
    }
    const normalizedStart = Math.max(0, Math.floor(startPosition));
    const upsertSession = this.db.prepare(
      `INSERT INTO ui_sessions (
         id, title, updated_at, messages_count, last_message_preview, ui_revision
       ) VALUES (
         @id, @title, @updatedAt, @messagesCount, @lastMessagePreview, @uiRevision
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         messages_count = excluded.messages_count,
         last_message_preview = excluded.last_message_preview,
         ui_revision = MAX(ui_sessions.ui_revision, excluded.ui_revision)`,
    );
    const deleteMessages = this.db.prepare(
      `DELETE FROM ui_session_messages
       WHERE session_id = ? AND position >= ?`,
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role,
         message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      upsertSession.run({
        id: session.id,
        title: summary.title,
        updatedAt: summary.updatedAt,
        messagesCount: summary.messagesCount,
        lastMessagePreview: summary.lastMessagePreview,
        uiRevision: summary.uiRevision,
      });
      deleteMessages.run(session.id, normalizedStart);
      session.messages.forEach((message, index) => {
        insertMessage.run(
          session.id,
          normalizedStart + index,
          message.id,
          message.backendMessageId ?? null,
          message.role,
          message.type,
          message.content,
          serializeUiMessageMetadata(message),
          message.timestamp,
          message.streaming ? 1 : 0,
        );
      });
    })();
  }

  insertUiMessageRelativeToBackendId(
    sessionId: string,
    message: ChatMessage,
    anchorBackendMessageId: string,
    placement: "before" | "after",
    summary: UISessionSummaryRecord,
  ): boolean {
    sessionId = requireHistorySessionId(sessionId);
    if (summary?.id !== sessionId) {
      throw new Error("UI session summary id must match the session id.");
    }
    const anchor = this.db
      .prepare(
        `SELECT position
         FROM ui_session_messages
         WHERE session_id = ? AND backend_message_id = ?
         ORDER BY position ASC
         LIMIT 1`,
      )
      .get(sessionId, anchorBackendMessageId) as
      | { position: number }
      | undefined;
    if (!anchor) return false;
    const insertPosition = anchor.position + (placement === "after" ? 1 : 0);
    const shiftNegative = this.db.prepare(
      `UPDATE ui_session_messages
       SET position = -position - 1
       WHERE session_id = ? AND position >= ?`,
    );
    const restoreShifted = this.db.prepare(
      `UPDATE ui_session_messages
       SET position = -position
       WHERE session_id = ? AND position < 0`,
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO ui_session_messages (
         session_id, position, ui_message_id, backend_message_id, role,
         message_type, content, metadata_json, timestamp, streaming
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateSummary = this.db.prepare(
      `UPDATE ui_sessions
       SET title = ?, updated_at = ?, messages_count = ?, last_message_preview = ?,
           ui_revision = MAX(ui_revision, ?)
       WHERE id = ?`,
    );

    this.db.transaction(() => {
      shiftNegative.run(sessionId, insertPosition);
      restoreShifted.run(sessionId);
      insertMessage.run(
        sessionId,
        insertPosition,
        message.id,
        message.backendMessageId ?? null,
        message.role,
        message.type,
        message.content,
        serializeUiMessageMetadata(message),
        message.timestamp,
        message.streaming ? 1 : 0,
      );
      updateSummary.run(
        summary.title,
        summary.updatedAt,
        summary.messagesCount,
        summary.lastMessagePreview,
        summary.uiRevision,
        sessionId,
      );
    })();
    return true;
  }

  deleteUiSessions(sessionIds: string[]): void {
    const ids = requireHistorySessionIds(sessionIds);
    if (ids.length === 0) return;
    const deleteSession = this.db.prepare(
      "DELETE FROM ui_sessions WHERE id = ?",
    );
    this.db.transaction(() => {
      ids.forEach((id) => deleteSession.run(id));
    })();
  }

  renameUiSession(
    sessionId: string,
    newTitle: string,
    updatedAt: number,
  ): void {
    sessionId = requireHistorySessionId(sessionId);
    this.db
      .prepare(
        `UPDATE ui_sessions
         SET title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newTitle, updatedAt, sessionId);
  }
}
