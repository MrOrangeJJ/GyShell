import React from "react";
import { parsePassChatMentionToken } from "@gyshell/shared";
import { getFileMentionDisplayName } from "./filesystemDragDrop";
import { truncateMentionDisplayText } from "./mentionDisplay";

/**
 * Shared by:
 * 1) Chat message/queue mention rendering (`components/Chat/MessageRow.tsx`, `components/Chat/Queue/QueueCard.tsx`)
 * 2) Session-title text normalization (`lib/sessionTitleDisplay.ts`)
 */
const MENTION_TOKEN_REGEX =
  /(\[MENTION_(?:(?:SKILL|TAB|FILE|IMAGE|PASS_CHAT):#.+?#(?:#.+?#)?|PASS_CHAT_V2:#[^#\r\n]+#)\])/g;

const getFileDisplayName = (path: string): string => {
  return getFileMentionDisplayName(path) || path;
};

const mentionTokenToText = (token: string): string | null => {
  const skillMatch = token.match(/^\[MENTION_SKILL:#(.+?)#\]$/);
  if (skillMatch) {
    return `@${skillMatch[1]}`;
  }

  const terminalMatch = token.match(/^\[MENTION_TAB:#(.+?)##(.+?)#\]$/);
  if (terminalMatch) {
    return `@${terminalMatch[1]}`;
  }

  const fileMatch = token.match(/^\[MENTION_FILE:#(.+?)#\]$/);
  if (fileMatch) {
    return getFileDisplayName(fileMatch[1]);
  }

  const imageMatch = token.match(/^\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]$/);
  if (imageMatch) {
    const explicitName = String(imageMatch[2] || "").trim();
    return explicitName || getFileDisplayName(imageMatch[1]);
  }

  const passChat = parsePassChatMentionToken(token);
  if (passChat) {
    return `@Pass Chat: ${passChat.title || "Chat"}`;
  }

  return null;
};

/**
 * Split only validated mention tokens. A regex match that looks like a token
 * but fails the shared parser stays inside the surrounding literal text, so a
 * malformed canonical pass-chat token cannot be cosmetically reclassified.
 */
const splitMentionTokens = (content: string): string[] => {
  const parts: string[] = [];
  let cursor = 0;

  for (const match of content.matchAll(MENTION_TOKEN_REGEX)) {
    const index = match.index;
    const token = match[1] ?? match[0];
    if (index === undefined || mentionTokenToText(token) === null) continue;

    parts.push(content.slice(cursor, index));
    parts.push(token);
    cursor = index + match[0].length;
  }

  parts.push(content.slice(cursor));
  return parts;
};

/**
 * Convert mention labels to plain display text.
 * This is intended for places like session titles where we only need text,
 * not badge-like styled labels.
 */
export const renderMentionText = (content: string): string => {
  if (!content) return "";

  let text = splitMentionTokens(content)
    .map((part) => mentionTokenToText(part) ?? part)
    .join("");

  // Session titles can be truncated (e.g. first 20 chars), leaving incomplete tags.
  // Fallback to the same visible text rule for dangling mention patterns.
  text = text
    .replace(
      /\[MENTION_TAB:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g,
      (_m, name: string) => `@${name}`,
    )
    .replace(
      /\[MENTION_SKILL:#([^#\]\r\n]+)(?:#\])?/g,
      (_m, name: string) => `@${name}`,
    )
    .replace(
      /\[MENTION_FILE:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g,
      (_m, path: string) => getFileDisplayName(path),
    )
    .replace(
      /\[MENTION_IMAGE:#([^#\]\r\n]+)(?:##([^#\]\r\n]+))?(?:#\])?/g,
      (_m, path: string, name: string) =>
        String(name || "").trim() || getFileDisplayName(path),
    );

  return text;
};

/**
 * Unified logic for parsing and rendering Mention tags.
 * Converts text in the format [MENTION_XXX:#...#] into an array of React nodes.
 */
export const renderMentionContent = (
  content: string,
): (string | React.ReactElement)[] => {
  if (!content) return [];

  const parts = splitMentionTokens(content);

  return parts.map((part, i) => {
    const mentionText = mentionTokenToText(part);
    if (!mentionText) {
      return part;
    }

    if (mentionText.startsWith("@")) {
      const cls = part.startsWith("[MENTION_TAB:")
        ? "terminal"
        : part.startsWith("[MENTION_SKILL:")
          ? "skill"
          : part.startsWith("[MENTION_PASS_CHAT:") ||
              part.startsWith("[MENTION_PASS_CHAT_V2:")
            ? "pass-chat"
            : "terminal";
      return (
        <span
          key={`mention-${i}`}
          className={`mention-badge ${cls}`}
          title={mentionText}
        >
          {truncateMentionDisplayText(mentionText)}
        </span>
      );
    }

    if (
      part.startsWith("[MENTION_FILE:") ||
      part.startsWith("[MENTION_IMAGE:")
    ) {
      return (
        <span
          key={`mention-${i}`}
          className="mention-badge file"
          title={mentionText}
        >
          {truncateMentionDisplayText(mentionText)}
        </span>
      );
    }

    return part;
  });
};
