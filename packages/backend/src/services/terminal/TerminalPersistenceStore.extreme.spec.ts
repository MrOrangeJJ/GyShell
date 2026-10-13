import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalActivitySnapshot } from '@gyshell/shared'
import { TerminalPersistenceStore } from './TerminalPersistenceStore'
import { openBetterSqlite3Database } from '../history/betterSqlite3Runtime'
import type { PersistedAgentCommandRecord } from './TerminalPersistenceStore'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const capture = (
  state: 'in_progress' | 'complete' | 'unknown',
  output: string,
): PersistedAgentCommandRecord['capture'] => ({
  state,
  ...(state === 'unknown' ? { reason: 'runtime_boundary' as const } : {}),
  observedUtf8Bytes: Buffer.byteLength(output, 'utf8'),
  retainedUtf8Bytes: Buffer.byteLength(output, 'utf8'),
  availableLineCount: output ? output.split('\n').length : 0,
  revision: 1,
  terminalControlsObserved: false,
})

const activity = (
  terminalId: string,
  status: TerminalActivitySnapshot['status'],
): TerminalActivitySnapshot => ({
  id: `${terminalId}-activity`,
  terminalId,
  kind: 'command',
  actor: 'agent',
  origin: 'agent-exec-command',
  status,
  revision: 1,
  startedAt: 10,
  updatedAt: 20,
  ...(status !== 'running' ? { endedAt: 20, endOffset: 8 } : {}),
  command: 'printf persisted',
  intent: 'persist',
  startOffset: 0,
  runtimeGeneration: 7,
})

const command = (
  terminalId: string,
  status: PersistedAgentCommandRecord['status'],
  executionState: PersistedAgentCommandRecord['executionState'],
  output: string,
): PersistedAgentCommandRecord => ({
  commandId: `${terminalId}-command`,
  terminalId,
  command: 'printf persisted',
  status,
  executionState,
  runtimeBoundary: executionState === 'outcome_unknown',
  outcomeUnknown: executionState === 'outcome_unknown',
  startOffset: 0,
  startedAt: 10,
  ...(status !== 'running' ? { endedAt: 20, endOffset: output.length } : {}),
  capture: capture(
    executionState === 'running' ? 'in_progress' : 'complete',
    output,
  ),
  output,
})

