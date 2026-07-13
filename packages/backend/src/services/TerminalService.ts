import pkg from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
const { Terminal } = pkg
import path from 'path'
import os from 'os'
import type {
  TerminalBackend,
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
  resolveTerminalConnectionCapabilities,
} from './terminal/terminalConnectionSupport'
import { escapePowerShellSingleQuotedString } from './windowsPowerShellTracking'

const MAX_BUFFER_SIZE = 200000 // 200KB
const SCROLLBACK_SIZE = 5000 // Keep up to 5000 lines in virtual terminal
const PERSIST_FLUSH_DELAY_MS = 120
// We do NOT print any wrapper/marker commands in the terminal.
// Instead, we rely on shell integration hooks (installed at shell startup by NodePtyBackend)
// that emit invisible OSC markers on command boundaries.
const OSC_PRECMD_PREFIX = '\x1b]1337;gyshell_precmd'
const OSC_SUFFIX = '\x07'
const GYSHELL_READY_MARKER = '__GYSHELL_READY__'
const WINDOWS_TASK_FINISH_PREFIX = '__GYSHELL_TASK_FINISH__::'
const CONTROL_PREFIXES = [OSC_PRECMD_PREFIX, WINDOWS_TASK_FINISH_PREFIX] as const
const ANSI_CSI_SEQUENCE_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const ANSI_OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g
const OTHER_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g
const WINDOWS_PROMPT_ONLY_PATTERN = /^(?:PS [A-Za-z]:\\.*?>|[A-Za-z]:\\.*?>)\s*$/
const WINDOWS_PROMPT_PREFIX_PATTERN = /^(?:PS [A-Za-z]:\\.*?>|[A-Za-z]:\\.*?>)\s*/
const WINDOWS_NATIVE_PIPELINE_PATTERN = /\|/
const WINDOWS_POWERSHELL_SPECIAL_PATTERN = /[\$;{}()`]/
const WINDOWS_POWERSHELL_CMDLET_PATTERN = /\b[A-Za-z]+-[A-Za-z]+\b/
const COMMAND_TRACKING_FAILURE_MESSAGE =
  '[GyShell] Hidden command-tracking channel failed; the command may still be running in the terminal.'

function stripGyShellOscMarkers(s: string): string {
  return s.replace(/\x1b]1337;gyshell_(?:preexec|precmd)[^\x07]*\x07/g, '')
}

function stripGyShellTextMarkers(s: string): string {
  return s.replace(/__GYSHELL_TASK_FINISH__::[^\r\n]*(?:\r?\n|\r)?/g, '')
}

function stripInternalControlMarkers(s: string): string {
  if (!s.includes(GYSHELL_READY_MARKER)) return s
  return s.replace(/__GYSHELL_READY__/g, '')
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
}

export interface TerminalRenderMetadata {
  remoteOs?: 'unix' | 'windows'
  windowsRelease?: string
}

type RawEventPublisher = (channel: string, data: unknown) => void
type TerminalClosedListener = (terminalId: string) => void
type PendingTaskFinish = {
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
}

interface PromptFileIoLease {
  waitForTurn: Promise<void>
  release: () => void
}

interface TerminalInputSequenceOptions {
  intervalMs?: number
  signal?: AbortSignal
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
  private activeTaskByTerminal: Map<string, string> = new Map()
  private commandStartReservationByTerminal: Map<string, CommandStartReservation> = new Map()
  private deferredWritesDuringCommandStartByTerminal: Map<string, string[]> = new Map()
  private promptFileIoTailByTerminal: Map<string, Promise<void>> = new Map()
  private promptFileIoReleaseByCommandStartToken: Map<symbol, () => void> = new Map()
  private terminalInputSequenceTailByTerminal: Map<string, Promise<void>> = new Map()
  private oscParseBufByTerminal: Map<string, string> = new Map()
  private headlessWriteSeqByTerminal: Map<string, number> = new Map()
  private headlessFlushedSeqByTerminal: Map<string, number> = new Map()
  private pendingTaskFinishByTerminal: Map<string, PendingTaskFinish> = new Map()
  private backendRuntimeGenerationByTerminal: Map<string, number> = new Map()
  private nextBackendRuntimeGeneration = 0
  private startMarkerByTaskId: Map<string, any> = new Map()
  private commandTrackingWatcherByTaskId: Map<string, { cancelled: boolean }> = new Map()
  private onTaskFinishedCallbacks: Map<string, (result: CommandResult) => void> = new Map()
  private primaryLocalTerminalId: string | null = null
  private rawEventPublisher: RawEventPublisher | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly terminalStateStore: TerminalStateStore | null
  private commandTrackingPollIntervalMs = 250
  private commandTrackingMaxConsecutiveErrors = 8
  private commandTrackingPromptSyncPollIntervalMs = 50
  private syntheticCommandQuietWindowMs = 1000
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

  private registerBackendRuntimeHandlers(
    terminalId: string,
    terminalType: ConnectionType,
    ptyId: string
  ): void {
    this.nextBackendRuntimeGeneration += 1
    const runtimeGeneration = this.nextBackendRuntimeGeneration
    this.backendRuntimeGenerationByTerminal.set(
      terminalId,
      runtimeGeneration
    )
    const backend = this.getBackend(terminalType)
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
    backend.onData(ptyId, (data: string) => {
      if (!isCurrentRuntime()) return
      this.handleData(terminalId, data)
    })
    backend.onExit(ptyId, (code: number) => {
      if (!isCurrentRuntime()) return
      runtimeExited = true
      this.handleExit(terminalId, code)
    })
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

    const tab: TerminalTab = {
      id: config.id,
      ptyId: runtime.ptyId,
      title: config.title,
      cols: config.cols,
      rows: config.rows,
      type: config.type,
      capabilities: resolveTerminalConnectionCapabilities(config),
      isInitializing: config.type === 'ssh' || (config.type === 'local' && os.platform() === 'win32'), // Enable silence mode for SSH and local Windows
      runtimeState: config.type === 'ssh' || (config.type === 'local' && os.platform() === 'win32') ? 'initializing' : 'ready'
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
    code: number
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

    tab.isInitializing = os.platform() === 'win32'
    tab.runtimeState = tab.isInitializing ? 'initializing' : 'ready'
    tab.lastExitCode = undefined
    tab.capabilities = resolveTerminalConnectionCapabilities(restartConfig)
    this.terminalConfigs.set(terminalId, restartConfig)
    this.publishTerminalTabsChanged()

    try {
      const runtime = await this.spawnBackendRuntime(restartConfig)
      const nextConfig = runtime.config
      tab.ptyId = runtime.ptyId
      tab.title = nextConfig.title
      tab.cols = nextConfig.cols
      tab.rows = nextConfig.rows
      tab.type = nextConfig.type
      tab.capabilities = resolveTerminalConnectionCapabilities(nextConfig)
      tab.isInitializing = nextConfig.type === 'local' && os.platform() === 'win32'
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

  private handleData(terminalId: string, data: string): void {
    const sanitizedData = stripInternalControlMarkers(data)
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

    const suppressRawDisplay = this.shouldSuppressRawTaskDisplay(terminalId)
    const headless = this.headlessPtys.get(terminalId)
    let writeSeq = 0
    if (!suppressRawDisplay && headless && sanitizedData) {
      writeSeq = (this.headlessWriteSeqByTerminal.get(terminalId) || 0) + 1
      this.headlessWriteSeqByTerminal.set(terminalId, writeSeq)
      headless.write(sanitizedData, () => {
        const flushed = Math.max(this.headlessFlushedSeqByTerminal.get(terminalId) || 0, writeSeq)
        this.headlessFlushedSeqByTerminal.set(terminalId, flushed)
        this.tryFlushPendingTaskFinish(terminalId)
      })
    }

    // Process OSC markers and strip markers from visual output
    const cleanedData = this.processIncomingData(terminalId, sanitizedData, writeSeq)
    if (!suppressRawDisplay && cleanedData) {
      const buffer = this.buffers.get(terminalId)
      let currentOffset = 0
      if (buffer) {
        buffer.content += cleanedData
        buffer.offset += cleanedData.length
        currentOffset = buffer.offset

        if (buffer.content.length > MAX_BUFFER_SIZE) {
          const trimAmount = buffer.content.length - MAX_BUFFER_SIZE
          buffer.content = buffer.content.slice(trimAmount)
        }
      }

      this.sendToRenderer('terminal:data', {
        terminalId,
        data: cleanedData,
        offset: currentOffset,
        ...this.getRenderMetadata(terminalId)
      })
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
    return this.getActiveTask(terminalId)?.displayMode === 'synthetic-transcript'
  }

  private appendSyntheticDisplayData(terminalId: string, data: string): void {
    if (!data) {
      return
    }

    const headless = this.headlessPtys.get(terminalId)
    if (headless) {
      const writeSeq = (this.headlessWriteSeqByTerminal.get(terminalId) || 0) + 1
      this.headlessWriteSeqByTerminal.set(terminalId, writeSeq)
      headless.write(data, () => {
        const flushed = Math.max(this.headlessFlushedSeqByTerminal.get(terminalId) || 0, writeSeq)
        this.headlessFlushedSeqByTerminal.set(terminalId, flushed)
      })
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

    this.sendToRenderer('terminal:data', {
      terminalId,
      data,
      offset: currentOffset,
      ...this.getRenderMetadata(terminalId)
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
      return `PS ${cwd.replace(/\//g, '\\')}> `
    }

    return terminal.remoteOs === 'windows' ? 'PS> ' : ''
  }

  private hasVisibleWindowsPromptLine(terminalId: string): boolean {
    return Boolean(this.getVisibleWindowsPromptLine(terminalId))
  }

  private buildSyntheticTaskPrelude(terminalId: string, terminal: TerminalTab, command: string): string {
    const promptPrefix = this.resolveVisibleWindowsPromptPrefix(terminalId, terminal)
    const clearCurrentPrompt = this.hasVisibleWindowsPromptLine(terminalId)
    return `${clearCurrentPrompt ? '\x1b[2K\r' : ''}${promptPrefix}${command}\r\n`
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

      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  private processIncomingData(terminalId: string, rawChunk: string, writeSeq: number): string {
    let buf = this.oscParseBufByTerminal.get(terminalId) || ''
    buf += rawChunk

    let cleanedData = ''

    while (buf.length > 0) {
      const precmdIdx = buf.indexOf(OSC_PRECMD_PREFIX)
      const windowsTaskIdx = this.findWindowsTaskMarkerIndex(buf)
      const nextControlIdx = this.findNextControlIndex(precmdIdx, windowsTaskIdx)

      if (nextControlIdx === -1) {
        const suffixLength = this.getTrailingControlPrefixLength(buf)
        const flushable = suffixLength > 0 ? buf.slice(0, -suffixLength) : buf
        const cleaned = stripGyShellOscMarkers(flushable)
        cleanedData += cleaned
        this.appendActiveTaskOutput(terminalId, cleaned)
        buf = suffixLength > 0 ? buf.slice(-suffixLength) : ''
        break
      }

      const before = buf.slice(0, nextControlIdx)
      const cleanedBefore = stripGyShellOscMarkers(before)
      cleanedData += cleanedBefore
      this.appendActiveTaskOutput(terminalId, cleanedBefore)

      if (nextControlIdx === precmdIdx) {
        const suffixIdx = buf.indexOf(OSC_SUFFIX, precmdIdx)
        if (suffixIdx === -1) {
          // Wait for the rest of the marker in the next chunk.
          buf = buf.slice(precmdIdx)
          break
        }

        const markerContent = buf.slice(precmdIdx, suffixIdx)
        const ecMatch = markerContent.match(/ec=(-?\d+)/)
        const exitCode = ecMatch ? parseInt(ecMatch[1], 10) : undefined

        this.scheduleTaskFinishAfterHeadlessFlush(terminalId, exitCode, writeSeq)

        buf = buf.slice(suffixIdx + OSC_SUFFIX.length)
        continue
      }

      const lineBreakMatch = buf.slice(windowsTaskIdx).match(/\r\n|\n|\r/)
      if (!lineBreakMatch || lineBreakMatch.index === undefined) {
        buf = buf.slice(windowsTaskIdx)
        break
      }

      const markerEnd = windowsTaskIdx + lineBreakMatch.index
      const markerContent = buf.slice(windowsTaskIdx, markerEnd)
      const marker = this.parseWindowsTaskFinishMarker(markerContent)
      const activeTaskId = this.activeTaskByTerminal.get(terminalId)
      if (
        marker &&
        activeTaskId &&
        (!marker.taskId || marker.taskId === activeTaskId)
      ) {
        this.scheduleTaskFinishAfterHeadlessFlush(terminalId, marker.exitCode, writeSeq)
      }

      buf = buf.slice(markerEnd + lineBreakMatch[0].length)
    }

    this.oscParseBufByTerminal.set(terminalId, buf)
    return cleanedData
  }

  private findNextControlIndex(...indices: number[]): number {
    return indices
      .filter((index) => index >= 0)
      .reduce((smallest, index) => (smallest === -1 || index < smallest ? index : smallest), -1)
  }

  private findWindowsTaskMarkerIndex(value: string): number {
    return value.indexOf(WINDOWS_TASK_FINISH_PREFIX)
  }

  private getTrailingControlPrefixLength(value: string): number {
    const upperBound = Math.min(
      value.length,
      Math.max(...CONTROL_PREFIXES.map((prefix) => prefix.length - 1))
    )

    for (let length = upperBound; length > 0; length -= 1) {
      if (CONTROL_PREFIXES.some((prefix) => value.endsWith(prefix.slice(0, length)))) {
        return length
      }
    }

    return 0
  }

  private parseWindowsTaskFinishMarker(
    markerContent: string
  ): { taskId?: string; exitCode?: number } | null {
    const normalizedMarkerContent = markerContent
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .trim()
    const match = normalizedMarkerContent.match(/^__GYSHELL_TASK_FINISH__::(?:(.+?);)?ec=(-?\d+)$/)
    if (!match) {
      return null
    }

    return {
      taskId: match[1] || undefined,
      exitCode: match[2] !== undefined ? parseInt(match[2], 10) : undefined
    }
  }

  private scheduleTaskFinishAfterHeadlessFlush(terminalId: string, exitCode: number | undefined, writeSeq: number): void {
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

    this.pendingTaskFinishByTerminal.set(terminalId, {
      requiredWriteSeq: writeSeq,
      exitCode
    })
  }

  private tryFlushPendingTaskFinish(terminalId: string): void {
    const pending = this.pendingTaskFinishByTerminal.get(terminalId)
    if (!pending) return
    const flushedSeq = this.headlessFlushedSeqByTerminal.get(terminalId) || 0
    if (flushedSeq < pending.requiredWriteSeq) return
    this.pendingTaskFinishByTerminal.delete(terminalId)
    this.finishActiveTask(terminalId, pending.exitCode)
  }

  private disposeTaskStartMarker(taskId: string): void {
    const marker = this.startMarkerByTaskId.get(taskId)
    this.startMarkerByTaskId.delete(taskId)
    if (marker && typeof marker.dispose === 'function') {
      try {
        marker.dispose()
      } catch {
        // Marker disposal is best-effort and must not hide the command outcome.
      }
    }
  }

  private handleExit(terminalId: string, code: number): void {
    // A command still preparing against this runtime must not block a
    // replacement runtime that reuses the same terminal id. Its generation
    // check will prevent any late dispatch.
    this.cancelCommandStartReservation(terminalId)
    const tab = this.terminals.get(terminalId)
    
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
        const retainedOutput = this.resolveFinalTaskOutput(terminalId, task, tab)
        task.output = retainedOutput || 'Terminal exited before command completion.'
        task.status = 'aborted'
        task.endTime = Date.now()
        task.exitCode = typeof code === 'number' ? code : -1
        task.runtimeBoundary = true
        task.endOffset = task.startOffset + task.output.length
        if (!task.suppressFinishCallback) {
          exitResult = {
            stdoutDelta: task.output,
            exitCode: task.exitCode,
            history_command_match_id: activeTaskId,
            runtimeBoundary: true
          }
        }
      }
      this.stopCommandTrackingWatcher(activeTaskId)
      this.activeTaskByTerminal.delete(terminalId)
      this.disposeTaskStartMarker(activeTaskId)
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
    }
    this.terminalInputSequenceTailByTerminal.delete(terminalId)
    this.pendingTaskFinishByTerminal.delete(terminalId)
    this.pendingResizeByTerminal.delete(terminalId)
    this.headlessWriteSeqByTerminal.delete(terminalId)
    this.headlessFlushedSeqByTerminal.delete(terminalId)

    // UI lifecycle is user-driven. Do not auto-remove tab metadata on backend exit.
    // We only update runtime state and keep captured output until user closes the tab.
    if (tab) {
      if (
        tab.type === 'local' &&
        tab.runtimeState !== 'exited' &&
        !this.terminalIdsBeingKilled.has(terminalId)
      ) {
        void this.restartLocalTerminalAfterExit(terminalId, code)
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

  private canWriteToTerminal(terminal: TerminalTab): boolean {
    if (terminal.type === 'local') {
      return terminal.runtimeState !== 'exited'
    }
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
    }
  ): Promise<void> | undefined {
    if (!this.promptFileIoTailByTerminal.has(terminalId)) {
      return undefined
    }

    const runtimePtyId = terminal.ptyId
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)
    const promptFileIo = this.reservePromptFileIo(terminalId)
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
        backend.write(runtimePtyId, data)
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
      backend.write(terminal.ptyId, data)
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
    const runtimePtyId = terminal.ptyId
    const runtimeGeneration =
      this.backendRuntimeGenerationByTerminal.get(terminalId)

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
              rejectOnRuntimeChange: true
            }
          )
          if (queuedWrite) {
            await queuedWrite
          } else {
            const backend = this.getBackend(currentTerminal.type)
            backend.write(runtimePtyId, sequence[index])
          }
          break
        }
        if (index < sequence.length - 1 && intervalMs > 0) {
          await waitForTerminalDelay(intervalMs, options?.signal)
        }
      }
    } finally {
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
      
      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.dispose()
        this.headlessPtys.delete(terminalId)
      }

      // Thoroughly cleanup all memory state for this terminal
      this.terminals.delete(terminalId)
      this.buffers.delete(terminalId)
      this.selectionByTerminal.delete(terminalId)
      this.oscParseBufByTerminal.delete(terminalId)
      this.backendRuntimeGenerationByTerminal.delete(terminalId)
      if (activeTaskId) {
        if (activeTask && activeTask.status !== 'finished') {
          const terminalClosedMessage = 'Terminal tab was closed.'
          const retainedOutput = (activeTask.output || '').trimEnd()
          activeTask.output =
            !retainedOutput ||
            retainedOutput === 'Terminal exited before command completion.'
              ? terminalClosedMessage
              : retainedOutput.includes(terminalClosedMessage)
                ? retainedOutput
                : `${retainedOutput}\n\n${terminalClosedMessage}`
          activeTask.status = 'aborted'
          activeTask.endTime = Date.now()
          activeTask.exitCode = -2
          activeTask.runtimeBoundary = true
          activeTask.endOffset =
            activeTask.startOffset + (activeTask.output?.length || 0)
        }
        this.stopCommandTrackingWatcher(activeTaskId)
        this.disposeTaskStartMarker(activeTaskId)
      }
      this.activeTaskByTerminal.delete(terminalId)
      this.cancelCommandStartReservation(terminalId)
      this.terminalInputSequenceTailByTerminal.delete(terminalId)
      const activeTaskCloseResult: CommandResult | undefined = activeTaskId
        ? {
            stdoutDelta: activeTask?.output || 'Terminal tab was closed.',
            exitCode: -2,
            history_command_match_id: activeTaskId,
            runtimeBoundary: true
          }
        : undefined
      this.tasksByTerminal.delete(terminalId)
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
      return stripGyShellTextMarkers(allLines.slice(start).join('\n'))
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
    
    return stripGyShellTextMarkers(result.join('\n'))
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

    return {
      id: terminal.id,
      title: terminal.title,
      type: terminal.type,
      runtimeState,
      isInitializing: terminal.isInitializing === true,
      lastExitCode: terminal.lastExitCode,
      reconnectable: this.isTerminalReconnectable(terminalId),
      canRunCommand: isReady,
      canWrite: this.canWriteToTerminal(terminal),
      canUseFilesystem: this.canUseFilesystemForTerminal(terminal)
    }
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
    const tab = this.terminals.get(terminalId)
    if (!tab || tab.isInitializing) return undefined
    const taskMap = this.tasksByTerminal.get(terminalId)
    return taskMap ? taskMap[commandId] : undefined
  }

  getCommandTasks(terminalId: string): CommandTask[] {
    const tab = this.terminals.get(terminalId)
    if (!tab || tab.isInitializing) return []
    const taskMap = this.tasksByTerminal.get(terminalId)
    if (!taskMap) return []
    return Object.values(taskMap).sort((a, b) => b.startTime - a.startTime)
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

  private buildDispatchedCommand(_terminal: TerminalTab, command: string, _taskId: string): string {
    return command
  }

  private async prepareCommandTracking(
    terminal: TerminalTab
  ): Promise<TerminalCommandTrackingToken | undefined> {
    const backend = this.getBackend(terminal.type)
    if (typeof backend.prepareCommandTracking !== 'function') {
      return undefined
    }
    try {
      return await backend.prepareCommandTracking(terminal.ptyId)
    } catch {
      return undefined
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
    if (activeTask && update.output !== undefined) {
      activeTask.capturedOutput = update.output
    }
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      return
    }
    if (update.cwd || update.homeDir) {
      this.hydrateTerminalRuntimeMetadata(terminalId)
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
    while (true) {
      if (this.activeTaskByTerminal.get(terminalId) !== taskId) {
        return
      }
      if (this.isWindowsPromptRendered(terminalId, cwd)) {
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

    const poll = async (): Promise<void> => {
      let consecutivePollErrors = 0
      try {
        while (!watcher.cancelled) {
          const activeTaskId = this.activeTaskByTerminal.get(terminal.id)
          const task = this.getTaskMap(terminal.id)[taskId]
          if (!task || task.status !== 'running' || activeTaskId !== taskId) {
            return
          }

          try {
            const update = await backend.pollCommandTracking!(terminal.ptyId, token)
            consecutivePollErrors = 0
            if (update) {
              this.applyCommandTrackingUpdate(terminal.id, update)
              if (task.displayMode === 'synthetic-transcript') {
                await this.maybeCaptureWindowsSyntheticFallbackOutput(terminal, task, update)
              }
              if (task.displayMode === 'synthetic-transcript') {
                await this.waitForSyntheticTaskOutputQuiescence(terminal.id, taskId)
              } else {
                await this.waitForWindowsPromptSync(terminal.id, taskId, update.cwd)
              }
              this.finishActiveTask(terminal.id, update.exitCode)
              return
            }
          } catch {
            consecutivePollErrors += 1
            if (consecutivePollErrors >= this.commandTrackingMaxConsecutiveErrors) {
              this.failActiveTaskDueToTrackingLoss(terminal.id)
              return
            }
          }

          await new Promise((resolve) => setTimeout(resolve, this.commandTrackingPollIntervalMs))
        }
      } finally {
        this.commandTrackingWatcherByTaskId.delete(taskId)
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

    while (true) {
      if (task.status === 'finished') {
        return {
          stdoutDelta: task.output || '',
          exitCode: task.exitCode ?? -1,
          history_command_match_id: taskId,
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
        return { stdoutDelta: 'Command aborted by user.', exitCode: -2, history_command_match_id: taskId }
      }

      if (task.status === 'aborted') {
        return {
          stdoutDelta: task.output || 'Command aborted because the terminal session ended.',
          exitCode: task.exitCode ?? (task.runtimeBoundary ? -1 : -2),
          history_command_match_id: taskId,
          ...(task.runtimeBoundary ? { runtimeBoundary: true } : {})
        }
      }
      // Check if user manually skipped the wait after honoring a just-finished task.
      if (opts?.shouldSkip?.()) {
        clearSuppressionIfStillRunning()
        return {
          stdoutDelta: 'USER_SKIPPED_WAIT',
          exitCode: -3,
          history_command_match_id: taskId
        }
      }

      if (Date.now() - startTime > timeoutMs) {
        clearSuppressionIfStillRunning()
        return {
          stdoutDelta: 'Command timed out (120s). The process is still running in the background.',
          exitCode: -1,
          history_command_match_id: taskId
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

    const reservationToken = this.reserveCommandStart(terminalId, command)
    try {
      return await this.executeReservedCommand(
        terminal,
        command,
        type,
        onFinished,
        signal,
        reservationToken
      )
    } finally {
      const releasePromptFileIo =
        this.promptFileIoReleaseByCommandStartToken.get(reservationToken)
      this.promptFileIoReleaseByCommandStartToken.delete(reservationToken)
      releasePromptFileIo?.()
      this.releaseCommandStart(terminalId, reservationToken)
    }
  }

  private reservePromptFileIo(
    terminalId: string,
    reservationToken?: symbol
  ): PromptFileIoLease {
    const predecessor =
      this.promptFileIoTailByTerminal.get(terminalId) ?? Promise.resolve()
    let releaseTurn: () => void = () => {}
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const queuedTail = predecessor.then(() => turn)
    this.promptFileIoTailByTerminal.set(terminalId, queuedTail)

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      releaseTurn()
      void queuedTail.then(() => {
        if (this.promptFileIoTailByTerminal.get(terminalId) === queuedTail) {
          this.promptFileIoTailByTerminal.delete(terminalId)
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
    reservation?.releaseWaiters()
  }

  private releaseCommandStart(terminalId: string, token: symbol): void {
    const reservation =
      this.commandStartReservationByTerminal.get(terminalId)
    if (reservation?.token !== token) return

    this.commandStartReservationByTerminal.delete(terminalId)
    const deferred =
      this.deferredWritesDuringCommandStartByTerminal.get(terminalId) || []
    this.deferredWritesDuringCommandStartByTerminal.delete(terminalId)
    try {
      const terminal = this.terminals.get(terminalId)
      if (terminal && this.canWriteToTerminal(terminal)) {
        for (const data of deferred) {
          try {
            this.write(terminalId, data)
          } catch (error) {
            // The command is already dispatched and tracked. A failed manual
            // input replay must not replace its task id with an exception.
            console.warn(
              `[TerminalService] Failed to replay input deferred during command startup for ${terminalId}.`,
              error
            )
          }
        }
      }
    } finally {
      reservation.releaseWaiters()
    }
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
    const completionTracking = await this.prepareCommandTracking(terminal)
    throwIfTerminalOperationAborted(signal)
    const wireCommand = this.buildDispatchedCommand(terminal, command, taskId)

    const backend = this.getBackend(terminal.type)
    const eol = terminal.remoteOs === 'windows' ? '\r' : '\n'
    let usedPromptFileDispatch = false
    let promptRequestPending = false
    let promptRequestCleanup: (() => Promise<boolean>) | undefined
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
    const usesPromptFileDispatch = Boolean(
      completionTracking?.dispatchMode === 'prompt-file' &&
      completionTracking.commandRequestPath &&
      isTerminalFileSystemBackend(backend)
    )
    if (
      usesPromptFileDispatch ||
      this.promptFileIoTailByTerminal.has(terminalId)
    ) {
      const promptFileIo = this.reservePromptFileIo(
        terminalId,
        reservationToken
      )
      // Request-file writes are not cancellable and SSH reconnects may reuse
      // both the pty id and request path. Keep later generations behind this
      // fence until the previous write/cleanup has fully settled.
      await promptFileIo.waitForTurn
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
          await backend.writeFile(
            runtimePtyId,
            completionTracking.commandRequestPath!,
            ''
          )
          return true
        } catch (cleanupError) {
          // A stale request file is unsafe. Quarantine the tab before trying
          // to close its runtime so even a throwing/no-op kill cannot release
          // deferred or future input into the abandoned prompt hook.
          const currentTerminal = this.terminals.get(terminalId)
          if (currentTerminal) {
            this.deferredWritesDuringCommandStartByTerminal.delete(terminalId)
            currentTerminal.isInitializing = false
            currentTerminal.runtimeState = 'exited'
            currentTerminal.lastExitCode = -1
            this.terminalIdsBeingKilled.add(terminalId)
            try {
              this.getBackend(currentTerminal.type).kill(currentTerminal.ptyId)
            } catch {
              // The quarantined runtime remains non-writable even when the
              // backend cannot confirm termination.
            } finally {
              this.terminalIdsBeingKilled.delete(terminalId)
            }
            this.publishTerminalTabsChanged()
            this.schedulePersistTerminalState()
          }
          console.warn(
            `[TerminalService] Failed to clear a pending prompt-file command for ${terminalId}; quarantined the current terminal runtime.`,
            cleanupError
          )
          return false
        }
      }
      const requestPayload = Buffer.from(command, 'utf8').toString('base64')
      let promptWriteSucceeded = false
      promptRequestPending = true
      try {
        // The backend file write is not cancellable. Await it while retaining
        // the per-terminal start reservation; otherwise a late write can leave
        // a command that the next PowerShell prompt executes unexpectedly.
        await backend.writeFile(
          runtimePtyId,
          completionTracking.commandRequestPath,
          requestPayload
        )
        promptWriteSucceeded = true
      } catch (writeError) {
        const cleared = await clearPendingPromptRequest()
        if (signal?.aborted) {
          throwIfTerminalOperationAborted(signal)
        }
        if (!cleared) {
          throw writeError
        }
        usedPromptFileDispatch = false
      }
      if (signal?.aborted) {
        await clearPendingPromptRequest()
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

    const headless = this.headlessPtys.get(terminalId)
    const task: CommandTask = {
      id: taskId,
      command,
      wireCommand,
      completionTracking,
      type,
      status: 'running',
      startOffset,
      startTime: Date.now(),
      output: '',
      // Scheme 1: Record start line in headless buffer
      startAbsLine: headless
        ? headless.buffer.active.baseY + headless.buffer.active.cursorY
        : undefined
    }
    const taskMap = this.getTaskMap(terminalId)
    taskMap[taskId] = task
    if (headless && typeof (headless as any).registerMarker === 'function') {
      const marker = (headless as any).registerMarker(0)
      if (marker) this.startMarkerByTaskId.set(taskId, marker)
    }
    this.activeTaskByTerminal.set(terminalId, taskId)
    if (onFinished) this.onTaskFinishedCallbacks.set(taskId, onFinished)

    try {
      backend.write(
        runtimePtyId,
        usedPromptFileDispatch ? eol : `${wireCommand}${eol}`
      )
    } catch (error) {
      delete taskMap[taskId]
      if (this.activeTaskByTerminal.get(terminalId) === taskId) {
        this.activeTaskByTerminal.delete(terminalId)
      }
      this.onTaskFinishedCallbacks.delete(taskId)
      this.disposeTaskStartMarker(taskId)
      await clearPendingPromptRequest()
      throw error
    }
    promptRequestPending = false

    if (usedPromptFileDispatch && completionTracking?.displayMode === 'synthetic-transcript') {
      task.displayMode = 'synthetic-transcript'
      this.appendSyntheticDisplayData(
        terminalId,
        this.buildSyntheticTaskPrelude(terminalId, terminal, command)
      )
    }
    if (completionTracking) {
      completionTracking.dispatchedAtMs = Date.now()
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
    task.output = (task.output || '') + chunk
    task.lastOutputAtMs = Date.now()
  }

  private resolveFinalTaskOutput(terminalId: string, task: CommandTask, terminal?: TerminalTab): string {
    const rawRenderedOutput = this.getRenderedTaskOutput(terminalId, task)
    const renderedOutput =
      rawRenderedOutput !== undefined
        ? this.normalizeFinishedTaskOutput(terminalId, terminal, task, rawRenderedOutput)
        : undefined
    const streamedOutput = this.normalizeFinishedTaskOutput(terminalId, terminal, task, task.output || '')
    if (task.displayMode === 'synthetic-transcript') {
      const hasCapturedOutput = task.capturedOutput !== undefined
      const syntheticSource = hasCapturedOutput ? task.capturedOutput || '' : task.output || ''
      const normalizedSyntheticOutput = this.normalizeSyntheticWindowsTaskOutput(syntheticSource, task, {
        source: hasCapturedOutput ? 'captured' : 'raw'
      })
      if (hasCapturedOutput) {
        return normalizedSyntheticOutput
      }
      return normalizedSyntheticOutput || renderedOutput || ''
    }
    if (terminal?.remoteOs === 'windows') {
      return this.selectWindowsTaskOutput(renderedOutput, streamedOutput, task)
    }
    if (renderedOutput !== undefined) {
      const renderedHasContent = renderedOutput.trim().length > 0
      return renderedHasContent || !streamedOutput ? renderedOutput : streamedOutput
    }
    return streamedOutput
  }

  private finalizeActiveTask(
    terminalId: string,
    options?: {
      exitCode?: number
      outputOverride?: string
      runtimeBoundary?: boolean
    }
  ): void {
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) return
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || (task.status !== 'running' && task.status !== 'timeout')) return
    const terminal = this.terminals.get(terminalId)
    task.output = options?.outputOverride ?? this.resolveFinalTaskOutput(terminalId, task, terminal)
    const syntheticDisplay =
      terminal && task.displayMode === 'synthetic-transcript'
        ? this.buildSyntheticTaskCompletionDisplay(terminalId, terminal, task.output)
        : undefined

    task.status = 'finished'
    task.endTime = Date.now()
    task.exitCode = options?.exitCode
    task.runtimeBoundary = options?.runtimeBoundary === true
    task.endOffset = task.startOffset + task.output.length

    this.stopCommandTrackingWatcher(taskId)
    this.activeTaskByTerminal.delete(terminalId)
    this.pendingTaskFinishByTerminal.delete(terminalId)
    if (syntheticDisplay) {
      this.appendSyntheticDisplayData(terminalId, syntheticDisplay)
    }

    const callback = this.onTaskFinishedCallbacks.get(taskId)
    if (callback) {
      this.onTaskFinishedCallbacks.delete(taskId)
    }
    if (callback && !task.suppressFinishCallback) {
      callback({
        stdoutDelta: task.output,
        exitCode: options?.exitCode,
        history_command_match_id: taskId,
        ...(task.runtimeBoundary ? { runtimeBoundary: true } : {})
      })
    }
  }

  private finishActiveTask(terminalId: string, exitCode?: number): void {
    this.finalizeActiveTask(terminalId, { exitCode })
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
    const terminal = this.terminals.get(terminalId)
    const currentOutput = this.resolveFinalTaskOutput(terminalId, task, terminal)
    const outputOverride = currentOutput
      ? `${currentOutput}\n\n${COMMAND_TRACKING_FAILURE_MESSAGE}`
      : COMMAND_TRACKING_FAILURE_MESSAGE
    this.finalizeActiveTask(terminalId, {
      exitCode: -1,
      outputOverride,
      runtimeBoundary: true
    })
  }

  private getRenderedTaskOutput(terminalId: string, task: CommandTask): string | undefined {
    const headless = this.headlessPtys.get(terminalId)
    if (!headless) return undefined
    const buffer = headless.buffer.active
    if (!buffer) return undefined

    const marker = this.startMarkerByTaskId.get(task.id)
    const markerLine = marker && typeof marker.line === 'number' ? marker.line : undefined
    this.disposeTaskStartMarker(task.id)

    const startAbsLineFromMarker = markerLine !== undefined && markerLine >= 0 ? markerLine : undefined
    const startAbsLine = startAbsLineFromMarker !== undefined ? startAbsLineFromMarker : task.startAbsLine
    if (startAbsLine === undefined) return undefined

    const endAbsLine = buffer.baseY + buffer.cursorY
    const start = Math.max(0, startAbsLine)
    if (endAbsLine < start) return ''

    const lines: string[] = []
    for (let i = start; i <= endAbsLine; i++) {
      const line = buffer.getLine(i)
      if (line) {
        lines.push(line.translateToString(true))
      }
    }
    return lines.join('\n').trimEnd()
  }

  private markTaskAborted(terminalId: string, taskId: string): void {
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || task.status !== 'running') return
    task.status = 'aborted'
    task.endTime = Date.now()
    task.exitCode = -2
    task.endOffset = task.startOffset + (task.output?.length || 0)
    this.stopCommandTrackingWatcher(taskId)
    this.activeTaskByTerminal.delete(terminalId)
    this.onTaskFinishedCallbacks.delete(taskId)
    this.disposeTaskStartMarker(taskId)
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
      stripGyShellTextMarkers(stripGyShellOscMarkers(output)),
      task.command,
      task.wireCommand
    )
    if (terminal?.remoteOs === 'windows') {
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
      return output
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => stripTerminalControlSequences(line).replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/^\n+/g, '')
        .replace(/\n+$/g, '')
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

  private shouldUseWindowsNativeFallbackCapture(task: CommandTask): boolean {
    const command = String(task.command || '').trim()
    if (!command) {
      return false
    }
    if (!WINDOWS_NATIVE_PIPELINE_PATTERN.test(command)) {
      return false
    }
    if (WINDOWS_POWERSHELL_SPECIAL_PATTERN.test(command)) {
      return false
    }
    return !WINDOWS_POWERSHELL_CMDLET_PATTERN.test(command)
  }

  private async maybeCaptureWindowsSyntheticFallbackOutput(
    terminal: TerminalTab,
    task: CommandTask,
    update: TerminalCommandTrackingUpdate
  ): Promise<void> {
    const currentOutput = task.capturedOutput
    if (!this.shouldUseWindowsNativeFallbackCapture(task)) {
      return
    }
    if (typeof currentOutput === 'string' && currentOutput.trim().length > 0) {
      return
    }
    const backend = this.getBackend(terminal.type)
    if (typeof backend.execOnSession !== 'function') {
      return
    }

    const commandB64 = Buffer.from(task.command, 'utf8').toString('base64')
    const fallbackScript = [
      '$__gyshell_utf8=[Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding=$__gyshell_utf8',
      '$OutputEncoding=$__gyshell_utf8',
      `$__gyshell_cmd_b64='${commandB64}'`,
      '$__gyshell_cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__gyshell_cmd_b64))',
      '$ProgressPreference=\'SilentlyContinue\'',
      update.cwd
        ? `$__gyshell_cwd='${escapePowerShellSingleQuotedString(update.cwd.replace(/\//g, '\\'))}'`
        : '',
      update.cwd ? 'Set-Location -LiteralPath $__gyshell_cwd' : '',
      '. ([scriptblock]::Create($__gyshell_cmd))'
    ]
      .filter(Boolean)
      .join(';')
    const encodedScript = Buffer.from(fallbackScript, 'utf16le').toString('base64')
    const fallbackCommand =
      `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`

    try {
      const fallbackResult = await backend.execOnSession(
        terminal.ptyId,
        fallbackCommand,
        30000
      )
      const stdout = String(fallbackResult?.stdout || '')
      if (stdout.trim().length > 0) {
        task.capturedOutput = stdout
      }
    } catch {
      // Keep the primary captured output path result when the hidden fallback fails.
    }
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
    if (line.startsWith(WINDOWS_TASK_FINISH_PREFIX)) return true
    if (line.includes('__GYSHELL_READY__')) return true
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

  private selectWindowsTaskOutput(
    renderedOutput: string | undefined,
    streamedOutput: string,
    task: CommandTask
  ): string {
    if (renderedOutput && WINDOWS_PROMPT_ONLY_PATTERN.test(renderedOutput.trim())) {
      return streamedOutput || ''
    }

    const renderedSignal = this.measureTaskOutputSignal(renderedOutput)
    const streamedSignal = this.measureTaskOutputSignal(streamedOutput)

    if (renderedSignal > 0 && this.looksLikeWindowsCommandEchoPollution(streamedOutput, task)) {
      return renderedOutput || ''
    }
    if (streamedSignal > renderedSignal) {
      return streamedOutput
    }
    if (renderedSignal > 0) {
      return renderedOutput || ''
    }
    return streamedOutput || renderedOutput || ''
  }

  private measureTaskOutputSignal(output: string | undefined): number {
    if (!output) return 0
    return output.replace(/\s+/g, '').length
  }

  private looksLikeWindowsCommandEchoPollution(output: string, task: CommandTask): boolean {
    const command = this.normalizeCommandEchoComparison(task.command || task.wireCommand || '')
    const normalizedOutput = this.normalizeCommandEchoComparison(output)
    if (!command || !normalizedOutput) {
      return false
    }
    if (
      normalizedOutput.includes(command) &&
      normalizedOutput !== command
    ) {
      return true
    }

    const commandWords = command.split(/\s+/).filter(Boolean)
    const echoPrefix = commandWords.slice(0, 2).join(' ')
    if (!echoPrefix) {
      return false
    }
    return normalizedOutput.split(echoPrefix).length - 1 >= 2
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (!this.rawEventPublisher) {
      console.warn(`[TerminalService] Missing rawEventPublisher, dropped event: ${channel}`)
      return
    }
    this.rawEventPublisher(channel, data)
  }
}
