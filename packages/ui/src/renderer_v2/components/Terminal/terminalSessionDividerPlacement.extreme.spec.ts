import pkg from '@xterm/headless'
import {
  isEmptySessionBetween,
  resolveSessionDividerRow,
} from './terminalSessionDividerPlacement'

const { Terminal } = pkg

const assertEqual = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const buffer = (lines: string[], viewportY: number, rows: number) => ({
  viewportY,
  rows,
  lineText: (line: number) => lines[line],
})

const lines = ['PS C:\\> old', 'old output', 'PS C:\\> ', '', 'PS C:\\> new', 'output']

assertEqual(resolveSessionDividerRow(3, buffer(lines, 0, 6)), 3, 'blank reserved row is drawn')
assertEqual(resolveSessionDividerRow(3, buffer(lines, 2, 4)), 1, 'row is viewport relative')
assertEqual(resolveSessionDividerRow(3, buffer(lines, 4, 2)), undefined, 'scrolled above viewport')
assertEqual(resolveSessionDividerRow(3, buffer(lines, 0, 3)), undefined, 'below viewport')
assertEqual(resolveSessionDividerRow(2, buffer(lines, 0, 6)), undefined, 'never covers a prompt')
const cleared = [...lines]
cleared[3] = 'PS C:\\> dir   # redrawn after clear-screen'
assertEqual(resolveSessionDividerRow(3, buffer(cleared, 0, 6)), undefined, 'never covers output written later')
assertEqual(resolveSessionDividerRow(3, buffer(['   ', '', '', '\t '], 0, 4)), 3, 'whitespace-only row counts as blank')
assertEqual(resolveSessionDividerRow(9, buffer(lines, 0, 20)), undefined, 'missing line is not drawn')
assertEqual(resolveSessionDividerRow(-1, buffer(lines, 0, 6)), undefined, 'disposed marker line (-1) is not drawn')

const clearScreenKeepsDivider = async (): Promise<void> => {
  const term = new Terminal({
    cols: 30,
    rows: 6,
    scrollback: 100,
    scrollOnEraseInDisplay: true,
    allowProposedApi: true,
  })
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve))
  await write('restored 1\r\nPS> ')
  const marker = term.registerMarker(1)!
  await write('\r\n\r\nPS> echo new\r\nnew\r\nPS> ')
  const view = () => ({
    viewportY: term.buffer.active.viewportY,
    rows: term.rows,
    lineText: (line: number) => term.buffer.active.getLine(line)?.translateToString(true),
  })
  const markerLine = marker.line
  assertEqual(resolveSessionDividerRow(markerLine, view()), markerLine, 'divider visible before clear')
  await write('\x1b[H\x1b[2J')
  await write('PS> after clear')
  assertEqual(marker.isDisposed, false, 'clear-screen keeps the divider marker')
  assertEqual(marker.line, markerLine, 'divider marker keeps its line in scrollback')
  assertEqual(
    term.buffer.active.getLine(markerLine)?.translateToString(true),
    '',
    'reserved row is not overwritten by post-clear output',
  )
  assertEqual(
    term.buffer.active.getLine(markerLine - 1)?.translateToString(true),
    'PS> ',
    'restored prompt above the divider is preserved',
  )
  await write('\x1b[3J')
  assertEqual(marker.isDisposed, true, 'clear-scrollback removes the divider')
  term.dispose()
}

// Back-to-back resumes with nothing in between collapse to the later divider.
{
  const stacked = ['PS C:\\> old', '', '', '', '', 'PS C:\\> new']
  const text = (line: number) => stacked[line]
  assertEqual(isEmptySessionBetween(1, 2, text), true, 'adjacent dividers: earlier one is redundant')
  assertEqual(isEmptySessionBetween(2, 4, text), true, 'only spacing rows between dividers: redundant')
  assertEqual(isEmptySessionBetween(4, 6, text), false, 'a prompt between dividers keeps both')
  assertEqual(isEmptySessionBetween(0, 5, (l) => (l === 3 ? '   ' : stacked[l])), true, 'whitespace-only rows are blank')
}

void clearScreenKeepsDivider()
  .then(() => console.log('All terminal session divider placement tests passed.'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
