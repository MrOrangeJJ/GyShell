import { FileTransferService } from './FileTransferService'
import type {
  FileSystemService,
  TransferEntriesProgress,
} from './FileSystemService'
import type { TerminalService } from './TerminalService'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertRejects = async (
  fn: () => Promise<unknown> | unknown,
  pattern: RegExp,
  message: string,
): Promise<void> => {
  try {
    await fn()
    throw new Error(`${message}: expected rejection`)
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error)
    if (!pattern.test(actualMessage)) {
      throw new Error(`${message}: unexpected error message "${actualMessage}"`)
    }
  }
}

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const waitFor = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

type TestTerminalService = TerminalService & {
  emitTerminalClosed: (terminalId: string) => void
}

const createTerminalService = (
  identities: Record<string, string | null>,
): TestTerminalService => {
  const terminalClosedListeners = new Set<(terminalId: string) => void>()
  return {
    getAllTerminals: () => [
      { id: 'local-a', title: 'Local A' },
      { id: 'local-b', title: 'Local B' },
      { id: 'remote-a', title: 'Remote A' },
      { id: 'remote-b', title: 'Remote B' },
    ],
    getTransferMachineIdentity: (terminalId: string) =>
      identities[terminalId] ?? null,
    onTerminalClosed: (listener: (terminalId: string) => void) => {
      terminalClosedListeners.add(listener)
      return () => {
        terminalClosedListeners.delete(listener)
      }
    },
    emitTerminalClosed: (terminalId: string) => {
      for (const listener of terminalClosedListeners) {
        listener(terminalId)
      }
    },
  } as unknown as TestTerminalService
}

