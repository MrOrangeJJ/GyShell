import { Check, CircleAlert, LoaderCircle, RotateCw, TriangleAlert, X } from "lucide-react";
import type { TerminalConnectionStatus } from "@gyshell/shared";
import "./terminalConnectionStatusCard.scss";

export type TerminalConnectionCardLabels = {
  connecting: string;
  failed: string;
  reconnect: string;
  hide: string;
};

const DEFAULT_LABELS: TerminalConnectionCardLabels = {
  connecting: "Connecting",
  failed: "Connection failed",
  reconnect: "Reconnect",
  hide: "Hide",
};

/** Progress rows kept while connecting; older finished steps add no information. */
const MAX_PROGRESS_ROWS = 4;

/**
 * Transport/setup progress rendered as chrome over the terminal. It is driven
 * by tab runtime metadata, never by terminal bytes, so it never lands in the
 * terminal content or in restored history.
 *
 * - Connecting: a compact, non-interactive progress card that disappears as
 *   soon as the shell is ready.
 * - Failed: the reason stays on screen (selectable) with Reconnect, until the
 *   user hides it or reconnects. The footer keeps the reason after hiding.
 */
export function TerminalConnectionStatusCard({
  status,
  hidden = false,
  labels = DEFAULT_LABELS,
  onReconnect,
  onHide,
}: {
  status?: TerminalConnectionStatus;
  hidden?: boolean;
  labels?: TerminalConnectionCardLabels;
  onReconnect?: () => void;
  onHide?: () => void;
}) {
  if (!status || status.lines.length === 0 || hidden) return null;

  if (status.phase === "failed") {
    return (
      <section className="terminal-connection-card is-failed" role="alert">
        <header className="terminal-connection-card-head">
          <CircleAlert size={13} aria-hidden="true" />
          <span className="terminal-connection-card-title">{labels.failed}</span>
          {onReconnect ? (
            <button
              type="button"
              className="terminal-connection-card-action"
              onClick={onReconnect}
            >
              <RotateCw size={12} aria-hidden="true" />
              <span>{labels.reconnect}</span>
            </button>
          ) : null}
          {onHide ? (
            <button
              type="button"
              className="terminal-connection-card-close"
              aria-label={labels.hide}
              title={labels.hide}
              onClick={onHide}
            >
              <X size={12} strokeWidth={2.2} aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <div className="terminal-connection-card-body">
          {status.lines.map((line, index) => (
            <p key={`${line.at}-${index}`} className={`is-${line.level}`}>
              {line.text}
            </p>
          ))}
        </div>
      </section>
    );
  }

  const lines = status.lines.slice(-MAX_PROGRESS_ROWS);
  return (
    <section
      className="terminal-connection-card is-connecting"
      role="status"
      aria-live="polite"
      aria-label={labels.connecting}
    >
      {lines.map((line, index) => {
        const isCurrent = index === lines.length - 1;
        const Icon =
          line.level === "error"
            ? CircleAlert
            : line.level === "warning"
              ? TriangleAlert
              : isCurrent
                ? LoaderCircle
                : Check;
        return (
          <div
            key={`${line.at}-${index}`}
            className={`terminal-connection-step is-${line.level}${isCurrent ? " is-current" : ""}`}
          >
            <Icon size={12} aria-hidden="true" />
            <span>{line.text}</span>
          </div>
        );
      })}
    </section>
  );
}
