import React from "react";
import { SquareTerminal } from "lucide-react";
import type { ITheme, Terminal } from "@xterm/xterm";
import { SessionGlyph } from "../../Common/SessionGlyph";
import { getTerminalActivityCommandPreview } from "../terminalActivityModel";
import {
  blockStatusLabel,
  blockStatusText,
  type TerminalBlockLabels,
} from "./blockLabels";
import {
  resolveBlockOutputWindow,
  type BlockDetailsPlacement,
} from "./blockLayout";
import { resolveBlockCommand, type BlockRange } from "./blockRange";
import { BlockRevealButton } from "./BlockActions";
import {
  BlockMeta,
  BlockStatusIcon,
  BlockTranscriptHead,
  formatBlockDuration,
} from "./BlockMeta";
import { BlockFoldRow, BlockOutputRows } from "./BlockOutputRows";
import type { TerminalCommandAnnotation } from "./terminalBlockModel";

const hasTextSelection = (): boolean => {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed);
};

interface BlockItemProps {
  terminal: Terminal;
  annotation: TerminalCommandAnnotation;
  range: BlockRange;
  theme: ITheme;
  labels: TerminalBlockLabels;
  sessionTitle?: string;
  roving: boolean;
  /** Newest block or still running: shown like the active Classic terminal. */
  live: boolean;
  /** Buffer revision for live blocks; 0 for settled ones (memo key). */
  version: number;
  expanded: boolean;
  inspected: boolean;
  /** Target of a jump from the terminal: flashes once so the eye lands. */
  targeted: boolean;
  placement: BlockDetailsPlacement;
  registerBlock: (id: string, element: HTMLLIElement | null) => void;
  registerHeader: (id: string, element: HTMLDivElement | null) => void;
  onHeaderFocus: (id: string) => void;
  /** The block is one control: opens its details (in place or split). */
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onHeaderKeyDown: (id: string, event: React.KeyboardEvent) => void;
  onExpand: (id: string) => void;
  onRevealInTerminal?: (activityId: string) => void;
}

/**
 * One command in the stream: a sticky header (actor/session glyph, intent or
 * command, session, duration, status) over its output. Success is a quiet
 * check; failure/abort get a red pill and a red left rule. Folded output is
 * counted by a passive "+N" on the header rather than costing a row.
 */
