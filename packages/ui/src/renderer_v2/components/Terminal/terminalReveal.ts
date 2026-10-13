/**
 * Where to land when the user jumps from a Block to the Classic terminal.
 *
 * The command row goes near the top with a little of the previous output
 * above it, so the reader sees where the command starts (not a row cut at the
 * edge) and as much of its output as fits. Short scrollback clamps naturally.
 */
export const resolveTerminalRevealContextRows = (viewportRows: number): number => {
  const rows = Math.max(0, Math.floor(viewportRows));
  // Never let context push the command row itself off screen.
  return Math.min(Math.max(0, rows - 1), Math.max(1, Math.min(3, Math.floor(rows / 12))));
};

export const resolveTerminalRevealTop = (input: {
  commandLine: number;
  viewportRows: number;
  /** Largest valid viewport top (buffer.baseY). */
  maxTop: number;
}): number => {
  const context = resolveTerminalRevealContextRows(input.viewportRows);
  const top = Math.floor(input.commandLine) - context;
  return Math.max(0, Math.min(Math.max(0, Math.floor(input.maxTop)), top));
};

/**
 * Where to put a Block's top edge when it is the target of a jump: a small
 * gap below the stream's top edge, so the header does not touch the edge and
 * the previous block's last row stays visible as context.
 */
export const resolveBlockRevealScrollTop = (input: {
  blockTop: number;
  viewportHeight: number;
  maxScrollTop: number;
  rowHeight: number;
}): number => {
  const gap = Math.min(
    Math.max(0, input.rowHeight) * 1.5,
    Math.max(0, input.viewportHeight) * 0.15,
  );
  const top = Math.round(input.blockTop - gap);
  return Math.max(0, Math.min(Math.max(0, input.maxScrollTop), top));
};
