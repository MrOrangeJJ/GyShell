import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  FileSystemService,
  FileTransferConflictStrategy,
  FileTransferMode,
  TransferEntriesResult,
} from './FileSystemService'
import { isFileSystemTransferCancelledError } from './FileSystemService'
import type { TerminalService } from './TerminalService'

const DEFAULT_TRANSFER_CONCURRENCY = 2
const COMPLETED_TRANSFER_RETENTION_MS = 15 * 60 * 1000

export type FileTransferTaskOrigin = 'user' | 'agent'
export type FileTransferTaskStatus =
  | 'queued'
  | 'scanning'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled'

export interface FileTransferTaskSnapshot {
  id: string
  origin: FileTransferTaskOrigin
  mode: FileTransferMode
  sourceTerminalId: string
  sourceTerminalName: string
  sourceMachineIdentity: string | null
  sourcePaths: string[]
  targetTerminalId: string
  targetTerminalName: string
  targetMachineIdentity: string | null
  targetDirPath: string
  itemNames: string[]
  conflictStrategy: FileTransferConflictStrategy
  status: FileTransferTaskStatus
  bytesDone: number
  totalBytes: number
  transferredFiles: number
  totalFiles: number
  percent: number
  message: string | null
  errorMessage: string | null
  cancelRequested: boolean
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  sessionId?: string
  agentRunId?: string
  toolMessageId?: string
}

export interface StartFileTransferInput {
  origin: FileTransferTaskOrigin
  mode?: FileTransferMode
  sourceTerminalId: string
  sourcePaths: string[]
  targetTerminalId: string
  targetDirPath: string
  transferId?: string
  conflictStrategy?: FileTransferConflictStrategy
  overwrite?: boolean
  chunkSize?: number
  requireDistinctMachine?: boolean
  sessionId?: string
  agentRunId?: string
  toolMessageId?: string
  onSettled?: (task: FileTransferTaskSnapshot) => void
}

export interface ListFileTransfersOptions {
  includeCompleted?: boolean
  origin?: FileTransferTaskOrigin
  terminalId?: string
  sessionId?: string
  agentRunId?: string
}

interface FileTransferTaskInternal {
  snapshot: FileTransferTaskSnapshot
  controller: AbortController
  allowPeerDirect: boolean
  chunkSize?: number
  onSettled?: (task: FileTransferTaskSnapshot) => void
  cleanupTimer?: ReturnType<typeof setTimeout>
  runSlotAcquired?: boolean
  runSlotReleased?: boolean
  settled?: boolean
}

type RawEventPublisher = (channel: string, data: unknown) => void

const TERMINAL_STATUSES = new Set<FileTransferTaskStatus>([
  'success',
  'error',
  'cancelled',
])

export class FileTransferService extends EventEmitter {
  private readonly tasks = new Map<string, FileTransferTaskInternal>()
  private readonly queue: string[] = []
  private runningCount = 0
  private rawEventPublisher: RawEventPublisher | null = null

  constructor(
    private readonly fileSystemService: FileSystemService,
    private readonly terminalService: TerminalService,
    private readonly concurrencyLimit = DEFAULT_TRANSFER_CONCURRENCY,
  ) {
    super()
    this.terminalService.onTerminalClosed?.((terminalId) => {
      this.handleTerminalClosed(terminalId)
    })
  }

  setRawEventPublisher(publisher: RawEventPublisher): void {
    this.rawEventPublisher = publisher
  }

