/**
 * Clean widening of a shell's in-progress command line.
 *
 * xterm keeps the wrapped rows that hold the cursor as they are on resize
 * (`reflowCursorLine: false`) because the shell redraws that line itself.
 * Bash/readline redraws from the line's first row at the new width but never
 * clears the old continuation rows it no longer fills, so widening a wrapped,
 * half-typed command leaves stale text behind:
 *
 *   $ echo "pending command that is long enough to wrap twice in the
 *   narrow panel ok" enough to wrap twice in the     <- stale tail
 *
 * Blanking every continuation row (keeping the cursor where it is) before the
 * shell receives SIGWINCH lets its redraw land on clean rows. Shells that
 * redraw the whole line anyway (zsh, fish) are unaffected.
 */

interface PromptLineBufferLine {
  readonly isWrapped: boolean
}

export interface PromptLineBuffer {
  readonly type: 'normal' | 'alternate'
  readonly cursorX: number
  readonly cursorY: number
  readonly baseY: number
  getLine(y: number): PromptLineBufferLine | undefined
}

const CSI = '\x1b['

/**
 * Control sequence that erases the continuation rows of the wrapped line the
 * cursor is on and returns the cursor to its exact cell. Empty when the line
 * is a single row, or on the alternate screen. Only relative cursor motions
 * are used, so it applies identically to every replica of the screen
 * regardless of scrollback depth. `viewportRows` bounds the rows it may touch.
 */
export const buildPromptContinuationClear = (
  buffer: PromptLineBuffer,
  viewportRows: number
): string => {
  if (buffer.type !== 'normal' || viewportRows <= 0) return ''
  const cursor = buffer.baseY + buffer.cursorY
  let start = cursor
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1
  let end = cursor
  while (buffer.getLine(end + 1)?.isWrapped) end += 1
  // Viewport-relative rows; relative motions cannot reach scrollback.
  const first = Math.max(start + 1, buffer.baseY) - buffer.baseY
  const last = Math.min(end, buffer.baseY + viewportRows - 1) - buffer.baseY
  if (last < first) return ''

  const move = (from: number, to: number): string =>
    to < from ? `${CSI}${from - to}A` : to > from ? `${CSI}${to - from}B` : ''
  let sequence = move(buffer.cursorY, first)
  for (let row = first; row <= last; row += 1) {
    if (row > first) sequence += `${CSI}B`
    sequence += `${CSI}2K`
  }
  return `${sequence}${move(last, buffer.cursorY)}${CSI}${buffer.cursorX + 1}G`
}
