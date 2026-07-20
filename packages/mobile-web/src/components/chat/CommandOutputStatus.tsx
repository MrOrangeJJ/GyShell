import React from "react";
import { commandOutputDisplayStatus } from "../../format";
import { useMobileI18n } from "../../i18n/provider";
import type { ChatMessage } from "../../types";

interface CommandOutputStatusProps {
  message: ChatMessage;
}

export const CommandOutputStatus: React.FC<CommandOutputStatusProps> = ({
  message,
}) => {
  const { t } = useMobileI18n();
  const status = commandOutputDisplayStatus(message, t.format);
  if (!status) return null;

  const parts = [
    ["execution", status.execution, status.executionTone],
    ["capture", status.capture, status.captureTone],
    ["presentation", status.presentation, "neutral"],
  ] as const;

  return (
    <div
      className={`command-output-status ${status.tone}`}
      role="status"
      aria-label={parts.map(([, label]) => label).join("; ")}
    >
      {parts.map(([axis, label, tone]) => (
        <span
          key={axis}
          className={`command-output-status-chip ${axis} ${tone}`}
        >
          {label}
        </span>
      ))}
    </div>
  );
};