  startTransfer(
    input: StartFileTransferInput,
    options?: { allowPeerDirect?: boolean },
  ): FileTransferTaskSnapshot {
    const sourcePaths = this.normalizeSourcePaths(input.sourcePaths)
    const targetDirPath = this.normalizeTargetDirPath(input.targetDirPath)
    const mode = input.mode === 'move' ? 'move' : 'copy'
    const conflictStrategy = this.resolveConflictStrategy(
      input.conflictStrategy,
      input.overwrite,
    )
    const sourceTerminal = this.resolveTerminalSummary(input.sourceTerminalId)
    const targetTerminal = this.resolveTerminalSummary(input.targetTerminalId)
    const sourceMachineIdentity =
      this.terminalService.getTransferMachineIdentity(input.sourceTerminalId)
    const targetMachineIdentity =
      this.terminalService.getTransferMachineIdentity(input.targetTerminalId)

    if (!sourceMachineIdentity) {
      throw new Error(
        `Source terminal does not support filesystem transfers: ${input.sourceTerminalId}`,
      )
    }
    if (!targetMachineIdentity) {
      throw new Error(
        `Target terminal does not support filesystem transfers: ${input.targetTerminalId}`,
      )
    }
    if (
      input.requireDistinctMachine === true &&
      sourceMachineIdentity === targetMachineIdentity
    ) {
      throw new Error(
        'File transfer tool requires two terminal tabs on different machines.',
      )
    }

    const id =
      this.normalizeTransferId(input.transferId) || `fs-transfer:${uuidv4()}`
    if (this.tasks.has(id)) {
      throw new Error(`File transfer task already exists: ${id}`)
    }

    const now = Date.now()
    const snapshot: FileTransferTaskSnapshot = {
      id,
      origin: input.origin,
      mode,
      sourceTerminalId: input.sourceTerminalId,
      sourceTerminalName: sourceTerminal.title,
      sourceMachineIdentity,
      sourcePaths,
      targetTerminalId: input.targetTerminalId,
      targetTerminalName: targetTerminal.title,
      targetMachineIdentity,
      targetDirPath,
      itemNames: sourcePaths.map((sourcePath) =>
        this.basenameFromPath(sourcePath),
      ),
      conflictStrategy,
      status: 'queued',
      bytesDone: 0,
      totalBytes: 0,
      transferredFiles: 0,
      totalFiles: 0,
      percent: 0,
      message: 'Transfer queued.',
      errorMessage: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      ...(input.toolMessageId ? { toolMessageId: input.toolMessageId } : {}),
    }

    this.tasks.set(id, {
      snapshot,
      controller: new AbortController(),
      allowPeerDirect:
        options?.allowPeerDirect === true && input.origin === 'user',
      chunkSize: input.chunkSize,
      onSettled: input.onSettled,
    })
    this.queue.push(id)
    this.publishTask(snapshot)
    this.pumpQueue()
    return this.cloneTask(snapshot)
  }

  getTransfer(taskId: string): FileTransferTaskSnapshot | null {
    const task = this.tasks.get(taskId)
    return task ? this.cloneTask(task.snapshot) : null
  }

