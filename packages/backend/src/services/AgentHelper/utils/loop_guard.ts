import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";
import {
  LOOP_GUARD_INPUT_TAG,
  buildLoopGuardRedirectInstruction,
  type LoopGuardTripKind,
} from "../prompts";
import { markEphemeral } from "./common";
import {
  PROSE_CYCLE_THRESHOLDS,
  STRUCTURED_CYCLE_THRESHOLDS,
  StreamCycleDetector,
  collapseRepeatedToolCalls,
  findRepeatedToolCall,
  type StreamCycleHit,
} from "./loop_detector";
import {
  STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY,
  rebuildResponseWithToolCalls,
  type CanonicalToolCall,
} from "./streamed_tool_call_integrity";

/**
 * Silent loop guard for one main `model_request`.
 *
 * Every check is scoped to the response being generated. When a response
 * loops it is stopped, discarded, retracted from the UI and re-requested with
 * the same history plus one hidden redirect note. Tools only run after
 * `model_request` returns, so a discarded response has executed nothing.
 */

/** Total attempts for one model request, including the first (= OMP). */
export const LOOP_GUARD_MAX_ATTEMPTS = 3;
/** Delay before re-requesting after attempt 1 and attempt 2. */
export const LOOP_GUARD_RETRY_DELAYS_MS: readonly number[] = [500, 1000];

const LOOP_GUARD_REDIRECT_INPUT_KIND = "loop_guard_redirect";

export interface LoopGuardTrip {
  kind: LoopGuardTripKind;
  /** Log-only description; never contains the looped text. */
  detail: string;
  toolName?: string;
  /** Assistant text before the loop began, with one copy of the unit. */
  cleanContent: string;
}

/** Returned (not thrown) by an interrupted attempt so retry layers ignore it. */
export class LoopGuardInterruption {
  constructor(readonly trip: LoopGuardTrip) {}
}

export function isLoopGuardInterruption(
  value: unknown,
): value is LoopGuardInterruption {
  return value instanceof LoopGuardInterruption;
}

function withoutDanglingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/**
 * The detector only sees its trailing window, so a run longer than the window
 * is reported as starting at the window edge. Walk back over the full text to
 * the real start of the periodic run.
 */
function periodicRunStart(text: string, start: number, period: number): number {
  let runStart = Math.max(0, start);
  while (runStart > 0 && text[runStart - 1] === text[runStart - 1 + period]) {
    runStart -= 1;
  }
  return runStart;
}

function isMalformedToolCall(call: any): boolean {
  return Boolean(call?.[STREAM_TOOL_CALL_INTEGRITY_ERROR_KEY]);
}

function describeCycle(source: string, hit: StreamCycleHit): string {
  return `${source} repeated a ${hit.unitLength}-char unit ${hit.copies}x back-to-back`;
}

interface ToolArgumentStream {
  detector: StreamCycleDetector;
  toolName: string;
}

export interface ResponseLoopMonitorOptions {
  /**
   * On the last attempt tool arguments are not scanned (their thresholds are
   * cautious, so a legitimately repetitive file must still be writable) and
   * repeated calls are collapsed instead of interrupting.
   */
  finalAttempt: boolean;
}

/** Watches one streamed response attempt. Create a fresh one per stream. */
export class ResponseLoopMonitor {
  private content = "";
  private readonly contentDetector = new StreamCycleDetector(
    PROSE_CYCLE_THRESHOLDS,
    { markdownAware: true },
  );
  private readonly reasoningDetector = new StreamCycleDetector(
    PROSE_CYCLE_THRESHOLDS,
    { markdownAware: true },
  );
  private readonly toolArgumentStreams = new Map<string, ToolArgumentStream>();

  constructor(private readonly options: ResponseLoopMonitorOptions) {}

  observeReasoning(delta: string): LoopGuardTrip | null {
    return this.reasoningTrip(this.reasoningDetector.push(delta));
  }

  observeContent(delta: string): LoopGuardTrip | null {
    this.content += delta;
    return this.contentTrip(this.contentDetector.push(delta));
  }

  /** Feed a chunk's `tool_call_chunks` (LangChain shape). */
  observeToolCallChunks(toolCallChunks: unknown): LoopGuardTrip | null {
    if (this.options.finalAttempt || !Array.isArray(toolCallChunks)) {
      return null;
    }
    for (let ordinal = 0; ordinal < toolCallChunks.length; ordinal += 1) {
      const chunk = toolCallChunks[ordinal];
      const stream = this.getToolArgumentStream(chunk, ordinal);
      if (typeof chunk?.name === "string" && chunk.name) {
        stream.toolName = chunk.name;
      }
      if (typeof chunk?.args !== "string" || !chunk.args) continue;
      const hit = stream.detector.push(chunk.args);
      if (hit) return this.toolArgumentTrip(stream, hit);
    }
    return null;
  }

