import {
  TERMINAL_ACTIVITY_COMMAND_PREVIEW_MAX_UTF8_BYTES,
  TERMINAL_ACTIVITY_INTENT_MAX_CHARACTERS,
  type TerminalActivityActor,
  type TerminalActivityOrigin,
  type TerminalActivitySnapshot,
  type TerminalActivityStatus,
} from "@gyshell/shared";
import { truncateUtf8 } from "./utf8Text";

/** Shared by the in-memory projection and durable Activity retention. */
export const TERMINAL_ACTIVITY_RETENTION_MAX_RECORDS = 300;
const COMMAND_PREVIEW_TRUNCATION_SUFFIX = "… [truncated]";

type ActivityStartedInput = {
  id: string;
  terminalId: string;
  actor: TerminalActivityActor;
  origin: TerminalActivityOrigin;
  startedAt: number;
  startOffset: number;
  command?: string;
  intent?: string;
  runtimeGeneration?: number;
  shellSequence?: number;
  sessionId?: string;
  messageId?: string;
};

type ActivityFinishedInput = {
  terminalId: string;
  activityId: string;
  status: Exclude<TerminalActivityStatus, "running">;
  endedAt: number;
  endOffset: number;
  exitCode?: number;
};

type TerminalActivityChangeListener = (
  activity: TerminalActivitySnapshot,
) => void;

const cloneActivity = (
  activity: TerminalActivitySnapshot,
): TerminalActivitySnapshot => ({ ...activity });

const normalizeIntent = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized = Array.from(
    value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim(),
  )
    .slice(0, TERMINAL_ACTIVITY_INTENT_MAX_CHARACTERS)
    .join("");
  return normalized || undefined;
};

export class TerminalActivityStore {
  private readonly activitiesByTerminal = new Map<
    string,
    TerminalActivitySnapshot[]
  >();
  private readonly activityById = new Map<string, TerminalActivitySnapshot>();

  constructor(
    private readonly onChange?: TerminalActivityChangeListener,
    private readonly maxActivitiesPerTerminal = TERMINAL_ACTIVITY_RETENTION_MAX_RECORDS,
  ) {}

  start(input: ActivityStartedInput): TerminalActivitySnapshot {
    const existing = this.activityById.get(input.id);
    if (existing) return cloneActivity(existing);

    const command = input.command
      ? truncateUtf8(
          input.command,
          TERMINAL_ACTIVITY_COMMAND_PREVIEW_MAX_UTF8_BYTES,
          COMMAND_PREVIEW_TRUNCATION_SUFFIX,
        )
      : undefined;
    const intent = normalizeIntent(input.intent);
    const activity: TerminalActivitySnapshot = {
      id: input.id,
      terminalId: input.terminalId,
      kind: "command",
      actor: input.actor,
      origin: input.origin,
      status: "running",
      revision: 1,
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      startOffset: input.startOffset,
      ...(command ? { command } : {}),
      ...(intent ? { intent } : {}),
      ...(input.runtimeGeneration !== undefined
        ? { runtimeGeneration: input.runtimeGeneration }
        : {}),
      ...(input.shellSequence !== undefined
        ? { shellSequence: input.shellSequence }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
    };
    const activities = this.activitiesByTerminal.get(input.terminalId) || [];
    activities.push(activity);
    this.activitiesByTerminal.set(input.terminalId, activities);
    this.activityById.set(activity.id, activity);
    this.enforceRetention(input.terminalId);
    this.emit(activity);
    return cloneActivity(activity);
  }

  finish(input: ActivityFinishedInput): TerminalActivitySnapshot | undefined {
    const current = this.activityById.get(input.activityId);
    if (!current || current.terminalId !== input.terminalId) return undefined;
    if (current.status !== "running") return cloneActivity(current);

    const next: TerminalActivitySnapshot = {
      ...current,
      status: input.status,
      revision: current.revision + 1,
      updatedAt: input.endedAt,
      endedAt: input.endedAt,
      endOffset: Math.max(current.startOffset, input.endOffset),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    };
    this.replace(current, next);
    this.enforceRetention(input.terminalId);
    this.emit(next);
    return cloneActivity(next);
  }

  hydrate(activities: readonly TerminalActivitySnapshot[]): void {
    const terminalIds = new Set(
      activities.map((activity) => activity.terminalId),
    );
    for (const terminalId of terminalIds) {
      this.clearTerminal(terminalId);
    }

    for (const activity of activities) {
      const next = cloneActivity(activity);
      const entries = this.activitiesByTerminal.get(next.terminalId) || [];
      entries.push(next);
      this.activitiesByTerminal.set(next.terminalId, entries);
      this.activityById.set(next.id, next);
    }

    for (const terminalId of terminalIds) {
      this.enforceRetention(terminalId);
    }
  }

  list(terminalId: string): TerminalActivitySnapshot[] {
    return (this.activitiesByTerminal.get(terminalId) || []).map(cloneActivity);
  }

  get(activityId: string): TerminalActivitySnapshot | undefined {
    const activity = this.activityById.get(activityId);
    return activity ? cloneActivity(activity) : undefined;
  }

  clearTerminal(terminalId: string): void {
    const activities = this.activitiesByTerminal.get(terminalId);
    if (!activities) return;
    for (const activity of activities) {
      this.activityById.delete(activity.id);
    }
    this.activitiesByTerminal.delete(terminalId);
  }

  private replace(
    current: TerminalActivitySnapshot,
    next: TerminalActivitySnapshot,
  ): void {
    const activities = this.activitiesByTerminal.get(current.terminalId);
    const index =
      activities?.findIndex((entry) => entry.id === current.id) ?? -1;
    if (activities && index >= 0) activities[index] = next;
    this.activityById.set(next.id, next);
  }

  private enforceRetention(terminalId: string): void {
    const activities = this.activitiesByTerminal.get(terminalId);
    if (!activities) return;
    const maxRecords = Math.max(1, Math.floor(this.maxActivitiesPerTerminal));
    while (activities.length > maxRecords) {
      const evictableIndex = activities.findIndex(
        (activity) => activity.status !== "running",
      );
      if (evictableIndex < 0) break;
      const [evicted] = activities.splice(evictableIndex, 1);
      if (evicted) this.activityById.delete(evicted.id);
    }
  }

  private emit(activity: TerminalActivitySnapshot): void {
    this.onChange?.(cloneActivity(activity));
  }
}
