import type { IMarker } from "@xterm/xterm";

interface TerminalMarkerHost {
  readonly buffer: {
    readonly active: {
      readonly type: "normal" | "alternate";
      readonly baseY: number;
      readonly cursorY: number;
      readonly cursorX: number;
    };
  };
  registerMarker: (lineOffset: number) => IMarker | undefined;
}

export interface TerminalOffsetAnchor {
  marker: IMarker;
  atLineStart: boolean;
}

export interface TerminalMarkerRegistry {
  readonly boundaryMarkers: Map<string, IMarker>;
  readonly offsetAnchors: Map<number, IMarker>;
  registerBoundary: (id: string, lineOffset?: number) => IMarker | undefined;
  registerBoundaryFromAnchor: (
    id: string,
    anchor: IMarker,
    lineOffset?: number,
  ) => IMarker | undefined;
  rememberOffsetAnchor: (offset: number) => IMarker | undefined;
  getOffsetAnchor: (offset: number) => TerminalOffsetAnchor | undefined;
  clearOffsetAnchors: () => void;
  dispose: () => void;
}

/**
 * Owns every marker that the renderer creates outside xterm's parser.
 *
 * Boundary markers and offset anchors deliberately have separate lifetimes:
 * xterm may evict an offset anchor from its scrollback while a divider still
 * points at the same logical row. Never return an offset anchor as a divider
 * marker or wrap it with a fake disposer.
 */
export const createTerminalMarkerRegistry = (
  terminal: TerminalMarkerHost,
  offsetAnchorLimit = 64,
): TerminalMarkerRegistry => {
  const boundaryMarkers = new Map<string, IMarker>();
  const offsetAnchors = new Map<number, IMarker>();
  const offsetAnchorAtLineStart = new WeakMap<IMarker, boolean>();
  let disposed = false;

  const registerOwnedMarker = (
    targetLine: number,
    onDispose: (marker: IMarker) => void,
  ): IMarker | undefined => {
    if (disposed || terminal.buffer.active.type !== "normal") return undefined;
    const cursorLine =
      terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
    if (!Number.isFinite(cursorLine)) return undefined;
    const marker = terminal.registerMarker(Math.floor(targetLine) - cursorLine);
    if (!marker) return undefined;
    marker.onDispose(() => onDispose(marker));
    return marker;
  };

  const getLiveBoundary = (id: string): IMarker | undefined => {
    const current = boundaryMarkers.get(id);
    if (!current) return undefined;
    if (!current.isDisposed) return current;
    if (boundaryMarkers.get(id) === current) boundaryMarkers.delete(id);
    return undefined;
  };

  const registerBoundaryAtLine = (
    id: string,
    targetLine: number,
  ): IMarker | undefined => {
    const existing = getLiveBoundary(id);
    if (existing) return existing;
    const marker = registerOwnedMarker(targetLine, (disposedMarker) => {
      if (boundaryMarkers.get(id) === disposedMarker) {
        boundaryMarkers.delete(id);
      }
    });
    if (marker) boundaryMarkers.set(id, marker);
    return marker;
  };

  const registerBoundary = (
    id: string,
    lineOffset = 1,
  ): IMarker | undefined => {
    if (!id || disposed || terminal.buffer.active.type !== "normal") {
      return undefined;
    }
    const cursorLine =
      terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
    return registerBoundaryAtLine(id, cursorLine + lineOffset);
  };

  const registerBoundaryFromAnchor = (
    id: string,
    anchor: IMarker,
    lineOffset = 1,
  ): IMarker | undefined => {
    if (!id || disposed || anchor.isDisposed) return undefined;
    // This creates a new xterm marker at the target row. The anchor remains
    // owned by the offset-anchor map and can be evicted independently.
    return registerBoundaryAtLine(id, anchor.line + lineOffset);
  };

  const rememberOffsetAnchor = (offset: number): IMarker | undefined => {
    if (disposed || terminal.buffer.active.type !== "normal") return undefined;
    const normalizedOffset = Math.max(0, Math.floor(offset));
    const existing = offsetAnchors.get(normalizedOffset);
    if (existing && !existing.isDisposed) return existing;
    if (existing?.isDisposed && offsetAnchors.get(normalizedOffset) === existing) {
      offsetAnchors.delete(normalizedOffset);
    }

    const marker = terminal.registerMarker(0);
    if (!marker) return undefined;
    offsetAnchors.set(normalizedOffset, marker);
    offsetAnchorAtLineStart.set(
      marker,
      terminal.buffer.active.cursorX === 0,
    );
    marker.onDispose(() => {
      if (offsetAnchors.get(normalizedOffset) === marker) {
        offsetAnchors.delete(normalizedOffset);
      }
    });

    while (offsetAnchors.size > offsetAnchorLimit) {
      const oldest = offsetAnchors.entries().next().value as
        | [number, IMarker]
        | undefined;
      if (!oldest) break;
      offsetAnchors.delete(oldest[0]);
      if (!oldest[1].isDisposed) oldest[1].dispose();
    }
    return marker;
  };

  const getOffsetAnchor = (offset: number): TerminalOffsetAnchor | undefined => {
    const marker = offsetAnchors.get(Math.max(0, Math.floor(offset)));
    if (!marker || marker.isDisposed) return undefined;
    return { marker, atLineStart: offsetAnchorAtLineStart.get(marker) === true };
  };

  const clearOffsetAnchors = (): void => {
    const anchors = [...offsetAnchors.values()];
    offsetAnchors.clear();
    for (const marker of anchors) {
      if (!marker.isDisposed) marker.dispose();
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const markers = [...boundaryMarkers.values()];
    boundaryMarkers.clear();
    for (const marker of markers) {
      if (!marker.isDisposed) marker.dispose();
    }
    clearOffsetAnchors();
  };

  return {
    boundaryMarkers,
    offsetAnchors,
    registerBoundary,
    registerBoundaryFromAnchor,
    rememberOffsetAnchor,
    getOffsetAnchor,
    clearOffsetAnchors,
    dispose,
  };
};
