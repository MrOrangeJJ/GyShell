import React from "react";
import { ArrowUpRight, Check } from "lucide-react";
import {
  copyTextToClipboard,
  useCopyFeedback,
} from "../../Common/useCopyFeedback";
import type { TerminalBlockLabels } from "./blockLabels";

const COPIED_KEY = "copied";

export const BlockCopyButton: React.FC<{
  label: string;
  copiedLabel: string;
  /** Read lazily: copying output walks the buffer only when clicked. */
  value: () => string;
  icon: React.ReactNode;
  disabled?: boolean;
  compact?: boolean;
}> = ({ label, copiedLabel, value, icon, disabled, compact }) => {
  const { copiedKey, markCopied } = useCopyFeedback();
  const copied = copiedKey === COPIED_KEY;
  return (
    <button
      type="button"
      className={`terminal-block-icon-btn${compact ? " is-compact" : ""}${copied ? " is-copied" : ""}`}
      title={copied ? copiedLabel : label}
      aria-label={copied ? copiedLabel : label}
      disabled={disabled}
      onClick={async (event) => {
        event.stopPropagation();
        if (await copyTextToClipboard(value())) markCopied(COPIED_KEY);
      }}
    >
      {copied ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : icon}
    </button>
  );
};

/**
 * Copy glyphs in the Lucide style (24 grid, 2px round strokes): the copy
 * sheets with what gets copied drawn on the front sheet, a prompt for the
 * command and text lines for the output. They sit next to the thing they
 * copy, so position and shape say the same thing.
 */
const CopyGlyph: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    <rect x="8" y="8" width="14" height="14" rx="2" />
    {children}
  </svg>
);

export const CopyCommandIcon: React.FC = () => (
  <CopyGlyph>
    <path d="m11.5 12.5 2.5 2.5-2.5 2.5" />
    <path d="M16.5 18H19" />
  </CopyGlyph>
);

export const CopyOutputIcon: React.FC = () => (
  <CopyGlyph>
    <path d="M12 12h6" />
    <path d="M12 15h6" />
    <path d="M12 18h3.5" />
  </CopyGlyph>
);

export const BlockRevealButton: React.FC<{
  activityId: string;
  labels: TerminalBlockLabels;
  onRevealInTerminal?: (activityId: string) => void;
}> = ({ activityId, labels, onRevealInTerminal }) =>
  onRevealInTerminal ? (
    <button
      type="button"
      className="terminal-block-icon-btn"
      title={labels.showInTerminal}
      aria-label={labels.showInTerminal}
      onClick={(event) => {
        event.stopPropagation();
        onRevealInTerminal(activityId);
      }}
    >
      <ArrowUpRight size={13} aria-hidden="true" />
    </button>
  ) : null;
