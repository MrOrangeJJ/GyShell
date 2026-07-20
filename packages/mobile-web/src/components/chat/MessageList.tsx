import React from "react";
import { CornerUpLeft, CornerUpRight } from "lucide-react";
import { formatClock, messageDetail, messageTypeTitle } from "../../format";
import { useMobileI18n } from "../../i18n/provider";
import {
  type AgentTimelineItem,
  type ChatTimelineItem,
} from "../../lib/chat-timeline";
import { normalizeDisplayText, trimOuterBlankLines } from "../../session-store";
import type { ChatMessage } from "../../types";
import { MarkdownContent } from "../common/MarkdownContent";
import { MentionContent } from "../common/MentionContent";
import { CommandOutputStatus } from "./CommandOutputStatus";

export interface MessageListProps {
  items: ChatTimelineItem[];
  onAskDecision: (message: ChatMessage, decision: "allow" | "deny") => void;
  onOpenDetail: (turnId: string) => void;
  onRollback: (message: ChatMessage) => void;
  onBranch: (message: ChatMessage) => void;
  rollbackDisabled: boolean;
  branchDisabled: boolean;
  listRef: React.RefObject<HTMLDivElement>;
}

interface UserBubbleProps {
  message: ChatMessage;
  onRollback: (message: ChatMessage) => void;
  onBranch: (message: ChatMessage) => void;
  rollbackDisabled: boolean;
  branchDisabled: boolean;
}

