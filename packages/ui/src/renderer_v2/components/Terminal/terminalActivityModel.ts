import type { TerminalActivitySnapshot } from "@gyshell/shared";

export const TERMINAL_ACTIVITY_RENDER_LIMIT = 300;

/** Prefer unfinished work to a more recent completed command. */
export const selectTerminalActivityContext = (
  activities: readonly TerminalActivitySnapshot[],
): TerminalActivitySnapshot | undefined => {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index].status === "running") return activities[index];
  }
  return activities.at(-1);
};

export const mergeTerminalActivities = (
  current: readonly TerminalActivitySnapshot[],
  incoming: readonly TerminalActivitySnapshot[],
): TerminalActivitySnapshot[] => {
  const byId = new Map(current.map((activity) => [activity.id, activity]));
  for (const candidate of incoming) {
    const existing = byId.get(candidate.id);
    if (
      existing &&
      (existing.revision > candidate.revision ||
        (existing.revision === candidate.revision &&
          existing.updatedAt >= candidate.updatedAt))
    ) {
      continue;
    }
    byId.set(candidate.id, candidate);
  }
  return Array.from(byId.values())
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id),
    )
    .slice(-TERMINAL_ACTIVITY_RENDER_LIMIT);
};

export const formatTerminalActivityDuration = (
  activity: TerminalActivitySnapshot,
  now = Date.now(),
): string => {
  const elapsed = Math.max(0, (activity.endedAt ?? now) - activity.startedAt);
  if (elapsed < 1000) return `${elapsed}ms`;
  if (elapsed < 60_000)
    return `${(elapsed / 1000).toFixed(elapsed < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
};

export const getTerminalActivityCommandPreview = (
  activity: TerminalActivitySnapshot,
): string | undefined => {
  const command = activity.command?.replace(/\s+/g, " ").trim();
  if (!command) return undefined;
  return command.length > 180 ? `${command.slice(0, 179)}…` : command;
};
