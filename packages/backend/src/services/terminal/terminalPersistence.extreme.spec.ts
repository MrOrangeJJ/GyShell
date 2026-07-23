import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  FileStatInfo,
  FileSystemEntry,
  TerminalBackend,
  TerminalCommandShellFamily,
  TerminalConfig,
  TerminalSystemInfo,
} from '../../types'
import { TerminalService } from '../TerminalService'
import { TerminalStateStore } from './TerminalStateStore'
import { createAutoTerminalConfig } from './terminalConnectionSupport'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertRejects = async (
  action: Promise<unknown>,
  expectedMessage: RegExp,
  message: string,
): Promise<void> => {
  try {
    await action
    throw new Error(`${message}. expected promise rejection`)
  } catch (error) {
    const actualMessage =
      error instanceof Error ? error.message : String(error)
    if (!expectedMessage.test(actualMessage)) {
      throw new Error(
        `${message}. expected=${String(expectedMessage)} actual=${actualMessage}`
      )
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

type FakeSession = {
  id: string
  cwd: string
  dataCallbacks: Array<(data: string) => void>
  exitCallbacks: Array<(code: number) => void>
}

class FakeTerminalBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()
  private readonly spawnFailures = new Set<string>()
  private readonly remoteOsByPtyId = new Map<string, 'unix' | 'windows' | undefined>()
  private readonly systemInfoByPtyId = new Map<string, TerminalSystemInfo | undefined>()
  private readonly delayedSystemInfoPtyIds = new Set<string>()
  private readonly delayedSystemInfoResolversByPtyId = new Map<
    string,
    Array<(info: TerminalSystemInfo | undefined) => void>
  >()
  private readonly initializationStateByPtyId = new Map<
    string,
    'initializing' | 'ready' | 'failed'
  >()
  private readonly homeDirByPtyId = new Map<string, string>()
  private readonly refreshCallbacksByPtyId = new Map<string, () => Promise<void> | void>()
  private readonly listDirectoryCalls: Array<{ ptyId: string; dirPath: string }> = []
  private readonly spawnConfigs: TerminalConfig[] = []
  private readonly resizeCalls: Array<{ ptyId: string; cols: number; rows: number }> = []
  private readonly writeCalls: Array<{ ptyId: string; data: string }> = []
  private readonly commandShellFamilyByPtyId = new Map<
    string,
    TerminalCommandShellFamily
  >()
  private spawnDelayMs = 0
  private emitExitOnKill = true
  private throwOnKill = false

  private getPtyIdForTerminalId(terminalId: string): string {
    return `pty-${terminalId}`
  }

  private createDefaultSystemInfo(
    remoteOs: 'unix' | 'windows',
    isRemote: boolean
  ): TerminalSystemInfo {
    if (remoteOs === 'windows') {
      return {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.19045',
        arch: 'x64',
        hostname: 'test-win',
        isRemote,
        shell: 'powershell.exe'
      }
    }

    return {
      os: 'unix',
      platform: 'linux',
      release: 'test',
      arch: 'x64',
      hostname: 'test',
      isRemote
    }
  }

  setRemoteOsForTerminalId(terminalId: string, remoteOs: 'unix' | 'windows' | undefined): void {
    this.remoteOsByPtyId.set(this.getPtyIdForTerminalId(terminalId), remoteOs)
  }

  setSystemInfoForTerminalId(terminalId: string, systemInfo: TerminalSystemInfo | undefined): void {
    this.systemInfoByPtyId.set(this.getPtyIdForTerminalId(terminalId), systemInfo)
  }

  delaySystemInfoForTerminalId(terminalId: string): void {
    this.delayedSystemInfoPtyIds.add(this.getPtyIdForTerminalId(terminalId))
  }

  resolveNextSystemInfoForTerminalId(
    terminalId: string,
    systemInfo: TerminalSystemInfo | undefined
  ): void {
    const ptyId = this.getPtyIdForTerminalId(terminalId)
    const resolvers = this.delayedSystemInfoResolversByPtyId.get(ptyId)
    const resolve = resolvers?.shift()
    if (!resolve) {
      throw new Error(`No delayed system-info request for ${terminalId}`)
    }
    resolve(systemInfo)
  }

  setCwdForTerminalId(terminalId: string, cwd: string): void {
    const session = this.sessions.get(this.getPtyIdForTerminalId(terminalId))
    if (session) {
      session.cwd = cwd
    }
  }

  setHomeDirForTerminalId(terminalId: string, homeDir: string): void {
    this.homeDirByPtyId.set(this.getPtyIdForTerminalId(terminalId), homeDir)
  }

  setRefreshSessionStateForTerminalId(
    terminalId: string,
    callback: () => Promise<void> | void
  ): void {
    this.refreshCallbacksByPtyId.set(this.getPtyIdForTerminalId(terminalId), callback)
  }

  getLastListDirectoryCall(): { ptyId: string; dirPath: string } | undefined {
    return this.listDirectoryCalls[this.listDirectoryCalls.length - 1]
  }

  getLastSpawnConfig(): TerminalConfig | undefined {
    return this.spawnConfigs[this.spawnConfigs.length - 1]
  }

  getSpawnConfigs(): TerminalConfig[] {
    return this.spawnConfigs.slice()
  }

  getResizeCalls(): Array<{ ptyId: string; cols: number; rows: number }> {
    return this.resizeCalls.slice()
  }

  getWriteCalls(): Array<{ ptyId: string; data: string }> {
    return this.writeCalls.slice()
  }

  failSpawnForTerminalId(terminalId: string): void {
    this.spawnFailures.add(terminalId)
  }

  setSpawnDelayMs(delayMs: number): void {
    this.spawnDelayMs = Math.max(0, Math.floor(delayMs))
  }

  setCommandShellFamilyForTerminalId(
    terminalId: string,
    family: TerminalCommandShellFamily
  ): void {
    this.commandShellFamilyByPtyId.set(
      this.getPtyIdForTerminalId(terminalId),
      family
    )
  }

  setEmitExitOnKill(value: boolean): void {
    this.emitExitOnKill = value
  }

  setThrowOnKill(value: boolean): void {
    this.throwOnKill = value
  }

  setInitializationStateForTerminalId(
    terminalId: string,
    state: 'initializing' | 'ready' | 'failed'
  ): void {
    this.initializationStateByPtyId.set(
      this.getPtyIdForTerminalId(terminalId),
      state
    )
  }

  emitDataForTerminalId(terminalId: string, data: string): void {
    const session = this.sessions.get(`pty-${terminalId}`)
    if (!session) return
    session.dataCallbacks.forEach((callback) => callback(data))
  }

  emitExitForTerminalId(terminalId: string, code: number): void {
    const ptyId = this.getPtyIdForTerminalId(terminalId)
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.forEach((callback) => callback(code))
    this.sessions.delete(ptyId)
    this.initializationStateByPtyId.delete(ptyId)
  }

  async spawn(config: TerminalConfig): Promise<string> {
    if (this.spawnFailures.has(config.id)) {
      throw new Error(`intentional spawn failure for ${config.id}`)
    }
    this.spawnConfigs.push(JSON.parse(JSON.stringify(config)) as TerminalConfig)
    if (this.spawnDelayMs > 0) {
      await sleep(this.spawnDelayMs)
    }
    const id = this.getPtyIdForTerminalId(config.id)
    this.sessions.set(id, {
      id,
      cwd: '/tmp',
      dataCallbacks: [],
      exitCallbacks: []
    })
    this.initializationStateByPtyId.set(id, 'initializing')
    if (!this.remoteOsByPtyId.has(id)) {
      this.remoteOsByPtyId.set(id, 'unix')
    }
    if (!this.systemInfoByPtyId.has(id)) {
      const remoteOs = this.remoteOsByPtyId.get(id) === 'windows' ? 'windows' : 'unix'
      this.systemInfoByPtyId.set(
        id,
        this.createDefaultSystemInfo(remoteOs, config.type === 'ssh')
      )
    }
    return id
  }

  write(ptyId: string, data: string): void {
    this.writeCalls.push({ ptyId, data })
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.resizeCalls.push({ ptyId, cols, rows })
  }

  kill(ptyId: string): void {
    if (this.throwOnKill) {
      throw new Error('simulated backend kill failure')
    }
    const session = this.sessions.get(ptyId)
    if (!session) return
    if (this.emitExitOnKill) {
      session.exitCallbacks.forEach((callback) => callback(0))
    }
    this.sessions.delete(ptyId)
    this.initializationStateByPtyId.delete(ptyId)
    this.remoteOsByPtyId.delete(ptyId)
    this.systemInfoByPtyId.delete(ptyId)
    this.homeDirByPtyId.delete(ptyId)
    this.refreshCallbacksByPtyId.delete(ptyId)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.dataCallbacks.push(callback)
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.push(callback)
  }

  async readFile(_ptyId: string, _filePath: string): Promise<Buffer> {
    return Buffer.alloc(0)
  }

  async writeFile(_ptyId: string, _filePath: string, _content: string): Promise<void> {}

  async readFileChunk(
    _ptyId: string,
    _filePath: string,
    offset: number,
    _chunkSize: number,
    options?: { totalSizeHint?: number }
  ): Promise<{ chunk: Buffer; bytesRead: number; totalSize: number; nextOffset: number; eof: boolean }> {
    const totalSize = Number.isFinite(options?.totalSizeHint) && (options?.totalSizeHint || 0) >= 0
      ? Math.floor(options!.totalSizeHint as number)
      : 0
    return {
      chunk: Buffer.alloc(0),
      bytesRead: 0,
      totalSize,
      nextOffset: offset,
      eof: true
    }
  }

  async writeFileChunk(
    _ptyId: string,
    _filePath: string,
    offset: number,
    content: Buffer
  ): Promise<{ writtenBytes: number; nextOffset: number }> {
    return {
      writtenBytes: content.length,
      nextOffset: offset + content.length
    }
  }

  async writeFileBytes(_ptyId: string, _filePath: string, _content: Buffer): Promise<void> {}

  async listDirectory(ptyId: string, dirPath: string): Promise<FileSystemEntry[]> {
    this.listDirectoryCalls.push({ ptyId, dirPath })
    return []
  }

  async createDirectory(_ptyId: string, _dirPath: string): Promise<void> {}

  async createFile(_ptyId: string, _filePath: string): Promise<void> {}

  async deletePath(_ptyId: string, _targetPath: string, _options?: { recursive?: boolean }): Promise<void> {}

  async renamePath(_ptyId: string, _sourcePath: string, _targetPath: string): Promise<void> {}

  getCwd(ptyId: string): string | undefined {
    return this.sessions.get(ptyId)?.cwd || '/tmp'
  }

  async getHomeDir(ptyId: string): Promise<string | undefined> {
    return this.homeDirByPtyId.get(ptyId) || '/tmp'
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return this.remoteOsByPtyId.get(_ptyId)
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    if (this.delayedSystemInfoPtyIds.has(_ptyId)) {
      return await new Promise<TerminalSystemInfo | undefined>((resolve) => {
        const resolvers = this.delayedSystemInfoResolversByPtyId.get(_ptyId) ?? []
        resolvers.push(resolve)
        this.delayedSystemInfoResolversByPtyId.set(_ptyId, resolvers)
      })
    }
    return this.systemInfoByPtyId.get(_ptyId)
  }

  getInitializationState(
    ptyId: string
  ): 'initializing' | 'ready' | 'failed' | undefined {
    return this.initializationStateByPtyId.get(ptyId)
  }

  getCommandShellFamily(
    ptyId: string
  ): TerminalCommandShellFamily | undefined {
    return this.commandShellFamilyByPtyId.get(ptyId)
  }

  async refreshSessionState(ptyId: string): Promise<void> {
    const callback = this.refreshCallbacksByPtyId.get(ptyId)
    if (!callback) {
      return
    }
    await callback()
  }

  async statFile(_ptyId: string, _filePath: string): Promise<FileStatInfo> {
    return { exists: false, isDirectory: false }
  }
}

class FakeTerminalOnlyBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()

  async spawn(config: TerminalConfig): Promise<string> {
    const id = `pty-${config.id}`
    this.sessions.set(id, {
      id,
      cwd: '/tmp',
      dataCallbacks: [],
      exitCallbacks: []
    })
    return id
  }

  write(_ptyId: string, _data: string): void {}

  resize(_ptyId: string, _cols: number, _rows: number): void {}

  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.forEach((callback) => callback(0))
    this.sessions.delete(ptyId)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.dataCallbacks.push(callback)
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.push(callback)
  }

  getCwd(_ptyId: string): string | undefined {
    return '/tmp'
  }

  async getHomeDir(_ptyId: string): Promise<string | undefined> {
    return '/tmp'
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return 'unix'
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    return {
      os: 'unix',
      platform: 'linux',
      release: 'test',
      arch: 'x64',
      hostname: 'test',
      isRemote: true
    }
  }
}

