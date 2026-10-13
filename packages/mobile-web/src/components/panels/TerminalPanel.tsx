import React from "react";
import { Plus, RefreshCw, X, PlugZap } from "lucide-react";
import { useMobileI18n } from "../../i18n/provider";
import type {
  CreateTerminalTarget,
  GatewaySshConnectionSummary,
  GatewayTerminalSummary,
} from "../../types";
import type { TerminalBufferEntry } from "../../hooks/useTerminalBuffer";

interface TerminalPanelProps {
  terminals: GatewayTerminalSummary[];
  sshConnections: GatewaySshConnectionSummary[];
  buffers: Record<string, TerminalBufferEntry>;
  onCreateTerminal: (target: CreateTerminalTarget) => void;
  onCloseTerminal: (terminalId: string) => void;
  onReconnectTerminal: (terminalId: string) => Promise<boolean>;
  onRefreshBuffers: () => void;
  onMarkBufferSeen: (terminalId: string) => void;
  onClearReconnectError: () => void;
  reconnectingId: string | null;
  reconnectError: string;
}

const OUTPUT_MAX_LINES = 400;

function isSshTerminal(terminal: GatewayTerminalSummary): boolean {
  return String(terminal.type || "").toLowerCase().includes("ssh");
}

function trimOutputTail(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= OUTPUT_MAX_LINES) return text;
  return lines.slice(lines.length - OUTPUT_MAX_LINES).join("\n");
}