const UserBubble = React.memo(function UserBubble({
  message,
  onRollback,
  onBranch,
  rollbackDisabled,
  branchDisabled,
}: UserBubbleProps) {
  const { t } = useMobileI18n();
  const displayText = trimOuterBlankLines(
    normalizeDisplayText(String(message.content || "")),
  );
  const inputImages = message.metadata?.inputImages || [];
  if (!displayText.trim() && inputImages.length === 0) return null;
  const canRollback =
    !!message.backendMessageId && !message.streaming && !rollbackDisabled;
  const isInserted = message.metadata?.inputKind === "inserted";
  const canBranch =
    !!message.backendMessageId && !message.streaming && !branchDisabled;

  return (
    <article className={`bubble-row user ${isInserted ? "inserted" : ""}`}>
      <div className="bubble user">
        {isInserted ? (
          <div className="bubble-inserted-badge" title={t.messageList.insertedBadge}>
            <CornerUpRight size={12} />
            <span>{t.messageList.insertedBadge}</span>
          </div>
        ) : null}
        {displayText.trim() ? (
          <p>
            <MentionContent text={displayText} />
          </p>
        ) : null}
        {inputImages.length > 0 ? (
          <div className="bubble-user-images">
            {inputImages.map((image, index) => (
              <div key={`${image.attachmentId || "image"}-${index}`} className="bubble-user-image-chip">
                {String(image.previewDataUrl || "").trim() ? (
                  <img
                    src={String(image.previewDataUrl || "")}
                    alt={image.fileName || image.attachmentId || "image"}
                    loading="lazy"
                  />
                ) : (
                  <div className="bubble-user-image-placeholder">IMG</div>
                )}
                <span>{image.fileName || image.attachmentId || "image"}</span>
              </div>
            ))}
          </div>
        ) : null}
        <footer>
          <span>{formatClock(message.timestamp)}</span>
          {message.streaming ? (
            <span className="streaming">{t.common.streaming}</span>
          ) : null}
          {canBranch ? (
            <button
              type="button"
              className="bubble-branch-btn"
              onClick={() => onBranch(message)}
              disabled={!canBranch}
              title={t.messageList.branchFromHere}
            >
              <CornerUpRight size={14} />
              <span>{t.app.branch}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="bubble-rollback-btn"
            onClick={() => onRollback(message)}
            disabled={!canRollback}
            title={t.messageList.rollbackAndEdit}
          >
            <CornerUpLeft size={14} />
            <span>{t.messageList.rollback}</span>
          </button>
        </footer>
      </div>
    </article>
  );
});

interface AgentTurnBubbleProps {
  item: AgentTimelineItem;
  onAskDecision: (message: ChatMessage, decision: "allow" | "deny") => void;
  onOpenDetail: (turnId: string) => void;
}

const AgentTurnBubble = React.memo(function AgentTurnBubble({
  item,
  onAskDecision,
  onOpenDetail,
}: AgentTurnBubbleProps) {
  const { t } = useMobileI18n();
  const message = item.latestMessage;
  const messageTitle = messageTypeTitle(message, t.format);
  const preview = trimOuterBlankLines(messageDetail(message, t.format));
  const isText = message.type === "text";
  const isAsk = message.type === "ask";
  const isReasoning = message.type === "reasoning";
  const isCompaction = message.type === "compaction";
  const isToolLike =
    message.type === "command" ||
    message.type === "tool_call" ||
    message.type === "file_edit" ||
    message.type === "sub_tool" ||
    isReasoning ||
    isCompaction;
  const isSpecialActivity = (isReasoning || isCompaction) && item.streaming;
  const titleClassName = `agent-event-title${isReasoning || isCompaction ? " special" : ""}${isReasoning ? " reasoning" : ""}${isCompaction ? " compaction" : ""}${isSpecialActivity ? " sweeping" : ""}`;
  const decision = message.metadata?.decision;
  const showDecisionButtons =
    isAsk && decision !== "allow" && decision !== "deny";
  const markdownPreview = trimOuterBlankLines(
    normalizeDisplayText(message.content || ""),
  );
  const textPreview = markdownPreview || (item.streaming ? "..." : "");
  const eventPreview = isCompaction ? preview : preview || (item.streaming ? "..." : "");
  const shouldClampTextPreview = item.streaming;
  const isNowaitCommand =
    message.type === "command" && message.metadata?.isNowait === true;

  return (
    <article className="bubble-row assistant">
      <div className="bubble assistant agent-turn">
        {isText ? (
          <MarkdownContent
            className={`bubble-markdown ${shouldClampTextPreview ? "streaming-clamped" : ""} ${
              markdownPreview ? "" : "placeholder"
            }`}
            content={textPreview}
          />
        ) : (
          <div className="agent-event-preview">
            <div className={titleClassName}>
              {messageTitle}
              {isNowaitCommand ? (
                <span className="nowait-chip" title={t.messageList.nowaitBadge}>
                  {t.messageList.nowaitBadge}
                </span>
              ) : null}
            </div>
            {message.metadata?.commandOutput ? (
              <CommandOutputStatus message={message} />
            ) : null}
            {eventPreview ? (
              <pre
                className={`agent-event-body ${isToolLike ? "tool-fixed" : ""}${isCompaction ? " compaction" : ""}`}
              >
                {eventPreview}
              </pre>
            ) : null}
          </div>
        )}

        {showDecisionButtons ? (
          <div className="decision-actions">
            <button
              type="button"
              className="accent-btn"
              onClick={() => onAskDecision(message, "allow")}
            >
              {t.common.allow}
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={() => onAskDecision(message, "deny")}
            >
              {t.common.deny}
            </button>
          </div>
        ) : null}

        {isAsk && decision ? (
          <p className="decision-result">{t.common.decision(decision)}</p>
        ) : null}

        <footer>
          <span>{formatClock(message.timestamp || item.startedAt)}</span>
          {item.streaming ? (
            <span className="streaming">{t.common.streaming}</span>
          ) : null}
          <button
            type="button"
            className="bubble-detail-btn"
            onClick={() => onOpenDetail(item.id)}
          >
            {t.common.details}
          </button>
        </footer>
      </div>
    </article>
  );
});

const BoundaryMarker = React.memo(function BoundaryMarker() {
  return (
    <article className="bubble-row boundary">
      <div
        className="mobile-compaction-boundary"
        role="note"
        aria-label="Context compacted"
      >
        <span className="mobile-compaction-boundary-line" aria-hidden="true" />
        <span className="mobile-compaction-boundary-label">[CTX COMPACTED]</span>
        <span className="mobile-compaction-boundary-line" aria-hidden="true" />
      </div>
    </article>
  );
});

export function areMessageListPropsEqual(
  previous: MessageListProps,
  next: MessageListProps,
): boolean {
  return (
    previous.items === next.items &&
    previous.onAskDecision === next.onAskDecision &&
    previous.onOpenDetail === next.onOpenDetail &&
    previous.onRollback === next.onRollback &&
    previous.onBranch === next.onBranch &&
    previous.rollbackDisabled === next.rollbackDisabled &&
    previous.branchDisabled === next.branchDisabled &&
    previous.listRef === next.listRef
  );
}

const MessageListInner: React.FC<MessageListProps> = ({
  items,
  onAskDecision,
  onOpenDetail,
  onRollback,
  onBranch,
  rollbackDisabled,
  branchDisabled,
  listRef,
}) => {
  const { t } = useMobileI18n();

  return (
    <main className="message-list" ref={listRef}>
      {items.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">{t.messageList.emptyTitle}</p>
          <p className="empty-state-hint">{t.messageList.emptyHint}</p>
        </div>
      ) : (
        items.map((item) => {
          if (item.kind === "user") {
            return (
              <UserBubble
                key={item.id}
                message={item.message}
                onRollback={onRollback}
                onBranch={onBranch}
                rollbackDisabled={rollbackDisabled}
                branchDisabled={
                  branchDisabled || item.branchBlockedByUnsettledCommand
                }
              />
            );
          }
          if (item.kind === "boundary") {
            return <BoundaryMarker key={item.id} />;
          }
          return (
            <AgentTurnBubble
              key={item.id}
              item={item}
              onAskDecision={onAskDecision}
              onOpenDetail={onOpenDetail}
            />
          );
        })
      )}
    </main>
  );
};

export const MessageList = React.memo(
  MessageListInner,
  areMessageListPropsEqual,
);
