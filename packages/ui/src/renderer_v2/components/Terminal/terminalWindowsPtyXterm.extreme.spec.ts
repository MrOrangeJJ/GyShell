import pkg from '@xterm/headless'
import type { IWindowsPty } from '@xterm/headless'
import { resolveTerminalWindowsPty } from './terminalWindowsPty'

const { Terminal } = pkg

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const firstLineAfterShrink = async (windowsPty: IWindowsPty): Promise<string> => {
  const terminal = new Terminal({
    cols: 10,
    rows: 5,
    scrollback: 20,
    allowProposedApi: true,
    windowsPty
  })
  await new Promise<void>((resolve) => {
    terminal.write('abcdefghijABCDEFGHIJ', resolve)
  })
  terminal.resize(5, 5)
  const firstLine = terminal.buffer.active.getLine(0)?.translateToString(true) ?? ''
  terminal.dispose()
  return firstLine
}

const run = async (): Promise<void> => {
  const accidentalPosixFallback = await firstLineAfterShrink({
    backend: 'winpty',
    buildNumber: 0
  })
  const safeUnknownWindowsFallback = await firstLineAfterShrink(
    resolveTerminalWindowsPty('windows')!
  )

  assertEqual(
    accidentalPosixFallback,
    'abcde',
    'xterm 6.0 should demonstrate that a zero build accidentally enables reflow'
  )
  assertEqual(
    safeUnknownWindowsFallback,
    'abcdefghij',
    'unknown Windows sessions must keep pre-reflow ConPTY row semantics'
  )
  console.log('PASS unknown Windows fallback avoids xterm 6.0 POSIX reflow')
  console.log('All terminal windows pty xterm extreme tests passed.')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
