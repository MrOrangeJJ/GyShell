import React from 'react';

/**
 * Unified logic for parsing and rendering Mention tags.
 * Converts text in the format [MENTION_XXX:#...#] into an array of React nodes.
 */
export const renderMentionContent = (content: string): (string | React.ReactElement)[] => {
  if (!content) return [];

  // Match all types of MENTION tags
  const regex = /(\[MENTION_(?:SKILL|TAB|FILE|USER_PASTE):#.+?#(?:#.+?#)?\])/g;
  const parts = content.split(regex);

  return parts.map((part, i) => {
    // 1. Skill tag: [MENTION_SKILL:#name#]
    const skillMatch = part.match(/\[MENTION_SKILL:#(.+?)#\]/);
    if (skillMatch) {
      return (
        <span key={`skill-${i}`} className="mention-badge skill">
          @{skillMatch[1]}
        </span>
      );
    }

    // 2. Terminal Tab tag: [MENTION_TAB:#name##id#]
    const terminalMatch = part.match(/\[MENTION_TAB:#(.+?)##(.+?)#\]/);
    if (terminalMatch) {
      return (
        <span key={`terminal-${i}`} className="mention-badge terminal">
          @{terminalMatch[1]}
        </span>
      );
    }

    // 3. File tag: [MENTION_FILE:#path#]
    const fileMatch = part.match(/\[MENTION_FILE:#(.+?)#\]/);
    if (fileMatch) {
      const fileName = fileMatch[1].split(/[/\\]/).pop() || fileMatch[1];
      return (
        <span key={`file-${i}`} className="mention-badge file">
          {fileName}
        </span>
      );
    }

    // 4. User Paste tag: [MENTION_USER_PASTE:#path##preview#]
    const pasteMatch = part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/);
    if (pasteMatch) {
      return (
        <span key={`paste-${i}`} className="mention-badge paste">
          {pasteMatch[2]}
        </span>
      );
    }

    // Plain text
    return part;
  });
};
