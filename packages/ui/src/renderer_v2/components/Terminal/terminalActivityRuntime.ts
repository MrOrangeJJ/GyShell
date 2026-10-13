import type { TerminalActivitySnapshot } from "@gyshell/shared";
import { mergeTerminalActivities } from "./terminalActivityModel";
import type { TerminalRecoveryMetadata } from "./terminalRecoveryMetadata";

export interface TerminalActivityRuntime {
  terminalId: string;
  /** Latest recovered and live metadata, retained with the xterm runtime. */
  recoveryMetadata?: TerminalRecoveryMetadata;
  scheduleActivityMarker: (
    activity: TerminalActivitySnapshot,
    edge: "start" | "end",
  ) => void;
  clearActivityMarker: (activityId: string) => void;
  activityMetadataListener?: (metadata: TerminalRecoveryMetadata) => void;
}

type SubscribeToActivities = (
  listener: (event: { activity: TerminalActivitySnapshot }) => void,
) => () => void;

/**
 * Activity subscriptions have the same lifetime as the retained xterm, not
 * its React host. Commands can finish while a panel is detached; remounting
 * must preserve their latest state and the markers placed as output arrived.
 */
export const createTerminalActivityRuntime = (
  runtime: TerminalActivityRuntime,
  subscribe?: SubscribeToActivities,
): { recover: (metadata: TerminalRecoveryMetadata) => void; dispose: () => void } => {
  let disposed = false;
  const recover = (metadata: TerminalRecoveryMetadata): void => {
    if (disposed) return;
    const previous = runtime.recoveryMetadata?.activities ?? [];
    const activities = mergeTerminalActivities(previous, metadata.activities);
    const retainedIds = new Set(activities.map((activity) => activity.id));
    const next = { activities, sessionBoundaries: metadata.sessionBoundaries };
    runtime.recoveryMetadata = next;
    for (const activity of previous) {
      if (!retainedIds.has(activity.id)) runtime.clearActivityMarker(activity.id);
    }
    for (const activity of activities) {
      runtime.scheduleActivityMarker(activity, "start");
      if (activity.status !== "running") {
        runtime.scheduleActivityMarker(activity, "end");
      }
    }
    runtime.activityMetadataListener?.(next);
  };
  const unsubscribe = subscribe?.(({ activity }) => {
    if (activity.terminalId !== runtime.terminalId) return;
    recover({
      activities: [activity],
      sessionBoundaries: runtime.recoveryMetadata?.sessionBoundaries ?? [],
    });
  });
  return {
    recover,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
    },
  };
};
