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
  /**
   * End (exclusive) of the rows listed here; a running block stops where the
   * dock shows the rest live. Copy and details still use the full range.
   */
  listedEnd: number;
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
 * One command in the stream: a sticky header over its output. A command with
 * an intent leads with it as the block's title (wrapped, not cut off), with the
 * command and session on a quieter line below; a command without one shows the
 * command on a single line. Duration and status sit on the right of the first
 * line. Success is a quiet check; failure/abort get a red pill and a red left
 * rule. Folded output is counted by a passive "+N" on the header rather than
 * costing a row.
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
  listedEnd,
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
    end: listedEnd,
    live,
    expanded,
  });
  const hasOutput = listedEnd > range.outputStart;
  const command = resolveBlockCommand(terminal, annotation);
  // Same one-line preview as elsewhere, also for commands read from the prompt.
  const commandPreview = getTerminalActivityCommandPreview({
    ...activity,
    command,
  });
  const isAgent = activity.actor === "agent";
  const intent = activity.intent?.trim();
  const duration = formatBlockDuration(activity);
  const inlineDetails = placement === "inline" && inspected;
  // Open in place, the meta strip right below carries session, duration and
  // status, and the transcript carries the command: the header keeps the title.
  const session =
    isAgent && sessionTitle && !inlineDetails ? (
      <span className="terminal-block-session">{sessionTitle}</span>
    ) : null;
  const subline =
    intent && !inlineDetails && (commandPreview || session) ? (
      <span className="terminal-block-subline">
        {commandPreview ? (
          <code className="terminal-block-secondary">{commandPreview}</code>
        ) : null}
        {session}
      </span>
    ) : null;
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
          {intent ? (
            <span className="terminal-block-title has-intent">
              <span className="terminal-block-intent">{intent}</span>
              {subline}
            </span>
          ) : (
            <span className="terminal-block-title">
              <code className="terminal-block-command">
                {commandPreview || labels.command}
              </code>
            </span>
          )}
          {intent ? null : session}
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
                end={listedEnd}
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
