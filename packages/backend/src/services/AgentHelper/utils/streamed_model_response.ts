import { AIMessageChunk } from "@langchain/core/messages";
import { extractText } from "./common";

export const EMPTY_MALFORMED_TOOL_CALL_FINISH_KEY =
  "_gyshellEmptyMalformedToolCallFinish";

export const SKIPPED_EMPTY_GENERIC_CHUNKS_KEY =
  "_gyshellSkippedEmptyGenericChunks";

export type StreamedUsageInfo = {
  usage: Record<string, any>;
  totalTokens: number;
};

export type StreamedResponseAppendResult = {
  response: any | null;
  skippedEmptyGenericChunk: boolean;
};

export function appendStreamedModelResponseChunk(
  response: any | null,
  chunk: any,
  rawChunk?: any,
): StreamedResponseAppendResult {
  if (isEmptyGenericChunk(chunk)) {
    const rawChunks = typeof rawChunk === "undefined" ? [] : [rawChunk];

    if (response && hasMergeableMetadata(chunk)) {
      return {
        response: response.concat(chunk),
        skippedEmptyGenericChunk: false,
      };
    }

    if (!response && hasToolCallFinishReason(chunk, rawChunks)) {
      return {
        response: createAssistantMetadataChunk(chunk, rawChunk),
        skippedEmptyGenericChunk: false,
      };
    }

    return {
      response,
      skippedEmptyGenericChunk: true,
    };
  }

  return {
    response: response ? response.concat(chunk) : chunk,
    skippedEmptyGenericChunk: false,
  };
}

export function extractStreamedResponseUsage(
  response: any,
  rawChunks: any[],
): StreamedUsageInfo | null {
  const candidates = [
    response?.usage_metadata,
    response?.additional_kwargs?.usage,
    response?.response_metadata?.usage,
    response?.response_metadata?.tokenUsage,
    ...rawChunks
      .slice()
      .reverse()
      .map((chunk) => chunk?.usage),
  ];

  for (const usage of candidates) {
    const totalTokens = normalizeTotalTokens(usage);
    if (totalTokens !== null) {
      return {
        usage,
        totalTokens,
      };
    }
  }

  return null;
}

export function getStreamedResponseModelName(
  response: any,
  rawChunks: any[],
): string | undefined {
  const candidates = [
    response?.response_metadata?.model_name,
    response?.response_metadata?.model,
    ...rawChunks
      .slice()
      .reverse()
      .map((chunk) => chunk?.model),
  ];

  return candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
}

export function isEmptyMalformedToolCallFinish(
  response: any,
  rawChunks: any[],
): boolean {
  if (!hasToolCallFinishReason(response, rawChunks)) return false;
  if (hasAnyToolCallPayload(response, rawChunks)) return false;

  const contentText = extractContentText(response);
  // Reasoning is diagnostic metadata, not an assistant answer or a tool-call payload.
  return !contentText.trim();
}

export function isEmptyUnusableModelResponse(
  response: any,
  rawChunks: any[],
): boolean {
  if (!response) return false;
  if (hasAnyToolCallPayload(response, rawChunks)) return false;
  if (hasToolCallFinishReason(response, rawChunks)) return false;

  const contentText = extractContentText(response);
  if (contentText.trim()) return false;

  const finishReasons = getFinishReasons(response, rawChunks);
  if (finishReasons.length === 0) return true;

  return finishReasons.some((reason) => {
    const normalized = String(reason || "")
      .trim()
      .toLowerCase();
    return normalized.length > 0 && !normalized.includes("tool_calls");
  });
}

export function describeStreamedResponseFinish(
  response: any,
  rawChunks: any[],
): string {
  const reasons = Array.from(new Set(getFinishReasons(response, rawChunks)));
  return reasons.length > 0 ? reasons.join(", ") : "unknown";
}

export function hasEmptyMalformedToolCallFinishFlag(message: any): boolean {
  return !!message?.additional_kwargs?.[EMPTY_MALFORMED_TOOL_CALL_FINISH_KEY];
}

function isEmptyGenericChunk(chunk: any): boolean {
  return (
    getMessageType(chunk) === "generic" &&
    !extractContentText(chunk).trim() &&
    !hasToolCallPayloadOnMessage(chunk)
  );
}

