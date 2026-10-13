import React from "react";
import { X } from "lucide-react";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { TerminalBlockLabels } from "./blockLabels";
import { isBlockScrolledToBottom } from "./blockFollow";
import { resolveBlockOutputWindow } from "./blockLayout";
import { resolveBlockCommand, type BlockRange } from "./blockRange";
import { BlockRevealButton } from "./BlockActions";
import { BlockMeta, BlockTranscriptHead } from "./BlockMeta";
import { BlockFoldRow, BlockOutputRows } from "./BlockOutputRows";
import type { TerminalCommandAnnotation } from "./terminalBlockModel";

/**
 * Details for one block in the split pane: meta line, the input as run and
 * the full output. Like a terminal, it follows new rows while scrolled to the
 * bottom and stays put once the user scrolls up to read.
 */
export const BlockDetails: React.FC<{
  terminal: Terminal;
  annotation: TerminalCommandAnnotation;
  range: BlockRange;
  theme: ITheme;
  labels: TerminalBlockLabels;
  sessionTitle?: string;
  revision: number;
  onClose: () => void;
  onRevealInTerminal?: (activityId: string) => void;
}> = ({
  terminal,
  annotation,
  range,
  theme,
  labels,
  sessionTitle,
  revision,
  onClose,
  onRevealInTerminal,
}) => {
  const { activity } = annotation;
  const command = resolveBlockCommand(terminal, annotation) || "";
  const output = resolveBlockOutputWindow({
    outputStart: range.outputStart,
    end: range.end,
    live: true,
    expanded: true,
  });
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const followRef = React.useRef(false);
  // Another command opens at its top (input first); a running one is watched
  // from its newest rows.
  React.useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    element.scrollTop = 0;
    followRef.current = activity.status === "running";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotation.id]);
  React.useLayoutEffect(() => {
    const element = bodyRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });
  const reveal = onRevealInTerminal
    ? () => onRevealInTerminal(annotation.id)
    : undefined;
  return (
    <div className="terminal-block-details" aria-label={labels.details}>
      <header className="terminal-block-details-head">
        <BlockMeta
          activity={activity}
          labels={labels}
          sessionTitle={sessionTitle}
        />
        <span className="terminal-block-actions">
          <BlockRevealButton
            activityId={annotation.id}
            labels={labels}
            onRevealInTerminal={onRevealInTerminal}
          />
          <button
            type="button"
            className="terminal-block-icon-btn"
            onClick={onClose}
            title={`${labels.close} (Esc)`}
            aria-label={labels.close}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </header>
      <div
        ref={bodyRef}
        className="terminal-block-details-body"
        tabIndex={0}
        role="log"
        aria-label={labels.output}
        aria-live={activity.status === "running" ? "polite" : "off"}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight > element.clientHeight &&
            isBlockScrolledToBottom(element);
        }}
      >
        <BlockTranscriptHead
          terminal={terminal}
          activity={activity}
          command={command}
          range={range}
          labels={labels}
        />
        <BlockFoldRow
          hidden={output.hidden}
          expandable={false}
          labels={labels}
          onExpand={() => undefined}
          onReveal={reveal}
        />
        {range.end > range.outputStart ? (
          <pre className="terminal-block-output-text">
            <BlockOutputRows
              terminal={terminal}
              start={output.start}
              end={range.end}
              cols={terminal.cols}
              theme={theme}
              version={activity.status === "running" ? revision : 0}
            />
          </pre>
        ) : null}
      </div>
    </div>
  );
};