export const BlockItem: React.FC<BlockItemProps> = ({
  terminal,
  annotation,
  range,
  theme,
  labels,
  sessionTitle,
  roving,
  live,
  version,
  expanded,
  inspected,
  targeted,
  placement,
  registerBlock,
  registerHeader,
  onHeaderFocus,
  onActivate,
  onClose,
  onHeaderKeyDown,
  onExpand,
  onRevealInTerminal,
}) => {
  const { activity } = annotation;
  const wasInspected = React.useRef(false);
  const output = resolveBlockOutputWindow({
    outputStart: range.outputStart,
    end: range.end,
    live,
    expanded,
  });
  const hasOutput = range.end > range.outputStart;
  const command = resolveBlockCommand(terminal, annotation);
  // Same one-line preview as elsewhere, also for commands read from the prompt.
  const commandPreview = getTerminalActivityCommandPreview({
    ...activity,
    command,
  });
  const isAgent = activity.actor === "agent";
  const duration = formatBlockDuration(activity);
  const inlineDetails = placement === "inline" && inspected;
  const reveal = onRevealInTerminal
    ? () => onRevealInTerminal(annotation.id)
    : undefined;

  return (
    <li
      ref={(element) => registerBlock(annotation.id, element)}
      data-activity-id={annotation.id}
      className={
        `terminal-block is-${activity.actor} is-${activity.status}` +
        (expanded ? " is-expanded" : "") +
        (inspected ? " is-inspected" : "") +
        (targeted ? " is-targeted" : "")
      }
      onPointerDown={() => {
        wasInspected.current = inspected;
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const opened = wasInspected.current;
        wasInspected.current = false;
        // Own controls (copy, View in Terminal) and drag-selections are not
        // a click on the block.
        if (target.closest("button, a") || hasTextSelection()) return;
        // Header clicks already opened it through focus.
        if (!opened) {
          if (!inspected) onActivate(annotation.id);
        }
        // An open block closes from its header; its body is for reading.
        else if (target.closest(".terminal-block-header"))
          onClose(annotation.id);
      }}
    >
      <div className="terminal-block-head">
        <div
          ref={(element) => registerHeader(annotation.id, element)}
          className="terminal-block-header"
          role="button"
          tabIndex={roving ? 0 : -1}
          aria-expanded={inspected}
          title={labels.blockHint}
          onFocus={(event) => {
            if (event.target === event.currentTarget)
              onHeaderFocus(annotation.id);
          }}
          onKeyDown={(event) => onHeaderKeyDown(annotation.id, event)}
        >
          <span
            className={`terminal-block-actor is-${activity.status}`}
            title={isAgent ? sessionTitle || labels.agent : labels.user}
          >
            {isAgent ? (
              <SessionGlyph sessionId={activity.sessionId} size={12} />
            ) : (
              <SquareTerminal size={12} strokeWidth={1.8} aria-hidden="true" />
            )}
          </span>
          <span className="terminal-block-title">
            {activity.intent ? (
              <span className="terminal-block-intent">{activity.intent}</span>
            ) : (
              <code className="terminal-block-command">
                {commandPreview || labels.command}
              </code>
            )}
            {activity.intent && commandPreview ? (
              <code className="terminal-block-secondary">{commandPreview}</code>
            ) : null}
          </span>
          {/* Open in place, the meta strip right below carries session,
              duration and status; the header keeps just the command. */}
          {isAgent && sessionTitle && !inlineDetails ? (
            <span className="terminal-block-session">{sessionTitle}</span>
          ) : null}
          {duration && !inlineDetails ? (
            <span className="terminal-block-duration">{duration}</span>
          ) : null}
          {inlineDetails ? null : (
            <span
              className={`terminal-block-status is-${activity.status}`}
              title={blockStatusLabel(activity.status, labels)}
            >
              <BlockStatusIcon status={activity.status} />
              {activity.status === "succeeded" &&
              (activity.exitCode === undefined ||
                activity.exitCode === 0) ? null : (
                <span>{blockStatusText(activity, labels)}</span>
              )}
            </span>
          )}
        </div>
        {output.expandable ? (
          // Folded rows are counted here instead of costing a row in the
          // stream; the block itself is what opens them.
          <span
            className="terminal-block-count"
            title={labels.hiddenRows(output.hidden)}
            aria-label={labels.hiddenRows(output.hidden)}
          >
            +{output.hidden}
          </span>
        ) : null}
      </div>
      {inlineDetails ? (
        <div className="terminal-block-strip">
          <BlockMeta
            activity={activity}
            labels={labels}
            sessionTitle={sessionTitle}
          />
          <BlockRevealButton
            activityId={annotation.id}
            labels={labels}
            onRevealInTerminal={onRevealInTerminal}
          />
        </div>
      ) : null}
      {hasOutput || inlineDetails ? (
        <div className="terminal-block-output">
          {inlineDetails ? (
            <BlockTranscriptHead
              terminal={terminal}
              activity={activity}
              command={command || ""}
              range={range}
              labels={labels}
              showIntent={false}
            />
          ) : null}
          {/* Inline details or a capped expansion name the hidden rows in flow. */}
          {inlineDetails || !output.expandable ? (
            <BlockFoldRow
              hidden={output.hidden}
              expandable={output.expandable}
              labels={labels}
              onExpand={() => onExpand(annotation.id)}
              onReveal={reveal}
            />
          ) : null}
          {hasOutput ? (
            <pre className="terminal-block-output-text">
              <BlockOutputRows
                terminal={terminal}
                start={output.start}
                end={range.end}
                cols={terminal.cols}
                theme={theme}
                version={version}
              />
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
};
