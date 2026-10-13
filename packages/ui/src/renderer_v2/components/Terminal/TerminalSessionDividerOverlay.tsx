import React from "react";
import type { Terminal, IMarker } from "@xterm/xterm";
import type { TerminalSessionBoundary } from "@gyshell/shared";
import type { AppLanguage } from "../../lib/ipcTypes";
import { measureTerminalRowHeight } from "./terminalFontOptions";
import "./terminalSessionDividerOverlay.scss";
import {
  isEmptySessionBetween,
  resolveSessionDividerRow,
} from "./terminalSessionDividerPlacement";

export interface TerminalSessionDividerLabels {
  title: string;
  resumedAt: string;
  lastCommand: string;
  exitCode: (code: number) => string;
}

function formatDividerTime(timestamp: number, locale: AppLanguage): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function TerminalSessionDividerOverlay({
  terminal,
  boundaries,
  markers,
  labels,
  locale,
}: {
  terminal: Terminal;
  boundaries: readonly TerminalSessionBoundary[];
  markers: ReadonlyMap<string, IMarker>;
  labels: TerminalSessionDividerLabels;
  locale: AppLanguage;
}) {
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);

  React.useEffect(() => {
    let frame = 0;
    const scheduleUpdate = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          forceUpdate();
        });
      }
    };

    const listeners = [
      terminal.onScroll(scheduleUpdate),
      terminal.onRender(scheduleUpdate),
      terminal.onResize(scheduleUpdate),
      terminal.buffer.onBufferChange(scheduleUpdate),
    ];

    return () => {
      cancelAnimationFrame(frame);
      listeners.forEach((listener) => listener.dispose());
    };
  }, [terminal]);

  if (!boundaries.length || terminal.buffer.active.type !== "normal") return null;

  const rowHeight = measureTerminalRowHeight(terminal);
  if (!rowHeight || rowHeight <= 0) return null;

  const activeBuffer = terminal.buffer.active;
  const placementBuffer = {
    viewportY: activeBuffer.viewportY,
    rows: terminal.rows,
    lineText: (line: number) =>
      activeBuffer.getLine(line)?.translateToString(true),
  };
  const markerFor = (index: number) => {
    const marker = markers.get(boundaries[index].id);
    return marker && !marker.isDisposed ? marker : undefined;
  };

  return (
    <div className="terminal-session-dividers" aria-hidden="true">
      {boundaries.map((boundary, index) => {
        const marker = markerFor(index);
        if (!marker) return null;
        const next =
          index + 1 < boundaries.length ? markerFor(index + 1) : undefined;
        if (
          next &&
          next.line >= marker.line &&
          isEmptySessionBetween(marker.line, next.line, placementBuffer.lineText)
        ) {
          return null;
        }

        // Only cover the reserved blank row; never hide terminal content.
        const row = resolveSessionDividerRow(marker.line, placementBuffer);
        if (row === undefined) return null;

        const top = row * rowHeight;
        const time = formatDividerTime(boundary.resumedAt, locale);
        const tooltip = `${labels.resumedAt}${time ? ` ${time}` : ""}${
          boundary.lastCommand
            ? `\n${labels.lastCommand}: ${boundary.lastCommand}${
                typeof boundary.exitCode === "number"
                  ? ` (${labels.exitCode(boundary.exitCode)})`
                  : ""
              }`
            : ""
        }`;

        return (
          <div
            key={boundary.id}
            className="terminal-session-divider"
            style={{ top, height: rowHeight }}
          >
            <div className="terminal-session-divider-rule is-left" />
            <div className="terminal-session-divider-content" title={tooltip}>
              <span className="terminal-session-divider-title">
                {labels.title}
              </span>
              {time ? (
                <>
                  <span className="terminal-session-divider-dot">·</span>
                  <span className="terminal-session-divider-time">{time}</span>
                </>
              ) : null}
            </div>
            <div className="terminal-session-divider-rule is-right" />
          </div>
        );
      })}
    </div>
  );
}
