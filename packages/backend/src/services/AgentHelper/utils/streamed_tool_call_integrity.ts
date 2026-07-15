import { isDeepStrictEqual } from "node:util";
import { AIMessageChunk } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

export const STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY =
  "_gyshellStreamToolCallIntegrityError";

const STREAM_TOOL_CALL_INTEGRITY_REPORT_KEY = "_gyshellStreamToolCallIntegrity";

export type StreamedToolCallIntegrityStatus =
  | "pass_through"
  | "reconstructed"
  | "malformed_with_identity"
  | "no_recoverable_identity";

export interface StreamedToolCallIntegrityResult {
  response: any;
  status: StreamedToolCallIntegrityStatus;
  issues: string[];
  rawCallCount: number;
  requiresNonStreamingFallback: boolean;
}

interface RawToolCallFragment {
  choiceIndex: number;
  arrayOrdinal: number;
  arrayLength: number;
  index?: number;
  id?: string;
  name?: string;
  args?: string;
  unsupportedArgsType?: string;
  order: number;
}

interface RawToolCallGroup {
  key: string;
  choiceIndex: number;
  index: number;
  firstOrder: number;
  ids: string[];
  names: string[];
  argFragments: string[];
  unsupportedArgumentTypes: string[];
  unidentifiableFragmentCount: number;
}

interface CanonicalToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  index: number;
  type: "tool_call";
  [STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY]?: {
    reason: string;
    rawIndex: number;
  };
}

interface ParsedArguments {
  args: Record<string, unknown> | null;
  reason?: string;
}

export type ToolArgumentContracts = ReadonlyMap<string, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asNumericIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getOpenAITool(tool: any): any | null {
  if (tool?.type === "function" && typeof tool?.function?.name === "string") {
    return tool;
  }
  try {
    return convertToOpenAITool(tool as any);
  } catch {
    return null;
  }
}

/** Build only the contract needed by the stream guard. Conversion failures are
 * intentionally ignored so an unfamiliar MCP tool cannot be falsely rejected. */
export function buildToolArgumentContracts(
  tools: any[],
): Map<string, readonly string[]> {
  const contracts = new Map<string, readonly string[]>();
  for (const tool of tools) {
    const openAITool = getOpenAITool(tool);
    const name = asNonEmptyString(openAITool?.function?.name);
    if (!name) continue;
    const required = Array.isArray(openAITool?.function?.parameters?.required)
      ? openAITool.function.parameters.required.filter(
          (field: unknown): field is string =>
            typeof field === "string" && field.length > 0,
        )
      : [];
    contracts.set(name, required);
  }
  return contracts;
}

function stringifyRawArguments(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return JSON.stringify(value);
  return undefined;
}

function extractRawArguments(rawCall: Record<string, unknown>): {
  present: boolean;
  value?: unknown;
} {
  const functionPayload = isRecord(rawCall.function) ? rawCall.function : null;
  if (
    functionPayload &&
    Object.prototype.hasOwnProperty.call(functionPayload, "arguments")
  ) {
    return { present: true, value: functionPayload.arguments };
  }
  if (Object.prototype.hasOwnProperty.call(rawCall, "arguments")) {
    return { present: true, value: rawCall.arguments };
  }
  if (Object.prototype.hasOwnProperty.call(rawCall, "args")) {
    return { present: true, value: rawCall.args };
  }
  return { present: false };
}

