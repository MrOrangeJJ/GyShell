import React from "react";
import { Check, CircleHelp, Radio, SquareTerminal, X } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalActivitySnapshot } from "@gyshell/shared";
import { SessionGlyph } from "../../Common/SessionGlyph";
import { formatTerminalActivityDuration } from "../terminalActivityModel";
import { blockStatusLabel, type TerminalBlockLabels } from "./blockLabels";
import {
  countBlockOutputLines,
  getBlockOutputText,
  type BlockRange,
} from "./blockRange";
import { BlockCopyButton, CopyCommandIcon, CopyOutputIcon } from "./BlockActions";

export const BlockStatusIcon: React.FC<{
  status: TerminalActivitySnapshot["status"];
}> = ({ status }) => {
  if (status === "running")
    return (
      <Radio size={11} className="terminal-block-pulse" aria-hidden="true" />
    );
  if (status === "succeeded")
    return <Check size={11} strokeWidth={2.5} aria-hidden="true" />;
  if (status === "failed" || status === "aborted")
    return <X size={11} strokeWidth={2.5} aria-hidden="true" />;
  return <CircleHelp size={11} strokeWidth={1.9} aria-hidden="true" />;
};

/** Elapsed time ("120ms", "1.4s", "2m 10s"); empty before the command starts. */
export const formatBlockDuration = (
  activity: TerminalActivitySnapshot,
): string => (activity.startedAt ? formatTerminalActivityDuration(activity) : "");

const formatTime = (timestamp?: number): string =>
  timestamp ? new Date(timestamp).toLocaleTimeString() : "";

/** One dense line: status/exit · start → end · duration · who ran it. */
export const BlockMeta: React.FC<{
  activity: TerminalActivitySnapshot;
  labels: TerminalBlockLabels;
  sessionTitle?: string;
}> = ({ activity, labels, sessionTitle }) => {
  const duration = formatBlockDuration(activity);
  const started = formatTime(activity.startedAt);
  const ended = formatTime(activity.endedAt);
  return (
    <span className="terminal-block-meta">
      <span className={`terminal-block-meta-status is-${activity.status}`}>
        <BlockStatusIcon status={activity.status} />
        {blockStatusLabel(activity.status, labels)}
        {activity.exitCode !== undefined
          ? ` · ${labels.exitCode(activity.exitCode)}`
          : ""}
      </span>
      {started ? (
        <span title={`${labels.started} → ${labels.ended}`}>
          {started}
          {ended && ended !== started ? ` → ${ended}` : ""}
        </span>
      ) : null}
      {duration ? <span title={labels.duration}>{duration}</span> : null}
      <span className="terminal-block-meta-actor" title={labels.session}>
        {activity.actor === "agent" ? (
          <SessionGlyph sessionId={activity.sessionId} size={11} />
        ) : (
          <SquareTerminal size={11} strokeWidth={1.8} aria-hidden="true" />
        )}
        {activity.actor === "agent"
          ? sessionTitle || labels.agent
          : labels.user}
      </span>
    </span>
  );
};

/**
 * Details transcript head: the input exactly as run (wrapped, never clipped),
 * then a dashed rule that starts the output. Each copy button sits on the
 * part it copies.
 */
export const BlockTranscriptHead: React.FC<{
  terminal: Terminal;
  activity: TerminalActivitySnapshot;
  command: string;
  range: BlockRange;
  labels: TerminalBlockLabels;
  /** Off when the block header right above already shows the intent. */
  showIntent?: boolean;
}> = ({ terminal, activity, command, range, labels, showIntent = true }) => {
  const rows = Math.max(0, range.end - range.outputStart);
  const lines = rows > 0 ? countBlockOutputLines(terminal, range) : 0;
  return (
    <>
      <div className="terminal-block-input">
        <div className="terminal-block-input-text">
          {showIntent && activity.intent ? (
            <span className="terminal-block-input-intent">
              {activity.intent}
            </span>
          ) : null}
          <code className="terminal-block-input-command">
            <span className="terminal-block-input-prompt" aria-hidden="true">
              $
            </span>
            {command || labels.command}
          </code>
        </div>
        <BlockCopyButton
          compact
          label={labels.copyCommand}
          copiedLabel={labels.copied}
          value={() => command}
          icon={<CopyCommandIcon />}
          disabled={!command.trim()}
        />
      </div>
      <div className="terminal-block-io-rule" role="separator">
        <span className="terminal-block-io-rule-count">
          {rows > 0
            ? labels.outputRows(lines)
            : activity.status === "running"
              ? labels.running
              : labels.noOutput}
        </span>
        <BlockCopyButton
          compact
          label={labels.copyOutput}
          copiedLabel={labels.copied}
          value={() => getBlockOutputText(terminal, range)}
          icon={<CopyOutputIcon />}
          disabled={rows === 0}
        />
      </div>
    </>
  );
};