function hasMergeableMetadata(message: any): boolean {
  return (
    hasNonEmptyObject(message?.response_metadata) ||
    hasNonEmptyObject(message?.usage_metadata) ||
    hasNonEmptyObject(message?.additional_kwargs) ||
    hasNonEmptyString(message?.id) ||
    hasNonEmptyString(message?.name)
  );
}

function createAssistantMetadataChunk(
  chunk: any,
  rawChunk?: any,
): AIMessageChunk {
  const rawMetadata = extractRawResponseMetadata(rawChunk);
  return new AIMessageChunk({
    content: chunk?.content ?? "",
    additional_kwargs: { ...(chunk?.additional_kwargs || {}) },
    response_metadata: {
      ...rawMetadata,
      ...(chunk?.response_metadata || {}),
    },
    usage_metadata: chunk?.usage_metadata,
    id: chunk?.id,
    name: chunk?.name,
  });
}

function extractRawResponseMetadata(rawChunk: any): Record<string, any> {
  if (!rawChunk || typeof rawChunk !== "object") return {};

  const finishReason = getRawFinishReason(rawChunk);
  return {
    ...(hasNonEmptyString(rawChunk.model)
      ? { model_name: rawChunk.model }
      : {}),
    ...(hasNonEmptyString(finishReason) ? { finish_reason: finishReason } : {}),
    ...(hasNonEmptyObject(rawChunk.usage) ? { usage: rawChunk.usage } : {}),
  };
}

function getRawFinishReason(rawChunk: any): string | undefined {
  const choices = Array.isArray(rawChunk?.choices) ? rawChunk.choices : [];
  const selectedChoice = choices[0];
  const reason = selectedChoice?.finish_reason ?? selectedChoice?.finishReason;
  return hasNonEmptyString(reason) ? reason : undefined;
}

function getFinishReasons(response: any, rawChunks: any[]): string[] {
  const candidates = [
    response?.response_metadata?.finish_reason,
    response?.response_metadata?.finishReason,
    response?.generationInfo?.finish_reason,
    response?.generationInfo?.finishReason,
    ...rawChunks.map((chunk) => {
      const selectedChoice = Array.isArray(chunk?.choices)
        ? chunk.choices[0]
        : undefined;
      return selectedChoice?.finish_reason ?? selectedChoice?.finishReason;
    }),
  ];

  return candidates.filter(hasNonEmptyString);
}

function getMessageType(message: any): string {
  const type =
    typeof message?._getType === "function"
      ? message._getType()
      : message?.type;
  return typeof type === "string" ? type : "";
}

function extractContentText(message: any): string {
  const text = extractText(message?.content);
  return typeof text === "string" ? text : "";
}

function normalizeTotalTokens(usage: any): number | null {
  if (!usage || typeof usage !== "object") return null;
  const value =
    usage.total_tokens ??
    usage.totalTokens ??
    usage.total ??
    usage.token_count ??
    usage.tokenCount;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasToolCallFinishReason(response: any, rawChunks: any[]): boolean {
  return getFinishReasons(response, rawChunks).some((reason) =>
    String(reason).includes("tool_calls"),
  );
}

function hasAnyToolCallPayload(response: any, rawChunks: any[]): boolean {
  if (hasToolCallPayloadOnMessage(response)) return true;

  return rawChunks.some((chunk) => {
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    const selectedChoice = choices[0];
    const delta = selectedChoice?.delta;
    const message = selectedChoice?.message;
    return (
      isNonEmptyArray(delta?.tool_calls) ||
      isNonEmptyArray(message?.tool_calls) ||
      isNonEmptyArray(selectedChoice?.tool_calls)
    );
  });
}

function hasToolCallPayloadOnMessage(message: any): boolean {
  return (
    isNonEmptyArray(message?.tool_calls) ||
    isNonEmptyArray(message?.tool_call_chunks) ||
    isNonEmptyArray(message?.additional_kwargs?.tool_calls) ||
    isNonEmptyArray(message?.invalid_tool_calls)
  );
}

function isNonEmptyArray(value: any): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasNonEmptyObject(value: any): boolean {
  return !!value && typeof value === "object" && Object.keys(value).length > 0;
}

function hasNonEmptyString(value: any): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
