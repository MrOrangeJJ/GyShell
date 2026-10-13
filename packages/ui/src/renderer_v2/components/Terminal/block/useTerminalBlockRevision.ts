import React from "react";
import type { Terminal } from "@xterm/xterm";

/** Re-render cadence of the Block view while the terminal writes. */
const BLOCK_REVISION_THROTTLE_MS = 60;

/**
 * A counter that bumps (throttled) whenever the terminal's content, size or
 * active buffer changes, so the Block view re-reads the buffer. Only listens
 * while enabled (the view is shown in the active panel).
 */
export const useTerminalBlockRevision = (
  terminal: Terminal,
  enabled: boolean,
): number => {
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return undefined;
    let timer: number | undefined;
    const update = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        setRevision((value) => value + 1);
      }, BLOCK_REVISION_THROTTLE_MS);
    };
    const listeners = [
      terminal.onWriteParsed(update),
      terminal.onRender(update),
      terminal.onResize(update),
      terminal.buffer.onBufferChange(update),
    ];
    update();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      listeners.forEach((listener) => listener.dispose());
    };
  }, [enabled, terminal]);
  return revision;
};