function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function extractRawToolCallFragments(rawChunks: any[]): RawToolCallFragment[] {
  const fragments: RawToolCallFragment[] = [];
  let order = 0;

  for (const rawChunk of rawChunks) {
    const choices = Array.isArray(rawChunk?.choices) ? rawChunk.choices : [];
    // ChatOpenAI consumes only choices[0] while streaming. Treating other
    // choices as part of that response would execute unselected alternatives.
    const choice = choices[0];
    if (!choice) continue;
    const choiceIndex = asNumericIndex(choice?.index) ?? 0;
    const seenCandidateArrays = new Set<any>();
    const candidateArrays = [
      choice?.delta?.tool_calls,
      choice?.message?.tool_calls,
      choice?.tool_calls,
    ];
    for (const candidate of candidateArrays) {
      if (!Array.isArray(candidate)) continue;
      if (seenCandidateArrays.has(candidate)) continue;
      seenCandidateArrays.add(candidate);
      for (
        let arrayOrdinal = 0;
        arrayOrdinal < candidate.length;
        arrayOrdinal += 1
      ) {
        const rawCall = candidate[arrayOrdinal];
        if (!rawCall || typeof rawCall !== "object") {
          fragments.push({
            choiceIndex,
            arrayOrdinal,
            arrayLength: candidate.length,
            order,
          });
          order += 1;
          continue;
        }
        const rawArguments = extractRawArguments(rawCall);
        const serializedArguments = rawArguments.present
          ? stringifyRawArguments(rawArguments.value)
          : undefined;
        fragments.push({
          choiceIndex,
          arrayOrdinal,
          arrayLength: candidate.length,
          index: asNumericIndex(rawCall.index),
          id: asNonEmptyString(rawCall.id),
          name: asNonEmptyString(rawCall?.function?.name ?? rawCall?.name),
          args: serializedArguments,
          unsupportedArgsType:
            rawArguments.present && serializedArguments === undefined
              ? describeValueType(rawArguments.value)
              : undefined,
          order,
        });
        order += 1;
      }
    }
  }
  return fragments;
}

function groupRawToolCallFragments(fragments: RawToolCallFragment[]): {
  groups: RawToolCallGroup[];
  unassignedFragmentCount: number;
} {
  const groups = new Map<string, RawToolCallGroup>();
  const groupKeysById = new Map<string, string>();
  const lastGroupKeyByChoice = new Map<number, string>();
  const lastGroupKeyByExplicitIndex = new Map<string, string>();
  let nextSyntheticIndex = 0;
  let unassignedFragmentCount = 0;

  const getOrCreateGroup = (
    key: string,
    fragment: RawToolCallFragment,
    index: number,
  ): RawToolCallGroup => {
    const existing = groups.get(key);
    if (existing) return existing;
    const created: RawToolCallGroup = {
      key,
      choiceIndex: fragment.choiceIndex,
      index,
      firstOrder: fragment.order,
      ids: [],
      names: [],
      argFragments: [],
      unsupportedArgumentTypes: [],
      unidentifiableFragmentCount: 0,
    };
    groups.set(key, created);
    nextSyntheticIndex = Math.max(nextSyntheticIndex, index + 1);
    return created;
  };

  for (const fragment of fragments) {
    let key: string | undefined;
    let index = fragment.index;

    if (index !== undefined) {
      const baseIndexKey = `${fragment.choiceIndex}:index:${index}`;
      const baseGroup = groups.get(baseIndexKey);
      if (
        fragment.id &&
        baseGroup &&
        baseGroup.ids.length > 0 &&
        !baseGroup.ids.includes(fragment.id)
      ) {
        key = `${baseIndexKey}:id:${fragment.id}`;
      } else if (!fragment.id) {
        key = lastGroupKeyByExplicitIndex.get(baseIndexKey) ?? baseIndexKey;
      } else {
        key = baseIndexKey;
      }
    } else if (fragment.id && groupKeysById.has(fragment.id)) {
      key = groupKeysById.get(fragment.id);
      index = key ? groups.get(key)?.index : undefined;
    } else if (fragment.arrayLength > 1) {
      index = fragment.arrayOrdinal;
      key = `${fragment.choiceIndex}:ordinal:${index}`;
    } else if (fragment.id) {
      index = nextSyntheticIndex;
      key = `${fragment.choiceIndex}:id:${fragment.id}`;
    } else {
      key = lastGroupKeyByChoice.get(fragment.choiceIndex);
      index = key ? groups.get(key)?.index : undefined;
    }

    if (key === undefined || index === undefined) {
      unassignedFragmentCount += 1;
      index = nextSyntheticIndex;
      key = `${fragment.choiceIndex}:anonymous:${index}`;
    }

    const group = getOrCreateGroup(key, fragment, index);
    if (fragment.id) {
      group.ids.push(fragment.id);
      groupKeysById.set(fragment.id, key);
    }
    if (fragment.name) group.names.push(fragment.name);
    if (fragment.args !== undefined && fragment.args.length > 0) {
      group.argFragments.push(fragment.args);
    }
    if (fragment.unsupportedArgsType) {
      group.unsupportedArgumentTypes.push(fragment.unsupportedArgsType);
    }
    if (!fragment.id && fragment.index === undefined) {
      group.unidentifiableFragmentCount += 1;
    }
    if (fragment.index !== undefined) {
      lastGroupKeyByExplicitIndex.set(
        `${fragment.choiceIndex}:index:${fragment.index}`,
        key,
      );
    }
    lastGroupKeyByChoice.set(fragment.choiceIndex, key);
  }

  return {
    groups: [...groups.values()].sort(
      (left, right) =>
        left.choiceIndex - right.choiceIndex ||
        left.index - right.index ||
        left.firstOrder - right.firstOrder,
    ),
    unassignedFragmentCount,
  };
}

