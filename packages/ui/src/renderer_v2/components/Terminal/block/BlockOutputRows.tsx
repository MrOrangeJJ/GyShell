import React from "react";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { TerminalBlockLabels } from "./blockLabels";
import { blockRunStyle } from "./blockRunStyle";
import { readTerminalBlockRow } from "./terminalBlockModel";

interface BlockOutputRowsProps {
  terminal: Terminal;
  start: number;
  end: number;
  /** Memo key: rows re-read when the width changes. */
  cols: number;
  theme: ITheme;
  /** Buffer revision for live blocks; constant for settled ones. */
  version: number;
}

/**
 * Output rows in terminal colours. Rows are re-read only when their range,
 * width, theme or `version` change; settled blocks pass a constant version so
 * live output does not re-render the whole history every frame.
 */
const OutputRows: React.FC<BlockOutputRowsProps> = ({
  terminal,
  start,
  end,
  theme,
}) => {
  const buffer = terminal.buffer.normal;
  const rows: React.ReactNode[] = [];
  for (let line = start; line < end; line += 1) {
    const row = readTerminalBlockRow(buffer, line, terminal.cols);
    const continues =
      line + 1 < end && buffer.getLine(line + 1)?.isWrapped === true;
    rows.push(
      <React.Fragment key={line}>
        <span className="terminal-block-output-line">
          {row.runs.map((run, index) => (
            <span key={index} style={blockRunStyle(run, theme)}>
              {run.text}
            </span>
          ))}
        </span>
        {continues || line + 1 === end ? null : "\n"}
      </React.Fragment>,
    );
  }
  return <>{rows}</>;
};

export const BlockOutputRows = React.memo(OutputRows);

/** In-flow marker for rows above the rendered window; never overlays text. */
export const BlockFoldRow: React.FC<{
  hidden: number;
  expandable: boolean;
  labels: TerminalBlockLabels;
  onExpand: () => void;
  onReveal?: () => void;
}> = ({ hidden, expandable, labels, onExpand, onReveal }) => {
  if (hidden <= 0 || (!expandable && !onReveal)) return null;
  return (
    <button
      type="button"
      className="terminal-block-fold"
      onClick={(event) => {
        event.stopPropagation();
        if (expandable) onExpand();
        else onReveal?.();
      }}
    >
      <span aria-hidden="true">⋯</span>
      {expandable
        ? labels.hiddenRows(hidden)
        : labels.hiddenRowsInTerminal(hidden)}
    </button>
  );
};
