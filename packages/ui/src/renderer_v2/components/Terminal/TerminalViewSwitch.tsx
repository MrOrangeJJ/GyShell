import React from "react";
import { Rows3, SquareTerminal } from "lucide-react";
import type { TerminalViewMode } from "../../lib/ipcTypes";
import "./terminalViewSwitch.scss";

export interface TerminalViewModeLabels {
  label: string;
  classic: string;
  block: string;
}

const TERMINAL_VIEW_MODES: readonly TerminalViewMode[] = ["classic", "block"];

/** Icon-only Classic | Block switch shown in the footer of both views. */
export const TerminalViewSwitch: React.FC<{
  value: TerminalViewMode;
  labels: TerminalViewModeLabels;
  onChange: (value: TerminalViewMode) => void;
}> = ({ value, labels, onChange }) => (
  <div className="terminal-view-switch" role="group" aria-label={labels.label}>
    {TERMINAL_VIEW_MODES.map((mode) => {
      const label = labels[mode];
      const Icon = mode === "classic" ? SquareTerminal : Rows3;
      return (
        <button
          key={mode}
          type="button"
          className={value === mode ? "is-active" : undefined}
          aria-pressed={value === mode}
          aria-label={label}
          title={label}
          onClick={() => onChange(mode)}
        >
          <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      );
    })}
  </div>
);