function parseArgumentFragments(fragments: string[]): ParsedArguments {
  if (fragments.length === 0) return { args: {} };

  const concatenated = fragments.join("");
  const concatenatedObject = parseObject(concatenated);
  if (concatenatedObject) return { args: concatenatedObject };

  const individuallyParsed = fragments
    .map((fragment) => ({ fragment, value: parseObject(fragment) }))
    .filter(
      (
        candidate,
      ): candidate is {
        fragment: string;
        value: Record<string, unknown>;
      } => candidate.value !== null,
    );
  if (
    individuallyParsed.length > 0 &&
    individuallyParsed.every((candidate) =>
      isDeepStrictEqual(candidate.value, individuallyParsed[0].value),
    )
  ) {
    const complete = individuallyParsed[0];
    if (
      fragments.every(
        (fragment) =>
          fragment === complete.fragment ||
          complete.fragment.startsWith(fragment),
      )
    ) {
      return { args: complete.value };
    }
  }

  const longest = fragments.reduce((current, candidate) =>
    candidate.length > current.length ? candidate : current,
  );
  const longestObject = parseObject(longest);
  if (
    longestObject &&
    fragments.every(
      (fragment) =>
        fragment === longest ||
        longest.startsWith(fragment) ||
        fragment.startsWith(longest),
    )
  ) {
    return { args: longestObject };
  }

  return {
    args: null,
    reason:
      "The streamed tool-call arguments were not one consistent JSON object.",
  };
}

function resolveStreamedName(
  fragments: string[],
  contracts: ToolArgumentContracts,
): { name: string; reason?: string } {
  const names = uniqueInOrder(fragments);
  if (names.length === 0) {
    return {
      name: "",
      reason: "The streamed tool call did not include a function name.",
    };
  }
  if (names.length === 1) return { name: names[0] };

  const concatenated = fragments.join("");
  if (contracts.has(concatenated)) return { name: concatenated };

  const knownNames = names.filter((name) => contracts.has(name));
  if (
    knownNames.length === 1 &&
    fragments.every(
      (fragment) =>
        fragment === knownNames[0] || knownNames[0].startsWith(fragment),
    )
  ) {
    return { name: knownNames[0] };
  }

  return {
    name: names[0],
    reason: `The streamed tool-call name changed within one index (${names.join(
      ", ",
    )}).`,
  };
}

function findMissingRequiredArguments(
  name: string,
  args: Record<string, unknown>,
  contracts: ToolArgumentContracts,
): string[] {
  const required = contracts.get(name) ?? [];
  return required.filter(
    (field) => !Object.prototype.hasOwnProperty.call(args, field),
  );
}

