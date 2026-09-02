import React from "react";
import { parsePassChatMentionToken } from "@gyshell/shared";

const MENTION_TOKEN_REGEX =
  /(\[MENTION_(?:(?:SKILL|TAB|FILE|IMAGE|PASS_CHAT):#.+?#(?:#.+?#)?|PASS_CHAT_V2:#[^#\r\n]+#)\])/g;

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function tokenToText(
  token: string,
): {
  text: string;
  kind: "terminal" | "skill" | "file" | "pass-chat";
} | null {
  const skillMatch = token.match(/^\[MENTION_SKILL:#(.+?)#\]$/);
  if (skillMatch) {
    return { text: `@${skillMatch[1]}`, kind: "skill" };
  }

  const tabMatch = token.match(/^\[MENTION_TAB:#(.+?)##(.+?)#\]$/);
  if (tabMatch) {
    return { text: `@${tabMatch[1]}`, kind: "terminal" };
  }

  const fileMatch = token.match(/^\[MENTION_FILE:#(.+?)#\]$/);
  if (fileMatch) {
    return { text: fileNameFromPath(fileMatch[1]), kind: "file" };
  }

  const imageMatch = token.match(/^\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]$/);
  if (imageMatch) {
    return {
      text: imageMatch[2] || fileNameFromPath(imageMatch[1]),
      kind: "file",
    };
  }

  const passChat = parsePassChatMentionToken(token);
  if (passChat) {
    return {
      text: `@Pass Chat: ${passChat.title || "Chat"}`,
      kind: "pass-chat",
    };
  }

  return null;
}

export const MentionContent: React.FC<{ text: string }> = React.memo(
  ({ text }) => {
    const parts = React.useMemo(
      () => String(text || "").split(MENTION_TOKEN_REGEX),
      [text],
    );

    return (
      <>
        {parts.map((part, index) => {
          const parsed = tokenToText(part);
          if (!parsed) {
            return <React.Fragment key={`raw-${index}`}>{part}</React.Fragment>;
          }
          return (
            <span
              key={`mention-${index}`}
              className={`mention-inline ${parsed.kind}`}
            >
              {parsed.text}
            </span>
          );
        })}
      </>
    );
  },
);
