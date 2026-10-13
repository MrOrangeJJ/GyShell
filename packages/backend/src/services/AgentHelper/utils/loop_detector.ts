/**
 * Pure repetition detectors for one streamed model response.
 *
 * The cycle detector is a port of Oh My Pi's exact suffix-cycle check
 * (`packages/ai/src/utils/thinking-loop.ts`, `detectExactSuffixCycle`): a
 * Z-array over the virtually reversed tail finds every period that ends at the
 * current stream position in linear time. Because the comparison is
 * `text[end - k] === text[end - period - k]`, detection is independent of the
 * phase at which the stream happens to be scanned, and it covers every period
 * shape — `abcabc…`, `aabccaabcc…`, multi-line `aaa\nbbb\nddd\naaa\n…` and
 * paragraph-sized units alike. The smallest qualifying period is reported.
 *
 * Deliberate differences from Oh My Pi:
 * - A unit without letters/emoji is still a loop once its run is long enough
 *   (OMP issue #12525: `?!?!…` runaways were never caught).
 * - Content inside an open Markdown code fence uses the stricter structured
 *   thresholds instead of being exempt, so a model looping inside a code block
 *   is still caught while ordinary repetitive code is not.
 * - Paragraph-sized units up to 2048 characters are considered.
 * - OMP's semantic heuristics (near-duplicate trigrams, lexical stall) are not
 *   ported; they produced false positives on tables and JSON (OMP #11129).
 *
 * Nothing in this module reads earlier responses: every detector instance is
 * scoped to the response currently being generated.
 */

export interface CycleThresholds {
  /** Longest unit (period) that is considered. */
  maxUnit: number;
  /** Units up to this length use the short-unit rule. */
  shortMaxUnit: number;
  shortMinCopies: number;
  shortMinChars: number;
  longMinCopies: number;
  longMinChars: number;
  /** A unit with no letter or emoji must repeat over at least this many chars. */
  symbolOnlyMinChars: number;
  /** Rolling tail kept for scanning; must hold `maxUnit * minCopies` chars. */
  windowChars: number;
  /** New characters between scans. A larger single delta scans at once. */
  scanStride: number;
}

/** Prose and reasoning (OMP's thresholds, widened to longer units). */
export const PROSE_CYCLE_THRESHOLDS: CycleThresholds = Object.freeze({
  maxUnit: 2048,
  shortMaxUnit: 60,
  shortMinCopies: 4,
  shortMinChars: 180,
  longMinCopies: 3,
  longMinChars: 1024,
  symbolOnlyMinChars: 2000,
  windowChars: 8192,
  scanStride: 128,
});

/**
 * Code blocks and tool-call arguments. Legitimate files and code repeat far
 * more than prose, so a loop needs many back-to-back copies over a long run.
 */
export const STRUCTURED_CYCLE_THRESHOLDS: CycleThresholds = Object.freeze({
  maxUnit: 1024,
  shortMaxUnit: 1024,
  shortMinCopies: 8,
  shortMinChars: 2048,
  longMinCopies: 8,
  longMinChars: 2048,
  symbolOnlyMinChars: 4096,
  windowChars: 8192,
  scanStride: 256,
});

export interface SuffixCycle {
  /** Period of the repetition in characters. */
  unitLength: number;
  /** Complete back-to-back copies of the unit at the end of the text. */
  copies: number;
  /** Length of the whole periodic suffix, including a trailing partial copy. */
  repeatedLength: number;
}

const LETTER_OR_EMOJI_RE = /\p{L}|\p{Extended_Pictographic}/u;

/** Reused Z-array scratch; scans are synchronous, so one buffer suffices. */
let zScratch = new Int32Array(0);

/**
 * Find the shortest period at the end of `text` that satisfies `thresholds`.
 * `accept` can veto a candidate by its periodic-suffix start offset.
 */