function withIntegrityError(
  call: CanonicalToolCall,
  reason: string,
): CanonicalToolCall {
  return {
    ...call,
    [STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY]: {
      reason,
      rawIndex: call.index,
    },
  };
}

function appendIntegrityError(call: CanonicalToolCall, reason: string): void {
  const previousReason = call[STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY]?.reason;
  const combinedReason =
    previousReason && previousReason !== reason
      ? `${previousReason} ${reason}`
      : reason;
  Object.assign(call, withIntegrityError(call, combinedReason));
}

function canonicalizeRawGroups(
  groups: RawToolCallGroup[],
  contracts: ToolArgumentContracts,
  issues: string[],
): CanonicalToolCall[] {
  const calls: CanonicalToolCall[] = [];

  for (const group of groups) {
    const ids = uniqueInOrder(group.ids);
    const name = resolveStreamedName(group.names, contracts);
    const parsed = parseArgumentFragments(group.argFragments);
    const baseReasons: string[] = [];
    if (ids.length === 0) {
      baseReasons.push(
        `The streamed tool call at raw index ${group.index} did not include a call ID.`,
      );
    }
    if (ids.length > 1) {
      baseReasons.push(
        `The streamed tool-call ID changed within raw index ${group.index}.`,
      );
    }
    if (name.reason) baseReasons.push(name.reason);
    if (parsed.reason) baseReasons.push(parsed.reason);
    const unsupportedArgumentTypes = uniqueInOrder(
      group.unsupportedArgumentTypes,
    );
    if (unsupportedArgumentTypes.length > 0) {
      baseReasons.push(
        `The streamed tool-call arguments used unsupported value type(s): ${unsupportedArgumentTypes.join(
          ", ",
        )}; expected a JSON object string or object.`,
      );
    }
    if (group.unidentifiableFragmentCount > 0 && groups.length > 1) {
      baseReasons.push(
        "One or more argument fragments omitted both index and call ID while multiple calls were active.",
      );
    }

    const parsedArgs = parsed.args ?? {};
    const missingRequired = findMissingRequiredArguments(
      name.name,
      parsedArgs,
      contracts,
    );
    if (missingRequired.length > 0) {
      baseReasons.push(
        `The streamed arguments omitted required field(s): ${missingRequired.join(
          ", ",
        )}.`,
      );
    }

    const outputIds = ids.length > 0 ? ids : [""];
    for (const id of outputIds) {
      let call: CanonicalToolCall = {
        id,
        name: name.name,
        args: parsedArgs,
        index: group.index,
        type: "tool_call",
      };
      if (baseReasons.length > 0) {
        const reason = baseReasons.join(" ");
        call = withIntegrityError(call, reason);
        issues.push(`index ${group.index}: ${reason}`);
      }
      calls.push(call);
    }
  }

  const callsById = new Map<string, CanonicalToolCall[]>();
  const callsByIndex = new Map<number, CanonicalToolCall[]>();
  for (const call of calls) {
    if (call.id) {
      const matching = callsById.get(call.id) ?? [];
      matching.push(call);
      callsById.set(call.id, matching);
    }
    const matchingIndex = callsByIndex.get(call.index) ?? [];
    matchingIndex.push(call);
    callsByIndex.set(call.index, matchingIndex);
  }
  for (const [id, matching] of callsById) {
    if (matching.length < 2) continue;
    const reason = `The same streamed tool-call ID (${id}) appeared at multiple indices.`;
    for (const call of matching) {
      appendIntegrityError(call, reason);
    }
    issues.push(reason);
  }
  for (const [index, matching] of callsByIndex) {
    if (matching.length < 2) continue;
    const reason = `Multiple streamed tool calls resolved to raw index ${index}.`;
    for (const call of matching) {
      appendIntegrityError(call, reason);
    }
    issues.push(reason);
  }

  return calls;
}

