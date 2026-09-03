import React from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { validateTerminalTitle } from "@gyshell/shared";
import type { AppStore } from "../../stores/AppStore";
import "../Common/confirmDialog.scss";
import "./terminalRenameDialog.scss";

interface TerminalRenameDialogProps {
  store: AppStore;
  terminalId: string | null;
  onClose: () => void;
}

export const TerminalRenameDialog: React.FC<TerminalRenameDialogProps> = ({
  store,
  terminalId,
  onClose,
}) => {
  const terminal = terminalId
    ? store.terminalTabs.find((tab) => tab.id === terminalId) || null
    : null;
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const t = store.i18n.t;

  React.useEffect(() => {
    if (!terminalId) return;
    const current = store.terminalTabs.find((tab) => tab.id === terminalId);
    if (!current) return;
    setDraft(current.title);
    setSaving(false);
    setError(null);
  }, [terminalId]);

  React.useEffect(() => {
    if (!terminalId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, terminalId]);

  if (!terminalId || !terminal) return null;

  const validation = validateTerminalTitle(draft);
  const validationError = (() => {
    if (validation.ok) return null;
    if (validation.reason === "blank") return t.terminal.renameBlank;
    if (validation.reason === "too_long") return t.terminal.renameTooLong;
    return t.terminal.renameInvalid;
  })();
  const normalizedDraft = validation.ok ? validation.title : null;
  const unchanged = normalizedDraft === terminal.title;

  const commitRename = async (): Promise<void> => {
    if (saving || !normalizedDraft) return;
    if (unchanged) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await store.renameTerminal(terminalId, normalizedDraft);
      onClose();
    } catch {
      setSaving(false);
      setError(t.terminal.renameFailed);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return createPortal(
    <div
      className="gy-confirm-overlay terminal-rename-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="terminal-rename-title"
    >
      <form
        className="gy-confirm-card terminal-rename-card"
        onSubmit={(event) => {
          event.preventDefault();
          void commitRename();
        }}
      >
        <div className="gy-confirm-header">
          <div id="terminal-rename-title" className="gy-confirm-title">
            {t.terminal.renameTitle}
          </div>
          <button
            type="button"
            className="icon-btn-sm"
            onClick={onClose}
            title={t.common.cancel}
            aria-label={t.common.cancel}
            disabled={saving}
          >
            <X size={18} />
          </button>
        </div>

        <div className="gy-confirm-body terminal-rename-body">
          <label htmlFor="terminal-rename-input">
            {t.terminal.renameLabel}
          </label>
          <input
            id="terminal-rename-input"
            ref={inputRef}
            value={draft}
            autoFocus
            disabled={saving}
            aria-invalid={Boolean(validationError || error)}
            aria-describedby="terminal-rename-feedback"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
          <div
            id="terminal-rename-feedback"
            className="terminal-rename-feedback"
            role={validationError || error ? "alert" : undefined}
          >
            {error || validationError || t.terminal.renameHint}
          </div>
        </div>

        <div className="gy-confirm-footer">
          <button
            type="button"
            className="gy-btn gy-btn-secondary"
            onClick={onClose}
            disabled={saving}
          >
            {t.common.cancel}
          </button>
          <button
            type="submit"
            className="gy-btn gy-btn-primary"
            disabled={saving || Boolean(validationError)}
          >
            {saving ? (
              <span className="gy-confirm-loading">
                <Loader2 size={14} />
                <span>{t.common.save}</span>
              </span>
            ) : (
              t.common.save
            )}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};