export function findSuffixCycle(
  text: string,
  thresholds: CycleThresholds,
  accept?: (cycle: SuffixCycle) => boolean,
): SuffixCycle | null {
  const n = text.length;
  const minChars = Math.min(thresholds.shortMinChars, thresholds.longMinChars);
  if (n < minChars) return null;
  const maxUnit = Math.min(thresholds.maxUnit, Math.floor(n / 2));
  if (maxUnit < 1) return null;
  if (zScratch.length < maxUnit + 1) {
    zScratch = new Int32Array(maxUnit + 1);
  }
  const z = zScratch;
  const last = n - 1;
  // z[i] = length of the longest common suffix of text and text[0..n-i).
  let left = 0;
  let right = 0;
  for (let i = 1; i <= maxUnit; i += 1) {
    let zi = i <= right ? Math.min(right - i + 1, z[i - left]) : 0;
    while (
      i + zi < n &&
      text.charCodeAt(last - zi) === text.charCodeAt(last - i - zi)
    ) {
      zi += 1;
    }
    z[i] = zi;
    if (i + zi - 1 > right) {
      left = i;
      right = i + zi - 1;
    }
  }

  for (let unitLength = 1; unitLength <= maxUnit; unitLength += 1) {
    const repeatedLength = unitLength + z[unitLength];
    const copies = Math.floor(repeatedLength / unitLength);
    const isShort = unitLength <= thresholds.shortMaxUnit;
    const minCopies = isShort
      ? thresholds.shortMinCopies
      : thresholds.longMinCopies;
    const minRunChars = isShort
      ? thresholds.shortMinChars
      : thresholds.longMinChars;
    if (copies < minCopies || unitLength * copies < minRunChars) continue;
    // One extra character still lies inside the periodic run, so the window
    // holds the same characters as the unit, but an emoji split across the
    // unit boundary keeps both halves of its surrogate pair.
    const unitWindow = text.slice(n - unitLength - 1);
    if (
      !LETTER_OR_EMOJI_RE.test(unitWindow) &&
      unitLength * copies < thresholds.symbolOnlyMinChars
    ) {
      continue;
    }
    const cycle = { unitLength, copies, repeatedLength };
    if (accept && !accept(cycle)) continue;
    return cycle;
  }
  return null;
}

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Tracks whether a streamed Markdown text currently sits inside a fenced
 * code block (CommonMark: a closing fence uses the opening character and is
 * at least as long).
 */
class MarkdownFenceTracker {
  private openFence: string | null = null;
  private currentLine = "";

  push(delta: string): void {
    let start = 0;
    for (;;) {
      const newline = delta.indexOf("\n", start);
      if (newline === -1) {
        this.currentLine += delta.slice(start);
        return;
      }
      this.consumeLine(this.currentLine + delta.slice(start, newline));
      this.currentLine = "";
      start = newline + 1;
    }
  }

  get insideFence(): boolean {
    return this.openFence !== null;
  }

  private consumeLine(line: string): void {
    const match = FENCE_LINE_RE.exec(line);
    if (!match) return;
    const marker = match[1];
    if (this.openFence === null) {
      this.openFence = marker;
      return;
    }
    if (
      marker[0] === this.openFence[0] &&
      marker.length >= this.openFence.length &&
      line.slice(match[0].length).trim() === ""
    ) {
      this.openFence = null;
    }
  }
}

function containsFenceMarker(text: string): boolean {
  return text.includes("```") || text.includes("~~~");
}

export interface StreamCycleHit extends SuffixCycle {
  /** Offset in the full observed text where the periodic suffix starts. */
  repeatStartOffset: number;
  /** Total characters observed so far. */
  observedLength: number;
}

/**
 * Incremental exact-cycle detector over a stream of deltas. The caller feeds
 * every delta *before* showing it, so the delta that completes a loop is never
 * displayed.
 */
export class StreamCycleDetector {
  private tail = "";
  private observedLength = 0;
  private charsSinceScan = 0;
  private readonly fence: MarkdownFenceTracker | null;

  constructor(
    private readonly thresholds: CycleThresholds,
    options: { markdownAware?: boolean } = {},
  ) {
    this.fence = options.markdownAware ? new MarkdownFenceTracker() : null;
  }

  push(delta: string): StreamCycleHit | null {
    if (!delta) return null;
    this.tail += delta;
    this.observedLength += delta.length;
    this.charsSinceScan += delta.length;
    this.fence?.push(delta);
    if (
      this.charsSinceScan < this.thresholds.scanStride &&
      delta.length < this.thresholds.scanStride
    ) {
      return null;
    }
    return this.scan();
  }

  /** Final scan when the stream ends between two strides. */
  flush(): StreamCycleHit | null {
    return this.charsSinceScan > 0 ? this.scan() : null;
  }

