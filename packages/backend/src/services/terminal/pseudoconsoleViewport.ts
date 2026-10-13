/**
 * Windows pseudoconsoles (ConPTY) render with ABSOLUTE cursor rows relative to
 * their own viewport (`ESC[row;colH`). GyShell's renderer viewport can hold
 * rows the pseudoconsole never produced (restored history, session spacing,
 * the banner, synthetic agent transcripts) and can lack rows it did produce
 * (hidden agent dispatch echo). Once the two cursor rows diverge, the next
 * absolute move lands on the wrong renderer row and overwrites content until a
 * resize makes ConPTY repaint. These helpers produce the display-only bytes
 * that put the renderer back on the pseudoconsole's row grid without erasing
 * anything: content is scrolled into scrollback instead of being cleared.
 */

const clampRow = (value: number, rows: number): number =>
  Math.max(0, Math.min(rows - 1, Math.floor(value)))

/**
 * Push the top `usedRows` renderer rows into scrollback and home the cursor on
 * a blank viewport (the state of a freshly cleared pseudoconsole).
 */
export const buildPseudoconsoleViewportHandoff = (
  rows: number,
  usedRows: number,
): string => {
  const safeRows = Math.max(1, Math.floor(rows))
  const scrolled = Math.max(1, Math.min(safeRows, Math.floor(usedRows)))
  return `\x1b[${safeRows};1H${'\r\n'.repeat(scrolled)}\x1b[H`
}

/**
 * Move the renderer's current line (and everything above it) so that it sits
 * on the pseudoconsole's cursor row, then place the cursor exactly where the
 * pseudoconsole has it. Returns '' when the rows already agree.
 *
 * - renderer below pseudoconsole: scroll the viewport up (rows leave through
 *   the top into scrollback, nothing is erased);
 * - renderer above pseudoconsole: insert blank rows at the viewport top (the
 *   pseudoconsole has rows there that were deliberately not displayed).
 */
export const buildPseudoconsoleRowRealignment = (options: {
  rows: number
  rendererCursorY: number
  pseudoconsoleCursorY: number
  pseudoconsoleCursorX: number
}): string => {
  const rows = Math.max(1, Math.floor(options.rows))
  const rendererY = clampRow(options.rendererCursorY, rows)
  const targetY = clampRow(options.pseudoconsoleCursorY, rows)
  const targetX = Math.max(0, Math.floor(options.pseudoconsoleCursorX))
  if (rendererY === targetY) return ''
  const place = `\x1b[${targetY + 1};${targetX + 1}H`
  if (rendererY > targetY) {
    return `\x1b[${rows};1H${'\n'.repeat(rendererY - targetY)}${place}`
  }
  return `\x1b[1;1H\x1b[${targetY - rendererY}L${place}`
}