  listTransfers(
    options?: ListFileTransfersOptions,
  ): FileTransferTaskSnapshot[] {
    return Array.from(this.tasks.values())
      .map((task) => task.snapshot)
      .filter((task) => {
        if (!options?.includeCompleted && TERMINAL_STATUSES.has(task.status)) {
          return false
        }
        if (options?.origin && task.origin !== options.origin) {
          return false
        }
        if (
          options?.terminalId &&
          task.sourceTerminalId !== options.terminalId &&
          task.targetTerminalId !== options.terminalId
        ) {
          return false
        }
        if (options?.sessionId && task.sessionId !== options.sessionId) {
          return false
        }
        if (options?.agentRunId && task.agentRunId !== options.agentRunId) {
          return false
        }
        return true
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((task) => this.cloneTask(task))
  }

  cancelTransfer(taskId: string): FileTransferTaskSnapshot | null {
    const task = this.tasks.get(taskId)
    if (!task || TERMINAL_STATUSES.has(task.snapshot.status)) {
      return null
    }

    if (task.snapshot.status === 'queued') {
      const queueIndex = this.queue.indexOf(taskId)
      if (queueIndex >= 0) {
        this.queue.splice(queueIndex, 1)
      }
      this.updateTask(taskId, {
        status: 'cancelled',
        cancelRequested: true,
        message: 'Transfer cancelled.',
        completedAt: Date.now(),
      })
      this.settleTask(taskId)
      return this.getTransfer(taskId)
    }

    task.controller.abort()
    this.updateTask(taskId, {
      cancelRequested: true,
      message: 'Cancelling transfer.',
    })
    return this.getTransfer(taskId)
  }

  private pumpQueue(): void {
    while (this.runningCount < this.concurrencyLimit && this.queue.length > 0) {
      const taskId = this.queue.shift()
      if (!taskId) break
      const task = this.tasks.get(taskId)
      if (!task || task.snapshot.status !== 'queued') {
        continue
      }

      task.runSlotAcquired = true
      task.runSlotReleased = false
      this.runningCount += 1
      queueMicrotask(() => {
        void this.runTask(taskId)
          .catch((error) => {
            console.warn(
              `[FileTransferService] Unhandled transfer failure (${taskId}):`,
              error,
            )
          })
          .finally(() => {
            this.releaseRunSlot(taskId)
          })
      })
    }
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || TERMINAL_STATUSES.has(task.snapshot.status)) return

    const startedAt = Date.now()
    this.updateTask(taskId, {
      status: 'scanning',
      startedAt,
      message: 'Scanning transfer entries.',
    })

    try {
      const result = await this.fileSystemService.transferEntries(
        task.snapshot.sourceTerminalId,
        task.snapshot.sourcePaths,
        task.snapshot.targetTerminalId,
        task.snapshot.targetDirPath,
        {
          mode: task.snapshot.mode,
          conflictStrategy: task.snapshot.conflictStrategy,
          chunkSize: task.chunkSize,
          transferId: task.snapshot.id,
          allowPeerDirect: task.allowPeerDirect,
          signal: task.controller.signal,
          onProgress: (progress) => {
            if (this.isTaskTerminal(taskId)) return
            const totalBytes = Math.max(0, Number(progress.totalBytes) || 0)
            const bytesDone = Math.max(
              0,
              Number(progress.bytesTransferred) || 0,
            )
            const percent =
              totalBytes > 0
                ? Math.min(
                    progress.eof ? 100 : 99,
                    Math.round((bytesDone / totalBytes) * 100),
                  )
                : progress.eof
                  ? 100
                  : 0
            this.updateTask(taskId, {
              status: 'running',
              bytesDone,
              totalBytes,
              transferredFiles: Math.max(
                0,
                Number(progress.transferredFiles) || 0,
              ),
              totalFiles: Math.max(0, Number(progress.totalFiles) || 0),
              percent,
              message:
                totalBytes > 0
                  ? `Transferring files (${percent}%).`
                  : 'Transferring files.',
            })
          },
        },
      )
      if (this.isTaskTerminal(taskId)) return
      this.markSucceeded(taskId, result)
    } catch (error) {
      if (this.isTaskTerminal(taskId)) return
      if (
        task.controller.signal.aborted ||
        isFileSystemTransferCancelledError(error)
      ) {
        this.updateTask(taskId, {
          status: 'cancelled',
          cancelRequested: true,
          message: 'Transfer cancelled.',
          errorMessage: null,
          completedAt: Date.now(),
        })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.updateTask(taskId, {
          status: 'error',
          message,
          errorMessage: message,
          completedAt: Date.now(),
        })
      }
    } finally {
      const latest = this.tasks.get(taskId)
      if (latest && TERMINAL_STATUSES.has(latest.snapshot.status)) {
        this.settleTask(taskId)
      }
    }
  }

  private markSucceeded(taskId: string, result: TransferEntriesResult): void {
    const task = this.tasks.get(taskId)
    if (!task || TERMINAL_STATUSES.has(task.snapshot.status)) return
    const verb = task?.snapshot.mode === 'move' ? 'Moved' : 'Copied'
    this.updateTask(taskId, {
      status: 'success',
      bytesDone: result.totalBytes,
      totalBytes: result.totalBytes,
      transferredFiles: result.transferredFiles,
      totalFiles: result.totalFiles,
      percent: 100,
      message: `${verb} ${result.transferredFiles} file${result.transferredFiles === 1 ? '' : 's'}.`,
      errorMessage: null,
      completedAt: Date.now(),
    })
  }

  private updateTask(
    taskId: string,
    patch: Partial<FileTransferTaskSnapshot>,
  ): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.snapshot = {
      ...task.snapshot,
      ...patch,
      updatedAt: Date.now(),
    }
    this.publishTask(task.snapshot)
  }

  private publishTask(snapshot: FileTransferTaskSnapshot): void {
    const cloned = this.cloneTask(snapshot)
    this.rawEventPublisher?.('filesystem:transferTaskUpdated', cloned)
    this.emit('updated', cloned)
  }

