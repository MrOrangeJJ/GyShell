import { waitSchema, waitTerminalIdle } from './wait_tools'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

async function run(): Promise<void> {
  // Schema description reflects the new 5-120 range
  {
    const shape = waitSchema.shape.seconds
    const description = (shape as { description?: string }).description ?? ''
    assertEqual(description, 'Number of seconds to wait (5-120)', 'schema description should reflect 5-120 range')
  }

  // Below minimum (4) is rejected
  {
    const result = waitSchema.safeParse({ seconds: 4 })
    assertEqual(result.success, false, 'seconds=4 should be rejected (below min 5)')
  }

  // Minimum boundary (5) is accepted
  {
    const result = waitSchema.safeParse({ seconds: 5 })
    assertEqual(result.success, true, 'seconds=5 should be accepted (min boundary)')
    if (result.success) {
      assertEqual(result.data.seconds, 5, 'seconds=5 should parse to 5')
    }
  }

  // Middle value (60) is accepted under new range
  {
    const result = waitSchema.safeParse({ seconds: 60 })
    assertEqual(result.success, true, 'seconds=60 should be accepted (well within 5-120)')
    if (result.success) {
      assertEqual(result.data.seconds, 60, 'seconds=60 should parse to 60')
    }
  }

  // Middle value (90) is accepted
  {
    const result = waitSchema.safeParse({ seconds: 90 })
    assertEqual(result.success, true, 'seconds=90 should be accepted')
    if (result.success) {
      assertEqual(result.data.seconds, 90, 'seconds=90 should parse to 90')
    }
  }

  // Maximum boundary (120) is accepted
  {
    const result = waitSchema.safeParse({ seconds: 120 })
    assertEqual(result.success, true, 'seconds=120 should be accepted (max boundary)')
    if (result.success) {
      assertEqual(result.data.seconds, 120, 'seconds=120 should parse to 120')
    }
  }

  // Above maximum (121) is rejected
  {
    const result = waitSchema.safeParse({ seconds: 121 })
    assertEqual(result.success, false, 'seconds=121 should be rejected (above max 120)')
  }

  // Far above maximum is rejected
  {
    const result = waitSchema.safeParse({ seconds: 9999 })
    assertEqual(result.success, false, 'seconds=9999 should be rejected (far above max 120)')
  }

  // Non-number is rejected
  {
    const result = waitSchema.safeParse({ seconds: 'sixty' })
    assertEqual(result.success, false, 'non-number seconds should be rejected')
  }

  // Missing seconds is rejected
  {
    const result = waitSchema.safeParse({})
    assertEqual(result.success, false, 'missing seconds field should be rejected')
  }

  const terminal = {
    id: 'win-busy',
    title: 'Windows Busy',
    type: 'ssh',
  }
  const createContext = (options: {
    snapshots: Array<Record<string, unknown> | null>
    output?: string
    waitForQueuedInsertion?: () => Promise<boolean>
    markQueuedInsertion?: () => void
  }) => {
    const events: Array<Record<string, unknown>> = []
    let snapshotIndex = 0
    const terminalService = {
      resolveTerminal: () => ({ found: [terminal], bestMatch: terminal }),
      getTerminalRuntimeSnapshot: () => {
        const index = Math.min(snapshotIndex, options.snapshots.length - 1)
        snapshotIndex += 1
        return options.snapshots[index]
      },
      getRecentOutput: () => options.output || '',
    }
    return {
      events,
      context: {
        sessionId: 'wait-session',
        messageId: 'wait-message',
        terminalService,
        sendEvent: (_sessionId: string, event: Record<string, unknown>) => {
          events.push(event)
        },
        waitForQueuedInsertion: options.waitForQueuedInsertion,
        markWaitInterruptedByQueuedInsertion: options.markQueuedInsertion,
      } as any,
    }
  }
  const readySnapshot = {
    ...terminal,
    runtimeState: 'ready',
    isInitializing: false,
    reconnectable: false,
    canRunCommand: true,
    canWrite: true,
    canUseFilesystem: true,
    shellInputState: 'idle',
  }
  const busySnapshot = {
    ...readySnapshot,
    canRunCommand: false,
    shellInputState: 'busy',
  }

  {
    const { context, events } = createContext({
      snapshots: [readySnapshot, readySnapshot],
      output: 'PS C:\\Users\\Tester>',
    })
    const result = await waitTerminalIdle({ tabIdOrName: terminal.id }, context)
    assertEqual(result.includes('verified idle prompt'), true, 'verified prompt state should finish immediately')
    assertEqual(events.at(-1)?.type, 'sub_tool_finished', 'successful monitoring must finish its tool event')
  }

  {
    const { context } = createContext({
      snapshots: [busySnapshot],
      output: 'long-running command has no new output',
    })
    const result = await waitTerminalIdle({ tabIdOrName: terminal.id }, context)
    assertEqual(result.includes('shell is still busy'), true, 'stable output must not be described as command completion')
    assertEqual(result.includes('do not start another command'), true, 'busy stability must give the agent an explicit interaction constraint')
  }

  {
    let marked = false
    const { context } = createContext({
      snapshots: [busySnapshot],
      waitForQueuedInsertion: async () => true,
      markQueuedInsertion: () => {
        marked = true
      },
    })
    const result = await waitTerminalIdle({ tabIdOrName: terminal.id }, context)
    assertEqual(result.includes('queued agent notification'), true, 'queued work should interrupt terminal monitoring promptly')
    assertEqual(marked, true, 'queued interruption must be recorded in the agent context')
  }

  {
    const exitedSnapshot = {
      ...busySnapshot,
      runtimeState: 'exited',
      reconnectable: true,
      canWrite: false,
      canUseFilesystem: false,
    }
    const { context } = createContext({
      snapshots: [busySnapshot, busySnapshot, exitedSnapshot],
    })
    const result = await waitTerminalIdle({ tabIdOrName: terminal.id }, context)
    assertEqual(result.includes('disconnected'), true, 'runtime exit during monitoring must be rechecked and reported')
  }

  console.log('PASS wait_tools.extreme.spec: all schema and runtime cases passed')
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
