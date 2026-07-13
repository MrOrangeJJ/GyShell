import type {
  TerminalBackend,
  TerminalCommandTrackingToken,
  TerminalCommandTrackingUpdate,
  TerminalConfig,
  TerminalSystemInfo
} from '../types'
import { TerminalService } from './TerminalService'

const WINDOWS_OSC_PRECMD = '\x1b]1337;gyshell_precmd;ec=0;cwd_b64=L3RtcA==\x07'
const WINDOWS_OSC_PRECMD_WITH_PROMPT =
  '\x1b]1337;gyshell_precmd;ec=0;cwd_b64=QzpcVXNlcnNcQWRtaW5pc3RyYXRvcg==;home_b64=QzpcVXNlcnNcQWRtaW5pc3RyYXRvcg==\x07'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

type FakeSession = {
  dataCallbacks: Array<(data: string) => void>
  exitCallbacks: Array<(code: number) => void>
}

class FakeCommandBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()
  private readonly writesByPtyId = new Map<string, string[]>()
  private readonly writeLog: Array<{ ptyId: string; data: string }> = []
  private readonly fileWritesByPtyId = new Map<string, Array<{ path: string; content: string }>>()
  private readonly trackingStateByPtyId = new Map<string, TerminalCommandTrackingUpdate>()
  private prepareTrackingError?: Error
  private pollTrackingError?: Error
  private promptFileDispatch = false
  private promptFileRequestPath?: string
  private promptFileOutputPath?: string
  private writeFileError?: Error
  private nextWriteError?: Error
  private nextWriteErrorHook?: () => void
  private writeErrorForData?: { data: string; error: Error }
  private nextKillError?: Error
  private deferNextKillExitCallback = false
  private nextWriteFileGate?: { promise: Promise<void>; onStarted: () => void }
  private nextWriteFileSuccessHook?: () => void
  private spawnCount = 0

  constructor(
    private readonly remoteOs: 'unix' | 'windows',
    private readonly systemInfo: TerminalSystemInfo,
    private readonly trackingMode?: TerminalCommandTrackingToken['mode']
  ) {}

  private getPtyId(terminalId: string): string {
    return `pty-${terminalId}`
  }

  async spawn(config: TerminalConfig): Promise<string> {
    this.spawnCount += 1
    const ptyId = this.getPtyId(config.id)
    this.sessions.set(ptyId, {
      dataCallbacks: [],
      exitCallbacks: []
    })
    this.writesByPtyId.set(ptyId, [])
    this.fileWritesByPtyId.set(ptyId, [])
    return ptyId
  }

  write(ptyId: string, data: string): void {
    const nextWriteError = this.nextWriteError
    this.nextWriteError = undefined
    if (nextWriteError) {
      const nextWriteErrorHook = this.nextWriteErrorHook
      this.nextWriteErrorHook = undefined
      nextWriteErrorHook?.()
      throw nextWriteError
    }
    if (this.writeErrorForData?.data === data) {
      const error = this.writeErrorForData.error
      this.writeErrorForData = undefined
      throw error
    }
    const writes = this.writesByPtyId.get(ptyId)
    if (!writes) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    writes.push(data)
    this.writeLog.push({ ptyId, data })
  }

  resize(_ptyId: string, _cols: number, _rows: number): void {}

  kill(ptyId: string): void {
    const nextKillError = this.nextKillError
    this.nextKillError = undefined
    if (nextKillError) {
      throw nextKillError
    }
    const session = this.sessions.get(ptyId)
    if (!session) {
      return
    }
    const finishExit = (): void => {
      session.exitCallbacks.forEach((callback) => callback(0))
      this.sessions.delete(ptyId)
    }
    if (this.deferNextKillExitCallback) {
      this.deferNextKillExitCallback = false
      queueMicrotask(finishExit)
      return
    }
    finishExit()
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    session.dataCallbacks.push(callback)
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    session.exitCallbacks.push(callback)
  }

  getCwd(_ptyId: string): string | undefined {
    return this.remoteOs === 'windows' ? 'C:/Users/Administrator' : '/tmp'
  }

  async getHomeDir(_ptyId: string): Promise<string | undefined> {
    return this.remoteOs === 'windows' ? 'C:/Users/Administrator' : '/tmp'
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return this.remoteOs
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    return this.systemInfo
  }

  async prepareCommandTracking(ptyId: string): Promise<TerminalCommandTrackingToken | undefined> {
    if (this.prepareTrackingError) {
      throw this.prepareTrackingError
    }
    if (!this.trackingMode) {
      return undefined
    }
    const baselineSequence = this.trackingStateByPtyId.get(ptyId)?.sequence || 0
    return {
      mode: this.trackingMode,
      baselineSequence,
      dispatchMode: this.promptFileDispatch ? 'prompt-file' : undefined,
      displayMode: this.promptFileDispatch ? 'synthetic-transcript' : undefined,
      commandRequestPath: this.promptFileDispatch ? this.promptFileRequestPath : undefined,
      commandOutputPath: this.promptFileDispatch ? this.promptFileOutputPath : undefined,
    }
  }

  async pollCommandTracking(
    ptyId: string,
    token: TerminalCommandTrackingToken
  ): Promise<TerminalCommandTrackingUpdate | undefined> {
    if (this.pollTrackingError) {
      throw this.pollTrackingError
    }
    const update = this.trackingStateByPtyId.get(ptyId)
    if (!update || update.mode !== token.mode || update.sequence <= token.baselineSequence) {
      return undefined
    }
    return update
  }

  emitData(terminalId: string, data: string): void {
    const session = this.sessions.get(this.getPtyId(terminalId))
    if (!session) {
      throw new Error(`Missing fake session for ${terminalId}`)
    }
    session.dataCallbacks.forEach((callback) => callback(data))
  }

  getLastWrite(terminalId: string): string {
    const writes = this.writesByPtyId.get(this.getPtyId(terminalId)) || []
    return writes[writes.length - 1] || ''
  }

  getWrites(terminalId: string): string[] {
    return [...(this.writesByPtyId.get(this.getPtyId(terminalId)) || [])]
  }

  getWriteLog(): Array<{ ptyId: string; data: string }> {
    return [...this.writeLog]
  }

  getLastFileWrite(terminalId: string): { path: string; content: string } | undefined {
    const writes = this.fileWritesByPtyId.get(this.getPtyId(terminalId)) || []
    return writes[writes.length - 1]
  }

  setTrackingState(terminalId: string, update: TerminalCommandTrackingUpdate): void {
    this.trackingStateByPtyId.set(this.getPtyId(terminalId), update)
  }

  setPrepareTrackingError(error?: Error): void {
    this.prepareTrackingError = error
  }

  setPollTrackingError(error?: Error): void {
    this.pollTrackingError = error
  }

  setPromptFileDispatch(requestPath?: string, outputPath?: string): void {
    this.promptFileDispatch = Boolean(requestPath)
    this.promptFileRequestPath = requestPath
    this.promptFileOutputPath = outputPath
  }

  setWriteFileError(error?: Error): void {
    this.writeFileError = error
  }

  setNextWriteError(error?: Error, onThrow?: () => void): void {
    this.nextWriteError = error
    this.nextWriteErrorHook = onThrow
  }

  setWriteErrorForData(data: string, error: Error): void {
    this.writeErrorForData = { data, error }
  }

  setNextKillError(error?: Error): void {
    this.nextKillError = error
  }

  deferNextKillExit(): void {
    this.deferNextKillExitCallback = true
  }

  getSpawnCount(): number {
    return this.spawnCount
  }

  delayNextWriteFile(promise: Promise<void>, onStarted: () => void): void {
    this.nextWriteFileGate = { promise, onStarted }
  }

  onNextWriteFileSuccess(callback: () => void): void {
    this.nextWriteFileSuccessHook = callback
  }

  async readFile(): Promise<Buffer> {
    throw new Error('not implemented')
  }

  async writeFile(ptyId: string, filePath: string, content: string): Promise<void> {
    const gate = this.nextWriteFileGate
    if (gate) {
      this.nextWriteFileGate = undefined
      gate.onStarted()
      await gate.promise
    }
    const writeFileError = this.writeFileError
    this.writeFileError = undefined
    if (writeFileError) {
      throw writeFileError
    }
    const writes = this.fileWritesByPtyId.get(ptyId)
    if (!writes) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    writes.push({ path: filePath, content })
    const successHook = this.nextWriteFileSuccessHook
    this.nextWriteFileSuccessHook = undefined
    successHook?.()
  }

  async readFileChunk(): Promise<any> {
    throw new Error('not implemented')
  }

  async writeFileChunk(): Promise<any> {
    throw new Error('not implemented')
  }

  async statFile(): Promise<any> {
    throw new Error('not implemented')
  }

  async listDirectory(): Promise<any> {
    throw new Error('not implemented')
  }

  async createDirectory(): Promise<void> {
    throw new Error('not implemented')
  }

  async createFile(): Promise<void> {
    throw new Error('not implemented')
  }

  async deletePath(): Promise<void> {
    throw new Error('not implemented')
  }

  async renamePath(): Promise<void> {
    throw new Error('not implemented')
  }

  async writeFileBytes(): Promise<void> {
    throw new Error('not implemented')
  }
}