  private handleTerminalClosed(terminalId: string): void {
    for (const [taskId, task] of Array.from(this.tasks.entries())) {
      if (TERMINAL_STATUSES.has(task.snapshot.status)) {
        continue
      }
      const side =
        task.snapshot.sourceTerminalId === terminalId
          ? 'source'
          : task.snapshot.targetTerminalId === terminalId
            ? 'target'
            : null
      if (!side) {
        continue
      }

      const queueIndex = this.queue.indexOf(taskId)
      if (queueIndex >= 0) {
        this.queue.splice(queueIndex, 1)
      }
      task.controller.abort()
      const terminalName =
        side === 'source'
          ? task.snapshot.sourceTerminalName
          : task.snapshot.targetTerminalName
      const message = `File transfer failed because the ${side} terminal tab was closed: ${terminalName || terminalId}.`
      this.updateTask(taskId, {
        status: 'error',
        message,
        errorMessage: message,
        completedAt: Date.now(),
      })
      this.settleTask(taskId)
      this.releaseRunSlot(taskId)
    }
  }

  private releaseRunSlot(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task?.runSlotAcquired || task.runSlotReleased) {
      return
    }
    task.runSlotReleased = true
    this.runningCount = Math.max(0, this.runningCount - 1)
    this.pumpQueue()
  }

  private settleTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task || task.settled || !TERMINAL_STATUSES.has(task.snapshot.status)) {
      return
    }
    task.settled = true
    this.notifySettled(task)
    this.scheduleCleanup(taskId)
  }

  private notifySettled(task: FileTransferTaskInternal): void {
    const snapshot = this.cloneTask(task.snapshot)
    task.onSettled?.(snapshot)
    this.emit('settled', snapshot)
  }

  private isTaskTerminal(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    return !task || TERMINAL_STATUSES.has(task.snapshot.status)
  }

  private scheduleCleanup(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.cleanupTimer) {
      clearTimeout(task.cleanupTimer)
    }
    task.cleanupTimer = setTimeout(() => {
      this.tasks.delete(taskId)
      this.rawEventPublisher?.('filesystem:transferTaskRemoved', {
        transferId: taskId,
      })
      this.emit('removed', taskId)
    }, COMPLETED_TRANSFER_RETENTION_MS)
    task.cleanupTimer.unref?.()
  }

  private resolveConflictStrategy(
    strategy: FileTransferConflictStrategy | undefined,
    overwrite: boolean | undefined,
  ): FileTransferConflictStrategy {
    if (
      strategy === 'rename' ||
      strategy === 'overwrite' ||
      strategy === 'error'
    ) {
      return strategy
    }
    return overwrite === true ? 'overwrite' : 'error'
  }

  private normalizeSourcePaths(sourcePaths: string[]): string[] {
    if (!Array.isArray(sourcePaths)) {
      throw new Error('sourcePaths must be an array.')
    }
    const normalized = sourcePaths
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
    if (normalized.length <= 0) {
      throw new Error('sourcePaths must contain at least one path.')
    }
    return normalized
  }

  private normalizeTransferId(transferId: string | undefined): string | null {
    if (typeof transferId !== 'string') return null
    const trimmed = transferId.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  private normalizeTargetDirPath(targetDirPath: string): string {
    if (typeof targetDirPath !== 'string') {
      throw new Error('targetDirPath must be a string.')
    }
    const trimmed = targetDirPath.trim()
    if (!trimmed) {
      throw new Error('targetDirPath must not be empty.')
    }
    return trimmed
  }

  private resolveTerminalSummary(terminalId: string): {
    id: string
    title: string
  } {
    const terminal = this.terminalService
      .getAllTerminals()
      .find((item) => item.id === terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    return {
      id: terminal.id,
      title: terminal.title || terminal.id,
    }
  }

  private basenameFromPath(inputPath: string): string {
    const normalized = String(inputPath || '')
      .trim()
      .replace(/[\\/]+$/, '')
    if (!normalized) return inputPath
    const slashIndex = Math.max(
      normalized.lastIndexOf('/'),
      normalized.lastIndexOf('\\'),
    )
    return slashIndex >= 0
      ? normalized.slice(slashIndex + 1) || normalized
      : normalized
  }

  private cloneTask(task: FileTransferTaskSnapshot): FileTransferTaskSnapshot {
    return {
      ...task,
      sourcePaths: [...task.sourcePaths],
      itemNames: [...task.itemNames],
    }
  }
}
