import type {
  TerminalActivitySnapshot,
  TerminalSessionBoundary,
} from "@gyshell/shared";

export interface TerminalRecoveryMetadataApi {
  getSessionBoundaries?: (
    terminalId: string,
  ) => Promise<{ boundaries?: TerminalSessionBoundary[] }>;
  getActivities?: (
    terminalId: string,
  ) => Promise<{ activities?: TerminalActivitySnapshot[] }>;
}

export interface TerminalRecoveryMetadata {
  activities: TerminalActivitySnapshot[];
  sessionBoundaries: TerminalSessionBoundary[];
}

/**
 * Metadata enriches recovery but must never prevent the terminal bytes from
 * being replayed when one supplementary store is unavailable.
 */
export const loadTerminalRecoveryMetadata = async (
  api: TerminalRecoveryMetadataApi,
  terminalId: string,
): Promise<TerminalRecoveryMetadata> => {
  const [boundariesResult, activitiesResult] = await Promise.allSettled([
    api.getSessionBoundaries
      ? Promise.resolve().then(() => api.getSessionBoundaries!(terminalId))
      : Promise.resolve({ boundaries: [] }),
    api.getActivities
      ? Promise.resolve().then(() => api.getActivities!(terminalId))
      : Promise.resolve({ activities: [] }),
  ]);

  return {
    sessionBoundaries:
      boundariesResult.status === "fulfilled"
        ? boundariesResult.value.boundaries || []
        : [],
    activities:
      activitiesResult.status === "fulfilled"
        ? activitiesResult.value.activities || []
        : [],
  };
};
