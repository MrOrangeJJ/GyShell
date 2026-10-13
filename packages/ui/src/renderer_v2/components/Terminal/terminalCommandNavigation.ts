import type { TerminalCommandAnnotation } from "./block/terminalBlockModel";
import {
  findTextMatches,
  splitTextForHighlights,
  type HighlightSegment,
  type TextSearchMatch,
} from "../../lib/textSearch";

const searchTokens = (query: string): string[] => [
  ...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean)),
];

export const getTerminalCommandSearchHighlights = (
  text: string,
  query: string,
): HighlightSegment[] => {
  const matches = searchTokens(query)
    .flatMap((token) => findTextMatches(text, token))
    .sort((left, right) => left.start - right.start);
  const merged: TextSearchMatch[] = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (previous && match.start <= previous.end) {
      previous.end = Math.max(previous.end, match.end);
    } else {
      merged.push({ ...match });
    }
  }
  // Keep the first match visible even inside a long, otherwise truncated command.
  const offset = Math.max(0, (merged[0]?.start || 0) - 12);
  const segments = splitTextForHighlights(
    text.slice(offset),
    merged.map(({ start, end }) => ({
      start: start - offset,
      end: end - offset,
    })),
  );
  return offset ? [{ text: "...", match: false }, ...segments] : segments;
};

/** Only retained marker rows are navigable; rewritten rows belong to the latest boundary. */
export const getNavigableTerminalAnnotations = (
  annotations: readonly TerminalCommandAnnotation[],
): TerminalCommandAnnotation[] => {
  const byLine = new Map<number, TerminalCommandAnnotation>();
  for (const annotation of annotations) {
    const startLine = Math.floor(annotation.startLine);
    if (!Number.isSafeInteger(startLine) || startLine < 0) continue;
    byLine.set(
      startLine,
      startLine === annotation.startLine
        ? annotation
        : { ...annotation, startLine },
    );
  }
  return [...byLine.values()].sort(
    (left, right) => left.startLine - right.startLine,
  );
};

/** Search retained evidence without guessing shell syntax or treating an unknown outcome as failure. */
export const filterTerminalCommands = (
  annotations: readonly TerminalCommandAnnotation[],
  query: string,
  issuesOnly: boolean,
): TerminalCommandAnnotation[] => {
  const tokens = searchTokens(query);
  return getNavigableTerminalAnnotations(annotations)
    .filter(({ activity, bufferPreview }) => {
      if (
        issuesOnly &&
        activity.status !== "failed" &&
        activity.status !== "aborted" &&
        activity.status !== "outcome-unknown"
      ) {
        return false;
      }
      const searchable =
        `${activity.intent || ""}\n${activity.command || ""}\n${bufferPreview || ""}`.toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    })
    .reverse();
};
