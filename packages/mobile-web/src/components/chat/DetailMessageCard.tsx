import React from "react";
import {
  clipMultilineWithLocale,
  formatClock,
  messageDetail,
  messageTypeTitle,
} from "../../format";
import { useMobileI18n } from "../../i18n/provider";
import {
  isEmptyMessageContent,
  normalizeDisplayText,
  trimOuterBlankLines,
} from "../../session-store";
import type { ChatMessage } from "../../types";
import { MarkdownContent } from "../common/MarkdownContent";
import { MentionContent } from "../common/MentionContent";
import { CommandOutputStatus } from "./CommandOutputStatus";

interface DetailMessageCardProps {
  message: ChatMessage;
  onAskDecision: (message: ChatMessage, decision: "allow" | "deny") => void;
}

export const DetailMessageCard: React.FC<DetailMessageCardProps> = ({
  message,
  onAskDecision,
}) => {
  const { t } = useMobileI18n();
  const toolPreviewLines = 8;
  const toolPreviewChars = 420;
  const [expanded, setExpanded] = React.useState(false);
  const isToolLikeMessage =
    message.type === "command" ||
    message.type === "tool_call" ||
    message.type === "file_edit" ||
    message.type === "sub_tool" ||
    message.type === "reasoning" ||
    message.type === "compaction";

  if (message.type === "text") {
    const displayText = trimOuterBlankLines(
      normalizeDisplayText(message.content || ""),
    );
    const inputImages = message.metadata?.inputImages || [];
    if (!displayText.trim() && inputImages.length === 0) return null;

    return (
      <article className={`event-card detail-text ${message.role}`}>
        <header>
          <strong>
            {message.role === "assistant"
              ? t.detail.assistantText
              : t.detail.systemText}
          </strong>
          <span>{formatClock(message.timestamp)}</span>
        </header>
        {message.role === "assistant" ? (
          <MarkdownContent className="detail-markdown" content={displayText} />
        ) : (
          <>
            {displayText.trim() ? (
              <p className="detail-text-body">
                <MentionContent text={displayText} />
              </p>
            ) : null}
            {inputImages.length > 0 ? (
              <div className="detail-user-images">
                {inputImages.map((image, index) => (
                  <div key={`${image.attachmentId || "image"}-${index}`} className="detail-user-image-chip">
                    {String(image.previewDataUrl || "").trim() ? (
                      <img
                        src={String(image.previewDataUrl || "")}
                        alt={image.fileName || image.attachmentId || "image"}
                        loading="lazy"
                      />
                    ) : (
                      <div className="detail-user-image-placeholder">IMG</div>
                    )}
                    <span>{image.fileName || image.attachmentId || "image"}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </article>
    );
  }

  const title = messageTypeTitle(message, t.format);
  const detail = trimOuterBlankLines(messageDetail(message, t.format));
  if (
    !detail.trim() &&
    isEmptyMessageContent(message) &&
    message.type !== "ask" &&
    message.type !== "command"
  ) {
    return null;
  }

  const detailLines = detail.split("\n").length;
  const showExpandToggle =
    isToolLikeMessage &&
    (detailLines > toolPreviewLines || detail.length > toolPreviewChars);
  const detailToRender =
    showExpandToggle && !expanded
      ? clipMultilineWithLocale(
          detail,
          toolPreviewLines,
          t.format,
          toolPreviewChars,
        )
      : detail;

  const decision = message.metadata?.decision;
  const showDecisionButtons =
    message.type === "ask" && decision !== "allow" && decision !== "deny";

  return (
    <article
      className={`event-card detail-card ${isToolLikeMessage ? "tool-like" : message.type}`}
    >
      <header>
        <div className="event-title-group">
          {isToolLikeMessage ? (
            <span className="event-chip">{t.common.tool}</span>
          ) : null}
          <strong>{title}</strong>
        </div>
        <span>{formatClock(message.timestamp)}</span>
      </header>

      {message.metadata?.commandOutput ? (
        <CommandOutputStatus message={message} />
      ) : null}

      {detailToRender ? (
        <pre
          className={
            isToolLikeMessage
              ? `toolcall-detail ${showExpandToggle && !expanded ? "is-collapsed" : ""}`
              : ""
          }
        >
          {detailToRender}
        </pre>
      ) : null}

      {showExpandToggle ? (
        <button
          type="button"
          className="event-expand-btn"
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? t.common.collapse : t.common.expand}
        </button>
      ) : null}

      {message.type === "error" && message.metadata?.details ? (
        <pre>{message.metadata.details}</pre>
      ) : null}

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

      {message.type === "ask" && decision ? (
        <p className="decision-result">{t.common.decision(decision)}</p>
      ) : null}
    </article>
  );
};
