import type {
  FileChunkReadResult,
  FileChunkWriteResult,
  FileStatInfo,
  FileSystemEntry,
  PeerFileTransferOptions,
  PeerFileTransferResult,
  TerminalBackend,
  TerminalCommandShellFamily,
  TerminalConfig,
  TerminalSystemInfo,
} from '../../types'
import { FileSystemService } from '../FileSystemService'
import { FileTransferService } from '../FileTransferService'
import {
  TerminalRuntimeChangedError,
  TerminalService,
} from '../TerminalService'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const assertRejects = async (
  operation: () => Promise<unknown> | unknown,
  expectedMessage: RegExp,
  message: string,
): Promise<void> => {
  try {
    await operation()
    throw new Error(`${message}: expected rejection`)
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error)
    if (!expectedMessage.test(actualMessage)) {
      throw new Error(
        `${message}: expected=${String(expectedMessage)} actual=${actualMessage}`,
      )
    }
  }
}

const runCase = async (
  name: string,
  operation: () => Promise<void> | void,
): Promise<void> => {
  await operation()
  console.log(`PASS ${name}`)
}

const createDeferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const waitUntil = async (
  predicate: () => boolean,
  message: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(message)
}

type FakeSession = {
  config: TerminalConfig
  dataCallbacks: Array<(data: string) => void>
  exitCallbacks: Array<(code: number) => void>
}

class CountingFilesystemBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()
  private readonly initializationStateByPtyId = new Map<
    string,
    'initializing' | 'ready' | 'failed'
  >()
  private readonly powerShellTerminalIds = new Set<string>()
  private readonly filesystemIoCalls: string[] = []
  private readonly writeCalls: Array<{ ptyId: string; data: string }> = []
  private readonly killCalls: string[] = []
  private peerFileTransferCalls = 0
  private emitExitOnKill = true
  private throwOnKill = false
  private deferredSpawn:
    | {
        gate: ReturnType<typeof createDeferred>
        started: ReturnType<typeof createDeferred>
      }
    | undefined
  private activeDeferredSpawn:
    | {
        gate: ReturnType<typeof createDeferred>
        started: ReturnType<typeof createDeferred>
      }
    | undefined

  private getPtyId(terminalId: string): string {
    // Deliberately reuse the backend key across reconnects to exercise ABA
    // fencing through object identity and runtime generation.
    return `pty-${terminalId}`
  }

  markPowerShellTerminal(terminalId: string): void {
    this.powerShellTerminalIds.add(terminalId)
  }

  setEmitExitOnKill(value: boolean): void {
    this.emitExitOnKill = value
  }

  setThrowOnKill(value: boolean): void {
    this.throwOnKill = value
  }

  deferNextSpawn(): Promise<void> {
    const gate = createDeferred()
    const started = createDeferred()
    this.deferredSpawn = { gate, started }
    return started.promise
  }

  releaseDeferredSpawn(): void {
    const deferred = this.activeDeferredSpawn ?? this.deferredSpawn
    if (!deferred) throw new Error('No deferred spawn is pending.')
    deferred.gate.resolve()
  }

  setInitializationState(
    terminalId: string,
    state: 'initializing' | 'ready' | 'failed',
  ): void {
    this.initializationStateByPtyId.set(this.getPtyId(terminalId), state)
  }

  emitData(terminalId: string, data: string): void {
    const session = this.sessions.get(this.getPtyId(terminalId))
    for (const callback of session?.dataCallbacks ?? []) callback(data)
  }

  emitExit(terminalId: string, code: number): void {
    const ptyId = this.getPtyId(terminalId)
    const session = this.sessions.get(ptyId)
    if (!session) return
    const callbacks = [...session.exitCallbacks]
    this.sessions.delete(ptyId)
    this.initializationStateByPtyId.delete(ptyId)
    for (const callback of callbacks) callback(code)
  }

  captureExitCallbacks(terminalId: string): Array<(code: number) => void> {
    return [
      ...(this.sessions.get(this.getPtyId(terminalId))?.exitCallbacks ?? []),
    ]
  }

  resetObservedIo(): void {
    this.filesystemIoCalls.length = 0
    this.writeCalls.length = 0
    this.peerFileTransferCalls = 0
  }

  getFilesystemIoCalls(): string[] {
    return [...this.filesystemIoCalls]
  }

  getWriteCalls(): Array<{ ptyId: string; data: string }> {
    return [...this.writeCalls]
  }

  getPeerFileTransferCalls(): number {
    return this.peerFileTransferCalls
  }

  getKillCalls(): string[] {
    return [...this.killCalls]
  }

  async spawn(config: TerminalConfig): Promise<string> {
    const deferred = this.deferredSpawn
    if (deferred) {
      this.deferredSpawn = undefined
      this.activeDeferredSpawn = deferred
      deferred.started.resolve()
      try {
        await deferred.gate.promise
      } finally {
        if (this.activeDeferredSpawn === deferred) {
          this.activeDeferredSpawn = undefined
        }
      }
    }
    const ptyId = this.getPtyId(config.id)
    this.sessions.set(ptyId, {
      config: { ...config },
      dataCallbacks: [],
      exitCallbacks: [],
    })
    this.initializationStateByPtyId.set(ptyId, 'initializing')
    return ptyId
  }

  write(ptyId: string, data: string): void {
    this.writeCalls.push({ ptyId, data })
  }

  resize(_ptyId: string, _cols: number, _rows: number): void {}

  kill(ptyId: string): void {
    this.killCalls.push(ptyId)
    if (this.throwOnKill) throw new Error('simulated backend kill failure')
    const session = this.sessions.get(ptyId)
    if (!session) return
    if (this.emitExitOnKill) {
      for (const callback of [...session.exitCallbacks]) callback(0)
    }
    this.sessions.delete(ptyId)
    this.initializationStateByPtyId.delete(ptyId)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    this.sessions.get(ptyId)?.dataCallbacks.push(callback)
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    this.sessions.get(ptyId)?.exitCallbacks.push(callback)
  }

  getInitializationState(
    ptyId: string,
  ): 'initializing' | 'ready' | 'failed' | undefined {
    return this.initializationStateByPtyId.get(ptyId)
  }

  getCommandShellFamily(
    ptyId: string,
  ): TerminalCommandShellFamily | undefined {
    const terminalId = this.sessions.get(ptyId)?.config.id
    return terminalId && this.powerShellTerminalIds.has(terminalId)
      ? 'powershell'
      : undefined
  }

  getCwd(_ptyId: string): string | undefined {
    this.filesystemIoCalls.push('getCwd')
    return '/tmp'
  }

  async getHomeDir(_ptyId: string): Promise<string | undefined> {
    this.filesystemIoCalls.push('getHomeDir')
    return '/home/tester'
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    this.filesystemIoCalls.push('getRemoteOs')
    return 'unix'
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    this.filesystemIoCalls.push('getSystemInfo')
    return {
      os: 'Linux',
      platform: 'linux',
      release: 'test',
      arch: 'x64',
      hostname: 'test-host',
      isRemote: true,
      shell: '/bin/bash',
    }
  }

  async refreshSessionState(_ptyId: string): Promise<void> {
    this.filesystemIoCalls.push('refreshSessionState')
  }

  async readFile(_ptyId: string, _filePath: string): Promise<Buffer> {
    this.filesystemIoCalls.push('readFile')
    return Buffer.from('data')
  }

  async writeFile(
    _ptyId: string,
    _filePath: string,
    _content: string,
  ): Promise<void> {
    this.filesystemIoCalls.push('writeFile')
  }

  async readFileChunk(
    _ptyId: string,
    _filePath: string,
    offset: number,
    _chunkSize: number,
  ): Promise<FileChunkReadResult> {
    this.filesystemIoCalls.push('readFileChunk')
    return {
      chunk: Buffer.from('x'),
      bytesRead: 1,
      totalSize: 1,
      nextOffset: offset + 1,
      eof: true,
    }
  }

  async writeFileChunk(
    _ptyId: string,
    _filePath: string,
    offset: number,
    content: Buffer,
  ): Promise<FileChunkWriteResult> {
    this.filesystemIoCalls.push('writeFileChunk')
    return {
      writtenBytes: content.length,
      nextOffset: offset + content.length,
    }
  }

  async downloadFileToLocalPath(
    _ptyId: string,
    _sourcePath: string,
    _targetLocalPath: string,
  ): Promise<{ totalBytes: number }> {
    this.filesystemIoCalls.push('downloadFileToLocalPath')
    return { totalBytes: 1 }
  }

  async uploadFileFromLocalPath(
    _ptyId: string,
    _sourceLocalPath: string,
    _targetPath: string,
  ): Promise<{ totalBytes: number }> {
    this.filesystemIoCalls.push('uploadFileFromLocalPath')
    return { totalBytes: 1 }
  }

  async statFile(_ptyId: string, filePath: string): Promise<FileStatInfo> {
    this.filesystemIoCalls.push('statFile')
    if (filePath === '/' || filePath === '/tmp' || filePath === '/dst') {
      return { exists: true, isDirectory: true, size: 0 }
    }
    return { exists: true, isDirectory: false, size: 1 }
  }

  async listDirectory(
    _ptyId: string,
    _dirPath: string,
  ): Promise<FileSystemEntry[]> {
    this.filesystemIoCalls.push('listDirectory')
    return []
  }

  async createDirectory(_ptyId: string, _dirPath: string): Promise<void> {
    this.filesystemIoCalls.push('createDirectory')
  }

  async createFile(_ptyId: string, _filePath: string): Promise<void> {
    this.filesystemIoCalls.push('createFile')
  }

  async deletePath(
    _ptyId: string,
    _targetPath: string,
    _options?: { recursive?: boolean },
  ): Promise<void> {
    this.filesystemIoCalls.push('deletePath')
  }

  async renamePath(
    _ptyId: string,
    _sourcePath: string,
    _targetPath: string,
  ): Promise<void> {
    this.filesystemIoCalls.push('renamePath')
  }

  async writeFileBytes(
    _ptyId: string,
    _filePath: string,
    _content: Buffer,
  ): Promise<void> {
    this.filesystemIoCalls.push('writeFileBytes')
  }

  async tryPeerFileTransfer(
    _sourcePtyId: string,
    _sourcePath: string,
    _targetPtyId: string,
    _targetPath: string,
    _options: PeerFileTransferOptions,
  ): Promise<PeerFileTransferResult> {
    this.peerFileTransferCalls += 1
    return { status: 'fallback', reason: 'direct-copy-failed' }
  }
}