export function shouldMarkActiveTerminalBufferSeen(
  activeTerminalId: string | null,
  activeBuffer: TerminalBufferEntry | undefined,
): boolean {
  return (
    !!activeTerminalId &&
    !!activeBuffer &&
    activeBuffer.terminalId === activeTerminalId &&
    activeBuffer.hasNew
  );
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  terminals,
  sshConnections,
  buffers,
  onCreateTerminal,
  onCloseTerminal,
  onReconnectTerminal,
  onRefreshBuffers,
  onMarkBufferSeen,
  onClearReconnectError,
  reconnectingId,
  reconnectError,
}) => {
  const { t } = useMobileI18n();
  const [createTarget, setCreateTarget] = React.useState<string>("local");
  const [activeTerminalId, setActiveTerminalId] = React.useState<string | null>(
    null,
  );
  const activeTerminal = activeTerminalId
    ? terminals.find((item) => item.id === activeTerminalId) || null
    : null;
  const activeBuffer = activeTerminalId ? buffers[activeTerminalId] : undefined;
  const activeBufferOffset = activeBuffer?.offset ?? null;
  const shouldMarkActiveBufferSeen = shouldMarkActiveTerminalBufferSeen(
    activeTerminalId,
    activeBuffer,
  );

  const options = React.useMemo(() => {
    return [
      { value: "local", label: t.terminal.localTerminal },
      ...sshConnections.map((item) => ({
        value: `ssh:${item.id}`,
        label: item.name || `${item.username}@${item.host}:${item.port}`,
      })),
    ];
  }, [sshConnections, t.terminal.localTerminal]);

  React.useEffect(() => {
    if (createTarget === "local") return;
    const id = createTarget.startsWith("ssh:") ? createTarget.slice(4) : "";
    if (!id) {
      setCreateTarget("local");
      return;
    }
    const exists = sshConnections.some((item) => item.id === id);
    if (!exists) {
      setCreateTarget("local");
    }
  }, [createTarget, sshConnections]);

  // Keep a valid active terminal selected. Auto-select first terminal when none chosen,
  // and fall back if the previously selected terminal was closed.
  React.useEffect(() => {
    if (terminals.length === 0) {
      if (activeTerminalId !== null) setActiveTerminalId(null);
      return;
    }
    const exists = terminals.some((item) => item.id === activeTerminalId);
    if (!exists) {
      setActiveTerminalId(terminals[0].id);
    }
  }, [terminals, activeTerminalId]);

  // When a terminal is visible, its incoming output has effectively been seen.
  React.useEffect(() => {
    if (!activeTerminalId || !shouldMarkActiveBufferSeen) {
      return;
    }
    onMarkBufferSeen(activeTerminalId);
  }, [
    activeBufferOffset,
    activeTerminalId,
    onMarkBufferSeen,
    shouldMarkActiveBufferSeen,
  ]);

  // Clear a stale reconnect error when the user switches to a different
  // terminal. The error is global (last failed reconnect); it should not
  // follow the user onto an unrelated terminal.
  React.useEffect(() => {
    onClearReconnectError();
  }, [activeTerminalId, onClearReconnectError]);

  const handleCreate = React.useCallback(() => {
    if (createTarget === "local") {
      onCreateTerminal({ type: "local" });
      return;
    }
    const id = createTarget.startsWith("ssh:") ? createTarget.slice(4) : "";
    if (!id) return;
    onCreateTerminal({ type: "ssh", connectionId: id });
  }, [createTarget, onCreateTerminal]);

  const handleReconnect = React.useCallback(
    (terminalId: string) => {
      void onReconnectTerminal(terminalId);
    },
    [onReconnectTerminal],
  );

  const activeRuntimeState = activeTerminal?.runtimeState || "initializing";
  const activeExited = activeRuntimeState === "exited";
  const activeIsSsh = activeTerminal ? isSshTerminal(activeTerminal) : false;
  const canReconnect = activeIsSsh && activeExited;
  const outputText = activeBuffer ? trimOutputTail(activeBuffer.text) : "";

  return (
    <section className="panel-scroll terminal-panel">
      <div className="panel-toolbar terminal-toolbar">
        <div className="panel-title-spacer terminal-create-field">
          <select
            className="terminal-create-select"
            value={createTarget}
            onChange={(event) => setCreateTarget(event.target.value)}
            aria-label={t.terminal.selectTerminalType}
          >
            {options.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label={t.terminal.refresh}
          title={t.terminal.refresh}
          onClick={onRefreshBuffers}
          disabled={!activeTerminal}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {sshConnections.length === 0 ? (
        <p className="terminal-sub-hint">{t.terminal.noSavedSsh}</p>
      ) : null}

      {terminals.length === 0 ? (
        <div className="empty-state panel-empty-state">
          <p className="empty-state-title">{t.terminal.noActiveTerminals}</p>
          <p className="empty-state-hint">{t.terminal.noActiveTerminalsHint}</p>
        </div>
      ) : (
        <>
          <div className="terminal-tab-strip" role="tablist">
            {terminals.map((terminal) => {
              const runtimeState = terminal.runtimeState || "initializing";
              const activityClass =
                runtimeState === "ready"
                  ? "active"
                  : runtimeState === "exited"
                    ? "exited"
                    : "inactive";
              const isActive = terminal.id === activeTerminalId;
              const buffer = buffers[terminal.id];
              const hasNew = !isActive && !!buffer?.hasNew;
              return (
                <button
                  key={terminal.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`terminal-tab ${isActive ? "active" : ""}`}
                  onClick={() => setActiveTerminalId(terminal.id)}
                  title={terminal.title}
                >
                  <span
                    className={`terminal-state-dot ${activityClass}`}
                    aria-label={t.terminal.state(runtimeState)}
                  />
                  <span className="terminal-tab-title">{terminal.title}</span>
                  {hasNew ? (
                    <span className="terminal-tab-new" aria-hidden="true">
                      {t.terminal.newItem}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {activeTerminal ? (
            <div className="terminal-detail">
              <div className="terminal-detail-head">
                <div className="terminal-detail-title">
                  <strong>{activeTerminal.title}</strong>
                  <span className="terminal-detail-type">
                    {activeTerminal.type}
                  </span>
                </div>
                <div className="terminal-detail-actions">
                  {canReconnect ? (
                    <button
                      type="button"
                      className="terminal-action-btn primary"
                      onClick={() => handleReconnect(activeTerminal.id)}
                      disabled={reconnectingId === activeTerminal.id}
                    >
                      <PlugZap size={14} />
                      {reconnectingId === activeTerminal.id
                        ? t.terminal.reconnecting
                        : t.terminal.reconnect}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="terminal-close-btn"
                    aria-label={t.terminal.close(activeTerminal.title)}
                    title={t.terminal.close(activeTerminal.title)}
                    onClick={() => onCloseTerminal(activeTerminal.id)}
                    disabled={terminals.length <= 1}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>

              {activeTerminal.connectionStatus?.lines.length ? (
                <p
                  className={
                    activeTerminal.connectionStatus.phase === "failed"
                      ? "terminal-reconnect-error"
                      : "terminal-exit-hint"
                  }
                  role="status"
                >
                  {activeTerminal.connectionStatus.lines.at(-1)?.text}
                </p>
              ) : null}
              {canReconnect ? (
                <p className="terminal-exit-hint">{t.terminal.sshExited}</p>
              ) : null}
              {reconnectError ? (
                <p className="terminal-reconnect-error">{reconnectError}</p>
              ) : null}

              <div className="terminal-output-label">{t.terminal.outputLabel}</div>
              <pre
                className={`terminal-output${outputText ? "" : " is-empty"}`}
                aria-live="polite"
                aria-label={outputText ? undefined : t.terminal.outputEmpty}
              >
                {outputText}
              </pre>
            </div>
          ) : null}
        </>
      )}

      <div className="panel-action-dock">
        <button
          type="button"
          className="panel-icon-btn panel-action-btn"
          aria-label={t.terminal.newTerminal}
          title={t.terminal.newTerminal}
          onClick={handleCreate}
        >
          <Plus size={18} />
        </button>
      </div>
    </section>
  );
};