function getResponseCallIndex(
  response: any,
  call: any,
  ordinal: number,
): number {
  const direct = asNumericIndex(call?.index);
  if (direct !== undefined) return direct;
  const chunks = Array.isArray(response?.tool_call_chunks)
    ? response.tool_call_chunks
    : [];
  const matching = chunks.find(
    (chunk: any) => call?.id && chunk?.id === call.id,
  );
  return (
    asNumericIndex(matching?.index) ??
    asNumericIndex(chunks[ordinal]?.index) ??
    ordinal
  );
}

function canonicalizeResponseCalls(
  response: any,
  contracts: ToolArgumentContracts,
  issues: string[],
): CanonicalToolCall[] {
  const calls: CanonicalToolCall[] = [];
  const validCalls = Array.isArray(response?.tool_calls)
    ? response.tool_calls
    : [];
  for (let ordinal = 0; ordinal < validCalls.length; ordinal += 1) {
    const source = validCalls[ordinal];
    const name = asNonEmptyString(source?.name) ?? "";
    const parsed = isRecord(source?.args)
      ? source.args
      : typeof source?.args === "string"
        ? parseObject(source.args)
        : null;
    let call: CanonicalToolCall = {
      ...source,
      id: typeof source?.id === "string" ? source.id : "",
      name,
      args: parsed ?? {},
      index: getResponseCallIndex(response, source, ordinal),
      type: "tool_call",
    };
    const reasons: string[] = [];
    if (!call.id) reasons.push("The tool call did not include a call ID.");
    if (!name) reasons.push("The tool call did not include a function name.");
    if (!parsed) {
      reasons.push("The tool-call arguments were not a JSON object.");
    } else {
      const missing = findMissingRequiredArguments(name, parsed, contracts);
      if (missing.length > 0) {
        reasons.push(
          `The tool-call arguments omitted required field(s): ${missing.join(
            ", ",
          )}.`,
        );
      }
    }
    if (reasons.length > 0) {
      const reason = reasons.join(" ");
      call = withIntegrityError(call, reason);
      issues.push(`aggregate index ${call.index}: ${reason}`);
    }
    calls.push(call);
  }

  const invalidCalls = Array.isArray(response?.invalid_tool_calls)
    ? response.invalid_tool_calls
    : [];
  for (let ordinal = 0; ordinal < invalidCalls.length; ordinal += 1) {
    const invalid = invalidCalls[ordinal];
    const id = typeof invalid?.id === "string" ? invalid.id : "";
    const name = asNonEmptyString(invalid?.name) ?? "";
    const rawArgs =
      typeof invalid?.args === "string"
        ? [invalid.args]
        : isRecord(invalid?.args)
          ? [JSON.stringify(invalid.args)]
          : [];
    const parsed = rawArgs.length > 0 ? parseObject(rawArgs.join("")) : null;
    const reason = asNonEmptyString(invalid?.error)
      ? `LangChain reported an invalid tool call: ${invalid.error}`
      : "LangChain reported an invalid tool call.";
    const matching = id ? calls.filter((call) => call.id === id) : [];
    if (matching.length > 0) {
      const conflictReason = `${reason} The same aggregate also contained a valid tool call with this ID.`;
      for (const existing of matching) {
        appendIntegrityError(existing, conflictReason);
        issues.push(`aggregate index ${existing.index}: ${conflictReason}`);
      }
      continue;
    }
    const call = withIntegrityError(
      {
        id,
        name,
        args: parsed ?? {},
        index: getResponseCallIndex(
          response,
          invalid,
          validCalls.length + ordinal,
        ),
        type: "tool_call",
      },
      reason,
    );
    calls.push(call);
    issues.push(`invalid aggregate index ${call.index}: ${reason}`);
  }

  const callsById = new Map<string, CanonicalToolCall[]>();
  const callsByIndex = new Map<number, CanonicalToolCall[]>();
  for (const call of calls) {
    if (call.id) {
      const matchingId = callsById.get(call.id) ?? [];
      matchingId.push(call);
      callsById.set(call.id, matchingId);
    }
    const matchingIndex = callsByIndex.get(call.index) ?? [];
    matchingIndex.push(call);
    callsByIndex.set(call.index, matchingIndex);
  }
  for (const [id, matching] of callsById) {
    if (matching.length < 2) continue;
    const reason = `The aggregate contained duplicate tool-call ID ${id}.`;
    for (const call of matching) appendIntegrityError(call, reason);
    issues.push(reason);
  }
  for (const [index, matching] of callsByIndex) {
    if (matching.length < 2) continue;
    const reason = `The aggregate contained multiple tool calls at index ${index}.`;
    for (const call of matching) appendIntegrityError(call, reason);
    issues.push(reason);
  }
  return calls;
}

