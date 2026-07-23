import type {
  CommandTask,
  CommandResult,
  TerminalBackend,
  TerminalCommandProtocolMetadata,
  TerminalCommandShellFamily,
  TerminalCommandTrackingToken,
  TerminalCommandTrackingUpdate,
  TerminalConfig,
  TerminalSystemInfo
} from '../types'
import { COMMAND_CAPTURE_MAX_UTF8_BYTES } from '@gyshell/shared'
import { TerminalService } from './TerminalService'

const WINDOWS_OSC_PRECMD_WITH_PROMPT =
  '\x1b]1337;gyshell_precmd;ec=0;cwd_b64=QzpcVXNlcnNcQWRtaW5pc3RyYXRvcg==;home_b64=QzpcVXNlcnNcQWRtaW5pc3RyYXRvcg==\x07'
const UNIX_BOUNDARY_NONCE = 'fixture_nonce_0001'
const UNIX_OSC_PREEXEC =
  `\x1b]1337;gyshell_preexec;seq=1;nonce=${UNIX_BOUNDARY_NONCE}\x07`
const UNIX_OSC_PRECMD =
  `\x1b]1337;gyshell_precmd;seq=1;nonce=${UNIX_BOUNDARY_NONCE};ec=0;cwd_b64=L3RtcA==\x07`
const unixBoundary = (
  kind: 'preexec' | 'preend' | 'precmd',
  sequence: number,
  nonce: string,
): string =>
  `\x1b]1337;gyshell_${kind};seq=${sequence};nonce=${nonce}${
    kind === 'precmd' ? ';ec=0;cwd_b64=L3RtcA==' : ''
  }\x07`

const tokenizedUnixBoundary = (
  runtimeToken: string,
  kind: 'preexec' | 'preend' | 'precmd' | 'inputidle',
  sequence: number,
  nonce: string,
  options?: { exitCode?: number; cwd?: string; homeDir?: string }
): string => {
  const metadata = kind === 'precmd'
    ? `;ec=${options?.exitCode ?? 0}` +
      `${options?.cwd ? `;cwd_b64=${Buffer.from(options.cwd).toString('base64')}` : ''}` +
      `${options?.homeDir ? `;home_b64=${Buffer.from(options.homeDir).toString('base64')}` : ''}`
    : ''
  return `\x1b]1337;gyshell_${runtimeToken}_${kind};seq=${sequence};nonce=${nonce}${metadata}\x07`
}

const tokenizedPowerShellInputIdle = (
  runtimeToken: string,
  sequence: number,
  inputRevision: number,
): string =>
  `\x1b]1337;gyshell_${runtimeToken}_inputidle;seq=${sequence};rev=${inputRevision};nonce=manual_input_drained\x07`

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const decodePromptFileRequest = (content: string): {
  requestId?: string
  kind?: 'probe' | 'command'
  command: string
} => {
  const separator = content.indexOf(':')
  const hasRequestId =
    separator === 32 && /^[a-f0-9]{32}$/i.test(content.slice(0, separator))
  const kindCode =
    hasRequestId && content[34] === ':' && /^[pc]$/.test(content[33] || '')
      ? content[33]
      : undefined
  const payloadOffset = kindCode ? 35 : separator + 1
  return {
    ...(hasRequestId ? { requestId: content.slice(0, separator) } : {}),
    ...(kindCode
      ? { kind: kindCode === 'p' ? ('probe' as const) : ('command' as const) }
      : {}),
    command: Buffer.from(
      hasRequestId ? content.slice(payloadOffset) : content,
      'base64'
    ).toString('utf8'),
  }
}

const assertRejects = async (
  promise: Promise<unknown>,
  expectedMessage: string
): Promise<void> => {
  try {
    await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(expectedMessage)) {
      throw new Error(
        `Expected rejection containing ${JSON.stringify(expectedMessage)}, received ${JSON.stringify(message)}`
      )
    }
    return
  }
  throw new Error(
    `Expected rejection containing ${JSON.stringify(expectedMessage)}, but the operation resolved.`
  )
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

const FAKE_PROMPT_FILE_DISPATCH_INPUT =
  '. $global:__gyshell_fake_runtime_dispatch'

class FakeCommandBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()
  private readonly writesByPtyId = new Map<string, string[]>()
  private readonly writeLog: Array<{ ptyId: string; data: string }> = []
  private readonly fileWritesByPtyId = new Map<string, Array<{ path: string; content: string }>>()
  private readonly filesByPtyId = new Map<string, Map<string, string>>()
  private readonly trackingStateByPtyId = new Map<string, TerminalCommandTrackingUpdate>()
  private readonly committedInputRevisionByPtyId = new Map<string, number>()
  private readonly minimumInputPromptSequenceByPtyId = new Map<string, number>()
  private readonly lastEmittedInputRevisionByPtyId = new Map<string, number>()
  private readonly lastUserRequestIdByPtyId = new Map<string, string>()
  private prepareTrackingError?: Error
  private pollTrackingError?: Error
  private promptFileDispatch = false
  private autoEmitPromptFileRawBoundaries = true
  private promptFileRequestPath?: string
  private promptFileOutputPath?: string
  private readonly promptFileRequestPathByPtyId = new Map<string, string>()
  private readonly promptFileOutputPathByPtyId = new Map<string, string>()
  private writeFileError?: Error
  private nextWriteError?: Error
  private nextWriteErrorHook?: () => void
  private writeErrorForData?: { data: string; error: Error }
  private nextKillError?: Error
  private deferNextKillExitCallback = false
  private nextPrepareGate?: { promise: Promise<void>; onStarted: () => void }
  private nextWriteFileGate?: { promise: Promise<void>; onStarted: () => void }
  private nextWriteFileSuccessHook?: () => void
  private nextUserRequestWriteSuccessHook?: () => void
  private nextPollGate?: {
    promise: Promise<void>
    onStarted: () => void
    update: TerminalCommandTrackingUpdate | undefined
  }
  private spawnCount = 0
  private execOnSessionCallCount = 0
  private commandProtocolAvailable?: boolean
  private commandProtocolToken?: string
  private commandShellFamily?: TerminalCommandShellFamily
  private initialTrackingBaselineSequence?: number
  private exposesCommandTrackingMode = false
  private autoProcessPromptFileDispatch = true
  private consumePromptFileUserRequests = true
  private readonly cwdByPtyId = new Map<string, string>()
  private readonly homeDirByPtyId = new Map<string, string>()

  constructor(
    private readonly remoteOs: 'unix' | 'windows',
    private readonly systemInfo: TerminalSystemInfo,
    private readonly trackingMode?: TerminalCommandTrackingToken['mode']
  ) {}

  private getPtyId(terminalId: string): string {
    return `pty-${terminalId}`
  }

  private scopePromptFilePath(path: string, runtimeNumber: number): string {
    return runtimeNumber <= 1 ? path : `${path}.runtime-${runtimeNumber}`
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
    this.filesByPtyId.set(ptyId, new Map())
    this.committedInputRevisionByPtyId.set(ptyId, 0)
    this.minimumInputPromptSequenceByPtyId.set(ptyId, 0)
    this.lastEmittedInputRevisionByPtyId.set(ptyId, 0)
    if (this.promptFileRequestPath) {
      this.promptFileRequestPathByPtyId.set(
        ptyId,
        this.scopePromptFilePath(this.promptFileRequestPath, this.spawnCount)
      )
    }
    if (this.promptFileOutputPath) {
      this.promptFileOutputPathByPtyId.set(
        ptyId,
        this.scopePromptFilePath(this.promptFileOutputPath, this.spawnCount)
      )
    }
    this.cwdByPtyId.set(
      ptyId,
      this.remoteOs === 'windows' ? 'C:/Users/Administrator' : '/tmp'
    )
    this.homeDirByPtyId.set(
      ptyId,
      this.remoteOs === 'windows' ? 'C:/Users/Administrator' : '/tmp'
    )
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
    if (
      data === `${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r` &&
      this.promptFileDispatch &&
      this.autoProcessPromptFileDispatch &&
      this.promptFileRequestPathByPtyId.has(ptyId)
    ) {
      const files = this.filesByPtyId.get(ptyId)
      const requestPath = this.promptFileRequestPathByPtyId.get(ptyId)!
      const encodedRequest = files?.get(requestPath) || ''
      const decoded = decodePromptFileRequest(encodedRequest)
      const requestId = decoded.requestId || ''
      const decodedRequest = decoded.command
      const probeMatch = decodedRequest.match(
        /^'(__GYSHELL_PROMPT_FILE_PROBE_[a-f0-9]+)'$/
      )
      if (probeMatch) {
        files?.set(requestPath, '')
        const previousSequence = this.trackingStateByPtyId.get(ptyId)?.sequence || 0
        const output = `${probeMatch[1]}\r\n`
        this.trackingStateByPtyId.set(ptyId, {
          mode: 'windows-powershell-sidecar',
          sequence: previousSequence + 1,
          exitCode: 0,
          requestId,
          output,
          outputObservedUtf8Bytes: Buffer.byteLength(output, 'utf8'),
          outputRetainedUtf8Bytes: Buffer.byteLength(output, 'utf8'),
          outputTruncated: false,
          cwd: this.cwdByPtyId.get(ptyId),
          homeDir: this.homeDirByPtyId.get(ptyId),
        })
      } else if (requestId && this.consumePromptFileUserRequests) {
        files?.set(requestPath, '')
        this.lastUserRequestIdByPtyId.set(ptyId, requestId)
      }
    }
  }

  async commitPowerShellInputRevision(
    ptyId: string,
    revision: number,
    minimumPromptSequence: number
  ): Promise<void> {
    if (!this.sessions.has(ptyId)) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('Invalid fake PowerShell input revision')
    }
    if (
      !Number.isSafeInteger(minimumPromptSequence) ||
      minimumPromptSequence < 1
    ) {
      throw new Error('Invalid fake PowerShell input prompt sequence')
    }
    this.committedInputRevisionByPtyId.set(ptyId, revision)
    this.minimumInputPromptSequenceByPtyId.set(
      ptyId,
      minimumPromptSequence
    )
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

  getCwd(ptyId: string): string | undefined {
    return this.cwdByPtyId.get(ptyId)
  }

  async getHomeDir(ptyId: string): Promise<string | undefined> {
    return this.homeDirByPtyId.get(ptyId)
  }

  getCommandProtocolAvailability(_ptyId: string): boolean | undefined {
    return this.commandProtocolAvailable
  }

  getCommandProtocolToken(_ptyId: string): string | undefined {
    return this.commandProtocolToken
  }

  getCommandShellFamily(_ptyId: string): TerminalCommandShellFamily | undefined {
    return this.commandShellFamily
  }

  getCommandTrackingMode(): TerminalCommandTrackingToken['mode'] | undefined {
    return this.exposesCommandTrackingMode ? this.trackingMode : undefined
  }

  getInitialCommandTrackingToken(): TerminalCommandTrackingToken | undefined {
    if (!this.trackingMode || this.initialTrackingBaselineSequence === undefined) {
      return undefined
    }
    return {
      mode: this.trackingMode,
      trackingScopeId: this.commandProtocolToken,
      baselineSequence: this.initialTrackingBaselineSequence,
    }
  }

  applyCommandProtocolMetadata(
    ptyId: string,
    metadata: TerminalCommandProtocolMetadata
  ): void {
    if (metadata.cwd !== undefined) this.cwdByPtyId.set(ptyId, metadata.cwd)
    if (metadata.homeDir !== undefined) this.homeDirByPtyId.set(ptyId, metadata.homeDir)
  }

  setCommandProtocol(available: boolean | undefined, runtimeToken?: string): void {
    this.commandProtocolAvailable = available
    this.commandProtocolToken = runtimeToken
  }

  setCommandShellFamily(family: TerminalCommandShellFamily | undefined): void {
    this.commandShellFamily = family
  }

  setExposeCommandTrackingMode(expose: boolean): void {
    this.exposesCommandTrackingMode = expose
  }

  setInitialTrackingBaseline(sequence: number | undefined): void {
    this.initialTrackingBaselineSequence = sequence
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return this.remoteOs
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    return this.systemInfo
  }

  async prepareCommandTracking(ptyId: string): Promise<TerminalCommandTrackingToken | undefined> {
    const prepareGate = this.nextPrepareGate
    if (prepareGate) {
      this.nextPrepareGate = undefined
      prepareGate.onStarted()
      await prepareGate.promise
    }
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
      dispatchInput: this.promptFileDispatch
        ? FAKE_PROMPT_FILE_DISPATCH_INPUT
        : undefined,
      displayMode: this.promptFileDispatch ? 'synthetic-transcript' : undefined,
      commandRequestPath: this.promptFileDispatch
        ? this.promptFileRequestPathByPtyId.get(ptyId)
        : undefined,
      commandOutputPath: this.promptFileDispatch
        ? this.promptFileOutputPathByPtyId.get(ptyId)
        : undefined,
    }
  }

  async pollCommandTracking(
    ptyId: string,
    token: TerminalCommandTrackingToken
  ): Promise<TerminalCommandTrackingUpdate | undefined> {
    const pollGate = this.nextPollGate
    if (pollGate) {
      this.nextPollGate = undefined
      pollGate.onStarted()
      await pollGate.promise
      return pollGate.update
    }
    if (this.pollTrackingError) {
      throw this.pollTrackingError
    }
    const update = this.trackingStateByPtyId.get(ptyId)
    if (!update || update.mode !== token.mode || update.sequence <= token.baselineSequence) {
      return undefined
    }
    return update
  }

  async execOnSession(): Promise<{ stdout: string; stderr: string }> {
    this.execOnSessionCallCount += 1
    return { stdout: 'UNEXPECTED_REPLAY_OUTPUT', stderr: '' }
  }

  getExecOnSessionCallCount(): number {
    return this.execOnSessionCallCount
  }

  emitData(terminalId: string, data: string): void {
    const session = this.sessions.get(this.getPtyId(terminalId))
    if (!session) {
      throw new Error(`Missing fake session for ${terminalId}`)
    }
    session.dataCallbacks.forEach((callback) => callback(data))
  }

  captureDataCallbacks(terminalId: string): Array<(data: string) => void> {
    const session = this.sessions.get(this.getPtyId(terminalId))
    if (!session) {
      throw new Error(`Missing fake session for ${terminalId}`)
    }
    return [...session.dataCallbacks]
  }

  emitPowerShellPrompt(
    terminalId: string,
    sequence: number,
    options?: { idle?: boolean; exitCode?: number }
  ): void {
    if (!this.commandProtocolToken) {
      throw new Error(`Missing command protocol token for ${terminalId}`)
    }
    setTimeout(() => {
      this.emitData(
        terminalId,
        tokenizedUnixBoundary(
          this.commandProtocolToken!,
          'precmd',
          sequence,
          `prompt_${sequence}`,
          { exitCode: options?.exitCode ?? 0 }
        )
      )
      if (
        options?.idle !== false &&
        sequence >=
          (this.minimumInputPromptSequenceByPtyId.get(
            this.getPtyId(terminalId)
          ) || 0) &&
        (this.committedInputRevisionByPtyId.get(
          this.getPtyId(terminalId)
        ) || 0) >
          (this.lastEmittedInputRevisionByPtyId.get(
            this.getPtyId(terminalId)
          ) || 0)
      ) {
        const inputRevision =
          this.committedInputRevisionByPtyId.get(
            this.getPtyId(terminalId)
          ) || 0
        this.lastEmittedInputRevisionByPtyId.set(
          this.getPtyId(terminalId),
          inputRevision
        )
        this.emitData(
          terminalId,
          tokenizedPowerShellInputIdle(
            this.commandProtocolToken!,
            sequence,
            inputRevision
          )
        )
      }
    }, 0)
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
    const ptyId = this.getPtyId(terminalId)
    const requestPath = this.promptFileRequestPathByPtyId.get(ptyId)
    const request = requestPath
      ? this.filesByPtyId.get(ptyId)?.get(requestPath) || ''
      : ''
    const requestId = request.indexOf(':') === 32
      ? request.slice(0, 32)
      : this.lastUserRequestIdByPtyId.get(ptyId)
    if (
      this.promptFileDispatch &&
      this.autoEmitPromptFileRawBoundaries &&
      requestId &&
      Number.isSafeInteger(update.sequence)
    ) {
      this.emitPromptFileRawBoundary(
        terminalId,
        'preexec',
        update.sequence,
        requestId
      )
      this.emitPromptFileRawBoundary(
        terminalId,
        'preend',
        update.sequence,
        requestId
      )
    }
    this.trackingStateByPtyId.set(ptyId, {
      ...update,
      ...(update.requestId === undefined && requestId ? { requestId } : {}),
      ...(update.output !== undefined &&
      update.outputRetainedUtf8Bytes === undefined
        ? { outputRetainedUtf8Bytes: Buffer.byteLength(update.output, 'utf8') }
        : {}),
    })
  }

  setAutoEmitPromptFileRawBoundaries(enabled: boolean): void {
    this.autoEmitPromptFileRawBoundaries = enabled
  }

  emitPromptFileRawBoundary(
    terminalId: string,
    kind: 'preexec' | 'preend',
    sequence: number,
    requestId?: string
  ): void {
    const ptyId = this.getPtyId(terminalId)
    const resolvedRequestId =
      requestId || this.lastUserRequestIdByPtyId.get(ptyId)
    if (!resolvedRequestId) {
      throw new Error(`Missing prompt-file request id for ${terminalId}`)
    }
    const marker = this.commandProtocolToken
      ? tokenizedUnixBoundary(
          this.commandProtocolToken,
          kind,
          sequence,
          resolvedRequestId
        )
      : unixBoundary(kind, sequence, resolvedRequestId)
    this.emitData(terminalId, marker)
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
    if (requestPath) {
      for (const ptyId of this.sessions.keys()) {
        this.promptFileRequestPathByPtyId.set(
          ptyId,
          this.scopePromptFilePath(requestPath, Math.max(1, this.spawnCount))
        )
      }
    }
    if (outputPath) {
      for (const ptyId of this.sessions.keys()) {
        this.promptFileOutputPathByPtyId.set(
          ptyId,
          this.scopePromptFilePath(outputPath, Math.max(1, this.spawnCount))
        )
      }
    }
  }

  getPromptFileRequestPath(terminalId: string): string | undefined {
    return this.promptFileRequestPathByPtyId.get(this.getPtyId(terminalId))
  }

  setAutoProcessPromptFileDispatch(enabled: boolean): void {
    this.autoProcessPromptFileDispatch = enabled
  }

  setConsumePromptFileUserRequests(enabled: boolean): void {
    this.consumePromptFileUserRequests = enabled
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

  delayNextPrepare(promise: Promise<void>, onStarted: () => void): void {
    this.nextPrepareGate = { promise, onStarted }
  }

  delayNextPoll(
    promise: Promise<void>,
    onStarted: () => void,
    update: TerminalCommandTrackingUpdate | undefined
  ): void {
    this.nextPollGate = { promise, onStarted, update }
  }

  onNextWriteFileSuccess(callback: () => void): void {
    this.nextWriteFileSuccessHook = callback
  }

  onNextPromptFileUserRequestSuccess(callback: () => void): void {
    this.nextUserRequestWriteSuccessHook = callback
  }

  async readFile(ptyId: string, filePath: string): Promise<Buffer> {
    return Buffer.from(this.filesByPtyId.get(ptyId)?.get(filePath) || '', 'utf8')
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
    this.filesByPtyId.get(ptyId)?.set(filePath, content)
    const successHook = this.nextWriteFileSuccessHook
    this.nextWriteFileSuccessHook = undefined
    successHook?.()
    if (content) {
      const decoded = decodePromptFileRequest(content).command
      if (!decoded.includes('__GYSHELL_PROMPT_FILE_PROBE_')) {
        const userRequestHook = this.nextUserRequestWriteSuccessHook
        this.nextUserRequestWriteSuccessHook = undefined
        userRequestHook?.()
      }
    }
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

const createWindowsPromptFileFixture = async (
  terminalId: string
): Promise<{
  backend: FakeCommandBackend
  service: TerminalService
  runtimeToken: string
}> => {
  const runtimeToken = 'abcdef0123456789abcdef0123456789'
  const backend = new FakeCommandBackend('windows', {
    os: 'Windows',
    platform: 'win32',
    release: '10.0.26200',
    arch: 'x64',
    hostname: 'win-sidecar-fixture',
    isRemote: false,
    shell: 'powershell.exe'
  }, 'windows-powershell-sidecar')
  backend.setCommandProtocol(undefined, runtimeToken)
  backend.setPromptFileDispatch(
    `C:/Windows/Temp/GyShell/${terminalId}-request.b64`,
    `C:/Windows/Temp/GyShell/${terminalId}-output.txt`
  )
  backend.setAutoEmitPromptFileRawBoundaries(false)
  const service = createService(backend) as any
  service.commandTrackingPollIntervalMs = 5
  service.syntheticCommandQuietWindowMs = 5
  await createLocalTerminal(service, terminalId)
  return { backend, service, runtimeToken }
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

const createReadyWindowsManualFixture = async (
  terminalId: string
): Promise<{
  backend: FakeCommandBackend
  service: any
  runtimeToken: string
}> => {
  const runtimeToken = '56565656565656565656565656565656'
  const backend = new FakeCommandBackend('windows', {
    os: 'Windows',
    platform: 'win32',
    release: '10.0.22631',
    arch: 'x64',
    hostname: terminalId,
    isRemote: false,
    shell: 'powershell.exe'
  }, 'windows-powershell-sidecar')
  backend.setCommandProtocol(true, runtimeToken)
  backend.setExposeCommandTrackingMode(true)
  backend.setInitialTrackingBaseline(1)
  backend.setTrackingState(terminalId, {
    mode: 'windows-powershell-sidecar',
    sequence: 1,
    exitCode: 0,
  })
  const service = createService(backend) as TerminalService & any
  service.commandTrackingPollIntervalMs = 5
  await createLocalTerminal(service, terminalId)
  backend.emitData(terminalId, 'PS sidecar ready')
  await waitUntil(
    () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
    `the ${terminalId} fixture needs a verified initial prompt`
  )
  return { backend, service, runtimeToken }
}

const createReadyWindowsPromptFileManualFixture = async (
  terminalId: string
): Promise<{
  backend: FakeCommandBackend
  service: any
  runtimeToken: string
}> => {
  const fixture = await createReadyWindowsManualFixture(terminalId)
  fixture.backend.setPromptFileDispatch(
    `C:/Windows/Temp/GyShell/${terminalId}-request.b64`,
    `C:/Windows/Temp/GyShell/${terminalId}-output.txt`
  )
  fixture.service.syntheticCommandQuietWindowMs = 5
  return fixture
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

  await runCase('input state changes only after bytes are delivered to the accepted runtime', async () => {
    const runtimeToken = '22222222222222222222222222222222'
    const backend = createUnixBackend()
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'input-state-after-write'
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_input_state_nonce'),
    )
    const baselineWrites = backend.getWrites(terminalId).length

    const controller = new AbortController()
    controller.abort()
    const aborted = await Promise.allSettled([
      service.writeInputSequence(terminalId, ['never-written', '\r'], {
        signal: controller.signal,
      }),
    ])
    assertEqual(aborted[0]?.status, 'rejected', 'pre-aborted input must reject')
    assertEqual(
      backend.getWrites(terminalId).length,
      baselineWrites,
      'pre-aborted input must deliver no bytes',
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'undelivered input must not poison the shell command gate',
    )

    backend.setNextWriteError(new Error('input write failed'))
    let writeFailed = false
    try {
      service.write(terminalId, '\r')
    } catch {
      writeFailed = true
    }
    assertEqual(writeFailed, true, 'a synchronous backend write failure must surface')
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'a failed write must leave the previously idle gate unchanged',
    )
    service.kill(terminalId)
  })

  await runCase('unsubmitted prompt text blocks agent dispatch until a verified prompt returns', async () => {
    const runtimeToken = '11111111111111111111111111111111'
    const backend = createUnixBackend()
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'dirty-prompt-input'
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_prompt_nonce'),
    )
    const baselineWrites = backend.getWrites(terminalId).length

    service.write(terminalId, "printf 'USER'")
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'any delivered prompt input can concatenate with a later agent command',
    )
    const rejected = await Promise.allSettled([
      service.runCommandNoWait(terminalId, "printf 'AGENT'"),
    ])
    assertEqual(rejected[0]?.status, 'rejected', 'agent dispatch must fail closed on a dirty prompt')
    assertEqual(
      backend.getWrites(terminalId).length,
      baselineWrites + 1,
      'rejection must not append agent bytes to the user input buffer',
    )

    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'cancelled_prompt_nonce'),
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'a verified replacement prompt should clear the dirty-input gate',
    )
    service.kill(terminalId)
  })

  await runCase('modern Windows ignores initial or duplicate prompt markers after input is dirty', async () => {
    const runtimeToken = '33333333333333333333333333333333'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'modern-windows-manual-gate',
      isRemote: false,
      shell: 'powershell.exe'
    })
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'modern-windows-manual-gate'
    await createLocalTerminal(service, terminalId)

    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'a reliable Windows protocol must prove its first prompt before agent dispatch',
    )
    service.write(terminalId, "Write-Output 'USER'")
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_windows_nonce'),
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the first prompt marker may predate buffered input and must not clear busy',
    )
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'duplicate_windows_nonce'),
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'a same-sequence duplicate must not reopen a dirty prompt',
    )
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 1, 'advanced_windows_nonce'),
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'only an advancing verified Windows prompt may restore idle',
    )

    service.write(terminalId, "Write-Output 'SECOND'")
    const baselineWrites = backend.getWrites(terminalId).length
    const rejected = await Promise.allSettled([
      service.runCommandNoWait(terminalId, "Write-Output 'AGENT'"),
    ])
    assertEqual(rejected[0]?.status, 'rejected', 'dirty modern Windows input must fail closed')
    assertEqual(
      backend.getWrites(terminalId).length,
      baselineWrites,
      'the rejected agent command must not concatenate with manual PowerShell input',
    )
    service.kill(terminalId)
  })

  await runCase('Windows in-band fallback accepts its natural first prompt', async () => {
    const runtimeToken = '34343434343434343434343434343434'
    const terminalId = 'windows-in-band-first-prompt'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: terminalId,
      isRemote: true,
      shell: 'powershell.exe'
    })
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    await createLocalTerminal(service, terminalId)

    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 1, 'first_in_band_prompt')
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'the first reliable in-band prompt should establish idle without a sidecar baseline'
    )
    service.kill(terminalId)
  })

  await runCase('Windows sidecar manual input returns idle only after its next prompt sequence', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'sidecar-manual-gate',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setCommandProtocol(true, '61616161616161616161616161616161')
    backend.setExposeCommandTrackingMode(true)
    backend.setInitialTrackingBaseline(1)
    backend.setTrackingState('sidecar-manual-gate', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
    })
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    const terminalId = 'sidecar-manual-gate'
    await createLocalTerminal(service, terminalId)
    backend.emitData(terminalId, 'PS sidecar ready')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'idle',
      'the sidecar initial marker should establish an idle baseline',
    )

    service.write(terminalId, "Write-Output 'USER'")
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'unsubmitted sidecar input must dirty the prompt immediately',
    )
    service.write(terminalId, '\r')
    await waitUntil(
      () => backend.getWrites(terminalId).includes('\r'),
      'the tracked Enter should be delivered immediately from the cached baseline',
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'delivering Enter is not evidence that the manual command finished',
    )

    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the next verified sidecar prompt should restore agent command availability',
    )
    service.kill(terminalId)
  })

  await runCase('Windows manual Enter uses its bootstrap baseline without prompt-journal I/O', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.22631',
      arch: 'x64',
      hostname: 'sidecar-pending-baseline',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setCommandProtocol(true, '62626262626262626262626262626262')
    backend.setExposeCommandTrackingMode(true)
    backend.setInitialTrackingBaseline(1)
    backend.setTrackingState('sidecar-pending-baseline', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
    })
    const prepareRelease = createDeferred()
    let prepareStarted = false
    backend.delayNextPrepare(prepareRelease.promise, () => {
      prepareStarted = true
    })
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    const terminalId = 'sidecar-pending-baseline'
    await createLocalTerminal(service, terminalId)
    backend.emitData(terminalId, 'PS sidecar ready')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'idle',
      'the private bootstrap baseline should establish idle synchronously'
    )

    const writing = service.writeInputSequence(terminalId, ['\r'])
    await waitUntil(
      () => backend.getWrites(terminalId).includes('\r'),
      'human Enter was blocked by out-of-band prompt-baseline I/O',
      250
    )
    await writing
    assertEqual(
      prepareStarted,
      false,
      'manual input must not start destructive prompt-journal preparation'
    )

    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the prompt after immediate manual input should restore the verified idle state'
    )
    prepareRelease.resolve()
    service.kill(terminalId)
  })

  await runCase('a long Windows manual command stays busy until its prompt becomes input-idle', async () => {
    const terminalId = 'sidecar-long-manual-command'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.22631',
      arch: 'x64',
      hostname: terminalId,
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setCommandProtocol(true, '63636363636363636363636363636363')
    backend.setExposeCommandTrackingMode(true)
    backend.setInitialTrackingBaseline(1)
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
    })
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.commandTrackingMaxConsecutiveErrors = 2
    await createLocalTerminal(service, terminalId)
    backend.emitData(terminalId, 'PS sidecar ready')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the long-command fixture needs a verified initial prompt'
    )

    await service.writeInputSequence(terminalId, [
      'Start-Sleep -Seconds 5',
      '\r',
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState,
      'busy',
      'normal empty polls must not exhaust the manual watcher error budget'
    )
    assertEqual(
      service.windowsManualPromptWatcherByTerminal.has(terminalId),
      true,
      'the manual watcher must survive while no newer prompt exists'
    )

    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the long manual command should recover when its prompt finally arrives'
    )
    service.kill(terminalId)
  })

  await runCase('PowerShell continuation lines share one pending prompt', async () => {
    const terminalId = 'sidecar-manual-continuation'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, ['if ($true) {', '\r'])
    backend.emitData(terminalId, '\r\n>> ')
    await service.writeInputSequence(terminalId, ["Write-Output 'OK'", '\r'])
    backend.emitData(terminalId, '\r\n>> ')
    await service.writeInputSequence(terminalId, ['}', '\r'])

    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'continuation Enter keys must not reserve nonexistent top-level prompts'
    )
    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the one natural prompt after a multiline block should restore idle'
    )
    service.kill(terminalId)
  })

  await runCase('one multiline Windows input sequence reuses its continuation prompt', async () => {
    const terminalId = 'sidecar-one-sequence-continuation'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)
    const enterCount = (): number =>
      backend.getWrites(terminalId).filter((write) => write === '\r').length

    const writing = service.writeInputSequence(
      terminalId,
      ['if ($true) {', '\r', "Write-Output 'OK'", '\r', '}', '\r'],
      { intervalMs: 30 }
    )
    await waitUntil(
      () => enterCount() >= 1,
      'the first multiline Enter should be delivered'
    )
    backend.emitData(terminalId, '\r\n>> ')
    await waitUntil(
      () => enterCount() >= 2,
      'the second multiline Enter should be delivered'
    )
    backend.emitData(terminalId, '\r\n>> ')
    await writing

    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'continuation lines in one input sequence must share one top-level prompt'
    )
    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the multiline input sequence should recover at its one natural prompt'
    )
    service.kill(terminalId)
  })

  await runCase('aborting later Windows input preserves the last verified idle prompt', async () => {
    const terminalId = 'sidecar-aborted-later-input'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)
    const controller = new AbortController()
    const writing = service.writeInputSequence(
      terminalId,
      ["Write-Output 'FIRST'\r", "Write-Output 'NEVER'\r"],
      { intervalMs: 10_000, signal: controller.signal }
    )
    await waitUntil(
      () => backend.getWrites(terminalId).includes("Write-Output 'FIRST'\r"),
      'the first submitted item should reach the shell before cancellation'
    )
    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () =>
        service.windowsManualPromptWatcherByTerminal.get(terminalId)
          ?.inputIdleSequence === 2,
      'the first item should retain its verified idle while the sequence owns its reservation'
    )
    controller.abort()
    const outcome = await Promise.allSettled([writing])
    assertEqual(outcome[0]?.status, 'rejected', 'the remaining input should abort')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'cancelling unsent later input must not discard the shell idle already proved by the first item'
    )
    assertEqual(
      backend.getWrites(terminalId).includes("Write-Output 'NEVER'\r"),
      false,
      'the cancelled later item must never reach the shell'
    )
    service.kill(terminalId)
  })

  await runCase('transient PowerShell revision commit failure retries without stranding the gate', async () => {
    const terminalId = 'sidecar-input-revision-retry'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)
    ;(service as any).commandTrackingPollIntervalMs = 5
    const commit = backend.commitPowerShellInputRevision.bind(backend)
    let attempts = 0
    backend.commitPowerShellInputRevision = async (
      ptyId: string,
      revision: number,
      minimumPromptSequence: number
    ): Promise<void> => {
      attempts += 1
      if (attempts < 3) {
        throw new Error('transient sidecar failure')
      }
      await commit(ptyId, revision, minimumPromptSequence)
    }

    await service.writeInputSequence(terminalId, ["Write-Output 'RETRY'\r"])
    await waitUntil(
      () => attempts === 3,
      'the sidecar commit should retry a bounded transient failure'
    )
    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'a successful retry should let the exact prompt restore the gate'
    )
    service.kill(terminalId)
  })

  await runCase('persistent PowerShell revision loss becomes unknown and remains recoverable', async () => {
    const terminalId = 'sidecar-input-revision-loss'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)
    ;(service as any).commandTrackingPollIntervalMs = 5
    const commit = backend.commitPowerShellInputRevision.bind(backend)
    backend.commitPowerShellInputRevision = async (): Promise<void> => {
      throw new Error('persistent sidecar failure')
    }

    await service.writeInputSequence(terminalId, ["Write-Output 'UNKNOWN'\r"])
    await waitUntil(
      () =>
        service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState ===
        'unknown',
      'an exhausted sidecar commit should become explicit tracking loss'
    )
    backend.emitPowerShellPrompt(terminalId, 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'a prompt without the missing revision acknowledgement must fail closed'
    )

    backend.commitPowerShellInputRevision = commit
    await service.writeInputSequence(terminalId, ['\r'])
    backend.emitPowerShellPrompt(terminalId, 3)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'a later verified human submission should recover the same runtime'
    )
    service.kill(terminalId)
  })

  await runCase('multiline Enter keys reserve one prompt without parsing visible continuation text', async () => {
    const terminalId = 'sidecar-delayed-continuation'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, [
      "if ($true) {\rWrite-Output 'OK'\r}\r",
    ])
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'one foreground interaction should initially reserve one natural prompt'
    )
    backend.emitData(terminalId, '\r\n>> \r\n>> ')
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'visible continuation text must not mutate authenticated prompt state'
    )

    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the delayed multiline fixture should recover at its actual prompt'
    )
    service.kill(terminalId)
  })

  await runCase('ordinary output cannot spoof authenticated PowerShell submissions', async () => {
    const terminalId = 'sidecar-continuation-output-spoof'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, [
      'Write-Output ">> "\rStart-Sleep -Seconds 30\r',
    ])
    backend.emitData(terminalId, '\r\n>> ')
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'one unsettled foreground interaction should reserve one later prompt'
    )
    backend.emitPowerShellPrompt(terminalId, 2, { idle: false })
    await new Promise((resolve) => setTimeout(resolve, 350))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'a prompt without authenticated empty-input idle must not release queued input'
    )
    backend.emitPowerShellPrompt(terminalId, 3)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the queued command should recover only at its own authenticated prompt'
    )
    service.kill(terminalId)
  })

  await runCase('Ctrl-C completes the pending PowerShell prompt instead of reserving another', async () => {
    const terminalId = 'sidecar-manual-interrupt'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, ['Start-Sleep -Seconds 30', '\r'])
    await service.writeInputSequence(terminalId, ['\x03'])
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'interrupting a pending command should keep its existing prompt target'
    )
    backend.emitPowerShellPrompt(terminalId, 2, { exitCode: 1 })
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the interrupted command prompt should restore idle without an extra Enter'
    )
    service.kill(terminalId)
  })

  await runCase('foreground PowerShell stdin does not reserve nonexistent shell prompts', async () => {
    const terminalId = 'sidecar-foreground-stdin'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, ['Read-Host', '\r'])
    await service.writeInputSequence(terminalId, ['interactive answer', '\r'])
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'stdin Enter must keep waiting for the foreground command final prompt'
    )

    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'Read-Host should recover when its one top-level prompt returns'
    )
    service.kill(terminalId)
  })

  await runCase('a prompt before trailing typed text cannot complete the later submission', async () => {
    const terminalId = 'sidecar-manual-trailing-text'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, [
      "Write-Output 'FIRST'",
      '\r',
      'Start-Sleep -Seconds 5',
    ])
    backend.emitPowerShellPrompt(terminalId, 2, { idle: false })
    await waitUntil(
      () => service.windowsPromptBaselineByTerminal.get(terminalId)?.baselineSequence === 2,
      'the observer should retain the prompt that preceded trailing text'
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'a prompt preceding already typed text must not restore idle'
    )

    await service.writeInputSequence(terminalId, ['\r'])
    await new Promise((resolve) => setTimeout(resolve, 30))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the older prompt must not complete the command submitted by the final Enter'
    )
    backend.emitPowerShellPrompt(terminalId, 3)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the trailing command should recover only at its own prompt'
    )
    service.kill(terminalId)
  })

  await runCase('rapid Windows manual submissions wait for their own prompt sequence', async () => {
    const terminalId = 'sidecar-consecutive-manual-input'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await Promise.all([
      service.writeInputSequence(terminalId, ["Write-Output 'FIRST'", '\r']),
      service.writeInputSequence(terminalId, ["Write-Output 'SECOND'", '\r']),
    ])
    backend.emitPowerShellPrompt(terminalId, 2, { idle: false })
    await new Promise((resolve) => setTimeout(resolve, 350))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the first command prompt must not complete the second queued command'
    )

    backend.emitPowerShellPrompt(terminalId, 3)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the second command should become idle only at its own prompt sequence'
    )
    service.kill(terminalId)
  })

  await runCase('one Windows input sequence reserves every submitted command prompt', async () => {
    const terminalId = 'sidecar-multi-command-input-sequence'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, [
      "Write-Output 'FIRST'\rStart-Sleep -Seconds 30\r",
    ])
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'one unsettled input sequence should reserve one later prompt'
    )

    backend.emitPowerShellPrompt(terminalId, 2, { idle: false })
    await new Promise((resolve) => setTimeout(resolve, 350))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the first prompt in one input sequence must not complete its second command'
    )

    backend.emitPowerShellPrompt(terminalId, 3)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the final prompt in one input sequence should restore idle'
    )
    service.kill(terminalId)
  })

  await runCase('PowerShell bracketed paste newlines do not reserve prompts', async () => {
    const terminalId = 'sidecar-bracketed-paste'
    const { backend, service } = await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, [
      "\x1b[200~Write-Output 'FIRST'\r\nWrite-Output 'SECOND'\x1b[201~",
    ])
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      1,
      'newlines inserted inside bracketed paste must not look like submitted commands'
    )

    await service.writeInputSequence(terminalId, ['\r'])
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'the Enter after bracketed paste should reserve exactly one natural prompt'
    )
    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the pasted command block should recover at its one natural prompt'
    )
    service.kill(terminalId)
  })

  await runCase('a completed sidecar task leaves a generic baseline for later manual input', async () => {
    const terminalId = 'sidecar-task-then-manual'
    const { backend, service } =
      await createReadyWindowsPromptFileManualFixture(terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      "Write-Output 'AGENT_OK'"
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      output: 'AGENT_OK\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('AGENT_OK\r\n', 'utf8'),
      outputTruncated: false,
    })
    await service.waitForTask(terminalId, taskId)

    const cachedBaseline = service.windowsPromptBaselineByTerminal.get(terminalId)
    assertEqual(
      cachedBaseline?.baselineSequence,
      2,
      'the completed task should advance the shared prompt baseline'
    )
    assertEqual(
      cachedBaseline?.expectedRequestId,
      undefined,
      'a completed request identity must not leak into later manual polling'
    )
    assertEqual(
      cachedBaseline?.expectCommandOutput,
      undefined,
      'manual polling must not inherit request-bound output requirements'
    )

    await service.writeInputSequence(terminalId, [
      "Write-Output 'MANUAL_OK'",
      '\r',
    ])
    backend.setAutoEmitPromptFileRawBoundaries(false)
    backend.emitPowerShellPrompt(terminalId, 3)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'manual input after a completed agent task should observe its own generic prompt'
    )
    service.kill(terminalId)
  })

  await runCase('an empty prompt journal cannot roll a live Windows baseline back to zero', async () => {
    const terminalId = 'sidecar-empty-journal-baseline'
    const { backend, service, runtimeToken } =
      await createReadyWindowsPromptFileManualFixture(terminalId)

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 7,
      exitCode: 0,
    })
    backend.emitPowerShellPrompt(terminalId, 7)
    await waitUntil(
      () =>
        service.windowsPromptBaselineByTerminal.get(terminalId)
          ?.baselineSequence === 7,
      'the fixture should authenticate the pre-reset prompt baseline'
    )

    const prepare = backend.prepareCommandTracking.bind(backend)
    ;(backend as any).prepareCommandTracking = async (ptyId: string) => {
      const token = await prepare(ptyId)
      return token
        ? {
            ...token,
            trackingScopeId: runtimeToken,
            baselineSequence: 0,
          }
        : undefined
    }

    const taskId = await service.runCommandNoWait(
      terminalId,
      "Write-Output 'AFTER_EMPTY_JOURNAL'"
    )
    const activeTask = service
      .getCommandTasks(terminalId)
      .find((task: CommandTask) => task.id === taskId)
    assertEqual(
      activeTask?.completionTracking?.baselineSequence,
      7,
      'preparation must reconcile an empty journal with the authenticated runtime baseline'
    )

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 8,
      exitCode: 0,
      output: 'AFTER_EMPTY_JOURNAL\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength(
        'AFTER_EMPTY_JOURNAL\r\n',
        'utf8'
      ),
      outputTruncated: false,
    })
    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(result.stdoutDelta.trim(), 'AFTER_EMPTY_JOURNAL', 'the next monotonic prompt must retain its request output')
    assertEqual(result.capture?.state, 'complete', 'the reconciled raw boundary must remain authoritative')
    service.kill(terminalId)
  })

  await runCase('a completed agent prompt cannot reopen the gate over newer manual input', async () => {
    const terminalId = 'sidecar-agent-poll-manual-race'
    const { backend, service, runtimeToken } =
      await createReadyWindowsPromptFileManualFixture(terminalId)
    service.commandTrackingMaxConsecutiveErrors = 1000
    backend.onNextPromptFileUserRequestSuccess(() => {
      backend.setPollTrackingError(new Error('hold task completion poll'))
    })

    const taskId = await service.runCommandNoWait(
      terminalId,
      "Write-Output 'AGENT_DONE'"
    )
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 3, '')
    )
    await service.writeInputSequence(terminalId, [
      'Start-Sleep -Seconds 30',
      '\r',
    ])
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 3,
      exitCode: 0,
      output: 'AGENT_DONE\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('AGENT_DONE\r\n', 'utf8'),
      outputTruncated: false,
    })
    backend.setPollTrackingError(undefined)
    await service.waitForTask(terminalId, taskId)
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the older task poll must not mark the newer manual command idle'
    )

    backend.emitPowerShellPrompt(terminalId, 4)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the newer manual command should recover only at its own prompt'
    )
    service.kill(terminalId)
  })

  await runCase('active sidecar Read-Host stdin settles with its task prompt', async () => {
    const terminalId = 'sidecar-agent-readhost-stdin'
    const { backend, service } =
      await createReadyWindowsPromptFileManualFixture(terminalId)
    const taskId = await service.runCommandNoWait(
      terminalId,
      "$answer=Read-Host 'NAME'; Write-Output $answer"
    )

    await service.writeInputSequence(terminalId, ['Ada', '\r'], {
      inputOwner: 'active-task',
    })
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      2,
      'foreground stdin should reuse the active task already-reserved prompt'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      output: 'Ada\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('Ada\r\n'),
      outputTruncated: false,
    })
    backend.emitPowerShellPrompt(terminalId, 2)
    await service.waitForTask(terminalId, taskId)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the exact task completion prompt should acknowledge foreground stdin'
    )
    service.kill(terminalId)
  })

  await runCase('sidecar task completion cannot clear unsubmitted human input', async () => {
    const terminalId = 'sidecar-task-unsubmitted-input'
    const { backend, service } =
      await createReadyWindowsPromptFileManualFixture(terminalId)
    const taskId = await service.runCommandNoWait(
      terminalId,
      "Write-Output 'AGENT_DONE'"
    )

    service.write(terminalId, 'Write-Output TYPEAHEAD')
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 3,
      exitCode: 0,
      output: 'AGENT_DONE\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('AGENT_DONE\r\n'),
      outputTruncated: false,
    })
    backend.emitPowerShellPrompt(terminalId, 3)
    await service.waitForTask(terminalId, taskId)
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the task prompt must not make an unsubmitted PSReadLine buffer agent-safe'
    )
    service.kill(terminalId)
  })

  await runCase('an unconsumed agent request quarantines the ambiguous runtime', async () => {
    const terminalId = 'sidecar-ambiguous-agent-then-manual'
    const { backend, service } =
      await createReadyWindowsPromptFileManualFixture(terminalId)
    backend.setConsumePromptFileUserRequests(false)
    backend.setAutoEmitPromptFileRawBoundaries(false)
    service.promptFileRequestTimeoutMs = 25

    const taskId = await service.runCommandNoWait(
      terminalId,
      "Write-Output 'UNACKNOWLEDGED_AGENT'"
    )
    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(
      result.executionState,
      'outcome_unknown',
      'the fixture must leave an ambiguously dispatched agent command'
    )
    const terminal = service
      .getDisplayTerminals()
      .find((item: { id: string }) => item.id === terminalId)
    assertEqual(
      terminal?.runtimeState,
      'exited',
      'an unconsumed request has ambiguous ordering and must quarantine its runtime'
    )
    assertEqual(
      service.windowsPromptSequenceFloorByTerminal.get(terminalId),
      undefined,
      'quarantine must discard prompt reservations from the ambiguous runtime'
    )

    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the quarantined runtime must not expose an agent-ready command gate'
    )
    service.kill(terminalId)
  })

  await runCase('local Unix pwsh sidecar owns command lifecycle without changing host paths', async () => {
    const terminalId = 'local-unix-pwsh-sidecar'
    const runtimeToken = '44444444444444444444444444444444'
    const backend = new FakeCommandBackend('unix', {
      os: 'darwin',
      platform: 'darwin',
      release: '25.0.0',
      arch: 'arm64',
      hostname: 'local-pwsh',
      isRemote: false,
      shell: '/opt/homebrew/bin/pwsh'
    }, 'windows-powershell-sidecar')
    backend.setCommandProtocol(true, runtimeToken)
    backend.setCommandShellFamily('powershell')
    backend.setExposeCommandTrackingMode(true)
    backend.setInitialTrackingBaseline(1)
    backend.setPromptFileDispatch(
      `/tmp/${terminalId}-request.b64`,
      `/tmp/${terminalId}-output.txt`
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: '/tmp',
      homeDir: '/Users/tester',
    })
    const service = createService(backend)
    ;(service as any).commandTrackingPollIntervalMs = 5
    ;(service as any).syntheticCommandQuietWindowMs = 5
    await createLocalTerminal(service, terminalId)

    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'initializing',
      'a local Unix sidecar should stay initializing until its private ready marker is consumed',
    )
    backend.emitData(terminalId, 'PS /tmp> ')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the Unix-hosted PowerShell sidecar should verify its first prompt',
    )
    assertEqual(
      service.getDisplayTerminals().find((item) => item.id === terminalId)
        ?.remoteOs,
      'unix',
      'sidecar selection must not change filesystem/path platform truth',
    )

    const command = "Write-Output 'POSIX_PWSH_OK'"
    const taskId = await service.runCommandNoWait(terminalId, command)
    assertEqual(
      decodePromptFileRequest(
        backend.getLastFileWrite(terminalId)?.content || ''
      ).command,
      command,
      'the sidecar request must preserve PowerShell source instead of applying a Unix shell dispatcher',
    )
    assertCondition(
      backend.getWrites(terminalId).includes(
        `${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r`
      ),
      'PowerShell prompt-file dispatch should submit with its shell Enter sequence on every host',
    )

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      output: 'POSIX_PWSH_OK\n',
      outputObservedUtf8Bytes: 14,
      outputRetainedUtf8Bytes: 14,
      outputTruncated: false,
      cwd: '/tmp',
      homeDir: '/Users/tester',
    })
    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(result.stdoutDelta, 'POSIX_PWSH_OK\n', 'sidecar output should be authoritative')
    assertEqual(result.exitCode, 0, 'the sidecar should retain the exact PowerShell exit status')
    assertEqual(result.capture?.state, 'complete', 'exact sidecar capture should be complete')
    const viewport = dumpViewport(service, terminalId, 32)
    assertCondition(
      viewport.includes('PS /tmp>') && !viewport.includes('PS \\tmp>'),
      'synthetic PowerShell prompts must preserve Unix cwd separators',
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'the verified completion prompt should reopen the agent command gate',
    )
    service.kill(terminalId)
  })

  await runCase('Windows-hosted Bash uses Unix command boundaries and dispatch', async () => {
    const terminalId = 'local-windows-bash'
    const runtimeToken = '55555555555555555555555555555555'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'windows-git-bash',
      isRemote: false,
      shell: 'C:/Program Files/Git/bin/bash.exe'
    })
    backend.setCommandProtocol(true, runtimeToken)
    backend.setCommandShellFamily('unix')
    const service = createService(backend)
    await createLocalTerminal(service, terminalId)

    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'ready',
      'a Unix-family shell must not wait for a PowerShell bootstrap marker merely because its host is Windows',
    )
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'windows_bash_initial', {
        cwd: '/c/Users/tester',
        homeDir: '/c/Users/tester',
      }),
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'the Bash initial boundary should open the command gate on Windows',
    )

    const command = "printf 'WIN_BASH_OK'"
    const taskId = await service.runCommandNoWait(terminalId, command)
    const payload = backend.getLastWrite(terminalId)
    assertCondition(
      payload.includes(`__gyshell_${runtimeToken}_dispatch`) &&
        payload.includes('WIN_BASH_OK') &&
        payload.endsWith('\n') &&
        !payload.endsWith('\r'),
      'Windows-hosted Bash must receive the Unix dispatcher and Unix Enter sequence',
    )

    const nonce = 'windows_bash_command_0001'
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preexec', 1, nonce) +
        'WIN_BASH_OK' +
        tokenizedUnixBoundary(runtimeToken, 'preend', 1, nonce) +
        tokenizedUnixBoundary(runtimeToken, 'precmd', 1, nonce, {
          cwd: '/c/Users/tester',
          homeDir: '/c/Users/tester',
        }),
    )
    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(result.stdoutDelta, 'WIN_BASH_OK', 'Bash capture should remain exact on a Windows host')
    assertEqual(result.exitCode, 0, 'Bash should retain its shell-provided exit status')
    assertEqual(result.capture?.state, 'complete', 'paired Unix boundaries should prove complete capture')
    assertEqual(
      service.getDisplayTerminals().find((item) => item.id === terminalId)
        ?.remoteOs,
      'windows',
      'shell-family selection must not rewrite filesystem host semantics',
    )
    service.kill(terminalId)
  })

  await runCase('modern PowerShell task completion cannot clear unsubmitted human input', async () => {
    const terminalId = 'modern-powershell-task-unsubmitted-input'
    const runtimeToken = '56565656565656565656565656565656'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'modern-powershell',
      isRemote: false,
      shell: 'powershell.exe'
    })
    backend.setCommandProtocol(true, runtimeToken)
    backend.setCommandShellFamily('powershell')
    const service = createService(backend)
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_modern_prompt')
    )

    const taskId = await service.runCommandNoWait(
      terminalId,
      "Write-Output 'AGENT_DONE'"
    )
    service.write(terminalId, 'Write-Output TYPEAHEAD')
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 1, 'modern_task_prompt')
    )
    await service.waitForTask(terminalId, taskId)
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the in-band task prompt must not make an unsubmitted PSReadLine buffer agent-safe'
    )
    service.kill(terminalId)
  })

  await runCase('Unix task completion cannot clear unsubmitted human input', async () => {
    const terminalId = 'unix-task-unsubmitted-input'
    const runtimeToken = '57575757575757575757575757575757'
    const backend = createUnixBackend()
    backend.setCommandProtocol(true, runtimeToken)
    backend.setCommandShellFamily('unix')
    const service = createService(backend)
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_unix_prompt')
    )

    const taskId = await service.runCommandNoWait(terminalId, "printf 'AGENT_DONE'")
    service.write(terminalId, 'TYPEAHEAD')
    const nonce = 'unix_task_prompt_0001'
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preexec', 1, nonce) +
        'AGENT_DONE' +
        tokenizedUnixBoundary(runtimeToken, 'preend', 1, nonce) +
        tokenizedUnixBoundary(runtimeToken, 'precmd', 1, nonce)
    )
    await service.waitForTask(terminalId, taskId)
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the Unix task prompt must not make unsubmitted terminal input agent-safe'
    )
    service.kill(terminalId)
  })

  await runCase('Unix manual prompt cannot clear typeahead received after preexec', async () => {
    const terminalId = 'unix-manual-typeahead-input'
    const runtimeToken = '58585858585858585858585858585858'
    const backend = createUnixBackend()
    backend.setCommandProtocol(true, runtimeToken)
    backend.setCommandShellFamily('unix')
    const service = createService(backend)
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_unix_prompt')
    )

    service.write(terminalId, 'sleep 1\n')
    const firstNonce = 'unix_manual_sleep_0001'
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preexec', 1, firstNonce)
    )
    service.write(terminalId, 'printf TYPEAHEAD_PENDING')
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preend', 1, firstNonce) +
        tokenizedUnixBoundary(runtimeToken, 'precmd', 1, firstNonce)
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the first prompt must not clear bytes typed after its preexec boundary'
    )

    service.write(terminalId, '\n')
    const secondNonce = 'unix_manual_typeahead_0002'
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preexec', 2, secondNonce) +
        tokenizedUnixBoundary(runtimeToken, 'preend', 2, secondNonce) +
        tokenizedUnixBoundary(runtimeToken, 'precmd', 2, secondNonce)
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'the prompt for the submitted typeahead command should restore idle'
    )
    service.kill(terminalId)
  })

  await runCase('Unix dispatcher echo stays private across local and SSH display surfaces', async () => {
    for (const connectionType of ['local', 'ssh'] as const) {
      const terminalId = `unix-private-dispatch-${connectionType}`
      const runtimeToken = connectionType === 'local'
        ? 'a1111111111111111111111111111111'
        : 'b2222222222222222222222222222222'
      const backend = createUnixBackend()
      backend.setCommandProtocol(true, runtimeToken)
      backend.setCommandShellFamily('unix')
      const service = createService(backend)
      let liveDisplay = ''
      service.setRawEventPublisher((channel, payload) => {
        const event = payload as { terminalId?: string; data?: string }
        if (channel === 'terminal:data' && event.terminalId === terminalId) {
          liveDisplay += event.data || ''
        }
      })
      if (connectionType === 'local') {
        await service.createTerminal({
          type: 'local',
          id: terminalId,
          title: terminalId,
          cols: 40,
          rows: 16,
        })
      } else {
        await createReadySshTerminal(service, terminalId)
        service.resize(terminalId, 40, 16)
      }
      backend.emitData(
        terminalId,
        tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_private_echo')
      )

      const baselineOffset = service.getCurrentOffset(terminalId)
      liveDisplay = ''
      const command = "printf 'VISIBLE_STDOUT'"
      const taskId = await service.runCommandNoWait(terminalId, command)
      const wireInput = backend.getLastWrite(terminalId)
      assertCondition(
        wireInput.includes(`__gyshell_${runtimeToken}_dispatch`) &&
          wireInput.includes('_command_exit'),
        `${connectionType} fixture must exercise the private Unix dispatcher`,
      )

      const chunkSizes = [1, 2, 7, 31]
      let cursor = 0
      let chunkIndex = 0
      while (cursor < wireInput.length) {
        const size = chunkSizes[chunkIndex % chunkSizes.length]!
        backend.emitData(terminalId, wireInput.slice(cursor, cursor + size))
        cursor += size
        chunkIndex += 1
      }
      backend.emitData(
        terminalId,
        '\x1b[?2004l\r\nPREEXEC_HOOK_VISIBLE\r\n'
      )

      const nonce = taskId.replace(/-/g, '')
      const privateLookingUserOutput = '__gyshell_user_literal'
      backend.emitData(
        terminalId,
        tokenizedUnixBoundary(runtimeToken, 'preexec', 1, nonce) +
          'VISIBLE_STDOUT' +
          privateLookingUserOutput +
          tokenizedUnixBoundary(runtimeToken, 'preend', 1, nonce) +
          tokenizedUnixBoundary(runtimeToken, 'precmd', 1, nonce),
      )
      const result = await service.waitForTask(terminalId, taskId)
      assertEqual(
        result.stdoutDelta,
        `VISIBLE_STDOUT${privateLookingUserOutput}`,
        `${connectionType} command capture must remain exact`,
      )
      await waitUntil(
        () => service.getRecentOutput(terminalId, 16).includes(privateLookingUserOutput),
        `${connectionType} headless terminal did not render the filtered stream`,
      )

      const surfaces = [
        { name: 'terminal:data', value: liveDisplay },
        { name: 'ring buffer', value: service.getBufferDelta(terminalId, baselineOffset) },
        { name: 'headless terminal', value: service.getRecentOutput(terminalId, 16) },
      ]
      for (const surface of surfaces) {
        assertEqual(
          surface.value.split(command).length - 1,
          1,
          `${connectionType} ${surface.name} must show the original command exactly once`,
        )
        assertCondition(
          surface.value.includes('VISIBLE_STDOUT') &&
            surface.value.includes(privateLookingUserOutput) &&
            surface.value.includes('PREEXEC_HOOK_VISIBLE'),
          `${connectionType} ${surface.name} must retain safe hook and post-preexec output`,
        )
        assertCondition(
          !surface.value.includes(`__gyshell_${runtimeToken}_dispatch`) &&
            !surface.value.includes('_command_exit') &&
            !surface.value.includes('builtin trap'),
          `${connectionType} ${surface.name} must never expose the private dispatcher`,
        )
      }
      service.kill(terminalId)
    }
  })

  await runCase('aborting before Unix preexec cannot release a delayed private echo', async () => {
    const terminalId = 'unix-private-dispatch-abort-race'
    const runtimeToken = 'c3333333333333333333333333333333'
    const backend = createUnixBackend()
    backend.setCommandProtocol(true, runtimeToken)
    backend.setCommandShellFamily('unix')
    const service = createService(backend)
    let liveDisplay = ''
    service.setRawEventPublisher((channel, payload) => {
      const event = payload as { terminalId?: string; data?: string }
      if (channel === 'terminal:data' && event.terminalId === terminalId) {
        liveDisplay += event.data || ''
      }
    })
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_abort_race')
    )

    const baselineOffset = service.getCurrentOffset(terminalId)
    liveDisplay = ''
    const command = "printf 'AFTER_ABORT'"
    const taskId = await service.runCommandNoWait(terminalId, command)
    const wireInput = backend.getLastWrite(terminalId)
    ;(service as any).markTaskAborted(terminalId, taskId)
    backend.emitData(terminalId, wireInput.slice(0, 19))
    backend.emitData(terminalId, wireInput.slice(19))

    assertCondition(
      !liveDisplay.includes(`__gyshell_${runtimeToken}_dispatch`) &&
        !service
          .getBufferDelta(terminalId, baselineOffset)
          .includes(`__gyshell_${runtimeToken}_dispatch`),
      'removing the active task must not release delayed dispatcher suppression',
    )

    const nonce = taskId.replace(/-/g, '')
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preexec', 1, nonce) +
        'OUTPUT_AFTER_ABORT' +
        tokenizedUnixBoundary(runtimeToken, 'preend', 1, nonce) +
        tokenizedUnixBoundary(runtimeToken, 'precmd', 1, nonce) +
        '\r\n$ ',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const recentOutput = service.getRecentOutput(terminalId, 32)
    assertCondition(
      recentOutput.includes('OUTPUT_AFTER_ABORT'),
      `post-abort verified output did not reach the headless terminal: ${JSON.stringify({
        liveDisplay,
        ring: service.getBufferDelta(terminalId, baselineOffset),
        recentOutput,
        pending: (service as any).pendingUnixCommandDisplayByTerminal.get(terminalId),
        boundary: (service as any).activeShellBoundaryByTerminal.get(terminalId),
      })}`,
    )
    for (const surface of [
      { name: 'terminal:data', value: liveDisplay },
      { name: 'ring buffer', value: service.getBufferDelta(terminalId, baselineOffset) },
      { name: 'headless terminal', value: recentOutput },
    ]) {
      assertEqual(
        surface.value.split(command).length - 1,
        1,
        `${surface.name} must show the accepted command once after a preexec race`,
      )
      assertCondition(
        surface.value.includes('OUTPUT_AFTER_ABORT') &&
          !surface.value.includes(`__gyshell_${runtimeToken}_dispatch`) &&
          !surface.value.includes('_command_exit'),
        `${surface.name} must stay private after task removal and retain later output`,
      )
    }
    assertEqual(
      (service as any).pendingUnixCommandDisplayByTerminal.has(terminalId),
      false,
      'the verified start boundary should release the independent display guard',
    )

    const promptFallbackBaseline = service.getCurrentOffset(terminalId)
    liveDisplay = ''
    const promptFallbackCommand = "printf 'NEVER_STARTED'"
    const promptFallbackTaskId = await service.runCommandNoWait(
      terminalId,
      promptFallbackCommand
    )
    const promptFallbackWire = backend.getLastWrite(terminalId)
    ;(service as any).markTaskAborted(terminalId, promptFallbackTaskId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 1, 'stale_before_echo')
    )
    assertEqual(
      (service as any).pendingUnixCommandDisplayByTerminal.has(terminalId),
      true,
      'a duplicate prompt received before this dispatcher echo must not release the guard',
    )
    backend.emitData(terminalId, promptFallbackWire)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(
        runtimeToken,
        'precmd',
        1,
        'abort_before_start_prompt'
      ) + 'PROMPT_AFTER_ABORT'
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const surface of [
      { name: 'terminal:data', value: liveDisplay },
      {
        name: 'ring buffer',
        value: service.getBufferDelta(terminalId, promptFallbackBaseline),
      },
      { name: 'headless terminal', value: service.getRecentOutput(terminalId, 32) },
    ]) {
      assertEqual(
        surface.value.split(promptFallbackCommand).length - 1,
        1,
        `${surface.name} must show an input cancelled before preexec exactly once`,
      )
      assertCondition(
        surface.value.includes('PROMPT_AFTER_ABORT') &&
          !surface.value.includes(`__gyshell_${runtimeToken}_dispatch`) &&
          !surface.value.includes('_command_exit'),
        `${surface.name} must recover at the authenticated prompt without leaking the cancelled dispatcher`,
      )
    }
    assertEqual(
      (service as any).pendingUnixCommandDisplayByTerminal.has(terminalId),
      false,
      'an authenticated same-sequence prompt after observed echo should release the guard',
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'a verified post-cancellation prompt should reopen the command gate',
    )
    service.kill(terminalId)
  })

  await runCase('Windows input without a bootstrap baseline stays fail closed', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'sidecar-initial-race',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setCommandProtocol(true)
    const prepareRelease = createDeferred()
    let prepareStarted = false
    backend.delayNextPrepare(prepareRelease.promise, () => {
      prepareStarted = true
    })
    const service = createService(backend) as any
    const terminalId = 'sidecar-initial-race'
    await createLocalTerminal(service, terminalId)
    backend.emitData(terminalId, 'PS sidecar ready')

    service.write(terminalId, 'whoami')
    service.write(terminalId, '\r')
    await waitUntil(
      () => backend.getWrites(terminalId).includes('\r'),
      'manual Enter must not wait for the initial sidecar baseline',
      250
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'input without a bootstrap-proven baseline must remain fail closed',
    )
    assertEqual(
      prepareStarted,
      false,
      'manual input must never start destructive prompt-journal preparation'
    )
    assertEqual(
      service.windowsManualPromptWatcherByTerminal.has(terminalId),
      false,
      'manual input must not attach a watcher without a pre-dispatch baseline'
    )
    prepareRelease.resolve()
    service.kill(terminalId)
  })

  await runCase('Windows absent bootstrap baseline never blocks recovery input', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'sidecar-zero-baseline-recovery',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setCommandProtocol(true)
    const service = createService(backend) as any
    const terminalId = 'sidecar-zero-baseline-recovery'
    await createLocalTerminal(service, terminalId)
    backend.emitData(terminalId, 'PS sidecar ready')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'unknown',
      'an unavailable bootstrap baseline should become explicitly unknown'
    )

    service.write(terminalId, '\r')
    await waitUntil(
      () => backend.getWrites(terminalId).includes('\r'),
      'an absent bootstrap baseline must not delay recovery Enter',
      250,
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'releasing recovery input must not invent a verified idle prompt',
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canWrite,
      true,
      'an unverified prompt baseline must remain user-recoverable',
    )

    assertEqual(
      service.windowsManualPromptWatcherByTerminal.has(terminalId),
      false,
      'manual input must not trigger destructive baseline acquisition after dispatch'
    )
    service.kill(terminalId)
  })

  await runCase('forged PowerShell input-idle records cannot reopen a manual gate', async () => {
    const terminalId = 'sidecar-input-idle-authentication'
    const { backend, service, runtimeToken } =
      await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, ["Write-Output 'BUSY'", '\r'])
    backend.emitData(
      terminalId,
      '\x1b]1337;gyshell_inputidle;seq=2;rev=1;nonce=manual_input_drained\x07' +
        `\x1b]1337;gyshell_${runtimeToken}_inputidle;seq=2;rev=1;nonce=forged_nonce\x07`
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    const snapshot = service.getTerminalRuntimeSnapshot(terminalId)
    assertEqual(
      snapshot?.canRunCommand,
      false,
      'legacy-namespace and wrong-nonce input-idle records must fail closed'
    )
    assertEqual(
      snapshot?.canWrite,
      true,
      'rejected protocol records must not disable user recovery input'
    )

    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the authenticated runtime-scoped input-idle record should restore idle'
    )
    service.kill(terminalId)
  })

  await runCase('an old prompt cannot consume a newer PowerShell input revision', async () => {
    const terminalId = 'sidecar-input-idle-prompt-floor'
    const { backend, service } =
      await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, ["Write-Output 'NEXT'\r"])
    backend.emitPowerShellPrompt(terminalId, 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the sidecar revision must remain pending at its older prompt sequence'
    )

    backend.emitPowerShellPrompt(terminalId, 2)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the same revision should settle at its minimum prompt sequence'
    )
    service.kill(terminalId)
  })

  await runCase('an in-flight old input-idle revision cannot satisfy newer Windows input', async () => {
    const terminalId = 'sidecar-input-idle-order'
    const { backend, service, runtimeToken } =
      await createReadyWindowsManualFixture(terminalId)

    await service.writeInputSequence(terminalId, ["Write-Output 'FIRST'\r"])
    await service.writeInputSequence(terminalId, ["Write-Output 'SECOND'\r"])
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 2, 'old_prompt') +
        tokenizedPowerShellInputIdle(runtimeToken, 2, 1)
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'a genuine old prompt idle must not acknowledge the newer local input revision'
    )

    backend.emitPowerShellPrompt(terminalId, 3)
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the final empty-input idle boundary should restore the gate'
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
    const delayedRequest = decodePromptFileRequest(fileWrites[0]?.content || '')
    assertEqual(
      delayedRequest.kind,
      'command',
      'the single persisted request must be typed as a user command'
    )
    assertEqual(
      delayedRequest.command,
      'Write-Output danger',
      'the protocol must persist the user request only once before cancellation'
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
    const persistedRequests = fileWrites
      .filter(({ content }) => content.length > 0)
      .map(({ content }) => decodePromptFileRequest(content))
    assertEqual(
      persistedRequests.length,
      1,
      'the command must be persisted exactly once before its trigger is attempted'
    )
    assertEqual(
      persistedRequests[0]?.command,
      'Write-Output must-not-run',
      'trigger failure must clean up the same user request without a probe phase'
    )
    assertEqual(
      persistedRequests[0]?.kind,
      'command',
      'the single request must retain its command identity'
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

  await runCase('runtime-scoped prompt files let a replacement dispatch before a stale write settles', async () => {
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
    service.write(terminalId, 'NEW_RUNTIME_INPUT')
    await waitUntil(
      () => replacementSettled,
      'the replacement dispatch should not wait for stale prompt-file io from another runtime'
    )
    const replacementOutcome = await Promise.allSettled([replacementStarting])
    assertEqual(
      replacementOutcome[0]?.status,
      'fulfilled',
      'the replacement command should dispatch on its own runtime-scoped path'
    )
    const replacementRequestPath = backend.getPromptFileRequestPath(terminalId)
    assertEqual(
      replacementRequestPath?.endsWith('.runtime-2'),
      true,
      'the replacement fake runtime should model the production runtime-specific sidecar path'
    )
    const replacementFileWrites = (backend as any).fileWritesByPtyId.get(
      `pty-${terminalId}`
    ) as Array<{ path: string; content: string }>
    const replacementRequestWrites = replacementFileWrites.filter(
      ({ path }) => path === replacementRequestPath
    )
    assertEqual(
      replacementRequestWrites.length,
      replacementFileWrites.length,
      'every request written before the old gate releases should belong to the replacement runtime path'
    )
    assertEqual(
      decodePromptFileRequest(
        replacementRequestWrites.filter(({ content }) => content.length > 0).at(-1)?.content || ''
      ).command,
      'Write-Output replacement-runtime',
      'the replacement user request must use the replacement runtime path'
    )
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId).slice(replacementWriteBaseline)),
      JSON.stringify([`${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r`]),
      'the single command trigger may dispatch, but startup-deferred input must wait for task completion'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      output: '',
      outputObservedUtf8Bytes: 0,
      outputTruncated: false,
    })
    await waitUntil(
      () => service.getActiveTaskId(terminalId) === undefined,
      'the replacement task should finish from its exact sidecar update'
    )
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId).slice(replacementWriteBaseline)),
      JSON.stringify([
        `${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r`,
        'NEW_RUNTIME_INPUT',
      ]),
      'startup-deferred input should replay only after the hidden request is finalized'
    )

    oldWriteGate.resolve()
    const oldOutcome = await Promise.allSettled([oldStarting])
    assertEqual(oldOutcome[0]?.status, 'rejected', 'the old startup should reject after reconnect')
    assertEqual(
      (await backend.readFile(`pty-${terminalId}`, replacementRequestPath!)).length,
      0,
      'a late old-runtime write and cleanup must not alter the replacement request file'
    )
    service.kill(terminalId)
  })

  await runCase('ordinary replacement input is not frozen by stale prompt-file io', async () => {
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
      replacementWriteBaseline + 1,
      'ordinary input should use the replacement runtime without waiting for stale io'
    )
    assertEqual(
      backend.getWrites(terminalId).at(-1),
      'REPLACEMENT_USER_ENTER',
      'the replacement input should be delivered to the replacement PTY immediately'
    )

    oldWriteGate.resolve()
    const oldOutcome = await Promise.allSettled([oldStarting])
    assertEqual(oldOutcome[0]?.status, 'rejected', 'the stale command should reject')
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId).slice(replacementWriteBaseline)),
      JSON.stringify(['REPLACEMENT_USER_ENTER']),
      'late old-runtime cleanup must not duplicate or suppress replacement input'
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
    controller.abort()
    const inputSequence = service.writeInputSequence(
      terminalId,
      ['CANCELLED_REPLACEMENT_INPUT'],
      { signal: controller.signal }
    )

    const inputOutcome = await Promise.allSettled([inputSequence])
    assertEqual(
      inputOutcome[0]?.status,
      'rejected',
      'a pre-aborted replacement input sequence must reject'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline,
      'aborted replacement input must not write while old-runtime io is stalled'
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

  await runCase('stale cleanup failure cannot quarantine a runtime-scoped replacement', async () => {
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
    })

    oldWriteGate.resolve()
    const oldOutcome = await Promise.allSettled([oldStarting])
    assertEqual(oldOutcome[0]?.status, 'rejected', 'the stale command should reject')
    await Promise.resolve()
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'ready',
      'an abandoned runtime path cannot make the replacement runtime unsafe'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline + 1,
      'replacement input must not wait on or be dropped by stale cleanup'
    )
    service.write(terminalId, 'LATER_UNSAFE_INPUT')
    assertEqual(
      backend.getWrites(terminalId).length,
      replacementWriteBaseline + 2,
      'future input should remain available on the isolated replacement runtime'
    )
    const unclearedRequest = decodePromptFileRequest(
      backend.getLastFileWrite(terminalId)?.content || ''
    )
    assertEqual(
      unclearedRequest.kind,
      'command',
      'the abandoned runtime path must retain the identity of its single request'
    )
    assertEqual(
      unclearedRequest.command,
      'Write-Output uncleared-stale-command',
      'a cleanup failure may leave the old command only on its abandoned runtime-scoped path'
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

    backend.emitData(terminalId, UNIX_OSC_PRECMD)
    // A real pending sequence now blocks command startup by design. This test
    // only needs an identity sentinel to prove a stale runtime callback cannot
    // delete queue state owned by its replacement.
    const replacementInputTail = Promise.resolve()
    ;(service as any).terminalInputSequenceTailByTerminal.set(
      terminalId,
      replacementInputTail
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

    prepareGate.resolve()
    const outcomes = await Promise.allSettled([replacementStarting])
    assertEqual(outcomes[0]?.status, 'fulfilled', 'the replacement command should still dispatch')
    assertEqual(
      backend.getWrites(terminalId).includes('REPLACEMENT_DEFERRED_INPUT'),
      true,
      'the replacement reservation should still release its deferred input'
    )
    service.kill(terminalId)
  })

  await runCase('a delayed old sidecar task poll cannot finish a replacement task', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'stale-task-poll-host',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/stale-poll-request.b64',
      'C:/Windows/Temp/GyShell/stale-poll-output.txt'
    )
    const service = createService(backend)
    const terminalId = 'stale-task-poll'
    await createReadySshTerminal(service, terminalId)

    const oldPollGate = createDeferred()
    const oldPollStarted = createDeferred()
    backend.onNextPromptFileUserRequestSuccess(() => {
      backend.delayNextPoll(oldPollGate.promise, oldPollStarted.resolve, {
        mode: 'windows-powershell-sidecar',
        sequence: 2,
        exitCode: 9,
        output: 'STALE_OLD_TASK_OUTPUT\r\n'
      })
    })
    await service.runCommandNoWait(terminalId, 'Write-Output old-task')
    await oldPollStarted.promise

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for stale task poll test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'

    const replacementTaskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output replacement-task'
    )
    oldPollGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))

    assertEqual(
      service.getActiveTaskId(terminalId),
      replacementTaskId,
      'an old runtime poll result must not finish the replacement active task'
    )
    assertEqual(
      service.getCommandOutputSnapshot(terminalId, replacementTaskId)?.output.includes(
        'STALE_OLD_TASK_OUTPUT'
      ),
      false,
      'an old runtime poll result must not attach output to the replacement task'
    )

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 3,
      exitCode: 0,
      output: 'replacement-output\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('replacement-output\r\n'),
      outputTruncated: false,
    })
    const replacementResult = await service.waitForTask(
      terminalId,
      replacementTaskId
    )
    assertEqual(replacementResult.exitCode, 0, 'the replacement watcher should finish its own task')
    assertEqual(
      replacementResult.stdoutDelta.trim(),
      'replacement-output',
      'the replacement task should retain only its own sidecar output'
    )
    service.kill(terminalId)
  })

  await runCase('an old runtime input-idle marker cannot restore prompt state after reconnect', async () => {
    const runtimeToken = '78787878787878787878787878787878'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'stale-manual-poll-host',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const terminalId = 'stale-manual-poll'
    backend.setCommandProtocol(true, runtimeToken)
    backend.setExposeCommandTrackingMode(true)
    backend.setInitialTrackingBaseline(1)
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0
    })
    const service = createService(backend)
    await createReadySshTerminal(service, terminalId)
    backend.emitData(terminalId, 'PS sidecar ready')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
      'the old runtime fixture needs an initial sidecar prompt baseline'
    )
    await service.writeInputSequence(terminalId, ['\r'])
    const oldRuntimeDataCallbacks = backend.captureDataCallbacks(terminalId)

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for stale manual poll test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'

    const staleMarker =
      tokenizedUnixBoundary(runtimeToken, 'precmd', 2, 'stale_prompt') +
      tokenizedPowerShellInputIdle(runtimeToken, 2, 1)
    oldRuntimeDataCallbacks.forEach((callback) => callback(staleMarker))
    assertEqual(
      (service as any).windowsPromptBaselineByTerminal.has(terminalId),
      false,
      'an old runtime callback must not repopulate a replacement baseline'
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState,
      'unknown',
      'an old runtime input-idle marker must not reopen the replacement command gate'
    )
    service.kill(terminalId)
  })

  await runCase('an aborted Windows flush cannot finish the next task with an old exit code', async () => {
    const runtimeToken = '1234567890abcdef1234567890abcdef'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.22631',
      arch: 'x64',
      hostname: 'delayed-flush-host',
      isRemote: false,
      shell: 'powershell.exe'
    })
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'windows-delayed-flush'
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_prompt_nonce')
    )

    const headless = (service as any).headlessPtys.get(terminalId)
    const originalHeadlessWrite = headless.write.bind(headless)
    const heldFlushCallbacks: Array<() => void> = []
    headless.write = (data: string, callback?: () => void): void => {
      originalHeadlessWrite(data, () => {
        if (callback) heldFlushCallbacks.push(callback)
      })
    }

    const oldTaskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output old-before-flush'
    )
    backend.emitData(
      terminalId,
      `old-output\r\n${tokenizedUnixBoundary(
        runtimeToken,
        'precmd',
        1,
        'old_task_nonce',
        { exitCode: 7 }
      )}`
    )
    await waitUntil(
      () => heldFlushCallbacks.length > 0,
      'the old Windows task should be waiting on its headless flush callback'
    )
    assertEqual(
      (service as any).pendingTaskFinishByTerminal.get(terminalId)?.taskId,
      oldTaskId,
      'the pending flush must be owned by the old task'
    )

    headless.write = originalHeadlessWrite
    service.interrupt(terminalId)
    ;(service as any).markTaskAborted(terminalId, oldTaskId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 2, 'interrupt_prompt_nonce')
    )
    const replacementTaskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output replacement-after-flush'
    )

    for (const callback of heldFlushCallbacks.splice(0)) callback()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assertEqual(
      service.getActiveTaskId(terminalId),
      replacementTaskId,
      'the old flush callback must not finish the replacement task'
    )

    backend.emitData(
      terminalId,
      `replacement-output\r\n${tokenizedUnixBoundary(
        runtimeToken,
        'precmd',
        3,
        'replacement_task_nonce',
        { exitCode: 0 }
      )}`
    )
    const replacementResult = await service.waitForTask(
      terminalId,
      replacementTaskId
    )
    assertEqual(replacementResult.exitCode, 0, 'the replacement should retain its own exit code')
    assertEqual(
      replacementResult.stdoutDelta.includes('replacement-output'),
      true,
      'the replacement should retain its own output'
    )
  })

  await runCase('an old runtime headless callback cannot satisfy a replacement flush barrier', async () => {
    const runtimeToken = 'abcdef1234567890abcdef1234567890'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.22631',
      arch: 'x64',
      hostname: 'stale-headless-callback-host',
      isRemote: true,
      shell: 'powershell.exe'
    })
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'stale-headless-callback'
    await createReadySshTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'old_initial_nonce')
    )

    const headless = (service as any).headlessPtys.get(terminalId)
    const originalHeadlessWrite = headless.write.bind(headless)
    const oldFlushCallbacks: Array<() => void> = []
    headless.write = (data: string, callback?: () => void): void => {
      originalHeadlessWrite(data, () => {
        if (callback) oldFlushCallbacks.push(callback)
      })
    }
    backend.emitData(terminalId, 'old-runtime-display\r\n')
    await waitUntil(
      () => oldFlushCallbacks.length > 0,
      'the old runtime should retain a delayed headless callback'
    )
    headless.write = originalHeadlessWrite

    backend.kill(`pty-${terminalId}`)
    await service.reconnectTerminal(terminalId)
    const replacement = service
      .getDisplayTerminals()
      .find((item) => item.id === terminalId)
    if (!replacement) {
      throw new Error('Missing replacement terminal for stale headless callback test')
    }
    replacement.isInitializing = false
    replacement.runtimeState = 'ready'
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'new_initial_nonce')
    )
    await waitUntil(
      () => (service as any).headlessFlushedSeqByTerminal.get(terminalId) === 1,
      'the replacement initial prompt should establish its own flush sequence'
    )

    for (const callback of oldFlushCallbacks.splice(0)) callback()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assertEqual(
      (service as any).headlessFlushedSeqByTerminal.get(terminalId),
      1,
      'the old callback must not repopulate replacement flush state'
    )

    const replacementFlushCallbacks: Array<() => void> = []
    headless.write = (data: string, callback?: () => void): void => {
      originalHeadlessWrite(data, () => {
        if (callback) replacementFlushCallbacks.push(callback)
      })
    }
    const replacementTaskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output replacement-render'
    )
    backend.emitData(
      terminalId,
      `replacement-render\r\n${tokenizedUnixBoundary(
        runtimeToken,
        'precmd',
        1,
        'replacement_render_nonce',
        { exitCode: 0 }
      )}`
    )
    assertEqual(
      service.getActiveTaskId(terminalId),
      replacementTaskId,
      'the replacement marker must wait for its own delayed render callback'
    )
    await waitUntil(
      () => replacementFlushCallbacks.length > 0,
      'the replacement should retain its own delayed headless callback'
    )
    for (const callback of replacementFlushCallbacks.splice(0)) callback()
    const result = await service.waitForTask(terminalId, replacementTaskId)
    assertEqual(result.exitCode, 0, 'the replacement should finish after its own flush')
    headless.write = originalHeadlessWrite
    service.kill(terminalId)
  })

  await runCase('interrupting a Windows task merges pending output without claiming complete capture', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win-abort-capture',
      isRemote: false,
      shell: 'powershell.exe'
    })
    const service = createService(backend)
    const terminalId = 'win-abort-capture'
    await createLocalTerminal(service, terminalId)
    const controller = new AbortController()
    const waiting = service.runCommandAndWait(
      terminalId,
      'Write-Output partial; Start-Sleep 30',
      { signal: controller.signal }
    )
    await waitUntil(
      () => service.getActiveTaskId(terminalId) !== undefined,
      'the Windows command should be active before interruption'
    )

    backend.emitData(terminalId, '\x1b[31mpartial\x1b[0m')
    controller.abort()
    const result = await waiting

    assertEqual(result.executionState, 'aborted', 'the interrupted task outcome should be aborted')
    assertEqual(result.stdoutDelta, 'partial', 'pending Windows output should be merged before abort finalization')
    assertEqual(result.capture?.state, 'unknown', 'an interrupted prefix must never be sealed complete')
    assertEqual(result.capture?.reason, 'tracking_lost', 'the interrupted capture should explain its unknown tail')
    assertEqual(
      result.capture?.terminalControlsObserved,
      true,
      'terminal-control observations from the pending projector should survive canonicalization'
    )
  })

  await runCase('Windows runtime exit retains output preceding a malformed marker suffix', async () => {
    const runtimeToken = 'fedcba0987654321fedcba0987654321'
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win-runtime-partial-marker',
      isRemote: true,
      shell: 'powershell.exe'
    })
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'win-runtime-partial-marker'
    await createReadySshTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_partial_nonce')
    )
    const waiting = service.runCommandAndWait(
      terminalId,
      'Write-Output partial; exit',
    )
    await waitUntil(
      () => service.getActiveTaskId(terminalId) !== undefined,
      'the partial-marker command should be active before runtime exit',
    )
    backend.emitData(
      terminalId,
      `partial\r\n\x1b]1337;gyshell_${runtimeToken}_precmd;seq=1;nonce=partial_marker_nonce`
    )
    backend.kill(`pty-${terminalId}`)
    const result = await waiting

    assertEqual(
      result.stdoutDelta.includes('partial'),
      true,
      'pre-marker output must survive even if canonical capture was premarked unknown',
    )
    assertEqual(result.executionState, 'outcome_unknown', 'runtime exit makes outcome unknown')
    assertEqual(result.capture?.state, 'unknown', 'malformed boundary cannot claim complete capture')
    assertEqual(
      result.capture?.reason,
      'tracking_lost',
      'the first specific malformed-boundary reason should survive runtime cleanup',
    )
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
    backend.emitData('continuing-stop', `${UNIX_OSC_PREEXEC}done${UNIX_OSC_PRECMD}\n`)
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
      '',
      'runtime status must not be mixed into the captured terminal transcript'
    )
    assertEqual(
      result.executionState,
      'outcome_unknown',
      'an exited task should settle immediately with an explicit typed outcome'
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
      executionState?: string
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
      '',
      'runtime status must not be mixed into the captured terminal transcript'
    )
    assertEqual(
      callbackResults[0]?.executionState,
      'outcome_unknown',
      'the exit callback should include an explicit typed non-success outcome'
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
    const storedExitTask = (service as any).tasksByTerminal.get(terminalId)?.[taskId]
    assertEqual(storedExitTask?.output, undefined, 'runtime-exit history must release duplicate output')
    assertEqual(storedExitTask?.wireCommand, undefined, 'runtime-exit history must release wire payloads')
    assertEqual(
      storedExitTask?.completionTracking,
      undefined,
      'runtime-exit history must release process-local tracking state'
    )
  })

  await runCase('fixed Windows marker text split across chunks cannot finish a command', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
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

    assertEqual(
      service.getActiveTaskId('win-local'),
      taskId,
      'printable marker-like output must not close the active task'
    )
    backend.setTrackingState('win-local', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: 'C:/Users/Administrator'
    })
    backend.emitData('win-local', 'PS C:\\Users\\Administrator> ')

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'the authenticated sidecar update should carry the exit code')
    assertEqual(
      result.stdoutDelta.includes('__GYSHELL_TASK_FINISH__::ec=0'),
      true,
      'marker-like printable text is user output and must be retained'
    )
  })

  await runCase('inline fixed Windows marker text is retained and cannot finish a command', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.17763',
      arch: 'x64',
      hostname: 'ws2019',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
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

    assertEqual(
      service.getActiveTaskId('win-local-inline-marker'),
      taskId,
      'inline marker-like output must not close the active task'
    )
    backend.setTrackingState('win-local-inline-marker', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: 'C:/Users/Administrator'
    })
    backend.emitData(
      'win-local-inline-marker',
      'PS C:\\Users\\Administrator> '
    )

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'only the authenticated sidecar update should finish the task')
    assertEqual(
      result.stdoutDelta.includes('hello__GYSHELL_TASK_FINISH__::ec=0'),
      true,
      'inline marker-like output must survive capture normalization'
    )
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

  await runCase('windows sidecar prompt-file dispatch uses its runtime-bound top-level dispatcher', async () => {
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
    const decodedFileWrite = decodePromptFileRequest(fileWrite?.content || '')

    assertEqual(
      fileWrite?.path,
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'prompt-file dispatch should target the hidden request file path from the backend token'
    )
    assertEqual(
      decodedFileWrite.command,
      'Get-Content \"$env:TEMP\\\\demo.txt\"',
      'prompt-file dispatch should store the original command text as base64 in the hidden request file'
    )
    assertEqual(
      decodedFileWrite.kind,
      'command',
      'the persisted user request must be explicitly distinct from its liveness probe'
    )
    assertEqual(
      backend.getLastWrite('win-local-prompt-file'),
      `${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r`,
      'prompt-file dispatch should invoke only the runtime-private top-level dispatcher'
    )

    backend.setTrackingState('win-local-prompt-file', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/SidecarHome',
      output: '\ufeffdemo-output\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('\ufeffdemo-output\r\n'),
      outputTruncated: false,
    })

    const result = await waitPromise
    assertEqual(result.exitCode, 0, 'prompt-file dispatch should still complete through the sidecar tracker')
    assertEqual(
      result.stdoutDelta,
      '\ufeffdemo-output\n',
      'prompt-file dispatch should preserve the visible command output, including a leading U+FEFF'
    )
    assertEqual(
      service.getCwd('win-local-prompt-file'),
      'C:/Windows',
      'validated sidecar cwd metadata must update the backend before relative path operations resume'
    )
    assertEqual(
      await service.getHomeDir('win-local-prompt-file'),
      'C:/Users/SidecarHome',
      'validated sidecar home metadata must update the backend together with cwd'
    )
  })

  await runCase('windows sidecar completes exact output without inventing an ambiguous exit code', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win-outcome-unknown',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/unknown-request.b64',
      'C:/Windows/Temp/GyShell/unknown-output.txt'
    )
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-sidecar-outcome-unknown',
      title: 'Windows Ambiguous Outcome',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait(
      'win-sidecar-outcome-unknown',
      "cmd /c exit 7; Write-Error 'later failure'"
    )
    const waitPromise = service.waitForTask('win-sidecar-outcome-unknown', taskId)
    const output = 'later failure\r\n'
    backend.setTrackingState('win-sidecar-outcome-unknown', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      outcomeKnown: false,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/SidecarHome',
      output,
      outputObservedUtf8Bytes: Buffer.byteLength(output),
      outputTruncated: false,
    })

    const result = await waitPromise
    assertEqual(
      result.executionState,
      'outcome_unknown',
      'an ambiguous PowerShell/native failure ordering must be represented honestly'
    )
    assertEqual(
      result.exitCode,
      undefined,
      'an ambiguous shell outcome must not receive a fabricated fallback exit code'
    )
    assertEqual(
      result.stdoutDelta,
      'later failure\n',
      'outcome uncertainty must remain independent from exact transcript capture'
    )
    assertEqual(
      result.capture?.state,
      'complete',
      'a complete transcript must remain complete when only the exit outcome is uncertain'
    )
    assertEqual(
      Boolean(result.terminalStatus?.includes('trustworthy exact exit code')),
      true,
      'the agent-facing result should explain exactly which part of the outcome is unknown'
    )
  })

  await runCase('prompt-file dispatch fails closed when its runtime-bound dispatcher is missing', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-missing-dispatch',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/missing-dispatch-request.b64',
      'C:/Windows/Temp/GyShell/missing-dispatch-output.txt'
    )
    const originalPrepare = backend.prepareCommandTracking.bind(backend)
    ;(backend as any).prepareCommandTracking = async (ptyId: string) => {
      const token = await originalPrepare(ptyId)
      if (token) token.dispatchInput = undefined
      return token
    }
    const service = createService(backend)
    const terminalId = 'win-prompt-missing-dispatch'
    await createLocalTerminal(service, terminalId)
    const baselineWrites = backend.getWrites(terminalId).length

    const outcome = await Promise.allSettled([
      service.runCommandNoWait(terminalId, 'Write-Output must-never-persist')
    ])

    assertEqual(outcome[0]?.status, 'rejected', 'missing top-level dispatch input must reject before request persistence')
    assertEqual(
      backend.getWrites(terminalId).length,
      baselineWrites,
      'a malformed prompt-file token must send no shell input'
    )
    assertEqual(
      (backend as any).fileWritesByPtyId.get(`pty-${terminalId}`).length,
      0,
      'a malformed prompt-file token must not persist even a probe request'
    )
    service.kill(terminalId)
  })

  await runCase('an indeterminate prompt-file write times out and quarantines its runtime', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-stalled-write',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/stalled-write-request.b64',
      'C:/Windows/Temp/GyShell/stalled-write-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingIoTimeoutMs = 15
    const terminalId = 'win-prompt-stalled-write'
    await createLocalTerminal(service, terminalId)
    const neverSettles = new Promise<void>(() => {})
    backend.delayNextWriteFile(neverSettles, () => {})

    const startedAt = Date.now()
    const outcome = await Promise.allSettled([
      service.runCommandNoWait(terminalId, 'Write-Output never-dispatched')
    ])
    const terminal = service
      .getDisplayTerminals()
      .find((item: { id: string }) => item.id === terminalId)

    assertEqual(outcome[0]?.status, 'rejected', 'a never-callback request write must reject within its IO budget')
    assertEqual(Date.now() - startedAt < 500, true, 'request write timeout must not freeze the command-start reservation')
    assertEqual(terminal?.runtimeState, 'exited', 'a late write has unknown ordering, so its exact runtime must be quarantined')
    assertEqual(
      service.getActiveTaskId(terminalId),
      undefined,
      'no task may be created after an indeterminate request mutation'
    )
    service.kill(terminalId)
  })

  await runCase('a stalled sidecar poll times out so a later exact completion can still finish', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-stalled-poll',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/stalled-poll-request.b64',
      'C:/Windows/Temp/GyShell/stalled-poll-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingIoTimeoutMs = 15
    service.commandTrackingPollIntervalMs = 5
    service.syntheticCommandQuietWindowMs = 5
    service.syntheticCommandMaxSyncWaitMs = 50
    const terminalId = 'win-prompt-stalled-poll'
    await createLocalTerminal(service, terminalId)
    const neverSettles = new Promise<void>(() => {})
    let releaseValidUpdate: () => void = () => {}
    const validUpdateReady = new Promise<void>((resolve) => {
      releaseValidUpdate = resolve
    })
    backend.onNextPromptFileUserRequestSuccess(() => {
      backend.delayNextPoll(
        neverSettles,
        () => {
          backend.setTrackingState(terminalId, {
            mode: 'windows-powershell-sidecar',
            sequence: 2,
            exitCode: 0,
            output: 'recovered-after-poll-timeout\r\n',
            outputObservedUtf8Bytes: Buffer.byteLength('recovered-after-poll-timeout\r\n'),
            outputTruncated: false,
          })
          releaseValidUpdate()
        },
        undefined
      )
    })

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output recovered-after-poll-timeout'
    )
    await validUpdateReady
    await waitUntil(
      () => service.getActiveTaskId(terminalId) === undefined,
      'the watcher should continue after one backend callback stalls',
      500
    )
    const result = await service.waitForTask(terminalId, taskId)

    assertEqual(result.executionState, 'finished', 'a timed-out poll attempt must not strand the active task')
    assertEqual(result.stdoutDelta.trim(), 'recovered-after-poll-timeout', 'the next exact update should remain authoritative')
    service.kill(terminalId)
  })

  await runCase('private prompt-file dispatcher redraw never leaks into the visible terminal transcript', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-probe-display',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/probe-display-request.b64',
      'C:/Windows/Temp/GyShell/probe-display-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    const terminalId = 'win-prompt-probe-display'
    await createLocalTerminal(service, terminalId)
    const originalWrite = backend.write.bind(backend)
    ;(backend as any).write = (ptyId: string, data: string) => {
      if (data === `${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r`) {
        backend.emitData(
          terminalId,
          `${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r\n__PRIVATE_DISPATCH_REDRAW__\r\n`
        )
      }
      originalWrite(ptyId, data)
    }

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output visible-user-command'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'visible-result\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('visible-result\r\n'),
      outputTruncated: false,
    })
    await service.waitForTask(terminalId, taskId)
    const visibleBuffer = service.buffers.get(terminalId)?.content || ''

    assertEqual(
      visibleBuffer.includes('__PRIVATE_DISPATCH_REDRAW__'),
      false,
      'dispatcher redraw should remain an internal protocol interaction'
    )
    assertEqual(
      visibleBuffer.includes(FAKE_PROMPT_FILE_DISPATCH_INPUT),
      false,
      'the runtime-private dispatcher command should never be shown to the user'
    )
    assertEqual(
      visibleBuffer.includes('visible-user-command') &&
        visibleBuffer.includes('visible-result'),
      true,
      'synthetic display should still show the user command and its owned result'
    )
    service.kill(terminalId)
  })

  await runCase('verified sidecar completion is not blocked forever by continuous background display', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-background-display',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/background-request.b64',
      'C:/Windows/Temp/GyShell/background-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.syntheticCommandQuietWindowMs = 1000
    service.syntheticCommandMaxSyncWaitMs = 35
    const terminalId = 'win-sidecar-background-display'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output protocol-owned-result'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'protocol-owned-result\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('protocol-owned-result\r\n'),
      outputTruncated: false,
    })
    const noise = setInterval(() => {
      backend.emitData(terminalId, 'background-writer\r\n')
    }, 5)
    const startedAt = Date.now()
    let result: CommandResult
    try {
      await waitUntil(
        () => service.getActiveTaskId(terminalId) === undefined,
        'verified completion should retire despite continuous display',
        500
      )
      result = await service.waitForTask(terminalId, taskId)
    } finally {
      clearInterval(noise)
    }

    assertEqual(result.executionState, 'finished', 'verified request identity and output should remain authoritative')
    assertEqual(
      Date.now() - startedAt < 500,
      true,
      'display quiescence must have a finite synchronization budget'
    )
    assertEqual(result.stdoutDelta.trim(), 'protocol-owned-result', 'background display must not replace task-owned output')
    service.kill(terminalId)
  })

  await runCase('request-bound sidecar tracking ignores recursive or unrelated prompt markers', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-request-bound',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/request-bound.b64',
      'C:/Windows/Temp/GyShell/request-bound.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.commandTrackingMaxConsecutiveErrors = 20
    const terminalId = 'win-local-request-bound'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'prompt | Out-Null; Start-Sleep -Milliseconds 100'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      requestId: 'ffffffffffffffffffffffffffffffff',
      output: '',
      outputObservedUtf8Bytes: 0,
      outputTruncated: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    assertEqual(
      service.getActiveTaskId(terminalId),
      taskId,
      'a recursive or unrelated prompt must not complete the still-running hidden request'
    )

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 3,
      exitCode: 0,
      output: 'real-completion\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('real-completion\r\n'),
      outputTruncated: false,
    })
    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(result.exitCode, 0, 'the matching request marker should complete the task')
    assertEqual(result.stdoutDelta.trim(), 'real-completion', 'only matching request output should be accepted')
  })

  await runCase('successful input sequences started during hidden command startup wait for its completion', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-sequence-fence',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/sequence-fence.b64',
      'C:/Windows/Temp/GyShell/sequence-fence.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    const terminalId = 'win-local-sequence-fence'
    await createLocalTerminal(service, terminalId)
    const prepareGate = createDeferred()
    const prepareStarted = createDeferred()
    const prepare = service.prepareCommandTracking.bind(service)
    service.prepareCommandTracking = async (terminal: any, options: any) => {
      prepareStarted.resolve()
      await prepareGate.promise
      return await prepare(terminal, options)
    }

    const starting = service.runCommandNoWait(terminalId, 'Write-Output task')
    await prepareStarted.promise
    let sequenceSettled = false
    const inputSequence = service
      .writeInputSequence(terminalId, ['SEQUENCE_INPUT', '\r'])
      .finally(() => {
        sequenceSettled = true
      })
    prepareGate.resolve()
    const taskId = await starting
    await new Promise((resolve) => setTimeout(resolve, 15))

    assertEqual(sequenceSettled, false, 'the successful sequence should remain deferred while the hidden task is active')
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId)),
      JSON.stringify([`${FAKE_PROMPT_FILE_DISPATCH_INPUT}\r`]),
      'only the single task trigger may reach PowerShell before request-bound completion'
    )

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'task\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('task\r\n'),
      outputTruncated: false,
    })
    await service.waitForTask(terminalId, taskId)
    await inputSequence
    assertEqual(
      JSON.stringify(backend.getWrites(terminalId).slice(-2)),
      JSON.stringify(['SEQUENCE_INPUT', '\r']),
      'the sequence should be delivered only after the request-bound task has finalized'
    )
    service.kill(terminalId)
  })

  await runCase('a missing prompt-file dispatcher quarantines its single unconsumed request', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-lost-prompt-hook',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/lost-hook-request.b64',
      'C:/Windows/Temp/GyShell/lost-hook-output.txt'
    )
    backend.setAutoProcessPromptFileDispatch(false)
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.promptFileRequestTimeoutMs = 25
    const terminalId = 'win-local-lost-prompt-hook'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output must-never-be-latent'
    )
    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(
      result.executionState,
      'outcome_unknown',
      'dispatcher loss must never be reported as command completion'
    )
    const persistedRequests = ((backend as any).fileWritesByPtyId.get(
      `pty-${terminalId}`
    ) as Array<{ content: string }>)
      .filter(({ content }) => content.length > 0)
      .map(({ content }) => decodePromptFileRequest(content))
    assertEqual(
      persistedRequests.length,
      1,
      'dispatcher loss must leave exactly one attempted request, not a probe-plus-command pair'
    )
    assertEqual(
      persistedRequests[0]?.command,
      'Write-Output must-never-be-latent',
      'the attempted request must preserve the exact user command identity'
    )
    assertEqual(
      backend.getLastFileWrite(terminalId)?.content,
      '',
      'the unconsumed command must be cleared before ownership is released'
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'exited',
      'ambiguous dispatcher loss must quarantine the exact runtime'
    )
    assertEqual(
      service.getActiveTaskId(terminalId),
      undefined,
      'dispatcher loss must not leave a running ghost task'
    )
    service.kill(terminalId)
  })

  await runCase('prompt-file dispatch fails unknown when the verified hook does not consume the real request', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-real-request-unconsumed',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/unconsumed-request.b64',
      'C:/Windows/Temp/GyShell/unconsumed-output.txt'
    )
    backend.setConsumePromptFileUserRequests(false)
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.promptFileRequestTimeoutMs = 25
    const terminalId = 'win-local-real-request-unconsumed'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output must-not-remain-latent'
    )
    const result = await service.waitForTask(terminalId, taskId)

    assertEqual(result.executionState, 'outcome_unknown', 'an unconsumed real request cannot be reported as executed')
    assertEqual(result.runtimeBoundary, true, 'request-consumption failure should close the command gate')
    assertEqual(result.capture?.state, 'unknown', 'the missing execution acknowledgement must be machine-readable')
    assertEqual(
      result.capture?.reason,
      'runtime_boundary',
      'quarantining the ambiguous runtime must expose the resulting runtime boundary'
    )
    assertEqual(
      result.terminalStatus?.includes('did not consume the command'),
      true,
      'the task should explain that the real request was never acknowledged'
    )
    assertEqual(
      backend.getLastFileWrite(terminalId)?.content,
      '',
      'the unconsumed user command must be removed before startup ownership is released'
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState,
      'unknown',
      'the terminal must remain quarantined from later agent commands'
    )
  })

  await runCase('missing sidecar output after a completion marker is tracking loss, not empty success', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-missing-sidecar-output',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/missing-output-request.b64',
      'C:/Windows/Temp/GyShell/missing-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.commandTrackingMaxConsecutiveErrors = 2
    const terminalId = 'win-local-missing-sidecar-output'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output expected-but-unreadable'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      outputObservedUtf8Bytes: 27,
      outputTruncated: false,
    })
    const result = await service.waitForTask(terminalId, taskId)

    assertEqual(result.executionState, 'outcome_unknown', 'missing authoritative output must not report success')
    assertEqual(result.runtimeBoundary, true, 'tracking loss should be an explicit runtime boundary')
    assertEqual(result.capture?.state, 'unknown', 'missing output must be machine-readable capture loss')
    assertEqual(result.capture?.reason, 'tracking_lost', 'missing output needs the stable tracking_lost reason')
    assertEqual(result.stdoutDelta, '', 'unreadable output must not be fabricated as a complete empty capture')
    service.kill(terminalId)
  })

  await runCase('startup-deferred input is replayed before a completion callback can enqueue work', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-callback-order',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/callback-order-request.b64',
      'C:/Windows/Temp/GyShell/callback-order-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.syntheticCommandQuietWindowMs = 5
    const terminalId = 'win-local-callback-order'
    await createLocalTerminal(service, terminalId)

    const prepareGate = createDeferred()
    const prepareStarted = createDeferred()
    const prepare = service.prepareCommandTracking.bind(service)
    service.prepareCommandTracking = async (terminal: any, options: any) => {
      prepareStarted.resolve()
      await prepareGate.promise
      return await prepare(terminal, options)
    }
    let callbackStartOutcome: PromiseSettledResult<string> | undefined
    const callbackObserved = createDeferred()
    const starting = service.runCommandNoWait(
      terminalId,
      'Write-Output first-task',
      () => {
        void Promise.allSettled([
          service.runCommandNoWait(terminalId, 'Write-Output callback-task')
        ]).then(([outcome]) => {
          callbackStartOutcome = outcome
          callbackObserved.resolve()
        })
      }
    )
    await prepareStarted.promise
    service.write(terminalId, 'DEFERRED_USER_INPUT')
    prepareGate.resolve()
    const taskId = await starting

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'first-task\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('first-task\r\n'),
      outputTruncated: false,
    })
    await service.waitForTask(terminalId, taskId)
    await callbackObserved.promise

    assertEqual(
      callbackStartOutcome?.status,
      'rejected',
      'the callback must observe deferred user input as owning the shell before it can start work'
    )
    assertEqual(
      callbackStartOutcome?.status === 'rejected' &&
        String(callbackStartOutcome.reason).includes('not at an idle prompt'),
      true,
      'callback startup should fail through the normal shell-input gate'
    )
    assertEqual(
      backend.getWrites(terminalId).filter((value) => value === 'DEFERRED_USER_INPUT').length,
      1,
      'deferred user input should be delivered exactly once before callback work'
    )
    service.kill(terminalId)
  })

  await runCase('a short retained sidecar file becomes tracking loss even when truncation is declared', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-short-retained',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/short-retained-request.b64',
      'C:/Windows/Temp/GyShell/short-retained-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.commandTrackingMaxConsecutiveErrors = 2
    const terminalId = 'win-local-short-retained'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output oversized-but-corrupt'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'short',
      outputObservedUtf8Bytes: 32 * 1024 * 1024,
      outputRetainedUtf8Bytes: 8,
      outputTruncated: true,
    })
    const result = await service.waitForTask(terminalId, taskId)

    assertEqual(result.executionState, 'outcome_unknown', 'a retained-length mismatch must not report success')
    assertEqual(result.capture?.state, 'unknown', 'the mismatch should be explicit capture uncertainty')
    assertEqual(result.capture?.reason, 'tracking_lost', 'the mismatch should use the stable tracking loss reason')
    service.kill(terminalId)
  })

  await runCase('sidecar observed-byte loss cannot be reported complete when the truncation flag lies', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-silent-loss',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/silent-loss-request.b64',
      'C:/Windows/Temp/GyShell/silent-loss-output.txt'
    )
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 5
    service.commandTrackingMaxConsecutiveErrors = 2
    const terminalId = 'win-local-silent-loss'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output corrupt-metadata'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'short',
      outputObservedUtf8Bytes: 100,
      outputRetainedUtf8Bytes: 5,
      outputTruncated: false,
    })
    const result = await service.waitForTask(terminalId, taskId)

    assertEqual(result.executionState, 'outcome_unknown', 'contradictory marker metadata must fail closed')
    assertEqual(result.capture?.state, 'unknown', 'silent byte loss must never produce a complete capture')
    assertEqual(result.capture?.reason, 'tracking_lost', 'contradictory byte counts should surface as tracking loss')
    service.kill(terminalId)
  })

  await runCase('windows sidecar retention loss is explicit in the capture contract', async () => {
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
      id: 'win-local-sidecar-retention',
      title: 'Windows Sidecar Retention',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait(
      'win-local-sidecar-retention',
      'Write-Output oversized'
    )
    const waitPromise = service.waitForTask('win-local-sidecar-retention', taskId)
    backend.setTrackingState('win-local-sidecar-retention', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'retained-prefix',
      outputObservedUtf8Bytes: 32 * 1024 * 1024,
      outputTruncated: true
    })

    const result = await waitPromise
    assertEqual(result.executionState, 'finished', 'capture loss must not change execution outcome')
    assertEqual(result.capture?.state, 'incomplete', 'retention loss must be machine-readable')
    assertEqual(result.capture?.reason, 'retention_limit', 'retention loss needs a stable reason')
    assertEqual(
      result.capture?.observedUtf8Bytes,
      32 * 1024 * 1024,
      'capture metadata should expose how much output the sidecar observed'
    )
  })

  await runCase('windows sidecar capture failure is uncertainty, not a retention limit', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-capture-failure',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/capture-failure-request.b64',
      'C:/Windows/Temp/GyShell/capture-failure-output.txt'
    )
    const service = createService(backend)
    const terminalId = 'win-local-sidecar-capture-failure'
    await createLocalTerminal(service, terminalId)

    const taskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output partial-before-formatter-failure'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'partial',
      outputObservedUtf8Bytes: 30,
      outputRetainedUtf8Bytes: 7,
      outputTruncated: false,
      outputCaptureFailed: true,
    })

    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(result.executionState, 'finished', 'capture failure must not invent command failure')
    assertEqual(result.stdoutDelta, 'partial', 'verified best-effort bytes should remain readable')
    assertEqual(result.capture?.state, 'unknown', 'capture infrastructure failure must be explicit uncertainty')
    assertEqual(result.capture?.reason, 'tracking_lost', 'capture failure needs a stable non-retention reason')

    const emptyTaskId = await service.runCommandNoWait(
      terminalId,
      'Write-Output lost-before-output-file-open'
    )
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      outputObservedUtf8Bytes: 30,
      outputRetainedUtf8Bytes: 0,
      outputTruncated: false,
      outputCaptureFailed: true,
    })

    const emptyResult = await service.waitForTask(terminalId, emptyTaskId)
    assertEqual(emptyResult.executionState, 'finished', 'an unreadable capture must not invent command failure')
    assertEqual(emptyResult.stdoutDelta, '', 'zero retained bytes must remain an empty best-effort transcript')
    assertEqual(emptyResult.capture?.state, 'unknown', 'missing capture bytes must remain explicit uncertainty')
    assertEqual(
      emptyResult.capture?.observedUtf8Bytes,
      30,
      'capture failure must retain the sidecar-observed byte count even without an output file'
    )
    service.kill(terminalId)
  })

  await runCase('empty native-pipeline output never triggers a second command execution', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-single-execution',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/single-exec-request.b64',
      'C:/Windows/Temp/GyShell/single-exec-output.txt'
    )
    const service = createService(backend)
    const terminalId = 'win-sidecar-single-execution'

    await service.createTerminal({
      type: 'local',
      id: terminalId,
      title: 'Windows Sidecar Single Execution',
      cols: 120,
      rows: 32
    })
    const command = 'native-producer | native-consumer'
    const taskId = await service.runCommandNoWait(terminalId, command)
    const waitPromise = service.waitForTask(terminalId, taskId)

    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: '',
      outputObservedUtf8Bytes: 0,
      outputTruncated: false
    })
    const result = await waitPromise

    assertEqual(
      backend.getExecOnSessionCallCount(),
      0,
      'empty pipeline output is a valid result and must never invoke a replay path'
    )
    assertEqual(
      decodePromptFileRequest(
        backend.getLastFileWrite(terminalId)?.content || ''
      ).command,
      command,
      'the hidden request should contain the user command exactly once'
    )
    assertEqual(result.stdoutDelta, '', 'an empty capture should remain empty')
    assertEqual(result.capture?.state, 'complete', 'a known empty sidecar capture is complete')
  })

  await runCase('request-bound sidecar frames retain split direct-console output without claiming completeness', async () => {
    const terminalId = 'win-sidecar-direct-console'
    const { backend, service, runtimeToken } =
      await createWindowsPromptFileFixture(terminalId)
    const taskId = await service.runCommandNoWait(
      terminalId,
      `[Console]::Write('DIRECT_CONSOLE')`
    )
    const requestId = decodePromptFileRequest(
      backend.getLastFileWrite(terminalId)?.content || ''
    ).requestId
    if (!requestId) {
      throw new Error('Missing request identity for direct-console fixture')
    }

    // Windows PowerShell/PSReadLine may finish echo rendering after dispatch.
    // The runtime emits this deliberately non-matching synchronization frame
    // before the real request frame so that residue remains outside capture.
    backend.emitData(
      terminalId,
      `${tokenizedUnixBoundary(runtimeToken, 'preexec', 1, '00000000000000000000000000000000')}\x1b[m`
    )
    const start = tokenizedUnixBoundary(
      runtimeToken,
      'preexec',
      1,
      requestId
    )
    for (let offset = 0; offset < start.length; offset += 7) {
      backend.emitData(terminalId, start.slice(offset, offset + 7))
    }
    backend.emitData(
      terminalId,
      'DIRECT_CONSOLE\r\nPS C:\\Literal> command-looking\r\n__GYSHELL_TASK_FINISH__::ec=0'
    )
    const end = tokenizedUnixBoundary(runtimeToken, 'preend', 1, requestId)
    for (let offset = 0; offset < end.length; offset += 5) {
      backend.emitData(terminalId, end.slice(offset, offset + 5))
    }
    backend.emitData(terminalId, 'PS C:\\Prompt-Must-Stay-Out> ')
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: '',
      outputObservedUtf8Bytes: 0,
      outputTruncated: false
    })

    const result = await service.waitForTask(terminalId, taskId)
    if (
      !result.stdoutDelta.includes('DIRECT_CONSOLE') ||
      !result.stdoutDelta.includes('PS C:\\Literal> command-looking') ||
      !result.stdoutDelta.includes('__GYSHELL_TASK_FINISH__::ec=0')
    ) {
      throw new Error('literal request-bound direct output must survive without prompt heuristics')
    }
    assertEqual(
      result.stdoutDelta.includes('Prompt-Must-Stay-Out'),
      false,
      'prompt bytes after the authenticated end frame must stay outside the task'
    )
    assertEqual(result.capture?.state, 'unknown', 'direct console bypasses cannot be called complete')
    assertEqual(
      result.capture?.reason,
      'projection_ambiguous',
      'dual-channel attribution needs a stable machine-readable warning'
    )
    assertEqual(
      result.capture?.terminalControlsObserved,
      false,
      'the synchronization reset outside the request pair must not taint task metadata'
    )
    service.kill(terminalId)
  })

  await runCase('mixed sidecar and control-bearing raw output is preserved and disclosed as ambiguous', async () => {
    const terminalId = 'win-sidecar-mixed-raw'
    const { backend, service } =
      await createWindowsPromptFileFixture(terminalId)
    const taskId = await service.runCommandNoWait(
      terminalId,
      `'PIPE_A'; [Console]::Write('DIRECT_B'); 'PIPE_C'`
    )
    const requestId = decodePromptFileRequest(
      backend.getLastFileWrite(terminalId)?.content || ''
    ).requestId
    if (!requestId) {
      throw new Error('Missing request identity for mixed-output fixture')
    }

    backend.emitData(terminalId, 'DISPATCH-ECHO-MUST-STAY-OUT')
    backend.emitPromptFileRawBoundary(terminalId, 'preexec', 1, requestId)
    backend.emitData(terminalId, '\x1b[31mDIRECT_B\x1b[0m')
    backend.emitPromptFileRawBoundary(terminalId, 'preend', 1, requestId)
    backend.emitData(terminalId, 'PROMPT-MUST-STAY-OUT')
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'PIPE_A\r\nPIPE_C\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('PIPE_A\r\nPIPE_C\r\n'),
      outputTruncated: false
    })

    const result = await service.waitForTask(terminalId, taskId)
    for (const expected of ['PIPE_A', 'PIPE_C', 'DIRECT_B']) {
      if (!result.stdoutDelta.includes(expected)) {
        throw new Error(`mixed output lost ${expected}`)
      }
    }
    assertEqual(
      result.stdoutDelta.includes('MUST-STAY-OUT'),
      false,
      'bytes outside the request-bound pair must not enter mixed output'
    )
    assertEqual(result.capture?.state, 'unknown', 'mixed output ordering cannot be proven')
    assertEqual(result.capture?.reason, 'projection_ambiguous', 'mixed channels must disclose ambiguity')
    assertEqual(
      result.capture?.terminalControlsObserved,
      true,
      'raw progress/color controls should be disclosed even when their projected text is retained'
    )
    service.kill(terminalId)
  })

  await runCase('request-bound raw retention loss remains visible beneath stronger attribution uncertainty', async () => {
    const terminalId = 'win-sidecar-raw-retention'
    const { backend, service } =
      await createWindowsPromptFileFixture(terminalId)
    const taskId = await service.runCommandNoWait(
      terminalId,
      `[Console]::Write(('R' * ${COMMAND_CAPTURE_MAX_UTF8_BYTES + 1024}))`
    )
    const requestId = decodePromptFileRequest(
      backend.getLastFileWrite(terminalId)?.content || ''
    ).requestId
    if (!requestId) {
      throw new Error('Missing request identity for raw-retention fixture')
    }

    backend.emitPromptFileRawBoundary(terminalId, 'preexec', 1, requestId)
    backend.emitData(
      terminalId,
      'R'.repeat(COMMAND_CAPTURE_MAX_UTF8_BYTES + 1024)
    )
    backend.emitPromptFileRawBoundary(terminalId, 'preend', 1, requestId)
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: '',
      outputObservedUtf8Bytes: 0,
      outputTruncated: false
    })
    const result = await service.waitForTask(terminalId, taskId)

    assertEqual(result.capture?.state, 'unknown', 'attribution uncertainty should outrank retention loss')
    assertEqual(result.capture?.reason, 'projection_ambiguous', 'raw attribution reason')
    assertEqual(
      result.capture?.retainedUtf8Bytes,
      COMMAND_CAPTURE_MAX_UTF8_BYTES,
      'raw retention should stop at the global byte ceiling'
    )
    assertEqual(
      result.capture?.observedUtf8Bytes,
      COMMAND_CAPTURE_MAX_UTF8_BYTES + 1024,
      'known discarded raw bytes should remain visible in metadata'
    )
    assertEqual(
      Buffer.byteLength(result.stdoutDelta, 'utf8'),
      COMMAND_CAPTURE_MAX_UTF8_BYTES,
      'only the bounded raw prefix should enter the task record'
    )
    service.kill(terminalId)
  })

  await runCase('independent sidecar and raw retention losses are additive', async () => {
    const terminalId = 'win-sidecar-dual-retention'
    const { backend, service } =
      await createWindowsPromptFileFixture(terminalId)
    const taskId = await service.runCommandNoWait(
      terminalId,
      `'S' * ${COMMAND_CAPTURE_MAX_UTF8_BYTES}; [Console]::Write(('R' * ${COMMAND_CAPTURE_MAX_UTF8_BYTES}))`
    )
    const requestId = decodePromptFileRequest(
      backend.getLastFileWrite(terminalId)?.content || ''
    ).requestId
    if (!requestId) {
      throw new Error('Missing request identity for dual-retention fixture')
    }

    backend.emitPromptFileRawBoundary(terminalId, 'preexec', 1, requestId)
    backend.emitData(
      terminalId,
      'R'.repeat(COMMAND_CAPTURE_MAX_UTF8_BYTES + 2048)
    )
    backend.emitPromptFileRawBoundary(terminalId, 'preend', 1, requestId)
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'S'.repeat(COMMAND_CAPTURE_MAX_UTF8_BYTES),
      outputObservedUtf8Bytes: COMMAND_CAPTURE_MAX_UTF8_BYTES + 1024,
      outputTruncated: true
    })

    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(
      result.capture?.observedUtf8Bytes,
      COMMAND_CAPTURE_MAX_UTF8_BYTES * 2 + 3072,
      'merged observed bytes must include both sources plus both discarded deltas'
    )
    assertEqual(
      result.capture?.retainedUtf8Bytes,
      COMMAND_CAPTURE_MAX_UTF8_BYTES,
      'the merged transcript must still honor its single global retention ceiling'
    )
    assertEqual(
      result.capture?.state,
      'unknown',
      'dual-channel ordering remains explicitly unprovable beneath known loss'
    )
    service.kill(terminalId)
  })

  await runCase('interactive sidecar prompts stay live for read_terminal_tab and write_stdin without final duplication', async () => {
    const terminalId = 'win-sidecar-interactive-prompt'
    const { backend, service } =
      await createWindowsPromptFileFixture(terminalId)
    const taskId = await service.runCommandNoWait(
      terminalId,
      `$name = Read-Host 'NAME'; "ANSWER=$name"`
    )
    const requestId = decodePromptFileRequest(
      backend.getLastFileWrite(terminalId)?.content || ''
    ).requestId
    if (!requestId) {
      throw new Error('Missing request identity for interactive prompt fixture')
    }

    backend.emitPromptFileRawBoundary(terminalId, 'preexec', 1, requestId)
    backend.emitData(terminalId, 'NAME: ')
    await waitUntil(
      () => dumpViewport(service, terminalId, 8).includes('NAME:'),
      'request-bound interactive prompt did not reach the live terminal view'
    )
    service.write(terminalId, 'Ada\r')
    assertEqual(
      backend.getLastWrite(terminalId),
      'Ada\r',
      'write_stdin input should reach the running sidecar command'
    )
    backend.emitData(terminalId, 'Ada\r\n')
    backend.emitPromptFileRawBoundary(terminalId, 'preend', 1, requestId)
    backend.setTrackingState(terminalId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: 'ANSWER=Ada\r\n',
      outputObservedUtf8Bytes: Buffer.byteLength('ANSWER=Ada\r\n'),
      outputTruncated: false
    })
    const result = await service.waitForTask(terminalId, taskId)
    const viewport = dumpViewport(service, terminalId, 12)

    assertEqual(
      viewport.split('NAME:').length - 1,
      1,
      'the live prompt should not be replayed by synthetic completion rendering'
    )
    if (!viewport.includes('ANSWER=Ada')) {
      throw new Error('hidden sidecar output should be appended after the live interaction')
    }
    assertEqual(result.capture?.state, 'unknown', 'interactive raw plus sidecar output is ambiguous')
    assertEqual(result.capture?.reason, 'projection_ambiguous', 'interactive ambiguity reason')
    service.kill(terminalId)
  })

  await runCase('missing sidecar raw boundaries fail closed while retaining only attributable best-effort text', async () => {
    const missingEndId = 'win-sidecar-missing-end'
    const missingEnd = await createWindowsPromptFileFixture(missingEndId)
    const missingEndTask = await missingEnd.service.runCommandNoWait(
      missingEndId,
      `[Console]::Write('BEST_EFFORT')`
    )
    const missingEndRequestId = decodePromptFileRequest(
      missingEnd.backend.getLastFileWrite(missingEndId)?.content || ''
    ).requestId
    if (!missingEndRequestId) {
      throw new Error('Missing request identity for missing-end fixture')
    }
    missingEnd.backend.emitPromptFileRawBoundary(
      missingEndId,
      'preexec',
      1,
      missingEndRequestId
    )
    missingEnd.backend.emitData(missingEndId, 'BEST_EFFORT')
    missingEnd.backend.setTrackingState(missingEndId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: '',
      outputObservedUtf8Bytes: 0,
      outputTruncated: false
    })
    const missingEndResult = await missingEnd.service.waitForTask(
      missingEndId,
      missingEndTask
    )
    assertEqual(missingEndResult.stdoutDelta, 'BEST_EFFORT', 'raw text after a valid start should be retained')
    assertEqual(missingEndResult.capture?.state, 'unknown', 'a missing end frame must fail closed')
    assertEqual(missingEndResult.capture?.reason, 'tracking_lost', 'a missing end frame is tracking loss')
    missingEnd.service.kill(missingEndId)

    const missingStartId = 'win-sidecar-missing-start'
    const missingStart = await createWindowsPromptFileFixture(missingStartId)
    const missingStartTask = await missingStart.service.runCommandNoWait(
      missingStartId,
      `[Console]::Write('UNATTRIBUTED')`
    )
    missingStart.backend.emitData(missingStartId, 'UNATTRIBUTED-MUST-STAY-OUT')
    missingStart.backend.setTrackingState(missingStartId, {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      output: '',
      outputObservedUtf8Bytes: 0,
      outputTruncated: false
    })
    const missingStartResult = await missingStart.service.waitForTask(
      missingStartId,
      missingStartTask
    )
    assertEqual(missingStartResult.stdoutDelta, '', 'raw text without a valid start is not attributable')
    assertEqual(missingStartResult.capture?.state, 'unknown', 'a missing start frame must fail closed')
    assertEqual(missingStartResult.capture?.reason, 'tracking_lost', 'a missing start frame is tracking loss')
    missingStart.service.kill(missingStartId)
  })

  await runCase('windows sidecar prompt-file dispatch fails closed when the hidden request write fails', async () => {
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

    await assertRejects(
      service.runCommandNoWait('win-local-prompt-file-fallback', 'Get-Date'),
      'temporary write failure'
    )
    assertEqual(
      backend.getLastWrite('win-local-prompt-file-fallback'),
      '',
      'a failed hidden request must never fall back to typing the command into the shell'
    )
    assertEqual(
      backend.getLastFileWrite('win-local-prompt-file-fallback')?.content,
      '',
      'the failed request path should be cleared before the command-start reservation is released'
    )
    assertEqual(
      service.getActiveTaskId('win-local-prompt-file-fallback'),
      undefined,
      'a command that was never dispatched must not leave a synthetic active task'
    )
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
      sequence: 1,
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

  await runCase('prepareCommandTracking failures block command dispatch before shell input', async () => {
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

    await assertRejects(
      service.runCommandNoWait('win-local-prepare-error', 'Write-Output 789'),
      'Unable to establish reliable command tracking'
    )
    assertEqual(
      backend.getLastWrite('win-local-prepare-error'),
      '',
      'tracking preparation failure must not deliver the command to an untrackable shell'
    )
    assertEqual(
      service.getActiveTaskId('win-local-prepare-error'),
      undefined,
      'tracking preparation failure must not create an active task'
    )
  })

  await runCase('timed-out tracking preparation quarantines the exact runtime before releasing its command gate', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-stalled-prepare',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend) as any
    service.commandTrackingIoTimeoutMs = 15
    const terminalId = 'win-local-stalled-prepare'

    await createLocalTerminal(service, terminalId)
    const prepareRelease = createDeferred()
    const prepareStarted = createDeferred()
    backend.delayNextPrepare(prepareRelease.promise, prepareStarted.resolve)
    const baselineWrites = backend.getWrites(terminalId).length

    const commandStart = service.runCommandNoWait(
      terminalId,
      'Write-Output must-never-dispatch'
    )
    await prepareStarted.promise
    await assertRejects(commandStart, 'command tracking preparation timed out')

    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'exited',
      'a timed-out non-cancellable preparation must make its exact runtime permanently non-writable'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      baselineWrites,
      'preparation timeout must not deliver any command bytes'
    )
    assertEqual(
      service.getActiveTaskId(terminalId),
      undefined,
      'preparation timeout must not create an active task'
    )
    await assertRejects(
      service.runCommandNoWait(terminalId, 'Write-Output no-ghost-reuse'),
      'is not ready'
    )

    prepareRelease.resolve()
    await Promise.resolve()
    await Promise.resolve()
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.runtimeState,
      'exited',
      'a late preparation callback must not revive its abandoned runtime'
    )
    assertEqual(
      backend.getWrites(terminalId).length,
      baselineWrites,
      'a late preparation callback must not dispatch a ghost command'
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

  await runCase('modern Windows runtime namespaces reject fixed-marker collisions and stop before prompt text', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win11-collision',
      isRemote: false,
      shell: 'powershell.exe'
    })
    const runtimeToken = 'fedcba9876543210fedcba9876543210'
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'win-modern-marker-collision'
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_collision_nonce'),
    )

    const taskId = await service.runCommandNoWait(terminalId, 'Write-Output VISIBLE')
    const waitPromise = service.waitForTask(terminalId, taskId)
    backend.emitData(
      terminalId,
      '\x1b]1337;gyshell_precmd;seq=1;ec=0;cwd_b64=QzpcV2luZG93cw==\x07FIXED_MARKER_SURVIVED'
    )
    assertEqual(
      service.getCommandTask(terminalId, taskId)?.status,
      'running',
      'a public fixed marker must not finish a token-namespaced runtime'
    )

    backend.emitData(
      terminalId,
      `\x1b[36mVISIBLE\x1b[0m\x1b]1337;gyshell_${runtimeToken}_precmd;seq=1;ec=0;cwd_b64=QzpcV2luZG93cw==;home_b64=QzpcVXNlcnNcQWRtaW4=\x07PS C:\\Windows> `
    )
    const result = await waitPromise

    assertEqual(
      result.stdoutDelta,
      'FIXED_MARKER_SURVIVEDVISIBLE',
      'the accepted end marker should exclude prompt text that follows in the same chunk'
    )
    assertEqual(result.capture?.state, 'unknown', 'modern end-only capture must remain best-effort')
    assertEqual(
      result.capture?.terminalControlsObserved,
      true,
      'pending Windows control-sequence observations must propagate to canonical metadata'
    )
  })

  await runCase('modern Windows in-band prompt omits an ambiguous exit code instead of inventing one', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win11-ambiguous-in-band',
      isRemote: false,
      shell: 'powershell.exe'
    })
    const runtimeToken = 'edcba9876543210fedcba9876543210f'
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'win-modern-ambiguous-in-band'
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_ambiguous_nonce'),
    )

    const taskId = await service.runCommandNoWait(
      terminalId,
      'cmd /c exit 7; Write-Error ambiguous'
    )
    const waitPromise = service.waitForTask(terminalId, taskId)
    backend.emitData(
      terminalId,
      `AMBIGUOUS_OUTPUT\r\n\x1b]1337;gyshell_${runtimeToken}_precmd;seq=1;cwd_b64=QzpcV2luZG93cw==;home_b64=QzpcVXNlcnNcQWRtaW4=\x07PS C:\\Windows> `
    )

    const result = await waitPromise
    assertEqual(
      result.executionState,
      'outcome_unknown',
      'a private prompt marker without ec must finish with an explicitly unknown outcome'
    )
    assertEqual(
      result.exitCode,
      undefined,
      'an omitted in-band ec must not receive a fallback shell exit code'
    )
    assertEqual(
      result.stdoutDelta,
      'AMBIGUOUS_OUTPUT',
      'exit-code uncertainty must not erase best-effort in-band output'
    )
    assertEqual(
      Boolean(result.terminalStatus?.includes('trustworthy exact exit code')),
      true,
      'the in-band result should explain the exact unknown dimension'
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
    assertEqual(
      result.capture?.state,
      'unknown',
      'an end-only PowerShell hook must not overclaim transcript completeness'
    )
    assertEqual(
      result.capture?.reason,
      'tracking_unavailable',
      'unpaired PowerShell capture should explain its weaker assurance'
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
    assertEqual(
      result.executionState,
      'outcome_unknown',
      'tracking loss should surface an explicit typed outcome instead of timing out silently'
    )
    assertEqual(
      result.capture?.state,
      'unknown',
      'tracking loss must not claim that the capture is complete'
    )
    assertEqual(
      result.capture?.reason,
      'tracking_lost',
      'tracking loss should preserve the machine-readable reason'
    )
    assertEqual(
      result.stdoutDelta.includes('123'),
      true,
      'tracking loss must retain already-observed best-effort Windows output without replaying the command',
    )
  })

  await runCase('private runtime markers gate startup and reject spoofed metadata or nonce pairs', async () => {
    const runtimeToken = '0123456789abcdef0123456789abcdef'
    const backend = createUnixBackend()
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'unix-private-command-protocol'
    await createLocalTerminal(service, terminalId)

    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'an explicitly supported Unix protocol must wait for its runtime-namespaced initial prompt'
    )
    const premature = await Promise.allSettled([
      service.runCommandNoWait(terminalId, 'printf premature')
    ])
    assertEqual(premature[0]?.status, 'rejected', 'startup gate should reject premature dispatch')
    assertEqual(backend.getWrites(terminalId).length, 0, 'startup rejection must not write command bytes')

    backend.emitData(
      terminalId,
      '\x1b]1337;gyshell_precmd;seq=0;nonce=spoof_nonce_0000;ec=0;cwd_b64=L2V2aWw=\x07'
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      'the public legacy namespace must not open a token-bound runtime gate'
    )
    assertEqual(service.getCwd(terminalId), '/tmp', 'a public-prefix spoof must not mutate cwd')

    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_nonce_0000', {
        cwd: '/trusted/start',
        homeDir: '/trusted/home'
      })
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      true,
      'the validated initial prompt should open the startup gate'
    )
    assertEqual(service.getCwd(terminalId), '/trusted/start', 'accepted initial metadata should update cwd')
    assertEqual(
      await service.getHomeDir(terminalId),
      '/trusted/home',
      'accepted initial metadata should update home'
    )

    const taskId = await service.runCommandNoWait(terminalId, 'printf trusted')
    backend.emitData(
      terminalId,
      '\x1b]1337;gyshell_preexec;seq=1;nonce=public_spoof_0001\x07' +
        '\x1b]1337;gyshell_precmd;seq=1;nonce=public_spoof_0001;ec=0;cwd_b64=L3Nwb29mZWQ=\x07'
    )
    assertEqual(
      service.getCommandTask(terminalId, taskId)?.status,
      'running',
      'legacy-prefix output must not complete a token-bound command'
    )
    assertEqual(service.getCwd(terminalId), '/trusted/start', 'legacy spoof metadata must remain ignored')

    const commandNonce = 'trusted_nonce_0001'
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preexec', 1, commandNonce) + 'trusted-output'
    )
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 1, 'wrong_nonce_0001', {
        cwd: '/wrong-nonce'
      })
    )
    assertEqual(
      service.getCommandTask(terminalId, taskId)?.status,
      'running',
      'a runtime-namespaced marker still requires the paired command nonce'
    )
    assertEqual(service.getCwd(terminalId), '/trusted/start', 'wrong-nonce metadata must remain ignored')

    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 1, commandNonce, {
        cwd: '/trusted/final',
        homeDir: '/trusted/home-final'
      })
    )
    const result = await service.waitForTask(terminalId, taskId)
    assertEqual(result.stdoutDelta, 'trusted-output', 'only the paired boundary should seal output')
    assertEqual(service.getCwd(terminalId), '/trusted/final', 'paired metadata should update cwd')
    assertEqual(
      await service.getHomeDir(terminalId),
      '/trusted/home-final',
      'paired metadata should update home'
    )
  })

  await runCase('validated same-sequence Bash prompt settles parse errors without replay', async () => {
    const runtimeToken = 'fedcba9876543210fedcba9876543210'
    const backend = createUnixBackend()
    backend.setCommandProtocol(true, runtimeToken)
    const service = createService(backend)
    const terminalId = 'unix-bash-parse-error'
    let liveDisplay = ''
    service.setRawEventPublisher((channel, payload) => {
      const event = payload as { terminalId?: string; data?: string }
      if (channel === 'terminal:data' && event.terminalId === terminalId) {
        liveDisplay += event.data || ''
      }
    })
    await createLocalTerminal(service, terminalId)
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_nonce_0000')
    )

    const baselineOffset = service.getCurrentOffset(terminalId)
    liveDisplay = ''
    const command = 'if then'
    const taskId = await service.runCommandNoWait(terminalId, command)
    backend.emitData(terminalId, backend.getLastWrite(terminalId))
    backend.emitData(terminalId, 'bash: syntax error near unexpected token `then`\r\n')
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'preend', 0, 'initial_nonce_0000') +
        'PROMPT_NOISE'
    )
    backend.emitData(
      terminalId,
      tokenizedUnixBoundary(runtimeToken, 'precmd', 0, 'initial_nonce_0000', {
        exitCode: 2
      })
    )
    const result = await service.waitForTask(terminalId, taskId)

    assertEqual(result.exitCode, 2, 'same-sequence validated prompt should preserve parse exit status')
    assertEqual(result.executionState, 'finished', 'parse error outcome should be known')
    assertEqual(
      result.stdoutDelta.includes('syntax error'),
      true,
      'best-effort pre-boundary capture should retain the shell diagnostic'
    )
    assertEqual(result.capture?.state, 'unknown', 'missing preexec must not claim complete capture')
    assertEqual(
      result.capture?.reason,
      'tracking_unavailable',
      'missing preexec should retain a machine-readable capture limitation'
    )
    assertEqual(
      result.stdoutDelta.includes('PROMPT_NOISE'),
      false,
      'prompt-hook output after the private preend marker must stay outside diagnostics'
    )
    for (const surface of [
      { name: 'terminal:data', value: liveDisplay },
      { name: 'ring buffer', value: service.getBufferDelta(terminalId, baselineOffset) },
    ]) {
      assertEqual(
        surface.value.split(command).length - 1,
        1,
        `${surface.name} should replace the hidden dispatcher with the original parse-error command`,
      )
      assertCondition(
        surface.value.includes('syntax error') &&
          !surface.value.includes(`__gyshell_${runtimeToken}_dispatch`) &&
          !surface.value.includes('_command_exit'),
        `${surface.name} should retain diagnostics without exposing private dispatch text`,
      )
    }
    assertEqual(backend.getWrites(terminalId).length, 1, 'parse-error recovery must never replay the command')
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

    backend.emitData('unix-local', `${UNIX_OSC_PREEXEC}test${UNIX_OSC_PRECMD}\n`)
    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'unix osc marker should still finish the task')
    assertEqual(result.stdoutDelta.trim(), 'test', 'unix output should remain visible')
  })

  await runCase('shells without a command boundary protocol fail before dispatch', async () => {
    const backend = createUnixBackend() as any
    backend.getCommandProtocolAvailability = () => false
    const service = createService(backend)
    const terminalId = 'unix-unsupported-command-protocol'
    await createLocalTerminal(service, terminalId)

    const snapshot = service.getTerminalRuntimeSnapshot(terminalId)
    assertEqual(snapshot?.canRunCommand, false, 'unsupported shells must not advertise exec support')

    const outcome = await Promise.allSettled([
      service.runCommandNoWait(terminalId, 'printf should-not-run')
    ])
    assertEqual(outcome[0]?.status, 'rejected', 'unsupported shells should fail immediately')
    assertEqual(
      backend.getWrites(terminalId).length,
      0,
      'fail-closed capability checks must happen before terminal input is written'
    )
  })

  await runCase('unix shell boundaries reject sequence poisoning and isolate prompt artifacts', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    const terminalId = 'unix-boundary-pairing'
    await createLocalTerminal(service, terminalId)

    const firstTaskId = await service.runCommandNoWait(terminalId, 'printf actual')
    const firstNonce = 'paired_nonce_0001'
    backend.emitData(
      terminalId,
      `${unixBoundary('preexec', 1, firstNonce)}actual${unixBoundary(
        'precmd',
        999,
        'forged_nonce_9999',
      )}`,
    )
    assertEqual(
      service.getCommandTask(terminalId, firstTaskId)?.status,
      'running',
      'a non-matching precmd must not finish the active task',
    )

    backend.emitData(
      terminalId,
      `${unixBoundary('preend', 1, firstNonce)}SHELL_PROMPT_ARTIFACT${unixBoundary(
        'precmd',
        1,
        firstNonce,
      )}`,
    )
    const first = await service.waitForTask(terminalId, firstTaskId)
    assertEqual(first.stdoutDelta, 'actual', 'preend must exclude shell-owned prompt rendering')

    const secondTaskId = await service.runCommandNoWait(terminalId, 'printf after')
    const secondNonce = 'paired_nonce_0002'
    backend.emitData(
      terminalId,
      `${unixBoundary('preexec', 2, secondNonce)}\x1b]1337;gyshell_precmd;seq=bad;nonce=x;ec=0\x07AFTER${unixBoundary(
        'precmd',
        2,
        secondNonce,
      )}`,
    )
    const second = await service.waitForTask(terminalId, secondTaskId)
    assertEqual(
      second.stdoutDelta,
      'AFTER',
      'best-effort transcript must continue after malformed reserved protocol',
    )
    assertEqual(second.capture?.state, 'unknown', 'malformed protocol must invalidate completeness')
    assertEqual(
      second.capture?.reason,
      'tracking_lost',
      'malformed protocol must preserve its machine-readable reason',
    )
  })

  await runCase('completed capture eviction leaves an explicit readable tombstone', async () => {
    const backend = createUnixBackend()
    const service = createService(backend) as any
    service.commandCaptureRetentionBudgetBytes = 5
    const terminalId = 'unix-capture-retention'
    await createLocalTerminal(service, terminalId)

    const firstTaskId = await service.runCommandNoWait(terminalId, 'printf 1111')
    backend.emitData(
      terminalId,
      `${unixBoundary('preexec', 1, 'retained_nonce_01')}1111${unixBoundary(
        'precmd',
        1,
        'retained_nonce_01',
      )}`,
    )
    await service.waitForTask(terminalId, firstTaskId)

    const secondTaskId = await service.runCommandNoWait(terminalId, 'printf 2222')
    backend.emitData(
      terminalId,
      `${unixBoundary('preexec', 2, 'retained_nonce_02')}2222${unixBoundary(
        'precmd',
        2,
        'retained_nonce_02',
      )}`,
    )
    await service.waitForTask(terminalId, secondTaskId)

    const expired = service.getCommandOutputSnapshot(terminalId, firstTaskId)
    const retained = service.getCommandOutputSnapshot(terminalId, secondTaskId)
    assertEqual(expired?.output, '', 'expired transcript bytes must be released')
    assertEqual(expired?.capture.state, 'unknown', 'expired transcript must remain addressable')
    assertEqual(
      expired?.capture.reason,
      'record_expired',
      'expired transcript must explain why bytes are unavailable',
    )
    assertEqual(retained?.output, '2222', 'the newest completed transcript must remain retained')
    assertEqual(retained?.capture.state, 'complete', 'retention must not weaken the newest result')
    const compactedTask = (service as any).tasksByTerminal.get(terminalId)?.[secondTaskId]
    assertEqual(compactedTask?.output, undefined, 'completed history must not duplicate capture text')
    assertEqual(compactedTask?.wireCommand, undefined, 'completed history must release private wire commands')
    assertEqual(
      compactedTask?.completionTracking,
      undefined,
      'completed history must release process-local tracking state'
    )

    const displayedTerminal = service
      .getDisplayTerminals()
      .find((terminal: any) => terminal.id === terminalId)
    if (!displayedTerminal) {
      throw new Error('missing retained-output terminal')
    }
    displayedTerminal.isInitializing = true
    displayedTerminal.runtimeState = 'initializing'
    assertEqual(
      service.getCommandOutputSnapshot(terminalId, secondTaskId)?.output,
      '2222',
      'runtime reinitialization must not hide immutable historical output',
    )
    assertEqual(
      service.getCommandTask(terminalId, secondTaskId)?.id,
      secondTaskId,
      'runtime reinitialization must not hide an addressable historical task',
    )
    assertEqual(
      service.getCommandTasks(terminalId).some((task: any) => task.id === secondTaskId),
      true,
      'runtime reinitialization must not hide the historical task list',
    )
  })

  await runCase('command history bounds detached and live tombstone records', async () => {
    const backend = createUnixBackend()
    const service = createService(backend) as any
    service.commandCaptureRetentionBudgetBytes = 1024 * 1024
    service.commandCaptureRetentionMaxRecords = 2
    service.commandHistoryTombstoneMaxRecords = 1
    const terminalId = 'unix-history-record-retention'
    await createLocalTerminal(service, terminalId)

    const taskIds: string[] = []
    for (let index = 1; index <= 4; index += 1) {
      const taskId = await service.runCommandNoWait(
        terminalId,
        `printf record-${index}`
      )
      taskIds.push(taskId)
      const nonce = `record_nonce_${String(index).padStart(2, '0')}`
      backend.emitData(
        terminalId,
        `${unixBoundary('preexec', index, nonce)}record-${index}${unixBoundary(
          'precmd',
          index,
          nonce,
        )}`,
      )
      await service.waitForTask(terminalId, taskId)
    }

    assertEqual(
      service.getCommandTask(terminalId, taskIds[0]),
      undefined,
      'the oldest tombstone must eventually leave the bounded history index',
    )
    assertEqual(
      service.getCommandOutputSnapshot(terminalId, taskIds[1])?.capture.reason,
      'record_expired',
      'the newest evicted transcript should remain an explicit tombstone',
    )
    assertEqual(
      service.getCommandOutputSnapshot(terminalId, taskIds[2])?.capture.state,
      'complete',
      'newer retained history must remain complete',
    )
    assertEqual(
      service.getCommandOutputSnapshot(terminalId, taskIds[3])?.output,
      'record-4',
      'the newest transcript must remain readable',
    )
  })

  await runCase('reusing a terminal id cannot rebind detached command provenance', async () => {
    const backend = createUnixBackend()
    const service = createService(backend)
    const terminalId = 'reused-terminal-provenance'
    await createLocalTerminal(service, terminalId)

    const oldTaskId = await service.runCommandNoWait(terminalId, 'printf old-runtime')
    backend.emitData(
      terminalId,
      `${unixBoundary('preexec', 1, 'old_runtime_nonce')}OLD${unixBoundary(
        'precmd',
        1,
        'old_runtime_nonce',
      )}`,
    )
    await service.waitForTask(terminalId, oldTaskId)
    service.kill(terminalId)

    await createLocalTerminal(service, terminalId)
    assertEqual(
      service.getCommandRecordLocation(terminalId, oldTaskId),
      'detached',
      'the old command must remain bound to its closed runtime history',
    )
    assertEqual(
      service.getCommandOutputSnapshot(terminalId, oldTaskId)?.output,
      'OLD',
      'same-id runtime replacement must not overwrite detached output',
    )

    const newTaskId = await service.runCommandNoWait(terminalId, 'printf new-runtime')
    backend.emitData(
      terminalId,
      `${unixBoundary('preexec', 1, 'new_runtime_nonce')}NEW${unixBoundary(
        'precmd',
        1,
        'new_runtime_nonce',
      )}`,
    )
    await service.waitForTask(terminalId, newTaskId)
    assertEqual(
      service.getCommandRecordLocation(terminalId, newTaskId),
      'active',
      'the replacement runtime must own only its new command record',
    )
    assertEqual(
      service.getCommandOutputSnapshot(terminalId, oldTaskId)?.output,
      'OLD',
      'new activity must leave the detached historical snapshot immutable',
    )
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

    backend.emitData(
      'unix-nowait-suppressed',
      `${UNIX_OSC_PREEXEC}suppressed${UNIX_OSC_PRECMD}\n`
    )
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
    backend.emitData(
      'unix-nowait-suppression-cleared',
      `${UNIX_OSC_PREEXEC}cleared${UNIX_OSC_PRECMD}\n`
    )
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
