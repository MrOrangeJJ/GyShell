import React from "react";
import {
  buildTerminalSessionTitleMaps,
  type TerminalSessionTitleEntry,
  type TerminalSessionTitleMaps,
} from "../../lib/sessionTitleDisplay";

export interface TerminalSessionTitleState extends TerminalSessionTitleMaps {}

/** Loads historical titles once and overlays live Chat tabs on every render. */
export const useTerminalSessionTitles = (
  activeSessions: readonly TerminalSessionTitleEntry[],
): TerminalSessionTitleState => {
  const [historicalTitles, setHistoricalTitles] = React.useState<
    Record<string, string>
  >({});
  const activeSessionTitleSignature = activeSessions
    .map(
      (session) =>
        String(session?.id || "") + "\u0000" + String(session?.title || ""),
    )
    .join("\u0001");

  React.useEffect(() => {
    let cancelled = false;
    const loadSessionSummaries = async (): Promise<void> => {
      try {
        if (typeof window.gyshell.agent.listSessionSummaries !== "function") {
          return;
        }
        const summaries = await window.gyshell.agent.listSessionSummaries();
        if (cancelled || !Array.isArray(summaries)) return;
        const titleMap: Record<string, string> = {};
        for (const item of summaries) {
          if (item?.id && item?.title) titleMap[item.id] = item.title;
        }
        if (!cancelled) {
          setHistoricalTitles((previous) => ({ ...previous, ...titleMap }));
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[TerminalPanel] Failed to load session summaries.", error);
        }
      }
    };
    void loadSessionSummaries();
    return () => {
      cancelled = true;
    };
  }, []);

  return React.useMemo(
    () => buildTerminalSessionTitleMaps(historicalTitles, activeSessions),
    [activeSessionTitleSignature, activeSessions, historicalTitles],
  );
};