  private scan(): StreamCycleHit | null {
    this.charsSinceScan = 0;
    if (this.tail.length > this.thresholds.windowChars) {
      this.tail = this.tail.slice(-this.thresholds.windowChars);
    }
    const cycle = this.detect();
    if (!cycle) return null;
    return {
      ...cycle,
      repeatStartOffset: this.observedLength - cycle.repeatedLength,
      observedLength: this.observedLength,
    };
  }

  private detect(): SuffixCycle | null {
    if (!this.fence?.insideFence) {
      return findSuffixCycle(this.tail, this.thresholds);
    }
    // Inside an open fence a run that contains no fence marker is pure code:
    // judge it as structured content. A run that does span fence markers is
    // repeating whole blocks together with their surrounding prose.
    const tail = this.tail;
    const regionOf = (cycle: SuffixCycle) =>
      tail.slice(tail.length - cycle.repeatedLength);
    return (
      findSuffixCycle(tail, STRUCTURED_CYCLE_THRESHOLDS) ??
      findSuffixCycle(tail, this.thresholds, (cycle) =>
        containsFenceMarker(regionOf(cycle)),
      )
    );
  }
}

export interface ToolCallLike {
  name?: unknown;
  args?: unknown;
}

const VOLATILE_TOOL_ARGUMENT_KEYS = new Set(["intent"]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeToolArguments(args: unknown): unknown {
  let parsed = args;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return parsed;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!VOLATILE_TOOL_ARGUMENT_KEYS.has(key)) normalized[key] = value;
  }
  return normalized;
}

/**
 * Identity of a tool call for repetition checks: the tool name plus its
 * arguments as key-order-independent JSON, ignoring the free-text `intent`.
 */
export function toolCallKey(call: ToolCallLike): string {
  const name = typeof call?.name === "string" ? call.name : "";
  return `${name}\u0000${canonicalJson(normalizeToolArguments(call?.args))}`;
}

export interface RepeatedToolCall {
  toolName: string;
  copies: number;
}

/** Identical calls in one response that trip the guard (two are allowed). */
export const REPEATED_TOOL_CALL_MIN_COPIES = 3;

export interface RepeatedToolCallOptions<T> {
  minCopies?: number;
  /**
   * Calls whose identity is unknown (e.g. arguments that failed to parse)
   * must not be compared: they would all share the same empty key.
   */
  isComparable?: (call: T) => boolean;
}

/** Repetition key per call; `null` for calls that must not be compared. */
function comparableToolCallKeys<T extends ToolCallLike>(
  calls: readonly T[],
  isComparable: ((call: T) => boolean) | undefined,
): Array<string | null> {
  return calls.map((call) =>
    !isComparable || isComparable(call) ? toolCallKey(call) : null,
  );
}

/** First tool call repeated at least `minCopies` times within one response. */
export function findRepeatedToolCall<T extends ToolCallLike>(
  calls: readonly T[],
  options: RepeatedToolCallOptions<T> = {},
): RepeatedToolCall | null {
  const minCopies = options.minCopies ?? REPEATED_TOOL_CALL_MIN_COPIES;
  const keys = comparableToolCallKeys(calls, options.isComparable);
  const counts = new Map<string, { toolName: string; copies: number }>();
  for (let index = 0; index < calls.length; index += 1) {
    const key = keys[index];
    if (key === null) continue;
    const call = calls[index];
    const entry = counts.get(key) ?? {
      toolName: typeof call?.name === "string" ? call.name : "",
      copies: 0,
    };
    entry.copies += 1;
    counts.set(key, entry);
  }
  for (const entry of counts.values()) {
    if (entry.copies >= minCopies) return entry;
  }
  return null;
}

/**
 * Keep only the first copy of every call repeated at least `minCopies` times.
 * Calls repeated fewer times are kept as-is, in their original order.
 */
export function collapseRepeatedToolCalls<T extends ToolCallLike>(
  calls: readonly T[],
  options: RepeatedToolCallOptions<T> = {},
): T[] {
  const minCopies = options.minCopies ?? REPEATED_TOOL_CALL_MIN_COPIES;
  const keys = comparableToolCallKeys(calls, options.isComparable);
  const counts = new Map<string, number>();
  for (const key of keys) {
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const kept = new Set<string>();
  return calls.filter((_call, index) => {
    const key = keys[index];
    if (key === null || (counts.get(key) ?? 0) < minCopies) return true;
    if (kept.has(key)) return false;
    kept.add(key);
    return true;
  });
}