const createFileSystemService = (options?: {
  delayMs?: number
  onStarted?: () => void
  onTransferOptions?: (options: { allowPeerDirect?: boolean }) => void
}): FileSystemService =>
  ({
    transferEntries: async (
      _sourceTerminalId: string,
      _sourcePaths: string[],
      _targetTerminalId: string,
      _targetDirPath: string,
      transferOptions?: {
        transferId?: string
        allowPeerDirect?: boolean
        signal?: AbortSignal
        onProgress?: (progress: TransferEntriesProgress) => void
      },
    ) => {
      options?.onStarted?.()
      options?.onTransferOptions?.(transferOptions || {})
      transferOptions?.onProgress?.({
        transferId: transferOptions.transferId,
        mode: 'copy',
        bytesTransferred: 0,
        totalBytes: 10,
        transferredFiles: 0,
        totalFiles: 1,
        eof: false,
      })
      if (options?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      if (transferOptions?.signal?.aborted) {
        const error = new Error('Transfer cancelled by user.') as Error & {
          code: string
        }
        error.code = 'GYSHELL_FS_TRANSFER_CANCELLED'
        throw error
      }
      transferOptions?.onProgress?.({
        transferId: transferOptions.transferId,
        mode: 'copy',
        bytesTransferred: 10,
        totalBytes: 10,
        transferredFiles: 1,
        totalFiles: 1,
        eof: true,
      })
      return {
        mode: 'copy',
        totalBytes: 10,
        transferredFiles: 1,
        totalFiles: 1,
      }
    },
  }) as unknown as FileSystemService

const createHangingFileSystemService = (options?: {
  completeWhenSourceIncludes?: string
}): FileSystemService =>
  ({
    transferEntries: async (
      _sourceTerminalId: string,
      sourcePaths: string[],
      _targetTerminalId: string,
      _targetDirPath: string,
      transferOptions?: {
        transferId?: string
        onProgress?: (progress: TransferEntriesProgress) => void
      },
    ) => {
      transferOptions?.onProgress?.({
        transferId: transferOptions.transferId,
        mode: 'copy',
        bytesTransferred: 5,
        totalBytes: 10,
        transferredFiles: 0,
        totalFiles: 1,
        eof: false,
      })
      if (
        options?.completeWhenSourceIncludes &&
        sourcePaths.some((sourcePath) =>
          sourcePath.includes(options.completeWhenSourceIncludes || ''),
        )
      ) {
        transferOptions?.onProgress?.({
          transferId: transferOptions.transferId,
          mode: 'copy',
          bytesTransferred: 10,
          totalBytes: 10,
          transferredFiles: 1,
          totalFiles: 1,
          eof: true,
        })
        return {
          mode: 'copy',
          totalBytes: 10,
          transferredFiles: 1,
          totalFiles: 1,
        }
      }
      await new Promise(() => undefined)
      throw new Error('unreachable')
    },
  }) as unknown as FileSystemService

const run = async (): Promise<void> => {
  await runCase(
    'trusted UI capability and user origin are both required for peer delegation',
    async () => {
      const observed: boolean[] = []
      const service = new FileTransferService(
        createFileSystemService({
          onTransferOptions: (options) =>
            observed.push(options.allowPeerDirect === true),
        }),
        createTerminalService({
          'remote-a': 'ssh://remote-a:22',
          'remote-b': 'ssh://remote-b:22',
        }),
      )

      const userTask = service.startTransfer(
        {
          origin: 'user',
          sourceTerminalId: 'remote-a',
          sourcePaths: ['/tmp/user.bin'],
          targetTerminalId: 'remote-b',
          targetDirPath: '/tmp',
        },
        { allowPeerDirect: true },
      )
      const agentTask = service.startTransfer(
        {
          origin: 'agent',
          sourceTerminalId: 'remote-a',
          sourcePaths: ['/tmp/agent.bin'],
          targetTerminalId: 'remote-b',
          targetDirPath: '/tmp',
        },
        { allowPeerDirect: true },
      )
      const untrustedUserTask = service.startTransfer({
        origin: 'user',
        sourceTerminalId: 'remote-a',
        sourcePaths: ['/tmp/untrusted-user.bin'],
        targetTerminalId: 'remote-b',
        targetDirPath: '/tmp',
      })
      await waitFor(
        () =>
          service.getTransfer(userTask.id)?.status === 'success' &&
          service.getTransfer(agentTask.id)?.status === 'success' &&
          service.getTransfer(untrustedUserTask.id)?.status === 'success',
        'all trust-boundary tasks should complete',
      )

      assertEqual(observed.length, 3, 'all tasks should reach filesystem service')
      assertEqual(observed[0], true, 'trusted user task should authorize peer route')
      assertEqual(observed[1], false, 'agent origin should remain on relay')
      assertEqual(observed[2], false, 'untrusted user label should remain on relay')
    },
  )

  await runCase(
    'startTransfer rejects same machine when required',
    async () => {
      const service = new FileTransferService(
        createFileSystemService(),
        createTerminalService({
          'local-a': 'local://default',
          'local-b': 'local://default',
        }),
      )

      await assertRejects(
        () =>
          service.startTransfer({
            origin: 'agent',
            mode: 'copy',
            sourceTerminalId: 'local-a',
            sourcePaths: ['/tmp/a.txt'],
            targetTerminalId: 'local-b',
            targetDirPath: '/tmp',
            requireDistinctMachine: true,
          }),
        /different machines/,
        'same machine transfer should be rejected',
      )
    },
  )

  await runCase(
    'startTransfer returns immediately and completes asynchronously',
    async () => {
      let started = false
      const updates: string[] = []
      const service = new FileTransferService(
        createFileSystemService({
          delayMs: 30,
          onStarted: () => {
            started = true
          },
        }),
        createTerminalService({
          'local-a': 'local://default',
          'remote-a': 'ssh://remote-a:22',
        }),
      )
      service.on('updated', (task: any) => updates.push(task.status))

      const task = service.startTransfer({
        origin: 'agent',
        mode: 'copy',
        sourceTerminalId: 'local-a',
        sourcePaths: ['/tmp/a.txt'],
        targetTerminalId: 'remote-a',
        targetDirPath: '/tmp',
        requireDistinctMachine: true,
      })

      assertEqual(task.status, 'queued', 'new transfer should start queued')
      assertEqual(
        started,
        false,
        'transfer should not run before startTransfer returns',
      )

      await waitFor(
        () => service.getTransfer(task.id)?.status === 'success',
        'transfer should complete',
      )
      const completed = service.getTransfer(task.id)
      assertEqual(
        completed?.transferredFiles,
        1,
        'completed transfer should report files',
      )
      assertCondition(
        updates.includes('scanning'),
        'transfer should publish scanning state',
      )
      assertCondition(
        updates.includes('running'),
        'transfer should publish running state',
      )
      assertCondition(
        updates.includes('success'),
        'transfer should publish success state',
      )
    },
  )

  await runCase(
    'running progress stays below 100 percent until eof',
    async () => {
      let releaseTransfer: () => void = () => undefined
      const releaseGate = new Promise<void>((resolve) => {
        releaseTransfer = resolve
      })
      const fileSystemService = {
        transferEntries: async (
          _sourceTerminalId: string,
          _sourcePaths: string[],
          _targetTerminalId: string,
          _targetDirPath: string,
          options?: {
            transferId?: string
            onProgress?: (progress: TransferEntriesProgress) => void
          },
        ) => {
          options?.onProgress?.({
            transferId: options.transferId,
            mode: 'copy',
            bytesTransferred: 10,
            totalBytes: 10,
            transferredFiles: 0,
            totalFiles: 1,
            eof: false,
          })
          await releaseGate
          options?.onProgress?.({
            transferId: options.transferId,
            mode: 'copy',
            bytesTransferred: 10,
            totalBytes: 10,
            transferredFiles: 1,
            totalFiles: 1,
            eof: true,
          })
          return {
            mode: 'copy',
            totalBytes: 10,
            transferredFiles: 1,
            totalFiles: 1,
          }
        },
      } as unknown as FileSystemService
      const service = new FileTransferService(
        fileSystemService,
        createTerminalService({
          'local-a': 'local://default',
          'remote-a': 'ssh://remote-a:22',
        }),
      )

      const task = service.startTransfer({
        origin: 'user',
        mode: 'copy',
        sourceTerminalId: 'local-a',
        sourcePaths: ['/tmp/a.txt'],
        targetTerminalId: 'remote-a',
        targetDirPath: '/tmp',
      })
      await waitFor(
        () => service.getTransfer(task.id)?.bytesDone === 10,
        'transfer should report all staged bytes before eof',
      )
      const pending = service.getTransfer(task.id)
      assertEqual(pending?.status, 'running', 'transfer should still be running')
      assertEqual(pending?.percent, 99, 'non-eof progress must stay below 100')
      assertEqual(
        pending?.message,
        'Transferring files (99%).',
        'progress message should use the capped running percentage',
      )

      releaseTransfer()
      await waitFor(
        () => service.getTransfer(task.id)?.status === 'success',
        'transfer should complete after eof',
      )
      assertEqual(
        service.getTransfer(task.id)?.percent,
        100,
        'completed transfer should report 100 percent',
      )
    },
  )

  await runCase(
    'queued transfers can be cancelled before they run',
    async () => {
      const service = new FileTransferService(
        createFileSystemService({ delayMs: 100 }),
        createTerminalService({
          'local-a': 'local://default',
          'remote-a': 'ssh://remote-a:22',
          'remote-b': 'ssh://remote-b:22',
        }),
        1,
      )

      const first = service.startTransfer({
        origin: 'user',
        mode: 'copy',
        sourceTerminalId: 'local-a',
        sourcePaths: ['/tmp/a.txt'],
        targetTerminalId: 'remote-a',
        targetDirPath: '/tmp',
      })
      const second = service.startTransfer({
        origin: 'user',
        mode: 'copy',
        sourceTerminalId: 'local-a',
        sourcePaths: ['/tmp/b.txt'],
        targetTerminalId: 'remote-b',
        targetDirPath: '/tmp',
      })

      const cancelled = service.cancelTransfer(second.id)
      assertCondition(!!cancelled, 'queued transfer should cancel')
      assertEqual(
        cancelled?.status,
        'cancelled',
        'queued transfer should become cancelled',
      )
      assertEqual(
        first.status,
        'queued',
        'first transfer should have been accepted',
      )
    },
  )

  await runCase(
    'running transfers settle cancelled when manually cancelled',
    async () => {
      const settledStatuses: string[] = []
      const service = new FileTransferService(
        createFileSystemService({ delayMs: 50 }),
        createTerminalService({
          'local-a': 'local://default',
          'remote-a': 'ssh://remote-a:22',
        }),
      )

      const task = service.startTransfer({
        origin: 'user',
        mode: 'copy',
        sourceTerminalId: 'local-a',
        sourcePaths: ['/tmp/a.txt'],
        targetTerminalId: 'remote-a',
        targetDirPath: '/tmp',
        onSettled: (settledTask) => settledStatuses.push(settledTask.status),
      })
      await waitFor(
        () => service.getTransfer(task.id)?.status === 'running',
        'transfer should enter running state before cancellation',
      )

      const cancelling = service.cancelTransfer(task.id)
      assertCondition(!!cancelling, 'running transfer should accept cancellation')
      assertEqual(
        cancelling?.cancelRequested,
        true,
        'running transfer should record the cancel request',
      )
      await waitFor(
        () => service.getTransfer(task.id)?.status === 'cancelled',
        'running transfer should settle cancelled',
      )
      assertEqual(
        settledStatuses[0],
        'cancelled',
        'cancelled transfer should notify onSettled',
      )
    },
  )

  await runCase(
    'running transfer errors immediately when the source terminal tab closes',
    async () => {
      const terminalService = createTerminalService({
        'local-a': 'local://default',
        'local-b': 'local://other',
        'remote-a': 'ssh://remote-a:22',
        'remote-b': 'ssh://remote-b:22',
      })
      const settledStatuses: string[] = []
      const service = new FileTransferService(
        createHangingFileSystemService({ completeWhenSourceIncludes: 'next' }),
        terminalService,
        1,
      )

      const hanging = service.startTransfer({
        origin: 'agent',
        mode: 'copy',
        sourceTerminalId: 'local-a',
        sourcePaths: ['/tmp/hang.txt'],
        targetTerminalId: 'remote-a',
        targetDirPath: '/tmp',
        onSettled: (settledTask) => settledStatuses.push(settledTask.status),
      })
      const next = service.startTransfer({
        origin: 'agent',
        mode: 'copy',
        sourceTerminalId: 'local-b',
        sourcePaths: ['/tmp/next.txt'],
        targetTerminalId: 'remote-b',
        targetDirPath: '/tmp',
      })

      await waitFor(
        () => service.getTransfer(hanging.id)?.status === 'running',
        'first transfer should enter running state before tab close',
      )
      terminalService.emitTerminalClosed('local-a')

      await waitFor(
        () => service.getTransfer(hanging.id)?.status === 'error',
        'source tab close should mark transfer error immediately',
      )
      const failed = service.getTransfer(hanging.id)
      assertCondition(
        failed?.errorMessage?.includes('source terminal tab was closed') === true,
        `source close should explain the failure, got ${failed?.errorMessage}`,
      )
      assertEqual(
        settledStatuses[0],
        'error',
        'source close should notify onSettled as error',
      )
      await waitFor(
        () => service.getTransfer(next.id)?.status === 'success',
        'source close should release the queue slot for the next transfer',
      )
    },
  )

  await runCase(
    'running transfer errors immediately when the target terminal tab closes',
    async () => {
      const terminalService = createTerminalService({
        'local-a': 'local://default',
        'remote-a': 'ssh://remote-a:22',
      })
      const settledStatuses: string[] = []
      const service = new FileTransferService(
        createHangingFileSystemService(),
        terminalService,
      )

      const task = service.startTransfer({
        origin: 'agent',
        mode: 'copy',
        sourceTerminalId: 'local-a',
        sourcePaths: ['/tmp/hang.txt'],
        targetTerminalId: 'remote-a',
        targetDirPath: '/tmp',
        onSettled: (settledTask) => settledStatuses.push(settledTask.status),
      })

      await waitFor(
        () => service.getTransfer(task.id)?.status === 'running',
        'transfer should enter running state before target tab close',
      )
      terminalService.emitTerminalClosed('remote-a')

      await waitFor(
        () => service.getTransfer(task.id)?.status === 'error',
        'target tab close should mark transfer error immediately',
      )
      const failed = service.getTransfer(task.id)
      assertCondition(
        failed?.errorMessage?.includes('target terminal tab was closed') === true,
        `target close should explain the failure, got ${failed?.errorMessage}`,
      )
      assertEqual(
        settledStatuses[0],
        'error',
        'target close should notify onSettled as error',
      )
    },
  )
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