const createService = (backend: FakeCommandBackend): TerminalService => {
  const service = new TerminalService()
  ;(service as any).backends.set('local', backend)
  ;(service as any).backends.set('ssh', backend)
  service.setRawEventPublisher(() => {})
  return service
}

const createUnixBackend = (): FakeCommandBackend =>
  new FakeCommandBackend('unix', {
    os: 'linux',
    platform: 'linux',
    release: '6.8.0',
    arch: 'x64',
    hostname: 'localhost',
    isRemote: false,
    shell: '/bin/bash'
  })

const createLocalTerminal = async (
  service: TerminalService,
  terminalId: string
): Promise<void> => {
  await service.createTerminal({
    type: 'local',
    id: terminalId,
    title: terminalId,
    cols: 120,
    rows: 32
  })
}

const createReadySshTerminal = async (
  service: TerminalService,
  terminalId: string
): Promise<void> => {
  await service.createTerminal({
    type: 'ssh',
    id: terminalId,
    title: terminalId,
    host: '192.0.2.10',
    port: 22,
    username: 'tester',
    authMethod: 'password',
    password: 'secret',
    cols: 120,
    rows: 32
  })
  const terminal = service
    .getDisplayTerminals()
    .find((item) => item.id === terminalId)
  if (!terminal) {
    throw new Error(`Missing SSH terminal ${terminalId}`)
  }
  terminal.isInitializing = false
  terminal.runtimeState = 'ready'
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const dumpViewport = (service: TerminalService, terminalId: string, rows: number): string => {
  const headless = (service as any).headlessPtys.get(terminalId)
  if (!headless) {
    return ''
  }
  const buffer = headless.buffer.active
  const start = buffer.baseY
  const end = Math.min(buffer.length - 1, start + rows - 1)
  const lines: string[] = []
  for (let i = start; i <= end; i += 1) {
    const line = buffer.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n')
}

const run = async (): Promise<void> => {
  await runCase('same-terminal command starts reserve before asynchronous preparation', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    await createLocalTerminal(service, 'reserved-start')
    const gate = createDeferred()
    const prepare = (service as any).prepareCommandTracking.bind(service)
    ;(service as any).prepareCommandTracking = async (terminal: any) => {
      await gate.promise
      return await prepare(terminal)
    }

    const first = service.runCommandNoWait('reserved-start', 'printf first')
    const competing = service.runCommandNoWait('reserved-start', 'printf second')
    gate.resolve()
    const outcomes = await Promise.allSettled([first, competing])

    assertEqual(outcomes[0]?.status, 'fulfilled', 'reserved command should start')
    assertEqual(outcomes[1]?.status, 'rejected', 'competing command should be rejected')
    assertEqual(
      service.getCommandTasks('reserved-start').length,
      1,
      'only one same-terminal task may be registered'
    )
    assertEqual(
      backend.getWrites('reserved-start').slice(-1)[0],
      'printf first\n',
      'only the reservation holder may reach the backend'
    )
  })

  await runCase('dispatch failures dispose every registered headless start marker', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    const terminalId = 'failed-dispatch-markers'
    await createLocalTerminal(service, terminalId)
    const headless = (service as any).headlessPtys.get(terminalId)
    if (!headless) {
      throw new Error('Missing headless terminal for marker disposal test')
    }
    let registeredMarkers = 0
    let disposedMarkers = 0
    ;(headless as any).registerMarker = () => {
      registeredMarkers += 1
      return {
        line: 0,
        dispose: () => {
          disposedMarkers += 1
        }
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      backend.setNextWriteError(new Error(`dispatch failure ${attempt}`))
      const outcome = await Promise.allSettled([
        service.runCommandNoWait(terminalId, `printf attempt-${attempt}`)
      ])
      assertEqual(outcome[0]?.status, 'rejected', 'each simulated dispatch should fail')
    }

    assertEqual(registeredMarkers, 3, 'each attempted dispatch should register one marker')
    assertEqual(disposedMarkers, 3, 'every failed dispatch marker should be disposed')
    assertEqual(
      (service as any).startMarkerByTaskId.size,
      0,
      'failed dispatches must not retain marker references'
    )
  })

  await runCase('stop during command preparation retains reservation until safe settlement', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    await createLocalTerminal(service, 'stopped-start')
    const baseline = backend.getWrites('stopped-start').length
    const gate = createDeferred()
    const prepare = (service as any).prepareCommandTracking.bind(service)
    ;(service as any).prepareCommandTracking = async (terminal: any) => {
      await gate.promise
      return await prepare(terminal)
    }
    const controller = new AbortController()
    const starting = service.runCommandAndWait(
      'stopped-start',
      'printf must-not-run',
      { signal: controller.signal, interruptOnAbort: false }
    )
    controller.abort()
    assertEqual(
      (service as any).commandStartReservationByTerminal.size,
      1,
      'non-cancellable preparation should retain the start reservation'
    )
    const competing = await Promise.allSettled([
      service.runCommandNoWait('stopped-start', 'printf competing')
    ])
    assertEqual(competing[0]?.status, 'rejected', 'a new command must not overlap stale preparation')
    gate.resolve()
    const outcome = await Promise.allSettled([starting])
    assertEqual(outcome[0]?.status, 'rejected', 'stopped startup should reject after preparation settles')
    assertEqual(
      (service as any).commandStartReservationByTerminal.size,
      0,
      'settlement should release the start reservation'
    )
    assertEqual(
      backend.getWrites('stopped-start').length,
      baseline,
      'late preparation must not dispatch the stopped command'
    )
  })

  await runCase('aborted input waiting on command preparation never dispatches later', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    const terminalId = 'stopped-deferred-input'
    await createLocalTerminal(service, terminalId)
    const gate = createDeferred()
    const prepareStarted = createDeferred()
    const prepare = (service as any).prepareCommandTracking.bind(service)
    ;(service as any).prepareCommandTracking = async (terminal: any) => {
      prepareStarted.resolve()
      await gate.promise
      return await prepare(terminal)
    }
    const starting = service.runCommandNoWait(
      terminalId,
      'printf command-after-preparation'
    )
    await prepareStarted.promise
    const controller = new AbortController()
    const inputSequence = service.writeInputSequence(
      terminalId,
      ['\x03', '\r'],
      { intervalMs: 100, signal: controller.signal }
    )
    await Promise.resolve()
    controller.abort()

    const inputOutcome = await Promise.allSettled([inputSequence])
    assertEqual(
      inputOutcome[0]?.status,
      'rejected',
      'stop must reject input waiting on command preparation'
    )
    gate.resolve()
    const startOutcome = await Promise.allSettled([starting])
    assertEqual(
      startOutcome[0]?.status,
      'fulfilled',
      'the pending command should dispatch'
    )
    assertEqual(
      backend.getWrites(terminalId).includes('\x03'),
      false,
      'an aborted control sequence must never be injected after command startup'
    )
    assertEqual(
      backend.getWrites(terminalId).includes('\r'),
      false,
      'the unsent sequence tail must never be injected after command startup'
    )
    service.kill(terminalId)
  })

  await runCase('deferred input failure cannot hide a successfully started command', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    const terminalId = 'failed-deferred-input'
    await createLocalTerminal(service, terminalId)
    const gate = createDeferred()
    const prepareStarted = createDeferred()
    const prepare = (service as any).prepareCommandTracking.bind(service)
    ;(service as any).prepareCommandTracking = async (terminal: any) => {
      prepareStarted.resolve()
      await gate.promise
      return await prepare(terminal)
    }
    const starting = service.runCommandNoWait(
      terminalId,
      'printf command-remains-tracked'
    )
    await prepareStarted.promise
    const deferredInput = 'DEFERRED_INPUT_WRITE_FAILURE'
    service.write(terminalId, deferredInput)
    backend.setWriteErrorForData(
      deferredInput,
      new Error('deferred input write failed')
    )
    gate.resolve()

    const outcome = await Promise.allSettled([starting])
    assertEqual(
      outcome[0]?.status,
      'fulfilled',
      'deferred input failure must not replace the successful task id'
    )
    const taskId =
      outcome[0]?.status === 'fulfilled' ? outcome[0].value : undefined
    assertEqual(
      service.getActiveTaskId(terminalId),
      taskId,
      'the successfully dispatched command must remain actively tracked'
    )
    assertEqual(
      backend.getWrites(terminalId).includes(deferredInput),
      false,
      'the failed deferred input should not appear as a successful write'
    )
    service.kill(terminalId)
  })

  await runCase('abort during delayed prompt-file write clears payload before deferred enter', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-abort',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const requestPath = 'C:/Windows/Temp/GyShell/abort-request.b64'
    backend.setPromptFileDispatch(
      requestPath,
      'C:/Windows/Temp/GyShell/abort-output.txt'
    )
    const writeGate = createDeferred()
    const writeStarted = createDeferred()
    backend.delayNextWriteFile(writeGate.promise, writeStarted.resolve)
    const service = createService(backend)
    await service.createTerminal({
      type: 'local',
      id: 'win-prompt-abort',
      title: 'Windows Prompt Abort',
      cols: 120,
      rows: 32
    })
    const baselineWrites = backend.getWrites('win-prompt-abort').length
    const controller = new AbortController()
    const starting = service.runCommandNoWait(
      'win-prompt-abort',
      'Write-Output danger',
      undefined,
      controller.signal
    )
    await writeStarted.promise
    controller.abort()
    service.write('win-prompt-abort', '\r')

    assertEqual(
      (service as any).commandStartReservationByTerminal.size,
      1,
      'the prompt request write must retain the terminal start reservation'
    )
    const competing = await Promise.allSettled([
      service.runCommandNoWait('win-prompt-abort', 'Write-Output competing')
    ])
    assertEqual(competing[0]?.status, 'rejected', 'a competing command must be rejected')
    assertEqual(
      backend.getWrites('win-prompt-abort').length,
      baselineWrites,
      'user enter must remain deferred while an unsafe payload may appear'
    )

    writeGate.resolve()
    const outcome = await Promise.allSettled([starting])
    assertEqual(outcome[0]?.status, 'rejected', 'the aborted command should never dispatch')
    const fileWrites = (backend as any).fileWritesByPtyId.get('pty-win-prompt-abort') as Array<{
      path: string
      content: string
    }>
    assertEqual(fileWrites[0]?.path, requestPath, 'the delayed payload should target the request file')
    assertEqual(
      Buffer.from(fileWrites[0]?.content || '', 'base64').toString('utf8'),
      'Write-Output danger',
      'the delayed backend write should have completed for the regression setup'
    )
    assertEqual(
      fileWrites[fileWrites.length - 1]?.content,
      '',
      'the request file must be cleared before the reservation is released'
    )
    assertEqual(
      JSON.stringify(backend.getWrites('win-prompt-abort').slice(baselineWrites)),
      JSON.stringify(['\r']),
      'only the deferred user enter may reach the prompt after cleanup'
    )
    assertEqual(
      service.getCommandTasks('win-prompt-abort').length,
      0,
      'the aborted payload must never register or dispatch a command task'
    )
  })

  await runCase('prompt-file trigger failure clears payload before deferred input is released', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-trigger-failure',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const requestPath = 'C:/Windows/Temp/GyShell/trigger-failure-request.b64'
    backend.setPromptFileDispatch(
      requestPath,
      'C:/Windows/Temp/GyShell/trigger-failure-output.txt'
    )
    const writeGate = createDeferred()
    const writeStarted = createDeferred()
    backend.delayNextWriteFile(writeGate.promise, writeStarted.resolve)
    const service = createService(backend)
    await service.createTerminal({
      type: 'local',
      id: 'win-prompt-trigger-failure',
      title: 'Windows Prompt Trigger Failure',
      cols: 120,
      rows: 32
    })
    const baselineWrites = backend.getWrites('win-prompt-trigger-failure').length
    backend.setNextWriteError(new Error('terminal input write failed before dispatch'))
    const starting = service.runCommandNoWait(
      'win-prompt-trigger-failure',
      'Write-Output must-not-run'
    )
    await writeStarted.promise
    service.write('win-prompt-trigger-failure', '\r')
    writeGate.resolve()

    const outcome = await Promise.allSettled([starting])
    assertEqual(outcome[0]?.status, 'rejected', 'a failed prompt trigger should reject startup')
    const fileWrites = (backend as any).fileWritesByPtyId.get(
      'pty-win-prompt-trigger-failure'
    ) as Array<{ path: string; content: string }>
    assertEqual(
      Buffer.from(fileWrites[0]?.content || '', 'base64').toString('utf8'),
      'Write-Output must-not-run',
      'the regression setup should persist the command before trigger failure'
    )
    assertEqual(
      fileWrites[fileWrites.length - 1]?.content,
      '',
      'trigger failure must clear the persisted request before releasing deferred input'
    )
    assertEqual(
      JSON.stringify(backend.getWrites('win-prompt-trigger-failure').slice(baselineWrites)),
      JSON.stringify(['\r']),
      'only deferred user input may reach the prompt after request cleanup'
    )
    assertEqual(
      service.getCommandTasks('win-prompt-trigger-failure').length,
      0,
      'a failed prompt trigger must not leave a tracked or ghost command task'
    )
  })

  await runCase('prompt cleanup and kill failure quarantine the runtime and drop deferred input', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-quarantine',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const requestPath = 'C:/Windows/Temp/GyShell/quarantine-request.b64'
    backend.setPromptFileDispatch(
      requestPath,
      'C:/Windows/Temp/GyShell/quarantine-output.txt'
    )
    const writeGate = createDeferred()
    const writeStarted = createDeferred()
    backend.delayNextWriteFile(writeGate.promise, writeStarted.resolve)
    const service = createService(backend)
    const terminalId = 'win-prompt-quarantine'
    await createReadySshTerminal(service, terminalId)
    const baselineWrites = backend.getWrites(terminalId).length
    backend.setNextWriteError(
      new Error('prompt trigger failed'),
      () => {
        backend.setWriteFileError(new Error('request cleanup failed'))
        backend.setNextKillError(new Error('runtime kill failed'))
      }
    )
    const starting = service.runCommandNoWait(
      terminalId,
      'Write-Output quarantined'
    )
    await writeStarted.promise
    service.writePaths(terminalId, ['C:/deferred path.txt'])
    service.write(terminalId, '\r')
    writeGate.resolve()

    const outcome = await Promise.allSettled([starting])
    assertEqual(outcome[0]?.status, 'rejected', 'unsafe startup should reject')
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'exited',
      'a runtime with an uncleared request and failed kill must be quarantined'
    )
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId).slice(baselineWrites)),
      JSON.stringify([]),
      'path input and Enter deferred behind the unsafe request must be dropped'
    )
    service.write(terminalId, '\r')
    assertEqual(
      backend.getWrites(terminalId).length,
      baselineWrites,
      'future input must remain blocked on the quarantined runtime'
    )
    assertEqual(
      service.getCommandTasks(terminalId).length,
      0,
      'quarantine must not leave a ghost command task'
    )
  })

  await runCase('prompt cleanup quarantine survives an asynchronous local exit', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local-quarantine',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/local-quarantine-request.b64',
      'C:/Windows/Temp/GyShell/local-quarantine-output.txt'
    )
    const service = createService(backend)
    const terminalId = 'win-prompt-local-quarantine'
    await service.createTerminal({
      type: 'local',
      id: terminalId,
      title: 'Windows Local Quarantine',
      cols: 120,
      rows: 32
    })
    backend.setNextWriteError(
      new Error('prompt trigger failed'),
      () => {
        backend.setWriteFileError(new Error('request cleanup failed'))
        backend.deferNextKillExit()
      }
    )

    const outcome = await Promise.allSettled([
      service.runCommandNoWait(terminalId, 'Write-Output quarantined-local')
    ])
    assertEqual(outcome[0]?.status, 'rejected', 'unsafe local startup should reject')
    await Promise.resolve()
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'exited',
      'an asynchronous local exit must preserve the explicit quarantine'
    )
    assertEqual(
      backend.getSpawnCount(),
      1,
      'a quarantined local runtime must not auto-restart after its delayed exit'
    )
    service.kill(terminalId)
  })

  await runCase('prompt-file io fence protects a replacement payload from late old-runtime writes', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-replacement',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/replacement-request.b64',
      'C:/Windows/Temp/GyShell/replacement-output.txt'
    )
    const oldWriteGate = createDeferred()
    const oldWriteStarted = createDeferred()
    backend.delayNextWriteFile(oldWriteGate.promise, oldWriteStarted.resolve)
    const service = createService(backend)
    const terminalId = 'win-prompt-replacement'
    await createReadySshTerminal(service, terminalId)
    const oldStarting = service.runCommandNoWait(
      terminalId,
      'Write-Output old-runtime'
    )
    await oldWriteStarted.promise

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing prompt-file replacement terminal')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'

    const replacementPrepared = createDeferred()
    const prepare = (service as any).prepareCommandTracking.bind(service)
    ;(service as any).prepareCommandTracking = async (terminal: any) => {
      const tracking = await prepare(terminal)
      replacementPrepared.resolve()
      return tracking
    }
    const replacementWriteBaseline = backend.getWrites(terminalId).length
    const replacementStarting = service.runCommandNoWait(
      terminalId,
      'Write-Output replacement-runtime'
    )
    let replacementSettled = false
    void replacementStarting.then(
      () => {
        replacementSettled = true
      },
      () => {
        replacementSettled = true
      }
    )
    await replacementPrepared.promise
    await Promise.resolve()
    service.write(terminalId, 'NEW_RUNTIME_INPUT')

    assertEqual(
      replacementSettled,
      false,
      'the replacement dispatch must wait for old request-file io to settle'
    )
    assertEqual(
      backend.getLastFileWrite(terminalId),
      undefined,
      'the replacement must not write its payload while the old write owns the shared path'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'the replacement must not send Enter before it owns the shared request path'
    )

    oldWriteGate.resolve()
    const outcomes = await Promise.allSettled([oldStarting, replacementStarting])
    assertEqual(outcomes[0]?.status, 'rejected', 'the old startup should reject after reconnect')
    assertEqual(
      outcomes[1]?.status,
      'fulfilled',
      'the replacement command should dispatch after the old io lease releases'
    )
    const replacementFileWrites = (backend as any).fileWritesByPtyId.get(
      `pty-${terminalId}`
    ) as Array<{ path: string; content: string }>
    assertEqual(
      Buffer.from(
        replacementFileWrites[replacementFileWrites.length - 1]?.content || '',
        'base64'
      ).toString('utf8'),
      'Write-Output replacement-runtime',
      'the final request payload must belong to the replacement command'
    )
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId).slice(replacementWriteBaseline)),
      JSON.stringify(['\r', 'NEW_RUNTIME_INPUT']),
      'only the replacement Enter may dispatch before its deferred input is released'
    )
    service.kill(terminalId)
  })

  await runCase('ordinary replacement input waits behind stale prompt-file io', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-input-fence',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/input-fence-request.b64',
      'C:/Windows/Temp/GyShell/input-fence-output.txt'
    )
    const oldWriteGate = createDeferred()
    const oldWriteStarted = createDeferred()
    backend.delayNextWriteFile(oldWriteGate.promise, oldWriteStarted.resolve)
    const service = createService(backend)
    const terminalId = 'win-prompt-input-fence'
    await createReadySshTerminal(service, terminalId)
    const oldStarting = service.runCommandNoWait(
      terminalId,
      'Write-Output stale-input-owner'
    )
    await oldWriteStarted.promise

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for ordinary input fence test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'
    const replacementWriteBaseline = backend.getWrites(terminalId).length

    service.write(terminalId, 'REPLACEMENT_USER_ENTER')
    await Promise.resolve()
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'ordinary input must not bypass an unsettled stale request write'
    )

    oldWriteGate.resolve()
    const oldOutcome = await Promise.allSettled([oldStarting])
    assertEqual(oldOutcome[0]?.status, 'rejected', 'the stale command should reject')
    await waitUntil(
      () => backend.getWrites(terminalId).includes('REPLACEMENT_USER_ENTER'),
      'replacement input should flush after stale request cleanup'
    )
    assertEqual(
      backend.getLastFileWrite(terminalId)?.content,
      '',
      'the stale request must be empty before replacement input is released'
    )
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId).slice(replacementWriteBaseline)),
      JSON.stringify(['REPLACEMENT_USER_ENTER']),
      'only the replacement input should reach the safe prompt'
    )
    service.kill(terminalId)
  })

  await runCase('aborted input sequence never leaks past a stale prompt-file io fence', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-aborted-input-fence',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/aborted-input-request.b64',
      'C:/Windows/Temp/GyShell/aborted-input-output.txt'
    )
    const oldWriteGate = createDeferred()
    const oldWriteStarted = createDeferred()
    backend.delayNextWriteFile(oldWriteGate.promise, oldWriteStarted.resolve)
    const service = createService(backend)
    const terminalId = 'win-prompt-aborted-input-fence'
    await createReadySshTerminal(service, terminalId)
    const oldStarting = service.runCommandNoWait(
      terminalId,
      'Write-Output stale-input-owner'
    )
    await oldWriteStarted.promise

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for aborted input test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'
    const replacementWriteBaseline = backend.getWrites(terminalId).length
    const controller = new AbortController()
    const inputSequence = service.writeInputSequence(
      terminalId,
      ['CANCELLED_REPLACEMENT_INPUT'],
      { signal: controller.signal }
    )
    await Promise.resolve()
    controller.abort()

    const inputOutcome = await Promise.allSettled([inputSequence])
    assertEqual(
      inputOutcome[0]?.status,
      'rejected',
      'stop must reject input waiting behind stale request io'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'aborted input must not write before the stale request settles'
    )

    oldWriteGate.resolve()
    const oldOutcome = await Promise.allSettled([oldStarting])
    assertEqual(oldOutcome[0]?.status, 'rejected', 'the stale command should reject')
    await Promise.resolve()
    await Promise.resolve()
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'aborted input must not write after the stale request settles'
    )
    service.kill(terminalId)
  })

  await runCase('input sequence rejects when its runtime changes behind a prompt-file io fence', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-input-runtime-change',
      isRemote: true,
      shell: 'powershell.exe'
    })
    const service = createService(backend)
    const terminalId = 'win-prompt-input-runtime-change'
    await createReadySshTerminal(service, terminalId)
    const promptFileIo = (service as any).reservePromptFileIo(terminalId)
    const inputSequence = service.writeInputSequence(
      terminalId,
      ['STALE_AGENT_INPUT']
    )
    await Promise.resolve()
    await Promise.resolve()

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for fenced input runtime-change test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'
    const replacementWriteBaseline = backend.getWrites(terminalId).length

    promptFileIo.release()
    const outcome = await Promise.allSettled([inputSequence])

    assertEqual(
      outcome[0]?.status,
      'rejected',
      'agent input must not report success after its accepted runtime was replaced'
    )
    assertEqual(
      outcome[0]?.status === 'rejected' &&
        String(outcome[0].reason).includes('changed while input was waiting'),
      true,
      'runtime replacement should surface an explicit fenced-input error'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'stale agent input must reach neither the exited runtime nor its replacement'
    )
    service.kill(terminalId)
  })

  await runCase('stale cleanup failure quarantines replacement input even when kill fails', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-stale-quarantine',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/stale-quarantine-request.b64',
      'C:/Windows/Temp/GyShell/stale-quarantine-output.txt'
    )
    const oldWriteGate = createDeferred()
    const oldWriteStarted = createDeferred()
    backend.delayNextWriteFile(oldWriteGate.promise, oldWriteStarted.resolve)
    const service = createService(backend)
    const terminalId = 'win-prompt-stale-quarantine'
    await createReadySshTerminal(service, terminalId)
    const oldStarting = service.runCommandNoWait(
      terminalId,
      'Write-Output uncleared-stale-command'
    )
    await oldWriteStarted.promise

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for stale quarantine test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'
    const replacementWriteBaseline = backend.getWrites(terminalId).length
    service.write(terminalId, 'UNSAFE_REPLACEMENT_ENTER')
    backend.onNextWriteFileSuccess(() => {
      backend.setWriteFileError(new Error('stale request cleanup failed'))
      backend.setNextKillError(new Error('replacement kill failed'))
    })

    oldWriteGate.resolve()
    const oldOutcome = await Promise.allSettled([oldStarting])
    assertEqual(oldOutcome[0]?.status, 'rejected', 'the stale command should reject')
    await Promise.resolve()
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'exited',
      'an uncleared shared request path must quarantine the replacement runtime'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'queued replacement input must be dropped when cleanup cannot prove safety'
    )
    service.write(terminalId, 'LATER_UNSAFE_INPUT')
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'future input must remain blocked after replacement quarantine'
    )
    assertEqual(
      Buffer.from(backend.getLastFileWrite(terminalId)?.content || '', 'base64').toString('utf8'),
      'Write-Output uncleared-stale-command',
      'the regression setup should leave the stale payload uncleared'
    )
    service.kill(terminalId)
  })

  await runCase('terminal close releases a pending start without allowing ghost dispatch', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    await createLocalTerminal(service, 'closed-start')
    const gate = createDeferred()
    const prepare = (service as any).prepareCommandTracking.bind(service)
    ;(service as any).prepareCommandTracking = async (terminal: any) => {
      await gate.promise
      return await prepare(terminal)
    }
    const starting = service.runCommandNoWait('closed-start', 'printf ghost')
    service.kill('closed-start')

    assertEqual(
      (service as any).commandStartReservationByTerminal.size,
      0,
      'closing the terminal should release its pending start reservation'
    )
    gate.resolve()
    const outcome = await Promise.allSettled([starting])
    assertEqual(outcome[0]?.status, 'rejected', 'closed runtime must reject the pending start')
    assertEqual(
      backend.getWriteLog().some((entry) => entry.data.includes('printf ghost')),
      false,
      'late preparation must never dispatch into a closed runtime'
    )
  })

  await runCase('same-terminal input sequences are atomic while different terminals progress concurrently', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    await createLocalTerminal(service, 'input-a')
    await createLocalTerminal(service, 'input-b')
    const aBaseline = backend.getWrites('input-a').length
    const logBaseline = backend.getWriteLog().length

    await Promise.allSettled([
      service.writeInputSequence('input-a', ['A', 'B'], { intervalMs: 20 }),
      service.writeInputSequence('input-a', ['1', '2'], { intervalMs: 20 }),
      service.writeInputSequence('input-b', ['X', 'Y'], { intervalMs: 20 })
    ])

    assertEqual(
      JSON.stringify(backend.getWrites('input-a').slice(aBaseline)),
      JSON.stringify(['A', 'B', '1', '2']),
      'same-terminal sequence items must never interleave'
    )
    const log = backend.getWriteLog().slice(logBaseline)
    const bFirst = log.findIndex((entry) => entry.data === 'X')
    const aLast = log.findIndex((entry) => entry.data === '2')
    assertEqual(
      bFirst >= 0 && bFirst < aLast,
      true,
      'another terminal should progress before terminal A drains its queue'
    )
  })

  await runCase('queued input never crosses an exit and reconnect boundary', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'remote-sequence-host',
      isRemote: true,
      shell: '/bin/bash'
    })
    const service = createService(backend)
    const terminalId = 'queued-input-reconnect'
    await createReadySshTerminal(service, terminalId)

    const first = service.writeInputSequence(
      terminalId,
      ['old-runtime-first', 'old-runtime-second'],
      { intervalMs: 200 }
    )
    await waitUntil(
      () => backend.getWrites(terminalId).includes('old-runtime-first'),
      'the first sequence should own the old runtime before reconnect'
    )
    const staleQueued = service.writeInputSequence(terminalId, ['stale-queued-input'])

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal after reconnect')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'
    const replacementBaseline = backend.getWrites(terminalId).length

    const outcomes = await Promise.allSettled([first, staleQueued])
    assertEqual(outcomes[0]?.status, 'rejected', 'the interrupted owner should reject')
    assertEqual(outcomes[1]?.status, 'rejected', 'queued old-runtime input should reject')
    assertEqual(
      backend.getWrites(terminalId).slice(replacementBaseline).includes('stale-queued-input'),
      false,
      'queued input from the old runtime must never reach the replacement shell'
    )
  })

  await runCase('late old-runtime callbacks cannot mutate replacement state', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'remote-stale-callback-host',
      isRemote: true,
      shell: '/bin/bash'
    })
    const service = createService(backend)
    const terminalId = 'stale-runtime-callback'
    await createReadySshTerminal(service, terminalId)
    const oldSession = (backend as any).sessions.get(`pty-${terminalId}`) as
      | FakeSession
      | undefined
    const oldDataCallback = oldSession?.dataCallbacks[0]
    const oldExitCallback = oldSession?.exitCallbacks[0]
    if (!oldDataCallback || !oldExitCallback) {
      throw new Error('Missing old runtime callbacks for stale callback test')
    }

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for stale callback test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'

    const sequenceController = new AbortController()
    const inputSequence = service.writeInputSequence(
      terminalId,
      ['replacement-sequence-first', 'replacement-sequence-second'],
      { intervalMs: 1000, signal: sequenceController.signal }
    )
    await waitUntil(
      () => backend.getWrites(terminalId).includes('replacement-sequence-first'),
      'the replacement input sequence should acquire its queue turn'
    )
    const replacementInputTail = (service as any).terminalInputSequenceTailByTerminal.get(
      terminalId
    )

    const prepareGate = createDeferred()
    const prepareStarted = createDeferred()
    const prepare = (service as any).prepareCommandTracking.bind(service)
    ;(service as any).prepareCommandTracking = async (terminal: any) => {
      prepareStarted.resolve()
      await prepareGate.promise
      return await prepare(terminal)
    }
    const replacementStarting = service.runCommandNoWait(
      terminalId,
      'printf replacement-command'
    )
    await prepareStarted.promise
    service.write(terminalId, 'REPLACEMENT_DEFERRED_INPUT')
    const replacementReservation = (service as any).commandStartReservationByTerminal.get(
      terminalId
    )

    oldDataCallback('STALE_OLD_RUNTIME_DATA')
    oldExitCallback(255)

    assertEqual(
      (service as any).commandStartReservationByTerminal.get(terminalId),
      replacementReservation,
      'a stale exit must not consume the replacement command reservation'
    )
    assertEqual(
      JSON.stringify(
        (service as any).deferredWritesDuringCommandStartByTerminal.get(terminalId)
      ),
      JSON.stringify(['REPLACEMENT_DEFERRED_INPUT']),
      'a stale exit must not delete input deferred for the replacement runtime'
    )
    assertEqual(
      (service as any).terminalInputSequenceTailByTerminal.get(terminalId),
      replacementInputTail,
      'a stale exit must not delete the replacement input queue tail'
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'ready',
      'a stale exit must not mark the replacement runtime exited'
    )
    assertEqual(
      service.getRecentOutput(terminalId).includes('STALE_OLD_RUNTIME_DATA'),
      false,
      'stale data callbacks must not publish into the replacement terminal'
    )

    sequenceController.abort()
    prepareGate.resolve()
    const outcomes = await Promise.allSettled([inputSequence, replacementStarting])
    assertEqual(outcomes[0]?.status, 'rejected', 'the test input sequence should stop cleanly')
    assertEqual(outcomes[1]?.status, 'fulfilled', 'the replacement command should still dispatch')
    assertEqual(
      backend.getWrites(terminalId).includes('REPLACEMENT_DEFERRED_INPUT'),
      true,
      'the replacement reservation should still release its deferred input'
    )
    service.kill(terminalId)
  })

  await runCase('stop after dispatch rejects agent wait while terminal tracking continues', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    await createLocalTerminal(service, 'continuing-stop')
    const controller = new AbortController()
    const waiting = service.runCommandAndWait(
      'continuing-stop',
      'printf continuing',
      { signal: controller.signal, interruptOnAbort: false }
    )
    await waitUntil(
      () => service.getActiveTaskId('continuing-stop') !== undefined,
      'command should dispatch before stop'
    )
    const taskId = service.getActiveTaskId('continuing-stop') as string
    controller.abort()
    const outcome = await Promise.allSettled([waiting])

    assertEqual(outcome[0]?.status, 'rejected', 'agent wait should reject')
    assertEqual(
      outcome[0]?.status === 'rejected'
        ? (outcome[0].reason as any).history_command_match_id
        : '',
      taskId,
      'AbortError should identify the continuing command'
    )
    assertEqual(
      service.getActiveTaskId('continuing-stop'),
      taskId,
      'the terminal process should remain active'
    )
    backend.emitData('continuing-stop', `done${WINDOWS_OSC_PRECMD}\n`)
    await waitUntil(
      () => service.getCommandTask('continuing-stop', taskId)?.status === 'finished',
      'terminal tracking should still observe completion'
    )
  })

  await runCase('stop after terminal exit never reports an aborted task as continuing', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'remote-stop-exit-host',
      isRemote: true,
      shell: '/bin/bash'
    })
    const service = createService(backend)
    const terminalId = 'stop-exit-race'
    await createReadySshTerminal(service, terminalId)
    const controller = new AbortController()
    const waiting = service.runCommandAndWait(
      terminalId,
      'printf race',
      { signal: controller.signal, interruptOnAbort: false }
    )
    await waitUntil(
      () => service.getActiveTaskId(terminalId) !== undefined,
      'the command should be active before the terminal exits'
    )
    const taskId = service.getActiveTaskId(terminalId) as string

    backend.kill(`pty-${terminalId}`)
    controller.abort()
    const outcome = await Promise.allSettled([waiting])

    assertEqual(outcome[0]?.status, 'rejected', 'stop should still reject the agent wait')
    assertEqual(
      outcome[0]?.status === 'rejected'
        ? (outcome[0].reason as any).commandContinues
        : true,
      false,
      'an exited and inactive task must not be tagged as continuing'
    )
    assertEqual(
      (service as any).tasksByTerminal.get(terminalId)?.[taskId]?.status,
      'aborted',
      'terminal exit should retain the task only as an aborted record'
    )
    assertEqual(
      service.getActiveTaskId(terminalId),
      undefined,
      'terminal exit should remove the task from active tracking'
    )
  })

  await runCase('terminal exit settles a wait even when no stop signal follows', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'remote-exit-host',
      isRemote: true,
      shell: '/bin/bash'
    })
    const service = createService(backend)
    const terminalId = 'exit-without-stop'
    await createReadySshTerminal(service, terminalId)
    const waiting = service.runCommandAndWait(terminalId, 'printf exit')
    await waitUntil(
      () => service.getActiveTaskId(terminalId) !== undefined,
      'the command should be active before the terminal exits'
    )

    backend.kill(`pty-${terminalId}`)
    const result = await waiting

    assertEqual(
      result.stdoutDelta,
      'Terminal exited before command completion.',
      'an exited task should settle immediately with an explicit outcome'
    )
    assertEqual(
      result.runtimeBoundary,
      true,
      'an exited task must create a runtime boundary for later mutations'
    )
    assertEqual(
      service.getActiveTaskId(terminalId),
      undefined,
      'the exited command should not remain active'
    )
  })

  await runCase('terminal exit settles a nowait callback with an unknown runtime boundary', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'remote-nowait-exit-host',
      isRemote: true,
      shell: '/bin/bash'
    })
    const service = createService(backend)
    const terminalId = 'nowait-exit-callback'
    await createReadySshTerminal(service, terminalId)
    const callbackResults: Array<{
      stdoutDelta: string
      exitCode?: number
      history_command_match_id: string
      runtimeBoundary?: boolean
    }> = []
    const taskId = await service.runCommandNoWait(
      terminalId,
      'printf background-exit',
      (result) => callbackResults.push(result)
    )

    backend.kill(`pty-${terminalId}`)

    assertEqual(callbackResults.length, 1, 'terminal exit should settle the nowait callback exactly once')
    assertEqual(
      callbackResults[0]?.history_command_match_id,
      taskId,
      'the exit callback should preserve the original command task id'
    )
    assertEqual(
      callbackResults[0]?.runtimeBoundary,
      true,
      'the exit callback must report that command outcome is unknown across the runtime boundary'
    )
    assertEqual(
      callbackResults[0]?.stdoutDelta,
      'Terminal exited before command completion.',
      'the exit callback should include an explicit non-success outcome'
    )
    assertEqual(
      (service as any).tasksByTerminal.get(terminalId)?.[taskId]?.status,
      'aborted',
      'terminal exit should retain the nowait task as aborted rather than finished'
    )
    assertEqual(
      (service as any).onTaskFinishedCallbacks.has(taskId),
      false,
      'the completion callback must be removed before it can fire again'
    )
  })

  await runCase('windows command waits can finish from an explicit marker even when the marker is chunked', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: false,
      shell: 'powershell.exe'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local',
      title: 'Windows Local',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local', 'Get-Date')
    const waitPromise = service.waitForTask('win-local', taskId)
    const payload = backend.getLastWrite('win-local')

    assertEqual(payload, 'Get-Date\r', 'windows command execution should preserve the original command text')

    backend.emitData('win-local', '2026-04-03 22:12:00\r\n__GYSHELL_TASK_FIN')
    backend.emitData('win-local', 'ISH__::ec=0\r\n')

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'windows explicit marker should carry the exit code')
    assertEqual(
      result.stdoutDelta.trim(),
      '2026-04-03 22:12:00',
      'windows marker line should be stripped from the task output'
    )
  })

  await runCase('windows finish markers are stripped even when they follow no-newline output', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.17763',
      arch: 'x64',
      hostname: 'ws2019',
      isRemote: false,
      shell: 'powershell.exe'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-inline-marker',
      title: 'Windows Local Inline Marker',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-inline-marker', 'Write-Host -NoNewline "hello"')
    const waitPromise = service.waitForTask('win-local-inline-marker', taskId)

    backend.emitData('win-local-inline-marker', 'hello__GYSHELL_TASK_FINISH__::ec=0\r\n')

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'inline finish markers should still carry the exit code')
    assertEqual(result.stdoutDelta, 'hello', 'inline finish markers should be stripped without losing visible output')
  })

  await runCase('windows local downlevel sessions keep the raw command visible and finish through the sidecar tracker', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-sidecar',
      title: 'Windows Local Sidecar',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-sidecar', 'Write-Output 456')
    const waitPromise = service.waitForTask('win-local-sidecar', taskId)
    const payload = backend.getLastWrite('win-local-sidecar')

    assertEqual(
      payload,
      'Write-Output 456\r',
      'downlevel local windows commands should stay raw on the visible terminal'
    )

    backend.emitData('win-local-sidecar', '456\r\n')
    backend.emitData('win-local-sidecar', 'PS C:\\Windows>\r\n')
    backend.setTrackingState('win-local-sidecar', {
      mode: 'windows-powershell-sidecar',
      sequence: 4,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'local windows sidecar tracking should finish the task')
    assertEqual(result.stdoutDelta.trim(), '456', 'local windows sidecar should keep task output clean')
  })

  await runCase('windows sidecar prompt-file dispatch writes a hidden request file and triggers prompt execution with a bare enter', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'C:/Windows/Temp/GyShell/exec-output.txt'
    )
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-prompt-file',
      title: 'Windows Local Prompt File',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-prompt-file', 'Get-Content \"$env:TEMP\\\\demo.txt\"')
    const waitPromise = service.waitForTask('win-local-prompt-file', taskId)
    const fileWrite = backend.getLastFileWrite('win-local-prompt-file')

    assertEqual(
      fileWrite?.path,
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'prompt-file dispatch should target the hidden request file path from the backend token'
    )
    assertEqual(
      Buffer.from(fileWrite?.content || '', 'base64').toString('utf8'),
      'Get-Content \"$env:TEMP\\\\demo.txt\"',
      'prompt-file dispatch should store the original command text as base64 in the hidden request file'
    )
    assertEqual(
      backend.getLastWrite('win-local-prompt-file'),
      '\r',
      'prompt-file dispatch should only send a bare enter to trigger the prompt hook'
    )

    backend.setTrackingState('win-local-prompt-file', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator',
      output: 'demo-output\r\n'
    })

    const result = await waitPromise
    assertEqual(result.exitCode, 0, 'prompt-file dispatch should still complete through the sidecar tracker')
    assertEqual(result.stdoutDelta.trim(), 'demo-output', 'prompt-file dispatch should preserve the visible command output')
  })

  await runCase('windows sidecar prompt-file dispatch falls back to typed command injection when the hidden request write fails', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'C:/Windows/Temp/GyShell/exec-output.txt'
    )
    backend.setWriteFileError(new Error('temporary write failure'))
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-prompt-file-fallback',
      title: 'Windows Local Prompt File Fallback',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-prompt-file-fallback', 'Get-Date')
    const waitPromise = service.waitForTask('win-local-prompt-file-fallback', taskId)

    assertEqual(
      backend.getLastWrite('win-local-prompt-file-fallback'),
      'Get-Date\r',
      'prompt-file dispatch failures should fall back to the normal visible command write path'
    )

    backend.emitData('win-local-prompt-file-fallback', '2026-04-04\r\n')
    backend.emitData('win-local-prompt-file-fallback', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-local-prompt-file-fallback', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise
    assertEqual(result.exitCode, 0, 'fallback command injection should still complete through the sidecar tracker')
  })

  await runCase('windows sidecar prompt-file dispatch keeps the headless viewport clean on downlevel hosts', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'C:/Windows/Temp/GyShell/exec-output.txt'
    )
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-synthetic-display',
      title: 'Windows Local Synthetic Display',
      cols: 120,
      rows: 20
    })

    backend.emitData('win-local-synthetic-display', 'PS C:\\Users\\Administrator> ')

    const taskId = await service.runCommandNoWait(
      'win-local-synthetic-display',
      'Write-Output 123'
    )
    const waitPromise = service.waitForTask('win-local-synthetic-display', taskId)

    backend.emitData(
      'win-local-synthetic-display',
      '\x1b[3;1HPS C:\\Users\\Administrator> Write-Output 123\x1b[4;1HrdwareAbstractionLayer'
    )
    backend.setTrackingState('win-local-synthetic-display', {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator',
      output: '123\r\n'
    })

    const result = await waitPromise
    const viewport = dumpViewport(service, 'win-local-synthetic-display', 6)

    assertEqual(result.exitCode, 0, 'synthetic display sidecar tasks should still complete')
    assertEqual(result.stdoutDelta.trim(), '123', 'synthetic display should preserve the normalized stdout')
    if (!viewport.includes('PS C:\\Users\\Administrator> Write-Output 123')) {
      throw new Error('synthetic display should render a clean prompt+command line in headless xterm')
    }
    if (!viewport.includes('123')) {
      throw new Error('synthetic display should render command output in headless xterm')
    }
    if (viewport.includes('rdwareAbstractionLayer')) {
      throw new Error('synthetic display should prefer hidden clean output over noisy raw shellhost fragments')
    }
    if (viewport.includes('\x1b[')) {
      throw new Error('synthetic display should not leak raw VT control sequences into the headless viewport')
    }
  })

  await runCase('prepareCommandTracking failures do not block command dispatch', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPrepareTrackingError(new Error('temporary marker read failure'))
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-prepare-error',
      title: 'Windows Local Prepare Error',
      cols: 120,
      rows: 32
    })

    await service.runCommandNoWait('win-local-prepare-error', 'Write-Output 789')

    assertEqual(
      backend.getLastWrite('win-local-prepare-error'),
      'Write-Output 789\r',
      'command dispatch should continue even when command tracking preparation fails'
    )
  })

  await runCase('windows ssh downlevel sessions keep the raw command visible and finish through the sidecar tracker', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh',
      title: 'Windows SSH',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item) => item.id === 'win-ssh')
    if (!terminal) {
      throw new Error('Missing Windows SSH terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh', 'Write-Output 123')
    const waitPromise = service.waitForTask('win-ssh', taskId)
    const payload = backend.getLastWrite('win-ssh')

    assertEqual(
      payload,
      'Write-Output 123\r',
      'downlevel windows ssh commands should stay raw on the visible terminal'
    )

    backend.emitData('win-ssh', '123\r\n')
    backend.emitData('win-ssh', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh', {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'windows ssh sidecar tracking should finish the task')
    assertEqual(result.stdoutDelta.trim(), '123', 'windows ssh sidecar mode should keep task output clean')
  })

  await runCase('windows sidecar tracking waits for the rendered prompt before finalizing delayed output', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 10
    service.commandTrackingPromptSyncPollIntervalMs = 10

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-delayed-prompt',
      title: 'Windows SSH Delayed Prompt',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-delayed-prompt')
    if (!terminal) {
      throw new Error('Missing Windows SSH delayed prompt terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh-delayed-prompt', 'Write-Output delayed')
    backend.setTrackingState('win-ssh-delayed-prompt', {
      mode: 'windows-powershell-sidecar',
      sequence: 9,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/Administrator'
    })

    setTimeout(() => {
      backend.emitData('win-ssh-delayed-prompt', 'delayed\r\n')
      backend.emitData('win-ssh-delayed-prompt', 'PS C:\\Windows>\r\n')
    }, 200)

    const result = await service.waitForTask('win-ssh-delayed-prompt', taskId)

    assertEqual(result.exitCode, 0, 'sidecar prompt sync should still preserve the exit code')
    assertEqual(
      result.stdoutDelta.trim(),
      'delayed',
      'sidecar prompt sync should wait for delayed stdout and prompt bytes before finishing'
    )
  })

  await runCase('windows output normalization preserves prompt-like text that belongs to real command output', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-prompt-text',
      title: 'Windows SSH Prompt Text',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-prompt-text')
    if (!terminal) {
      throw new Error('Missing Windows SSH prompt text terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh-prompt-text', 'Write-Output "done"')
    const waitPromise = service.waitForTask('win-ssh-prompt-text', taskId)

    backend.emitData('win-ssh-prompt-text', 'Example transcript: PS C:\\repo> npm test\r\n')
    backend.emitData('win-ssh-prompt-text', 'done\r\n')
    backend.emitData('win-ssh-prompt-text', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh-prompt-text', {
      mode: 'windows-powershell-sidecar',
      sequence: 7,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    if (!result.stdoutDelta.includes('Example transcript: PS C:\\repo> npm test')) {
      throw new Error('prompt-like text that belongs to real output should be preserved verbatim')
    }
  })

  await runCase('windows output normalization preserves standalone prompt-looking output lines', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-standalone-prompt-output',
      title: 'Windows SSH Standalone Prompt Output',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service
      .getDisplayTerminals()
      .find((item: any) => item.id === 'win-ssh-standalone-prompt-output')
    if (!terminal) {
      throw new Error('Missing Windows SSH standalone prompt terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait(
      'win-ssh-standalone-prompt-output',
      "Write-Output 'PS C:\\repo>'"
    )
    const waitPromise = service.waitForTask('win-ssh-standalone-prompt-output', taskId)

    backend.emitData('win-ssh-standalone-prompt-output', 'PS C:\\repo>\r\n')
    backend.emitData('win-ssh-standalone-prompt-output', 'done\r\n')
    backend.emitData('win-ssh-standalone-prompt-output', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh-standalone-prompt-output', {
      mode: 'windows-powershell-sidecar',
      sequence: 8,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    if (!result.stdoutDelta.includes('PS C:\\repo>')) {
      throw new Error('standalone prompt-looking output should be preserved')
    }
    if (result.stdoutDelta.includes('PS C:\\Users\\Administrator>')) {
      throw new Error('the trailing shell prompt should still be removed from finished output')
    }
  })

  await runCase('windows ssh sidecar output still prefers cleaned streamed data when rendered output collapses to a prompt', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-noise',
      title: 'Windows SSH Noise',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item) => item.id === 'win-ssh-noise')
    if (!terminal) {
      throw new Error('Missing Windows SSH noise terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    ;(service as any).getRenderedTaskOutput = () => 'PS C:\\Users\\Administrator>'

    const taskId = await service.runCommandNoWait('win-ssh-noise', 'Write-Output 123')
    const waitPromise = service.waitForTask('win-ssh-noise', taskId)
    const payload = backend.getLastWrite('win-ssh-noise').trim()

    backend.emitData('win-ssh-noise', `\x1b[2J\x1b[HPS C:\\Users\\Administrator>${payload}\r\n`)
    backend.emitData('win-ssh-noise', '123\r\n')
    backend.emitData('win-ssh-noise', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh-noise', {
      mode: 'windows-powershell-sidecar',
      sequence: 3,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    assertEqual(
      result.stdoutDelta.trim(),
      '123',
      'windows ssh cleanup should keep stdout even when rendered output degenerates to a prompt'
    )
  })

  await runCase('modern windows output prefers rendered text when streamed output is polluted by repeated command echoes', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win11',
      isRemote: true,
      shell: 'powershell.exe'
    })
    const service = createService(backend) as any

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-modern-echo-noise',
      title: 'Windows SSH Modern Echo Noise',
      host: '192.168.64.12',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-modern-echo-noise')
    if (!terminal) {
      throw new Error('Missing Windows SSH modern echo noise terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    service.getRenderedTaskOutput = () => 'WIN_OK'

    const taskId = await service.runCommandNoWait('win-ssh-modern-echo-noise', 'cmd /c "echo WIN_OK"')
    const waitPromise = service.waitForTask('win-ssh-modern-echo-noise', taskId)

    backend.emitData(
      'win-ssh-modern-echo-noise',
      `cmd /c "echcmd /c "echocmd /c "echo WIN_OK"\r\nWIN_OK\r\n${WINDOWS_OSC_PRECMD_WITH_PROMPT}PS C:\\Users\\Administrator> `
    )

    const result = await waitPromise

    assertEqual(
      result.stdoutDelta,
      'WIN_OK',
      'modern windows waits should prefer clean rendered output over fragmented command-echo pollution'
    )
  })

  await runCase('modern windows output preserves standalone prompt-looking output lines', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win11',
      isRemote: true,
      shell: 'powershell.exe'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-modern-prompt-output',
      title: 'Windows SSH Modern Prompt Output',
      host: '192.168.64.12',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-modern-prompt-output')
    if (!terminal) {
      throw new Error('Missing Windows SSH modern prompt output terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait(
      'win-ssh-modern-prompt-output',
      "Write-Output 'PS C:\\repo>'"
    )
    const waitPromise = service.waitForTask('win-ssh-modern-prompt-output', taskId)

    backend.emitData(
      'win-ssh-modern-prompt-output',
      `Write-Output 'PS C:\\repo>'\r\nPS C:\\repo>\r\n${WINDOWS_OSC_PRECMD_WITH_PROMPT}PS C:\\Users\\Administrator> `
    )

    const result = await waitPromise

    assertEqual(
      result.stdoutDelta,
      'PS C:\\repo>',
      'modern windows waits should preserve standalone prompt-looking output while still stripping the trailing shell prompt'
    )
  })

  await runCase('windows sidecar tracking failures fail fast instead of hanging until the wait timeout', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPollTrackingError(new Error('sftp channel reset'))
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 10
    service.commandTrackingMaxConsecutiveErrors = 2

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-tracking-failure',
      title: 'Windows SSH Tracking Failure',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-tracking-failure')
    if (!terminal) {
      throw new Error('Missing Windows SSH tracking failure terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh-tracking-failure', 'Write-Output 123')
    backend.emitData('win-ssh-tracking-failure', '123\r\n')
    const result = await service.waitForTask('win-ssh-tracking-failure', taskId)

    assertEqual(result.exitCode, -1, 'tracking loss should end the wait with an explicit failure code')
    assertEqual(
      result.runtimeBoundary,
      true,
      'tracking loss must create a runtime boundary because the command may still be running'
    )
    if (!result.stdoutDelta.includes('Hidden command-tracking channel failed')) {
      throw new Error('tracking loss should surface a clear diagnostic instead of timing out silently')
    }
  })

  await runCase('unix commands continue to use the shell-integration OSC path without wrapping', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'ubuntu',
      isRemote: false,
      shell: '/bin/bash'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'unix-local',
      title: 'Unix Local',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('unix-local', 'printf test')
    const waitPromise = service.waitForTask('unix-local', taskId)
    const payload = backend.getLastWrite('unix-local')

    assertEqual(payload, 'printf test\n', 'unix command execution should stay unwrapped')

    backend.emitData('unix-local', `test${WINDOWS_OSC_PRECMD}\n`)
    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'unix osc marker should still finish the task')
    assertEqual(result.stdoutDelta.trim(), 'test', 'unix output should remain visible')
  })

  await runCase('waitForTask suppresses nowait finish callback when manual wait consumes completion', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'ubuntu',
      isRemote: false,
      shell: '/bin/bash'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'unix-nowait-suppressed',
      title: 'Unix Nowait Suppressed',
      cols: 120,
      rows: 32
    })

    let callbackCount = 0
    const taskId = await service.runCommandNoWait('unix-nowait-suppressed', 'printf suppressed', () => {
      callbackCount += 1
    })
    const waitPromise = service.waitForTask('unix-nowait-suppressed', taskId, {
      suppressFinishCallback: true
    })

    backend.emitData('unix-nowait-suppressed', `suppressed${WINDOWS_OSC_PRECMD}\n`)
    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'manual wait should still receive the finished result')
    assertEqual(result.stdoutDelta.trim(), 'suppressed', 'manual wait should receive command output')
    assertEqual(callbackCount, 0, 'manual wait should suppress the nowait completion callback')
  })

  await runCase('waitForTask clears finish callback suppression when user skips manual wait', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'ubuntu',
      isRemote: false,
      shell: '/bin/bash'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'unix-nowait-suppression-cleared',
      title: 'Unix Nowait Suppression Cleared',
      cols: 120,
      rows: 32
    })

    let callbackCount = 0
    let callbackTaskId = ''
    const taskId = await service.runCommandNoWait('unix-nowait-suppression-cleared', 'printf cleared', (result) => {
      callbackCount += 1
      callbackTaskId = result.history_command_match_id
    })
    const skipped = await service.waitForTask('unix-nowait-suppression-cleared', taskId, {
      suppressFinishCallback: true,
      shouldSkip: () => true
    })

    assertEqual(skipped.exitCode, -3, 'manual wait should switch to async when skipped')
    backend.emitData('unix-nowait-suppression-cleared', `cleared${WINDOWS_OSC_PRECMD}\n`)
    await waitUntil(
      () => callbackCount === 1,
      'nowait completion callback should fire after skipped manual wait'
    )
    assertEqual(callbackTaskId, taskId, 'completion callback should preserve the command task id')
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