function mergeCanonicalSources(
  rawCalls: CanonicalToolCall[],
  responseCalls: CanonicalToolCall[],
  issues: string[],
): CanonicalToolCall[] {
  if (rawCalls.length === 0) return responseCalls;
  const merged = [...rawCalls];
  for (const call of responseCalls) {
    const represented = rawCalls.some(
      (rawCall) =>
        (call.id.length > 0 && rawCall.id === call.id) ||
        (rawCall.index === call.index && rawCall.name === call.name),
    );
    if (represented) continue;
    const reason =
      "LangChain aggregated a tool call that was absent from the captured raw stream.";
    merged.push(
      call[STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY]
        ? call
        : withIntegrityError(call, reason),
    );
    issues.push(`aggregate index ${call.index}: ${reason}`);
  }
  return merged;
}

function comparableCalls(response: any): Array<Record<string, unknown>> {
  const calls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
  return calls.map((call: any, ordinal: number) => ({
    id: typeof call?.id === "string" ? call.id : "",
    name: typeof call?.name === "string" ? call.name : "",
    args: isRecord(call?.args) ? call.args : call?.args,
    index: getResponseCallIndex(response, call, ordinal),
  }));
}

function canonicalComparable(
  calls: CanonicalToolCall[],
): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    args: call.args,
    index: call.index,
  }));
}

function hasToolCallFinishReason(response: any, rawChunks: any[]): boolean {
  const candidates = [
    response?.response_metadata?.finish_reason,
    response?.additional_kwargs?.finish_reason,
    ...rawChunks.map((chunk) =>
      Array.isArray(chunk?.choices)
        ? chunk.choices[0]?.finish_reason
        : undefined,
    ),
  ];
  return candidates.some((reason) => reason === "tool_calls");
}

function rebuildResponse(
  response: any,
  calls: CanonicalToolCall[],
  status: StreamedToolCallIntegrityStatus,
  issues: string[],
  rawCallCount: number,
): any {
  const additionalKwargs = {
    ...(response?.additional_kwargs ?? {}),
    [STREAM_TOOL_CALL_INTEGRITY_REPORT_KEY]: {
      status,
      issues: [...issues],
      rawCallCount,
    },
  };
  delete (additionalKwargs as any).tool_calls;
  delete (additionalKwargs as any).__raw_response;

  const rebuilt = new AIMessageChunk({
    content: response?.content ?? "",
    additional_kwargs: additionalKwargs,
    response_metadata: response?.response_metadata ?? {},
    usage_metadata: response?.usage_metadata,
    id: response?.id,
    name: response?.name,
    tool_call_chunks: calls.map((call) => ({
      id: call.id || undefined,
      name: call.name || undefined,
      args: JSON.stringify(call.args),
      index: call.index,
      type: "tool_call_chunk" as const,
    })),
  } as any);
  (rebuilt as any).tool_calls = calls;
  (rebuilt as any).invalid_tool_calls = [];
  return rebuilt;
}

