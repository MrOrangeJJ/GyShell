import React from "react";
import type { Terminal } from "@xterm/xterm";
import { blockStatusLabel, type TerminalBlockLabels } from "./block/blockLabels";
import type { TerminalCommandAnnotation } from "./block/terminalBlockModel";
import { useTerminalRowHeight } from "./terminalFontOptions";
import "./terminalCommandMarks.scss";

/** Gutter marks on command rows in the Classic view; a click opens the block. */

export function TerminalCommandMarks({
  terminal,
  annotations,
  selectedId,
  labels,
  onInspect,
}: {
  terminal: Terminal;
  annotations: readonly TerminalCommandAnnotation[];
  selectedId?: string;
  labels: TerminalBlockLabels;
  onInspect: (id: string) => void;
}) {
  const [, refresh] = React.useReducer((value) => value + 1, 0);
  const rowHeight = useTerminalRowHeight(terminal);
  React.useEffect(() => {
    let frame = 0;
    const update = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          refresh();
        });
    };
    const listeners = [
      terminal.onScroll(update),
      terminal.onRender(update),
      terminal.onResize(update),
      terminal.buffer.onBufferChange(update),
    ];
    return () => {
      cancelAnimationFrame(frame);
      listeners.forEach((listener) => listener.dispose());
    };
  }, [terminal]);
  if (terminal.buffer.active.type !== "normal") return null;
  return (
    <div className="terminal-command-marks">
      {annotations.map(({ id, startLine, activity, bufferPreview }) => {
        const row = startLine - terminal.buffer.active.viewportY;
        if (row < 0 || row >= terminal.rows || !rowHeight) return null;
        const status = blockStatusLabel(activity.status, labels);
        const exit =
          activity.exitCode === undefined
            ? ""
            : ` (${labels.exitCode(activity.exitCode)})`;
        const description = `${labels.openBlock}: ${activity.actor === "agent" ? labels.agent : labels.user} - ${activity.intent || activity.command || bufferPreview || labels.output}; ${status}${exit}`;
        return (
          <button
            key={id}
            type="button"
            className={`terminal-command-mark is-${activity.actor} is-${activity.status}${selectedId === id ? " is-selected" : ""}`}
            style={{ top: row * rowHeight, height: rowHeight }}
            title={description}
            aria-label={description}
            onClick={() => onInspect(id)}
          >
            <span
              style={{ height: Math.max(1, Math.min(11, rowHeight - 4)) }}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}
