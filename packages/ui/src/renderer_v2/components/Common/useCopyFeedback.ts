import React from "react";

/** How long a copy button shows its "copied" state. */
export const COPY_FEEDBACK_MS = 1400;

/** Writes text to the clipboard; false when empty or the write is refused. */
export const copyTextToClipboard = async (value: string): Promise<boolean> => {
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Transient "copied" feedback. `markCopied(key)` shows it for one key until
 * COPY_FEEDBACK_MS passes or another key is marked.
 */
export const useCopyFeedback = (): {
  copiedKey: string | null;
  markCopied: (key: string) => void;
} => {
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>();

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  const markCopied = React.useCallback((key: string) => {
    setCopiedKey(key);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, COPY_FEEDBACK_MS);
  }, []);

  return { copiedKey, markCopied };
};