/**
 * Reconcile LangChain's aggregate with the unmerged Chat Completions payload.
 * Raw SSE is authoritative when present. Every identifiable malformed call is
 * materialized as a non-executable call so the planner can emit one result for
 * its ID; only a payload-free tool-call finish requests a non-streaming retry.
 */
export function reconcileStreamedToolCalls(
  response: any,
  rawChunks: any[],
  contracts: ToolArgumentContracts = new Map(),
): StreamedToolCallIntegrityResult {
  const normalizedRawChunks = Array.isArray(rawChunks) ? rawChunks : [];
  const fragments = extractRawToolCallFragments(normalizedRawChunks);
  const grouped = groupRawToolCallFragments(fragments);
  const issues: string[] = [];
  if (grouped.unassignedFragmentCount > 0) {
    issues.push(
      `${grouped.unassignedFragmentCount} raw tool-call fragment(s) lacked both a stable index and call ID.`,
    );
  }

  const rawCalls = canonicalizeRawGroups(grouped.groups, contracts, issues);
  const responseCalls = canonicalizeResponseCalls(response, contracts, issues);
  const canonicalCalls = mergeCanonicalSources(rawCalls, responseCalls, issues);
  const rawCallCount = rawCalls.length;

  if (canonicalCalls.length === 0) {
    const requiresNonStreamingFallback = hasToolCallFinishReason(
      response,
      normalizedRawChunks,
    );
    return {
      response,
      status: requiresNonStreamingFallback
        ? "no_recoverable_identity"
        : "pass_through",
      issues,
      rawCallCount,
      requiresNonStreamingFallback,
    };
  }

  if (grouped.unassignedFragmentCount > 0) {
    for (let index = 0; index < canonicalCalls.length; index += 1) {
      const call = canonicalCalls[index];
      if (call[STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY]) continue;
      canonicalCalls[index] = withIntegrityError(
        call,
        "Raw fragments without a stable index or call ID made this streamed batch ambiguous.",
      );
    }
  }

  const hasMalformedCall = canonicalCalls.some(
    (call) => !!call[STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY],
  );
  const aggregateInvalidCount = Array.isArray(response?.invalid_tool_calls)
    ? response.invalid_tool_calls.length
    : 0;
  const aggregateMatches =
    aggregateInvalidCount === 0 &&
    isDeepStrictEqual(
      comparableCalls(response),
      canonicalComparable(canonicalCalls),
    );
  if (!aggregateMatches && rawCalls.length > 0) {
    issues.push(
      "LangChain's aggregated tool calls differed from the original streamed calls.",
    );
  }
  const responseCallsHavePersistentIndices =
    Array.isArray(response?.tool_calls) &&
    response.tool_calls.every(
      (call: any) => asNumericIndex(call?.index) !== undefined,
    );
  const requiresPersistentIndexRepair =
    rawCalls.length > 0 && !responseCallsHavePersistentIndices;

  if (aggregateMatches && !hasMalformedCall && !requiresPersistentIndexRepair) {
    return {
      response,
      status: "pass_through",
      issues,
      rawCallCount,
      requiresNonStreamingFallback: false,
    };
  }

  const status: StreamedToolCallIntegrityStatus = hasMalformedCall
    ? "malformed_with_identity"
    : aggregateMatches && !requiresPersistentIndexRepair
      ? "pass_through"
      : "reconstructed";
  return {
    response:
      status === "pass_through"
        ? response
        : rebuildResponse(
            response,
            canonicalCalls,
            status,
            issues,
            rawCallCount,
          ),
    status,
    issues,
    rawCallCount,
    // Keep an explicit, non-executable representation while asking the model
    // once more for stable identity. If that retry is equally malformed, the
    // original call still reaches the planner and receives an error result.
    requiresNonStreamingFallback: grouped.unassignedFragmentCount > 0,
  };
}

export function getStreamToolCallIntegrityError(
  toolCall: any,
): { reason: string } | null {
  const marker = toolCall?.[STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY];
  return marker && typeof marker.reason === "string" ? marker : null;
}
