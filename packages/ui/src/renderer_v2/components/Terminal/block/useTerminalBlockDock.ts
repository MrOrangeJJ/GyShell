import { useLayoutEffect, useRef, useState } from "react";
import type { IBuffer, Terminal } from "@xterm/xterm";
import { measureTerminalRowHeight } from "../terminalFontOptions";
import {
  EMPTY_TERMINAL_DOCK_STATE,
  resolveTerminalDockWindow,
  terminalDockGeometry,
  terminalDockMaxRows,
  type TerminalDockAnchor,
  type TerminalDockState,
} from "./terminalDockModel";

const isBlankRow = (buffer: IBuffer, line: number): boolean =>
  !buffer.getLine(line)?.translateToString(true).trim();

/** Viewport row of the last visible content at or below the cursor. */
const findContentBottomRow = (
  buffer: IBuffer,
  rows: number,
  cursorRow: number,
): number => {
  for (let row = rows - 1; row > cursorRow; row -= 1) {
    if (!isBlankRow(buffer, buffer.viewportY + row)) return row;
  }
  return cursorRow;
};

/** Viewport row where the cursor's soft-wrapped logical line starts. */
const findLogicalStartRow = (buffer: IBuffer, cursorRow: number): number => {
  let line = buffer.viewportY + cursorRow;
  while (line > buffer.viewportY && buffer.getLine(line)?.isWrapped) line -= 1;
  return line - buffer.viewportY;
};

/**
 * What the Block view reads from the dock. A store rather than React state so
 * the view re-renders in the same frame the aperture moves (the seam between
 * the stream and the dock never lags), without re-rendering the host view.
 */
export interface TerminalDockSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TerminalDockState;
  /**
   * Where a wheel over the dock goes. The dock never scrolls (that would show
   * other rows through the aperture); the stream above is the history.
   */
  setWheelHandler: (handler?: (event: WheelEvent) => void) => void;
}

interface TerminalDockStore extends TerminalDockSource {
  publish: (state: TerminalDockState) => void;
  wheel: (event: WheelEvent) => void;
}

const createTerminalDockStore = (): TerminalDockStore => {
  let state = EMPTY_TERMINAL_DOCK_STATE;
  let wheelHandler: ((event: WheelEvent) => void) | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    setWheelHandler: (handler) => {
      wheelHandler = handler;
    },
    publish: (next) => {
      if (next.height === state.height && next.topLine === state.topLine)
        return;
      state = next;
      listeners.forEach((listener) => listener());
    },
    wheel: (event) => wheelHandler?.(event),
  };
};

/**
 * Docks the real xterm at the bottom of the Block view. The terminal is never
 * resized: the host is clipped to a bottom aperture and the mount is
 * translated so the prompt/running output sits inside it. The aperture grows
 * while a command runs and shrinks back to the prompt when idle.
 *
 * Returns a source for the aperture height (the space the Block view
 * reserves) and its first buffer line (where a running block continues live).
 */
export function useTerminalBlockDock(
  terminal: Terminal | null,
  host: HTMLDivElement | null,
  enabled: boolean,
  bottomInset = 0,
  getAnchor?: () => TerminalDockAnchor,
): TerminalDockSource {
  const [store] = useState(createTerminalDockStore);
  const getAnchorRef = useRef(getAnchor);
  getAnchorRef.current = getAnchor;

  useLayoutEffect(() => {
    const mount = terminal?.element?.parentElement;
    if (!terminal || !host || !mount || !enabled) {
      store.publish(EMPTY_TERMINAL_DOCK_STATE);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const buffer = terminal.buffer.active;
      if (buffer.type !== "normal") {
        host.style.clipPath = "";
        mount.style.transform = "";
        store.publish(EMPTY_TERMINAL_DOCK_STATE);
        return;
      }
      // Rows outside the aperture must never slide into it.
      if (buffer.viewportY !== buffer.baseY) terminal.scrollToBottom();
      const rowHeight = measureTerminalRowHeight(terminal);
      const available = Math.max(0, host.clientHeight - bottomInset);
      const anchor = getAnchorRef.current?.() ?? {};
      const toRow = (line?: number) =>
        line === undefined ? undefined : line - buffer.viewportY;
      const dockWindow = resolveTerminalDockWindow({
        cursorRow: buffer.cursorY,
        contentBottomRow: findContentBottomRow(
          buffer,
          terminal.rows,
          buffer.cursorY,
        ),
        logicalStartRow: findLogicalStartRow(buffer, buffer.cursorY),
        runningStartRow: toRow(anchor.runningStartLine),
        promptStartRow: toRow(anchor.promptStartLine),
        maxRows: terminalDockMaxRows(available, rowHeight),
      });
      const geometry = terminalDockGeometry(
        host.clientHeight,
        rowHeight,
        dockWindow,
        bottomInset,
      );
      host.style.clipPath = `inset(${geometry.clipTop}px 0 ${geometry.clipBottom}px)`;
      mount.style.transform = `translateY(${geometry.offset}px)`;
      store.publish({
        height: Math.round(geometry.height),
        topLine: buffer.viewportY + dockWindow.topRow,
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    terminal.scrollToBottom();
    update();
    const focusFrame = requestAnimationFrame(() => terminal.focus());
    const listeners = [
      terminal.onCursorMove(schedule),
      terminal.onWriteParsed(schedule),
      terminal.onResize(schedule),
      terminal.onScroll(() => {
        // Keyboard scrolling (Shift+PageUp) moves xterm's viewport; pin it
        // back before it paints. Deferred: xterm ignores a re-entrant scroll.
        const buffer = terminal.buffer.active;
        if (buffer.type === "normal" && buffer.viewportY !== buffer.baseY)
          queueMicrotask(() => terminal.scrollToBottom());
        schedule();
      }),
      terminal.buffer.onBufferChange(schedule),
    ];
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    // clip-path limits hit-testing to the aperture, so any press on the host
    // (including its side padding) is a press on the dock.
    const focusFromDock = (event: PointerEvent) => {
      if (!terminal.element?.contains(event.target as Node))
        requestAnimationFrame(() => terminal.focus());
    };
    // Captured before xterm's own scrollable element sees it: scrolling the
    // terminal would move other rows into the aperture. Apps that track the
    // mouse still get their wheel events.
    const redirectWheel = (event: WheelEvent) => {
      if (
        terminal.buffer.active.type !== "normal" ||
        terminal.modes.mouseTrackingMode !== "none"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      store.wheel(event);
    };
    host.addEventListener("pointerdown", focusFromDock);
    host.addEventListener("wheel", redirectWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      host.removeEventListener("pointerdown", focusFromDock);
      host.removeEventListener("wheel", redirectWheel, { capture: true });
      cancelAnimationFrame(frame);
      cancelAnimationFrame(focusFrame);
      observer.disconnect();
      listeners.forEach((listener) => listener.dispose());
      host.style.clipPath = "";
      mount.style.transform = "";
      store.publish(EMPTY_TERMINAL_DOCK_STATE);
    };
  }, [terminal, host, enabled, bottomInset, store]);
  return store;
}
