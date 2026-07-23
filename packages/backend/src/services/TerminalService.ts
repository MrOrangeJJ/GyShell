import pkg from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
const { Terminal } = pkg
import path from 'path'
import os from 'os'
import type {
  TerminalBackend,
  TerminalCommandShellFamily,
  TerminalCommandTrackingToken,
  TerminalCommandTrackingUpdate,
  TerminalExecOptions,
  PeerFileTransferOptions,
  PeerFileTransferResult,
  TerminalFileSystemBackend,
  TerminalConfig,
  TerminalTab,
  CommandResult,
  ConnectionType,
  FileStatInfo,
  FileSystemEntry,
  CommandTask
} from '../types'
import {
  isLocalConnectionConfig,
  isSshConnectionConfig,
  isTerminalFileSystemBackend,
} from '../types'
import { NodePtyBackend } from './NodePtyBackend'
import { SSHBackend } from './SSHBackend'
import { escapeShellPathList } from './ShellUtility'
import { TerminalStateStore, type PersistedTerminalRecord } from './terminal/TerminalStateStore'
import { v4 as uuidv4 } from 'uuid'
import {
  isValidTerminalRuntimeId,
  resolveTerminalConnectionCapabilities,
} from './terminal/terminalConnectionSupport'
import {
  buildUnixDispatchedCommand,
  CommandStreamProtocol,
  type GyShellBoundaryMarker,
} from './terminal/CommandStreamProtocol'
import { CommandTranscriptCapture } from './terminal/CommandTranscriptCapture'
import { buildWindowsPowerShellDispatchRequest } from './windowsPowerShellTracking'
import { TerminalOutputFlowController } from './terminal/TerminalOutputFlowController'

const MAX_BUFFER_SIZE = 200000 // 200KB
const SCROLLBACK_SIZE = 5000 // Keep up to 5000 lines in virtual terminal
const TERMINAL_OUTPUT_RETIRE_TIMEOUT_MS = 10_000
const TERMINAL_HEADLESS_REPLAY_CHUNK_SIZE = 64 * 1024
const PERSIST_FLUSH_DELAY_MS = 120
const PRIVATE_UNIX_ECHO_SCAN_SIZE = 4096
const UNIX_INTERACTIVE_SUBMISSION_BOUNDARY = '\x1b[?2004l'
// Shell hooks provide normal interactive boundaries. Agent commands use a
// top-level eval bookended by runtime-private helpers, which preserves native
// interactive semantics while restoring the hidden ready hook after a command
// legitimately changes its own prompt hooks.
const ANSI_CSI_SEQUENCE_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const ANSI_OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g
const OTHER_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g
const WINDOWS_PROMPT_ONLY_PATTERN = /^(?:PS (?:[A-Za-z]:\\|\/).*?>|[A-Za-z]:\\.*?>)\s*$/
const WINDOWS_PROMPT_PREFIX_PATTERN = /^(?:PS (?:[A-Za-z]:\\|\/).*?>|[A-Za-z]:\\.*?>)\s*/

const renderTerminalSafeCommand = (command: string): string =>
  Array.from(command, (scalar) => {
    const codePoint = scalar.codePointAt(0)!
    if (codePoint <= 0x1f) {
      return `^${String.fromCharCode(codePoint + 0x40)}`
    }
    if (codePoint === 0x7f) {
      return '^?'
    }
    if (codePoint >= 0x80 && codePoint <= 0x9f) {
      return `\\u{${codePoint.toString(16).padStart(4, '0')}}`
    }
    return scalar
  }).join('')

function stripGyShellOscMarkers(s: string): string {
  return s.replace(
    /\x1b]1337;gyshell_(?:[0-9a-f]{32}_)?(?:preexec|preend|precmd)[^\x07]*\x07/g,
    ''
  )
}

function stripTerminalControlSequences(s: string): string {
  return s
    .replace(ANSI_OSC_SEQUENCE_PATTERN, '')
    .replace(ANSI_CSI_SEQUENCE_PATTERN, '')
    .replace(OTHER_CONTROL_CHAR_PATTERN, '')
}

interface RingBuffer {
  content: string
  offset: number
}

export type TerminalRuntimeState = NonNullable<TerminalTab['runtimeState']>
export type TerminalShellInputState = 'idle' | 'busy' | 'unknown'

export interface TerminalRuntimeSnapshot {
  id: string
  title: string
  type: ConnectionType
  runtimeState: TerminalRuntimeState | 'unknown'
  isInitializing: boolean
  lastExitCode?: number
  reconnectable: boolean
  canRunCommand: boolean
  canWrite: boolean
  canUseFilesystem: boolean
  shellInputState?: TerminalShellInputState
  commandProtocolAvailable?: boolean
}

export interface CommandOutputSnapshot {
  taskId: string
  command: string
  status: CommandTask['status']
  executionState: NonNullable<CommandResult['executionState']>
  exitCode?: number
  runtimeBoundary: boolean
  output: string
  capture: NonNullable<CommandResult['capture']>
}

export interface TerminalRenderMetadata {
  remoteOs?: 'unix' | 'windows'
  windowsRelease?: string
}

type RawEventPublisher = (channel: string, data: unknown) => void
type TerminalClosedListener = (terminalId: string) => void
type PendingTaskFinish = {
  taskId: string
  runtimeGeneration: number | undefined
  requiredWriteSeq: number
  exitCode?: number
}

type TerminalTabSnapshot = {
  id: string
  title: string
  type: ConnectionType
  cols: number
  rows: number
  runtimeState?: 'initializing' | 'ready' | 'exited'
  lastExitCode?: number
  remoteOs?: 'unix' | 'windows'
  systemInfo?: TerminalTab['systemInfo']
  monitorIdentity?: string
}

interface TerminalServiceOptions {
  terminalStateStore?: TerminalStateStore | null
}

interface TerminalResizeTarget {
  cols: number
  rows: number
}

interface CommandStartReservation {
  token: symbol
  command: string
  waitForRelease: Promise<void>
  releaseWaiters: () => void
  startedTaskId?: string
}

interface PendingUnixCommandDisplay {
  taskId: string
  command: string
  expectedSequence: number
  expectedNonce: string
  privateDispatcherName: string
  privateEchoEndAnchor: string
  suppressedTextTail: string
  privateEchoObserved: boolean
  submissionBoundaryObserved: boolean
  postSubmitDisplay: string
  postSubmitDisplayOverflowed: boolean
}

interface WindowsManualPromptWatcher {
  ptyId: string
  runtimeGeneration: number | undefined
  expectedInputRevision: number
  expectedPromptSequence: number
  inputIdleSequence?: number
  restoreIdleOnCompletion: boolean
  ownedInputReservation: symbol
  cancelled: boolean
}

interface PromptFileIoLease {
  waitForTurn: Promise<void>
  release: () => void
}

interface TerminalInputSequenceOptions {
  intervalMs?: number
  signal?: AbortSignal
  inputOwner?: 'active-task'
}

const createTerminalAbortError = (): Error => {
  const error = new Error('AbortError')
  error.name = 'AbortError'
  return error
}

const throwIfTerminalOperationAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw createTerminalAbortError()
}

