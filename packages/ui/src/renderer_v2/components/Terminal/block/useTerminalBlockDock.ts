import { useLayoutEffect, useRef, useState } from "react";
import type { IBuffer, Terminal } from "@xterm/xterm";
import { measureTerminalRowHeight } from "../terminalFontOptions";
import {
  resolveTerminalDockWindow,
  terminalDockGeometry,
  terminalDockMaxRows,
  type TerminalDockAnchor,
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
 * Docks the real xterm at the bottom of the Block view. The terminal is never
 * resized: the host is clipped to a bottom aperture and the mount is
 * translated so the prompt/running output sits inside it. The aperture grows
 * while a command runs and shrinks back to the prompt when idle.
 *
 * Returns the aperture height in px so the Block view can reserve space.
 */
export function useTerminalBlockDock(
  terminal: Terminal | null,
  host: HTMLDivElement | null,
  enabled: boolean,
  bottomInset = 0,
  getAnchor?: () => TerminalDockAnchor,
) {
  const [height, setHeight] = useState(0);
  const getAnchorRef = useRef(getAnchor);
  getAnchorRef.current = getAnchor;

  useLayoutEffect(() => {
    const mount = terminal?.element?.parentElement;
    if (!terminal || !host || !mount || !enabled) {
      setHeight(0);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const buffer = terminal.buffer.active;
      if (buffer.type !== "normal") {
        host.style.clipPath = "";
        mount.style.transform = "";
        setHeight(0);
        return;
      }
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
      setHeight(Math.round(geometry.height));
      host.style.clipPath = `inset(${geometry.clipTop}px 0 ${geometry.clipBottom}px)`;
      mount.style.transform = `translateY(${geometry.offset}px)`;
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
      terminal.buffer.onBufferChange(schedule),
      terminal.onScroll(() => {
        if (
          terminal.buffer.active.type === "normal" &&
          terminal.buffer.active.viewportY !== terminal.buffer.active.baseY
        )
          terminal.scrollToBottom();
      }),
    ];
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    // clip-path limits hit-testing to the aperture, so any press on the host
    // (including its side padding) is a press on the dock.
    const focusFromDock = (event: PointerEvent) => {
      if (!terminal.element?.contains(event.target as Node))
        requestAnimationFrame(() => terminal.focus());
    };
    host.addEventListener("pointerdown", focusFromDock);
    return () => {
      host.removeEventListener("pointerdown", focusFromDock);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(focusFrame);
      observer.disconnect();
      listeners.forEach((listener) => listener.dispose());
      host.style.clipPath = "";
      mount.style.transform = "";
    };
  }, [terminal, host, enabled, bottomInset]);
  return height;
}
