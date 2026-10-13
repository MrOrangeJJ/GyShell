import pkg from '@xterm/headless'
import { buildPromptContinuationClear } from './promptLineReflow'

const { Terminal } = pkg

let failures = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`PASS ${name}`)
  else {
    failures += 1
    console.error(`FAIL ${name}`, detail ?? '')
  }
}

const write = (term: InstanceType<typeof Terminal>, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve))

const rows = (term: InstanceType<typeof Terminal>): string[] => {
  const buffer = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buffer.length; y += 1) {
    const text = buffer.getLine(y)!.translateToString(true)
    if (text) out.push(text)
  }
  return out
}

const PROMPT = 'host:~ me$ '
const LINE =
  'echo "pending command that is long enough to wrap twice in the narrow panel ok, and more text"'

/**
 * What bash/readline emits on SIGWINCH (_rl_redisplay_after_sigwinch):
 * go to the last screen row of the line, CR, clear it, climb to the first
 * row, then redraw prompt + line at the new width without clearing below.
 */
const bashRedrawAfterResize = (oldRowsOfLine: number, cursorRow: number) =>
  `${'\x1b[B'.repeat(oldRowsOfLine - 1 - cursorRow)}\r\x1b[K${'\x1b[A'.repeat(oldRowsOfLine - 1)}${PROMPT}${LINE}`

const widen = async (withClear: boolean, cursorLeft = 0) => {
  const term = new Terminal({ cols: 45, rows: 10, allowProposedApi: true })
  await write(term, `previous output\r\n${PROMPT}${LINE}`)
  if (cursorLeft) await write(term, `\x1b[${cursorLeft}D`)
  const oldRows = Math.ceil((PROMPT.length + LINE.length) / 45)
  const startRow = 1
  const cursorRowInLine = term.buffer.active.cursorY - startRow
  term.resize(90, 10)
  if (withClear) {
    const before = { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }
    await write(term, buildPromptContinuationClear(term.buffer.active, term.rows))
    check(
      `cursor restored (left ${cursorLeft})`,
      term.buffer.active.cursorX === before.x && term.buffer.active.cursorY === before.y,
      { before, after: [term.buffer.active.cursorX, term.buffer.active.cursorY] }
    )
  }
  await write(term, bashRedrawAfterResize(oldRows, cursorRowInLine))
  const result = rows(term)
  term.dispose()
  return result
}

const expected = [
  'previous output',
  `${PROMPT}${LINE}`.slice(0, 90),
  `${PROMPT}${LINE}`.slice(90)
]

const main = async () => {
  // Negative control: reproduces the stale tail seen in the app.
  const garbled = await widen(false)
  check(
    'without the clear, bash leaves a stale tail (reproduction)',
    garbled.length === 3 && garbled[2] !== expected[2] && garbled[2].startsWith(expected[2]),
    garbled
  )

  const clean = await widen(true)
  check('widened line redraws cleanly', JSON.stringify(clean) === JSON.stringify(expected), clean)

  const midLine = await widen(true, 50)
  check(
    'cursor moved left into an earlier row still redraws cleanly',
    JSON.stringify(midLine) === JSON.stringify(expected),
    midLine
  )

  // Blanked rows lose the wrapped flag; the redraw re-wraps exactly once.
  {
    const term = new Terminal({ cols: 45, rows: 10, allowProposedApi: true })
    await write(term, `${PROMPT}${LINE}`)
    term.resize(90, 10)
    await write(term, buildPromptContinuationClear(term.buffer.active, term.rows))
    await write(term, `\r\x1b[K\x1b[A\x1b[A${PROMPT}${LINE}`)
    const wrapped = [0, 1, 2].map((y) => term.buffer.active.getLine(y)!.isWrapped)
    check('wrap flags match the new layout', JSON.stringify(wrapped) === '[false,true,false]', wrapped)
    term.dispose()
  }

  {
    const term = new Terminal({ cols: 45, rows: 10, allowProposedApi: true })
    await write(term, `${PROMPT}echo short`)
    check('single-row line: nothing to clear', buildPromptContinuationClear(term.buffer.active, term.rows) === '')
    await write(term, '\x1b[?1049h')
    check('alternate screen: nothing to clear', buildPromptContinuationClear(term.buffer.active, term.rows) === '')
    term.dispose()
  }

  // Continuation rows below the cursor (cursor on the first row).
  {
    const term = new Terminal({ cols: 45, rows: 10, allowProposedApi: true })
    await write(term, `${PROMPT}${LINE}\x1b[2A\x1b[5G`)
    term.resize(90, 10)
    const sequence = buildPromptContinuationClear(term.buffer.active, term.rows)
    await write(term, sequence)
    check(
      'rows below the cursor are cleared, first row kept',
      rows(term).length === 1 && rows(term)[0] === `${PROMPT}${LINE}`.slice(0, 45),
      { rows: rows(term), sequence: JSON.stringify(sequence) }
    )
    check('cursor stays on the first row', term.buffer.active.cursorY === 0 && term.buffer.active.cursorX === 4)
    term.dispose()
  }

  // Only rows inside the viewport are touched; scrollback is never reached.
  {
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true })
    await write(term, `${PROMPT}${'x'.repeat(80)}`)
    const before = rows(term).slice(0, -3)
    term.resize(40, 3)
    await write(term, buildPromptContinuationClear(term.buffer.active, term.rows))
    const after = rows(term)
    check(
      'scrollback rows are left untouched',
      JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before),
      { before, after }
    )
    term.dispose()
  }

  if (failures > 0) {
    console.error(`${failures} failure(s)`)
    process.exit(1)
  }
  console.log('All promptLineReflow checks passed')
}

void main()