const waitForPromiseOrAbort = <T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  if (!signal) return promise
  throwIfTerminalOperationAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(createTerminalAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

const waitForTerminalDelay = (
  ms: number,
  signal?: AbortSignal
): Promise<void> => {
  throwIfTerminalOperationAborted(signal)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      cleanup()
      reject(createTerminalAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RestoreTerminalResult {
  restored: string[]
  failed: Array<{ id: string; reason: string }>
}

const cloneTerminalConfig = (config: TerminalConfig): TerminalConfig =>
  JSON.parse(JSON.stringify(config)) as TerminalConfig

const normalizeTerminalConfigForRuntime = (config: TerminalConfig): TerminalConfig => {
  if (!isValidTerminalRuntimeId(config.id)) {
    throw new Error('Terminal id is empty, contains control characters, or exceeds the safe output-contract limit.')
  }
  const normalized = cloneTerminalConfig(config)
  normalized.id = config.id
  normalized.title = config.title
  normalized.cols = Number.isFinite(config.cols) && config.cols > 0 ? Math.max(1, Math.floor(config.cols)) : 80
  normalized.rows = Number.isFinite(config.rows) && config.rows > 0 ? Math.max(1, Math.floor(config.rows)) : 24
  return normalized
}

const resolveUniqueTerminalTitle = (
  baseTitle: string,
  existingTitles: Iterable<string>
): string => {
  const usedTitles = new Set(
    Array.from(existingTitles)
      .map((title) => String(title || '').trim())
      .filter((title) => title.length > 0)
  )
  const normalizedBaseTitle = String(baseTitle || '').trim() || 'Terminal'
  if (!usedTitles.has(normalizedBaseTitle)) {
    return normalizedBaseTitle
  }

  const rootTitle = normalizedBaseTitle
  let counter = 1
  let nextTitle = `${rootTitle} (${counter})`
  while (usedTitles.has(nextTitle)) {
    counter += 1
    nextTitle = `${rootTitle} (${counter})`
  }
  return nextTitle
}

const normalizeTerminalResizeTarget = (
  cols: number,
  rows: number
): TerminalResizeTarget | null => {
  if (!Number.isFinite(cols) || cols <= 0 || !Number.isFinite(rows) || rows <= 0) {
    return null
  }
  return {
    cols: Math.max(1, Math.floor(cols)),
    rows: Math.max(1, Math.floor(rows))
  }
}

export class TerminalService {
  private backends: Map<ConnectionType, TerminalBackend> = new Map()
  private terminals: Map<string, TerminalTab> = new Map()
  private terminalConfigs: Map<string, TerminalConfig> = new Map()
  private pendingTerminalTitles: Map<string, string> = new Map()
  private pendingResizeByTerminal: Map<string, TerminalResizeTarget> = new Map()
  private buffers: Map<string, RingBuffer> = new Map()
  private headlessPtys: Map<string, TerminalType> = new Map()
  private selectionByTerminal: Map<string, string> = new Map()
  private tasksByTerminal: Map<string, Record<string, CommandTask>> = new Map()
  private detachedTasksByTerminal: Map<string, Record<string, CommandTask>> = new Map()
  private activeTaskByTerminal: Map<string, string> = new Map()
  private commandStartReservationByTerminal: Map<string, CommandStartReservation> = new Map()
  private deferredWritesDuringCommandStartByTerminal: Map<string, string[]> = new Map()
  private deferredWritesUntilTaskFinishByTaskId: Map<string, string[]> = new Map()
  private promptFileIoTailByTerminal: Map<string, Promise<void>> = new Map()
  private pendingUnixCommandDisplayByTerminal: Map<
    string,
    PendingUnixCommandDisplay
  > = new Map()
  private promptFileIoReleaseByCommandStartToken: Map<symbol, () => void> = new Map()
  private terminalInputSequenceTailByTerminal: Map<string, Promise<void>> = new Map()
  private commandStreamProtocolByTerminal: Map<string, CommandStreamProtocol> = new Map()
  private commandProtocolTokenByTerminal: Map<string, string | undefined> = new Map()
  private captureByTaskId: Map<string, CommandTranscriptCapture> = new Map()
  /**
   * Bytes observed after dispatch but before a trustworthy capture boundary.
   * Unix discards this echo-prefixed staging capture once preexec is verified;
   * Windows promotes it as best-effort output when no sidecar capture exists.
   */
  private unverifiedCaptureByTaskId: Map<string, CommandTranscriptCapture> = new Map()
  private shellInputStateByTerminal: Map<string, TerminalShellInputState> = new Map()
  private lastShellSequenceByTerminal: Map<string, number> = new Map()
  private activeShellBoundaryByTerminal: Map<
    string,
    {
      sequence?: number
      nonce?: string
      legacy: boolean
      inputRevisionAtStart: number
    }
  > = new Map()
  private headlessWriteSeqByTerminal: Map<string, number> = new Map()
  private headlessFlushedSeqByTerminal: Map<string, number> = new Map()
  private outputFlowControllerByTerminal: Map<
    string,
    TerminalOutputFlowController
  > = new Map()
  private outputConsumersByTerminal: Map<string, Set<string>> = new Map()
  private retiringOutputDrainByTerminal: Map<string, Promise<void>> = new Map()
  private terminalOutputFailureGenerationByTerminal: Map<string, number> = new Map()
  private pendingTaskFinishByTerminal: Map<string, PendingTaskFinish> = new Map()
  private backendRuntimeGenerationByTerminal: Map<string, number> = new Map()
  private nextBackendRuntimeGeneration = 0
  private commandTrackingWatcherByTaskId: Map<string, { cancelled: boolean }> = new Map()
  private windowsPromptBaselineByTerminal: Map<
    string,
    TerminalCommandTrackingToken
  > = new Map()
  private windowsManualPromptWatcherByTerminal: Map<
    string,
    WindowsManualPromptWatcher
  > = new Map()
  /**
   * Highest prompt sequence that any agent command or human input may
   * produce. Ambiguous failures retain this floor so delayed older prompts can
   * never complete newer input.
   */
  private windowsPromptSequenceFloorByTerminal: Map<string, number> = new Map()
  private windowsPowerShellBracketedPasteByTerminal: Map<string, boolean> =
    new Map()
  private terminalInputRevisionByTerminal: Map<string, number> = new Map()
  private windowsInputRevisionCommitByTerminal: Map<
    string,
    { runtimeGeneration: number | undefined; tail: Promise<void> }
  > = new Map()
  private pendingInputReservationsByTerminal: Map<string, Set<symbol>> = new Map()
  private onTaskFinishedCallbacks: Map<string, (result: CommandResult) => void> = new Map()
  private primaryLocalTerminalId: string | null = null
  private rawEventPublisher: RawEventPublisher | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly terminalStateStore: TerminalStateStore | null
  private commandTrackingPollIntervalMs = 250
  private commandTrackingMaxConsecutiveErrors = 8
  private commandTrackingPromptSyncPollIntervalMs = 50
  private commandTrackingPromptSyncTimeoutMs = 2000
  private commandTrackingIoTimeoutMs = 5000
  private promptFileRequestTimeoutMs = 5000
  private syntheticCommandQuietWindowMs = 1000
  private syntheticCommandMaxSyncWaitMs = 2000
  private commandCaptureRetentionBudgetBytes = 64 * 1024 * 1024
  private commandCaptureRetentionMaxRecords = 200
  private commandHistoryTombstoneMaxRecords = 200
  private readonly terminalIdsBeingKilled = new Set<string>()
  private readonly terminalClosedListeners = new Set<TerminalClosedListener>()

  constructor(options?: TerminalServiceOptions) {
    this.backends.set('local', new NodePtyBackend())
    this.backends.set('ssh', new SSHBackend())
    this.terminalStateStore = options?.terminalStateStore ?? null
  }

  setRawEventPublisher(publisher: RawEventPublisher): void {
    this.rawEventPublisher = publisher
  }

  onTerminalClosed(listener: TerminalClosedListener): () => void {
    this.terminalClosedListeners.add(listener)
    return () => {
      this.terminalClosedListeners.delete(listener)
    }
  }

  private listRenderableTerminals(): TerminalTabSnapshot[] {
    return Array.from(this.terminals.values()).map((terminal) => ({
      id: terminal.id,
      title: terminal.title,
      type: terminal.type,
      cols: terminal.cols,
      rows: terminal.rows,
      runtimeState: terminal.runtimeState,
      lastExitCode: terminal.lastExitCode,
      remoteOs: terminal.remoteOs,
      systemInfo: terminal.systemInfo,
      monitorIdentity: this.getMonitorIdentity(terminal.id) ?? undefined
    }))
  }

  private publishTerminalTabsChanged(): void {
    this.sendToRenderer('terminal:tabs', {
      terminals: this.listRenderableTerminals()
    })
  }

  private inferRemoteOsFromSystemInfo(
    systemInfo?: TerminalTab['systemInfo']
  ): 'unix' | 'windows' | undefined {
    if (!systemInfo) return undefined

    const platform = String(systemInfo.platform || '').trim().toLowerCase()
    if (platform === 'win32' || platform === 'windows') {
      return 'windows'
    }
    if (platform === 'linux' || platform === 'darwin' || platform === 'unix') {
      return 'unix'
    }

    const osName = String(systemInfo.os || '').trim().toLowerCase()
    if (osName.includes('windows')) {
      return 'windows'
    }
    if (osName) {
      return 'unix'
    }

    return undefined
  }

  private hydrateTerminalRuntimeMetadata(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return false

    const backend = this.getBackend(terminal.type)
    let shouldPublishTabsChanged = false

    const remoteOs = backend.getRemoteOs(terminal.ptyId) ?? this.inferRemoteOsFromSystemInfo(terminal.systemInfo)
    if (remoteOs && terminal.remoteOs !== remoteOs) {
      terminal.remoteOs = remoteOs
      shouldPublishTabsChanged = true
    }

    if (!terminal.systemInfo) {
      const metadataPtyId = terminal.ptyId
      const metadataRuntimeGeneration =
        this.backendRuntimeGenerationByTerminal.get(terminalId) ?? 0
      void backend.getSystemInfo(metadataPtyId).then((info) => {
        if (!info) return

        const latest = this.terminals.get(terminalId)
        if (
          !latest ||
          latest.ptyId !== metadataPtyId ||
          this.backendRuntimeGenerationByTerminal.get(terminalId) !==
            metadataRuntimeGeneration
        ) return

        let shouldPublishLatest = false
        if (!latest.systemInfo) {
          latest.systemInfo = info
          shouldPublishLatest = true
        }

        const nextRemoteOs =
          latest.remoteOs ??
          backend.getRemoteOs(latest.ptyId) ??
          this.inferRemoteOsFromSystemInfo(info)
        if (nextRemoteOs && latest.remoteOs !== nextRemoteOs) {
          latest.remoteOs = nextRemoteOs
          shouldPublishLatest = true
        }

        if (shouldPublishLatest) {
          this.publishTerminalTabsChanged()
        }
      }).catch(() => {
        // Runtime metadata discovery is best-effort.
      })
    }

    return shouldPublishTabsChanged
  }

  private getBackend(type: ConnectionType): TerminalBackend {
    const backend = this.backends.get(type)
    if (!backend) {
      throw new Error(`No backend found for connection type: ${type}`)
    }
    return backend
  }

  private backendUsesPowerShellSidecar(
    terminal: TerminalTab | undefined
  ): boolean {
    if (!terminal) return false
    return (
      this.getBackend(terminal.type).getCommandTrackingMode?.(
        terminal.ptyId
      ) === 'windows-powershell-sidecar'
    )
  }

  private getCommandShellFamily(
    terminal: TerminalTab | undefined
  ): TerminalCommandShellFamily | undefined {
    if (!terminal) return undefined
    const declaredFamily = this.getBackend(
      terminal.type
    ).getCommandShellFamily?.(terminal.ptyId)
    if (declaredFamily) return declaredFamily
    if (this.backendUsesPowerShellSidecar(terminal)) return 'powershell'
    if (terminal.remoteOs === 'windows') return 'powershell'
    if (terminal.remoteOs === 'unix') return 'unix'
    return undefined
  }

  /**
   * Command lifecycle behavior follows the interactive shell protocol, not
   * the filesystem host. PowerShell Core on macOS/Linux keeps Unix path
   * semantics while using the same prompt-file sidecar as Windows.
   */
  private usesPowerShellCommandLifecycle(
    terminal: TerminalTab | undefined
  ): boolean {
    return this.getCommandShellFamily(terminal) === 'powershell'
  }

  private canObserveManualPowerShellPrompt(
    terminalId: string,
    terminal: TerminalTab
  ): boolean {
    if (!this.usesPowerShellCommandLifecycle(terminal)) {
      return false
    }
    const activeTask = this.getActiveTask(terminalId)
    return (
      !activeTask ||
      (this.backendUsesPowerShellSidecar(terminal) &&
        activeTask.observedShellPromptSequence !== undefined)
    )
  }

  private runtimeNeedsInitializationSilence(
    config: TerminalConfig,
    ptyId: string
  ): boolean {
    if (config.type === 'ssh') return true
    if (config.type !== 'local') return false
    const backend = this.getBackend(config.type)
    const declaredFamily = backend.getCommandShellFamily?.(ptyId)
    if (declaredFamily) return declaredFamily === 'powershell'
    if (
      backend.getCommandTrackingMode?.(ptyId) ===
      'windows-powershell-sidecar'
    ) return true
    if (typeof backend.getCommandShellFamily === 'function') return false
    return (
      os.platform() === 'win32'
    )
  }

  private getFileSystemBackend(
    terminal: TerminalTab,
  ): TerminalFileSystemBackend {
    const backend = this.getBackend(terminal.type)
    if (!isTerminalFileSystemBackend(backend)) {
      throw new Error(
        `Connection type ${terminal.type} does not support filesystem operations.`,
      )
    }
    return backend
  }

  private mergeTerminalConfigForIdempotent(existing: TerminalConfig, incoming: TerminalConfig): TerminalConfig {
    if (existing.type !== incoming.type) {
      return normalizeTerminalConfigForRuntime(existing)
    }
    return normalizeTerminalConfigForRuntime({
      ...existing,
      ...incoming,
      id: existing.id,
      type: existing.type
    } as TerminalConfig)
  }

  private resolveUniqueTitleForTerminal(title: string, terminalId: string): string {
    return resolveUniqueTerminalTitle(
      title,
      [
        ...Array.from(this.terminals.values())
          .filter((terminal) => terminal.id !== terminalId)
          .map((terminal) => terminal.title),
        ...Array.from(this.pendingTerminalTitles.entries())
          .filter(([pendingTerminalId]) => pendingTerminalId !== terminalId)
          .map(([, pendingTitle]) => pendingTitle)
      ]
    )
  }

  private reserveUniqueTitleForTerminal(title: string, terminalId: string): string {
    const uniqueTitle = this.resolveUniqueTitleForTerminal(title, terminalId)
    this.pendingTerminalTitles.set(terminalId, uniqueTitle)
    return uniqueTitle
  }

  private releaseReservedTitleForTerminal(terminalId: string, title: string): void {
    if (this.pendingTerminalTitles.get(terminalId) !== title) {
      return
    }
    this.pendingTerminalTitles.delete(terminalId)
  }

  private extractTerminalConfigForPersist(terminal: TerminalTab): TerminalConfig | null {
    const existing = this.terminalConfigs.get(terminal.id)
    if (existing) {
      return normalizeTerminalConfigForRuntime({
        ...existing,
        id: terminal.id,
        title: terminal.title,
        cols: terminal.cols,
        rows: terminal.rows
      } as TerminalConfig)
    }

    if (terminal.type === 'local') {
      return {
        type: 'local',
        id: terminal.id,
        title: terminal.title,
        cols: terminal.cols > 0 ? terminal.cols : 80,
        rows: terminal.rows > 0 ? terminal.rows : 24
      }
    }

    return null
  }

  private getPersistableRecords(): PersistedTerminalRecord[] {
    const records: PersistedTerminalRecord[] = []
    Array.from(this.terminals.values()).forEach((terminal) => {
      const config = this.extractTerminalConfigForPersist(terminal)
      if (!config) return
      records.push({
        id: terminal.id,
        config
      })
    })
    return records
  }

  private persistTerminalStateNow(): void {
    if (!this.terminalStateStore) return
    this.terminalStateStore.save(this.getPersistableRecords())
  }

  private schedulePersistTerminalState(): void {
    if (!this.terminalStateStore) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistTerminalStateNow()
    }, PERSIST_FLUSH_DELAY_MS)
  }

  flushPersistedState(): void {
    if (!this.terminalStateStore) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistTerminalStateNow()
  }

  private async spawnBackendRuntime(
    initialConfig: TerminalConfig
  ): Promise<{ config: TerminalConfig; ptyId: string }> {
    let config = initialConfig
    const backend = this.getBackend(config.type)
    const ptyId = await backend.spawn(config)
    const pendingResizeAfterSpawn = this.pendingResizeByTerminal.get(config.id)
    if (pendingResizeAfterSpawn) {
      this.pendingResizeByTerminal.delete(config.id)
      config = normalizeTerminalConfigForRuntime({
        ...config,
        cols: pendingResizeAfterSpawn.cols,
        rows: pendingResizeAfterSpawn.rows
      } as TerminalConfig)
      backend.resize(ptyId, config.cols, config.rows)
    }
    return { config, ptyId }
  }

  private clearWindowsPromptRuntimeState(terminalId: string): void {
    const manualWatcher = this.windowsManualPromptWatcherByTerminal.get(terminalId)
    if (manualWatcher) manualWatcher.cancelled = true
    this.windowsManualPromptWatcherByTerminal.delete(terminalId)
    this.windowsPromptBaselineByTerminal.delete(terminalId)
    this.windowsPromptSequenceFloorByTerminal.delete(terminalId)
    this.windowsPowerShellBracketedPasteByTerminal.delete(terminalId)
    this.terminalInputRevisionByTerminal.delete(terminalId)
    this.windowsInputRevisionCommitByTerminal.delete(terminalId)
    // A stale sequence owns its captured Set. Replacing the map entry means
    // its eventual finally block cannot delete reservations for this runtime.
    this.pendingInputReservationsByTerminal.delete(terminalId)
  }

  private countWindowsPromptSubmissions(
    terminalId: string,
    input: string
  ): number {
    let count = 0
    let inBracketedPaste =
      this.windowsPowerShellBracketedPasteByTerminal.get(terminalId) === true
    for (let index = 0; index < input.length; index += 1) {
      if (input.startsWith('\x1b[200~', index)) {
        inBracketedPaste = true
        index += 5
        continue
      }
      if (input.startsWith('\x1b[201~', index)) {
        inBracketedPaste = false
        index += 5
        continue
      }
      if (inBracketedPaste) continue
      const code = input.charCodeAt(index)
      if (code === 13) {
        count += 1
        if (input.charCodeAt(index + 1) === 10) index += 1
      } else if (code === 10 || code === 3) {
        count += 1
      }
    }
    if (inBracketedPaste) {
      this.windowsPowerShellBracketedPasteByTerminal.set(terminalId, true)
    } else {
      this.windowsPowerShellBracketedPasteByTerminal.delete(terminalId)
    }
    return count
  }

  private noteWindowsPowerShellInputIdle(
    terminalId: string,
    sequence: number,
    inputRevision: number
  ): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !Number.isSafeInteger(inputRevision) ||
      inputRevision < 1
    ) {
      return
    }
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      const baseline = this.getWindowsPromptBaselineWithoutIo(
        terminalId,
        terminal
      )
      if (baseline && sequence >= baseline.baselineSequence) {
        this.rememberWindowsPromptBaseline(terminalId, baseline, sequence)
      }
    }
    const watcher = this.windowsManualPromptWatcherByTerminal.get(terminalId)
    if (watcher?.expectedInputRevision === inputRevision) {
      watcher.inputIdleSequence = Math.max(
        watcher.inputIdleSequence || 0,
        sequence
      )
      this.tryCompleteWindowsManualPromptWatcher(terminalId)
    }
  }

  private registerBackendRuntimeHandlers(
    terminalId: string,
    terminalType: ConnectionType,
    ptyId: string
  ): void {
    this.clearWindowsPromptRuntimeState(terminalId)
    this.pendingUnixCommandDisplayByTerminal.delete(terminalId)
    this.nextBackendRuntimeGeneration += 1
    const runtimeGeneration = this.nextBackendRuntimeGeneration
    this.backendRuntimeGenerationByTerminal.set(
      terminalId,
      runtimeGeneration
    )
    const backend = this.getBackend(terminalType)
    this.synchronizeCommandStreamProtocol(terminalId, backend, ptyId)
    let runtimeExited = false
    const isCurrentRuntime = (): boolean => {
      const terminal = this.terminals.get(terminalId)
      return (
        !runtimeExited &&
        terminal?.ptyId === ptyId &&
        this.backendRuntimeGenerationByTerminal.get(terminalId) ===
          runtimeGeneration
      )
    }
    this.outputFlowControllerByTerminal.get(terminalId)?.dispose()
    const headless = this.headlessPtys.get(terminalId)
    const outputFlowController = new TerminalOutputFlowController({
      runtimeGeneration,
      writeHeadless: headless
        ? (data, callback) => headless.write(data, callback)
        : undefined,
      pauseSource: () => {
        if (isCurrentRuntime()) backend.pauseOutput?.(ptyId)
      },
      resumeSource: () => {
        if (isCurrentRuntime()) backend.resumeOutput?.(ptyId)
      },
      onHeadlessFailure: (error) => {
        this.handleTerminalOutputFailure(
          terminalId,
          terminalType,
          ptyId,
          runtimeGeneration,
          error
        )
      }
    })
    for (const consumerId of this.outputConsumersByTerminal.get(terminalId) || []) {
      outputFlowController.attachRendererConsumer(consumerId)
    }
    this.outputFlowControllerByTerminal.set(terminalId, outputFlowController)
    const failedGeneration =
      this.terminalOutputFailureGenerationByTerminal.get(terminalId)
    if (
      Number.isSafeInteger(failedGeneration) &&
      failedGeneration !== runtimeGeneration
    ) {
      // A replacement runtime can be silent until its first prompt. Publish a
      // zero-byte generation boundary so a failed visible parser can rebuild
      // immediately from the retained buffer without waiting for new output.
      this.sendToRenderer('terminal:data', {
        terminalId,
        data: '',
        offset: this.getCurrentOffset(terminalId),
        runtimeGeneration,
        ...this.getRenderMetadata(terminalId)
      })
    }
    backend.onData(ptyId, (data: string) => {
      if (!isCurrentRuntime()) return
      try {
        this.synchronizeCommandStreamProtocol(terminalId, backend, ptyId)
        this.handleData(terminalId, data, isCurrentRuntime)
      } catch (error) {
        this.handleTerminalOutputFailure(
          terminalId,
          terminalType,
          ptyId,
          runtimeGeneration,
          error instanceof Error ? error : new Error(String(error))
        )
      }
    })
    backend.onExit(ptyId, (code: number) => {
      if (!isCurrentRuntime()) return
      runtimeExited = true
      this.handleExit(terminalId, code)
    })
  }

  private synchronizeCommandStreamProtocol(
    terminalId: string,
    backend: TerminalBackend,
    ptyId: string
  ): void {
    const runtimeToken = backend.getCommandProtocolToken?.(ptyId)
    const hasCurrentToken = this.commandProtocolTokenByTerminal.has(terminalId)
    const currentToken = this.commandProtocolTokenByTerminal.get(terminalId)
    if (
      hasCurrentToken &&
      currentToken === runtimeToken &&
      this.commandStreamProtocolByTerminal.has(terminalId)
    ) {
      return
    }

    // SSH learns the remote OS after registration. Its Unix token becomes
    // visible before the injected hook can emit protocol data, so replacing
    // the empty/legacy parser here keeps Windows on the legacy namespace while
    // binding Unix parsing to the runtime-private namespace.
    this.commandProtocolTokenByTerminal.set(terminalId, runtimeToken)
    this.commandStreamProtocolByTerminal.set(
      terminalId,
      new CommandStreamProtocol(runtimeToken)
    )
  }

  async restorePersistedTerminals(): Promise<RestoreTerminalResult> {
    if (!this.terminalStateStore) {
      return { restored: [], failed: [] }
    }

    const records = this.terminalStateStore.load()
    if (records.length === 0) {
      return { restored: [], failed: [] }
    }

    const restored: string[] = []
    const failed: Array<{ id: string; reason: string }> = []

    for (const record of records) {
      try {
        await this.createTerminal(record.config)
        restored.push(record.id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failed.push({ id: record.id, reason })
      }
    }

    // Prune any entries that could not be restored to avoid repeated startup failures.
    this.persistTerminalStateNow()

    return { restored, failed }
  }

  private async printBanner(terminalId: string): Promise<void> {
    // ANSI Shadow font for "GyShell"
    // Using \x1b[36m for Cyan color
    const banner = `\r\n\x1b[36m  ____         ____  _          _ _ \r\n / ___|_   _  / ___|| |__   ___| | |\r\n| |  _| | | | \\___ \\| '_ \\ / _ \\ | |\r\n| |_| | |_| |  ___) | | | |  __/ | |\r\n \\____|\\__, | |____/|_| |_|\\___|_|_|\r\n       |___/                        \x1b[0m\r\n`

    // Small delay to ensure shell is ready
    setTimeout(() => {
      // Inject the banner directly into the local display state without
      // routing it through command-output capture.
      this.appendSyntheticDisplayData(terminalId, banner)
    }, 500)
  }

  async createTerminal(rawConfig: TerminalConfig): Promise<TerminalTab> {
    let config = normalizeTerminalConfigForRuntime(rawConfig)
    const pendingResizeBeforeCreate = this.pendingResizeByTerminal.get(config.id)
    if (pendingResizeBeforeCreate) {
      config = normalizeTerminalConfigForRuntime({
        ...config,
        cols: pendingResizeBeforeCreate.cols,
        rows: pendingResizeBeforeCreate.rows
      } as TerminalConfig)
      this.pendingResizeByTerminal.delete(config.id)
    }
    // Idempotent: renderer may call createTab more than once (dev reload / re-mount).
    const existing = this.terminals.get(config.id)
    if (existing) {
      config = normalizeTerminalConfigForRuntime({
        ...config,
        title: this.resolveUniqueTitleForTerminal(config.title, config.id)
      } as TerminalConfig)
      const existingConfig = this.terminalConfigs.get(config.id)
      const mergedConfig = existingConfig
        ? this.mergeTerminalConfigForIdempotent(existingConfig, config)
        : config
      const shouldResizeBackend =
        existing.cols !== mergedConfig.cols ||
        existing.rows !== mergedConfig.rows ||
        Boolean(pendingResizeBeforeCreate)

      // Keep size updated
      existing.cols = mergedConfig.cols
      existing.rows = mergedConfig.rows
      // Keep title updated (required)
      existing.title = mergedConfig.title
      existing.capabilities = resolveTerminalConnectionCapabilities(mergedConfig)
      
      const headless = this.headlessPtys.get(config.id)
      if (headless) {
        headless.resize(mergedConfig.cols, mergedConfig.rows)
      }

      if (shouldResizeBackend) {
        const backend = this.getBackend(existing.type)
        backend.resize(existing.ptyId, mergedConfig.cols, mergedConfig.rows)
      }

      this.terminalConfigs.set(config.id, mergedConfig)
      this.schedulePersistTerminalState()

      if (this.hydrateTerminalRuntimeMetadata(config.id)) {
        this.publishTerminalTabsChanged()
      }

      return existing
    }

    const reservedTitle = this.reserveUniqueTitleForTerminal(config.title, config.id)
    config = normalizeTerminalConfigForRuntime({
      ...config,
      title: reservedTitle
    } as TerminalConfig)

    let runtime: { config: TerminalConfig; ptyId: string }
    try {
      runtime = await this.spawnBackendRuntime(config)
    } catch (error) {
      this.releaseReservedTitleForTerminal(config.id, reservedTitle)
      throw error
    }
    config = runtime.config

    const needsInitializationSilence =
      this.runtimeNeedsInitializationSilence(config, runtime.ptyId)
    const tab: TerminalTab = {
      id: config.id,
      ptyId: runtime.ptyId,
      title: config.title,
      cols: config.cols,
      rows: config.rows,
      type: config.type,
      capabilities: resolveTerminalConnectionCapabilities(config),
      isInitializing: needsInitializationSilence,
      runtimeState: needsInitializationSilence ? 'initializing' : 'ready'
    }

    // Initialize Headless Terminal for AI context
    const headless = new Terminal({
      cols: config.cols,
      rows: config.rows,
      scrollback: SCROLLBACK_SIZE,
      allowProposedApi: true
    })

    this.terminals.set(config.id, tab)
    this.terminalConfigs.set(config.id, config)
    this.releaseReservedTitleForTerminal(config.id, reservedTitle)
    this.buffers.set(config.id, { content: '', offset: 0 })
    this.headlessPtys.set(config.id, headless)
    if (config.type === 'local' && !this.primaryLocalTerminalId) {
      this.primaryLocalTerminalId = config.id
    }

    this.registerBackendRuntimeHandlers(config.id, config.type, runtime.ptyId)

    this.hydrateTerminalRuntimeMetadata(config.id)

    // Print banner for the first local terminal
    if (config.type === 'local' && this.primaryLocalTerminalId === config.id) {
      this.printBanner(config.id)
    }

    this.publishTerminalTabsChanged()
    this.schedulePersistTerminalState()

    return tab
  }

  async reconnectTerminal(terminalId: string): Promise<TerminalTab> {
    const tab = this.terminals.get(terminalId)
    if (!tab) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    if (tab.type !== 'ssh') {
      throw new Error(`Terminal ${terminalId} is not a remote SSH terminal`)
    }
    if (tab.runtimeState !== 'exited') {
      throw new Error(`Terminal ${terminalId} is not disconnected`)
    }

    const existingConfig = this.terminalConfigs.get(terminalId)
    if (!existingConfig || !isSshConnectionConfig(existingConfig)) {
      throw new Error(
        `Terminal ${terminalId} does not have a reconnectable SSH config`
      )
    }

    const backend = this.getBackend(tab.type)
    await this.retiringOutputDrainByTerminal.get(terminalId)
    if (
      this.terminals.get(terminalId) !== tab ||
      tab.runtimeState !== 'exited'
    ) {
      throw new Error(`Terminal ${terminalId} changed while reconnecting`)
    }
    try {
      backend.kill(tab.ptyId)
    } catch {
      // The previous SSH runtime is normally already gone after exit.
    }

    const previousLastExitCode = tab.lastExitCode
    const reconnectConfig = normalizeTerminalConfigForRuntime({
      ...existingConfig,
      id: tab.id,
      title: tab.title,
      cols: tab.cols,
      rows: tab.rows
    } as TerminalConfig)

    tab.isInitializing = true
    tab.runtimeState = 'initializing'
    tab.lastExitCode = undefined
    tab.capabilities = resolveTerminalConnectionCapabilities(reconnectConfig)
    this.terminalConfigs.set(terminalId, reconnectConfig)
    this.publishTerminalTabsChanged()

    try {
      const runtime = await this.spawnBackendRuntime(reconnectConfig)
      const nextConfig = runtime.config
      tab.ptyId = runtime.ptyId
      tab.title = nextConfig.title
      tab.cols = nextConfig.cols
      tab.rows = nextConfig.rows
      tab.type = nextConfig.type
      tab.capabilities = resolveTerminalConnectionCapabilities(nextConfig)
      tab.isInitializing = nextConfig.type === 'ssh'
      tab.runtimeState = nextConfig.type === 'ssh' ? 'initializing' : 'ready'
      tab.lastExitCode = undefined
      tab.remoteOs = undefined
      tab.systemInfo = undefined
      this.terminalConfigs.set(terminalId, nextConfig)

      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.resize(nextConfig.cols, nextConfig.rows)
      } else {
        this.headlessPtys.set(
          terminalId,
          new Terminal({
            cols: nextConfig.cols,
            rows: nextConfig.rows,
            scrollback: SCROLLBACK_SIZE,
            allowProposedApi: true
          })
        )
      }

      this.registerBackendRuntimeHandlers(
        terminalId,
        nextConfig.type,
        runtime.ptyId
      )
      this.hydrateTerminalRuntimeMetadata(terminalId)
      this.publishTerminalTabsChanged()
      this.schedulePersistTerminalState()

      return tab
    } catch (error) {
      tab.isInitializing = false
      tab.runtimeState = 'exited'
      tab.lastExitCode =
        typeof previousLastExitCode === 'number' ? previousLastExitCode : -1
      this.publishTerminalTabsChanged()
      this.schedulePersistTerminalState()
      throw error
    }
  }

  private async restartLocalTerminalAfterExit(
    terminalId: string,
    code: number,
    outputDrain?: Promise<void>
  ): Promise<void> {
    const tab = this.terminals.get(terminalId)
    const existingConfig = this.terminalConfigs.get(terminalId)
    if (!tab || !existingConfig || !isLocalConnectionConfig(existingConfig)) {
      return
    }

    const restartConfig = normalizeTerminalConfigForRuntime({
      ...existingConfig,
      id: tab.id,
      title: tab.title,
      cols: tab.cols,
      rows: tab.rows
    } as TerminalConfig)

    // The old PTY has exited and no replacement exists yet. Keep every local
    // shell non-writable until spawn returns and the tab is bound to that exact
    // runtime; otherwise a synchronous caller can dispatch into the dead PTY.
    tab.isInitializing = true
    tab.runtimeState = 'initializing'
    tab.lastExitCode = undefined
    tab.capabilities = resolveTerminalConnectionCapabilities(restartConfig)
    this.terminalConfigs.set(terminalId, restartConfig)
    this.publishTerminalTabsChanged()

    await outputDrain
    if (this.terminals.get(terminalId) !== tab) {
      return
    }

    try {
      const runtime = await this.spawnBackendRuntime(restartConfig)
      const nextConfig = runtime.config
      tab.ptyId = runtime.ptyId
      tab.title = nextConfig.title
      tab.cols = nextConfig.cols
      tab.rows = nextConfig.rows
      tab.type = nextConfig.type
      tab.capabilities = resolveTerminalConnectionCapabilities(nextConfig)
      tab.isInitializing = this.runtimeNeedsInitializationSilence(
        nextConfig,
        runtime.ptyId
      )
      tab.runtimeState = tab.isInitializing ? 'initializing' : 'ready'
      tab.lastExitCode = undefined
      this.terminalConfigs.set(terminalId, nextConfig)

      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.resize(nextConfig.cols, nextConfig.rows)
      }

      this.registerBackendRuntimeHandlers(terminalId, nextConfig.type, runtime.ptyId)
      this.hydrateTerminalRuntimeMetadata(terminalId)
      this.publishTerminalTabsChanged()
      this.schedulePersistTerminalState()
    } catch {
      tab.isInitializing = false
      tab.runtimeState = 'exited'
      tab.lastExitCode = typeof code === 'number' ? code : -1
      this.publishTerminalTabsChanged()
      this.schedulePersistTerminalState()
    }
  }

  private handleData(
    terminalId: string,
    data: string,
    isCurrentRuntime: () => boolean
  ): void {
    const tab = this.terminals.get(terminalId)
    if (tab) {
      let shouldPublishTabsChanged = false

      // Sync initialization state and remote OS
      if (tab.isInitializing) {
        if (tab.type === 'ssh') {
          const backend = this.getBackend('ssh') as SSHBackend
          const initState = backend.getInitializationState(tab.ptyId)
          if (initState === 'ready') {
            tab.isInitializing = false
            tab.runtimeState = 'ready'
            shouldPublishTabsChanged = true
          } else if (initState === 'failed') {
            tab.isInitializing = false
            tab.runtimeState = 'exited'
            tab.lastExitCode = -1
            shouldPublishTabsChanged = true
          }
        } else {
          // For local silence mode, first meaningful output means shell is ready.
          tab.isInitializing = false
          tab.runtimeState = 'ready'
          shouldPublishTabsChanged = true
        }
      }

      shouldPublishTabsChanged =
        this.hydrateTerminalRuntimeMetadata(terminalId) || shouldPublishTabsChanged

      if (shouldPublishTabsChanged) {
        this.publishTerminalTabsChanged()
      }
    }
    const taskRawDisplaySuppressed = this.shouldSuppressRawTaskDisplay(terminalId)
    const suppressRawDisplay = taskRawDisplaySuppressed
    const headless = this.headlessPtys.get(terminalId)
    let writeSeq = 0
    let headlessData = ''
    if (!suppressRawDisplay && headless && data) {
      writeSeq = (this.headlessWriteSeqByTerminal.get(terminalId) || 0) + 1
      this.headlessWriteSeqByTerminal.set(terminalId, writeSeq)
      headlessData = data
    }

    // Process OSC markers and strip markers from visual output
    const cleanedData = this.processIncomingData(terminalId, data, writeSeq)
    const displayFilteredTaskData = taskRawDisplaySuppressed
    if (displayFilteredTaskData && headless && cleanedData) {
      writeSeq = (this.headlessWriteSeqByTerminal.get(terminalId) || 0) + 1
      this.headlessWriteSeqByTerminal.set(terminalId, writeSeq)
      headlessData = cleanedData
    }
    let visibleOffset = 0
    if (
      (!suppressRawDisplay || displayFilteredTaskData) &&
      cleanedData
    ) {
      const buffer = this.buffers.get(terminalId)
      if (buffer) {
        buffer.content += cleanedData
        buffer.offset += cleanedData.length
        visibleOffset = buffer.offset

        if (buffer.content.length > MAX_BUFFER_SIZE) {
          const trimAmount = buffer.content.length - MAX_BUFFER_SIZE
          buffer.content = buffer.content.slice(trimAmount)
        }
      }

    }
    const hasVisibleData =
      (!suppressRawDisplay || displayFilteredTaskData) && Boolean(cleanedData)
    if (headlessData || hasVisibleData) {
      const runtimeGeneration =
        this.backendRuntimeGenerationByTerminal.get(terminalId)
      const outputController = this.outputFlowControllerByTerminal.get(terminalId)
      outputController?.enqueue({
        sourceCost: data.length,
        headlessData,
        hasVisibleData,
        onHeadlessDrained: writeSeq > 0
          ? () => {
              if (!isCurrentRuntime()) return
              const flushed = Math.max(
                this.headlessFlushedSeqByTerminal.get(terminalId) || 0,
                writeSeq
              )
              this.headlessFlushedSeqByTerminal.set(terminalId, flushed)
              this.tryFlushPendingTaskFinish(terminalId)
            }
          : undefined,
        publishVisible: hasVisibleData
          ? (outputSequence, controllerGeneration) => {
              if (
                controllerGeneration !== runtimeGeneration ||
                !isCurrentRuntime()
              ) {
                return
              }
              const published = this.sendToRenderer('terminal:data', {
                terminalId,
                data: cleanedData,
                offset: visibleOffset,
                outputSequence,
                runtimeGeneration: controllerGeneration,
                ...this.getRenderMetadata(terminalId)
              })
              if (!published) {
                throw new Error('visible terminal output publisher unavailable')
              }
            }
          : undefined
      })
    }
    const currentTerminal = this.terminals.get(terminalId)
    if (
      currentTerminal !== undefined &&
      this.usesPowerShellCommandLifecycle(currentTerminal) &&
      currentTerminal.runtimeState === 'ready' &&
      !this.activeTaskByTerminal.has(terminalId) &&
      !this.commandStartReservationByTerminal.has(terminalId) &&
      this.shellInputStateByTerminal.get(terminalId) !== 'idle'
    ) {
      // The in-band PowerShell fallback settles through its OSC marker. A
      // sidecar runtime returns a verified out-of-band baseline here.
      void this.ensureWindowsPromptBaseline(terminalId)
    }
  }

  private getActiveTask(terminalId: string): CommandTask | undefined {
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) {
      return undefined
    }
    return this.getTaskMap(terminalId)[taskId]
  }

  private shouldSuppressRawTaskDisplay(terminalId: string): boolean {
    const task = this.getActiveTask(terminalId)
    return (
      task?.displayMode === 'synthetic-transcript' ||
      this.pendingUnixCommandDisplayByTerminal.has(terminalId)
    )
  }

  private appendSyntheticDisplayData(terminalId: string, data: string): void {
    if (!data) {
      return
    }

    const headless = this.headlessPtys.get(terminalId)
    let writeSeq = 0
    if (headless) {
      writeSeq = (this.headlessWriteSeqByTerminal.get(terminalId) || 0) + 1
      this.headlessWriteSeqByTerminal.set(terminalId, writeSeq)
    }

    const buffer = this.buffers.get(terminalId)
    let currentOffset = 0
    if (buffer) {
      buffer.content += data
      buffer.offset += data.length
      currentOffset = buffer.offset

      if (buffer.content.length > MAX_BUFFER_SIZE) {
        const trimAmount = buffer.content.length - MAX_BUFFER_SIZE
        buffer.content = buffer.content.slice(trimAmount)
      }
    }

    const terminalAtWrite = this.terminals.get(terminalId)
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    this.outputFlowControllerByTerminal.get(terminalId)?.enqueue({
      sourceCost: data.length,
      headlessData: headless ? data : '',
      hasVisibleData: true,
      onHeadlessDrained: writeSeq > 0
        ? () => {
            if (
              this.terminals.get(terminalId) !== terminalAtWrite ||
              this.backendRuntimeGenerationByTerminal.get(terminalId) !==
                runtimeGeneration
            ) {
              return
            }
            const flushed = Math.max(
              this.headlessFlushedSeqByTerminal.get(terminalId) || 0,
              writeSeq
            )
            this.headlessFlushedSeqByTerminal.set(terminalId, flushed)
          }
        : undefined,
      publishVisible: (outputSequence, controllerGeneration) => {
        if (controllerGeneration !== runtimeGeneration) return
        const published = this.sendToRenderer('terminal:data', {
          terminalId,
          data,
          offset: currentOffset,
          outputSequence,
          runtimeGeneration: controllerGeneration,
          ...this.getRenderMetadata(terminalId)
        })
        if (!published) {
          throw new Error('visible terminal output publisher unavailable')
        }
      }
    })
  }

  private getVisibleWindowsPromptLine(terminalId: string): string | undefined {
    const ringBuffer = this.buffers.get(terminalId)
    if (ringBuffer?.content) {
      const tailLine = stripTerminalControlSequences(
        ringBuffer.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').slice(-1)[0] || ''
      ).trimEnd()
      if (WINDOWS_PROMPT_ONLY_PATTERN.test(tailLine)) {
        return tailLine
      }
    }

    const headless = this.headlessPtys.get(terminalId)
    const buffer = headless?.buffer.active
    if (buffer) {
      const currentLine = buffer.getLine(buffer.baseY + buffer.cursorY)
      const renderedCurrentLine = currentLine
        ? stripTerminalControlSequences(currentLine.translateToString(true)).trimEnd()
        : ''
      if (WINDOWS_PROMPT_ONLY_PATTERN.test(renderedCurrentLine)) {
        return renderedCurrentLine
      }
    }
    return undefined
  }

  private resolveVisibleWindowsPromptPrefix(terminalId: string, terminal: TerminalTab): string {
    const visiblePromptLine = this.getVisibleWindowsPromptLine(terminalId)
    if (visiblePromptLine) {
      return visiblePromptLine.replace(/[ \t]+$/g, '') + ' '
    }
    const cwd = this.getCwd(terminalId)
    if (cwd) {
      const promptCwd =
        terminal.remoteOs === 'windows' ? cwd.replace(/\//g, '\\') : cwd
      return `PS ${promptCwd}> `
    }

    return this.usesPowerShellCommandLifecycle(terminal) ? 'PS> ' : ''
  }

  private hasVisibleWindowsPromptLine(terminalId: string): boolean {
    return Boolean(this.getVisibleWindowsPromptLine(terminalId))
  }

  private buildSyntheticTaskPrelude(terminalId: string, terminal: TerminalTab, command: string): string {
    const promptPrefix = this.resolveVisibleWindowsPromptPrefix(terminalId, terminal)
    const clearCurrentPrompt = this.hasVisibleWindowsPromptLine(terminalId)
    return `${clearCurrentPrompt ? '\x1b[2K\r' : ''}${promptPrefix}${command}\r\n`
  }

  private buildSyntheticUnixCommandEcho(command: string, output = ''): string {
    const normalizedOutput = output
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n/g, '\r\n')
    return `${renderTerminalSafeCommand(command)}\r\n${normalizedOutput}`
  }

  private stagePendingUnixPostSubmitDisplay(
    pending: PendingUnixCommandDisplay,
    text: string
  ): void {
    let postSubmitText: string
    if (!pending.submissionBoundaryObserved) {
      const anchorIndex = pending.suppressedTextTail.lastIndexOf(
        pending.privateEchoEndAnchor
      )
      if (anchorIndex < 0) {
        return
      }
      const boundaryIndex = pending.suppressedTextTail.lastIndexOf(
        UNIX_INTERACTIVE_SUBMISSION_BOUNDARY
      )
      if (
        boundaryIndex <
        anchorIndex + pending.privateEchoEndAnchor.length
      ) {
        return
      }
      const lineEnd = pending.suppressedTextTail.indexOf(
        '\n',
        boundaryIndex + UNIX_INTERACTIVE_SUBMISSION_BOUNDARY.length
      )
      if (lineEnd < 0) {
        return
      }
      // Require both a runtime-bound suffix from the wire command and the
      // non-rendering Readline/ZLE submission boundary. Text after the next
      // line break can belong to user preexec hooks; without both positive
      // signals the safe behavior is to keep suppressing.
      pending.submissionBoundaryObserved = true
      postSubmitText = pending.suppressedTextTail.slice(lineEnd + 1)
    } else {
      postSubmitText = text
    }
    if (!postSubmitText || pending.postSubmitDisplayOverflowed) {
      return
    }
    if (
      pending.postSubmitDisplay.length + postSubmitText.length >
      MAX_BUFFER_SIZE
    ) {
      pending.postSubmitDisplay = ''
      pending.postSubmitDisplayOverflowed = true
      return
    }
    pending.postSubmitDisplay += postSubmitText
  }

  private getSafePendingUnixPostSubmitDisplay(
    pending: PendingUnixCommandDisplay
  ): string {
    if (pending.postSubmitDisplayOverflowed || !pending.postSubmitDisplay) {
      return ''
    }
    return this.containsPrivateUnixDisplay(pending.postSubmitDisplay, pending)
      ? ''
      : pending.postSubmitDisplay
  }

  private containsPrivateUnixDisplay(
    display: string,
    pending: PendingUnixCommandDisplay
  ): boolean {
    const plain = stripTerminalControlSequences(display)
    const compact = plain.replace(/\s+/g, '')
    return (
      compact.includes('__gyshell_') ||
      compact.includes(pending.privateDispatcherName) ||
      compact.includes(pending.expectedNonce)
    )
  }

  private buildSyntheticTaskCompletionDisplay(terminalId: string, terminal: TerminalTab, output: string): string {
    const normalizedOutput = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '')
    const promptPrefix = this.resolveVisibleWindowsPromptPrefix(terminalId, terminal)
    if (!normalizedOutput) {
      return promptPrefix
    }
    return `${normalizedOutput.replace(/\n/g, '\r\n')}\r\n${promptPrefix}`
  }

  private async waitForSyntheticTaskOutputQuiescence(
    terminalId: string,
    taskId: string
  ): Promise<void> {
    const deadline = Date.now() + this.syntheticCommandMaxSyncWaitMs
    while (true) {
      const activeTaskId = this.activeTaskByTerminal.get(terminalId)
      const task = this.getTaskMap(terminalId)[taskId]
      if (!task || task.status !== 'running' || activeTaskId !== taskId) {
        return
      }

      const lastOutputAtMs = task.lastOutputAtMs || task.startTime
      if (Date.now() - lastOutputAtMs >= this.syntheticCommandQuietWindowMs) {
        return
      }
      if (Date.now() >= deadline) {
        // Protocol completion and the sidecar file are authoritative. Visual
        // output from an unrelated background writer must not keep the agent
        // command gate occupied forever.
        return
      }

      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  private processIncomingData(terminalId: string, rawChunk: string, writeSeq: number): string {
    let cleanedData = ''
    let protocol = this.commandStreamProtocolByTerminal.get(terminalId)
    if (!protocol) {
      protocol = new CommandStreamProtocol(
        this.commandProtocolTokenByTerminal.get(terminalId)
      )
      this.commandStreamProtocolByTerminal.set(terminalId, protocol)
    }

    for (const event of protocol.feed(rawChunk)) {
      if (event.type === 'text') {
        const syntheticTask = this.getActiveTask(terminalId)
        const displayRequestBoundRaw =
          syntheticTask?.displayMode === 'synthetic-transcript' &&
          syntheticTask.captureBoundaryState === 'capturing'
        // Zsh can redraw one submitted line through hundreds of cursor-control
        // fragments, and preexec hooks can themselves print that private line.
        // Nothing before the request-bound start marker is safe to project.
        const pendingUnixDisplay =
          this.pendingUnixCommandDisplayByTerminal.get(terminalId)
        const hideUnixDispatchEcho = pendingUnixDisplay !== undefined
        if (pendingUnixDisplay && !pendingUnixDisplay.privateEchoObserved) {
          pendingUnixDisplay.suppressedTextTail =
            (pendingUnixDisplay.suppressedTextTail + event.text).slice(
              -PRIVATE_UNIX_ECHO_SCAN_SIZE
            )
          pendingUnixDisplay.privateEchoObserved = this.containsPrivateUnixDisplay(
            pendingUnixDisplay.suppressedTextTail,
            pendingUnixDisplay
          ) || pendingUnixDisplay.suppressedTextTail.includes(
            UNIX_INTERACTIVE_SUBMISSION_BOUNDARY
          )
        } else if (pendingUnixDisplay) {
          pendingUnixDisplay.suppressedTextTail =
            (pendingUnixDisplay.suppressedTextTail + event.text).slice(
              -PRIVATE_UNIX_ECHO_SCAN_SIZE
            )
        }
        if (pendingUnixDisplay) {
          this.stagePendingUnixPostSubmitDisplay(pendingUnixDisplay, event.text)
        }
        const cleanedText = this.processTextControlMarkers(
          terminalId,
          event.text,
          writeSeq
        )
        if (
          !hideUnixDispatchEcho &&
          (syntheticTask?.displayMode !== 'synthetic-transcript' ||
            displayRequestBoundRaw)
        ) {
          cleanedData += cleanedText
        }
        if (displayRequestBoundRaw && cleanedText) {
          syntheticTask.syntheticRawDisplayObserved = true
          syntheticTask.syntheticRawDisplayEndsWithLineBreak =
            /[\r\n]$/.test(cleanedText)
        }
      } else if (event.type === 'marker') {
        const pendingUnixEchoTask = this.getActiveTask(terminalId)
        const pendingUnixDisplay =
          this.pendingUnixCommandDisplayByTerminal.get(terminalId)
        this.handleShellBoundaryMarker(terminalId, event.marker, writeSeq)
        if (!pendingUnixDisplay) {
          continue
        }
        const activeBoundary =
          this.activeShellBoundaryByTerminal.get(terminalId)
        const verifiedStart =
          event.marker.kind === 'preexec' &&
          !event.marker.legacy &&
          event.marker.sequence === pendingUnixDisplay.expectedSequence &&
          event.marker.nonce === pendingUnixDisplay.expectedNonce &&
          activeBoundary?.sequence === event.marker.sequence &&
          activeBoundary.nonce === event.marker.nonce
        const verifiedFallback =
          event.marker.kind === 'precmd' &&
          pendingUnixEchoTask?.id === pendingUnixDisplay.taskId &&
          pendingUnixEchoTask.status !== 'running' &&
          pendingUnixEchoTask.capture?.reason === 'tracking_unavailable'
        const pendingTask =
          this.getTaskMap(terminalId)[pendingUnixDisplay.taskId]
        const verifiedAbortedPrompt =
          event.marker.kind === 'precmd' &&
          !event.marker.legacy &&
          event.marker.sequence === pendingUnixDisplay.expectedSequence - 1 &&
          pendingUnixDisplay.privateEchoObserved &&
          pendingTask?.status === 'aborted' &&
          this.getActiveTask(terminalId) === undefined
        if (verifiedStart || verifiedFallback || verifiedAbortedPrompt) {
          this.pendingUnixCommandDisplayByTerminal.delete(terminalId)
          if (verifiedAbortedPrompt) {
            this.shellInputStateByTerminal.set(terminalId, 'idle')
            this.applyVerifiedShellMetadata(terminalId, event.marker)
          }
          cleanedData += verifiedFallback
            ? this.buildSyntheticUnixCommandEcho(
                pendingUnixDisplay.command,
                this.getTaskCapture(pendingUnixDisplay.taskId)?.getText() || ''
              )
            : this.buildSyntheticUnixCommandEcho(pendingUnixDisplay.command) +
              this.getSafePendingUnixPostSubmitDisplay(pendingUnixDisplay)
        }
      } else {
        const task = this.getActiveTask(terminalId)
        if (task?.captureBoundaryState === 'capturing') {
          this.getTaskCapture(task.id)?.markUnknown('tracking_lost')
          this.syncTaskCaptureMetadata(task)
        }
        this.shellInputStateByTerminal.set(terminalId, 'unknown')
      }
    }
    return cleanedData
  }

  private processTextControlMarkers(
    terminalId: string,
    chunk: string,
    _writeSeq: number
  ): string {
    // Windows completion is authenticated either by a runtime-token OSC
    // marker or by its out-of-band sidecar. Fixed printable marker text is
    // ordinary command output and must never change task or shell state.
    this.appendActiveTaskOutput(terminalId, chunk)
    return chunk
  }

  private decodeCommandProtocolPath(value: string | undefined): string | undefined {
    if (!value || value.length > 16 * 1024) return undefined
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
      return undefined
    }
    const unpadded = value.replace(/=+$/, '')
    try {
      const bytes = Buffer.from(value, 'base64')
      if (bytes.toString('base64').replace(/=+$/, '') !== unpadded) {
        return undefined
      }
      const decoded = bytes.toString('utf8')
      if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
        return undefined
      }
      return decoded
    } catch {
      return undefined
    }
  }

  private applyVerifiedShellMetadata(
    terminalId: string,
    marker: GyShellBoundaryMarker
  ): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return
    const cwd = this.decodeCommandProtocolPath(marker.cwdBase64)
    const homeDir = this.decodeCommandProtocolPath(marker.homeBase64)
    if (cwd === undefined && homeDir === undefined) return
    this.getBackend(terminal.type).applyCommandProtocolMetadata?.(
      terminal.ptyId,
      {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(homeDir !== undefined ? { homeDir } : {}),
      }
    )
  }

  private taskOwnsLatestTerminalInput(
    terminalId: string,
    task: CommandTask
  ): boolean {
    return (
      task.inputRevisionAtDispatch === undefined ||
      task.inputRevisionAtDispatch ===
        (this.terminalInputRevisionByTerminal.get(terminalId) || 0)
    )
  }

  private handleShellBoundaryMarker(
    terminalId: string,
    marker: GyShellBoundaryMarker,
    writeSeq: number
  ): void {
    const terminal = this.terminals.get(terminalId)
    const task = this.getActiveTask(terminalId)
    const boundaryMatches = (
      boundary: { sequence?: number; nonce?: string },
      candidate: GyShellBoundaryMarker
    ): boolean =>
      (boundary.sequence === undefined || candidate.sequence === boundary.sequence) &&
      (boundary.nonce === undefined || candidate.nonce === boundary.nonce)

    if (marker.kind === 'inputidle') {
      if (
        this.backendUsesPowerShellSidecar(terminal) &&
        this.commandProtocolTokenByTerminal.get(terminalId) !== undefined &&
        !marker.legacy &&
        marker.nonce === 'manual_input_drained' &&
        marker.sequence !== undefined &&
        marker.inputRevision !== undefined
      ) {
        this.noteWindowsPowerShellInputIdle(
          terminalId,
          marker.sequence,
          marker.inputRevision
        )
      }
      return
    }

    if (marker.kind === 'preexec') {
      if (this.usesPowerShellCommandLifecycle(terminal)) {
        const expectedRequestId = task?.completionTracking?.expectedRequestId
        const expectedSequence =
          task?.completionTracking?.baselineSequence !== undefined
            ? task.completionTracking.baselineSequence + 1
            : undefined
        if (
          task?.status === 'running' &&
          task.displayMode === 'synthetic-transcript' &&
          task.captureBoundaryState === 'awaiting-start' &&
          !marker.legacy &&
          expectedRequestId !== undefined &&
          marker.nonce === expectedRequestId &&
          (expectedSequence === undefined || marker.sequence === expectedSequence)
        ) {
          // The dispatcher echo is outside this request-bound pair. Replace
          // its staging transcript so even prompt/command-looking direct
          // console output inside the pair remains literal task evidence.
          this.unverifiedCaptureByTaskId.set(
            task.id,
            new CommandTranscriptCapture()
          )
          task.activeShellSequence = marker.sequence
          task.activeShellNonce = marker.nonce
          task.captureBoundaryState = 'capturing'
          this.syncTaskCaptureMetadata(task)
        }
        return
      }
      // Once a start boundary is open, further preexec-looking output belongs
      // to the running command and cannot replace the trusted pair.
      if (this.activeShellBoundaryByTerminal.has(terminalId)) {
        return
      }
      const previous = this.lastShellSequenceByTerminal.get(terminalId)
      if (
        previous !== undefined &&
        marker.sequence !== undefined &&
        marker.sequence !== previous + 1
      ) {
        this.shellInputStateByTerminal.set(terminalId, 'unknown')
        if (task?.status === 'running') {
          this.getTaskCapture(task.id)?.markUnknown('tracking_lost')
          this.syncTaskCaptureMetadata(task)
        }
        return
      }
      const boundary = {
        ...(marker.sequence !== undefined ? { sequence: marker.sequence } : {}),
        ...(marker.nonce ? { nonce: marker.nonce } : {}),
        legacy: marker.legacy,
        inputRevisionAtStart:
          this.terminalInputRevisionByTerminal.get(terminalId) || 0,
      }
      this.activeShellBoundaryByTerminal.set(terminalId, boundary)
      this.shellInputStateByTerminal.set(terminalId, 'busy')

      if (!task || task.status !== 'running' || task.captureBoundaryState !== 'awaiting-start') {
        return
      }
      if (
        task.expectedShellSequence !== undefined &&
        marker.sequence !== undefined &&
        marker.sequence !== task.expectedShellSequence
      ) {
        return
      }
      if (!marker.legacy && marker.sequence !== undefined && marker.nonce) {
        task.activeShellSequence = marker.sequence
        task.activeShellNonce = marker.nonce
      } else {
        task.activeShellSequence = marker.sequence
      }
      // Everything before the verified preexec marker is terminal echo or
      // shell-owned rendering, not command output.
      this.unverifiedCaptureByTaskId.delete(task.id)
      task.captureBoundaryState = 'capturing'
      this.syncTaskCaptureMetadata(task)
      return
    }

    if (marker.kind === 'preend') {
      if (
        task?.displayMode === 'synthetic-transcript'
      ) {
        if (
          task.status === 'running' &&
          task.captureBoundaryState === 'capturing' &&
          !marker.legacy &&
          marker.sequence === task.activeShellSequence &&
          marker.nonce === task.activeShellNonce &&
          marker.nonce === task.completionTracking?.expectedRequestId
        ) {
          this.unverifiedCaptureByTaskId.get(task.id)?.seal()
          task.captureBoundaryState = 'sealed'
          this.syncTaskCaptureMetadata(task)
        }
        return
      }
      const boundary = this.activeShellBoundaryByTerminal.get(terminalId)
      if (!boundary) {
        const previous = this.lastShellSequenceByTerminal.get(terminalId)
        const backend = terminal ? this.getBackend(terminal.type) : undefined
        const commandProtocolAvailable = terminal
          ? backend?.getCommandProtocolAvailability?.(terminal.ptyId)
          : undefined
        if (
          task?.status === 'running' &&
          task.captureBoundaryState === 'awaiting-start' &&
          commandProtocolAvailable === true &&
          this.commandProtocolTokenByTerminal.get(terminalId) !== undefined &&
          previous !== undefined &&
          marker.sequence === previous
        ) {
          // Bash can reject syntax before DEBUG/preexec runs. Its private
          // prompt-begin hook still closes the staging transcript here so
          // existing PROMPT_COMMAND output cannot masquerade as diagnostics.
          this.unverifiedCaptureByTaskId.get(task.id)?.seal()
        }
        return
      }
      if (!boundaryMatches(boundary, marker)) {
        return
      }
      if (!task || task.status !== 'running' || task.captureBoundaryState !== 'capturing') {
        return
      }
      const sequenceMatches =
        task.activeShellSequence === undefined ||
        marker.sequence === task.activeShellSequence
      const nonceMatches =
        task.activeShellNonce === undefined || marker.nonce === task.activeShellNonce
      if (sequenceMatches && nonceMatches) {
        // zsh renders PROMPT_EOL_MARK before its precmd hooks. Closing only the
        // capture gate here keeps that shell-owned rendering out of the
        // transcript; the matching precmd still supplies the authoritative
        // exit status and completes the task.
        task.captureBoundaryState = 'awaiting-end'
      }
      return
    }

    if (this.usesPowerShellCommandLifecycle(terminal)) {
      const previous = this.lastShellSequenceByTerminal.get(terminalId)
      const manualWatcher =
        this.windowsManualPromptWatcherByTerminal.get(terminalId)
      if (
        marker.sequence !== undefined &&
        this.backendUsesPowerShellSidecar(terminal)
      ) {
        const baseline = this.getWindowsPromptBaselineWithoutIo(
          terminalId,
          terminal!
        )
        if (baseline && marker.sequence >= baseline.baselineSequence) {
          this.rememberWindowsPromptBaseline(
            terminalId,
            baseline,
            marker.sequence
          )
          if (task?.status === 'running') {
            task.observedShellPromptSequence = marker.sequence
          }
        }
      }
      if (task?.status === 'running' && task.captureBoundaryState === 'unverified') {
        if (
          task.expectedShellSequence !== undefined &&
          marker.sequence !== undefined &&
          marker.sequence !== task.expectedShellSequence
        ) {
          return
        }
        if (marker.sequence !== undefined) {
          this.lastShellSequenceByTerminal.set(terminalId, marker.sequence)
        }
        // Stop the best-effort transcript at the runtime-namespaced end
        // marker. Prompt rendering may follow in the same PTY chunk and is
        // shell-owned rather than command output.
        task.captureBoundaryState = 'sealed'
        if (this.taskOwnsLatestTerminalInput(terminalId, task)) {
          this.shellInputStateByTerminal.set(terminalId, 'idle')
        }
        this.applyVerifiedShellMetadata(terminalId, marker)
        this.scheduleTaskFinishAfterHeadlessFlush(terminalId, marker.exitCode, writeSeq)
        return
      }
      if (
        !task &&
        (marker.sequence === undefined ||
          previous === undefined ||
          marker.sequence === previous ||
          marker.sequence === previous + 1)
      ) {
        const trackedState = this.shellInputStateByTerminal.get(terminalId)
        const advancesPrompt =
          previous !== undefined &&
          marker.sequence !== undefined &&
          marker.sequence === previous + 1
        if (marker.sequence !== undefined) {
          this.lastShellSequenceByTerminal.set(terminalId, marker.sequence)
        }
        // A first or duplicate prompt marker can have been generated before
        // already-delivered input was consumed. Only an advancing marker may
        // clear an explicitly busy/unknown Windows gate.
        if (
          !manualWatcher &&
          (trackedState === undefined ||
            trackedState === 'idle' ||
            advancesPrompt)
        ) {
          this.shellInputStateByTerminal.set(terminalId, 'idle')
        }
        this.applyVerifiedShellMetadata(terminalId, marker)
      }
      return
    }

    const boundary = this.activeShellBoundaryByTerminal.get(terminalId)
    if (!boundary) {
      const previous = this.lastShellSequenceByTerminal.get(terminalId)
      // Initial prompt and blank-line prompts have no paired preexec. They may
      // confirm idle state, but they must never advance the sequence.
      if (
        !task &&
        (marker.sequence === undefined ||
          previous === undefined ||
          marker.sequence === previous)
      ) {
        if (previous === undefined && marker.sequence !== undefined) {
          this.lastShellSequenceByTerminal.set(terminalId, marker.sequence)
        }
        this.shellInputStateByTerminal.set(terminalId, 'idle')
        this.applyVerifiedShellMetadata(terminalId, marker)
        return
      }

      const backend = terminal ? this.getBackend(terminal.type) : undefined
      const commandProtocolAvailable = terminal
        ? backend?.getCommandProtocolAvailability?.(terminal.ptyId)
        : undefined
      if (
        task?.status === 'running' &&
        task.captureBoundaryState === 'awaiting-start' &&
        commandProtocolAvailable === true &&
        this.commandProtocolTokenByTerminal.get(terminalId) !== undefined &&
        previous !== undefined &&
        marker.sequence === previous
      ) {
        // Bash syntax errors can return directly to PROMPT_COMMAND without a
        // DEBUG/preexec hook. The per-runtime namespace makes accidental
        // marker collisions unlikely; this same-sequence prompt confirms the
        // outcome, but without a start boundary capture remains unverified.
        if (this.taskOwnsLatestTerminalInput(terminalId, task)) {
          this.shellInputStateByTerminal.set(terminalId, 'idle')
        }
        this.applyVerifiedShellMetadata(terminalId, marker)
        this.promoteUnverifiedUnixCapture(terminalId, terminal, task)
        this.getTaskCapture(task.id)?.markUnknown('tracking_unavailable')
        this.syncTaskCaptureMetadata(task)
        this.scheduleTaskFinishAfterHeadlessFlush(terminalId, marker.exitCode, writeSeq)
      }
      return
    }
    if (!boundaryMatches(boundary, marker)) {
      return
    }

    this.activeShellBoundaryByTerminal.delete(terminalId)
    if (marker.sequence !== undefined) {
      this.lastShellSequenceByTerminal.set(terminalId, marker.sequence)
    }
    const boundaryOwnsLatestInput =
      boundary.inputRevisionAtStart ===
      (this.terminalInputRevisionByTerminal.get(terminalId) || 0)
    if (
      task
        ? this.taskOwnsLatestTerminalInput(terminalId, task)
        : boundaryOwnsLatestInput
    ) {
      this.shellInputStateByTerminal.set(terminalId, 'idle')
    }
    this.applyVerifiedShellMetadata(terminalId, marker)

    if (
      !task ||
      task.status !== 'running' ||
      (task.captureBoundaryState !== 'capturing' &&
        task.captureBoundaryState !== 'awaiting-end')
    ) {
      return
    }
    const sequenceMatches =
      task.activeShellSequence === undefined ||
      marker.sequence === task.activeShellSequence
    const nonceMatches =
      task.activeShellNonce === undefined ||
      marker.nonce === task.activeShellNonce
    if (!sequenceMatches || !nonceMatches) {
      return
    }

    task.captureBoundaryState = 'sealed'
    const capture = this.getTaskCapture(task.id)
    if (boundary.legacy || marker.legacy) {
      capture?.markUnknown('tracking_unavailable')
    }
    capture?.seal()
    this.syncTaskCaptureMetadata(task)
    this.scheduleTaskFinishAfterHeadlessFlush(terminalId, marker.exitCode, writeSeq)
  }

  private scheduleTaskFinishAfterHeadlessFlush(terminalId: string, exitCode: number | undefined, writeSeq: number): void {
    if (
      !this.usesPowerShellCommandLifecycle(
        this.terminals.get(terminalId)
      )
    ) {
      // Canonical Unix output is already sealed by the protocol parser. Human
      // screen rendering is independent and must not delay or weaken the
      // command outcome.
      this.finishActiveTask(terminalId, exitCode)
      return
    }
    const headless = this.headlessPtys.get(terminalId)
    if (!headless || writeSeq <= 0) {
      this.finishActiveTask(terminalId, exitCode)
      return
    }

    const flushedSeq = this.headlessFlushedSeqByTerminal.get(terminalId) || 0
    if (flushedSeq >= writeSeq) {
      this.finishActiveTask(terminalId, exitCode)
      return
    }

    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) {
      return
    }
    this.pendingTaskFinishByTerminal.set(terminalId, {
      taskId,
      runtimeGeneration:
        this.backendRuntimeGenerationByTerminal.get(terminalId),
      requiredWriteSeq: writeSeq,
      exitCode
    })
  }

  private tryFlushPendingTaskFinish(terminalId: string): void {
    const pending = this.pendingTaskFinishByTerminal.get(terminalId)
    if (!pending) return
    if (
      this.activeTaskByTerminal.get(terminalId) !== pending.taskId ||
      this.backendRuntimeGenerationByTerminal.get(terminalId) !==
        pending.runtimeGeneration
    ) {
      this.pendingTaskFinishByTerminal.delete(terminalId)
      return
    }
    const flushedSeq = this.headlessFlushedSeqByTerminal.get(terminalId) || 0
    if (flushedSeq < pending.requiredWriteSeq) return
    this.pendingTaskFinishByTerminal.delete(terminalId)
    this.finishActiveTask(terminalId, pending.exitCode)
  }

  private flushCommandProtocolOnRuntimeExit(terminalId: string): void {
    const protocol = this.commandStreamProtocolByTerminal.get(terminalId)
    if (protocol) {
      for (const event of protocol.end()) {
        if (event.type === 'text') {
          this.processTextControlMarkers(terminalId, event.text, 0)
        } else if (event.type === 'malformed-marker') {
          const task = this.getActiveTask(terminalId)
          if (task) {
            this.getTaskCapture(task.id)?.markUnknown('tracking_lost')
            this.syncTaskCaptureMetadata(task)
          }
        }
      }
    }

  }

  private async replayIntoHeadlessTerminal(
    terminal: TerminalType,
    content: string
  ): Promise<void> {
    let offset = 0
    while (offset < content.length) {
      let end = Math.min(
        content.length,
        offset + TERMINAL_HEADLESS_REPLAY_CHUNK_SIZE
      )
      if (
        end < content.length &&
        end > offset &&
        content.charCodeAt(end - 1) >= 0xd800 &&
        content.charCodeAt(end - 1) <= 0xdbff &&
        content.charCodeAt(end) >= 0xdc00 &&
        content.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1
      }
      const chunk = content.slice(offset, end)
      await new Promise<void>((resolve, reject) => {
        try {
          terminal.write(chunk, resolve)
        } catch (error) {
          reject(error)
        }
      })
      offset = end
    }
  }

  private async rebuildHeadlessAfterOutputFailure(
    terminalId: string,
    failedGeneration: number | undefined,
    retiringHeadless: TerminalType | undefined
  ): Promise<void> {
    if (
      !Number.isSafeInteger(failedGeneration) ||
      this.terminalOutputFailureGenerationByTerminal.get(terminalId) !==
        failedGeneration
    ) {
      return
    }

    const expectedTab = this.terminals.get(terminalId)
    if (!expectedTab || this.headlessPtys.get(terminalId) !== retiringHeadless) {
      return
    }

    const createFreshHeadless = (): TerminalType =>
      new Terminal({
        cols: expectedTab.cols,
        rows: expectedTab.rows,
        scrollback: SCROLLBACK_SIZE,
        allowProposedApi: true
      })
    let replacement = createFreshHeadless()
    try {
      const retainedDisplay = this.buffers.get(terminalId)?.content || ''
      await this.replayIntoHeadlessTerminal(replacement, retainedDisplay)
    } catch (error) {
      console.error(
        `[TerminalService] Failed to replay retained output while rebuilding headless terminal ${terminalId}; installing an empty parser instead.`,
        error
      )
      replacement.dispose()
      replacement = createFreshHeadless()
      try {
        await this.replayIntoHeadlessTerminal(
          replacement,
          '\r\nTerminal display recovery could not replay the retained buffer; future output will continue in a fresh parser.\r\n'
        )
      } catch {
        replacement.dispose()
        replacement = createFreshHeadless()
      }
    }

    if (
      this.terminals.get(terminalId) !== expectedTab ||
      this.headlessPtys.get(terminalId) !== retiringHeadless ||
      this.terminalOutputFailureGenerationByTerminal.get(terminalId) !==
        failedGeneration
    ) {
      replacement.dispose()
      return
    }

    replacement.resize(expectedTab.cols, expectedTab.rows)
    this.headlessPtys.set(terminalId, replacement)
    retiringHeadless?.dispose()
  }

  private handleExit(terminalId: string, code: number): void {
    // A command still preparing against this runtime must not block a
    // replacement runtime that reuses the same terminal id. Its generation
    // check will prevent any late dispatch.
    this.cancelCommandStartReservation(terminalId)
    const retiringOutputController =
      this.outputFlowControllerByTerminal.get(terminalId)
    const retiringRuntimeGeneration =
      retiringOutputController?.runtimeGeneration ??
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const retiringHeadless = this.headlessPtys.get(terminalId)
    const controllerDrain = retiringOutputController
      ? retiringOutputController
          .waitForDrain(TERMINAL_OUTPUT_RETIRE_TIMEOUT_MS)
          .then((drained) => {
            if (!drained) {
              console.warn(
                `[TerminalService] Final terminal output did not drain cleanly for ${terminalId}; continuing with bounded recovery.`
              )
            }
            if (
              this.outputFlowControllerByTerminal.get(terminalId) ===
              retiringOutputController
            ) {
              retiringOutputController.dispose()
              this.outputFlowControllerByTerminal.delete(terminalId)
            }
          })
      : Promise.resolve()
    const outputDrain = controllerDrain
      .then(() =>
        this.rebuildHeadlessAfterOutputFailure(
          terminalId,
          retiringRuntimeGeneration,
          retiringHeadless
        )
      )
      .catch((error) => {
        // Runtime replacement must never be stranded by recovery diagnostics.
        console.error(
          `[TerminalService] Failed while retiring terminal output for ${terminalId}.`,
          error
        )
      })
    this.retiringOutputDrainByTerminal.set(terminalId, outputDrain)
    void outputDrain.finally(() => {
      if (this.retiringOutputDrainByTerminal.get(terminalId) === outputDrain) {
        this.retiringOutputDrainByTerminal.delete(terminalId)
      }
    })
    const tab = this.terminals.get(terminalId)
    this.flushCommandProtocolOnRuntimeExit(terminalId)
    
    // Mark active task as aborted if terminal exits unexpectedly. A nowait
    // caller relies on its completion callback to retire the background
    // record, so terminal exit must settle that callback exactly once with an
    // explicit runtime boundary instead of silently deleting it.
    const activeTaskId = this.activeTaskByTerminal.get(terminalId)
    if (activeTaskId) {
      const task = this.getTaskMap(terminalId)[activeTaskId]
      const callback = this.onTaskFinishedCallbacks.get(activeTaskId)
      this.onTaskFinishedCallbacks.delete(activeTaskId)
      let exitResult: CommandResult | null = null
      if (task && (task.status === 'running' || task.status === 'timeout')) {
        this.finalizeTaskCapture(terminalId, task, tab, {
          runtimeBoundary: true,
        })
        task.output = this.getTaskCapture(task.id)?.getText() ?? ''
        task.status = 'aborted'
        task.endTime = Date.now()
        task.exitCode = typeof code === 'number' ? code : -1
        task.runtimeBoundary = true
        task.terminalStatus = 'Terminal exited before command completion.'
        task.endOffset = task.startOffset + task.output.length
        if (!task.suppressFinishCallback) {
          exitResult = {
            stdoutDelta: task.output,
            exitCode: task.exitCode,
            history_command_match_id: activeTaskId,
            executionState: 'outcome_unknown',
            ...(task.capture ? { capture: { ...task.capture } } : {}),
            terminalStatus: task.terminalStatus,
            runtimeBoundary: true
          }
        }
      }
      this.stopCommandTrackingWatcher(activeTaskId)
      this.activeTaskByTerminal.delete(terminalId)
      this.deferredWritesUntilTaskFinishByTaskId.delete(activeTaskId)
      if (callback && exitResult) {
        try {
          callback(exitResult)
        } catch (error) {
          // Runtime cleanup must continue even if a consumer callback fails.
          console.warn(
            `[TerminalService] Command completion callback failed during terminal exit for ${terminalId}.`,
            error
          )
        }
      }
      if (task && task.status !== 'running') {
        this.compactFinalizedTask(task)
      }
      this.enforceCommandCaptureRetention()
    }
    this.terminalInputSequenceTailByTerminal.delete(terminalId)
    this.pendingUnixCommandDisplayByTerminal.delete(terminalId)
    this.clearWindowsPromptRuntimeState(terminalId)
    this.pendingTaskFinishByTerminal.delete(terminalId)
    this.unverifiedCaptureByTaskId.delete(activeTaskId || '')
    this.pendingResizeByTerminal.delete(terminalId)
    this.headlessWriteSeqByTerminal.delete(terminalId)
    this.headlessFlushedSeqByTerminal.delete(terminalId)
    this.commandStreamProtocolByTerminal.delete(terminalId)
    this.commandProtocolTokenByTerminal.delete(terminalId)
    this.shellInputStateByTerminal.delete(terminalId)
    this.lastShellSequenceByTerminal.delete(terminalId)
    this.activeShellBoundaryByTerminal.delete(terminalId)

    // UI lifecycle is user-driven. Do not auto-remove tab metadata on backend exit.
    // We only update runtime state and keep captured output until user closes the tab.
    if (tab) {
      if (
        tab.type === 'local' &&
        tab.runtimeState !== 'exited' &&
        !this.terminalIdsBeingKilled.has(terminalId)
      ) {
        void this.restartLocalTerminalAfterExit(
          terminalId,
          code,
          outputDrain
        )
        return
      }
      tab.isInitializing = false
      tab.runtimeState = 'exited'
      tab.lastExitCode = typeof code === 'number' ? code : -1
      const config = this.terminalConfigs.get(terminalId)
      if (config) {
        this.terminalConfigs.set(terminalId, {
          ...config,
          title: tab.title,
          cols: tab.cols,
          rows: tab.rows
        } as TerminalConfig)
      }
    }
    
    this.sendToRenderer('terminal:exit', { terminalId, code })
    this.publishTerminalTabsChanged()
    this.schedulePersistTerminalState()
  }

  private handleTerminalOutputFailure(
    terminalId: string,
    terminalType: ConnectionType,
    ptyId: string,
    runtimeGeneration: number,
    error: Error
  ): void {
    if (
      this.backendRuntimeGenerationByTerminal.get(terminalId) !==
      runtimeGeneration
    ) {
      return
    }
    if (
      this.terminalOutputFailureGenerationByTerminal.get(terminalId) ===
      runtimeGeneration
    ) {
      return
    }
    this.terminalOutputFailureGenerationByTerminal.set(
      terminalId,
      runtimeGeneration
    )
    console.error(
      `[TerminalService] Terminal output flow failed for ${terminalId}; stopping runtime to preserve headless/visible consistency.`,
      error
    )
    const message =
      '\r\n\x1b[31m✘ Terminal output parser failed and this runtime was stopped to prevent data loss. Reconnect the terminal to continue.\x1b[0m\r\n'
    const buffer = this.buffers.get(terminalId)
    let offset = 0
    if (buffer) {
      buffer.content += message
      buffer.offset += message.length
      offset = buffer.offset
      if (buffer.content.length > MAX_BUFFER_SIZE) {
        buffer.content = buffer.content.slice(-MAX_BUFFER_SIZE)
      }
    }
    this.sendToRenderer('terminal:data', {
      terminalId,
      data: message,
      offset,
      ...this.getRenderMetadata(terminalId)
    })
    try {
      this.getBackend(terminalType).kill(ptyId)
    } catch (killError) {
      console.error(
        `[TerminalService] Failed to stop output-corrupted runtime ${terminalId}:`,
        killError
      )
      this.handleExit(terminalId, -1)
    }
  }

  private canWriteToTerminal(terminal: TerminalTab): boolean {
    return terminal.runtimeState === 'ready'
  }

  private canUseFilesystemForTerminal(terminal: TerminalTab): boolean {
    if (terminal.capabilities?.supportsFilesystem !== true) {
      return false
    }
    if (terminal.type === 'local') {
      return terminal.runtimeState !== 'exited'
    }
    return terminal.runtimeState === 'ready'
  }

  private queueWriteAfterPromptFileIo(
    terminalId: string,
    terminal: TerminalTab,
    data: string,
    options?: {
      signal?: AbortSignal
      rejectOnRuntimeChange?: boolean
      inputOwner?: 'active-task'
    }
  ): Promise<void> | undefined {
    const runtimePtyId = terminal.ptyId
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const promptFileIoKey = this.getPromptFileIoKey(
      terminalId,
      runtimeGeneration
    )
    if (!this.promptFileIoTailByTerminal.has(promptFileIoKey)) {
      return undefined
    }

    const promptFileIo = this.reservePromptFileIo(
      terminalId,
      undefined,
      runtimeGeneration
    )
    return (async () => {
      try {
        await waitForPromiseOrAbort(promptFileIo.waitForTurn, options?.signal)
        throwIfTerminalOperationAborted(options?.signal)
        const currentTerminal = this.terminals.get(terminalId)
        if (
          currentTerminal !== terminal ||
          currentTerminal.ptyId !== runtimePtyId ||
          !this.canWriteToTerminal(currentTerminal) ||
          this.backendRuntimeGenerationByTerminal.get(terminalId) !==
            runtimeGeneration
        ) {
          if (options?.rejectOnRuntimeChange) {
            throw new Error(
              `Terminal ${terminalId} changed while input was waiting for prompt-file io.`
            )
          }
          return
        }
        const backend = this.getBackend(currentTerminal.type)
        this.deliverTerminalInput(terminalId, backend, runtimePtyId, data, {
          inputOwner: options?.inputOwner,
        })
      } finally {
        promptFileIo.release()
      }
    })()
  }

  write(terminalId: string, data: string): void {
    if (this.commandStartReservationByTerminal.has(terminalId)) {
      const deferred =
        this.deferredWritesDuringCommandStartByTerminal.get(terminalId) || []
      deferred.push(data)
      this.deferredWritesDuringCommandStartByTerminal.set(terminalId, deferred)
      return
    }
    const terminal = this.terminals.get(terminalId)
    if (terminal && this.canWriteToTerminal(terminal)) {
      const requiresOrderedWindowsPromptTracking =
        this.canObserveManualPowerShellPrompt(terminalId, terminal) &&
        this.getBackend(terminal.type).getCommandProtocolAvailability?.(
          terminal.ptyId
        ) === true &&
        (/[\r\n\x03]/.test(data) ||
          this.terminalInputSequenceTailByTerminal.has(terminalId))
      if (requiresOrderedWindowsPromptTracking) {
        void this.writeInputSequence(terminalId, [data]).catch((error) => {
          console.warn(
            `[TerminalService] Failed to write tracked Windows input for ${terminalId}.`,
            error
          )
        })
        return
      }
      const queuedWrite = this.queueWriteAfterPromptFileIo(
        terminalId,
        terminal,
        data
      )
      if (queuedWrite) {
        void queuedWrite.catch((error) => {
          console.warn(
            `[TerminalService] Failed to write input after prompt-file io settled for ${terminalId}.`,
            error
          )
        })
        return
      }
      const backend = this.getBackend(terminal.type)
      this.deliverTerminalInput(terminalId, backend, terminal.ptyId, data)
    }
  }

  private deliverTerminalInput(
    terminalId: string,
    backend: TerminalBackend,
    ptyId: string,
    data: string,
    options?: { inputOwner?: 'active-task' }
  ): void {
    if (!data) {
      backend.write(ptyId, data)
      return
    }
    const hadPreviousState = this.shellInputStateByTerminal.has(terminalId)
    const previousState = this.shellInputStateByTerminal.get(terminalId)
    const activeTask = this.getActiveTask(terminalId)
    const inputBelongsToActiveTask =
      options?.inputOwner === 'active-task' &&
      activeTask?.status === 'running' &&
      activeTask.observedShellPromptSequence === undefined
    // Treat the state transition and backend write as one transaction. Marking
    // first prevents a synchronously delivered prompt marker from being
    // overwritten; a rejected write restores the exact previous gate state.
    this.shellInputStateByTerminal.set(terminalId, 'busy')
    try {
      backend.write(ptyId, data)
      const inputRevision =
        (this.terminalInputRevisionByTerminal.get(terminalId) || 0) + 1
      this.terminalInputRevisionByTerminal.set(
        terminalId,
        inputRevision
      )
      if (inputBelongsToActiveTask && activeTask?.status === 'running') {
        activeTask.inputRevisionAtDispatch = inputRevision
      }
    } catch (error) {
      if (hadPreviousState && previousState) {
        this.shellInputStateByTerminal.set(terminalId, previousState)
      } else {
        this.shellInputStateByTerminal.delete(terminalId)
      }
      throw error
    }
  }

  async writeInputSequence(
    terminalId: string,
    sequence: readonly string[],
    options?: TerminalInputSequenceOptions
  ): Promise<void> {
    if (sequence.length === 0) {
      throwIfTerminalOperationAborted(options?.signal)
      return
    }

    // Bind queued input to the runtime that accepted it. A predecessor may
    // outlive an exit/reconnect, and stale input must never spill into the
    // replacement shell when that predecessor releases the queue.
    const terminal = this.terminals.get(terminalId)
    if (!terminal || !this.canWriteToTerminal(terminal)) {
      throw new Error(`Terminal ${terminalId} is not available for input.`)
    }
    const inputReservation = Symbol(terminalId)
    const inputReservations =
      this.pendingInputReservationsByTerminal.get(terminalId) || new Set<symbol>()
    inputReservations.add(inputReservation)
    this.pendingInputReservationsByTerminal.set(terminalId, inputReservations)
    const runtimePtyId = terminal.ptyId
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const startupReservation =
      this.commandStartReservationByTerminal.get(terminalId)

    const predecessor =
      this.terminalInputSequenceTailByTerminal.get(terminalId) ??
      Promise.resolve()
    let releaseTurn: () => void = () => {}
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const queuedTail = predecessor.then(() => turn)
    this.terminalInputSequenceTailByTerminal.set(terminalId, queuedTail)

    try {
      await waitForPromiseOrAbort(predecessor, options?.signal)
      if (startupReservation) {
        await waitForPromiseOrAbort(
          startupReservation.waitForRelease,
          options?.signal
        )
        const startedTaskId = startupReservation.startedTaskId
        if (startedTaskId) {
          while (this.activeTaskByTerminal.get(terminalId) === startedTaskId) {
            throwIfTerminalOperationAborted(options?.signal)
            if (
              !this.isCurrentTerminalRuntime(
                terminalId,
                runtimePtyId,
                runtimeGeneration
              )
            ) {
              throw new Error(
                `Terminal ${terminalId} changed while input was deferred behind command startup.`
              )
            }
            await waitForTerminalDelay(10, options?.signal)
          }
          const startedTask = this.tasksByTerminal.get(terminalId)?.[startedTaskId]
          if (
            !startedTask ||
            startedTask.status !== 'finished' ||
            startedTask.runtimeBoundary === true
          ) {
            throw new Error(
              `Input deferred behind command ${startedTaskId} was not sent because its terminal outcome is unknown.`
            )
          }
        }
      }

      if (
        !this.isCurrentTerminalRuntime(
          terminalId,
          runtimePtyId,
          runtimeGeneration
        )
      ) {
        throw new Error(
          `Terminal ${terminalId} changed while the input sequence was waiting to start.`
        )
      }
      const shouldObserveManualWindowsPrompt =
        this.canObserveManualPowerShellPrompt(terminalId, terminal)
      // Human input is the in-band event that can produce the next prompt.
      // Never wait for out-of-band baseline I/O before delivering it.
      const manualTrackingToken = shouldObserveManualWindowsPrompt
        ? this.getWindowsPromptBaselineWithoutIo(terminalId, terminal)
        : undefined
      const observePromptAfterInput = (index: number): void => {
        const input = sequence[index]
        // This scanner is stateful across xterm writes (notably bracketed
        // paste), so advance it only after the input was actually delivered.
        const submissionCount = this.countWindowsPromptSubmissions(
          terminalId,
          input
        )
        if (
          !manualTrackingToken ||
          submissionCount === 0 ||
          !this.isCurrentTerminalRuntime(
            terminalId,
            runtimePtyId,
            runtimeGeneration
          )
        ) {
          return
        }
        const expectedInputRevision =
          this.terminalInputRevisionByTerminal.get(terminalId) || 0
        const backend = this.getBackend(terminal.type)
        if (!backend.commitPowerShellInputRevision) {
          return
        }
        const minimumPromptSequence = this.startWindowsManualPromptWatcher(
          terminal,
          {
            ...manualTrackingToken,
            dispatchedAtMs: Date.now(),
          },
          expectedInputRevision,
          inputReservation,
          {
            // If a later planned item is aborted, this submitted item may be
            // the sequence's actual last interaction. Its verified idle must
            // therefore remain eligible to restore the gate. A later write
            // replaces the watcher before the reservation is released.
            restoreIdleOnCompletion: /[\r\n\x03]$/.test(input),
          }
        )
        this.commitWindowsPowerShellInputRevision(
          terminal,
          backend,
          expectedInputRevision,
          minimumPromptSequence
        )
      }
      throwIfTerminalOperationAborted(options?.signal)
      const requestedIntervalMs = options?.intervalMs ?? 0
      const intervalMs =
        Number.isFinite(requestedIntervalMs) && requestedIntervalMs > 0
          ? Math.floor(requestedIntervalMs)
          : 0

      for (let index = 0; index < sequence.length; index += 1) {
        while (true) {
          throwIfTerminalOperationAborted(options?.signal)
          const currentTerminal = this.terminals.get(terminalId)
          if (
            currentTerminal !== terminal ||
            currentTerminal?.ptyId !== runtimePtyId ||
            !this.canWriteToTerminal(terminal) ||
            this.backendRuntimeGenerationByTerminal.get(terminalId) !==
              runtimeGeneration
          ) {
            throw new Error(
              `Terminal ${terminalId} changed while the input sequence was being written.`
            )
          }
          const commandStartReservation =
            this.commandStartReservationByTerminal.get(terminalId)
          if (commandStartReservation) {
            await waitForPromiseOrAbort(
              commandStartReservation.waitForRelease,
              options?.signal
            )
            continue
          }
          const queuedWrite = this.queueWriteAfterPromptFileIo(
            terminalId,
            currentTerminal,
            sequence[index],
            {
              signal: options?.signal,
              rejectOnRuntimeChange: true,
              inputOwner: options?.inputOwner,
            }
          )
          if (queuedWrite) {
            await queuedWrite
          } else {
            const backend = this.getBackend(currentTerminal.type)
            this.deliverTerminalInput(
              terminalId,
              backend,
              runtimePtyId,
              sequence[index],
              { inputOwner: options?.inputOwner }
            )
          }
          break
        }
        observePromptAfterInput(index)
        if (index < sequence.length - 1 && intervalMs > 0) {
          await waitForTerminalDelay(intervalMs, options?.signal)
        }
      }
    } finally {
      inputReservations.delete(inputReservation)
      if (
        this.pendingInputReservationsByTerminal.get(terminalId) ===
          inputReservations &&
        inputReservations.size === 0
      ) {
        this.pendingInputReservationsByTerminal.delete(terminalId)
      }
      this.tryCompleteWindowsManualPromptWatcher(terminalId)
      releaseTurn()
      void queuedTail.then(() => {
        if (
          this.terminalInputSequenceTailByTerminal.get(terminalId) ===
          queuedTail
        ) {
          this.terminalInputSequenceTailByTerminal.delete(terminalId)
        }
      })
    }
  }

  writePaths(terminalId: string, paths: string[]): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal || paths.length === 0) return
    const text = escapeShellPathList(paths)
    if (!text) return
    this.write(terminalId, text)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const size = normalizeTerminalResizeTarget(cols, rows)
    if (!size) return

    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      this.pendingResizeByTerminal.set(terminalId, size)
      return
    }

    terminal.cols = size.cols
    terminal.rows = size.rows
    const config = this.terminalConfigs.get(terminalId)
    if (config) {
      this.terminalConfigs.set(terminalId, {
        ...config,
        cols: size.cols,
        rows: size.rows
      } as TerminalConfig)
    }
    const backend = this.getBackend(terminal.type)
    backend.resize(terminal.ptyId, size.cols, size.rows)

    const headless = this.headlessPtys.get(terminalId)
    if (headless) {
      headless.resize(size.cols, size.rows)
    }
  }

  kill(terminalId: string): void {
    this.pendingResizeByTerminal.delete(terminalId)
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      const backend = this.getBackend(terminal.type)
      const activeTaskId = this.activeTaskByTerminal.get(terminalId)
      const activeTask = activeTaskId
        ? this.getTaskMap(terminalId)[activeTaskId]
        : undefined
      const activeTaskCallback = activeTaskId
        ? this.onTaskFinishedCallbacks.get(activeTaskId)
        : undefined
      if (activeTaskId) {
        this.onTaskFinishedCallbacks.delete(activeTaskId)
      }
      this.terminalIdsBeingKilled.add(terminalId)
      try {
        backend.kill(terminal.ptyId)
      } catch (error) {
        if (
          activeTaskId &&
          activeTaskCallback &&
          this.activeTaskByTerminal.get(terminalId) === activeTaskId
        ) {
          this.onTaskFinishedCallbacks.set(activeTaskId, activeTaskCallback)
        }
        throw error
      } finally {
        this.terminalIdsBeingKilled.delete(terminalId)
      }

      this.outputFlowControllerByTerminal.get(terminalId)?.dispose()
      this.outputFlowControllerByTerminal.delete(terminalId)
      // Visible consumers belong to the retained renderer runtime, not to one
      // backend process. Renderer detach/webContents teardown removes them;
      // keeping the registry here lets a quickly reused terminal id attach its
      // replacement controller to the same visible xterm.
      this.terminalOutputFailureGenerationByTerminal.delete(terminalId)
      
      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.dispose()
        this.headlessPtys.delete(terminalId)
      }

      // Thoroughly clean up live runtime and UI state for this terminal.
      this.terminals.delete(terminalId)
      this.buffers.delete(terminalId)
      this.selectionByTerminal.delete(terminalId)
      this.commandStreamProtocolByTerminal.delete(terminalId)
      this.pendingUnixCommandDisplayByTerminal.delete(terminalId)
      this.commandProtocolTokenByTerminal.delete(terminalId)
      this.shellInputStateByTerminal.delete(terminalId)
      this.lastShellSequenceByTerminal.delete(terminalId)
      this.activeShellBoundaryByTerminal.delete(terminalId)
      this.backendRuntimeGenerationByTerminal.delete(terminalId)
      this.clearWindowsPromptRuntimeState(terminalId)
      if (activeTaskId) {
        if (activeTask && activeTask.status !== 'finished') {
          this.finalizeTaskCapture(terminalId, activeTask, terminal, {
            runtimeBoundary: true,
          })
          activeTask.output = this.getTaskCapture(activeTask.id)?.getText() ?? ''
          activeTask.status = 'aborted'
          activeTask.endTime = Date.now()
          activeTask.exitCode = -2
          activeTask.runtimeBoundary = true
          activeTask.terminalStatus = 'Terminal tab was closed before command completion.'
          activeTask.endOffset =
            activeTask.startOffset + (activeTask.output?.length || 0)
        }
        this.stopCommandTrackingWatcher(activeTaskId)
      }
      this.activeTaskByTerminal.delete(terminalId)
      this.cancelCommandStartReservation(terminalId)
      this.terminalInputSequenceTailByTerminal.delete(terminalId)
      const activeTaskCloseResult: CommandResult | undefined = activeTaskId
        ? {
            stdoutDelta: activeTask?.output || '',
            exitCode: -2,
            history_command_match_id: activeTaskId,
            executionState: 'outcome_unknown',
            ...(activeTask?.capture ? { capture: { ...activeTask.capture } } : {}),
            ...(activeTask?.terminalStatus
              ? { terminalStatus: activeTask.terminalStatus }
              : {}),
            runtimeBoundary: true
          }
        : undefined
      // Command history outlives the visual tab for the rest of this process,
      // but it must not become the execution namespace of a later tab that
      // reuses the same public id. Move it into a read-only detached store.
      // The aggregate capture budget below still evicts old bytes into
      // explicit record_expired tombstones.
      const closedTasks = this.tasksByTerminal.get(terminalId) || {}
      const closedTaskIds = Object.keys(closedTasks)
      if (closedTaskIds.length > 0) {
        this.detachedTasksByTerminal.set(terminalId, {
          ...(this.detachedTasksByTerminal.get(terminalId) || {}),
          ...closedTasks,
        })
      }
      this.tasksByTerminal.delete(terminalId)
      for (const taskId of closedTaskIds) {
        this.unverifiedCaptureByTaskId.delete(taskId)
        this.deferredWritesUntilTaskFinishByTaskId.delete(taskId)
      }
      this.headlessWriteSeqByTerminal.delete(terminalId)
      this.headlessFlushedSeqByTerminal.delete(terminalId)
      this.pendingTaskFinishByTerminal.delete(terminalId)
      this.terminalConfigs.delete(terminalId)
      if (this.primaryLocalTerminalId === terminalId) {
        const nextLocal = Array.from(this.terminals.values()).find((item) => item.type === 'local')
        this.primaryLocalTerminalId = nextLocal?.id || null
      }
      this.notifyTerminalClosed(terminalId)
      if (
        activeTaskCloseResult &&
        activeTaskCallback &&
        activeTask?.suppressFinishCallback !== true
      ) {
        try {
          activeTaskCallback(activeTaskCloseResult)
        } catch (error) {
          console.warn(
            `[TerminalService] terminal close task callback failed for ${terminalId}:`,
            error
          )
        }
      }
      for (const task of Object.values(closedTasks)) {
        this.compactFinalizedTask(task)
      }
      this.enforceCommandCaptureRetention()
    }
    this.publishTerminalTabsChanged()
    this.schedulePersistTerminalState()
  }

  private notifyTerminalClosed(terminalId: string): void {
    for (const listener of this.terminalClosedListeners) {
      try {
        listener(terminalId)
      } catch (error) {
        console.warn(`[TerminalService] terminal close listener failed for ${terminalId}:`, error)
      }
    }
  }

  interrupt(terminalId: string): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return
    const backend = this.getBackend(terminal.type)
    // Send Ctrl+C to interrupt current foreground command.
    backend.write(terminal.ptyId, '\x03')
  }

  getCwd(terminalId: string): string | undefined {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return undefined
    const backend = this.getBackend(terminal.type)
    return backend.getCwd(terminal.ptyId)
  }

  async getHomeDir(terminalId: string): Promise<string | undefined> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return undefined
    const backend = this.getBackend(terminal.type)
    return backend.getHomeDir(terminal.ptyId)
  }

  getRemoteOs(terminalId: string): 'unix' | 'windows' | undefined {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return undefined
    if (terminal.remoteOs) return terminal.remoteOs
    const backend = this.getBackend(terminal.type)
    const osType = backend.getRemoteOs(terminal.ptyId)
    if (osType) {
      terminal.remoteOs = osType
    }
    return osType
  }

  getTerminalType(terminalId: string): TerminalConfig['type'] {
    const terminal = this.getTerminalOrThrow(terminalId)
    return terminal.type
  }

  private getSshConnectionIdentity(
    terminalId: string,
    options: { includeUsername: boolean }
  ): string | null {
    const config = this.terminalConfigs.get(terminalId)
    if (!config || !isSshConnectionConfig(config)) {
      return null
    }
    const host = String(config.host || '').trim().toLowerCase()
    if (!host) {
      return null
    }
    const port = Number.isFinite(config.port) && config.port > 0 ? Math.floor(config.port) : 22
    if (!options.includeUsername) {
      return `ssh://${host}:${port}`
    }
    const username = String(config.username || '').trim().toLowerCase()
    return `ssh://${username}@${host}:${port}`
  }

  getFileSystemIdentity(terminalId: string): string | null {
    const terminal = this.getTerminalOrThrow(terminalId)
    if (!terminal.capabilities.supportsFilesystem) {
      return null
    }
    if (terminal.type === 'local') {
      return 'local://default'
    }
    return this.getSshConnectionIdentity(terminalId, { includeUsername: true })
  }

  getMonitorIdentity(terminalId: string): string | null {
    const terminal = this.getTerminalOrThrow(terminalId)
    if (!terminal.capabilities.supportsMonitor) {
      return null
    }
    if (terminal.type === 'local') {
      return 'local://default'
    }
    return this.getSshConnectionIdentity(terminalId, { includeUsername: true })
  }

  async resolvePathForFileSystem(terminalId: string, filePath: string): Promise<string> {
    this.getTerminalOrThrow(terminalId)
    return await this.resolvePath(terminalId, filePath)
  }

  private getTerminalOrThrow(terminalId: string): TerminalTab {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    return terminal
  }

  async readFile(terminalId: string, filePath: string): Promise<Buffer> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getFileSystemBackend(terminal)
    return backend.readFile(terminal.ptyId, resolvedPath)
  }

  async readFileChunk(
    terminalId: string,
    filePath: string,
    offset: number,
    chunkSize: number,
    options?: { totalSizeHint?: number }
  ): Promise<{ chunk: Buffer; bytesRead: number; totalSize: number; nextOffset: number; eof: boolean }> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getFileSystemBackend(terminal)
    return await backend.readFileChunk(terminal.ptyId, resolvedPath, offset, chunkSize, options)
  }

  async writeFile(terminalId: string, filePath: string, content: string): Promise<void> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getFileSystemBackend(terminal)
    return backend.writeFile(terminal.ptyId, resolvedPath, content)
  }

  async writeFileChunk(
    terminalId: string,
    filePath: string,
    offset: number,
    content: Buffer,
    options?: { truncate?: boolean; close?: boolean }
  ): Promise<{ writtenBytes: number; nextOffset: number }> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getFileSystemBackend(terminal)
    return await backend.writeFileChunk(terminal.ptyId, resolvedPath, offset, content, options)
  }

  async downloadFileToLocalPath(
    terminalId: string,
    sourcePath: string,
    targetLocalPath: string,
    options?: {
      onProgress?: (progress: { bytesTransferred: number; totalBytes: number; eof: boolean }) => void
      signal?: AbortSignal
    }
  ): Promise<{ totalBytes: number } | null> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, sourcePath)
    const backend = this.getFileSystemBackend(terminal)
    if (typeof backend.downloadFileToLocalPath !== 'function') {
      return null
    }
    return await backend.downloadFileToLocalPath(terminal.ptyId, resolvedPath, targetLocalPath, options)
  }

  async uploadFileFromLocalPath(
    terminalId: string,
    sourceLocalPath: string,
    targetPath: string,
    options?: {
      onProgress?: (progress: { bytesTransferred: number; totalBytes: number; eof: boolean }) => void
      signal?: AbortSignal
    }
  ): Promise<{ totalBytes: number } | null> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedTargetPath = await this.resolvePath(terminalId, targetPath)
    const backend = this.getFileSystemBackend(terminal)
    if (typeof backend.uploadFileFromLocalPath !== 'function') {
      return null
    }
    return await backend.uploadFileFromLocalPath(terminal.ptyId, sourceLocalPath, resolvedTargetPath, options)
  }

  async statFile(terminalId: string, filePath: string): Promise<FileStatInfo> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getFileSystemBackend(terminal)
    return backend.statFile(terminal.ptyId, resolvedPath)
  }

  async listDirectory(
    terminalId: string,
    dirPath?: string
  ): Promise<{ path: string; entries: FileSystemEntry[] }> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const backend = this.getFileSystemBackend(terminal)
    const hasExplicitPath = typeof dirPath === 'string' && dirPath.trim().length > 0
    if (!hasExplicitPath) {
      await this.refreshTerminalSessionState(terminalId)
    }
    const requestedPath = hasExplicitPath
      ? dirPath!.trim()
      : this.getCwd(terminalId) || (await this.getHomeDir(terminalId)) || '.'
    const resolvedPath = await this.resolvePath(terminalId, requestedPath)
    try {
      const entries = await backend.listDirectory(terminal.ptyId, resolvedPath)
      return {
        path: resolvedPath,
        entries
      }
    } catch (error) {
      if (hasExplicitPath || !this.isPathMissingError(error)) {
        throw error
      }

      const fallbackPaths = await this.getDirectoryFallbackPaths(terminalId, terminal.remoteOs)
      for (const fallbackPath of fallbackPaths) {
        if (!fallbackPath || fallbackPath === resolvedPath) continue
        try {
          const entries = await backend.listDirectory(terminal.ptyId, fallbackPath)
      return {
        path: fallbackPath,
        entries
          }
        } catch (fallbackError) {
          if (!this.isPathMissingError(fallbackError)) {
            throw fallbackError
          }
        }
      }
      throw error
    }
  }

  async createDirectory(terminalId: string, dirPath: string): Promise<void> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, dirPath)
    const backend = this.getFileSystemBackend(terminal)
    await backend.createDirectory(terminal.ptyId, resolvedPath)
  }

  async createFile(terminalId: string, filePath: string): Promise<void> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getFileSystemBackend(terminal)
    await backend.createFile(terminal.ptyId, resolvedPath)
  }

  async deletePath(terminalId: string, targetPath: string, options?: { recursive?: boolean }): Promise<void> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, targetPath)
    const backend = this.getFileSystemBackend(terminal)
    await backend.deletePath(terminal.ptyId, resolvedPath, options)
  }

  async renamePath(terminalId: string, sourcePath: string, targetPath: string): Promise<void> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedSource = await this.resolvePath(terminalId, sourcePath)
    const resolvedTarget = await this.resolvePath(terminalId, targetPath)
    const backend = this.getFileSystemBackend(terminal)
    await backend.renamePath(terminal.ptyId, resolvedSource, resolvedTarget)
  }

  async writeFileBytes(terminalId: string, filePath: string, content: Buffer): Promise<void> {
    const terminal = this.getTerminalOrThrow(terminalId)
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getFileSystemBackend(terminal)
    await backend.writeFileBytes(terminal.ptyId, resolvedPath, content)
  }

  /**
   * Internal path resolution that handles:
   * 1. ~ expansion (home directory)
   * 2. Relative paths (resolves from current CWD)
   * 3. Platform specific separators (uses remoteOs if available)
   */
  private async resolvePath(terminalId: string, filePath: string): Promise<string> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return filePath

    const isWindows = terminal.remoteOs === 'windows'
    const pathUtil = isWindows ? path.win32 : path.posix

    let targetPath = filePath
    const needsRuntimePathState =
      targetPath.startsWith('~') || !pathUtil.isAbsolute(targetPath)
    if (needsRuntimePathState) {
      await this.refreshTerminalSessionState(terminalId)
    }

    // 1. Expand ~
    if (targetPath.startsWith('~')) {
      const homeDir = await this.getHomeDir(terminalId)
      if (homeDir) {
        if (targetPath === '~') {
          targetPath = homeDir
        } else if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
          targetPath = pathUtil.join(homeDir, targetPath.slice(2))
        }
      }
    }

    // 2. Resolve relative paths
    if (!pathUtil.isAbsolute(targetPath)) {
      const cwd = this.getCwd(terminalId)
      if (cwd) {
        targetPath = pathUtil.resolve(cwd, targetPath)
      }
    }

    return targetPath
  }

  private async refreshTerminalSessionState(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      return
    }
    const backend = this.getBackend(terminal.type)
    if (typeof backend.refreshSessionState !== 'function') {
      return
    }
    try {
      await backend.refreshSessionState(terminal.ptyId)
    } catch {
      // Best-effort: file operations should degrade to cached cwd/home state.
    }
    this.hydrateTerminalRuntimeMetadata(terminalId)
  }

  private async getDirectoryFallbackPaths(
    terminalId: string,
    remoteOs: 'unix' | 'windows' | undefined
  ): Promise<string[]> {
    const candidates: string[] = []
    const homeDir = await this.getHomeDir(terminalId)
    if (homeDir) {
      candidates.push(homeDir)
      if (remoteOs === 'windows') {
        const rootFromHome = path.win32.parse(homeDir).root
        if (rootFromHome) {
          candidates.push(rootFromHome)
        }
      }
    }

    if (remoteOs === 'windows') {
      candidates.push('C:\\')
    } else {
      candidates.push('/')
    }

    const seen = new Set<string>()
    const resolvedCandidates: string[] = []
    for (const candidate of candidates) {
      const resolved = await this.resolvePath(terminalId, candidate)
      if (!resolved || seen.has(resolved)) continue
      seen.add(resolved)
      resolvedCandidates.push(resolved)
    }
    return resolvedCandidates
  }

  private isPathMissingError(error: unknown): boolean {
    const maybeError = error as { code?: string | number; message?: string } | null
    const code = maybeError?.code
    if (code === 'ENOENT' || code === '2' || code === 2) {
      return true
    }
    const message = maybeError?.message || (error instanceof Error ? error.message : String(error))
    return /no such file|not found|cannot find/i.test(message)
  }

  getBufferDelta(terminalId: string, fromOffset: number): string {
    const buffer = this.buffers.get(terminalId)
    if (!buffer) return ''

    const normalizedFromOffset =
      Number.isFinite(fromOffset) && fromOffset > 0 ? Math.floor(fromOffset) : 0
    const bufferStartOffset = Math.max(0, buffer.offset - buffer.content.length)
    const startIdx = Math.max(0, normalizedFromOffset - bufferStartOffset)
    return buffer.content.slice(startIdx)
  }

  getCurrentOffset(terminalId: string): number {
    const buffer = this.buffers.get(terminalId)
    return buffer?.offset || 0
  }

  attachOutputConsumer(
    terminalId: string,
    consumerId: string
  ): {
    runtimeGeneration?: number
    data: string
    offset: number
    remoteOs?: 'unix' | 'windows'
    windowsRelease?: string
  } {
    if (!terminalId || !consumerId) {
      return { data: '', offset: 0 }
    }
    let consumers = this.outputConsumersByTerminal.get(terminalId)
    if (!consumers) {
      consumers = new Set<string>()
      this.outputConsumersByTerminal.set(terminalId, consumers)
    }
    consumers.add(consumerId)
    const controller = this.outputFlowControllerByTerminal.get(terminalId)
    controller?.attachRendererConsumer(consumerId)
    // Registration and snapshot capture are one synchronous main-process
    // operation. Output emitted after this point is retained as live consumer
    // credit, so the renderer can merge it with this exact buffer baseline.
    const buffer = this.buffers.get(terminalId)
    return {
      runtimeGeneration:
        controller?.runtimeGeneration ??
        this.backendRuntimeGenerationByTerminal.get(terminalId),
      data: buffer?.content || '',
      offset: buffer?.offset || 0,
      ...this.getRenderMetadata(terminalId)
    }
  }

  detachOutputConsumer(terminalId: string, consumerId: string): void {
    const consumers = this.outputConsumersByTerminal.get(terminalId)
    consumers?.delete(consumerId)
    if (consumers?.size === 0) {
      this.outputConsumersByTerminal.delete(terminalId)
    }
    this.outputFlowControllerByTerminal
      .get(terminalId)
      ?.detachRendererConsumer(consumerId)
  }

  acknowledgeOutput(
    terminalId: string,
    consumerId: string,
    runtimeGeneration: number,
    outputSequence: number
  ): void {
    const controller = this.outputFlowControllerByTerminal.get(terminalId)
    if (!controller || controller.runtimeGeneration !== runtimeGeneration) {
      return
    }
    controller.acknowledgeRenderer(consumerId, outputSequence)
  }

  reportOutputConsumerFailure(
    terminalId: string,
    consumerId: string,
    runtimeGeneration: number,
    errorMessage: string
  ): void {
    const controller = this.outputFlowControllerByTerminal.get(terminalId)
    const terminal = this.terminals.get(terminalId)
    if (
      !controller ||
      !terminal ||
      controller.runtimeGeneration !== runtimeGeneration
    ) {
      return
    }
    controller.detachRendererConsumer(consumerId)
    const normalizedMessage = String(errorMessage || 'visible xterm write failed')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500)
    this.handleTerminalOutputFailure(
      terminalId,
      terminal.type,
      terminal.ptyId,
      runtimeGeneration,
      new Error(normalizedMessage || 'visible xterm write failed')
    )
  }

  getRenderMetadata(terminalId: string): TerminalRenderMetadata {
    const terminal = this.terminals.get(terminalId)
    const remoteOs =
      terminal?.remoteOs ?? this.inferRemoteOsFromSystemInfo(terminal?.systemInfo)
    return {
      remoteOs,
      windowsRelease:
        remoteOs === 'windows' ? terminal?.systemInfo?.release : undefined
    }
  }

  /**
   * Get the recent output of the terminal.
   * If lines is not provided, it dynamically uses the current visible rows.
   */
  getRecentOutput(terminalId: string, lines?: number): string {
    const tab = this.terminals.get(terminalId)
    const headless = this.headlessPtys.get(terminalId)
    
    // If lines is not provided, use the synchronized rows from frontend, fallback to 24
    const finalLines = lines ?? (tab?.rows || 24)

    if (!headless) {
      // Fallback to raw buffer if headless is not available
      const buffer = this.buffers.get(terminalId)
      if (!buffer) return ''
      const allLines = buffer.content.split('\n')
      const start = Math.max(0, allLines.length - finalLines)
      return allLines.slice(start).join('\n')
    }
    
    // Use xterm headless buffer for clean, rendered text
    const buffer = headless.buffer.active
    const totalLines = buffer.length
    const startRow = Math.max(0, totalLines - finalLines)
    
    const result: string[] = []
    for (let i = startRow; i < totalLines; i++) {
      const line = buffer.getLine(i)
      if (line) {
        result.push(line.translateToString(true))
      }
    }
    
    return result.join('\n')
  }

  getTerminalById(terminalId: string): TerminalTab | undefined {
    return this.terminals.get(terminalId)
  }

  isTerminalReconnectable(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId)
    const config = this.terminalConfigs.get(terminalId)
    return (
      terminal?.type === 'ssh' &&
      terminal.runtimeState === 'exited' &&
      !!config &&
      isSshConnectionConfig(config)
    )
  }

  getTerminalRuntimeSnapshot(terminalId: string): TerminalRuntimeSnapshot | null {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return null

    const runtimeState: TerminalRuntimeSnapshot['runtimeState'] =
      terminal.runtimeState ?? (terminal.isInitializing ? 'initializing' : 'unknown')
    const isReady = runtimeState === 'ready'
    const trackedShellInputState = this.shellInputStateByTerminal.get(terminalId)
    const shellInputState = trackedShellInputState || 'unknown'
    const shellProtocolObserved = this.lastShellSequenceByTerminal.has(terminalId)
    const backend = this.backends.get(terminal.type)
    const commandProtocolAvailable =
      backend?.getCommandProtocolAvailability?.(terminal.ptyId)
    const shellAcceptsCommand = this.shellAcceptsAgentCommand({
      terminal,
      commandProtocolAvailable,
      shellProtocolObserved,
      trackedShellInputState,
    })
    const hasActiveOrStartingCommand =
      this.activeTaskByTerminal.has(terminalId) ||
      this.commandStartReservationByTerminal.has(terminalId) ||
      (this.pendingInputReservationsByTerminal.get(terminalId)?.size || 0) > 0

    return {
      id: terminal.id,
      title: terminal.title,
      type: terminal.type,
      runtimeState,
      isInitializing: terminal.isInitializing === true,
      lastExitCode: terminal.lastExitCode,
      reconnectable: this.isTerminalReconnectable(terminalId),
      canRunCommand: isReady && shellAcceptsCommand && !hasActiveOrStartingCommand,
      canWrite: this.canWriteToTerminal(terminal),
      canUseFilesystem: this.canUseFilesystemForTerminal(terminal),
      shellInputState,
      commandProtocolAvailable,
    }
  }

  private shellAcceptsAgentCommand(params: {
    terminal: TerminalTab
    commandProtocolAvailable: boolean | undefined
    shellProtocolObserved: boolean
    trackedShellInputState: TerminalShellInputState | undefined
  }): boolean {
    if (params.commandProtocolAvailable === false) {
      return false
    }
    if (params.trackedShellInputState !== undefined) {
      return params.trackedShellInputState === 'idle'
    }
    if (params.commandProtocolAvailable === true) {
      // A backend claiming a reliable protocol must prove its first prompt.
      // Unix and the Windows fallback do so in-band; Windows sidecars set
      // the tracked state to idle only after their marker file is verified.
      return false
    }
    // Legacy/unknown runtimes remain compatible only while untouched. Once a
    // byte has been delivered, the tracked state above must return to idle via
    // a verified prompt before an agent command can be appended safely.
    return !params.shellProtocolObserved
  }

  /**
   * Execute a command on the terminal's backend and collect stdout/stderr.
   * Used by ResourceMonitorService to run stat-collection commands.
   */
  async execOnTerminal(
    terminalId: string,
    command: string,
    timeoutMs = 6000,
    options?: TerminalExecOptions
  ): Promise<{ stdout: string; stderr: string } | null> {
    const tab = this.terminals.get(terminalId)
    if (!tab) return null

    const backend = this.getBackend(tab.type)
    if (!backend) return null

    if (typeof backend.execOnSession === 'function') {
      return await backend.execOnSession(tab.ptyId, command, timeoutMs, options)
    }

    return null
  }

  async tryPeerFileTransfer(
    sourceTerminalId: string,
    sourcePath: string,
    targetTerminalId: string,
    targetPath: string,
    options: PeerFileTransferOptions
  ): Promise<PeerFileTransferResult> {
    const source = this.terminals.get(sourceTerminalId)
    const target = this.terminals.get(targetTerminalId)
    if (!source || !target || sourceTerminalId === targetTerminalId) {
      return { status: 'fallback', reason: 'unavailable' }
    }
    if (source.type !== 'ssh' || target.type !== 'ssh') {
      return { status: 'fallback', reason: 'unavailable' }
    }
    if (
      this.getRemoteOs(sourceTerminalId) !== 'unix' ||
      this.getRemoteOs(targetTerminalId) !== 'unix'
    ) {
      return { status: 'fallback', reason: 'unsupported-os' }
    }

    const backend = this.getBackend('ssh')
    if (typeof backend.tryPeerFileTransfer !== 'function') {
      return { status: 'fallback', reason: 'unavailable' }
    }
    return await backend.tryPeerFileTransfer(
      source.ptyId,
      sourcePath,
      target.ptyId,
      targetPath,
      options
    )
  }

  getDisplayTerminals(): TerminalTab[] {
    return Array.from(this.terminals.values())
  }

  getAllTerminals(): TerminalTab[] {
    return Array.from(this.terminals.values()).filter((t) => !t.isInitializing && t.runtimeState === 'ready')
  }

  getTransferMachineIdentity(terminalId: string): string | null {
    const terminal = this.terminals.get(terminalId)
    const config = this.terminalConfigs.get(terminalId)
    if (!terminal || !config) {
      return null
    }
    if (!terminal.capabilities?.supportsFilesystem) {
      return null
    }
    if (isLocalConnectionConfig(config)) {
      return 'local://default'
    }
    if (isSshConnectionConfig(config)) {
      const host = config.host.trim().toLowerCase()
      if (this.isLoopbackHost(host)) {
        return 'local://default'
      }
      return `ssh://${host}:${config.port || 22}`
    }
    return `${config.type}:${terminalId}`
  }

  private isLoopbackHost(host: string): boolean {
    const normalized = host.replace(/^\[|\]$/g, '')
    return (
      normalized === 'localhost' ||
      normalized === '127.0.0.1' ||
      normalized === '::1'
    )
  }

  getCommandTask(terminalId: string, commandId: string): CommandTask | undefined {
    const task =
      this.tasksByTerminal.get(terminalId)?.[commandId] ||
      this.detachedTasksByTerminal.get(terminalId)?.[commandId]
    if (!task) return undefined
    const snapshot = this.getCommandOutputSnapshot(terminalId, commandId)
    return snapshot
      ? { ...task, output: snapshot.output, capture: snapshot.capture }
      : { ...task }
  }

  getCommandRecordLocation(
    terminalId: string,
    commandId: string
  ): 'active' | 'detached' | undefined {
    if (this.tasksByTerminal.get(terminalId)?.[commandId]) {
      return 'active'
    }
    if (this.detachedTasksByTerminal.get(terminalId)?.[commandId]) {
      return 'detached'
    }
    return undefined
  }

  getCommandOutputSnapshot(
    terminalId: string,
    commandId: string
  ): CommandOutputSnapshot | undefined {
    const task =
      this.tasksByTerminal.get(terminalId)?.[commandId] ||
      this.detachedTasksByTerminal.get(terminalId)?.[commandId]
    if (!task) return undefined
    const capture = this.captureByTaskId.get(commandId)
    const output = capture?.getText() ?? task.output ?? ''
    const captureMetadata = capture?.getMetadata() ?? task.capture ?? {
      state: 'unknown' as const,
      reason: 'tracking_unavailable' as const,
      observedUtf8Bytes: Buffer.byteLength(output, 'utf8'),
      retainedUtf8Bytes: Buffer.byteLength(output, 'utf8'),
      availableLineCount: output
        ? output.split('\n').length - (output.endsWith('\n') ? 1 : 0)
        : 0,
      revision: 0,
      terminalControlsObserved: false,
    }
    const executionState: CommandOutputSnapshot['executionState'] =
      task.runtimeBoundary || task.outcomeUnknown
      ? 'outcome_unknown'
      : task.status === 'finished'
        ? 'finished'
        : task.status === 'aborted'
          ? 'aborted'
          : 'running'
    return {
      taskId: task.id,
      command: task.command,
      status: task.status,
      executionState,
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      runtimeBoundary: task.runtimeBoundary === true,
      output,
      capture: { ...captureMetadata },
    }
  }

  getCommandTasks(terminalId: string): CommandTask[] {
    const activeTasks = Object.values(this.tasksByTerminal.get(terminalId) || {})
    const detachedTasks = Object.values(
      this.detachedTasksByTerminal.get(terminalId) || {}
    )
    return [...activeTasks, ...detachedTasks].sort(
      (a, b) => b.startTime - a.startTime
    )
  }

  setSelection(terminalId: string, selectionText: string): void {
    this.selectionByTerminal.set(terminalId, selectionText)
  }

  getSelection(terminalId: string): string {
    return this.selectionByTerminal.get(terminalId) || ''
  }
  
  findTerminalId(idOrName: string): string | undefined {
    if (this.terminals.has(idOrName)) return idOrName
    
    // Fuzzy match name? Or exact? User says "if Name match Unique run, else return error info"
    // Let's return all matches so AgentService can decide.
    // But this method just returns one ID if found.
    return undefined
  }

  // Helper for Agent to resolve "ID or Name"
  resolveTerminal(idOrName: string): { found: TerminalTab[], bestMatch?: TerminalTab } {
    if (this.terminals.has(idOrName)) {
        return { found: [this.terminals.get(idOrName)!], bestMatch: this.terminals.get(idOrName) }
    }
    
    const matches = Array.from(this.terminals.values()).filter(t => t.title === idOrName)
    if (matches.length === 1) {
        return { found: matches, bestMatch: matches[0] }
    }
    return { found: matches }
  }

  async runCommandNoWait(
    terminalId: string,
    command: string,
    onFinished?: (result: CommandResult) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const taskId = await this.executeCommandInternal(
      terminalId,
      command,
      'nowait',
      onFinished,
      signal
    )
    return taskId
  }

  private buildDispatchedCommand(
    terminal: TerminalTab,
    command: string,
    taskId: string
  ): string {
    if (
      this.getCommandShellFamily(terminal) !== 'unix'
    ) return command
    const runtimeToken = this.commandProtocolTokenByTerminal.get(terminal.id)
    const previousSequence = this.lastShellSequenceByTerminal.get(terminal.id)
    if (!runtimeToken || previousSequence === undefined) return command

    const expectedSequence = previousSequence + 1
    const fallbackNonce = taskId.replace(/-/g, '')
    return buildUnixDispatchedCommand(
      runtimeToken,
      expectedSequence,
      fallbackNonce,
      command
    )
  }

  private async prepareCommandTracking(
    terminal: TerminalTab,
    options?: { failClosed?: boolean }
  ): Promise<TerminalCommandTrackingToken | undefined> {
    const backend = this.getBackend(terminal.type)
    if (typeof backend.prepareCommandTracking !== 'function') {
      return undefined
    }
    try {
      const token = await this.awaitCommandTrackingIo(
        backend.prepareCommandTracking(terminal.ptyId),
        'command tracking preparation'
      )
      if (token?.mode !== 'windows-powershell-sidecar') {
        return token
      }

      const cached = this.windowsPromptBaselineByTerminal.get(terminal.id)
      const trackingScopeMatches =
        cached?.mode === token.mode &&
        (!cached.trackingScopeId ||
          !token.trackingScopeId ||
          cached.trackingScopeId === token.trackingScopeId)
      if (!cached || !trackingScopeMatches) {
        return token
      }

      // Preparation bounds the append-only prompt journal by truncating it.
      // If a prepared command is cancelled before dispatch, the next live
      // read is legitimately empty. Keep the monotonic baseline already
      // authenticated for this runtime instead of falling back to sequence 0.
      return {
        ...token,
        baselineSequence: Math.max(
          token.baselineSequence,
          cached.baselineSequence,
          this.windowsPromptSequenceFloorByTerminal.get(terminal.id) || 0
        ),
      }
    } catch (error) {
      if (options?.failClosed) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Unable to establish reliable command tracking for terminal ${terminal.title || terminal.id}: ${detail}`
        )
      }
      return undefined
    }
  }

  private async awaitCommandTrackingIo<T>(
    operation: Promise<T>,
    description: string,
    timeoutMs = this.commandTrackingIoTimeoutMs
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs))
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `${description} timed out after ${boundedTimeoutMs}ms.`
              )
            )
          }, boundedTimeoutMs)
        }),
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  private isCurrentTerminalRuntime(
    terminalId: string,
    ptyId: string,
    runtimeGeneration: number | undefined
  ): boolean {
    const terminal = this.terminals.get(terminalId)
    return (
      terminal?.ptyId === ptyId &&
      terminal.runtimeState === 'ready' &&
      this.backendRuntimeGenerationByTerminal.get(terminalId) ===
        runtimeGeneration
    )
  }

  private isCommandTrackingIoTimeout(error: unknown): boolean {
    return (
      error instanceof Error &&
      / timed out after \d+ms\.$/.test(error.message)
    )
  }

  private quarantineTerminalRuntime(
    terminalId: string,
    ptyId: string,
    runtimeGeneration: number | undefined
  ): boolean {
    if (
      !this.isCurrentTerminalRuntime(
        terminalId,
        ptyId,
        runtimeGeneration
      )
    ) {
      return false
    }
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return false

    this.deferredWritesDuringCommandStartByTerminal.delete(terminalId)
    terminal.isInitializing = false
    terminal.runtimeState = 'exited'
    terminal.lastExitCode = -1
    this.terminalIdsBeingKilled.add(terminalId)
    try {
      this.getBackend(terminal.type).kill(terminal.ptyId)
    } catch {
      // The runtime remains non-writable even if termination cannot be
      // confirmed. A reconnect receives a new generation and private paths.
    } finally {
      this.terminalIdsBeingKilled.delete(terminalId)
    }
    this.publishTerminalTabsChanged()
    this.schedulePersistTerminalState()
    return true
  }

  private rememberWindowsPromptBaseline(
    terminalId: string,
    token: TerminalCommandTrackingToken,
    sequence: number
  ): TerminalCommandTrackingToken {
    const baseline: TerminalCommandTrackingToken = {
      mode: token.mode,
      ...(token.trackingScopeId
        ? { trackingScopeId: token.trackingScopeId }
        : {}),
      baselineSequence: sequence,
    }
    this.windowsPromptBaselineByTerminal.set(terminalId, baseline)
    this.windowsPromptSequenceFloorByTerminal.set(
      terminalId,
      Math.max(
        sequence,
        this.windowsPromptSequenceFloorByTerminal.get(terminalId) || 0
      )
    )
    return { ...baseline }
  }

  private reserveWindowsPromptSequence(
    terminalId: string,
    token: TerminalCommandTrackingToken
  ): number {
    const expectedSequence =
      Math.max(
        token.baselineSequence,
        this.windowsPromptSequenceFloorByTerminal.get(terminalId) || 0
      ) + 1
    this.windowsPromptSequenceFloorByTerminal.set(
      terminalId,
      expectedSequence
    )
    return expectedSequence
  }

  private getWindowsPromptBaselineWithoutIo(
    terminalId: string,
    terminal: TerminalTab
  ): TerminalCommandTrackingToken | undefined {
    const cached = this.windowsPromptBaselineByTerminal.get(terminalId)
    if (cached) {
      return this.rememberWindowsPromptBaseline(
        terminalId,
        cached,
        cached.baselineSequence
      )
    }

    const initial = this.getBackend(
      terminal.type
    ).getInitialCommandTrackingToken?.(terminal.ptyId)
    if (
      !initial ||
      !Number.isSafeInteger(initial.baselineSequence) ||
      initial.baselineSequence < 1 ||
      this.terminals.get(terminalId) !== terminal
    ) {
      return undefined
    }
    return this.rememberWindowsPromptBaseline(
      terminalId,
      initial,
      initial.baselineSequence
    )
  }

  private ensureWindowsPromptBaseline(
    terminalId: string
  ): Promise<TerminalCommandTrackingToken | undefined> {
    const terminal = this.terminals.get(terminalId)
    if (
      !this.usesPowerShellCommandLifecycle(terminal) ||
      terminal?.runtimeState !== 'ready'
    ) {
      return Promise.resolve(undefined)
    }
    const baseline = this.getWindowsPromptBaselineWithoutIo(
      terminalId,
      terminal
    )
    if (!baseline) {
      if (
        this.backendUsesPowerShellSidecar(terminal) &&
        !this.shellInputStateByTerminal.has(terminalId)
      ) {
        this.shellInputStateByTerminal.set(terminalId, 'unknown')
      }
      return Promise.resolve(undefined)
    }

    const trackedState = this.shellInputStateByTerminal.get(terminalId)
    const hasPendingInput =
      (this.pendingInputReservationsByTerminal.get(terminalId)?.size || 0) > 0
    if (
      !hasPendingInput &&
      !this.activeTaskByTerminal.has(terminalId) &&
      !this.commandStartReservationByTerminal.has(terminalId) &&
      (trackedState === undefined || trackedState === 'idle')
    ) {
      this.shellInputStateByTerminal.set(terminalId, 'idle')
    }
    return Promise.resolve(baseline)
  }

  private applyCommandTrackingMetadata(
    terminalId: string,
    update: TerminalCommandTrackingUpdate
  ): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      return
    }
    if (update.cwd || update.homeDir) {
      this.getBackend(terminal.type).applyCommandProtocolMetadata?.(
        terminal.ptyId,
        {
          ...(update.cwd !== undefined ? { cwd: update.cwd } : {}),
          ...(update.homeDir !== undefined ? { homeDir: update.homeDir } : {}),
        }
      )
      this.hydrateTerminalRuntimeMetadata(terminalId)
    }
  }

  private applyCommandTrackingUpdate(
    terminalId: string,
    update: TerminalCommandTrackingUpdate
  ): void {
    if (update.mode !== 'windows-powershell-sidecar') {
      return
    }
    const activeTask = this.getActiveTask(terminalId)
    if (activeTask) {
      if (update.output !== undefined) {
        activeTask.capturedOutput = update.output
      }
      if (update.outputObservedUtf8Bytes !== undefined) {
        activeTask.capturedOutputObservedUtf8Bytes = update.outputObservedUtf8Bytes
      }
      if (update.outputRetainedUtf8Bytes !== undefined) {
        activeTask.capturedOutputRetainedUtf8Bytes = update.outputRetainedUtf8Bytes
      }
      activeTask.capturedOutputTruncated = update.outputTruncated === true
      activeTask.capturedOutputCaptureFailed =
        update.outputCaptureFailed === true
    }
    if (activeTask?.completionTracking) {
      this.rememberWindowsPromptBaseline(
        terminalId,
        activeTask.completionTracking,
        update.sequence
      )
    }
    const manualWatcher =
      this.windowsManualPromptWatcherByTerminal.get(terminalId)
    if (
      !manualWatcher &&
      (!activeTask ||
        this.taskOwnsLatestTerminalInput(terminalId, activeTask))
    ) {
      this.shellInputStateByTerminal.set(terminalId, 'idle')
    }
    this.applyCommandTrackingMetadata(terminalId, update)
  }

  private assertSidecarTaskOutputIsConsistent(
    task: CommandTask,
    update: TerminalCommandTrackingUpdate
  ): void {
    if (task.displayMode !== 'synthetic-transcript') {
      return
    }
    if (
      task.completionTracking?.expectedRequestId &&
      update.requestId !== task.completionTracking.expectedRequestId
    ) {
      throw new Error('Windows sidecar completion does not match its task request identity.')
    }
    if (
      update.output === undefined &&
      (update.outputCaptureFailed !== true ||
        update.outputRetainedUtf8Bytes !== 0)
    ) {
      throw new Error('Windows sidecar completion arrived without its task output file.')
    }
    if (update.output === undefined) {
      return
    }
    if (update.outputRetainedUtf8Bytes === undefined) {
      throw new Error('Windows sidecar completion arrived without its retained output length.')
    }
    if (
      update.outputRetainedUtf8Bytes !== undefined &&
      Buffer.byteLength(update.output, 'utf8') !==
        update.outputRetainedUtf8Bytes
    ) {
      throw new Error('Windows sidecar output length does not match its completion marker.')
    }
    if (
      update.outputObservedUtf8Bytes !== undefined &&
      update.outputRetainedUtf8Bytes > update.outputObservedUtf8Bytes
    ) {
      throw new Error('Windows sidecar retained output exceeds its observed output length.')
    }
    if (
      update.outputTruncated !== true &&
      update.outputCaptureFailed !== true &&
      update.outputObservedUtf8Bytes !== undefined &&
      update.outputRetainedUtf8Bytes !== update.outputObservedUtf8Bytes
    ) {
      throw new Error('Windows sidecar reported silent output loss.')
    }
  }

  private stopCommandTrackingWatcher(taskId: string | undefined): void {
    if (!taskId) {
      return
    }
    const watcher = this.commandTrackingWatcherByTaskId.get(taskId)
    if (watcher) {
      watcher.cancelled = true
      this.commandTrackingWatcherByTaskId.delete(taskId)
    }
  }

  private startWindowsManualPromptWatcher(
    terminal: TerminalTab,
    token: TerminalCommandTrackingToken,
    expectedInputRevision: number,
    ownedInputReservation: symbol,
    options: {
      restoreIdleOnCompletion: boolean
    }
  ): number {
    const terminalId = terminal.id
    const previous = this.windowsManualPromptWatcherByTerminal.get(terminalId)
    if (previous) previous.cancelled = true
    const previousIsUnsettled =
      previous !== undefined &&
      previous.expectedPromptSequence > token.baselineSequence
    const sequenceFloor =
      this.windowsPromptSequenceFloorByTerminal.get(terminalId) || 0
    // Raw Enter is ambiguous: it can submit a top-level command, complete a
    // multiline block, or feed a foreground program. Reserve one later prompt
    // for the whole unsettled interaction. The authenticated PSReadLine-idle
    // boundary, rather than the number of Enter bytes, proves when all queued
    // input has drained at an empty prompt. Input sent to an active agent task
    // remains owned by that task's exact completion marker instead.
    const expectedPromptSequence = previousIsUnsettled
      ? Math.max(previous.expectedPromptSequence, sequenceFloor)
      : Math.max(token.baselineSequence, sequenceFloor) + 1
    this.windowsPromptSequenceFloorByTerminal.set(
      terminalId,
      expectedPromptSequence
    )
    const runtimePtyId = terminal.ptyId
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const watcher: WindowsManualPromptWatcher = {
      ptyId: runtimePtyId,
      runtimeGeneration,
      expectedInputRevision,
      expectedPromptSequence,
      restoreIdleOnCompletion: options.restoreIdleOnCompletion,
      ownedInputReservation,
      cancelled: false,
    }
    this.windowsManualPromptWatcherByTerminal.set(terminalId, watcher)
    return expectedPromptSequence
  }

  private commitWindowsPowerShellInputRevision(
    terminal: TerminalTab,
    backend: TerminalBackend,
    revision: number,
    minimumPromptSequence: number
  ): void {
    const commit = backend.commitPowerShellInputRevision
    if (!commit || !Number.isSafeInteger(revision) || revision < 1) {
      return
    }
    const terminalId = terminal.id
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const previous = this.windowsInputRevisionCommitByTerminal.get(terminalId)
    const commitCurrentRevision = async (): Promise<void> => {
      let lastError: unknown
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (
          !this.isCurrentTerminalRuntime(
            terminalId,
            terminal.ptyId,
            runtimeGeneration
          )
        ) {
          return
        }
        try {
          await commit.call(
            backend,
            terminal.ptyId,
            revision,
            minimumPromptSequence
          )
          return
        } catch (error) {
          lastError = error
          if (attempt < 3) {
            await waitForTerminalDelay(
              Math.min(250, Math.max(10, this.commandTrackingPollIntervalMs))
            )
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError))
    }
    const pending =
      previous && previous.runtimeGeneration === runtimeGeneration
        ? previous.tail.then(commitCurrentRevision, commitCurrentRevision)
        : commitCurrentRevision()
    const settled = pending.catch((error) => {
      if (
        this.isCurrentTerminalRuntime(
          terminalId,
          terminal.ptyId,
          runtimeGeneration
        )
      ) {
        const watcher =
          this.windowsManualPromptWatcherByTerminal.get(terminalId)
        if (
          watcher?.expectedInputRevision === revision &&
          watcher.expectedPromptSequence === minimumPromptSequence
        ) {
          // Keep the watcher so a later human recovery submission can replace
          // it, but make the loss explicit instead of leaving a silent busy
          // state that looks like a running command.
          this.shellInputStateByTerminal.set(terminalId, 'unknown')
        }
        console.warn(
          `[TerminalService] Failed to commit PowerShell input revision for ${terminalId}.`,
          error
        )
      }
    })
    const entry = { runtimeGeneration, tail: settled }
    this.windowsInputRevisionCommitByTerminal.set(terminalId, entry)
    void settled.finally(() => {
      if (this.windowsInputRevisionCommitByTerminal.get(terminalId) === entry) {
        this.windowsInputRevisionCommitByTerminal.delete(terminalId)
      }
    })
  }

  private tryCompleteWindowsManualPromptWatcher(terminalId: string): boolean {
    const watcher = this.windowsManualPromptWatcherByTerminal.get(terminalId)
    if (
      !watcher ||
      watcher.cancelled ||
      this.windowsManualPromptWatcherByTerminal.get(terminalId) !== watcher ||
      !this.isCurrentTerminalRuntime(
        terminalId,
        watcher.ptyId,
        watcher.runtimeGeneration
      ) ||
      (watcher.inputIdleSequence || 0) < watcher.expectedPromptSequence
    ) {
      return false
    }

    const reservations = this.pendingInputReservationsByTerminal.get(terminalId)
    if (
      reservations?.has(watcher.ownedInputReservation) ||
      this.activeTaskByTerminal.has(terminalId) ||
      this.commandStartReservationByTerminal.has(terminalId)
    ) {
      return false
    }

    if (
      watcher.restoreIdleOnCompletion &&
      (this.terminalInputRevisionByTerminal.get(terminalId) || 0) ===
        watcher.expectedInputRevision &&
      (!reservations || reservations.size === 0)
    ) {
      this.shellInputStateByTerminal.set(terminalId, 'idle')
    }
    watcher.cancelled = true
    this.windowsManualPromptWatcherByTerminal.delete(terminalId)
    return true
  }

  private isWindowsPromptRendered(terminalId: string, cwd?: string): boolean {
    const headless = this.headlessPtys.get(terminalId)
    const buffer = headless?.buffer.active
    if (!buffer) {
      return true
    }

    const endAbsLine = buffer.baseY + buffer.cursorY
    const startAbsLine = Math.max(0, endAbsLine - 6)
    const tailLines: string[] = []
    for (let lineIndex = startAbsLine; lineIndex <= endAbsLine; lineIndex += 1) {
      const line = buffer.getLine(lineIndex)
      if (!line) {
        continue
      }
      tailLines.push(stripTerminalControlSequences(line.translateToString(true)).trimEnd())
    }

    const expectedPrompt = cwd ? `PS ${cwd.replace(/\//g, '\\')}>` : undefined
    for (let index = tailLines.length - 1; index >= 0; index -= 1) {
      const line = tailLines[index]
      if (!line) {
        continue
      }
      if (expectedPrompt ? line.startsWith(expectedPrompt) : WINDOWS_PROMPT_ONLY_PATTERN.test(line.trim())) {
        return true
      }
    }

    if (!expectedPrompt) {
      return false
    }
    return tailLines.join('').includes(expectedPrompt)
  }

  private async waitForWindowsPromptSync(
    terminalId: string,
    taskId: string,
    cwd?: string
  ): Promise<void> {
    const deadline = Date.now() + this.commandTrackingPromptSyncTimeoutMs
    while (true) {
      if (this.activeTaskByTerminal.get(terminalId) !== taskId) {
        return
      }
      if (this.isWindowsPromptRendered(terminalId, cwd)) {
        return
      }
      if (Date.now() >= deadline) {
        return
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.commandTrackingPromptSyncPollIntervalMs)
      )
    }
  }

  private startCommandTrackingWatcher(
    terminal: TerminalTab,
    taskId: string,
    token: TerminalCommandTrackingToken
  ): void {
    const backend = this.getBackend(terminal.type)
    if (typeof backend.pollCommandTracking !== 'function') {
      return
    }
    this.stopCommandTrackingWatcher(taskId)
    const watcher = { cancelled: false }
    this.commandTrackingWatcherByTaskId.set(taskId, watcher)
    const terminalId = terminal.id
    const runtimePtyId = terminal.ptyId
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const isCurrentTask = (): boolean => {
      const task = this.tasksByTerminal.get(terminalId)?.[taskId]
      return (
        !watcher.cancelled &&
        this.commandTrackingWatcherByTaskId.get(taskId) === watcher &&
        this.isCurrentTerminalRuntime(
          terminalId,
          runtimePtyId,
          runtimeGeneration
        ) &&
        this.activeTaskByTerminal.get(terminalId) === taskId &&
        task?.status === 'running'
      )
    }

    const poll = async (): Promise<void> => {
      let consecutivePollErrors = 0
      try {
        while (isCurrentTask()) {
          const task = this.tasksByTerminal.get(terminalId)?.[taskId]
          if (!task) {
            return
          }

          try {
            const update = await this.awaitCommandTrackingIo(
              backend.pollCommandTracking!(runtimePtyId, token),
              'Windows command completion poll'
            )
            if (!isCurrentTask()) {
              return
            }
            if (update) {
              this.assertSidecarTaskOutputIsConsistent(task, update)
              consecutivePollErrors = 0
              this.applyCommandTrackingUpdate(terminalId, update)
              if (task.displayMode === 'synthetic-transcript') {
                if (task.captureBoundaryState !== 'sealed') {
                  await this.waitForSyntheticTaskOutputQuiescence(terminalId, taskId)
                }
              } else {
                await this.waitForWindowsPromptSync(terminalId, taskId, update.cwd)
              }
              if (!isCurrentTask()) {
                return
              }
              this.finishActiveTask(
                terminalId,
                update.exitCode,
                update.outcomeKnown === false || update.exitCode === undefined
              )
              return
            }
            consecutivePollErrors = 0
          } catch {
            if (!isCurrentTask()) {
              return
            }
            consecutivePollErrors += 1
            if (consecutivePollErrors >= this.commandTrackingMaxConsecutiveErrors) {
              this.failActiveTaskDueToTrackingLoss(terminalId)
              return
            }
          }

          await new Promise((resolve) => setTimeout(resolve, this.commandTrackingPollIntervalMs))
        }
      } finally {
        if (this.commandTrackingWatcherByTaskId.get(taskId) === watcher) {
          this.commandTrackingWatcherByTaskId.delete(taskId)
        }
      }
    }

    void poll()
  }

  async runCommandAndWait(
    terminalId: string,
    command: string,
    opts?: { 
      signal?: AbortSignal; 
      interruptOnAbort?: boolean; 
      onFinished?: (result: CommandResult) => void;
      shouldSkip?: () => boolean;
      suppressFinishCallback?: boolean;
    }
  ): Promise<CommandResult> {
    const taskId = await this.executeCommandInternal(
      terminalId,
      command,
      'wait',
      opts?.onFinished,
      opts?.signal
    )
    return this.waitForTask(terminalId, taskId, opts)
  }

  async waitForTask(
    terminalId: string,
    taskId: string,
    opts?: { 
      signal?: AbortSignal; 
      interruptOnAbort?: boolean;
      shouldSkip?: () => boolean;
      suppressFinishCallback?: boolean;
    }
  ): Promise<CommandResult> {
    const startTime = Date.now()
    const timeoutMs = 120_000
    let suppressionApplied = false
    const task = this.tasksByTerminal.get(terminalId)?.[taskId]
    if (!task) {
      throw new Error(`Task ${taskId} not found.`)
    }
    if (opts?.suppressFinishCallback && task.status === 'running') {
      task.suppressFinishCallback = true
      suppressionApplied = true
    }
    const clearSuppressionIfStillRunning = (): void => {
      if (!suppressionApplied) return
      if (task.status === 'running') {
        task.suppressFinishCallback = false
      }
    }
    const currentTaskOutput = (): string =>
      this.getTaskCapture(taskId)?.getText() ?? task.output ?? ''

    while (true) {
      if (task.status === 'finished') {
        const outcomeUnknown =
          task.runtimeBoundary === true || task.outcomeUnknown === true
        return {
          stdoutDelta: currentTaskOutput(),
          ...(!task.outcomeUnknown
            ? { exitCode: task.exitCode ?? -1 }
            : {}),
          history_command_match_id: taskId,
          executionState: outcomeUnknown ? 'outcome_unknown' : 'finished',
          ...(task.capture ? { capture: { ...task.capture } } : {}),
          ...(task.terminalStatus ? { terminalStatus: task.terminalStatus } : {}),
          ...(task.runtimeBoundary ? { runtimeBoundary: true } : {})
        }
      }
      if (opts?.signal?.aborted) {
        if (opts.interruptOnAbort !== false) {
          if (
            task.status === 'running' &&
            this.activeTaskByTerminal.get(terminalId) === taskId
          ) {
            this.interrupt(terminalId)
            this.markTaskAborted(terminalId, taskId)
          }
        } else {
          clearSuppressionIfStillRunning()
          const abortError = createTerminalAbortError() as Error & {
            history_command_match_id?: string
            commandContinues?: boolean
          }
          abortError.history_command_match_id = taskId
          abortError.commandContinues =
            task?.status === 'running' &&
            this.activeTaskByTerminal.get(terminalId) === taskId
          throw abortError
        }
        return {
          stdoutDelta: currentTaskOutput(),
          exitCode: -2,
          history_command_match_id: taskId,
          executionState: 'aborted',
          ...(task.capture ? { capture: { ...task.capture } } : {}),
        }
      }

      if (task.status === 'aborted') {
        return {
          stdoutDelta: currentTaskOutput(),
          exitCode: task.exitCode ?? (task.runtimeBoundary ? -1 : -2),
          history_command_match_id: taskId,
          executionState: task.runtimeBoundary ? 'outcome_unknown' : 'aborted',
          ...(task.capture ? { capture: { ...task.capture } } : {}),
          ...(task.terminalStatus ? { terminalStatus: task.terminalStatus } : {}),
          ...(task.runtimeBoundary ? { runtimeBoundary: true } : {})
        }
      }
      // Check if user manually skipped the wait after honoring a just-finished task.
      if (opts?.shouldSkip?.()) {
        clearSuppressionIfStillRunning()
        return {
          stdoutDelta: currentTaskOutput(),
          exitCode: -3,
          history_command_match_id: taskId,
          executionState: 'running',
          ...(task.capture ? { capture: { ...task.capture } } : {}),
        }
      }

      if (Date.now() - startTime > timeoutMs) {
        clearSuppressionIfStillRunning()
        return {
          stdoutDelta: currentTaskOutput(),
          exitCode: -1,
          history_command_match_id: taskId,
          executionState: 'running',
          ...(task.capture ? { capture: { ...task.capture } } : {}),
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  private async executeCommandInternal(
    terminalId: string,
    command: string,
    type: 'wait' | 'nowait',
    onFinished?: (result: CommandResult) => void,
    signal?: AbortSignal
  ): Promise<string> {
    throwIfTerminalOperationAborted(signal)
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    if (terminal.runtimeState !== 'ready') {
      throw new Error(`Terminal ${terminal.title || terminal.id} is not ready (state=${terminal.runtimeState || 'unknown'}).`)
    }
    const backend = this.getBackend(terminal.type)
    const commandProtocolAvailable =
      backend.getCommandProtocolAvailability?.(terminal.ptyId)
    if (commandProtocolAvailable === false) {
      throw new Error(
        `Terminal ${terminal.title || terminal.id} shell does not expose a reliable exec_command boundary protocol.`
      )
    }
    if (!this.shellAcceptsAgentCommand({
      terminal,
      commandProtocolAvailable,
      shellProtocolObserved: this.lastShellSequenceByTerminal.has(terminalId),
      trackedShellInputState: this.shellInputStateByTerminal.get(terminalId),
    })) {
      throw new Error(
        `Terminal ${terminal.title || terminal.id} shell is not at an idle prompt.`
      )
    }
    if ((this.pendingInputReservationsByTerminal.get(terminalId)?.size || 0) > 0) {
      throw new Error(
        `Terminal ${terminal.title || terminal.id} has a pending input sequence.`
      )
    }

    const reservationToken = this.reserveCommandStart(terminalId, command)
    let startedTaskId: string | undefined
    try {
      startedTaskId = await this.executeReservedCommand(
        terminal,
        command,
        type,
        onFinished,
        signal,
        reservationToken
      )
      return startedTaskId
    } finally {
      const releasePromptFileIo =
        this.promptFileIoReleaseByCommandStartToken.get(reservationToken)
      this.promptFileIoReleaseByCommandStartToken.delete(reservationToken)
      releasePromptFileIo?.()
      this.releaseCommandStart(
        terminalId,
        reservationToken,
        startedTaskId
      )
    }
  }

  private reservePromptFileIo(
    terminalId: string,
    reservationToken?: symbol,
    runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
  ): PromptFileIoLease {
    const promptFileIoKey = this.getPromptFileIoKey(
      terminalId,
      runtimeGeneration
    )
    const predecessor =
      this.promptFileIoTailByTerminal.get(promptFileIoKey) ?? Promise.resolve()
    let releaseTurn: () => void = () => {}
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const queuedTail = predecessor.then(() => turn)
    this.promptFileIoTailByTerminal.set(promptFileIoKey, queuedTail)

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      releaseTurn()
      void queuedTail.then(() => {
        if (
          this.promptFileIoTailByTerminal.get(promptFileIoKey) === queuedTail
        ) {
          this.promptFileIoTailByTerminal.delete(promptFileIoKey)
        }
      })
    }
    if (reservationToken) {
      this.promptFileIoReleaseByCommandStartToken.set(
        reservationToken,
        release
      )
    }
    return { waitForTurn: predecessor, release }
  }

  private getPromptFileIoKey(
    terminalId: string,
    runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
  ): string {
    return `${terminalId}:${runtimeGeneration ?? 'unbound'}`
  }

  private reserveCommandStart(terminalId: string, command: string): symbol {
    const activeTaskId = this.activeTaskByTerminal.get(terminalId)
    const pendingStart = this.commandStartReservationByTerminal.get(terminalId)
    if (activeTaskId || pendingStart) {
      const activeTask = activeTaskId
        ? this.getTaskMap(terminalId)[activeTaskId]
        : undefined
      const commandName =
        activeTask?.command ?? pendingStart?.command ?? 'unknown'
      throw new Error(
        `There is a running exec_command in the terminal tab: "${commandName}". If you need to end the previous command, use write_stdin to end it, otherwise wait until it finishes.`
      )
    }

    const token = Symbol(terminalId)
    let releaseWaiters: () => void = () => {}
    const waitForRelease = new Promise<void>((resolve) => {
      releaseWaiters = resolve
    })
    this.commandStartReservationByTerminal.set(terminalId, {
      token,
      command,
      waitForRelease,
      releaseWaiters
    })
    return token
  }

  private cancelCommandStartReservation(terminalId: string): void {
    const reservation =
      this.commandStartReservationByTerminal.get(terminalId)
    this.commandStartReservationByTerminal.delete(terminalId)
    this.deferredWritesDuringCommandStartByTerminal.delete(terminalId)
    if (reservation) {
      const releasePromptFileIo =
        this.promptFileIoReleaseByCommandStartToken.get(reservation.token)
      this.promptFileIoReleaseByCommandStartToken.delete(reservation.token)
      releasePromptFileIo?.()
    }
    reservation?.releaseWaiters()
  }

  private releaseCommandStart(
    terminalId: string,
    token: symbol,
    startedTaskId?: string
  ): void {
    const reservation =
      this.commandStartReservationByTerminal.get(terminalId)
    if (reservation?.token !== token) return

    this.commandStartReservationByTerminal.delete(terminalId)
    const deferred =
      this.deferredWritesDuringCommandStartByTerminal.get(terminalId) || []
    this.deferredWritesDuringCommandStartByTerminal.delete(terminalId)
    try {
      reservation.startedTaskId = startedTaskId
      const startedTask = startedTaskId
        ? this.tasksByTerminal.get(terminalId)?.[startedTaskId]
        : undefined
      if (
        deferred.length > 0 &&
        startedTask?.status === 'running' &&
        startedTask.displayMode === 'synthetic-transcript'
      ) {
        // A sidecar marker and output file describe one hidden request. Input
        // buffered behind startup must not generate another prompt marker
        // before that exact request has been correlated and finalized.
        this.deferredWritesUntilTaskFinishByTaskId.set(
          startedTask.id,
          deferred
        )
      } else {
        this.replayDeferredTerminalWrites(terminalId, deferred)
      }
    } finally {
      reservation.releaseWaiters()
    }
  }

  private replayDeferredTerminalWrites(
    terminalId: string,
    deferred: readonly string[]
  ): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal || !this.canWriteToTerminal(terminal)) {
      return
    }
    for (const data of deferred) {
      try {
        this.write(terminalId, data)
      } catch (error) {
        console.warn(
          `[TerminalService] Failed to replay input deferred during command startup for ${terminalId}.`,
          error
        )
      }
    }
  }

  private async waitForPromptFileRequestConsumption(options: {
    terminalId: string
    runtimePtyId: string
    backend: TerminalBackend & TerminalFileSystemBackend
    requestPath: string
    runtimeIsCurrent: () => boolean
  }): Promise<void> {
    const {
      terminalId,
      runtimePtyId,
      backend,
      requestPath,
      runtimeIsCurrent,
    } = options
    const deadline = Date.now() + this.promptFileRequestTimeoutMs
    let lastFailure = 'the request file still contains the user command'
    while (runtimeIsCurrent()) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now())
        const requestContents = await this.awaitCommandTrackingIo(
          backend.readFile(runtimePtyId, requestPath),
          'Windows prompt-file request consumption read',
          Math.min(this.commandTrackingIoTimeoutMs, remainingMs)
        )
        if (!runtimeIsCurrent()) {
          break
        }
        if (requestContents.length === 0) {
          return
        }
        lastFailure = 'the request file still contains the user command'
      } catch (error) {
        if (!runtimeIsCurrent()) {
          break
        }
        lastFailure = error instanceof Error ? error.message : String(error)
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The Windows prompt-file hook did not consume the command for terminal ${terminalId}: ${lastFailure}.`
        )
      }
      await waitForTerminalDelay(this.commandTrackingPollIntervalMs)
    }
    throw new Error(
      `Terminal ${terminalId} changed before its Windows prompt-file command request was consumed.`
    )
  }

  private async executeReservedCommand(
    terminal: TerminalTab,
    command: string,
    type: 'wait' | 'nowait',
    onFinished: ((result: CommandResult) => void) | undefined,
    signal: AbortSignal | undefined,
    reservationToken: symbol
  ): Promise<string> {
    const terminalId = terminal.id
    const runtimePtyId = terminal.ptyId
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const runtimeIsCurrent = (): boolean =>
      this.terminals.get(terminalId) === terminal &&
      terminal.ptyId === runtimePtyId &&
      terminal.runtimeState === 'ready' &&
      this.backendRuntimeGenerationByTerminal.get(terminalId) ===
        runtimeGeneration

    const taskId = uuidv4()
    const startOffset = this.getCurrentOffset(terminalId)
    // Preparation can mutate shared prompt-marker state and is not
    // cancellable. Keep the start reservation until it settles, then honor
    // stop before any dispatch.
    let completionTracking: TerminalCommandTrackingToken | undefined
    try {
      completionTracking = await this.prepareCommandTracking(terminal, {
        failClosed: true,
      })
    } catch (error) {
      if (this.isCommandTrackingIoTimeout(error)) {
        this.quarantineTerminalRuntime(
          terminalId,
          runtimePtyId,
          runtimeGeneration
        )
      }
      throw error
    }
    throwIfTerminalOperationAborted(signal)
    const wireCommand = this.buildDispatchedCommand(terminal, command, taskId)

    const backend = this.getBackend(terminal.type)
    const eol = this.usesPowerShellCommandLifecycle(terminal) ? '\r' : '\n'
    let usedPromptFileDispatch = false
    let promptRequestPending = false
    let promptRequestCleanup: (() => Promise<boolean>) | undefined
    const shellInputStateBeforePromptDispatch =
      this.shellInputStateByTerminal.get(terminalId)
    const restoreShellStateAfterPromptDispatchFailure = (): void => {
      if (!runtimeIsCurrent()) {
        return
      }
      if (shellInputStateBeforePromptDispatch === undefined) {
        this.shellInputStateByTerminal.delete(terminalId)
      } else {
        this.shellInputStateByTerminal.set(
          terminalId,
          shellInputStateBeforePromptDispatch
        )
      }
    }
    const quarantineCurrentPromptFileRuntime = (): boolean =>
      this.quarantineTerminalRuntime(
        terminalId,
        runtimePtyId,
        runtimeGeneration
      )
    const clearPendingPromptRequest = async (): Promise<boolean> => {
      if (!promptRequestPending || !promptRequestCleanup) {
        return true
      }
      const cleared = await promptRequestCleanup()
      // A failed cleanup quarantines the runtime, so either outcome makes it
      // safe to release the command-start reservation.
      promptRequestPending = false
      return cleared
    }
    const requestsPromptFileDispatch =
      completionTracking?.dispatchMode === 'prompt-file'
    if (
      requestsPromptFileDispatch &&
      (!completionTracking?.dispatchInput ||
        !completionTracking?.commandRequestPath ||
        !completionTracking?.commandOutputPath ||
        !isTerminalFileSystemBackend(backend))
    ) {
      throw new Error(
        'The Windows prompt-file command protocol is missing a runtime-bound request, output, or dispatch channel.'
      )
    }
    const usesPromptFileDispatch = Boolean(requestsPromptFileDispatch)
    const promptFileIoKey = this.getPromptFileIoKey(
      terminalId,
      runtimeGeneration
    )
    if (
      usesPromptFileDispatch ||
      this.promptFileIoTailByTerminal.has(promptFileIoKey)
    ) {
      const promptFileIo = this.reservePromptFileIo(
        terminalId,
        reservationToken,
        runtimeGeneration
      )
      // Serialize request-file access only within one runtime. Every backend
      // runtime owns unique sidecar paths, so a permanently stalled old write
      // cannot freeze or later overwrite a replacement runtime.
      await waitForPromiseOrAbort(promptFileIo.waitForTurn, signal)
      throwIfTerminalOperationAborted(signal)
      if (!runtimeIsCurrent()) {
        throw new Error(
          `Terminal ${terminalId} changed before the prompt-file command could be prepared.`
        )
      }
    }
    if (
      usesPromptFileDispatch &&
      completionTracking?.commandRequestPath &&
      isTerminalFileSystemBackend(backend)
    ) {
      promptRequestCleanup = async (): Promise<boolean> => {
        try {
          await this.awaitCommandTrackingIo(
            backend.writeFile(
              runtimePtyId,
              completionTracking.commandRequestPath!,
              ''
            ),
            'Windows prompt-file request cleanup'
          )
          return true
        } catch (cleanupError) {
          // Every runtime owns a unique sidecar path. Cleanup failure is fatal
          // only while this exact runtime is still current; a late failure
          // from an abandoned runtime cannot make its replacement unsafe.
          const quarantined = quarantineCurrentPromptFileRuntime()
          console.warn(
            quarantined
              ? `[TerminalService] Failed to clear a pending prompt-file command for ${terminalId}; quarantined the current terminal runtime.`
              : `[TerminalService] Failed to clear an abandoned runtime's prompt-file command for ${terminalId}; its runtime-scoped path cannot affect the replacement.`,
            cleanupError
          )
          return false
        }
      }

      // Bootstrap readiness establishes the runtime-private dispatcher. The
      // request id, one-time file consumption, completion marker, and cleanup
      // quarantine then authenticate this exact user request. A separate
      // preflight dispatch is not atomic with the real request and only
      // duplicates shell input, prompts, history, and latency.
      completionTracking.expectCommandOutput = true
      const commandRequestId = taskId.replace(/-/g, '')
      completionTracking.expectedRequestId = commandRequestId
      const requestPayload = buildWindowsPowerShellDispatchRequest({
        requestId: commandRequestId,
        kind: 'command',
        command,
      })
      let promptWriteSucceeded = false
      promptRequestPending = true
      try {
        // The backend file write is not cancellable. Await it while retaining
        // the per-terminal start reservation; otherwise a late write can leave
        // a command that the next PowerShell prompt executes unexpectedly.
        await this.awaitCommandTrackingIo(
          backend.writeFile(
            runtimePtyId,
            completionTracking.commandRequestPath,
            requestPayload
          ),
          'Windows prompt-file user request write'
        )
        promptWriteSucceeded = true
      } catch (writeError) {
        await clearPendingPromptRequest()
        if (this.isCommandTrackingIoTimeout(writeError)) {
          quarantineCurrentPromptFileRuntime()
        }
        restoreShellStateAfterPromptDispatchFailure()
        if (signal?.aborted) {
          throwIfTerminalOperationAborted(signal)
        }
        // A raw-input fallback cannot use the sidecar output file safely: it
        // belongs to the most recent hidden request and may still contain a
        // previous command's transcript. Abort before any shell input is
        // delivered, even when cleanup succeeded.
        throw writeError
      }
      if (signal?.aborted) {
        await clearPendingPromptRequest()
        restoreShellStateAfterPromptDispatchFailure()
        throwIfTerminalOperationAborted(signal)
      }
      usedPromptFileDispatch = promptWriteSucceeded
    }

    throwIfTerminalOperationAborted(signal)
    if (!runtimeIsCurrent()) {
      await clearPendingPromptRequest()
      throw new Error(
        `Terminal ${terminalId} changed before the command could be dispatched.`
      )
    }

    const usesPowerShellLifecycle =
      this.usesPowerShellCommandLifecycle(terminal)
    const usesSyntheticTranscript =
      usedPromptFileDispatch &&
      completionTracking?.displayMode === 'synthetic-transcript'
    const usesSyntheticCommandEcho =
      !usesPowerShellLifecycle && wireCommand !== command
    const capture = new CommandTranscriptCapture()
    const unverifiedCapture = new CommandTranscriptCapture()
    const lastShellSequence = this.lastShellSequenceByTerminal.get(terminalId)
    const task: CommandTask = {
      id: taskId,
      command,
      wireCommand,
      completionTracking,
      inputRevisionAtDispatch:
        this.terminalInputRevisionByTerminal.get(terminalId) || 0,
      type,
      status: 'running',
      startOffset,
      startTime: Date.now(),
      output: '',
      capture: capture.getMetadata(),
      captureBoundaryState: usesSyntheticTranscript
        ? 'awaiting-start'
        : usesPowerShellLifecycle
          ? 'unverified'
          : 'awaiting-start',
      ...(usesSyntheticTranscript
        ? { displayMode: 'synthetic-transcript' as const }
        : usesSyntheticCommandEcho
          ? { displayMode: 'synthetic-command-echo' as const }
          : {}),
      ...(lastShellSequence !== undefined
        ? { expectedShellSequence: lastShellSequence + 1 }
        : {})
    }
    const taskMap = this.getTaskMap(terminalId)
    taskMap[taskId] = task
    this.captureByTaskId.set(taskId, capture)
    this.unverifiedCaptureByTaskId.set(taskId, unverifiedCapture)
    this.activeTaskByTerminal.set(terminalId, taskId)
    if (usesSyntheticCommandEcho && lastShellSequence !== undefined) {
      const privateDispatcherName = wireCommand.split(' ', 1)[0] || wireCommand
      const runtimeTokenSuffix = privateDispatcherName
        .replace(/^__gyshell_/, '')
        .replace(/_dispatch$/, '')
        .slice(-8)
      this.pendingUnixCommandDisplayByTerminal.set(terminalId, {
        taskId,
        command,
        expectedSequence: lastShellSequence + 1,
        expectedNonce: taskId.replace(/-/g, ''),
        privateDispatcherName,
        privateEchoEndAnchor: `${runtimeTokenSuffix}_command_exit`,
        suppressedTextTail: '',
        privateEchoObserved: false,
        submissionBoundaryObserved: false,
        postSubmitDisplay: '',
        postSubmitDisplayOverflowed: false,
      })
    }
    if (onFinished) this.onTaskFinishedCallbacks.set(taskId, onFinished)
    if (task.displayMode === 'synthetic-transcript') {
      this.appendSyntheticDisplayData(
        terminalId,
        this.buildSyntheticTaskPrelude(terminalId, terminal, command)
      )
    }

    try {
      const dispatchedInput = usedPromptFileDispatch
        ? `${completionTracking!.dispatchInput}${eol}`
        : `${wireCommand}${eol}`
      const previousShellInputState = shellInputStateBeforePromptDispatch
      this.shellInputStateByTerminal.set(terminalId, 'busy')
      if (completionTracking) {
        completionTracking.dispatchedAtMs = Date.now()
      }
      try {
        backend.write(runtimePtyId, dispatchedInput)
        if (completionTracking) {
          this.reserveWindowsPromptSequence(
            terminalId,
            completionTracking
          )
        }
      } catch (error) {
        if (previousShellInputState) {
          this.shellInputStateByTerminal.set(terminalId, previousShellInputState)
        } else {
          this.shellInputStateByTerminal.delete(terminalId)
        }
        throw error
      }
    } catch (error) {
      delete taskMap[taskId]
      this.captureByTaskId.delete(taskId)
      this.unverifiedCaptureByTaskId.delete(taskId)
      if (this.activeTaskByTerminal.get(terminalId) === taskId) {
        this.activeTaskByTerminal.delete(terminalId)
      }
      this.onTaskFinishedCallbacks.delete(taskId)
      if (
        this.pendingUnixCommandDisplayByTerminal.get(terminalId)?.taskId ===
        taskId
      ) {
        this.pendingUnixCommandDisplayByTerminal.delete(terminalId)
      }
      await clearPendingPromptRequest()
      throw error
    }

    if (
      usedPromptFileDispatch &&
      completionTracking?.commandRequestPath &&
      isTerminalFileSystemBackend(backend)
    ) {
      try {
        await this.waitForPromptFileRequestConsumption({
          terminalId,
          runtimePtyId,
          backend,
          requestPath: completionTracking.commandRequestPath,
          runtimeIsCurrent,
        })
        promptRequestPending = false
      } catch (consumptionError) {
        await clearPendingPromptRequest()
        quarantineCurrentPromptFileRuntime()
        task.terminalStatus =
          consumptionError instanceof Error
            ? consumptionError.message
            : String(consumptionError)
        if (
          this.activeTaskByTerminal.get(terminalId) === taskId &&
          task.status === 'running'
        ) {
          this.failActiveTaskDueToTrackingLoss(terminalId)
        }
        return taskId
      }
    } else {
      promptRequestPending = false
    }
    if (completionTracking) {
      this.startCommandTrackingWatcher(terminal, taskId, completionTracking)
    }
    return taskId
  }

  getActiveTaskId(terminalId: string): string | undefined {
    return this.activeTaskByTerminal.get(terminalId)
  }

  private getTaskMap(terminalId: string): Record<string, CommandTask> {
    const existing = this.tasksByTerminal.get(terminalId)
    if (existing) return existing
    const next: Record<string, CommandTask> = {}
    this.tasksByTerminal.set(terminalId, next)
    return next
  }

  private appendActiveTaskOutput(terminalId: string, chunk: string): void {
    if (!chunk) return
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) return
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || task.status !== 'running') return
    const terminal = this.terminals.get(terminalId)
    if (this.usesPowerShellCommandLifecycle(terminal)) {
      if (task.captureBoundaryState === 'sealed') {
        return
      }
      if (
        task.displayMode === 'synthetic-transcript' &&
        task.captureBoundaryState !== 'capturing'
      ) {
        return
      }
      task.lastOutputAtMs = Date.now()
      this.unverifiedCaptureByTaskId.get(task.id)?.append(chunk)
      return
    }
    task.lastOutputAtMs = Date.now()
    if (task.captureBoundaryState !== 'capturing') {
      if (task.captureBoundaryState === 'awaiting-start') {
        this.unverifiedCaptureByTaskId.get(task.id)?.append(chunk)
      }
      return
    }
    this.getTaskCapture(task.id)?.append(chunk)
    this.syncTaskCaptureMetadata(task)
  }

  private getTaskCapture(taskId: string): CommandTranscriptCapture | undefined {
    return this.captureByTaskId.get(taskId)
  }

  private promoteUnverifiedUnixCapture(
    terminalId: string,
    terminal: TerminalTab | undefined,
    task: CommandTask
  ): void {
    if (this.usesPowerShellCommandLifecycle(terminal)) {
      return
    }
    const pendingCapture = this.unverifiedCaptureByTaskId.get(task.id)
    if (!pendingCapture) {
      return
    }
    this.unverifiedCaptureByTaskId.delete(task.id)
    pendingCapture.seal()
    const pendingMetadata = pendingCapture.getMetadata()
    const capture = this.getTaskCapture(task.id)
    if (!capture) {
      return
    }

    capture.append(
      this.normalizeFinishedTaskOutput(
        terminalId,
        terminal,
        task,
        pendingCapture.getText()
      )
    )
    if (pendingMetadata.state === 'incomplete') {
      capture.markIncomplete(
        pendingMetadata.reason || 'retention_limit',
        pendingMetadata.observedUtf8Bytes
      )
    }
    if (pendingMetadata.terminalControlsObserved) {
      capture.markTerminalControlsObserved()
    }
    this.syncTaskCaptureMetadata(task)
  }

  private syncTaskCaptureMetadata(task: CommandTask): void {
    const capture = this.getTaskCapture(task.id)
    if (!capture) {
      return
    }
    task.capture = capture.getMetadata()
  }

  private finalizeActiveTask(
    terminalId: string,
    options?: {
      exitCode?: number
      outputOverride?: string
      runtimeBoundary?: boolean
      outcomeUnknown?: boolean
      captureUnknownReason?: 'tracking_lost'
    }
  ): void {
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) return
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || (task.status !== 'running' && task.status !== 'timeout')) return
    const terminal = this.terminals.get(terminalId)
    this.finalizeTaskCapture(terminalId, task, terminal, {
      runtimeBoundary: options?.runtimeBoundary === true,
      outputOverride: options?.outputOverride,
      captureUnknownReason: options?.captureUnknownReason,
    })
    task.output = this.getTaskCapture(task.id)?.getText() ?? ''
    const syntheticCompletionOutput = task.syntheticRawDisplayObserved
      ? task.syntheticSidecarDisplayOutput || ''
      : task.output
    const rawToSidecarSeparator =
      task.syntheticRawDisplayObserved &&
      syntheticCompletionOutput.length > 0 &&
      !task.syntheticRawDisplayEndsWithLineBreak
        ? '\r\n'
        : ''
    const syntheticDisplay =
      terminal && task.displayMode === 'synthetic-transcript'
        ? rawToSidecarSeparator + this.buildSyntheticTaskCompletionDisplay(
            terminalId,
            terminal,
            syntheticCompletionOutput
          )
        : undefined

    task.status = 'finished'
    task.endTime = Date.now()
    task.exitCode = options?.exitCode
    task.runtimeBoundary = options?.runtimeBoundary === true
    task.outcomeUnknown = options?.outcomeUnknown === true
    if (task.outcomeUnknown && !task.terminalStatus) {
      task.terminalStatus =
        'The shell completed the command but did not provide a trustworthy exact exit code.'
    }
    task.endOffset = task.startOffset + task.output.length

    this.stopCommandTrackingWatcher(taskId)
    this.unverifiedCaptureByTaskId.delete(taskId)
    this.activeTaskByTerminal.delete(terminalId)
    this.pendingTaskFinishByTerminal.delete(terminalId)
    const deferredWrites =
      this.deferredWritesUntilTaskFinishByTaskId.get(taskId) || []
    this.deferredWritesUntilTaskFinishByTaskId.delete(taskId)
    if (syntheticDisplay) {
      this.appendSyntheticDisplayData(terminalId, syntheticDisplay)
    }

    // Input that arrived while this hidden request was starting belongs to
    // the shell immediately after this task, not to work a completion
    // callback may synchronously enqueue. Replay it while the terminal is
    // task-free but before invoking external code so the shell-input gate is
    // already busy when a callback attempts to start another command.
    if (!task.runtimeBoundary) {
      this.replayDeferredTerminalWrites(terminalId, deferredWrites)
    }
    this.tryCompleteWindowsManualPromptWatcher(terminalId)

    const callback = this.onTaskFinishedCallbacks.get(taskId)
    if (callback) {
      this.onTaskFinishedCallbacks.delete(taskId)
    }
    if (callback && !task.suppressFinishCallback) {
      const outcomeUnknown =
        task.runtimeBoundary === true || task.outcomeUnknown === true
      callback({
        stdoutDelta: task.output,
        ...(!task.outcomeUnknown && options?.exitCode !== undefined
          ? { exitCode: options.exitCode }
          : {}),
        history_command_match_id: taskId,
        executionState: outcomeUnknown ? 'outcome_unknown' : 'finished',
        ...(task.capture ? { capture: { ...task.capture } } : {}),
        ...(task.terminalStatus ? { terminalStatus: task.terminalStatus } : {}),
        ...(task.runtimeBoundary ? { runtimeBoundary: true } : {})
      })
    }
    this.compactFinalizedTask(task)
    this.enforceCommandCaptureRetention()
  }

  private finalizeTaskCapture(
    terminalId: string,
    task: CommandTask,
    terminal: TerminalTab | undefined,
    options: {
      runtimeBoundary: boolean
      outputOverride?: string
      captureUnknownReason?: 'tracking_lost'
    }
  ): void {
    const capture = this.getTaskCapture(task.id)
    if (!capture) {
      return
    }
    this.promoteUnverifiedUnixCapture(terminalId, terminal, task)
    const current = capture.getMetadata()
    if (
      this.usesPowerShellCommandLifecycle(terminal) &&
      this.unverifiedCaptureByTaskId.has(task.id)
    ) {
      const pendingCapture = this.unverifiedCaptureByTaskId.get(task.id)
      this.unverifiedCaptureByTaskId.delete(task.id)
      const hasSidecarOutput = task.capturedOutput !== undefined
      const hasRequestBoundSidecar =
        hasSidecarOutput && task.displayMode === 'synthetic-transcript'
      const rawBoundaryVerified =
        hasRequestBoundSidecar && task.captureBoundaryState === 'sealed'
      if (hasRequestBoundSidecar && !rawBoundaryVerified) {
        pendingCapture?.seal()
      }
      const pendingMetadata = pendingCapture?.getMetadata()
      const pendingText = pendingCapture?.getText() || ''

      if (hasRequestBoundSidecar) {
        capture.append(
          this.normalizeSyntheticWindowsTaskOutput(
            task.capturedOutput || '',
            task,
            { source: 'captured' }
          )
        )
        task.syntheticSidecarDisplayOutput = capture.getText()
        // The request-bound OSC pair excludes dispatcher echo and prompt
        // rendering without content heuristics. Raw bytes inside it can come
        // from Console/Host/TUI paths that bypass PowerShell streams. Preserve
        // their projected text, but never claim process attribution or an
        // ordering relative to the sidecar stream.
        if (rawBoundaryVerified || task.captureBoundaryState === 'capturing') {
          capture.append(pendingText)
        }
      } else {
        capture.append(
          this.normalizeFinishedTaskOutput(
            terminalId,
            terminal,
            task,
            pendingText
          )
        )
      }

      const capturedOutputBytes = hasSidecarOutput
        ? Buffer.byteLength(task.capturedOutput || '', 'utf8')
        : undefined
      const sidecarRetainedBytes =
        task.capturedOutputRetainedUtf8Bytes ?? capturedOutputBytes
      const sidecarObservedLoss =
        sidecarRetainedBytes !== undefined &&
        task.capturedOutputObservedUtf8Bytes !== undefined &&
        sidecarRetainedBytes < task.capturedOutputObservedUtf8Bytes
      const sidecarObservedLossBytes =
        sidecarRetainedBytes !== undefined &&
        task.capturedOutputObservedUtf8Bytes !== undefined
          ? Math.max(
              0,
              task.capturedOutputObservedUtf8Bytes - sidecarRetainedBytes
            )
          : 0
      const pendingObservedLossBytes = pendingMetadata
        ? Math.max(
            0,
            pendingMetadata.observedUtf8Bytes -
              pendingMetadata.retainedUtf8Bytes
          )
        : 0
      // The merged capture has already counted every retained projected byte.
      // Add each source's discarded delta; taking max(sourceObserved) loses
      // information whenever sidecar and request-bound raw capture both hit
      // their independent retention limits.
      const combinedObservedUtf8Bytes =
        capture.getMetadata().observedUtf8Bytes +
        sidecarObservedLossBytes +
        pendingObservedLossBytes
      if (
        !task.capturedOutputCaptureFailed &&
        (task.capturedOutputTruncated || sidecarObservedLoss)
      ) {
        if (capture.getMetadata().state === 'unknown') {
          capture.markUnknown(
            capture.getMetadata().reason || 'tracking_lost',
            combinedObservedUtf8Bytes
          )
        } else {
          capture.markIncomplete(
            'retention_limit',
            combinedObservedUtf8Bytes
          )
        }
      }
      if (task.capturedOutputCaptureFailed) {
        capture.markUnknown('tracking_lost', combinedObservedUtf8Bytes)
      }
      if (pendingMetadata?.state === 'incomplete') {
        if (capture.getMetadata().state === 'unknown') {
          capture.markUnknown(
            capture.getMetadata().reason || 'tracking_lost',
            combinedObservedUtf8Bytes
          )
        } else {
          capture.markIncomplete(
            pendingMetadata.reason || 'retention_limit',
            combinedObservedUtf8Bytes
          )
        }
      }
      if (pendingMetadata?.terminalControlsObserved) {
        capture.markTerminalControlsObserved()
      }
      if (
        hasRequestBoundSidecar &&
        rawBoundaryVerified &&
        (pendingText.length > 0 || pendingMetadata?.terminalControlsObserved) &&
        capture.getMetadata().state !== 'complete' &&
        capture.getMetadata().state !== 'unknown'
      ) {
        capture.markUnknown('projection_ambiguous')
      }
      if (
        hasRequestBoundSidecar &&
        !rawBoundaryVerified &&
        capture.getMetadata().state !== 'complete' &&
        capture.getMetadata().state !== 'unknown'
      ) {
        capture.markUnknown('tracking_lost')
      }
      if (
        !hasSidecarOutput &&
        !options.captureUnknownReason &&
        !options.runtimeBoundary &&
        capture.getMetadata().state === 'in_progress'
      ) {
        // The modern PowerShell prompt hook provides an end marker but no
        // task-bound start marker. Its best-effort transcript is useful, but
        // claiming completeness would overstate what the protocol proves.
        capture.markUnknown('tracking_unavailable')
      }
    } else if (options.outputOverride && current.retainedUtf8Bytes === 0) {
      capture.append(options.outputOverride)
    }

    const afterAppend = capture.getMetadata()
    if (options.captureUnknownReason) {
      capture.markUnknown(options.captureUnknownReason)
    } else if (options.runtimeBoundary) {
      capture.markUnknown('runtime_boundary')
    } else if (
      !this.usesPowerShellCommandLifecycle(terminal) &&
      task.captureBoundaryState !== 'sealed' &&
      afterAppend.state === 'in_progress'
    ) {
      capture.markUnknown('tracking_lost')
    } else {
      capture.seal()
    }
    this.syncTaskCaptureMetadata(task)
  }

  private finishActiveTask(
    terminalId: string,
    exitCode?: number,
    outcomeUnknown = exitCode === undefined
  ): void {
    this.finalizeActiveTask(terminalId, { exitCode, outcomeUnknown })
  }

  private failActiveTaskDueToTrackingLoss(terminalId: string): void {
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) {
      return
    }
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || task.status !== 'running') {
      return
    }
    this.shellInputStateByTerminal.set(terminalId, 'unknown')
    this.finalizeActiveTask(terminalId, {
      exitCode: -1,
      runtimeBoundary: true,
      captureUnknownReason: 'tracking_lost',
    })
  }

  private markTaskAborted(terminalId: string, taskId: string): void {
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || task.status !== 'running') return
    const terminal = this.terminals.get(terminalId)
    this.finalizeTaskCapture(terminalId, task, terminal, {
      runtimeBoundary: false,
      captureUnknownReason: 'tracking_lost',
    })
    task.output = this.getTaskCapture(task.id)?.getText() ?? ''
    task.status = 'aborted'
    task.endTime = Date.now()
    task.exitCode = -2
    task.endOffset = task.startOffset + (task.output?.length || 0)
    this.stopCommandTrackingWatcher(taskId)
    this.unverifiedCaptureByTaskId.delete(taskId)
    this.activeTaskByTerminal.delete(terminalId)
    this.tryCompleteWindowsManualPromptWatcher(terminalId)
    this.pendingTaskFinishByTerminal.delete(terminalId)
    this.deferredWritesUntilTaskFinishByTaskId.delete(taskId)
    this.onTaskFinishedCallbacks.delete(taskId)
    this.compactFinalizedTask(task)
    this.enforceCommandCaptureRetention()
  }

  private compactFinalizedTask(task: CommandTask): void {
    if (task.status === 'running') return
    task.command = this.takeTaskCommandPreview(task.command, 4096)
    delete task.output
    delete task.wireCommand
    delete task.completionTracking
    delete task.capturedOutput
    delete task.capturedOutputObservedUtf8Bytes
    delete task.capturedOutputRetainedUtf8Bytes
    delete task.capturedOutputTruncated
    delete task.capturedOutputCaptureFailed
    delete task.syntheticSidecarDisplayOutput
    delete task.syntheticRawDisplayObserved
    delete task.syntheticRawDisplayEndsWithLineBreak
  }

  private takeTaskCommandPreview(command: string, maxUtf8Bytes: number): string {
    const source = String(command || '')
    if (Buffer.byteLength(source, 'utf8') <= maxUtf8Bytes) return source
    const suffix = '… [command preview truncated]'
    const contentBudget = Math.max(
      0,
      maxUtf8Bytes - Buffer.byteLength(suffix, 'utf8')
    )
    let preview = ''
    let retainedBytes = 0
    for (const scalar of source) {
      const scalarBytes = Buffer.byteLength(scalar, 'utf8')
      if (retainedBytes + scalarBytes > contentBudget) break
      preview += scalar
      retainedBytes += scalarBytes
    }
    return `${preview}${suffix}`
  }

  /**
   * Bounds aggregate in-memory transcripts without turning eviction into
   * silent data loss. Active and newest captures are never evicted; older
   * records remain as explicit tombstones for read_command_output.
   */
  private enforceCommandCaptureRetention(): void {
    const candidates: Array<{
      task: CommandTask
      capture: CommandTranscriptCapture
      retainedBytes: number
    }> = []
    let retainedBytes = 0

    const taskStores = [
      ...this.tasksByTerminal.entries(),
      ...this.detachedTasksByTerminal.entries(),
    ] as Array<[string, Record<string, CommandTask>]>
    for (const [terminalId, tasks] of taskStores) {
      const activeTaskId = this.activeTaskByTerminal.get(terminalId)
      for (const task of Object.values(tasks)) {
        if (task.id === activeTaskId || task.status === 'running') {
          continue
        }
        const capture = this.captureByTaskId.get(task.id)
        if (!capture) {
          continue
        }
        const bytes = capture.getMetadata().retainedUtf8Bytes
        retainedBytes += bytes
        candidates.push({ task, capture, retainedBytes: bytes })
      }
    }

    candidates.sort(
      (left, right) =>
        (left.task.endTime || left.task.startTime) -
        (right.task.endTime || right.task.startTime)
    )
    while (
      candidates.length > 1 &&
      (retainedBytes > this.commandCaptureRetentionBudgetBytes ||
        candidates.length > this.commandCaptureRetentionMaxRecords)
    ) {
      const expired = candidates.shift()
      if (!expired) {
        break
      }
      const metadata = expired.capture.getMetadata()
      retainedBytes -= expired.retainedBytes
      this.captureByTaskId.delete(expired.task.id)
      this.unverifiedCaptureByTaskId.delete(expired.task.id)
      this.compactFinalizedTask(expired.task)
      expired.task.command = this.takeTaskCommandPreview(
        expired.task.command,
        1024
      )
      expired.task.capture = {
        state: 'unknown',
        reason: 'record_expired',
        observedUtf8Bytes: metadata.observedUtf8Bytes,
        retainedUtf8Bytes: 0,
        availableLineCount: 0,
        revision: metadata.revision + 1,
        terminalControlsObserved: metadata.terminalControlsObserved,
      }
    }

    const tombstones: Array<{
      terminalId: string
      task: CommandTask
      tasks: Record<string, CommandTask>
      detached: boolean
    }> = []
    for (const [terminalId, tasks] of taskStores) {
      const detached = this.detachedTasksByTerminal.get(terminalId) === tasks
      for (const task of Object.values(tasks)) {
        if (
          task.status !== 'running' &&
          !this.captureByTaskId.has(task.id)
        ) {
          tombstones.push({ terminalId, task, tasks, detached })
        }
      }
    }
    tombstones.sort(
      (left, right) =>
        (left.task.endTime || left.task.startTime) -
        (right.task.endTime || right.task.startTime)
    )
    while (tombstones.length > this.commandHistoryTombstoneMaxRecords) {
      const expired = tombstones.shift()
      if (!expired) break
      delete expired.tasks[expired.task.id]
      this.unverifiedCaptureByTaskId.delete(expired.task.id)
      this.deferredWritesUntilTaskFinishByTaskId.delete(expired.task.id)
      if (
        expired.detached &&
        Object.keys(expired.tasks).length === 0 &&
        this.detachedTasksByTerminal.get(expired.terminalId) === expired.tasks
      ) {
        this.detachedTasksByTerminal.delete(expired.terminalId)
      }
    }
  }

  private stripEchoedCommand(output: string, command: string): string {
    if (!output) return output
    const lines = output.split(/\r?\n/)
    if (lines.length === 0) return output
    if (lines[0].includes(command)) {
      return lines.slice(1).join('\n').trimEnd()
    }
    return output.trimEnd()
  }

  private stripEchoedCommands(output: string, ...commands: Array<string | undefined>): string {
    return commands
      .filter((command): command is string => Boolean(command))
      .reduce((current, command) => this.stripEchoedCommand(current, command), output)
  }

  private normalizeFinishedTaskOutput(
    terminalId: string,
    terminal: TerminalTab | undefined,
    task: CommandTask,
    output: string
  ): string {
    const stripped = this.stripEchoedCommands(
      stripGyShellOscMarkers(output),
      task.command,
      task.wireCommand
    )
    if (this.usesPowerShellCommandLifecycle(terminal)) {
      return this.normalizeWindowsTaskOutput(terminalId, stripped, task)
    }
    return stripped.trimEnd()
  }

  private normalizeSyntheticWindowsTaskOutput(
    output: string,
    task: CommandTask,
    options?: { source?: 'captured' | 'raw' }
  ): string {
    if (!output) {
      return ''
    }

    if (options?.source === 'captured') {
      // Sidecar output is the authoritative command transcript. Feed it
      // unchanged into CommandTranscriptCapture so whitespace, blank lines,
      // carriage returns, and control-sequence metadata share one projector.
      return output
    }

    const logicalLineOutput = output.replace(/\x1b\[(\d+);(\d+)H/g, (_match, _row, col) =>
      String(col) === '1' ? '\n' : ''
    )

    const cleanedLines: string[] = []
    let previousWasBlank = false

    for (const rawLine of logicalLineOutput.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
      const withoutAnsi = stripTerminalControlSequences(rawLine)
      const normalizedLine = withoutAnsi.replace(/[ \t]+$/g, '')
      if (!normalizedLine.trim()) {
        if (cleanedLines.length > 0 && !previousWasBlank) {
          cleanedLines.push('')
          previousWasBlank = true
        }
        continue
      }

      if (WINDOWS_PROMPT_ONLY_PATTERN.test(normalizedLine.trim())) {
        continue
      }

      const withoutPrompt = normalizedLine.replace(WINDOWS_PROMPT_PREFIX_PATTERN, '')
      const strippedEcho =
        this.stripSyntheticCommandEchoPrefix(withoutPrompt, task.command) ??
        this.stripSyntheticCommandEchoPrefix(withoutPrompt, task.wireCommand)
      const effectiveLine = strippedEcho !== null ? strippedEcho : withoutPrompt
      if (!effectiveLine.trim()) {
        continue
      }
      if (this.isWindowsSyntheticProgressLine(effectiveLine, task)) {
        continue
      }
      if (this.isWindowsSshNoiseLine(effectiveLine.trim(), task)) {
        continue
      }

      cleanedLines.push(effectiveLine.replace(/[ \t]+$/g, ''))
      previousWasBlank = false
    }

    while (cleanedLines[0] === '') {
      cleanedLines.shift()
    }
    while (cleanedLines[cleanedLines.length - 1] === '') {
      cleanedLines.pop()
    }

    return cleanedLines.join('\n')
  }

  private stripSyntheticCommandEchoPrefix(
    line: string,
    command: string | undefined
  ): string | null {
    if (!command) {
      return null
    }
    const trimmedLine = line.trimStart()
    if (!trimmedLine.startsWith(command)) {
      return null
    }
    return trimmedLine.slice(command.length)
  }

  private isWindowsSyntheticProgressLine(line: string, task: CommandTask): boolean {
    const trimmed = line.trim()
    if (!trimmed) {
      return false
    }
    if (/^(?:PS>?|PS:?)$/i.test(trimmed)) {
      return true
    }
    if (/(正在加载|loading\s)/i.test(trimmed)) {
      return true
    }
    const commandHead = (task.command || '').split(/[|\s]/).find(Boolean)
    if (!commandHead) {
      return Boolean(task.command && trimmed.length >= 12 && task.command.includes(trimmed))
    }
    return (
      (trimmed.startsWith(commandHead) && trimmed.length <= commandHead.length + 24) ||
      Boolean(task.command && trimmed.length >= 12 && task.command.includes(trimmed))
    )
  }

  private shouldStripTrailingWindowsPromptLine(
    terminalId: string,
    cleanedLines: string[],
    rawOutput: string
  ): boolean {
    const trailingLine = cleanedLines[cleanedLines.length - 1]?.trim()
    if (!trailingLine || !WINDOWS_PROMPT_ONLY_PATTERN.test(trailingLine)) {
      return false
    }

    if (cleanedLines.length > 1) {
      return true
    }

    const visiblePromptLine = this.getVisibleWindowsPromptLine(terminalId)?.trim()
    if (visiblePromptLine && trailingLine !== visiblePromptLine) {
      return false
    }

    if (!visiblePromptLine) {
      const cwd = (this.getCwd(terminalId) || '').replace(/\//g, '\\').trim()
      if (cwd) {
        const expectedPowerShellPrompt = `PS ${cwd}>`
        const expectedCmdPrompt = `${cwd}>`
        if (trailingLine !== expectedPowerShellPrompt && trailingLine !== expectedCmdPrompt) {
          return false
        }
      }
    }

    return /[\r\n]/.test(rawOutput)
  }

  private normalizeWindowsTaskOutput(
    terminalId: string,
    output: string,
    task: CommandTask
  ): string {
    if (!output) return ''

    const cleanedLines: string[] = []
    let previousWasBlank = false

    for (const rawLine of output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
      const withoutAnsi = stripTerminalControlSequences(rawLine)
      if (!withoutAnsi) {
        continue
      }

      const normalizedLine = withoutAnsi.replace(/[ \t]+$/g, '')
      const trimmedLine = normalizedLine.trim()
      const lineWithoutPrompt = normalizedLine.replace(WINDOWS_PROMPT_PREFIX_PATTERN, '')
      const trimmedWithoutPrompt = lineWithoutPrompt.trim()
      if (
        !trimmedLine ||
        this.isWindowsSshNoiseLine(trimmedWithoutPrompt, task)
      ) {
        if (!trimmedLine) {
          if (cleanedLines.length > 0 && !previousWasBlank) {
            cleanedLines.push('')
            previousWasBlank = true
          }
        }
        continue
      }

      cleanedLines.push(normalizedLine)
      previousWasBlank = false
    }

    while (cleanedLines[0] === '') {
      cleanedLines.shift()
    }
    while (cleanedLines[cleanedLines.length - 1] === '') {
      cleanedLines.pop()
    }
    if (this.shouldStripTrailingWindowsPromptLine(terminalId, cleanedLines, output)) {
      cleanedLines.pop()
    }
    while (cleanedLines[cleanedLines.length - 1] === '') {
      cleanedLines.pop()
    }

    return cleanedLines.join('\n')
  }

  private isWindowsSshNoiseLine(line: string, task: CommandTask): boolean {
    if (!line) return false
    if (task.command && this.isEchoedCommandLine(line, task.command)) return true
    if (task.wireCommand && this.isEchoedCommandLine(line, task.wireCommand)) return true
    return false
  }

  private isEchoedCommandLine(line: string, command: string): boolean {
    const normalizedLine = this.normalizeCommandEchoComparison(line)
    const normalizedCommand = this.normalizeCommandEchoComparison(command)
    if (!normalizedLine || !normalizedCommand) {
      return false
    }

    return (
      normalizedLine === normalizedCommand ||
      normalizedLine.startsWith(`${normalizedCommand} `) ||
      normalizedLine.startsWith(`${normalizedCommand};`)
    )
  }

  private normalizeCommandEchoComparison(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
  }

  private sendToRenderer(channel: string, data: unknown): boolean {
    if (!this.rawEventPublisher) {
      console.warn(`[TerminalService] Missing rawEventPublisher, dropped event: ${channel}`)
      return false
    }
    try {
      this.rawEventPublisher(channel, data)
      return true
    } catch (error) {
      console.warn(
        `[TerminalService] raw event publisher failed for ${channel}:`,
        error
      )
      return false
    }
  }
}
