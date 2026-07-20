import React from "react";
import { ChevronLeft } from "lucide-react";
import { useMobileI18n } from "../../i18n/provider";
import type { AgentTimelineItem } from "../../lib/chat-timeline";
import type { ChatMessage } from "../../types";
import { DetailMessageCard } from "./DetailMessageCard";

const detailAutoScrollThresholdPx = 48;

function isDetailListNearBottom(element: HTMLElement): boolean {
  const remainingDistance =
    element.scrollHeight - element.scrollTop - element.clientHeight;
  return remainingDistance <= detailAutoScrollThresholdPx;
}

interface MessageDetailSheetProps {
  open: boolean;
  turn: AgentTimelineItem | null;
  onClose: () => void;
  onAskDecision: (message: ChatMessage, decision: "allow" | "deny") => void;
}

export const MessageDetailSheet: React.FC<MessageDetailSheetProps> = ({
  open,
  turn,
  onClose,
  onAskDecision,
}) => {
  const { t } = useMobileI18n();
  const messages = turn?.detailMessages || [];
  const detailListRef = React.useRef<HTMLElement>(null);
  const shouldStickDetailListToBottomRef = React.useRef(true);
  const previousDetailContextRef = React.useRef<{
    open: boolean;
    turnId: string | null;
  } | null>(null);
  const detailUpdateSignature = React.useMemo(() => {
    return messages
      .map((message) => {
        const contentLength = String(message.content || "").length;
        const outputLength = String(message.metadata?.output || "").length;
        const commandOutput = message.metadata?.commandOutput;
        const commandOutputState = commandOutput
          ? `${commandOutput.executionState}:${commandOutput.capture.state}:${commandOutput.presentation.state}:${commandOutput.capture.revision}`
          : "legacy";
        return `${message.id}:${message.streaming ? "1" : "0"}:${contentLength}:${outputLength}:${commandOutputState}`;
      })
      .join("|");
  }, [messages]);

  React.useEffect(() => {
    if (!open) return;
    const element = detailListRef.current;
    if (!element) return;

    const handleScroll = () => {
      shouldStickDetailListToBottomRef.current =
        isDetailListNearBottom(element);
    };
    handleScroll();
    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", handleScroll);
    };
  }, [open, turn?.id]);

  React.useEffect(() => {
    const currentContext = {
      open,
      turnId: turn?.id || null,
    };
    if (!open) {
      previousDetailContextRef.current = currentContext;
      return;
    }
    const element = detailListRef.current;
    if (!element) {
      previousDetailContextRef.current = currentContext;
      return;
    }

    const previousContext = previousDetailContextRef.current;
    const hasContextChanged =
      !previousContext ||
      previousContext.open !== currentContext.open ||
      previousContext.turnId !== currentContext.turnId;

    if (hasContextChanged || shouldStickDetailListToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
      shouldStickDetailListToBottomRef.current = true;
    }

    previousDetailContextRef.current = currentContext;
  }, [open, turn?.id, detailUpdateSignature]);

  return (
    <aside
      className={`detail-screen ${open ? "is-open" : ""}`}
      aria-hidden={!open}
    >
      <header className="detail-screen-header">
        <button
          type="button"
          className="top-back-btn"
          onClick={onClose}
          aria-label={t.detail.closeDetail}
        >
          <ChevronLeft size={20} />
        </button>
        <h2>{t.detail.title}</h2>
        <div style={{ width: 28 }} />
      </header>

      <section className="detail-sheet-meta">
        <span>{t.detail.events(messages.length)}</span>
      </section>

      <section className="detail-list" ref={detailListRef}>
        {messages.length === 0 ? (
          <p className="panel-empty">{t.detail.empty}</p>
        ) : (
          messages.map((message) => (
            <DetailMessageCard
              key={message.id}
              message={message}
              onAskDecision={onAskDecision}
            />
          ))
        )}
      </section>
    </aside>
  );
};
