import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TerminalService } from '../TerminalService'
import { TerminalPersistenceStore } from './TerminalPersistenceStore'
import { TerminalStateStore } from './TerminalStateStore'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

const createService = (
  statePath: string,
  databasePath: string,
): TerminalService => {
  const service = new TerminalService({
    terminalStateStore: new TerminalStateStore(statePath),
    terminalPersistenceStore: new TerminalPersistenceStore(databasePath),
  })
  service.setRawEventPublisher(() => {})
  return service
}

const run = async (): Promise<void> => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gyshell-terminal-real-pty-'),
  )
  const statePath = path.join(tempDir, 'terminal-tabs-state.json')
  const databasePath = path.join(tempDir, 'terminal-persistence.sqlite')
  const terminalId = 'real-pty-persistence'
  const firstMarker = 'GYSHELL_REAL_PTY_PERSISTENCE_FIRST'
  const secondMarker = 'GYSHELL_REAL_PTY_PERSISTENCE_SECOND'
  let firstService: TerminalService | undefined
  let secondService: TerminalService | undefined

  try {
    firstService = createService(statePath, databasePath)
    await firstService.createTerminal({
      type: 'local',
      id: terminalId,
      title: 'Real PTY Persistence',
      cols: 100,
      rows: 30,
    })
    await waitUntil(
      () => firstService?.getTerminalRuntimeSnapshot(terminalId)?.canWrite === true,
      'real PTY did not become writable',
    )
    firstService.write(terminalId, `printf '${firstMarker}\\n'\r`)
    await waitUntil(
      () => firstService?.getBufferDelta(terminalId, 0).includes(firstMarker) === true,
      'real PTY output did not reach the TerminalService visible buffer',
    )
    firstService.flushPersistedState()
    firstService.closePersistedState()

    secondService = createService(statePath, databasePath)
    const restore = await secondService.restorePersistedTerminals()
    assertCondition(
      restore.restored.includes(terminalId),
      'real PTY terminal state should restore from terminal-tabs-state.json',
    )
    assertCondition(
      secondService.getBufferDelta(terminalId, 0).includes(firstMarker),
      'real PTY visible output should restore from terminal SQLite before live output',
    )
    await waitUntil(
      () => secondService?.getTerminalRuntimeSnapshot(terminalId)?.canWrite === true,
      'restored real PTY did not become writable',
    )
    secondService.write(terminalId, `printf '${secondMarker}\\n'\r`)
    await waitUntil(
      () => secondService?.getBufferDelta(terminalId, 0).includes(secondMarker) === true,
      'restored real PTY did not accept new live output',
    )

    firstService.kill(terminalId)
    secondService.kill(terminalId)
    secondService.closePersistedState()
    console.log('Real PTY terminal persistence test passed.')
  } finally {
    try {
      firstService?.closePersistedState()
    } catch {
      // The first service may already have closed its persistence store.
    }
    try {
      secondService?.closePersistedState()
    } catch {
      // The second service may already have closed its persistence store.
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
