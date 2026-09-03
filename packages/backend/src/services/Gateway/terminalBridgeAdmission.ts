export interface LiveTerminalBridgeRegistry {
  getTerminalById(terminalId: string): unknown;
}

/**
 * Keeps transport-only terminal operations on the same exact live-registry
 * boundary as model-visible tools. No normalization or historical fallback is
 * permitted for writes, resizes, selection changes, buffer reads, or closes.
 */
export const requireLiveTerminalBridgeTarget = (
  registry: LiveTerminalBridgeRegistry,
  terminalId: string,
): void => {
  if (!registry.getTerminalById(terminalId)) {
    throw new Error(`Terminal ${JSON.stringify(terminalId)} not found.`);
  }
};