const createService = (): {
  backend: CountingFilesystemBackend
  service: TerminalService
} => {
  const backend = new CountingFilesystemBackend()
  const service = new TerminalService()
  ;(service as any).backends.set('local', backend)
  ;(service as any).backends.set('ssh', backend)
  ;(service as any).backends.set('serial', backend)
  service.setRawEventPublisher(() => {})
  return { backend, service }
}

const sshConfig = (id: string): TerminalConfig => ({
  type: 'ssh',
  id,
  title: id,
  host: '10.0.0.8',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: 'secret',
  cols: 80,
  rows: 24,
})

const localConfig = (id: string): TerminalConfig => ({
  type: 'local',
  id,
  title: id,
  cols: 80,
  rows: 24,
})

const createReadySsh = async (
  service: TerminalService,
  backend: CountingFilesystemBackend,
  terminalId: string,
): Promise<void> => {
  await service.createTerminal(sshConfig(terminalId))
  backend.setInitializationState(terminalId, 'ready')
  backend.emitData(terminalId, 'ready\r\n')
  await flushMicrotasks()
  assertEqual(
    service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
    'ready',
    `${terminalId} should be ready`,
  )
}

const inactiveFilesystemOperations = (
  service: TerminalService,
  terminalId: string,
): Array<[string, () => Promise<unknown> | unknown]> => [
  [
    'runtime accessor',
    () => service.getTerminalFilesystemRuntime(terminalId),
  ],
  [
    'path resolution',
    () => service.resolvePathForFileSystem(terminalId, 'relative.txt'),
  ],
  [
    'cwd metadata',
    () => service.getCwd(terminalId, undefined, { filesystem: true }),
  ],
  [
    'home metadata',
    () => service.getHomeDir(terminalId, undefined, { filesystem: true }),
  ],
  [
    'OS metadata',
    () => service.getRemoteOs(terminalId, undefined, { filesystem: true }),
  ],
  [
    'filesystem identity',
    () =>
      service.getFileSystemIdentity(terminalId, undefined, {
        requireActive: true,
      }),
  ],
  [
    'transfer identity',
    () =>
      service.getTransferMachineIdentity(terminalId, undefined, {
        requireActive: true,
      }),
  ],
  ['file read', () => service.readFile(terminalId, '/tmp/file.txt')],
  [
    'file chunk read',
    () => service.readFileChunk(terminalId, '/tmp/file.txt', 0, 1024),
  ],
  [
    'file write',
    () => service.writeFile(terminalId, '/tmp/file.txt', 'data'),
  ],
  [
    'file chunk write',
    () =>
      service.writeFileChunk(
        terminalId,
        '/tmp/file.txt',
        0,
        Buffer.from('data'),
      ),
  ],
  ['file stat', () => service.statFile(terminalId, '/tmp/file.txt')],
  ['directory list', () => service.listDirectory(terminalId, '/tmp')],
  [
    'directory creation',
    () => service.createDirectory(terminalId, '/tmp/new-dir'),
  ],
  ['file creation', () => service.createFile(terminalId, '/tmp/new-file')],
  [
    'path deletion',
    () => service.deletePath(terminalId, '/tmp/file.txt'),
  ],
  [
    'path rename',
    () =>
      service.renamePath(
        terminalId,
        '/tmp/source.txt',
        '/tmp/target.txt',
      ),
  ],
  [
    'binary file write',
    () =>
      service.writeFileBytes(
        terminalId,
        '/tmp/file.bin',
        Buffer.from([1]),
      ),
  ],
  [
    'file download',
    () =>
      service.downloadFileToLocalPath(
        terminalId,
        '/tmp/file.txt',
        '/tmp/local.txt',
      ),
  ],
  [
    'file upload',
    () =>
      service.uploadFileFromLocalPath(
        terminalId,
        '/tmp/local.txt',
        '/tmp/file.txt',
      ),
  ],
]

