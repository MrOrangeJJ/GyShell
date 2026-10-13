/**
 * Windows "cursor jumps back into existing content" (ConPTY row drift).
 *
 * Each case first reproduces the overwrite with a headless renderer fed the
 * same bytes GyShell sends to xterm, then proves the realignment bytes keep
 * every renderer row intact and the renderer cursor on ConPTY's row.
 * `shadow` = ConPTY's own screen (raw PTY bytes only).
 */
import pkg from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
import {
  buildPseudoconsoleRowRealignment,
  buildPseudoconsoleViewportHandoff,
} from './pseudoconsoleViewport'

const { Terminal } = pkg
const ROWS = 12
const COLS = 40

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}
const make = (): TerminalType =>
  new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
const write = (term: TerminalType, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve))
const lines = (term: TerminalType): string[] => {
  const out: string[] = []
  const buffer = term.buffer.active
  for (let i = 0; i < buffer.length; i += 1) {
    out.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  return out
}
const realign = (renderer: TerminalType, shadow: TerminalType) =>
  buildPseudoconsoleRowRealignment({
    rows: ROWS,
    rendererCursorY: renderer.buffer.active.cursorY,
    pseudoconsoleCursorY: shadow.buffer.active.cursorY,
    pseudoconsoleCursorX: shadow.buffer.active.cursorX,
  })

// ConPTY after a fresh Clear-Host: everything addressed by absolute row.
const conptyStartup =
  '\x1b[1;1HPS C:\\> dir' +
  '\x1b[3;1H    Directory: C:\\Users\\X' +
  '\x1b[5;1HMode   Name' +
  '\x1b[6;1Hd----  Desktop' +
  '\x1b[8;1HPS C:\\> '
const restored = (count: number) =>
  Array.from({ length: count }, (_, i) => `history ${i}`).join('\r\n') + '\r\n\r\n'

const runCase = async (name: string, fn: () => Promise<void>) => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async () => {
  for (const historyLines of [0, 3, 20]) {
    await runCase(`restored history (${historyLines} lines) + new ConPTY runtime`, async () => {
      const broken = make()
      const banner = 'BANNER\r\n'
      await write(broken, restored(historyLines) + banner)
      await write(broken, conptyStartup)
      const brokenText = lines(broken).join('\n')
      const expected = [
        ...Array.from({ length: historyLines }, (_, i) => `history ${i}`),
        'BANNER',
      ]
      assert(
        expected.some((line) => !brokenText.includes(line)),
        'repro: ConPTY absolute rows overwrite renderer-only rows',
      )

      const fixed = make()
      await write(fixed, restored(historyLines) + banner)
      await write(
        fixed,
        buildPseudoconsoleViewportHandoff(ROWS, fixed.buffer.active.cursorY + 1),
      )
      await write(fixed, conptyStartup)
      const all = lines(fixed)
      for (const line of expected) assert(all.includes(line), `${line} must survive`)
      const prompt = all.indexOf('PS C:\\> dir')
      assert(prompt > all.lastIndexOf('BANNER'), 'runtime output follows restored rows')
      assert(all[fixed.buffer.active.baseY] === 'PS C:\\> dir', 'viewport tops agree')
      assert(
        fixed.buffer.active.cursorY === 7 && fixed.buffer.active.cursorX === 8,
        'renderer cursor equals ConPTY cursor',
      )
    })
  }

  await runCase('synthetic agent transcript (renderer gains rows ConPTY never drew)', async () => {
    const prompt = '\x1b[1;1HPS C:\\> '
    // ConPTY: the hidden dispatch line is echoed, output goes to a sidecar
    // file, then a new prompt on the next row.
    const conptyAgentRun = '. $global:__gyshell_dispatch\r\nPS C:\\> '
    // Renderer: hidden echo suppressed; synthetic transcript appended instead.
    const transcript =
      'git log --oneline\r\n' +
      Array.from({ length: 6 }, (_, i) => `commit ${i}`).join('\r\n') +
      '\r\nPS C:\\> '
    // PSReadLine redraws the input line with an absolute move to ConPTY's row.
    const psReadLineRedraw = '\x1b[2;9Hls'

    const broken = make()
    await write(broken, prompt + transcript + psReadLineRedraw)
    assert(
      lines(broken).includes('commit 0ls') &&
        !lines(broken).includes('PS C:\\> ls'),
      'repro: typing after a transcript overwrites the transcript',
    )

    const renderer = make()
    const shadow = make()
    await write(renderer, prompt + transcript)
    await write(shadow, prompt + conptyAgentRun)
    const fix = realign(renderer, shadow)
    assert(fix.length > 0, 'rows disagree after the transcript')
    await write(renderer, fix)
    assert(realign(renderer, shadow) === '', 'realignment is idempotent')
    await write(renderer, psReadLineRedraw)
    await write(shadow, psReadLineRedraw)
    const all = lines(renderer)
    assert(all.includes('PS C:\\> git log --oneline'), 'transcript header survives')
    for (let i = 0; i < 6; i += 1) assert(all.includes(`commit ${i}`), `commit ${i} survives`)
    assert(
      all[renderer.buffer.active.baseY + renderer.buffer.active.cursorY] === 'PS C:\\> ls',
      'typed input lands on the live prompt line',
    )
    assert(
      renderer.buffer.active.cursorY === shadow.buffer.active.cursorY &&
        renderer.buffer.active.cursorX === shadow.buffer.active.cursorX,
      'renderer and ConPTY cursors agree',
    )
  })

  await runCase('hidden ConPTY rows (renderer above ConPTY) insert blank rows, keep content', async () => {
    const renderer = make()
    const shadow = make()
    await write(renderer, 'PS C:\\> first\r\nPS C:\\> ')
    await write(shadow, 'PS C:\\> first\r\n. hidden\r\n. hidden\r\nPS C:\\> ')
    await write(renderer, realign(renderer, shadow))
    assert(realign(renderer, shadow) === '', 'aligned')
    await write(renderer, '\x1b[4;9Hdir')
    const all = lines(renderer)
    assert(all.includes('PS C:\\> first'), 'earlier content preserved')
    assert(all.includes('PS C:\\> dir'), 'input on the live prompt row')
    assert(!all.some((line) => line.includes('hidden')), 'hidden dispatch rows stay hidden')
  })

  await runCase('full viewport: renderer cursor at the bottom row', async () => {
    const renderer = make()
    const shadow = make()
    await write(renderer, Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\r\n'))
    await write(shadow, 'row 29')
    await write(renderer, realign(renderer, shadow))
    assert(renderer.buffer.active.cursorY === 0, 'cursor moved to ConPTY row')
    const all = lines(renderer)
    for (let i = 0; i < 30; i += 1) assert(all.includes(`row ${i}`), `row ${i} kept`)
    await write(renderer, '\x1b[1;7H!')
    assert(lines(renderer).includes('row 29!'), 'ConPTY absolute write hits the same row')
  })

  assert(
    buildPseudoconsoleRowRealignment({
      rows: ROWS,
      rendererCursorY: 3,
      pseudoconsoleCursorY: 3,
      pseudoconsoleCursorX: 5,
    }) === '',
    'no bytes when rows already agree',
  )
  console.log('All pseudoconsole viewport tests passed.')
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
