/**
 * The "Session Resumed" divider is an opaque overlay covering one full xterm
 * row. It must only ever cover the blank spacing row the backend reserved for
 * it. Anything that later writes onto that row (clear-screen, a ConPTY repaint
 * after resize, reflow, a full-screen redraw) would otherwise be hidden under
 * the divider, so in that case the divider is not drawn at all.
 */
export type SessionDividerBuffer = {
  viewportY: number
  rows: number
  /** Visible text of an absolute buffer line, or undefined if out of range. */
  lineText: (line: number) => string | undefined
}

export const resolveSessionDividerRow = (
  markerLine: number,
  buffer: SessionDividerBuffer,
): number | undefined => {
  if (!Number.isInteger(markerLine) || markerLine < 0) return undefined
  const row = markerLine - buffer.viewportY
  if (row < 0 || row >= buffer.rows) return undefined
  const text = buffer.lineText(markerLine)
  if (text === undefined || text.trim() !== '') return undefined
  return row
}

/**
 * A session that printed nothing (for example the app was closed again before
 * the shell produced a prompt, or a connection never came up) must not leave
 * a stack of "Session Resumed" dividers. A divider is redundant when every row
 * between it and the next divider is blank; only the later one is drawn.
 */
export const isEmptySessionBetween = (
  dividerLine: number,
  nextDividerLine: number,
  lineText: (line: number) => string | undefined,
): boolean => {
  for (let line = dividerLine + 1; line < nextDividerLine; line += 1) {
    const text = lineText(line)
    if (text !== undefined && text.trim() !== '') return false
  }
  return true
}
