import React from "react";
import type { Terminal, IMarker } from "@xterm/xterm";
import type {
  TerminalActivitySnapshot,
  TerminalSessionBoundary,
} from "@gyshell/shared";
import type { TerminalActivityRuntime } from "./terminalActivityRuntime";
import type { TerminalMarkerRegistry } from "./terminalMarkerRegistry";
import type { TerminalRecoveryMetadata } from "./terminalRecoveryMetadata";

export interface TerminalActivityMarkerRange {
  start?: IMarker;
  end?: IMarker;
  endAtLineStart?: boolean;
}

export interface TerminalActivitiesRuntime extends TerminalActivityRuntime {
  term: Terminal;
  activityMarkers: Map<string, TerminalActivityMarkerRange>;
  markerRegistry: Pick<
    TerminalMarkerRegistry,
    "boundaryMarkers" | "getOffsetAnchor" | "registerBoundaryFromAnchor"
  >;
  activityMarkerLayoutListener?: () => void;
}

export interface TerminalActivitiesState {
  activities: TerminalActivitySnapshot[];
  sessionBoundaries: readonly TerminalSessionBoundary[];
  blockFocusRequest?: { activityId: string; revision: number };
  selectedCommandId?: string;
  activityLayoutRevision: number;
  setBlockFocusRequest: React.Dispatch<
    React.SetStateAction<{ activityId: string; revision: number } | undefined>
  >;
  setSelectedCommandId: React.Dispatch<React.SetStateAction<string | undefined>>;
}

/** Binds the live activity stream and recovered metadata to one runtime. */
export const useTerminalActivities = (
  runtimeRef: React.MutableRefObject<TerminalActivitiesRuntime | null>,
  terminalId: string,
  runtimeSignal: Terminal | null,
): TerminalActivitiesState => {
  const [activities, setActivities] = React.useState<
    TerminalActivitySnapshot[]
  >([]);
  const [sessionBoundaries, setSessionBoundaries] = React.useState<
    readonly TerminalSessionBoundary[]
  >([]);
  const [blockFocusRequest, setBlockFocusRequest] = React.useState<{
    activityId: string;
    revision: number;
  }>();
  const [selectedCommandId, setSelectedCommandId] = React.useState<string>();
  const [activityLayoutRevision, setActivityLayoutRevision] = React.useState(0);

  React.useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.term !== runtimeSignal) return;

    let disposed = false;
    let activityLayoutFrame: number | null = null;
    const runningActivityIds = new Set<string>();
    let lastActivityLayoutRows = runtime.term.rows;
    let lastActivityLayoutHeight =
      runtime.term.element?.querySelector<HTMLElement>(".xterm-screen")
        ?.clientHeight ?? 0;

    setActivities([]);
    setSessionBoundaries([]);
    setBlockFocusRequest(undefined);
    setSelectedCommandId(undefined);

    const requestActivityLayout = (force = false) => {
      if (
        disposed ||
        activityLayoutFrame !== null ||
        (!force && runtime.activityMarkers.size === 0)
      ) {
        return;
      }
      activityLayoutFrame = window.requestAnimationFrame(() => {
        activityLayoutFrame = null;
        if (!disposed) {
          setActivityLayoutRevision((revision) => revision + 1);
        }
      });
    };

    const applyMetadata = ({
      activities: nextActivities,
      sessionBoundaries: boundaries,
    }: TerminalRecoveryMetadata): void => {
      if (disposed) return;
      runningActivityIds.clear();
      for (const activity of nextActivities) {
        if (activity.status === "running") runningActivityIds.add(activity.id);
      }
      setActivities(nextActivities);
      setSessionBoundaries(boundaries);
      for (const boundary of boundaries) {
        if (runtime.markerRegistry.boundaryMarkers.has(boundary.id)) continue;
        const anchor = runtime.markerRegistry.getOffsetAnchor(boundary.offset);
        if (anchor) {
          runtime.markerRegistry.registerBoundaryFromAnchor(
            boundary.id,
            anchor.marker,
          );
        }
      }
      requestActivityLayout(true);
    };
    const layoutListener = () => requestActivityLayout(true);
    runtime.activityMarkerLayoutListener = layoutListener;
    runtime.activityMetadataListener = applyMetadata;

    // The runtime keeps receiving activities while its React host is absent.
    // Read its latest snapshot without clearing any of the retained markers.
    if (runtime.recoveryMetadata) applyMetadata(runtime.recoveryMetadata);

    const scrollDisposable = runtime.term.onScroll(() =>
      requestActivityLayout(),
    );
    const resizeDisposable = runtime.term.onResize(() =>
      requestActivityLayout(true),
    );
    const renderDisposable = runtime.term.onRender(() => {
      const nextRows = runtime.term.rows;
      const nextHeight =
        runtime.term.element?.querySelector<HTMLElement>(".xterm-screen")
          ?.clientHeight ?? 0;
      const geometryChanged =
        nextRows !== lastActivityLayoutRows ||
        nextHeight !== lastActivityLayoutHeight;
      lastActivityLayoutRows = nextRows;
      lastActivityLayoutHeight = nextHeight;
      if (runningActivityIds.size > 0 || geometryChanged) {
        requestActivityLayout();
      }
    });
    const bufferDisposable = runtime.term.buffer.onBufferChange(() =>
      requestActivityLayout(true),
    );

    return () => {
      disposed = true;
      if (activityLayoutFrame !== null) {
        window.cancelAnimationFrame(activityLayoutFrame);
      }
      if (runtime.activityMarkerLayoutListener === layoutListener) {
        runtime.activityMarkerLayoutListener = undefined;
      }
      if (runtime.activityMetadataListener === applyMetadata) {
        runtime.activityMetadataListener = undefined;
      }
      scrollDisposable.dispose();
      resizeDisposable.dispose();
      renderDisposable.dispose();
      bufferDisposable.dispose();
    };
  }, [runtimeRef, runtimeSignal, terminalId]);

  return {
    activities,
    sessionBoundaries,
    blockFocusRequest,
    selectedCommandId,
    activityLayoutRevision,
    setBlockFocusRequest,
    setSelectedCommandId,
  };
};