const run = async (): Promise<void> => {
  await runCase(
    'SSH initialization rejects every direct filesystem entry before backend IO',
    async () => {
      const { backend, service } = createService()
      const terminalId = 'ssh-initializing-filesystem'
      await service.createTerminal(sshConfig(terminalId))
      await flushMicrotasks()
      backend.resetObservedIo()

      for (const [name, operation] of inactiveFilesystemOperations(
        service,
        terminalId,
      )) {
        await assertRejects(
          operation,
          /changed before|does not support filesystem/i,
          `initializing SSH ${name}`,
        )
      }

      assertEqual(
        backend.getFilesystemIoCalls().length,
        0,
        'inactive direct filesystem calls must execute zero backend IO',
      )
      assertEqual(
        backend.getPeerFileTransferCalls(),
        0,
        'inactive direct filesystem calls must execute zero peer transfers',
      )
      assertEqual(
        backend.getWriteCalls().length,
        0,
        'inactive direct filesystem calls must execute zero terminal writes',
      )
      service.kill(terminalId)
    },
  )

  await runCase(
    'local PowerShell bootstrap keeps filesystem access but rejects interrupt',
    async () => {
      const { backend, service } = createService()
      const terminalId = 'local-powershell-filesystem'
      backend.markPowerShellTerminal(terminalId)
      await service.createTerminal(localConfig(terminalId))
      await flushMicrotasks()
      backend.resetObservedIo()

      assertEqual(
        service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
        'initializing',
        'local PowerShell fixture should remain in bootstrap',
      )
      assertEqual(
        service.getTerminalRuntimeSnapshot(terminalId)?.canUseFilesystem,
        true,
        'active local bootstrap should retain filesystem capability',
      )
      await service.listDirectory(terminalId, '/tmp')
      assertCondition(
        backend.getFilesystemIoCalls().includes('listDirectory'),
        'active local bootstrap should dispatch directory IO',
      )

      backend.resetObservedIo()
      service.interrupt(terminalId)
      assertEqual(
        backend.getWriteCalls().length,
        0,
        'initializing local runtime must not receive Ctrl+C',
      )
      service.kill(terminalId)
    },
  )

  await runCase(
    'retained exited SSH tab rejects cached metadata and filesystem IO',
    async () => {
      const { backend, service } = createService()
      const terminalId = 'ssh-retained-exited-filesystem'
      await createReadySsh(service, backend, terminalId)
      assertEqual(
        service.getRemoteOs(terminalId),
        'unix',
        'fixture should cache remote OS before exit',
      )
      backend.emitExit(terminalId, 255)
      await flushMicrotasks()
      backend.resetObservedIo()

      await assertRejects(
        () =>
          service.getRemoteOs(terminalId, undefined, { filesystem: true }),
        /changed before/i,
        'cached filesystem OS metadata must still require an active runtime',
      )
      await assertRejects(
        () => service.listDirectory(terminalId, '/tmp'),
        /changed before/i,
        'retained exited tab must reject directory IO',
      )
      service.interrupt(terminalId)

      assertEqual(
        backend.getFilesystemIoCalls().length,
        0,
        'retained exited tab must execute zero backend metadata or filesystem IO',
      )
      assertEqual(
        backend.getWriteCalls().length,
        0,
        'retained exited tab must execute zero interrupt writes',
      )
      service.kill(terminalId)
    },
  )

  await runCase(
    'local auto-restart gap rejects filesystem IO until replacement binds',
    async () => {
      const { backend, service } = createService()
      const terminalId = 'local-restart-filesystem-gap'
      await service.createTerminal(localConfig(terminalId))
      await flushMicrotasks()
      const spawnStarted = backend.deferNextSpawn()
      backend.emitExit(terminalId, 129)
      await spawnStarted
      backend.resetObservedIo()

      assertEqual(
        service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
        'initializing',
        'local restart gap should be initializing',
      )
      await assertRejects(
        () => service.listDirectory(terminalId, '/tmp'),
        /changed before/i,
        'local restart gap must reject filesystem IO',
      )
      service.interrupt(terminalId)
      assertEqual(
        backend.getFilesystemIoCalls().length,
        0,
        'local restart gap must execute zero filesystem IO',
      )
      assertEqual(
        backend.getWriteCalls().length,
        0,
        'local restart gap must execute zero interrupt writes',
      )

      backend.releaseDeferredSpawn()
      await waitUntil(
        () =>
          service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState ===
          'ready',
        'local replacement runtime did not bind',
      )
      service.kill(terminalId)
    },
  )

  await runCase(
    'quarantine retires guards synchronously despite kill failure and stale callback',
    async () => {
      const { backend, service } = createService()
      const terminalId = 'ssh-quarantined-filesystem'
      await createReadySsh(service, backend, terminalId)
      const oldGuard = service.createTerminalRuntimeGuard(terminalId)
      const oldExitCallbacks = backend.captureExitCallbacks(terminalId)
      backend.setEmitExitOnKill(false)
      backend.setThrowOnKill(true)
      backend.resetObservedIo()

      const quarantined = (service as any).quarantineTerminalRuntime(
        terminalId,
        oldGuard.expectedPtyId,
        oldGuard.expectedRuntimeGeneration,
      )
      assertEqual(quarantined, true, 'current runtime should be quarantined')
      assertEqual(
        service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
        'exited',
        'kill failure must not undo quarantine state',
      )
      await assertRejects(
        () => service.assertTerminalRuntimeGuard(oldGuard, 'old lease check'),
        /changed before/i,
        'quarantine must invalidate the old guard immediately',
      )
      await assertRejects(
        () => service.listDirectory(terminalId, '/tmp'),
        /changed before/i,
        'quarantine must reject filesystem IO without waiting for exit callback',
      )
      service.interrupt(terminalId)
      assertEqual(
        backend.getFilesystemIoCalls().length,
        0,
        'quarantine must execute zero filesystem IO',
      )
      assertEqual(
        backend.getWriteCalls().length,
        0,
        'quarantine must execute zero interrupt writes',
      )

      backend.setThrowOnKill(false)
      const replacement = await service.reconnectTerminal(terminalId)
      backend.setInitializationState(terminalId, 'ready')
      backend.emitData(terminalId, 'replacement ready\r\n')
      await flushMicrotasks()
      const replacementGeneration =
        service.getTerminalRuntimeGeneration(terminalId)
      for (const callback of oldExitCallbacks) callback(255)
      assertEqual(
        service.getTerminalById(terminalId),
        replacement,
        'stale exit callback must not remove the replacement object',
      )
      assertEqual(
        service.getTerminalRuntimeGeneration(terminalId),
        replacementGeneration,
        'stale exit callback must not advance replacement generation',
      )
      assertEqual(
        service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
        'ready',
        'stale exit callback must not retire replacement runtime',
      )
      service.kill(terminalId)
    },
  )

  await runCase(
    'same-ID replacement rejects an old filesystem lease before backend IO',
    async () => {
      const { backend, service } = createService()
      const terminalId = 'ssh-filesystem-id-reuse'
      const config = sshConfig(terminalId)
      await createReadySsh(service, backend, terminalId)
      const oldGuard = service.createTerminalRuntimeGuard(terminalId)
      service.kill(terminalId)
      await createReadySsh(service, backend, terminalId)
      backend.resetObservedIo()

      await assertRejects(
        () => service.listDirectory(terminalId, '/tmp', oldGuard),
        /changed before/i,
        'old same-ID lease must reject replacement filesystem IO',
      )
      assertEqual(
        backend.getFilesystemIoCalls().length,
        0,
        'old same-ID lease must dispatch zero backend IO',
      )

      await service.listDirectory(terminalId, '/tmp')
      assertCondition(
        backend.getFilesystemIoCalls().includes('listDirectory'),
        'a newly captured lease should authorize the replacement runtime',
      )
      service.kill(config.id)
    },
  )

  await runCase(
    'dual-terminal transfer admission fails before scan, peer dispatch, or queue mutation',
    async () => {
      const { backend, service } = createService()
      await createReadySsh(service, backend, 'source-ready')
      await service.createTerminal(sshConfig('target-initializing'))
      await flushMicrotasks()
      backend.resetObservedIo()

      const fileSystemService = new FileSystemService(service)
      await assertRejects(
        () =>
          fileSystemService.transferEntries(
            'source-ready',
            ['/tmp/file.txt'],
            'target-initializing',
            '/dst',
          ),
        /changed before/i,
        'direct transfer must reject inactive target before scan',
      )

      let queuedTransferRuns = 0
      const transferService = new FileTransferService(
        {
          transferEntries: async () => {
            queuedTransferRuns += 1
            throw new Error('must not run')
          },
        } as unknown as FileSystemService,
        service,
      )
      let publishedTasks = 0
      transferService.setRawEventPublisher(() => {
        publishedTasks += 1
      })
      await assertRejects(
        () =>
          transferService.startTransfer({
            origin: 'user',
            sourceTerminalId: 'source-ready',
            sourcePaths: ['/tmp/file.txt'],
            targetTerminalId: 'target-initializing',
            targetDirPath: '/dst',
          }),
        /changed before/i,
        'queued transfer must reject inactive target before task creation',
      )

      await assertRejects(
        () =>
          service.tryPeerFileTransfer(
            'source-ready',
            '/tmp/file.txt',
            'target-initializing',
            '/dst/file.txt',
            { expectedBytes: 1 },
          ),
        /changed before/i,
        'peer transfer must reject inactive target before backend dispatch',
      )

      assertEqual(
        queuedTransferRuns,
        0,
        'inactive transfer admission must not start FileSystemService work',
      )
      assertEqual(
        transferService.listTransfers({ includeCompleted: true }).length,
        0,
        'inactive transfer admission must not mutate the task registry',
      )
      assertEqual(
        publishedTasks,
        0,
        'inactive transfer admission must not publish task events',
      )
      assertEqual(
        backend.getFilesystemIoCalls().length,
        0,
        'inactive dual-terminal admission must execute zero backend IO',
      )
      assertEqual(
        backend.getPeerFileTransferCalls(),
        0,
        'inactive dual-terminal admission must execute zero peer calls',
      )
      service.kill('source-ready')
      service.kill('target-initializing')
    },
  )

  await runCase(
    'terminal-only capability rejects filesystem access before backend methods',
    async () => {
      const { backend, service } = createService()
      const terminalId = 'serial-terminal-only-filesystem'
      await service.createTerminal({
        type: 'serial',
        id: terminalId,
        title: terminalId,
        cols: 80,
        rows: 24,
      } as TerminalConfig)
      await flushMicrotasks()
      backend.resetObservedIo()

      assertEqual(
        service.getTerminalRuntimeSnapshot(terminalId)?.canUseFilesystem,
        false,
        'terminal-only capability must not advertise filesystem access',
      )
      await assertRejects(
        () => service.listDirectory(terminalId, '/tmp'),
        /does not support filesystem/i,
        'terminal-only capability must reject direct filesystem access',
      )
      assertEqual(
        backend.getFilesystemIoCalls().length,
        0,
        'terminal-only capability rejection must execute zero backend IO',
      )
      service.kill(terminalId)
    },
  )

  console.log('PASS terminalFilesystemRuntime.extreme.spec: all 8 cases passed')
}

void run().catch((error) => {
  if (error instanceof TerminalRuntimeChangedError) {
    console.error(error.message)
  } else {
    console.error(error)
  }
  process.exit(1)
})
