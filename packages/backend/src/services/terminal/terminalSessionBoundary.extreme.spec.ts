import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TerminalPersistenceStore } from './TerminalPersistenceStore'
import type { TerminalSessionBoundary } from '@gyshell/shared'

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'gyshell-session-boundary-test-'),
)

try {
  const dbPath = path.join(tempDir, 'boundaries.sqlite')
  const store = new TerminalPersistenceStore(dbPath)

  const boundaryA: TerminalSessionBoundary = {
    id: 'boundary-session-1',
    terminalId: 'term-boundary-test',
    resumedAt: 1774653427000,
    offset: 250,
    lastCommand: 'git status',
    exitCode: 0,
  }
  const boundaryB: TerminalSessionBoundary = {
    id: 'boundary-session-2',
    terminalId: 'term-boundary-test',
    resumedAt: 1774657027000,
    offset: 680,
    lastCommand: 'cargo build',
    exitCode: 1,
  }

  store.recordSessionBoundary(boundaryA)
  store.recordSessionBoundary(boundaryB)
  const retrieved = store.listSessionBoundaries('term-boundary-test')
  assert.equal(retrieved.length, 2, 'should retrieve exactly two recorded boundaries')
  assert.equal(retrieved[0].id, boundaryA.id)
  assert.equal(retrieved[0].lastCommand, boundaryA.lastCommand)
  assert.equal(retrieved[1].id, boundaryB.id)
  assert.equal(retrieved[1].exitCode, boundaryB.exitCode)

  store.clearAll()
  assert.equal(
    store.listSessionBoundaries('term-boundary-test').length,
    0,
    'clearAll should clear all session boundaries',
  )

  store.close()
  console.log('All terminal session boundary extreme tests passed.')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
