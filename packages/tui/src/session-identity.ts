import { readOpaqueNonBlankWellFormedString } from "@gyshell/shared";
import type {
  GatewaySessionSnapshot,
  GatewaySessionSummary,
} from "./protocol";

export const readTuiSessionId = (value: unknown): string | undefined =>
  readOpaqueNonBlankWellFormedString(value);

export const requireTuiSessionId = (value: unknown): string => {
  const sessionId = readTuiSessionId(value);
  if (sessionId === undefined) throw new Error("Session id is required.");
  return sessionId;
};

export const createTuiSessionRecord = <T>(): Record<string, T> =>
  Object.create(null) as Record<string, T>;

export const normalizeTuiSessionSummaries = (
  value: unknown,
): GatewaySessionSummary[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const summaries: GatewaySessionSummary[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return undefined;
    const sessionId = readTuiSessionId((candidate as { id?: unknown }).id);
    if (sessionId === undefined) return undefined;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    summaries.push({ ...(candidate as GatewaySessionSummary), id: sessionId });
  }
  return summaries;
};

export const readMatchingTuiSessionSnapshot = (
  value: unknown,
  expectedSessionId: unknown,
): GatewaySessionSnapshot | undefined => {
  const expected = readTuiSessionId(expectedSessionId);
  if (expected === undefined || !value || typeof value !== "object") {
    return undefined;
  }
  const actual = readTuiSessionId((value as { id?: unknown }).id);
  if (actual !== expected) return undefined;
  return { ...(value as GatewaySessionSnapshot), id: actual };
};