const run = (): void => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gyshell-terminal-persistence-store-'),
  )
  const databasePath = path.join(tempDir, 'terminal-persistence.sqlite')

  try {
    const store = new TerminalPersistenceStore(databasePath, {
      visibleHistoryMaxUtf8Bytes: 64,
      visibleHistoryMaxSegments: 8,
    })
    const visible = 'alpha🙂\nβeta\n'
    store.appendVisibleStream('terminal-a', 0, visible, 1)
    store.saveActivity(activity('terminal-a', 'succeeded'))
    store.saveAgentCommand(
      command('terminal-a', 'finished', 'finished', 'persisted output\n'),
    )
    store.flush()

    assertEqual(
      store.readVisibleRange('terminal-a', 0, visible.length),
      visible,
      'visible range should preserve unicode and UTF-16 offsets',
    )
    store.close()

    const restoredStore = new TerminalPersistenceStore(databasePath, {
      visibleHistoryMaxUtf8Bytes: 64,
      visibleHistoryMaxSegments: 8,
    })
    const restored = restoredStore.restoreTerminal('terminal-a', 100)
    assertEqual(
      restored.visible.data,
      visible,
      'a new store instance should restore the durable visible tail',
    )
    assertEqual(
      restored.visible.endOffset,
      visible.length,
      'visible end offset should use JavaScript string length',
    )
    assertEqual(
      restored.activities[0]?.runtimeGeneration,
      7,
      'durable Activity metadata should retain diagnostic runtime generation',
    )
    assertEqual(
      restoredStore.getAgentCommand('terminal-a', 'terminal-a-command')?.output,
      'persisted output\n',
      'Agent capture should be restored by the existing task id',
    )

    const unknownRetentionPath = path.join(tempDir, 'unknown-retention.sqlite')
    const unknownRetentionStore = new TerminalPersistenceStore(unknownRetentionPath, {
      agentCaptureRetentionBudgetBytes: 5,
      agentCaptureRetentionMaxRecords: 1,
      agentTombstoneMaxRecords: 10,
    })
    const unknownRecord = command(
      'terminal-unknown-retention',
      'finished',
      'outcome_unknown',
      '123456',
    )
    unknownRecord.capture = capture('unknown', unknownRecord.output)
    unknownRetentionStore.saveAgentCommand(unknownRecord)
    unknownRetentionStore.flush()
    const expiredUnknown = unknownRetentionStore.getAgentCommand(
      unknownRecord.terminalId,
      unknownRecord.commandId,
    )
    assertEqual(
      expiredUnknown?.output,
      '',
      'unknown captures with retained bytes must still be evicted by the byte budget',
    )
    assertEqual(
      expiredUnknown?.capture.reason,
      'record_expired',
      'unknown capture eviction must remain an explicit tombstone',
    )
    unknownRetentionStore.close()

    const zeroTailDatabasePath = path.join(tempDir, 'zero-tail.sqlite')
    const zeroTailStore = new TerminalPersistenceStore(zeroTailDatabasePath)
    zeroTailStore.appendVisibleStream('terminal-zero-tail', 0, 'corrupt me', 1)
    zeroTailStore.flush()
    zeroTailStore.close()
    const zeroTailDatabase = openBetterSqlite3Database(zeroTailDatabasePath)
    zeroTailDatabase
      .prepare(
        'UPDATE terminal_visible_segments SET end_offset = end_offset + 1 WHERE terminal_id = ?',
      )
      .run('terminal-zero-tail')
    zeroTailDatabase.close()
    const corruptedZeroTailStore = new TerminalPersistenceStore(zeroTailDatabasePath)
    let zeroTailDetected = false
    try {
      corruptedZeroTailStore.restoreTerminal('terminal-zero-tail', 0)
    } catch {
      zeroTailDetected = true
    }
    assertCondition(
      zeroTailDetected,
      'a zero-character restore should still validate corrupted visible segments',
    )
    corruptedZeroTailStore.close()

    const runningActivity = activity('terminal-b', 'running')
    const runningCommand = command(
      'terminal-b',
      'running',
      'running',
      'partial output',
    )
    restoredStore.appendVisibleStream('terminal-b', 0, 'before restart', 2)
    restoredStore.saveActivity(runningActivity)
    restoredStore.saveAgentCommand(runningCommand)
    restoredStore.flush()
    restoredStore.close()

    const restartedStore = new TerminalPersistenceStore(databasePath)
    const interrupted = restartedStore.restoreTerminal('terminal-b', 200)
    assertEqual(
      interrupted.activities[0]?.status,
      'outcome-unknown',
      'running Activity should become outcome-unknown after runtime recreation',
    )
    const interruptedCommand = restartedStore.getAgentCommand(
      'terminal-b',
      'terminal-b-command',
    )
    assertEqual(
      interruptedCommand?.executionState,
      'outcome_unknown',
      'running Agent command should become outcome_unknown after restart',
    )
    assertEqual(
      interruptedCommand?.capture.reason,
      'runtime_boundary',
      'interrupted capture should explain its runtime boundary',
    )

    restartedStore.appendVisibleStream('terminal-c', 0, 'old output', 3)
    restartedStore.saveActivity(activity('terminal-c', 'succeeded'))
    restartedStore.saveAgentCommand(
      command('terminal-c', 'finished', 'finished', 'keep this capture'),
    )
    restartedStore.flush()
    restartedStore.deleteTerminalVisibleHistory('terminal-c')
    const afterVisualDelete = restartedStore.restoreTerminal('terminal-c', 300)
    assertEqual(
      afterVisualDelete.visible.data,
      '',
      'closing a terminal should delete durable visual history',
    )
    assertEqual(
      afterVisualDelete.activities.length,
      0,
      'closing a terminal should delete durable Activity metadata',
    )
    assertEqual(
      restartedStore.getAgentCommand('terminal-c', 'terminal-c-command')?.output,
      'keep this capture',
      'closing a terminal should retain Agent command capture history',
    )

    restartedStore.close()

    const activityRetentionDatabasePath = path.join(
      tempDir,
      'activity-retention.sqlite',
    )
    const activityRetentionStore = new TerminalPersistenceStore(
      activityRetentionDatabasePath,
      { activityRetentionMaxRecords: 2 },
    )
    for (let index = 0; index < 5; index += 1) {
      activityRetentionStore.saveActivity({
        ...activity('terminal-activity-retention', 'succeeded'),
        id: `activity-${index}`,
        startedAt: index,
        updatedAt: index,
      })
    }
    activityRetentionStore.flush()
    assertEqual(
      activityRetentionStore.readActivities('terminal-activity-retention').length,
      2,
      'durable Activity retention should match the in-memory projection bound',
    )
    activityRetentionStore.close()

    const zeroOutputDatabasePath = path.join(tempDir, 'zero-output.sqlite')
    const zeroOutputStore = new TerminalPersistenceStore(
      zeroOutputDatabasePath,
      { agentTombstoneMaxRecords: 3 },
    )
    for (let index = 0; index < 5; index += 1) {
      zeroOutputStore.saveAgentCommand({
        ...command('terminal-zero-output', 'finished', 'finished', ''),
        commandId: `zero-output-${index}`,
      })
    }
    zeroOutputStore.flush()
    assertEqual(
      zeroOutputStore.listAgentCommands('terminal-zero-output').length,
      3,
      'zero-output Agent commands should count toward durable tombstone retention',
    )
    zeroOutputStore.close()

    const retainedStore = new TerminalPersistenceStore(databasePath, {
      visibleHistoryMaxUtf8Bytes: 5,
      visibleHistoryMaxSegments: 2,
    })
    retainedStore.appendVisibleStream('terminal-retention', 0, 'abc', 1)
    retainedStore.appendVisibleStream('terminal-retention', 3, 'def', 1)
    retainedStore.appendVisibleStream('terminal-retention', 6, 'ghi', 1)
    retainedStore.flush()
    const retained = retainedStore.restoreTerminal('terminal-retention', 400)
    assertEqual(
      retained.visible.endOffset,
      9,
      'retention must preserve the absolute stream end offset',
    )
    assertCondition(
      retained.visible.data.length < 9,
      'retention should remove old visible segments instead of growing forever',
    )
    assertCondition(
      retained.visible.startOffset > 0,
      'retention should expose the first durable offset after pruning',
    )
    retainedStore.close()

    const clearDatabasePath = path.join(tempDir, 'clear-all.sqlite')
    const clearStore = new TerminalPersistenceStore(clearDatabasePath)
    clearStore.appendVisibleStream('terminal-clear-all', 0, 'visual history', 1)
    clearStore.saveActivity(activity('terminal-clear-all', 'succeeded'))
    clearStore.recordSessionBoundary({
      id: 'boundary-1',
      terminalId: 'terminal-clear-all',
      resumedAt: Date.now(),
      offset: 14,
      lastCommand: 'ls -la',
      exitCode: 0,
    })
    clearStore.saveAgentCommand(
      command('terminal-clear-all', 'finished', 'finished', 'command history'),
    )
    clearStore.flush()
    assertEqual(
      clearStore.listSessionBoundaries('terminal-clear-all').length,
      1,
      'listSessionBoundaries should return recorded boundary before clear',
    )
    clearStore.clearAll()
    assertEqual(
      clearStore.listSessionBoundaries('terminal-clear-all').length,
      0,
      'clearAll should delete session boundaries',
    )
    const clearedTerminal = clearStore.restoreTerminal('terminal-clear-all', 500)
    assertEqual(
      clearedTerminal.visible.data,
      '',
      'clearAll should delete durable visible history for every terminal',
    )
    assertEqual(
      clearedTerminal.activities.length,
      0,
      'clearAll should delete durable Activity rows',
    )
    assertEqual(
      clearStore.listAgentCommands('terminal-clear-all').length,
      0,
      'clearAll should delete durable Agent command rows',
    )
    clearStore.close()

    // Discontinuity regression: a rewound/gapped stream must never wedge
    // persistence for this or any other terminal.
    const wedgeStore = new TerminalPersistenceStore(
      path.join(tempDir, 'wedge.sqlite'),
    )
    wedgeStore.appendVisibleStream('wedge-a', 0, 'x'.repeat(100))
    wedgeStore.saveActivity(activity('wedge-a', 'succeeded'))
    wedgeStore.recordSessionBoundary({
      id: 'wedge-boundary',
      terminalId: 'wedge-a',
      resumedAt: 1,
      offset: 100,
    })
    // Idempotent retry of stored bytes is skipped.
    wedgeStore.appendVisibleStream('wedge-a', 50, 'x'.repeat(50))
    wedgeStore.flush()
    // Idempotent retry with a new tail appends just the tail.
    wedgeStore.appendVisibleStream('wedge-a', 90, 'x'.repeat(10) + 'TAIL')
    wedgeStore.flush()
    assertEqual(
      wedgeStore.restoreTerminal('wedge-a', 600).visible.data,
      'x'.repeat(100) + 'TAIL',
      'idempotent overlap should append only the new tail',
    )
    // Rewind: in-memory buffer restarted at offset 0 with different bytes.
    wedgeStore.appendVisibleStream('wedge-a', 0, 'short')
    wedgeStore.appendVisibleStream('wedge-a', 5, '-then-more')
    wedgeStore.saveActivity({
      ...activity('wedge-a', 'running'),
      id: 'wedge-a-pending-old-stream',
    })
    wedgeStore.appendVisibleStream('wedge-b', 0, 'unrelated')
    wedgeStore.flush()
    const rewound = wedgeStore.restoreTerminal('wedge-a', 600)
    assertEqual(
      rewound.visible.data,
      'short-then-more',
      'a rewound stream should rebase durable history onto the live stream',
    )
    assertEqual(rewound.visible.endOffset, 15, 'rewound end offset')
    assertEqual(
      wedgeStore.listSessionBoundaries('wedge-a').length,
      0,
      'a rewind should drop boundaries addressing abandoned offsets',
    )
    assertEqual(
      rewound.activities.length,
      0,
      'a rewind should drop activities addressing abandoned offsets',
    )
    assertEqual(
      wedgeStore.restoreTerminal('wedge-b', 600).visible.data,
      'unrelated',
      'another terminal in the same batch must persist',
    )
    // Gap: an earlier batch was lost; history and offset-based metadata
    // restart at the new offset.
    wedgeStore.saveActivity(activity('wedge-b', 'succeeded'))
    wedgeStore.recordSessionBoundary({
      id: 'wedge-b-boundary',
      terminalId: 'wedge-b',
      resumedAt: 2,
      offset: 9,
    })
    wedgeStore.saveActivity({
      ...activity('wedge-b', 'running'),
      id: 'wedge-b-pending-old-stream',
    })
    wedgeStore.appendVisibleStream('wedge-b', 40, 'after-gap')
    wedgeStore.flush()
    const gapped = wedgeStore.restoreTerminal('wedge-b', 600)
    assertEqual(gapped.visible.data, 'after-gap', 'gap rebases visible history')
    assertEqual(gapped.visible.endOffset, 49, 'gap keeps the live offsets')
    assertEqual(
      wedgeStore.listSessionBoundaries('wedge-b').length,
      0,
      'a gap should drop boundaries addressing abandoned offsets',
    )
    assertEqual(
      gapped.activities.length,
      0,
      'a gap should drop activities addressing abandoned offsets',
    )
    wedgeStore.appendVisibleStream('wedge-b', 49, '!')
    wedgeStore.flush()
    assertEqual(
      wedgeStore.restoreTerminal('wedge-b', 600).visible.data,
      'after-gap!',
      'appends continue after a gap rebase',
    )
    wedgeStore.deleteTerminalVisibleHistory('wedge-a')
    assertEqual(
      wedgeStore.restoreTerminal('wedge-a', 600).visible.data,
      '',
      'deleteTerminalVisibleHistory should clear durable history',
    )
    wedgeStore.close()

    console.log('All terminal persistence store extreme tests passed.')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run()