const createService = (stateFilePath: string, backend: FakeTerminalBackend): TerminalService => {
  const service = new TerminalService({
    terminalStateStore: new TerminalStateStore(stateFilePath)
  })
  ;(service as any).backends.set('local', backend)
  ;(service as any).backends.set('ssh', backend)
  service.setRawEventPublisher(() => {})
  return service
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-terminal-persist-extreme-'))
  const stateFilePath = path.join(tempDir, 'terminal-tabs-state.json')

  try {
    await runCase('state store filters invalid records and de-duplicates by terminal id', async () => {
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            terminals: [
              {
                id: 'local-a',
                config: {
                  type: 'local',
                  id: 'local-a',
                  title: 'Local A',
                  cols: 80,
                  rows: 24
                }
              },
              {
                id: 'local-a',
                config: {
                  type: 'local',
                  id: 'local-a',
                  title: 'Duplicate',
                  cols: 90,
                  rows: 30
                }
              },
              {
                id: 'ssh-bad',
                config: {
                  type: 'ssh',
                  id: 'ssh-bad',
                  title: 'Broken SSH'
                }
              }
            ]
          },
          null,
          2
        ),
        'utf8'
      )

      const store = new TerminalStateStore(stateFilePath)
      const loaded = store.load()
      assertEqual(loaded.length, 1, 'only valid unique records should be loaded')
      assertEqual(loaded[0].id, 'local-a', 'first valid record should be kept')
    })

    await runCase('a visible output consumer can register before its terminal runtime exists', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      service.attachOutputConsumer('pre-attached-terminal', 'visible-consumer')
      await service.createTerminal({
        type: 'local',
        id: 'pre-attached-terminal',
        title: 'Pre-attached',
        cols: 80,
        rows: 24
      })

      const controller = (service as any).outputFlowControllerByTerminal.get(
        'pre-attached-terminal'
      )
      assertCondition(
        controller?.activeRendererConsumers?.has('visible-consumer'),
        'runtime registration must attach consumers that arrived before createTab'
      )
      service.kill('pre-attached-terminal')
    })

    await runCase('a retained visible output consumer follows a reused terminal id into its new runtime', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      const terminalId = 'reused-output-consumer'
      const consumerId = 'visible-consumer'
      const visibleEvents: Array<{
        terminalId: string
        outputSequence: number
        runtimeGeneration: number
      }> = []
      service.setRawEventPublisher((channel, payload) => {
        if (channel === 'terminal:data') {
          visibleEvents.push(payload as (typeof visibleEvents)[number])
        }
      })
      const config: TerminalConfig = {
        type: 'local',
        id: terminalId,
        title: 'Reused Output Consumer',
        cols: 80,
        rows: 24
      }

      service.attachOutputConsumer(terminalId, consumerId)
      await service.createTerminal(config)
      const firstController = (service as any).outputFlowControllerByTerminal.get(
        terminalId
      )
      assertCondition(
        firstController?.activeRendererConsumers?.has(consumerId),
        'first runtime should attach the retained visible consumer'
      )

      service.kill(terminalId)
      await service.createTerminal(config)
      const replacementController = (service as any).outputFlowControllerByTerminal.get(
        terminalId
      )
      assertCondition(
        replacementController !== firstController,
        'same-id recreation should install a new output controller'
      )
      assertCondition(
        replacementController?.activeRendererConsumers?.has(consumerId),
        'same-id recreation must preserve visible parser backpressure registration'
      )

      backend.emitDataForTerminalId(terminalId, 'replacement output')
      const replacementEvent = visibleEvents.find(
        (event) => event.terminalId === terminalId
      )
      assertCondition(
        replacementEvent,
        'replacement output should publish a visible parser sequence'
      )
      service.acknowledgeOutput(
        terminalId,
        consumerId,
        replacementEvent!.runtimeGeneration,
        replacementEvent!.outputSequence
      )
      assertEqual(
        await replacementController.waitForDrain(2_000),
        true,
        'replacement visible acknowledgement should release source credit'
      )

      service.detachOutputConsumer(terminalId, consumerId)
      service.kill(terminalId)
    })

    await runCase('output consumer attachment returns an atomic bounded-buffer snapshot', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      const visibleEvents: Array<{
        terminalId: string
        data: string
        offset: number
        outputSequence: number
        runtimeGeneration: number
      }> = []
      service.setRawEventPublisher((channel, payload) => {
        if (channel === 'terminal:data') {
          visibleEvents.push(payload as (typeof visibleEvents)[number])
        }
      })
      await service.createTerminal({
        type: 'local',
        id: 'atomic-output-snapshot',
        title: 'Atomic Output Snapshot',
        cols: 80,
        rows: 24
      })

      const initial = service.attachOutputConsumer(
        'atomic-output-snapshot',
        'visible-consumer'
      )
      const fullOutput = `${'a'.repeat(50_000)}${'b'.repeat(200_000)}`
      backend.emitDataForTerminalId('atomic-output-snapshot', fullOutput)
      const snapshot = service.attachOutputConsumer(
        'atomic-output-snapshot',
        'snapshot-observer'
      )

      assertEqual(initial.offset, 0, 'initial attachment should capture its exact empty baseline')
      assertEqual(visibleEvents.length, 1, 'the registered consumer should receive one full live frame')
      assertEqual(
        visibleEvents[0].data,
        fullOutput,
        'live delivery must retain the prefix that the bounded buffer later trims'
      )
      assertEqual(snapshot.offset, fullOutput.length, 'snapshot offset should be absolute')
      assertEqual(snapshot.data.length, 200_000, 'snapshot should expose the bounded retained tail')
      assertEqual(
        snapshot.data,
        fullOutput.slice(-200_000),
        'atomic snapshot and live frame must form reconstructable offset intervals'
      )
      service.detachOutputConsumer('atomic-output-snapshot', 'visible-consumer')
      service.detachOutputConsumer('atomic-output-snapshot', 'snapshot-observer')
      const drained = await (service as any).outputFlowControllerByTerminal
        .get('atomic-output-snapshot')
        .waitForDrain(2_000)
      assertEqual(drained, true, 'headless parser should drain before test teardown')
      service.kill('atomic-output-snapshot')
    })

    await runCase('terminal service persists created tabs and restores them on next startup', async () => {
      const backend1 = new FakeTerminalBackend()
      const service1 = createService(stateFilePath, backend1)
      await service1.createTerminal({
        type: 'local',
        id: 'local-restore-a',
        title: 'Restore A',
        cols: 120,
        rows: 32
      })
      await sleep(220)

      const store = new TerminalStateStore(stateFilePath)
      const snapshot = store.load()
      assertCondition(
        snapshot.some((item) => item.id === 'local-restore-a'),
        'created terminal should be persisted to state store'
      )

      const backend2 = new FakeTerminalBackend()
      const service2 = createService(stateFilePath, backend2)
      const restore = await service2.restorePersistedTerminals()
      assertCondition(
        restore.restored.includes('local-restore-a'),
        'persisted terminal should be restored successfully'
      )
      assertCondition(
        service2.getDisplayTerminals().some((item) => item.id === 'local-restore-a'),
        'restored terminal must exist in display list'
      )
    })

    await runCase('restored idle windows terminals publish runtime metadata before any new output', async () => {
      const store = new TerminalStateStore(stateFilePath)
      store.save([
        {
          id: 'ssh-win-idle',
          config: {
            type: 'ssh',
            id: 'ssh-win-idle',
            title: 'Idle Windows',
            cols: 120,
            rows: 32,
            host: '10.0.0.10',
            port: 22,
            username: 'Administrator',
            authMethod: 'password',
            password: 'secret-password'
          }
        }
      ])

      const backend = new FakeTerminalBackend()
      backend.setRemoteOsForTerminalId('ssh-win-idle', 'windows')
      backend.setSystemInfoForTerminalId('ssh-win-idle', {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.19045',
        arch: 'x64',
        hostname: 'test-win',
        isRemote: true,
        shell: 'powershell.exe'
      })

      const terminalTabEvents: Array<{
        terminals: Array<{
          id: string
          remoteOs?: 'unix' | 'windows'
          systemInfo?: TerminalSystemInfo
        }>
      }> = []
      const terminalDataEvents: Array<{
        terminalId: string
        data: string
        remoteOs?: 'unix' | 'windows'
        windowsRelease?: string
      }> = []

      const service = createService(stateFilePath, backend)
      service.setRawEventPublisher((channel, payload) => {
        if (channel === 'terminal:tabs') {
          terminalTabEvents.push(payload as {
            terminals: Array<{
              id: string
              remoteOs?: 'unix' | 'windows'
              systemInfo?: TerminalSystemInfo
            }>
          })
        }
        if (channel === 'terminal:data') {
          terminalDataEvents.push(payload as {
            terminalId: string
            data: string
            remoteOs?: 'unix' | 'windows'
            windowsRelease?: string
          })
        }
      })

      const restore = await service.restorePersistedTerminals()
      assertCondition(
        restore.restored.includes('ssh-win-idle'),
        'windows terminal should restore from persisted state'
      )

      await sleep(20)

      const restored = service.getDisplayTerminals().find((item) => item.id === 'ssh-win-idle')
      assertEqual(restored?.remoteOs, 'windows', 'restored terminal should learn windows PTY metadata without new output')
      assertEqual(
        restored?.systemInfo?.platform,
        'win32',
        'restored terminal should hydrate system info without waiting for handleData'
      )
      assertCondition(
        terminalTabEvents.some((event) =>
          event.terminals.some(
            (terminal) =>
              terminal.id === 'ssh-win-idle' &&
              terminal.remoteOs === 'windows' &&
              terminal.systemInfo?.platform === 'win32'
          )
        ),
        'renderer tab snapshots should be republished once restored windows metadata is available'
      )

      backend.emitDataForTerminalId('ssh-win-idle', 'PS C:\\Users\\test> ')
      await sleep(10)
      const renderedData = terminalDataEvents.find(
        (event) => event.terminalId === 'ssh-win-idle'
      )
      assertEqual(
        renderedData?.remoteOs,
        'windows',
        'every rendered data packet should carry its Windows parser mode'
      )
      assertEqual(
        renderedData?.windowsRelease,
        '10.0.19045',
        'rendered data should carry the exact Windows build before xterm parses it'
      )
      assertEqual(
        service.getRenderMetadata('ssh-win-idle').windowsRelease,
        '10.0.19045',
        'buffer replay metadata should match the live renderer stream'
      )
    })

    await runCase('failed restores are pruned from persisted state to avoid repeated startup failures', async () => {
      const store = new TerminalStateStore(stateFilePath)
      store.save([
        {
          id: 'local-good',
          config: {
            type: 'local',
            id: 'local-good',
            title: 'Local Good',
            cols: 80,
            rows: 24
          }
        },
        {
          id: 'local-bad',
          config: {
            type: 'local',
            id: 'local-bad',
            title: 'Local Bad',
            cols: 80,
            rows: 24
          }
        }
      ])

      const backend = new FakeTerminalBackend()
      backend.failSpawnForTerminalId('local-bad')
      const service = createService(stateFilePath, backend)
      const restore = await service.restorePersistedTerminals()
      assertCondition(restore.restored.includes('local-good'), 'good record should still restore')
      assertCondition(
        restore.failed.some((item) => item.id === 'local-bad'),
        'failed record should be reported'
      )

      const nextSnapshot = store.load()
      assertCondition(
        nextSnapshot.some((item) => item.id === 'local-good'),
        'successful record should remain in state file'
      )
      assertCondition(
        !nextSnapshot.some((item) => item.id === 'local-bad'),
        'failed record should be pruned after restore'
      )
    })

    await runCase('terminal service preserves ready-marker lookalikes after backend initialization', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      const terminalDataEvents: Array<{ terminalId: string; data: string; offset?: number }> = []
      service.setRawEventPublisher((channel, payload) => {
        if (channel !== 'terminal:data') return
        terminalDataEvents.push(payload as { terminalId: string; data: string; offset?: number })
      })

      await service.createTerminal({
        type: 'local',
        id: 'local-ready-marker-filter',
        title: 'Marker Filter',
        cols: 80,
        rows: 24
      })

      backend.emitDataForTerminalId(
        'local-ready-marker-filter',
        'before__GYSHELL_READY__after\r\nPS C:\\Users\\TUOTUO_Server> '
      )

      await sleep(20)

      const buffered = service.getBufferDelta('local-ready-marker-filter', 0)
      assertCondition(
        buffered.includes('before__GYSHELL_READY__after'),
        'ordinary terminal data must not be mistaken for an initialization control marker'
      )
      assertCondition(
        buffered.includes('PS C:\\Users\\TUOTUO_Server> '),
        'shell prompt after ready marker should be preserved'
      )
      assertCondition(
        terminalDataEvents.some((item) => item.data.includes('before__GYSHELL_READY__after')),
        'renderer output must preserve the same ordinary marker-like text'
      )
    })

    await runCase('idempotent terminal recreation must preserve full ssh restore config', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-restore-a',
        title: 'SSH Restore A',
        cols: 100,
        rows: 30,
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret-password'
      })
      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-restore-a',
        title: 'SSH Restore A',
        cols: 120,
        rows: 40
      } as any)
      service.flushPersistedState()

      const store = new TerminalStateStore(stateFilePath)
      const snapshot = store.load()
      const sshRecord = snapshot.find((item) => item.id === 'ssh-restore-a')
      assertCondition(!!sshRecord, 'ssh record should remain persistable after idempotent create')
      assertEqual(sshRecord?.config.type, 'ssh', 'ssh record should keep ssh type')
      assertEqual((sshRecord?.config as any).host, '10.0.0.5', 'ssh host should not be lost on idempotent updates')
      assertEqual((sshRecord?.config as any).username, 'root', 'ssh username should not be lost on idempotent updates')
      assertEqual(
        (sshRecord?.config as any).authMethod,
        'password',
        'ssh auth method should not be lost on idempotent updates'
      )
    })

    await runCase('terminal service rejects filesystem APIs for terminal-only connection types', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      ;(service as any).backends.set('serial', new FakeTerminalOnlyBackend())

      await service.createTerminal({
        type: 'serial',
        id: 'serial-a',
        title: 'Serial A',
        cols: 80,
        rows: 24
      } as any)

      const created = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'serial-a')
      assertCondition(!!created, 'serial terminal should be created successfully')
      assertEqual(
        created?.capabilities.supportsFilesystem,
        false,
        'terminal-only connection types should be marked as not file-capable'
      )
      assertEqual(
        service.getFileSystemIdentity('serial-a'),
        null,
        'terminal-only connection types should not expose filesystem identity'
      )
      await assertRejects(
        service.listDirectory('serial-a'),
        /does not support filesystem operations/i,
        'filesystem requests should fail with explicit capability error'
      )
    })

    await runCase('createAutoTerminalConfig preserves explicit id and type for terminal remounts', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      ;(service as any).backends.set('serial', new FakeTerminalOnlyBackend())

      await service.createTerminal({
        type: 'serial',
        id: 'serial-remount-a',
        title: 'Serial Remount A',
        cols: 80,
        rows: 24
      } as any)

      const snapshot = service.getDisplayTerminals().map((terminal) => ({
        id: terminal.id,
        title: terminal.title,
        type: terminal.type
      }))
      const normalized = createAutoTerminalConfig(snapshot, {
        type: 'serial',
        id: 'serial-remount-a',
        title: 'Serial Remount A',
        cols: 120,
        rows: 40
      })

      assertEqual(
        normalized.type,
        'serial',
        'explicit terminal-only type should survive auto-config normalization'
      )
      assertEqual(
        normalized.id,
        'serial-remount-a',
        'explicit terminal id should be preserved for idempotent remounts'
      )

      await service.createTerminal(normalized as any)

      const terminals = service.getDisplayTerminals()
      const remounted = terminals.find((terminal) => terminal.id === 'serial-remount-a')
      assertEqual(
        terminals.length,
        1,
        'idempotent remount should not create a duplicate terminal session'
      )
      assertEqual(
        remounted?.cols,
        120,
        'idempotent remount should still update terminal dimensions'
      )
    })

    await runCase('terminal service allocates unique titles for duplicate terminal names', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'local',
        id: 'local-a',
        title: 'Local (1)',
        cols: 80,
        rows: 24
      })
      await service.createTerminal({
        type: 'local',
        id: 'local-b',
        title: 'Local (1)',
        cols: 80,
        rows: 24
      })
      await service.createTerminal({
        type: 'local',
        id: 'local-c',
        title: 'Local (3)',
        cols: 80,
        rows: 24
      })

      assertEqual(
        JSON.stringify(service.getDisplayTerminals().map((terminal) => terminal.title)),
        JSON.stringify(['Local (1)', 'Local (1) (1)', 'Local (3)']),
        'runtime terminal inventory should not expose duplicate titles'
      )

      await service.createTerminal({
        type: 'local',
        id: 'local-b',
        title: 'Local (1)',
        cols: 120,
        rows: 40
      })

      const remounted = service.getDisplayTerminals().find((terminal) => terminal.id === 'local-b')
      assertEqual(
        remounted?.title,
        'Local (1) (1)',
        'idempotent remount should keep a unique title for the existing terminal id'
      )
      assertEqual(
        remounted?.cols,
        120,
        'idempotent remount should still update dimensions after title normalization'
      )
    })

    await runCase('terminal service preserves numeric suffixes in user titles', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'gpu-root',
        title: 'GPU',
        cols: 80,
        rows: 24,
        host: 'gpu.example.test',
        port: 22,
        username: 'gpu',
        authMethod: 'password'
      } as any)
      await service.createTerminal({
        type: 'ssh',
        id: 'gpu-a',
        title: 'GPU (8)',
        cols: 80,
        rows: 24,
        host: 'gpu.example.test',
        port: 22,
        username: 'gpu',
        authMethod: 'password'
      } as any)
      await service.createTerminal({
        type: 'ssh',
        id: 'gpu-b',
        title: 'GPU (8)',
        cols: 80,
        rows: 24,
        host: 'gpu.example.test',
        port: 22,
        username: 'gpu',
        authMethod: 'password'
      } as any)

      assertEqual(
        JSON.stringify(service.getDisplayTerminals().map((terminal) => terminal.title)),
        JSON.stringify(['GPU', 'GPU (8)', 'GPU (8) (1)']),
        'user-provided numeric title suffixes should be preserved when allocating duplicates'
      )
    })

    await runCase('terminal service reserves unique titles across parallel creates', async () => {
      const backend = new FakeTerminalBackend()
      backend.setSpawnDelayMs(20)
      const service = createService(stateFilePath, backend)

      await Promise.all([
        service.createTerminal({
          type: 'local',
          id: 'race-a',
          title: 'Race',
          cols: 80,
          rows: 24
        }),
        service.createTerminal({
          type: 'local',
          id: 'race-b',
          title: 'Race',
          cols: 80,
          rows: 24
        })
      ])

      const titlesById = new Map(
        service.getDisplayTerminals().map((terminal) => [terminal.id, terminal.title])
      )
      assertEqual(
        titlesById.get('race-a'),
        'Race',
        'first parallel create should reserve the requested title'
      )
      assertEqual(
        titlesById.get('race-b'),
        'Race (1)',
        'second parallel create should see the pending title reservation'
      )

      const spawnTitlesById = new Map(
        backend.getSpawnConfigs().map((config) => [config.id, config.title])
      )
      assertEqual(
        spawnTitlesById.get('race-a'),
        'Race',
        'backend spawn config should carry the reserved title for the first create'
      )
      assertEqual(
        spawnTitlesById.get('race-b'),
        'Race (1)',
        'backend spawn config should carry the reserved title for the second create'
      )
    })

    await runCase('terminal service releases reserved title after spawn failure', async () => {
      const backend = new FakeTerminalBackend()
      backend.failSpawnForTerminalId('race-fail')
      const service = createService(stateFilePath, backend)

      await assertRejects(
        service.createTerminal({
          type: 'local',
          id: 'race-fail',
          title: 'Race',
          cols: 80,
          rows: 24
        }),
        /intentional spawn failure/,
        'failed spawn should reject'
      )

      await service.createTerminal({
        type: 'local',
        id: 'race-ok',
        title: 'Race',
        cols: 80,
        rows: 24
      })

      assertEqual(
        service.getDisplayTerminals().find((terminal) => terminal.id === 'race-ok')?.title,
        'Race',
        'failed spawn should release its pending title reservation'
      )
    })

    await runCase('pending resize before terminal registration is used for backend spawn geometry', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      service.resize('ssh-race-size', 132, 43)
      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-race-size',
        title: 'SSH Race Size',
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })

      const spawned = backend.getLastSpawnConfig()
      const tab = service.getDisplayTerminals().find((terminal) => terminal.id === 'ssh-race-size')

      assertEqual(spawned?.cols, 132, 'pending renderer resize should override the initial spawn cols')
      assertEqual(spawned?.rows, 43, 'pending renderer resize should override the initial spawn rows')
      assertEqual(tab?.cols, 132, 'terminal inventory should expose the pending resize cols')
      assertEqual(tab?.rows, 43, 'terminal inventory should expose the pending resize rows')
    })

    await runCase('idempotent terminal remount forwards changed dimensions to the live backend', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-remount-resize',
        title: 'SSH Remount Resize',
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })
      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-remount-resize',
        title: 'SSH Remount Resize',
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 120,
        rows: 40
      })

      const resizeCall = backend.getResizeCalls()[0]
      assertEqual(resizeCall?.ptyId, 'pty-ssh-remount-resize', 'remount resize should target the existing PTY')
      assertEqual(resizeCall?.cols, 120, 'remount resize should forward the changed cols')
      assertEqual(resizeCall?.rows, 40, 'remount resize should forward the changed rows')
    })

    await runCase('local PowerShell rejects input until its private bootstrap is ready', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      backend.setCommandShellFamilyForTerminalId(
        'local-powershell-initializing',
        'powershell'
      )

      await service.createTerminal({
        type: 'local',
        id: 'local-powershell-initializing',
        title: 'Local PowerShell Initializing',
        cols: 80,
        rows: 24
      })

      const runtimeSnapshot = service.getTerminalRuntimeSnapshot(
        'local-powershell-initializing'
      )
      assertEqual(
        runtimeSnapshot?.runtimeState,
        'initializing',
        'PowerShell family should control bootstrap state independently of the host OS'
      )
      assertEqual(
        runtimeSnapshot?.canWrite,
        false,
        'PowerShell bootstrap must not accept terminal input'
      )
      assertEqual(
        runtimeSnapshot?.canUseFilesystem,
        true,
        'initializing local terminal should still expose filesystem operations'
      )

      await service.listDirectory('local-powershell-initializing', '/tmp')
      assertEqual(
        backend.getLastListDirectoryCall()?.ptyId,
        'pty-local-powershell-initializing',
        'initializing local terminal filesystem calls should still target the backend pty'
      )

      service.write('local-powershell-initializing', 'echo blocked\r')
      assertEqual(
        backend.getWriteCalls().length,
        0,
        'input during PowerShell bootstrap must not reach the backend'
      )
      await assertRejects(
        service.runCommandNoWait(
          'local-powershell-initializing',
          'Write-Output blocked'
        ),
        /not ready/,
        'agent commands during PowerShell bootstrap must fail before task creation'
      )

      backend.emitDataForTerminalId(
        'local-powershell-initializing',
        'PS /tmp> '
      )
      service.write('local-powershell-initializing', 'echo allowed\r')
      assertEqual(
        backend.getWriteCalls()[0]?.data,
        'echo allowed\r',
        'input should resume after bootstrap reaches ready'
      )
    })

    await runCase('ssh terminals still reject writes until runtime is ready', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-not-ready-write',
        title: 'SSH Not Ready Write',
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })

      service.write('ssh-not-ready-write', 'echo blocked\n')
      const runtimeSnapshot = service.getTerminalRuntimeSnapshot('ssh-not-ready-write')

      assertEqual(
        backend.getWriteCalls().length,
        0,
        'initializing ssh terminal writes should remain blocked'
      )
      assertEqual(
        runtimeSnapshot?.canUseFilesystem,
        false,
        'initializing ssh terminal should not expose filesystem operations'
      )
    })

    await runCase('local terminals auto-restart after an unexpected backend exit', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'local',
        id: 'local-auto-restart',
        title: 'Local Auto Restart',
        cols: 80,
        rows: 24
      })

      backend.emitExitForTerminalId('local-auto-restart', 129)
      await sleep(20)

      const tab = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'local-auto-restart')
      assertEqual(tab?.runtimeState, 'ready', 'local tab should stay ready after auto-restart')
      assertEqual(tab?.lastExitCode, undefined, 'local auto-restart should clear the old exit code')
      assertEqual(
        backend.getSpawnConfigs().filter((config) => config.id === 'local-auto-restart').length,
        2,
        'local auto-restart should respawn the backend runtime with the same tab id'
      )

      service.write('local-auto-restart', 'echo after-restart\n')
      const writeCall = backend.getWriteCalls().at(-1)
      assertEqual(
        writeCall?.ptyId,
        'pty-local-auto-restart',
        'writes after local auto-restart should target the respawned pty'
      )
    })

    await runCase('local output parser failure rebuilds headless state before auto-restart', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      const terminalId = 'local-headless-parser-rebuild'
      const runtimeBoundaries: Array<{
        terminalId: string
        data: string
        runtimeGeneration?: number
      }> = []
      service.setRawEventPublisher((channel, payload) => {
        if (channel === 'terminal:data') {
          const event = payload as (typeof runtimeBoundaries)[number]
          if (event.data === '') runtimeBoundaries.push(event)
        }
      })

      await service.createTerminal({
        type: 'local',
        id: terminalId,
        title: 'Local Headless Parser Rebuild',
        cols: 80,
        rows: 24
      })
      await (service as any).outputFlowControllerByTerminal
        .get(terminalId)
        .waitForDrain(2_000)
      backend.emitDataForTerminalId(terminalId, 'before-parser-failure\r\n')
      await (service as any).outputFlowControllerByTerminal
        .get(terminalId)
        .waitForDrain(2_000)

      const retiringHeadless = (service as any).headlessPtys.get(terminalId)
      const originalWrite = retiringHeadless.write.bind(retiringHeadless)
      retiringHeadless.write = (data: string, callback?: () => void): void => {
        if (data.includes('trigger-parser-failure')) {
          throw new Error('simulated headless parser failure')
        }
        originalWrite(data, callback)
      }
      backend.emitDataForTerminalId(terminalId, 'trigger-parser-failure\r\n')
      await sleep(100)

      const replacementHeadless = (service as any).headlessPtys.get(terminalId)
      assertCondition(
        replacementHeadless !== retiringHeadless,
        'output failure must replace the poisoned headless parser before restart'
      )
      assertEqual(
        backend.getSpawnConfigs().filter((config) => config.id === terminalId).length,
        2,
        'local restart must wait for headless reconstruction and then spawn once'
      )
      assertCondition(
        runtimeBoundaries.some(
          (event) =>
            event.terminalId === terminalId &&
            Number.isSafeInteger(event.runtimeGeneration)
        ),
        'replacement runtime must announce its generation even before producing output'
      )
      const rebuiltOutput = service.getRecentOutput(terminalId, 200)
      assertCondition(
        rebuiltOutput.includes('before-parser-failure') &&
          rebuiltOutput.includes('trigger-parser-failure') &&
          rebuiltOutput.includes('Terminal output parser failed'),
        'fresh headless state must replay the same retained display tail and failure diagnostic'
      )

      backend.emitDataForTerminalId(terminalId, 'after-parser-restart\r\n')
      await (service as any).outputFlowControllerByTerminal
        .get(terminalId)
        .waitForDrain(2_000)
      assertCondition(
        service.getRecentOutput(terminalId, 200).includes('after-parser-restart'),
        'replacement headless parser must continue consuming the new runtime output'
      )
    })

    await runCase('local auto-restart never publishes the dead runtime as command-ready', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'local',
        id: 'local-auto-restart-spawn-window',
        title: 'Local Auto Restart Spawn Window',
        cols: 80,
        rows: 24
      })

      backend.setSpawnDelayMs(80)
      backend.emitExitForTerminalId('local-auto-restart-spawn-window', 129)

      const restartingSnapshot = service.getTerminalRuntimeSnapshot(
        'local-auto-restart-spawn-window'
      )
      assertEqual(
        restartingSnapshot?.runtimeState,
        'initializing',
        'the tab must remain initializing while replacement spawn is pending'
      )
      assertEqual(
        restartingSnapshot?.canRunCommand,
        false,
        'the dead PTY must not be exposed as command-ready during replacement spawn'
      )
      assertEqual(
        restartingSnapshot?.canWrite,
        false,
        'the dead PTY must not accept manual input during replacement spawn'
      )

      service.write('local-auto-restart-spawn-window', 'echo blocked\n')
      await assertRejects(
        service.runCommandNoWait(
          'local-auto-restart-spawn-window',
          'echo blocked'
        ),
        /not ready/,
        'a synchronous command attempt in the spawn window must fail closed'
      )
      assertEqual(
        backend.getWriteCalls().length,
        0,
        'neither manual nor agent input may be submitted to the exited PTY'
      )
      assertEqual(
        service.getActiveTaskId('local-auto-restart-spawn-window'),
        undefined,
        'a rejected spawn-window command must not create a permanently running task'
      )

      await sleep(100)
      const restartedSnapshot = service.getTerminalRuntimeSnapshot(
        'local-auto-restart-spawn-window'
      )
      assertEqual(
        restartedSnapshot?.runtimeState,
        'ready',
        'a Unix-family local runtime should become ready after replacement spawn'
      )
      service.write('local-auto-restart-spawn-window', 'echo allowed\n')
      assertEqual(
        backend.getWriteCalls()[0]?.data,
        'echo allowed\n',
        'input should target the replacement runtime after it becomes ready'
      )
    })

    await runCase('killed local terminals are removed instead of auto-restarted', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'local',
        id: 'local-user-closed',
        title: 'Local User Closed',
        cols: 80,
        rows: 24
      })

      service.kill('local-user-closed')
      await sleep(20)

      assertCondition(
        !service.getDisplayTerminals().some((terminal) => terminal.id === 'local-user-closed'),
        'user-closed local tab should be removed from display inventory'
      )
      assertEqual(
        backend.getSpawnConfigs().filter((config) => config.id === 'local-user-closed').length,
        1,
        'user-closed local tab should not be respawned'
      )
    })

    await runCase('reconnectTerminal respawns an exited ssh tab with the same terminal id', async () => {
      const backend = new FakeTerminalBackend()
      backend.setRemoteOsForTerminalId('ssh-reconnect-same-id', 'windows')
      backend.setSystemInfoForTerminalId('ssh-reconnect-same-id', {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.19045',
        arch: 'x64',
        hostname: 'old-windows-host',
        isRemote: true,
        shell: 'powershell.exe'
      })
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-reconnect-same-id',
        title: 'SSH Reconnect',
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })

      backend.setInitializationStateForTerminalId(
        'ssh-reconnect-same-id',
        'ready'
      )
      backend.emitDataForTerminalId('ssh-reconnect-same-id', 'ready\r\n')
      await sleep(20)

      let tab = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'ssh-reconnect-same-id')
      assertEqual(tab?.runtimeState, 'ready', 'ssh tab should become ready before disconnect')

      backend.emitExitForTerminalId('ssh-reconnect-same-id', 255)
      tab = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'ssh-reconnect-same-id')
      assertEqual(tab?.runtimeState, 'exited', 'ssh tab should stay in the inventory after disconnect')
      assertEqual(tab?.lastExitCode, 255, 'disconnect exit code should be retained before reconnect')
      let runtimeSnapshot = service.getTerminalRuntimeSnapshot('ssh-reconnect-same-id')
      assertEqual(runtimeSnapshot?.runtimeState, 'exited', 'runtime snapshot should report disconnected ssh tab')
      assertEqual(runtimeSnapshot?.reconnectable, true, 'disconnected ssh tab with config should be reconnectable')
      assertEqual(runtimeSnapshot?.canRunCommand, false, 'disconnected ssh tab should not accept commands')
      assertEqual(runtimeSnapshot?.canUseFilesystem, false, 'disconnected ssh tab should not expose filesystem operations')

      backend.setRemoteOsForTerminalId('ssh-reconnect-same-id', 'unix')
      backend.setSystemInfoForTerminalId('ssh-reconnect-same-id', {
        os: 'Linux',
        platform: 'linux',
        release: '6.8.0',
        arch: 'x64',
        hostname: 'new-unix-host',
        isRemote: true,
        shell: '/bin/bash'
      })

      const reconnected = await service.reconnectTerminal(
        'ssh-reconnect-same-id'
      )
      assertEqual(
        reconnected.id,
        'ssh-reconnect-same-id',
        'reconnect should preserve the terminal tab id'
      )
      assertEqual(
        backend
          .getSpawnConfigs()
          .filter((config) => config.id === 'ssh-reconnect-same-id').length,
        2,
        'reconnect should spawn a new backend runtime for the same id'
      )

      tab = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'ssh-reconnect-same-id')
      assertEqual(tab?.runtimeState, 'initializing', 'reconnect should mark the existing tab as reconnecting')
      assertEqual(tab?.lastExitCode, undefined, 'successful reconnect attempt should clear the old exit code')
      runtimeSnapshot = service.getTerminalRuntimeSnapshot('ssh-reconnect-same-id')
      assertEqual(runtimeSnapshot?.runtimeState, 'initializing', 'runtime snapshot should report reconnect initialization')
      assertEqual(runtimeSnapshot?.reconnectable, false, 'initializing ssh tab should not start another reconnect')
      assertEqual(runtimeSnapshot?.canUseFilesystem, false, 'initializing ssh tab should not expose filesystem operations')

      backend.setInitializationStateForTerminalId(
        'ssh-reconnect-same-id',
        'ready'
      )
      backend.emitDataForTerminalId('ssh-reconnect-same-id', 'ready again\r\n')
      await sleep(20)

      tab = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'ssh-reconnect-same-id')
      assertEqual(
        tab?.runtimeState,
        'ready',
        'reconnected ssh tab should return to ready after backend initialization'
      )
      assertCondition(
        service.getBufferDelta('ssh-reconnect-same-id', 0).includes('ready again'),
        'reconnected runtime should continue streaming data to the same terminal buffer'
      )
      runtimeSnapshot = service.getTerminalRuntimeSnapshot('ssh-reconnect-same-id')
      assertEqual(runtimeSnapshot?.runtimeState, 'ready', 'runtime snapshot should report reconnected tab ready')
      assertEqual(runtimeSnapshot?.canRunCommand, true, 'ready ssh tab should accept commands')
      assertEqual(runtimeSnapshot?.canUseFilesystem, true, 'ready ssh tab should expose filesystem operations')
      assertEqual(
        service.getRenderMetadata('ssh-reconnect-same-id').remoteOs,
        'unix',
        'reconnect should hydrate metadata from the replacement PTY runtime'
      )
      assertEqual(
        service.getRenderMetadata('ssh-reconnect-same-id').windowsRelease,
        undefined,
        'reconnect should not leak the previous Windows build into a new runtime'
      )
    })

    await runCase('ssh reconnect waits for failed headless parser reconstruction', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      const terminalId = 'ssh-headless-parser-rebuild'

      await service.createTerminal({
        type: 'ssh',
        id: terminalId,
        title: 'SSH Headless Parser Rebuild',
        host: '10.0.0.9',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })
      backend.setInitializationStateForTerminalId(terminalId, 'ready')
      backend.emitDataForTerminalId(terminalId, 'ssh-before-parser-failure\r\n')
      await (service as any).outputFlowControllerByTerminal
        .get(terminalId)
        .waitForDrain(2_000)

      const retiringHeadless = (service as any).headlessPtys.get(terminalId)
      const originalWrite = retiringHeadless.write.bind(retiringHeadless)
      retiringHeadless.write = (data: string, callback?: () => void): void => {
        if (data.includes('ssh-trigger-parser-failure')) {
          throw new Error('simulated ssh headless parser failure')
        }
        originalWrite(data, callback)
      }
      backend.emitDataForTerminalId(
        terminalId,
        'ssh-trigger-parser-failure\r\n'
      )
      await sleep(50)
      assertEqual(
        service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
        'exited',
        'SSH output failure must leave the tab disconnected until explicit reconnect'
      )

      await service.reconnectTerminal(terminalId)
      const replacementHeadless = (service as any).headlessPtys.get(terminalId)
      assertCondition(
        replacementHeadless !== retiringHeadless,
        'SSH reconnect must not bind a new runtime to the poisoned headless parser'
      )
      const rebuiltOutput = service.getRecentOutput(terminalId, 200)
      assertCondition(
        rebuiltOutput.includes('ssh-before-parser-failure') &&
          rebuiltOutput.includes('ssh-trigger-parser-failure') &&
          rebuiltOutput.includes('Terminal output parser failed'),
        'SSH headless reconstruction must retain the display-equivalent failure tail'
      )

      backend.setInitializationStateForTerminalId(terminalId, 'ready')
      backend.emitDataForTerminalId(terminalId, 'ssh-after-parser-reconnect\r\n')
      await (service as any).outputFlowControllerByTerminal
        .get(terminalId)
        .waitForDrain(2_000)
      assertCondition(
        service.getRecentOutput(terminalId, 200).includes(
          'ssh-after-parser-reconnect'
        ),
        'fresh SSH headless parser must continue after reconnect'
      )
    })

    await runCase('reconnect ignores delayed metadata from a reused ssh pty id', async () => {
      const backend = new FakeTerminalBackend()
      backend.setRemoteOsForTerminalId('ssh-reconnect-generation', undefined)
      backend.delaySystemInfoForTerminalId('ssh-reconnect-generation')
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-reconnect-generation',
        title: 'SSH Reconnect Generation',
        host: '10.0.0.6',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })
      backend.emitExitForTerminalId('ssh-reconnect-generation', 255)
      await service.reconnectTerminal('ssh-reconnect-generation')

      backend.resolveNextSystemInfoForTerminalId('ssh-reconnect-generation', {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.19045',
        arch: 'x64',
        hostname: 'stale-windows-runtime',
        isRemote: true,
        shell: 'powershell.exe'
      })
      await sleep(10)
      assertEqual(
        service.getDisplayTerminals().find(
          (terminal) => terminal.id === 'ssh-reconnect-generation'
        )?.systemInfo,
        undefined,
        'metadata from the previous runtime generation must be ignored'
      )

      backend.resolveNextSystemInfoForTerminalId('ssh-reconnect-generation', {
        os: 'Linux',
        platform: 'linux',
        release: '6.8.0',
        arch: 'x64',
        hostname: 'current-unix-runtime',
        isRemote: true,
        shell: '/bin/bash'
      })
      await sleep(10)
      assertEqual(
        service.getRenderMetadata('ssh-reconnect-generation').remoteOs,
        'unix',
        'metadata from the current runtime generation should be accepted'
      )
      assertEqual(
        service.getRenderMetadata('ssh-reconnect-generation').windowsRelease,
        undefined,
        'stale Windows build metadata must not leak across the reconnect'
      )
    })

    await runCase('recreated terminal id rejects metadata from the killed runtime', async () => {
      const backend = new FakeTerminalBackend()
      backend.setRemoteOsForTerminalId('ssh-recreate-generation', undefined)
      backend.delaySystemInfoForTerminalId('ssh-recreate-generation')
      const service = createService(stateFilePath, backend)
      const config = {
        type: 'ssh' as const,
        id: 'ssh-recreate-generation',
        title: 'SSH Recreate Generation',
        host: '10.0.0.7',
        port: 22,
        username: 'root',
        authMethod: 'password' as const,
        password: 'secret',
        cols: 80,
        rows: 24
      }

      await service.createTerminal(config)
      service.kill(config.id)
      backend.setRemoteOsForTerminalId(config.id, undefined)
      await service.createTerminal(config)

      backend.resolveNextSystemInfoForTerminalId(config.id, {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.19045',
        arch: 'x64',
        hostname: 'killed-windows-runtime',
        isRemote: true,
        shell: 'powershell.exe'
      })
      await sleep(10)
      assertEqual(
        service.getDisplayTerminals().find(
          (terminal) => terminal.id === config.id
        )?.systemInfo,
        undefined,
        'a killed runtime token must never match a recreated terminal id'
      )

      backend.resolveNextSystemInfoForTerminalId(config.id, {
        os: 'Linux',
        platform: 'linux',
        release: '6.8.0',
        arch: 'x64',
        hostname: 'recreated-unix-runtime',
        isRemote: true,
        shell: '/bin/bash'
      })
      await sleep(10)
      assertEqual(
        service.getRenderMetadata(config.id).remoteOs,
        'unix',
        'the recreated runtime should accept only its own metadata result'
      )
    })

    await runCase('reconnectTerminal restores exited state when respawn fails synchronously', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-reconnect-fail',
        title: 'SSH Reconnect Fail',
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })
      backend.emitExitForTerminalId('ssh-reconnect-fail', 19)
      backend.failSpawnForTerminalId('ssh-reconnect-fail')

      await assertRejects(
        service.reconnectTerminal('ssh-reconnect-fail'),
        /intentional spawn failure/,
        'failed reconnect should reject with backend spawn error'
      )

      const tab = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'ssh-reconnect-fail')
      assertEqual(tab?.runtimeState, 'exited', 'failed reconnect should restore exited runtime state')
      assertEqual(tab?.lastExitCode, 19, 'failed reconnect should retain the previous exit code')
    })

    await runCase('monitor identity scopes ssh tabs by username on the same host', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-root',
        title: 'Root',
        host: 'shared.example.com',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24,
      } as any)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-app',
        title: 'App',
        host: 'shared.example.com',
        port: 22,
        username: 'app',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24,
      } as any)

      assertEqual(
        service.getMonitorIdentity('ssh-root'),
        'ssh://root@shared.example.com:22',
        'monitor identity should include the ssh username for privileged session isolation'
      )
      assertEqual(
        service.getMonitorIdentity('ssh-app'),
        'ssh://app@shared.example.com:22',
        'monitor identity should distinguish different usernames on the same host'
      )
    })

    await runCase('terminal-only configs survive persistence and restore', async () => {
      const backend1 = new FakeTerminalBackend()
      const service1 = createService(stateFilePath, backend1)
      ;(service1 as any).backends.set('serial', new FakeTerminalOnlyBackend())

      await service1.createTerminal({
        type: 'serial',
        id: 'serial-restore-a',
        title: 'Serial Restore A',
        cols: 96,
        rows: 28,
        devicePath: '/dev/tty.usbserial-A',
        baudRate: 115200
      } as any)
      service1.flushPersistedState()

      const store = new TerminalStateStore(stateFilePath)
      const snapshot = store.load()
      const serialRecord = snapshot.find((item) => item.id === 'serial-restore-a')
      assertCondition(
        !!serialRecord,
        'terminal-only config should remain in persisted terminal state'
      )
      assertEqual(
        serialRecord?.config.type,
        'serial',
        'persisted terminal-only config should keep its original type'
      )
      assertEqual(
        (serialRecord?.config as any).devicePath,
        '/dev/tty.usbserial-A',
        'persisted terminal-only config should preserve backend-specific fields'
      )

      const backend2 = new FakeTerminalBackend()
      const service2 = createService(stateFilePath, backend2)
      ;(service2 as any).backends.set('serial', new FakeTerminalOnlyBackend())

      const restore = await service2.restorePersistedTerminals()
      assertCondition(
        restore.restored.includes('serial-restore-a'),
        'terminal-only config should restore when its backend is registered'
      )
      assertCondition(
        service2.getDisplayTerminals().some((terminal) => terminal.id === 'serial-restore-a'),
        'restored terminal-only tab should exist in display inventory after restart'
      )
    })

    await runCase('sidecar-backed windows file operations refresh cwd and home before resolving paths', async () => {
      const backend = new FakeTerminalBackend()
      backend.setRemoteOsForTerminalId('ssh-win-sidecar-fs', 'windows')
      backend.setSystemInfoForTerminalId('ssh-win-sidecar-fs', {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.14393.0',
        arch: 'x64',
        hostname: 'ws2016',
        isRemote: true,
        shell: 'powershell.exe'
      })
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-win-sidecar-fs',
        title: 'Windows Sidecar FS',
        host: '192.168.64.11',
        port: 22,
        username: 'Administrator',
        authMethod: 'password',
        password: 'secret',
        cols: 120,
        rows: 32
      })

      backend.setCwdForTerminalId('ssh-win-sidecar-fs', 'C:\\Users\\Administrator')
      backend.setHomeDirForTerminalId('ssh-win-sidecar-fs', 'C:\\Users\\Administrator')
      backend.setRefreshSessionStateForTerminalId('ssh-win-sidecar-fs', () => {
        backend.setCwdForTerminalId('ssh-win-sidecar-fs', 'C:\\Windows')
        backend.setHomeDirForTerminalId('ssh-win-sidecar-fs', 'C:\\Users\\Administrator')
      })

      const listed = await service.listDirectory('ssh-win-sidecar-fs')
      const resolvedRelative = await service.resolvePathForFileSystem('ssh-win-sidecar-fs', 'System32')
      const resolvedHome = await service.resolvePathForFileSystem('ssh-win-sidecar-fs', '~\\Desktop')

      assertEqual(
        listed.path,
        'C:\\Windows',
        'default directory listing should use the refreshed sidecar cwd after manual prompt changes'
      )
      assertEqual(
        backend.getLastListDirectoryCall()?.dirPath,
        'C:\\Windows',
        'filesystem backend should receive the refreshed cwd for implicit listings'
      )
      assertEqual(
        resolvedRelative,
        'C:\\Windows\\System32',
        'relative path resolution should use the refreshed sidecar cwd'
      )
      assertEqual(
        resolvedHome,
        'C:\\Users\\Administrator\\Desktop',
        'home expansion should use the refreshed sidecar home directory'
      )
    })

    await runCase('terminal tab broadcasts include monitor identity for agent-created SSH tabs', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      const tabEvents: Array<{
        terminals: Array<{ id: string; monitorIdentity?: string }>
      }> = []
      service.setRawEventPublisher((channel, payload) => {
        if (channel === 'terminal:tabs') {
          tabEvents.push(
            payload as {
              terminals: Array<{ id: string; monitorIdentity?: string }>
            }
          )
        }
      })

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-agent-created-monitor',
        title: 'Agent Created Monitor',
        host: '10.0.0.9',
        port: 2222,
        username: 'deploy',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24
      })

      assertCondition(
        tabEvents.some((event) =>
          event.terminals.some(
            (terminal) =>
              terminal.id === 'ssh-agent-created-monitor' && terminal.monitorIdentity === 'ssh://deploy@10.0.0.9:2222'
          )
        ),
        'terminal:tabs should carry the same monitor identity as terminal:list'
      )
    })

    await runCase('closing a terminal completes and removes its active command callback', async () => {
      const backend = new FakeTerminalBackend()
      backend.setEmitExitOnKill(false)
      const service = createService(stateFilePath, backend)
      service.setRawEventPublisher(() => {})
      const terminal = await service.createTerminal({
        type: 'local',
        id: 'local-agent-close-active-task',
        title: 'Agent Close Active Task',
        cols: 80,
        rows: 24
      })
      terminal.runtimeState = 'ready'
      terminal.isInitializing = false

      let completionResult:
        | {
            exitCode?: number
            history_command_match_id: string
            runtimeBoundary?: boolean
          }
        | undefined
      let callbackObservedCleanState = false
      const taskId = await service.runCommandNoWait(terminal.id, 'sleep 60', (result) => {
        completionResult = result
        callbackObservedCleanState =
          !(service as any).activeTaskByTerminal.has(terminal.id) && !(service as any).tasksByTerminal.has(terminal.id)
      })

      service.kill(terminal.id)

      assertEqual(
        completionResult?.history_command_match_id,
        taskId,
        'terminal close should finish the registered command callback'
      )
      assertEqual(completionResult?.exitCode, -2, 'terminal close should report an aborted command exit code')
      assertEqual(
        completionResult?.runtimeBoundary,
        true,
        'terminal close should report that the active command did not reach a definitive completion boundary'
      )
      assertEqual(
        (service as any).onTaskFinishedCallbacks.size,
        0,
        'terminal close should not leak command completion callbacks'
      )
      assertEqual(
        callbackObservedCleanState,
        true,
        'terminal close should detach task state before notifying completion listeners'
      )
      assertEqual(
        service.getCommandOutputSnapshot(terminal.id, taskId)?.executionState,
        'outcome_unknown',
        'terminal close should leave a read-only historical snapshot addressable by exact terminal id'
      )
      assertEqual(
        service.getCommandOutputSnapshot(terminal.id, taskId)?.capture.reason,
        'runtime_boundary',
        'the detached snapshot must preserve why capture ended without a trusted boundary'
      )
      assertEqual(
        (service as any).detachedTasksByTerminal.has(terminal.id),
        true,
        'closed command history should use a detached namespace'
      )
    })

    await runCase('closing a terminal resolves an in-flight command wait as aborted', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      service.setRawEventPublisher(() => {})
      const terminal = await service.createTerminal({
        type: 'local',
        id: 'local-agent-close-waiting-task',
        title: 'Agent Close Waiting Task',
        cols: 80,
        rows: 24
      })
      terminal.runtimeState = 'ready'
      terminal.isInitializing = false

      const taskId = await service.runCommandNoWait(terminal.id, 'sleep 60')
      const waitingResult = service.waitForTask(terminal.id, taskId)

      service.kill(terminal.id)
      const result = await Promise.race([
        waitingResult,
        sleep(2_000).then(() => {
          throw new Error('command wait did not settle after its terminal was closed')
        })
      ])

      assertEqual(
        result.history_command_match_id,
        taskId,
        'terminal close should settle the same in-flight command task'
      )
      assertEqual(result.exitCode, -2, 'terminal close should resolve a waiting command with the aborted exit code')
      assertEqual(
        result.runtimeBoundary,
        true,
        'terminal close should preserve the unknown command outcome boundary for waiters'
      )
      assertCondition(
        /terminal tab was closed/i.test(result.terminalStatus || ''),
        'terminal close should explain why the waiting command was aborted without forging stdout'
      )
      assertEqual(result.stdoutDelta, '', 'terminal lifecycle status must not become captured command output')
      assertEqual(
        (service as any).tasksByTerminal.has(terminal.id),
        false,
        'settling a closed command wait should remove the live execution namespace'
      )
      assertEqual(
        service.getCommandTask(terminal.id, taskId)?.id,
        taskId,
        'settling a closed command wait should retain bounded read-only history'
      )
      assertEqual(
        (service as any).activeTaskByTerminal.has(terminal.id),
        false,
        'settling a closed command wait should clear the active task index'
      )
    })

    await runCase('failed backend kill restores the active command callback', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      service.setRawEventPublisher(() => {})
      const terminal = await service.createTerminal({
        type: 'local',
        id: 'local-agent-close-kill-failure',
        title: 'Agent Close Kill Failure',
        cols: 80,
        rows: 24
      })
      terminal.runtimeState = 'ready'
      terminal.isInitializing = false
      await service.runCommandNoWait(terminal.id, 'sleep 60', () => {})

      backend.setThrowOnKill(true)
      let failureMessage = ''
      try {
        service.kill(terminal.id)
      } catch (error) {
        failureMessage = error instanceof Error ? error.message : String(error)
      }

      assertCondition(
        /simulated backend kill failure/.test(failureMessage),
        'backend kill error should still be reported to the caller'
      )
      assertEqual(
        (service as any).onTaskFinishedCallbacks.size,
        1,
        'failed close should restore the still-active command callback'
      )
      assertCondition(
        service.getTerminalRuntimeSnapshot(terminal.id) !== null,
        'failed close should keep the terminal tab available'
      )

      backend.setThrowOnKill(false)
      service.kill(terminal.id)
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

void run()
  .then(() => {
    console.log('All terminal persistence extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
