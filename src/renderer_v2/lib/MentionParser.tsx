import React from 'react';

/**
 * Shared by:
 * 1) Chat message/queue mention rendering (`components/Chat/MessageRow.tsx`, `components/Chat/Queue/QueueCard.tsx`)
 * 2) Session-title text normalization (`lib/sessionTitleDisplay.ts`)
 */
const MENTION_TOKEN_REGEX = /(\[MENTION_(?:SKILL|TAB|FILE|USER_PASTE):#.+?#(?:#.+?#)?\])/g;

const getFileDisplayName = (path: string): string => {
  return path.split(/[/\\]/).pop() || path;
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

  const pasteMatch = token.match(/^\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]$/);
  if (pasteMatch) {
    return pasteMatch[2];
  }

  return null;
};

/**
 * Convert mention labels to plain display text.
 * This is intended for places like session titles where we only need text,
 * not badge-like styled labels.
 */
export const renderMentionText = (content: string): string => {
  if (!content) return '';

  let text = content
    .split(MENTION_TOKEN_REGEX)
    .map((part) => mentionTokenToText(part) ?? part)
    .join('');

  // Session titles can be truncated (e.g. first 20 chars), leaving incomplete tags.
  // Fallback to the same visible text rule for dangling mention patterns.
  text = text
    .replace(/\[MENTION_TAB:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g, (_m, name: string) => `@${name}`)
    .replace(/\[MENTION_SKILL:#([^#\]\r\n]+)(?:#\])?/g, (_m, name: string) => `@${name}`)
    .replace(/\[MENTION_FILE:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g, (_m, path: string) => getFileDisplayName(path))
    .replace(/\[MENTION_USER_PASTE:#([^#\]\r\n]+)##([^#\]\r\n]+)(?:#\])?/g, (_m, _path: string, preview: string) => preview);

  return text;
};

/**
 * Unified logic for parsing and rendering Mention tags.
 * Converts text in the format [MENTION_XXX:#...#] into an array of React nodes.
 */
export const renderMentionContent = (content: string): (string | React.ReactElement)[] => {
  if (!content) return [];

  const parts = content.split(MENTION_TOKEN_REGEX);

  return parts.map((part, i) => {
    const mentionText = mentionTokenToText(part);
    if (!mentionText) {
      return part;
    }

    if (mentionText.startsWith('@')) {
      const cls = part.startsWith('[MENTION_TAB:')
        ? 'terminal'
        : part.startsWith('[MENTION_SKILL:')
          ? 'skill'
          : 'terminal';
      return (
        <span key={`mention-${i}`} className={`mention-badge ${cls}`}>
          {mentionText}
        </span>
      );
    }

    if (part.startsWith('[MENTION_FILE:')) {
      return (
        <span key={`mention-${i}`} className="mention-badge file">
          {mentionText}
        </span>
      );
    }

    if (part.startsWith('[MENTION_USER_PASTE:')) {
      return (
        <span key={`mention-${i}`} className="mention-badge paste">
          {mentionText}
        </span>
      );
    }

    return part;
  });
};