  /** Final scans for text that ended between two scan strides. */
  finish(): LoopGuardTrip | null {
    const reasoning = this.reasoningTrip(this.reasoningDetector.flush());
    if (reasoning) return reasoning;
    const content = this.contentTrip(this.contentDetector.flush());
    if (content) return content;
    for (const stream of this.toolArgumentStreams.values()) {
      const hit = stream.detector.flush();
      if (hit) return this.toolArgumentTrip(stream, hit);
    }
    return null;
  }

  /**
   * Check the reconciled tool calls for one call repeated several times in
   * this response. The final attempt collapses the copies instead.
   */
  reviewToolCalls(response: any): { trip: LoopGuardTrip } | { response: any } {
    const calls: any[] = Array.isArray(response?.tool_calls)
      ? response.tool_calls
      : [];
    // Calls whose arguments failed to parse all reconcile to `{}`, so they are
    // never compared; the integrity layer already reports them to the model.
    const options = { isComparable: (call: any) => !isMalformedToolCall(call) };
    const repeated = findRepeatedToolCall(calls, options);
    if (!repeated) return { response };
    if (!this.options.finalAttempt) {
      return {
        trip: {
          kind: "repeated_tool_calls",
          detail: `response repeated the identical ${repeated.toolName} call ${repeated.copies}x`,
          toolName: repeated.toolName,
          cleanContent: this.content,
        },
      };
    }
    const canonicalCalls: CanonicalToolCall[] = calls.map((call, ordinal) => ({
      ...call,
      id: typeof call?.id === "string" ? call.id : "",
      name: typeof call?.name === "string" ? call.name : "",
      args: call?.args && typeof call.args === "object" ? call.args : {},
      index: typeof call?.index === "number" ? call.index : ordinal,
      type: "tool_call",
    }));
    const kept = collapseRepeatedToolCalls(canonicalCalls, options);
    console.warn(
      `[loop_guard] final attempt still repeated the identical ${repeated.toolName} call ${repeated.copies}x; keeping one copy.`,
    );
    return { response: rebuildResponseWithToolCalls(response, kept) };
  }

  private getToolArgumentStream(chunk: any, ordinal: number): ToolArgumentStream {
    const key =
      typeof chunk?.index === "number"
        ? `index:${chunk.index}`
        : typeof chunk?.id === "string" && chunk.id
          ? `id:${chunk.id}`
          : `ordinal:${ordinal}`;
    let stream = this.toolArgumentStreams.get(key);
    if (!stream) {
      stream = {
        detector: new StreamCycleDetector(STRUCTURED_CYCLE_THRESHOLDS),
        toolName: "",
      };
      this.toolArgumentStreams.set(key, stream);
    }
    return stream;
  }

  private reasoningTrip(hit: StreamCycleHit | null): LoopGuardTrip | null {
    if (!hit) return null;
    return {
      kind: "reasoning",
      detail: describeCycle("reasoning", hit),
      cleanContent: this.content,
    };
  }

  private contentTrip(hit: StreamCycleHit | null): LoopGuardTrip | null {
    if (!hit) return null;
    return {
      kind: "content",
      detail: describeCycle("content", hit),
      cleanContent: withoutDanglingHighSurrogate(
        this.content.slice(
          0,
          periodicRunStart(this.content, hit.repeatStartOffset, hit.unitLength) +
            hit.unitLength,
        ),
      ),
    };
  }

  private toolArgumentTrip(
    stream: ToolArgumentStream,
    hit: StreamCycleHit,
  ): LoopGuardTrip {
    const toolName = stream.toolName || "tool";
    return {
      kind: "tool_arguments",
      detail: describeCycle(`${toolName} arguments`, hit),
      toolName,
      cleanContent: this.content,
    };
  }
}

/**
 * Hidden note appended to the re-request only (never to history). It is built
 * like the Runtime Thinking Correction instruction, is never shown in the UI,
 * and is marked ephemeral as a second line of defence against persistence.
 */
export function createLoopGuardRedirectMessage(
  trip: LoopGuardTrip,
  nextAttempt: number,
): HumanMessage {
  const message = new HumanMessage(
    `${LOOP_GUARD_INPUT_TAG}${buildLoopGuardRedirectInstruction({
      kind: trip.kind,
      toolName: trip.toolName,
      repeatedInterruption: nextAttempt >= LOOP_GUARD_MAX_ATTEMPTS,
    })}`,
  );
  (message as any).additional_kwargs = {
    _gyshellMessageId: uuidv4(),
    input_kind: LOOP_GUARD_REDIRECT_INPUT_KIND,
  };
  return markEphemeral(message);
}

/**
 * Response accepted after every attempt looped in its text or reasoning: the
 * clean text written before the loop, with no tool calls. `null` when nothing
 * usable remains. Tool-call kinds never trip on the final attempt (see
 * ResponseLoopMonitorOptions).
 */
export function buildExhaustedLoopGuardResponse(
  trip: LoopGuardTrip,
): AIMessage | null {
  const content = trip.cleanContent.trimEnd();
  return content.trim() ? new AIMessage({ content }) : null;
}
