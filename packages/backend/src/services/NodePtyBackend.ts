import * as pty from 'node-pty'
import {
  buildPackagedCliFishInitCommand,
  buildPackagedCliNushellInitCommand,
  buildPackagedCliPathShellSnippet,
  PACKAGED_CLI_DIRECTORY_ENV,
  quotePosixShellLiteral,
} from './terminal/packagedCliEnvironment'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { StringDecoder } from 'node:string_decoder'
import { COMMAND_CAPTURE_MAX_UTF8_BYTES } from '@gyshell/shared'
import {
  isLocalConnectionConfig,
  type TerminalCommandShellFamily,
  type TerminalCommandTrackingToken,
  type TerminalCommandTrackingMode,
  type TerminalCommandTrackingUpdate,
  type TerminalCommandProtocolMetadata,
  type TerminalBackend,
  type TerminalConfig,
  type TerminalExecOptions,
  type FileSystemEntry,
  type FileStatInfo,
} from '../types'
import {
  buildWindowsPowerShellBootstrapLoaderEncodedCommand,
  buildWindowsPowerShellBootstrapScript,
  buildWindowsPowerShellDispatchInput,
  buildWindowsPowerShellInputRevisionPath,
  serializeWindowsPowerShellInputRevision,
  buildWindowsPowerShellRequestMarkerPath,
  buildWindowsPowerShellEncodedCommand,
  parseWindowsBuildNumber,
  parseWindowsPromptMarkerLine,
  parseWindowsPowerShellRequestMarkerFile,
  shouldUseWindowsPowerShellSidecar,
  WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX,
  WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX,
  WINDOWS_POWERSHELL_INITIAL_PROMPT_SEQUENCE,
  WINDOWS_POWERSHELL_LOCAL_SIDECAR_DIR_PREFIX,
  WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES,
  WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS,
  type WindowsCommandTrackingMode,
  type WindowsPromptMarkerState,
} from './windowsPowerShellTracking'
import {
  buildCommandProtocolMarkerPrefix,
  buildInitializationReadyMarker,
  buildPowerShellInitializationReadySequence,
  buildUnixCommandDispatcherScript,
  consumeInitializationReadyRecord,
} from './terminal/CommandStreamProtocol'

const execFileAsync = promisify(execFile)

interface PtyInstance {
  pty: pty.IPty
  dataCallbacks: Set<(data: string) => void>
  exitCallbacks: Set<(code: number) => void>
  pendingData: string
  isInitializing?: boolean
  buffer?: string
}

interface BoundedCommandOutput {
  text: string
  observedUtf8Bytes: number
  truncated: boolean
}

export class NodePtyBackend implements TerminalBackend {
  private ptys: Map<string, PtyInstance> = new Map()
  private tmpPathsByPtyId: Map<string, string> = new Map()
  private cwdByPtyId: Map<string, string> = new Map()
  private homeDirByPtyId: Map<string, string> = new Map()
  private commandTrackingModeByPtyId: Map<string, WindowsCommandTrackingMode> = new Map()
  private promptMarkerPathByPtyId: Map<string, string> = new Map()
  private commandRequestPathByPtyId: Map<string, string> = new Map()
  private commandOutputPathByPtyId: Map<string, string> = new Map()
  private commandProtocolAvailabilityByPtyId: Map<string, boolean> = new Map()
  private commandProtocolTokenByPtyId: Map<string, string> = new Map()
  private commandShellFamilyByPtyId: Map<string, TerminalCommandShellFamily> = new Map()
  private promptMarkerStateByPtyId: Map<string, WindowsPromptMarkerState> = new Map()
  private hasScannedWindowsSidecarTempDirs = false

  private buildExecInvocation(command: string, platform = os.platform()): { shell: string; args: string[] } {
    if (platform === 'win32') {
      return {
        shell: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      }
    }
    return {
      shell: '/bin/sh',
      args: ['-c', command],
    }
  }

  private buildMonitorExecEnv(): Record<string, string> {
    const env = this.getSafeEnv()
    if (os.platform() !== 'win32') {
      env.LC_ALL = 'en_US.UTF-8'
      env.LANG = 'en_US.UTF-8'
    }
    return env
  }

  /**
   * Execute a local shell command and collect output.
   * Used by ResourceMonitorService for local resource stats.
   */
  async execOnSession(
    _ptyId: string,
    command: string,
    timeoutMs = 6000,
    options?: TerminalExecOptions
  ): Promise<{ stdout: string; stderr: string } | null> {
    try {
      const { shell, args } = this.buildExecInvocation(command)
      const env = this.buildMonitorExecEnv()

      if (options?.stdin !== undefined) {
        return await this.execWithStdin(shell, args, env, timeoutMs, options.stdin)
      }

      const { stdout, stderr } = await execFileAsync(shell, args, {
        timeout: timeoutMs,
        env,
      })
      return { stdout, stderr }
    } catch {
      return null
    }
  }

  private execWithStdin(
    shell: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
    stdin: string
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(shell, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error(`exec timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout!.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr!.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ stdout, stderr })
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })

      try {
        child.stdin!.end(stdin)
      } catch (err) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      }
    })
  }

  async prepareCommandTracking(ptyId: string): Promise<TerminalCommandTrackingToken | undefined> {
    const runtimeInstance = this.ptys.get(ptyId)
    const commandTrackingMode = this.commandTrackingModeByPtyId.get(ptyId)
    if (commandTrackingMode !== 'windows-powershell-sidecar') {
      return undefined
    }
    const markerPath = this.promptMarkerPathByPtyId.get(ptyId)
    const commandRequestPath = this.commandRequestPathByPtyId.get(ptyId)
    const commandOutputPath = this.commandOutputPathByPtyId.get(ptyId)
    const commandProtocolToken = this.commandProtocolTokenByPtyId.get(ptyId)
    if (!markerPath) {
      throw new Error('Windows prompt marker path is unavailable for this runtime.')
    }
    const runtimeIsCurrent = (): boolean =>
      this.ptys.get(ptyId) === runtimeInstance &&
      this.commandTrackingModeByPtyId.get(ptyId) === commandTrackingMode &&
      this.promptMarkerPathByPtyId.get(ptyId) === markerPath &&
      this.commandRequestPathByPtyId.get(ptyId) === commandRequestPath &&
      this.commandOutputPathByPtyId.get(ptyId) === commandOutputPath &&
      this.commandProtocolTokenByPtyId.get(ptyId) === commandProtocolToken
    const buildToken = (baselineSequence: number): TerminalCommandTrackingToken => ({
      mode: 'windows-powershell-sidecar',
      trackingScopeId: commandProtocolToken,
      baselineSequence,
      dispatchMode: commandRequestPath ? 'prompt-file' : undefined,
      dispatchInput: commandRequestPath
        ? buildWindowsPowerShellDispatchInput(commandProtocolToken)
        : undefined,
      displayMode: commandRequestPath ? 'synthetic-transcript' : undefined,
      commandRequestPath,
      commandOutputPath,
    })
    const snapshot = await this.refreshPromptMarkerState(ptyId, {
      allowCachedFallback: false,
      baseMarkerPath: markerPath,
    })
    if (!runtimeIsCurrent()) {
      throw new Error('Windows prompt marker runtime changed during preparation.')
    }
    if (!snapshot) {
      const resetOk = await this.resetPromptMarkerFile(ptyId, markerPath)
      if (!resetOk || !runtimeIsCurrent()) {
        throw new Error('Unable to establish a live Windows prompt marker baseline.')
      }
      return buildToken(0)
    }
    if (!(await this.resetPromptMarkerFile(ptyId, markerPath)) || !runtimeIsCurrent()) {
      throw new Error('Unable to reset the live Windows prompt marker journal.')
    }
    return buildToken(snapshot.sequence)
  }

  async pollCommandTracking(
    ptyId: string,
    token: TerminalCommandTrackingToken
  ): Promise<TerminalCommandTrackingUpdate | undefined> {
    if (token.mode !== 'windows-powershell-sidecar') {
      return undefined
    }
    if (this.commandTrackingModeByPtyId.get(ptyId) !== 'windows-powershell-sidecar') {
      return undefined
    }
    if (
      token.trackingScopeId &&
      this.commandProtocolTokenByPtyId.get(ptyId) !== token.trackingScopeId
    ) {
      return undefined
    }
    const snapshot = await this.refreshPromptMarkerState(ptyId, {
      allowCachedFallback: !token.awaitingInitialFreshMarker,
      expectedRequestId: token.expectedRequestId,
    })
    if (!snapshot || snapshot.sequence <= token.baselineSequence) {
      return undefined
    }
    if (
      token.trackingScopeId &&
      this.commandProtocolTokenByPtyId.get(ptyId) !== token.trackingScopeId
    ) {
      return undefined
    }
    if (
      token.expectedRequestId &&
      snapshot.requestId !== token.expectedRequestId
    ) {
      return undefined
    }
    if (token.awaitingInitialFreshMarker) {
      token.awaitingInitialFreshMarker = false
    }
    let output = await this.readCommandOutputFile(
      token.commandOutputPath || this.commandOutputPathByPtyId.get(ptyId)
    )
    if (
      token.trackingScopeId &&
      this.commandProtocolTokenByPtyId.get(ptyId) !== token.trackingScopeId
    ) {
      return undefined
    }
    if (
      snapshot.outputCaptureFailed === true &&
      output &&
      snapshot.outputRetainedUtf8Bytes !== output.observedUtf8Bytes
    ) {
      // A failed open can leave the previous request's file in place. Never
      // attach stale bytes to the completed request.
      output = undefined
    }
    if (
      token.expectCommandOutput &&
      token.commandOutputPath &&
      !output &&
      !(
        snapshot.outputCaptureFailed === true &&
        snapshot.outputRetainedUtf8Bytes === 0
      )
    ) {
      throw new Error('Windows sidecar output file is not readable yet.')
    }
    if (token.expectCommandOutput && output) {
      if (snapshot.outputRetainedUtf8Bytes === undefined) {
        throw new Error('Windows sidecar completion marker has no retained output length.')
      }
      if (output.observedUtf8Bytes !== snapshot.outputRetainedUtf8Bytes) {
        throw new Error('Windows sidecar output file length does not match its completion marker.')
      }
      if (Buffer.byteLength(output.text, 'utf8') !== output.observedUtf8Bytes) {
        throw new Error('Windows sidecar output file was not read as one complete UTF-8 transcript.')
      }
    }
    if (token.expectedRequestId) {
      const baseMarkerPath = this.promptMarkerPathByPtyId.get(ptyId)
      if (baseMarkerPath) {
        const completedMarkerPath = buildWindowsPowerShellRequestMarkerPath(
          baseMarkerPath,
          token.expectedRequestId
        )
        await fs.promises.unlink(completedMarkerPath).catch(() => {
          // Runtime cleanup and stale-sidecar retention remain the fallback.
        })
      }
    }
    return {
      mode: 'windows-powershell-sidecar',
      sequence: snapshot.sequence,
      exitCode: snapshot.exitCode,
      outcomeKnown: snapshot.outcomeKnown,
      requestId: snapshot.requestId,
      cwd: snapshot.cwd,
      homeDir: snapshot.homeDir,
      output: output?.text,
      outputObservedUtf8Bytes:
        snapshot.outputObservedUtf8Bytes ?? output?.observedUtf8Bytes,
      outputRetainedUtf8Bytes:
        snapshot.outputRetainedUtf8Bytes ?? output?.observedUtf8Bytes,
      outputTruncated: snapshot.outputTruncated ?? output?.truncated,
      outputCaptureFailed: snapshot.outputCaptureFailed,
    }
  }

  async refreshSessionState(ptyId: string): Promise<void> {
    if (this.commandTrackingModeByPtyId.get(ptyId) !== 'windows-powershell-sidecar') {
      return
    }
    await this.refreshPromptMarkerState(ptyId)
  }

  private cleanupTempArtifacts(ptyId: string): void {
    this.commandTrackingModeByPtyId.delete(ptyId)
    this.promptMarkerPathByPtyId.delete(ptyId)
    this.commandRequestPathByPtyId.delete(ptyId)
    this.commandOutputPathByPtyId.delete(ptyId)
    this.commandProtocolAvailabilityByPtyId.delete(ptyId)
    this.commandProtocolTokenByPtyId.delete(ptyId)
    this.commandShellFamilyByPtyId.delete(ptyId)
    this.promptMarkerStateByPtyId.delete(ptyId)
    const tmp = this.tmpPathsByPtyId.get(ptyId)
    if (!tmp) {
      return
    }
    this.tmpPathsByPtyId.delete(ptyId)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  private cleanupStaleWindowsSidecarTempDirs(): void {
    if (this.hasScannedWindowsSidecarTempDirs) {
      return
    }
    this.hasScannedWindowsSidecarTempDirs = true
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    } catch {
      return
    }
    const cutoffTime = Date.now() - WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(WINDOWS_POWERSHELL_LOCAL_SIDECAR_DIR_PREFIX)) {
        continue
      }
      const targetPath = path.join(os.tmpdir(), entry.name)
      try {
        const stats = fs.statSync(targetPath)
        if ((stats.mtimeMs || 0) >= cutoffTime) {
          continue
        }
        fs.rmSync(targetPath, { recursive: true, force: true })
      } catch {
        // ignore best-effort stale temp cleanup failures
      }
    }
  }

  private async refreshPromptMarkerState(
    ptyId: string,
    options?: {
      allowCachedFallback?: boolean
      expectedRequestId?: string
      baseMarkerPath?: string
    }
  ): Promise<WindowsPromptMarkerState | null> {
    const baseMarkerPath =
      options?.baseMarkerPath ?? this.promptMarkerPathByPtyId.get(ptyId)
    if (!baseMarkerPath) {
      return this.promptMarkerStateByPtyId.get(ptyId) || null
    }
    if (
      options?.baseMarkerPath &&
      this.promptMarkerPathByPtyId.get(ptyId) !== options.baseMarkerPath
    ) {
      return null
    }
    const markerPath = options?.expectedRequestId
      ? buildWindowsPowerShellRequestMarkerPath(
          baseMarkerPath,
          options.expectedRequestId
        )
      : baseMarkerPath
    try {
      const stats = await fs.promises.stat(markerPath)
      if (
        options?.expectedRequestId &&
        stats.size > WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES
      ) {
        throw new Error('Windows sidecar request marker exceeds its protocol limit.')
      }
      const raw = await fs.promises.readFile(markerPath, 'utf8')
      if (this.promptMarkerPathByPtyId.get(ptyId) !== baseMarkerPath) {
        return null
      }
      const exactRequestMarker = options?.expectedRequestId
        ? parseWindowsPowerShellRequestMarkerFile(
            raw,
            options.expectedRequestId
          )
        : undefined
      if (options?.expectedRequestId && !exactRequestMarker) {
        throw new Error('Windows sidecar request marker is malformed.')
      }
      const lines = exactRequestMarker ? [] : raw.split(/\r?\n/)
      const candidates = exactRequestMarker ? [exactRequestMarker] : lines
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index]
        const parsed = typeof candidate === 'string'
          ? parseWindowsPromptMarkerLine(candidate)
          : candidate
        if (!parsed) {
          continue
        }
        if (
          options?.expectedRequestId &&
          parsed.requestId !== options.expectedRequestId
        ) {
          continue
        }
        const next: WindowsPromptMarkerState = {
          sequence: parsed.sequence,
          exitCode: parsed.exitCode,
          outcomeKnown: parsed.outcomeKnown,
          requestId: parsed.requestId,
          outputObservedUtf8Bytes: parsed.outputObservedUtf8Bytes,
          outputRetainedUtf8Bytes: parsed.outputRetainedUtf8Bytes,
          outputTruncated: parsed.outputTruncated,
          outputCaptureFailed: parsed.outputCaptureFailed,
          cwd: parsed.cwd ? this.normalizeDecodedLocalPath(parsed.cwd) || undefined : undefined,
          homeDir: parsed.homeDir ? this.normalizeDecodedLocalPath(parsed.homeDir) || undefined : undefined,
          modifiedAtMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : undefined,
        }
        if (!options?.expectedRequestId) {
          this.promptMarkerStateByPtyId.set(ptyId, next)
          if (next.cwd) {
            this.cwdByPtyId.set(ptyId, next.cwd)
          }
          if (next.homeDir) {
            this.homeDirByPtyId.set(ptyId, next.homeDir)
          }
        }
        return next
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && options?.expectedRequestId) {
        throw error
      }
      if (error?.code !== 'ENOENT') {
        // ignore transient best-effort read failures
      }
    }
    if (options?.expectedRequestId) {
      // The immutable request marker is the completion commit record. Never
      // substitute a mutable journal cache when that exact file is absent.
      return null
    }
    if (options?.allowCachedFallback === false) {
      return null
    }
    const cached = this.promptMarkerStateByPtyId.get(ptyId)
    return cached || null
  }

  private async resetPromptMarkerFile(
    ptyId: string,
    expectedMarkerPath?: string
  ): Promise<boolean> {
    const markerPath =
      expectedMarkerPath ?? this.promptMarkerPathByPtyId.get(ptyId)
    if (!markerPath) {
      return false
    }
    if (
      expectedMarkerPath &&
      this.promptMarkerPathByPtyId.get(ptyId) !== expectedMarkerPath
    ) {
      return false
    }
    try {
      await fs.promises.mkdir(path.dirname(markerPath), { recursive: true })
      await fs.promises.writeFile(markerPath, '', 'utf8')
      if (this.promptMarkerPathByPtyId.get(ptyId) !== markerPath) {
        return false
      }
      this.promptMarkerStateByPtyId.delete(ptyId)
      return true
    } catch {
      return false
    }
  }

  private async readCommandOutputFile(
    filePath?: string
  ): Promise<BoundedCommandOutput | undefined> {
    if (!filePath) {
      return undefined
    }
    let handle: fs.promises.FileHandle | undefined
    try {
      const stats = await fs.promises.stat(filePath)
      const fileBytes = Math.max(0, Number(stats.size) || 0)
      const bytesToRead = Math.min(
        fileBytes,
        COMMAND_CAPTURE_MAX_UTF8_BYTES + 6
      )
      handle = await fs.promises.open(filePath, 'r')
      const buffer = Buffer.allocUnsafe(bytesToRead)
      let bytesRead = 0
      while (bytesRead < bytesToRead) {
        const partRead = (
          await handle.read(
            buffer,
            bytesRead,
            bytesToRead - bytesRead,
            bytesRead
          )
        ).bytesRead
        if (partRead <= 0) {
          break
        }
        bytesRead += partRead
      }
      if (bytesRead !== bytesToRead) {
        return undefined
      }
      const bytes = buffer.subarray(0, bytesRead)
      const decoder = new StringDecoder('utf8')
      const decoded = decoder.end(bytes)
      let retainedBytes = 0
      let text = ''
      for (const scalar of decoded) {
        const scalarBytes = Buffer.byteLength(scalar, 'utf8')
        if (retainedBytes + scalarBytes > COMMAND_CAPTURE_MAX_UTF8_BYTES) {
          break
        }
        text += scalar
        retainedBytes += scalarBytes
      }
      const observedUtf8Bytes = fileBytes
      return {
        text,
        observedUtf8Bytes,
        truncated: observedUtf8Bytes > retainedBytes,
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return undefined
      }
      return undefined
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  private getDefaultShell(): string {
    const platform = os.platform()
    if (platform === 'darwin') {
      return process.env.SHELL || '/bin/zsh'
    } else if (platform === 'win32') {
      return process.env.SHELL || 'powershell.exe'
    } else {
      return process.env.SHELL || '/bin/bash'
    }
  }

  private getSafeEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    // Ensure TERM exists for many CLI apps
    if (!env.TERM) env.TERM = 'xterm-256color'
    return env
  }

  private pickShell(shell?: string): string {
    const candidates = [shell, this.getDefaultShell(), '/bin/zsh', '/bin/bash'].filter((x): x is string => !!x)
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch {
        // ignore
      }
    }
    // Last resort: let posix_spawnp search PATH
    return candidates[0]!
  }

  async spawn(config: TerminalConfig): Promise<string> {
    if (!isLocalConnectionConfig(config)) {
      throw new Error('NodePtyBackend only supports local connections')
    }
    const localConfig = config

    const shell = this.pickShell(localConfig.shell)
    const commandShellFamily = this.resolveCommandShellFamily(shell)
    const cwdCandidate = localConfig.cwd || os.homedir()
    const cwd = fs.existsSync(cwdCandidate) ? cwdCandidate : os.homedir()
    const env = this.getSafeEnv()

    // Fix for Chinese characters rendering issues in packaged apps
    // Setting LC_ALL and LANG to UTF-8 ensures the shell and sub-processes use UTF-8 encoding
    const localeEnv = {
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    }

    const commandProtocolToken = this.shellSupportsCommandProtocol(shell)
      ? randomBytes(16).toString('hex')
      : undefined
    const initializationReadyRecord =
      commandShellFamily === 'powershell'
        ? buildPowerShellInitializationReadySequence(commandProtocolToken)
        : buildInitializationReadyMarker(commandProtocolToken)

    const {
      args,
      envOverrides,
      tmpPath,
      commandTrackingMode,
      promptMarkerPath,
      commandRequestPath,
      commandOutputPath,
    } = this.buildShellIntegration(shell, commandProtocolToken)
    const mergedEnv = { ...env, ...localeEnv, ...envOverrides }

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: config.cols || 80,
      rows: config.rows || 24,
      cwd,
      env: mergedEnv,
      useConpty: os.platform() === 'win32',
    })

    const waitsForPrivateReadyMarker =
      commandShellFamily === 'powershell'
    const instance: PtyInstance = {
      pty: ptyProcess,
      dataCallbacks: new Set(),
      exitCallbacks: new Set(),
      pendingData: '',
      isInitializing: waitsForPrivateReadyMarker,
      buffer: '',
    }

    ptyProcess.onData((data) => {
      const chunk = data.toString()
      if (instance.isInitializing) {
        instance.buffer += chunk
        const postInitializationData = consumeInitializationReadyRecord(
          instance.buffer!,
          initializationReadyRecord
        )
        if (postInitializationData !== undefined) {
          instance.isInitializing = false
          const realContent = postInitializationData.trimStart()
          if (realContent) {
            this.emitPtyData(instance, realContent)
          }
          instance.buffer = ''
        }
      } else {
        this.emitPtyData(instance, chunk)
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      // TerminalService can synchronously auto-restart a local terminal from
      // an exit callback using the same public pty id. Retire this exact
      // instance before notifying consumers so the old callback cannot erase
      // replacement maps after spawn repopulates them.
      if (this.ptys.get(config.id) === instance) {
        this.ptys.delete(config.id)
        this.cwdByPtyId.delete(config.id)
        this.homeDirByPtyId.delete(config.id)
        this.cleanupTempArtifacts(config.id)
      }
      instance.exitCallbacks.forEach((callback) => callback(exitCode))
    })

    this.ptys.set(config.id, instance)
    if (tmpPath) this.tmpPathsByPtyId.set(config.id, tmpPath)
    if (commandTrackingMode) this.commandTrackingModeByPtyId.set(config.id, commandTrackingMode)
    if (promptMarkerPath) this.promptMarkerPathByPtyId.set(config.id, promptMarkerPath)
    if (commandRequestPath) this.commandRequestPathByPtyId.set(config.id, commandRequestPath)
    if (commandOutputPath) this.commandOutputPathByPtyId.set(config.id, commandOutputPath)
    this.commandProtocolAvailabilityByPtyId.set(
      config.id,
      this.shellSupportsCommandProtocol(shell)
    )
    if (commandProtocolToken) {
      this.commandProtocolTokenByPtyId.set(config.id, commandProtocolToken)
    }
    if (commandShellFamily) {
      this.commandShellFamilyByPtyId.set(config.id, commandShellFamily)
    }
    return config.id
  }

  getCommandProtocolAvailability(ptyId: string): boolean | undefined {
    return this.commandProtocolAvailabilityByPtyId.get(ptyId)
  }

  getCommandProtocolToken(ptyId: string): string | undefined {
    return this.commandProtocolTokenByPtyId.get(ptyId)
  }

  getCommandShellFamily(
    ptyId: string
  ): TerminalCommandShellFamily | undefined {
    return this.commandShellFamilyByPtyId.get(ptyId)
  }

  getCommandTrackingMode(
    ptyId: string
  ): TerminalCommandTrackingMode | undefined {
    return this.commandTrackingModeByPtyId.get(ptyId) ===
      'windows-powershell-sidecar'
      ? 'windows-powershell-sidecar'
      : undefined
  }

  getInitialCommandTrackingToken(
    ptyId: string
  ): TerminalCommandTrackingToken | undefined {
    const instance = this.ptys.get(ptyId)
    if (
      instance?.isInitializing !== false ||
      this.commandTrackingModeByPtyId.get(ptyId) !==
        'windows-powershell-sidecar'
    ) {
      return undefined
    }
    return {
      mode: 'windows-powershell-sidecar',
      trackingScopeId: this.commandProtocolTokenByPtyId.get(ptyId),
      baselineSequence: WINDOWS_POWERSHELL_INITIAL_PROMPT_SEQUENCE,
    }
  }

  async commitPowerShellInputRevision(
    ptyId: string,
    revision: number,
    minimumPromptSequence: number
  ): Promise<void> {
    const revisionState = serializeWindowsPowerShellInputRevision(
      revision,
      minimumPromptSequence
    )
    const runtimeInstance = this.ptys.get(ptyId)
    const markerPath = this.promptMarkerPathByPtyId.get(ptyId)
    if (
      !runtimeInstance ||
      this.commandTrackingModeByPtyId.get(ptyId) !==
        'windows-powershell-sidecar' ||
      !markerPath
    ) {
      throw new Error('PowerShell input revision sidecar is unavailable.')
    }
    await fs.promises.writeFile(
      buildWindowsPowerShellInputRevisionPath(markerPath),
      revisionState,
      'utf8'
    )
    if (
      this.ptys.get(ptyId) !== runtimeInstance ||
      this.promptMarkerPathByPtyId.get(ptyId) !== markerPath
    ) {
      throw new Error('PowerShell input revision runtime changed during commit.')
    }
  }

  private shellSupportsCommandProtocol(shellPath: string): boolean {
    return this.resolveCommandShellFamily(shellPath) !== undefined
  }

  private resolveCommandShellFamily(
    shellPath: string
  ): TerminalCommandShellFamily | undefined {
    const shellBase = path.basename(shellPath).toLowerCase()
    if (shellBase.includes('zsh') || shellBase.includes('bash')) {
      return 'unix'
    }
    if (
      shellBase.includes('powershell') ||
      shellBase.includes('pwsh') ||
      shellBase.includes('cmd.exe')
    ) {
      return 'powershell'
    }
    return undefined
  }

  /**
   * Inject "invisible" command boundary markers via shell integration hooks.
   * This avoids printing any wrapper/marker commands in the terminal.
   *
   * Markers (OSC) are emitted on:
   * - bash: DEBUG trap (preexec-ish) and PROMPT_COMMAND (precmd-ish)
   * - zsh: preexec + precmd hooks
   */
  private buildShellIntegration(shellPath: string, runtimeToken?: string): {
    args: string[]
    envOverrides: Record<string, string>
    tmpPath?: string
    commandTrackingMode?: WindowsCommandTrackingMode
    promptMarkerPath?: string
    commandRequestPath?: string
    commandOutputPath?: string
  } {
    const shellBase = path.basename(shellPath).toLowerCase()
    const commandMarkerPrefix = buildCommandProtocolMarkerPrefix(runtimeToken)
    const privateIdentifierPrefix = runtimeToken
      ? `__gyshell_${runtimeToken}`
      : '__gyshell'
    const packagedCliDirectory = process.env[PACKAGED_CLI_DIRECTORY_ENV]
    const packagedCliPathSnippet = buildPackagedCliPathShellSnippet(packagedCliDirectory)

    // zsh integration via ZDOTDIR/.zshrc (no visible setup commands)
    if (shellBase.includes('zsh')) {
      const commandSequenceName = `${privateIdentifierPrefix}_command_seq`
      const commandNonceName = `${privateIdentifierPrefix}_command_nonce`
      const inCommandName = `${privateIdentifierPrefix}_in_command`
      const dispatchActiveName = `${privateIdentifierPrefix}_dispatch_active`
      const dispatchCompletionReadyName = `${privateIdentifierPrefix}_dispatch_completion_ready`
      const dispatcherName = `${privateIdentifierPrefix}_dispatch`
      const savedPromptEolName = `${privateIdentifierPrefix}_saved_prompt_eol_mark`
      const savedExitName = `${privateIdentifierPrefix}_command_exit`
      const preexecHookName = runtimeToken
        ? `${privateIdentifierPrefix}_preexec`
        : 'gyshell_preexec'
      const precmdHookName = runtimeToken
        ? `${privateIdentifierPrefix}_precmd`
        : 'gyshell_precmd'
      const precmdBeginHookName = runtimeToken
        ? `${privateIdentifierPrefix}_precmd_begin`
        : 'gyshell_precmd_begin'
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-zsh-'))
      const wrapperZdotDir = quotePosixShellLiteral(tmpDir)
      const userZdotDirEnv = 'GYSHELL_USER_ZDOTDIR'
      const captureUserZdotDir = `if [ -n "\${ZDOTDIR:-}" ] && [ "$ZDOTDIR" != ${wrapperZdotDir} ]; then export ${userZdotDirEnv}="$ZDOTDIR"; fi\n`
      const reassertWrapperZdotDir = captureUserZdotDir + `export ZDOTDIR=${wrapperZdotDir}\n`
      const sourceUserProfile = (name: string) =>
        `if [ -f "\${${userZdotDirEnv}:-$HOME}/.${name}" ]; then source "\${${userZdotDirEnv}:-$HOME}/.${name}"; fi\n`
      // Login shell reads: .zshenv -> .zprofile -> .zshrc -> .zlogin (all under ZDOTDIR)
      // Keep the wrapper ZDOTDIR active even when the user's .zshenv changes
      // it, while proxying every later profile from the user's chosen path.
      fs.writeFileSync(
        path.join(tmpDir, '.zshenv'),
        `# gyshell integration (generated)\n` +
          sourceUserProfile('zshenv') +
          reassertWrapperZdotDir +
          `${packagedCliPathSnippet}\n`,
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmpDir, '.zprofile'),
        `# gyshell integration (generated)\n` +
          sourceUserProfile('zprofile') +
          reassertWrapperZdotDir +
          `${packagedCliPathSnippet}\n`,
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmpDir, '.zlogin'),
        `# gyshell integration (generated)\n` +
          sourceUserProfile('zlogin') +
          captureUserZdotDir +
          `${packagedCliPathSnippet}\n` +
          // .zlogin runs after .zshrc. Re-assert the private hooks in case a
          // user login profile replaced the hook arrays during startup.
          `autoload -Uz add-zsh-hook 2>/dev/null || true\n` +
          `add-zsh-hook preexec ${preexecHookName}\n` +
          `precmd_functions=(${precmdBeginHookName} \${precmd_functions:#${precmdBeginHookName}})\n` +
          `precmd_functions=(\${precmd_functions:#${precmdHookName}} ${precmdHookName})\n` +
          `export ZDOTDIR="\${${userZdotDirEnv}:-$HOME}"\n` +
          `unset ${userZdotDirEnv}\n`,
        'utf8'
      )

      const rcPath = path.join(tmpDir, '.zshrc')
      const script =
        `# gyshell integration (generated)\n` +
        sourceUserProfile('zshrc') +
        reassertWrapperZdotDir +
        `${packagedCliPathSnippet}\n` +
        `autoload -Uz add-zsh-hook 2>/dev/null || true\n` +
        // Use builtin printf with octal escapes for better cross-shell portability.
        `typeset -gi ${commandSequenceName}=0\n` +
        `typeset -g ${commandNonceName}=\n` +
        `typeset -gi ${inCommandName}=0\n` +
        `typeset -gi ${dispatchActiveName}=0\n` +
        `typeset -gi ${dispatchCompletionReadyName}=0\n` +
        `typeset -g ${savedPromptEolName}=\n` +
        `typeset -gi ${savedExitName}=0\n` +
        `${preexecHookName}() { if [[ "\${1-}" == ${dispatcherName}\\ * ]]; then return 0; fi; (( ${commandSequenceName} += 1 )); ${inCommandName}=1; ${savedPromptEolName}=\${PROMPT_EOL_MARK-}; builtin printf -v ${commandNonceName} "%04x%04x%04x%04x%04x%04x%04x%04x" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"; PROMPT_EOL_MARK="$(builtin printf "\\\\033]1337;${commandMarkerPrefix}preend;seq=%s;nonce=%s\\\\007" "$${commandSequenceName}" "$${commandNonceName}")$${savedPromptEolName}"; builtin printf "\\\\033]1337;${commandMarkerPrefix}preexec;seq=%s;nonce=%s\\\\007" "$${commandSequenceName}" "$${commandNonceName}"; }\n` +
        // PROMPT_EOL_MARK is only rendered when zsh needs to repair a missing
        // trailing newline. Always close the command transcript in our first
        // precmd hook as well, before any user hook can print prompt content.
        `${precmdBeginHookName}() { local prior=$?; if [ "\${${dispatchCompletionReadyName}-0}" != 1 ]; then ${savedExitName}=$prior; fi; builtin printf "\\\\033]1337;${commandMarkerPrefix}preend;seq=%s;nonce=%s\\\\007" "$${commandSequenceName}" "$${commandNonceName}"; }\n` +
        `${precmdHookName}() { local ec=$${savedExitName} cwd_b64 home_b64; cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n"); home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n"); builtin printf "\\\\033]1337;${commandMarkerPrefix}precmd;seq=%s;nonce=%s;ec=%s;cwd_b64=%s;home_b64=%s\\\\007" "$${commandSequenceName}" "$${commandNonceName}" "$ec" "$cwd_b64" "$home_b64"; PROMPT_EOL_MARK=$${savedPromptEolName}; ${dispatchCompletionReadyName}=0; ${inCommandName}=0; ${dispatchActiveName}=0; return "$ec"; }\n` +
        `${buildUnixCommandDispatcherScript(runtimeToken!)}\n` +
        `add-zsh-hook preexec ${preexecHookName}\n` +
        `precmd_functions=(${precmdBeginHookName} \${precmd_functions:#${precmdBeginHookName}})\n` +
        `precmd_functions=(\${precmd_functions:#${precmdHookName}} ${precmdHookName})\n`
      fs.writeFileSync(rcPath, script, 'utf8')

      // -l: login shell, -i: interactive
      return {
        args: ['-l', '-i'],
        envOverrides: {
          ZDOTDIR: tmpDir,
          [userZdotDirEnv]: process.env.ZDOTDIR?.trim() || process.env.HOME || os.homedir(),
        },
        tmpPath: tmpDir,
      }
    }

    // bash integration via --rcfile (works on macOS bash 3.2)
    if (shellBase.includes('bash')) {
      const inCommandName = `${privateIdentifierPrefix}_in_command`
      const commandSequenceName = `${privateIdentifierPrefix}_command_seq`
      const commandNonceName = `${privateIdentifierPrefix}_command_nonce`
      const preexecHookName = `${privateIdentifierPrefix}_preexec`
      const precmdBeginHookName = `${privateIdentifierPrefix}_precmd_begin`
      const precmdHookName = `${privateIdentifierPrefix}_precmd`
      const savedExitName = `${privateIdentifierPrefix}_command_exit`
      const dispatchActiveName = `${privateIdentifierPrefix}_dispatch_active`
      const dispatchCompletionReadyName = `${privateIdentifierPrefix}_dispatch_completion_ready`
      const debugPriorName = `${privateIdentifierPrefix}_debug_prior`
      const dispatcherName = `${privateIdentifierPrefix}_dispatch`
      const completionName = `${dispatcherName}_complete`
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-bash-'))
      const rcPath = path.join(tmpDir, 'bashrc')
      // Improve based on VS Code reference logic
      const script = [
        '# gyshell integration (generated)',
        // Emulate login shell sourcing logic if we were in login mode,
        // but to keep it simple and consistent with existing proven logic:
        'if [ -f "/etc/profile" ]; then source "/etc/profile"; fi',
        'if [ -f "$HOME/.bash_profile" ]; then source "$HOME/.bash_profile"; ' +
          'elif [ -f "$HOME/.bash_login" ]; then source "$HOME/.bash_login"; ' +
          'elif [ -f "$HOME/.profile" ]; then source "$HOME/.profile"; fi',
        // Also source bashrc (many users put interactive settings here)
        'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc"; fi',
        packagedCliPathSnippet,
        '',
        `${inCommandName}=0`,
        `${commandSequenceName}=0`,
        `${commandNonceName}=`,
        `${savedExitName}=0`,
        `${dispatchActiveName}=0`,
        `${dispatchCompletionReadyName}=0`,
        `${preexecHookName}() {`,
        `  local ${debugPriorName}=$?`,
        `  if shopt -q extdebug; then builtin trap - DEBUG; return 0; fi`,
        `  if [ "\${${dispatchActiveName}-0}" = 1 ]; then`,
        `    return 0`,
        `  fi`,
        '  # DEBUG trap fires a lot; only emit once per user command.',
        '  # Avoid firing for PROMPT_COMMAND / our own helper.',
        '  case "$BASH_COMMAND" in',
        `    ${dispatcherName}*|${completionName}*|${precmdBeginHookName}*|${precmdHookName}*|${preexecHookName}* ) return "$${debugPriorName}" ;;`,
        '  esac',
        `  case "\${FUNCNAME[1]-}" in ${dispatcherName}|${completionName}) return "$${debugPriorName}" ;; esac`,
        `  if [ "$${inCommandName}" = "0" ]; then`,
        `    ${inCommandName}=1`,
        `    ${commandSequenceName}=$(($${commandSequenceName} + 1))`,
        `    printf -v ${commandNonceName} "%04x%04x%04x%04x%04x%04x%04x%04x" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"`,
        `    builtin printf "\\033]1337;${commandMarkerPrefix}preexec;seq=%s;nonce=%s\\007" "$${commandSequenceName}" "$${commandNonceName}"`,
        '  fi',
        `  return "$${debugPriorName}"`,
        '}',
        buildUnixCommandDispatcherScript(runtimeToken!),
        `if ! shopt -q extdebug; then trap '${preexecHookName}' DEBUG; fi`,
        '',
        `${precmdBeginHookName}() {`,
        `  local ${debugPriorName}=$?`,
        `  if [ "\${${dispatchCompletionReadyName}-0}" != 1 ]; then ${savedExitName}="$${debugPriorName}"; fi`,
        `  ${inCommandName}=1`,
        `  builtin printf "\\033]1337;${commandMarkerPrefix}preend;seq=%s;nonce=%s\\007" "$${commandSequenceName}" "$${commandNonceName}"`,
        '}',
        `${precmdHookName}() {`,
        `  local ec="$${savedExitName}"`,
        '  local cwd_b64 home_b64',
        '  cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n")',
        '  home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n")',
        `  builtin printf "\\033]1337;${commandMarkerPrefix}precmd;seq=%s;nonce=%s;ec=%s;cwd_b64=%s;home_b64=%s\\007" "$${commandSequenceName}" "$${commandNonceName}" "\${ec}" "\${cwd_b64}" "\${home_b64}"`,
        `  ${dispatchCompletionReadyName}=0`,
        `  ${inCommandName}=0`,
        `  ${dispatchActiveName}=0`,
        `  return "$ec"`,
        '}',
        // Freeze the user's exit status before existing prompt hooks, keep the
        // DEBUG trap guarded while they run, then publish our marker last.
        `if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then`,
        `  PROMPT_COMMAND=(${precmdBeginHookName} "\${PROMPT_COMMAND[@]}" ${precmdHookName})`,
        'else',
        `  PROMPT_COMMAND="${precmdBeginHookName}\${PROMPT_COMMAND:+; $PROMPT_COMMAND}; ${precmdHookName}"`,
        'fi',
        '',
      ].join('\n')
      fs.writeFileSync(rcPath, script, 'utf8')

      return {
        // NOTE: We intentionally do NOT use --login here; see comment above.
        args: ['--noprofile', '--rcfile', rcPath, '-i'],
        envOverrides: {},
        tmpPath: tmpDir,
      }
    }

    // cmd.exe integration via PROMPT env var
    // PowerShell integration via -Command
    if (shellBase.includes('powershell') || shellBase.includes('pwsh') || shellBase.includes('cmd.exe')) {
      const { commandTrackingMode, promptMarkerPath, commandRequestPath, commandOutputPath, tmpPath } =
        this.resolveWindowsShellTracking(shellBase)
      let launchPayload: string
      if (commandTrackingMode === 'windows-powershell-sidecar' && tmpPath) {
        const bootstrapPath = path.join(tmpPath, 'bootstrap.ps1')
        const bootstrapScript = buildWindowsPowerShellBootstrapScript({
          readySequence: buildPowerShellInitializationReadySequence(runtimeToken),
          commandTrackingMode,
          promptMarkerPath,
          commandRequestPath,
          commandOutputPath,
          commandProtocolToken: runtimeToken,
        })
        fs.writeFileSync(bootstrapPath, `\ufeff${bootstrapScript}`, 'utf8')
        launchPayload = buildWindowsPowerShellBootstrapLoaderEncodedCommand(
          bootstrapPath
        )
      } else {
        launchPayload = this.buildWindowsPowerShellEncodedCommand(
          commandTrackingMode,
          promptMarkerPath,
          commandRequestPath,
          commandOutputPath,
          runtimeToken
        )
      }
      const executionPolicyArgs =
        commandTrackingMode === 'windows-powershell-sidecar'
          ? ['-ExecutionPolicy', 'Bypass']
          : []
      // If it's cmd.exe, we'll force it to powershell via arguments
      const isCmd = shellBase.includes('cmd.exe')
      if (isCmd) {
        return {
          args: ['/K', 'powershell', '-NoLogo', '-NoProfile', '-NoExit', ...executionPolicyArgs, '-EncodedCommand', launchPayload],
          envOverrides: {},
          tmpPath,
          promptMarkerPath,
          commandRequestPath,
          commandOutputPath,
          commandTrackingMode,
        }
      }
      return {
        args: ['-NoLogo', '-NoProfile', '-NoExit', ...executionPolicyArgs, '-EncodedCommand', launchPayload],
        envOverrides: {},
        tmpPath,
        promptMarkerPath,
        commandRequestPath,
        commandOutputPath,
        commandTrackingMode,
      }
    }

    if (shellBase === 'fish') {
      return {
        args: ['-C', buildPackagedCliFishInitCommand(packagedCliDirectory)],
        envOverrides: {},
      }
    }

    if (shellBase === 'nu' || shellBase === 'nushell') {
      return {
        args: ['-e', buildPackagedCliNushellInitCommand(packagedCliDirectory)],
        envOverrides: {},
      }
    }

    if (['sh', 'dash', 'ksh', 'mksh'].includes(shellBase)) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-posix-shell-'))
      const envPath = path.join(tmpDir, 'env')
      const originalEnvName = 'GYSHELL_ORIGINAL_POSIX_ENV'
      fs.writeFileSync(
        envPath,
        `# gyshell integration (generated)\n` +
          `if [ -n "\${${originalEnvName}:-}" ] && [ -f "$${originalEnvName}" ]; then . "$${originalEnvName}"; fi\n` +
          `${packagedCliPathSnippet}\n` +
          `if [ -n "\${${originalEnvName}:-}" ]; then export ENV="$${originalEnvName}"; else unset ENV; fi\n` +
          `unset ${originalEnvName}\n`,
        'utf8'
      )
      return {
        args: [],
        envOverrides: {
          ENV: envPath,
          [originalEnvName]: process.env.ENV || '',
        },
        tmpPath: tmpDir,
      }
    }

    if (shellBase === 'csh' || shellBase === 'tcsh') {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-csh-'))
      const originalHomeName = 'GYSHELL_ORIGINAL_CSH_HOME'
      const userProfile = shellBase === 'tcsh' ? '.tcshrc' : '.cshrc'
      const sourceUserProfile =
        shellBase === 'tcsh'
          ? `if ( -f "$HOME/.tcshrc" ) then\n` +
            `  source "$HOME/.tcshrc"\n` +
            `else if ( -f "$HOME/.cshrc" ) then\n` +
            `  source "$HOME/.cshrc"\n` +
            `endif\n`
          : `if ( -f "$HOME/.cshrc" ) source "$HOME/.cshrc"\n`
      const script =
        `# gyshell integration (generated)\n` +
        `if ( $?${originalHomeName} ) then\n` +
        `  setenv HOME "$${originalHomeName}"\n` +
        `endif\n` +
        sourceUserProfile +
        `if ( $?${PACKAGED_CLI_DIRECTORY_ENV} ) then\n` +
        `  if ( $?path ) then\n` +
        `    set path = ( "$${PACKAGED_CLI_DIRECTORY_ENV}" $path )\n` +
        `  else\n` +
        `    set path = ( "$${PACKAGED_CLI_DIRECTORY_ENV}" )\n` +
        `  endif\n` +
        `endif\n` +
        `if ( $?${originalHomeName} ) unsetenv ${originalHomeName}\n`
      fs.writeFileSync(path.join(tmpDir, userProfile), script, 'utf8')
      return {
        args: [],
        envOverrides: {
          HOME: tmpDir,
          [originalHomeName]: process.env.HOME || os.homedir(),
        },
        tmpPath: tmpDir,
      }
    }

    if (process.env[PACKAGED_CLI_DIRECTORY_ENV]) {
      console.warn(`[NodePtyBackend] No post-profile PATH adapter for custom shell: ${shellPath}`)
    }
    // Truly unknown shells retain the verified parent PATH. Shell-specific
    // startup files may still replace it, so keep this fallback explicit.
    return { args: [], envOverrides: {} }
  }

  private resolveWindowsShellTracking(
    shellBase: string,
    release = os.release()
  ): {
    commandTrackingMode: WindowsCommandTrackingMode
    promptMarkerPath?: string
    commandRequestPath?: string
    commandOutputPath?: string
    tmpPath?: string
  } {
    const buildNumber = parseWindowsBuildNumber(release)
    const shellNameForTracking = shellBase.includes('cmd.exe') ? 'powershell.exe' : shellBase
    const useSidecar = shouldUseWindowsPowerShellSidecar({
      buildNumber,
      shell: shellNameForTracking,
      trackingChannelAvailable: true,
    })
    if (!useSidecar) {
      return { commandTrackingMode: 'shell-integration' }
    }
    this.cleanupStaleWindowsSidecarTempDirs()
    const tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), WINDOWS_POWERSHELL_LOCAL_SIDECAR_DIR_PREFIX))
    return {
      commandTrackingMode: 'windows-powershell-sidecar',
      tmpPath,
      promptMarkerPath: path.join(tmpPath, 'prompt-marker.log'),
      commandRequestPath: path.join(tmpPath, `${WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX}exec.b64`),
      commandOutputPath: path.join(tmpPath, `${WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX}exec.txt`),
    }
  }

  private buildWindowsPowerShellEncodedCommand(
    commandTrackingMode: WindowsCommandTrackingMode,
    promptMarkerPath?: string,
    commandRequestPath?: string,
    commandOutputPath?: string,
    commandProtocolToken?: string
  ): string {
    return buildWindowsPowerShellEncodedCommand({
      readySequence: buildPowerShellInitializationReadySequence(commandProtocolToken),
      commandTrackingMode,
      promptMarkerPath,
      commandRequestPath,
      commandOutputPath,
      commandProtocolToken,
    })
  }

  write(ptyId: string, data: string): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.pty.write(data)
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.pty.resize(cols, rows)
    }
  }

  kill(ptyId: string): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.pty.kill()
      this.ptys.delete(ptyId)
    }
    this.cwdByPtyId.delete(ptyId)
    this.homeDirByPtyId.delete(ptyId)
    this.cleanupTempArtifacts(ptyId)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.dataCallbacks.add(callback)
      if (instance.pendingData) {
        const pendingData = instance.pendingData
        instance.pendingData = ''
        callback(pendingData)
      }
    }
  }

  pauseOutput(ptyId: string): void {
    this.ptys.get(ptyId)?.pty.pause()
  }

  resumeOutput(ptyId: string): void {
    this.ptys.get(ptyId)?.pty.resume()
  }

  private emitPtyData(instance: PtyInstance, data: string): void {
    if (instance.dataCallbacks.size === 0) {
      instance.pendingData += data
      return
    }
    instance.dataCallbacks.forEach((callback) => callback(data))
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.exitCallbacks.add(callback)
    }
  }

  async readFile(_ptyId: string, filePath: string): Promise<Buffer> {
    return await fs.promises.readFile(filePath)
  }

  async downloadFileToLocalPath(
    _ptyId: string,
    sourcePath: string,
    targetLocalPath: string,
    options?: {
      onProgress?: (progress: { bytesTransferred: number; totalBytes: number; eof: boolean }) => void
      signal?: AbortSignal
    }
  ): Promise<{ totalBytes: number }> {
    const sourceStat = await fs.promises.stat(sourcePath)
    const totalBytes = Math.max(0, Number(sourceStat.size) || 0)
    await fs.promises.mkdir(path.dirname(targetLocalPath), { recursive: true })

    const readStream = fs.createReadStream(sourcePath, {
      highWaterMark: 512 * 1024,
    })
    const writeStream = fs.createWriteStream(targetLocalPath, { flags: 'w' })
    let bytesTransferred = 0
    readStream.on('data', (chunk: Buffer | string) => {
      const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      bytesTransferred += byteLength
      options?.onProgress?.({
        bytesTransferred,
        totalBytes,
        eof: bytesTransferred >= totalBytes,
      })
    })

    try {
      if (options?.signal) {
        await pipeline(readStream, writeStream, { signal: options.signal })
      } else {
        await pipeline(readStream, writeStream)
      }
    } catch (err) {
      // Clean up the partially-written target file on abort or any error so the
      // caller does not see a corrupt/incomplete file on disk.
      await fs.promises.unlink(targetLocalPath).catch(() => {})
      throw err
    }

    options?.onProgress?.({
      bytesTransferred: totalBytes,
      totalBytes,
      eof: true,
    })
    return { totalBytes }
  }

  async uploadFileFromLocalPath(
    _ptyId: string,
    sourceLocalPath: string,
    targetPath: string,
    options?: {
      onProgress?: (progress: { bytesTransferred: number; totalBytes: number; eof: boolean }) => void
      signal?: AbortSignal
    }
  ): Promise<{ totalBytes: number }> {
    const sourceStat = await fs.promises.stat(sourceLocalPath)
    const totalBytes = Math.max(0, Number(sourceStat.size) || 0)
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })

    const readStream = fs.createReadStream(sourceLocalPath, {
      highWaterMark: 512 * 1024,
    })
    const writeStream = fs.createWriteStream(targetPath, { flags: 'w' })
    let bytesTransferred = 0
    readStream.on('data', (chunk: Buffer | string) => {
      const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      bytesTransferred += byteLength
      options?.onProgress?.({
        bytesTransferred,
        totalBytes,
        eof: bytesTransferred >= totalBytes,
      })
    })

    try {
      if (options?.signal) {
        await pipeline(readStream, writeStream, { signal: options.signal })
      } else {
        await pipeline(readStream, writeStream)
      }
    } catch (err) {
      // Clean up the partially-written target file on abort or any error.
      await fs.promises.unlink(targetPath).catch(() => {})
      throw err
    }

    options?.onProgress?.({
      bytesTransferred: totalBytes,
      totalBytes,
      eof: true,
    })
    return { totalBytes }
  }

  async writeFile(_ptyId: string, filePath: string, content: string): Promise<void> {
    await this.writeFileBytes(_ptyId, filePath, Buffer.from(content, 'utf8'))
  }

  async readFileChunk(
    _ptyId: string,
    filePath: string,
    offset: number,
    chunkSize: number,
    options?: { totalSizeHint?: number }
  ): Promise<{
    chunk: Buffer
    bytesRead: number
    totalSize: number
    nextOffset: number
    eof: boolean
  }> {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const safeChunkSize = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : 256 * 1024
    const hintedTotalSize =
      Number.isFinite(options?.totalSizeHint) && (options?.totalSizeHint || 0) >= 0
        ? Math.floor(options!.totalSizeHint as number)
        : null

    const handle = await fs.promises.open(filePath, 'r')
    try {
      const totalSize =
        hintedTotalSize !== null ? hintedTotalSize : Math.max(0, Number((await handle.stat()).size) || 0)
      if (safeOffset >= totalSize) {
        return {
          chunk: Buffer.alloc(0),
          bytesRead: 0,
          totalSize,
          nextOffset: safeOffset,
          eof: true,
        }
      }

      const readableSize = Math.max(0, Math.min(safeChunkSize, totalSize - safeOffset))
      const buffer = Buffer.allocUnsafe(readableSize)
      const { bytesRead } = await handle.read(buffer, 0, readableSize, safeOffset)
      const chunk = bytesRead >= readableSize ? buffer : buffer.subarray(0, bytesRead)
      const nextOffset = safeOffset + bytesRead
      return {
        chunk,
        bytesRead,
        totalSize,
        nextOffset,
        eof: nextOffset >= totalSize,
      }
    } finally {
      await handle.close()
    }
  }

  async writeFileChunk(
    _ptyId: string,
    filePath: string,
    offset: number,
    content: Buffer,
    options?: { truncate?: boolean; close?: boolean }
  ): Promise<{ writtenBytes: number; nextOffset: number }> {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(content)

    // When truncating at offset 0 use the 'w' flag, which atomically creates-or-truncates
    // in a single syscall — avoiding the TOCTOU race of a separate truncate + open('r+').
    let handle: fs.promises.FileHandle
    if (options?.truncate && safeOffset === 0) {
      handle = await fs.promises.open(filePath, 'w')
    } else {
      try {
        handle = await fs.promises.open(filePath, 'r+')
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          throw error
        }
        handle = await fs.promises.open(filePath, 'w+')
      }
    }

    try {
      const { bytesWritten } = await handle.write(payload, 0, payload.length, safeOffset)
      return {
        writtenBytes: bytesWritten,
        nextOffset: safeOffset + bytesWritten,
      }
    } finally {
      await handle.close()
    }
  }

  getCwd(ptyId: string): string | undefined {
    return this.cwdByPtyId.get(ptyId)
  }

  async getHomeDir(ptyId: string): Promise<string | undefined> {
    return this.homeDirByPtyId.get(ptyId) || os.homedir()
  }

  applyCommandProtocolMetadata(
    ptyId: string,
    metadata: TerminalCommandProtocolMetadata
  ): void {
    if (metadata.cwd !== undefined) {
      const normalized = this.normalizeDecodedLocalPath(metadata.cwd)
      if (normalized) {
        this.cwdByPtyId.set(ptyId, normalized)
      }
    }
    if (metadata.homeDir !== undefined) {
      const normalized = this.normalizeDecodedLocalPath(metadata.homeDir)
      if (normalized) {
        this.homeDirByPtyId.set(ptyId, normalized)
      }
    }
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return os.platform() === 'win32' ? 'windows' : 'unix'
  }

  async getSystemInfo(_ptyId: string): Promise<any> {
    return {
      os: os.platform(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      isRemote: false,
      shell: this.getDefaultShell(),
    }
  }

  async statFile(_ptyId: string, filePath: string): Promise<FileStatInfo> {
    try {
      const stat = await fs.promises.stat(filePath)
      const isDirectory = stat.isDirectory()
      return {
        exists: true,
        isDirectory,
        size: isDirectory ? undefined : stat.size,
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { exists: false, isDirectory: false }
      }
      throw err
    }
  }

  async listDirectory(_ptyId: string, dirPath: string): Promise<FileSystemEntry[]> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const mapped = await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(dirPath, entry.name)
        let stats: fs.Stats | null = null
        try {
          stats = await fs.promises.lstat(absolutePath)
        } catch {
          stats = null
        }
        const isDirectory = stats ? stats.isDirectory() : entry.isDirectory()
        const isSymbolicLink = stats ? stats.isSymbolicLink() : entry.isSymbolicLink()
        return {
          name: entry.name,
          path: absolutePath,
          isDirectory,
          isSymbolicLink,
          size: stats ? stats.size : 0,
          mode: stats ? `0${(stats.mode & 0o777).toString(8)}` : undefined,
          modifiedAt: stats ? new Date(stats.mtimeMs).toISOString() : undefined,
        } satisfies FileSystemEntry
      })
    )

    return mapped.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    })
  }

  async createDirectory(_ptyId: string, dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath)
  }

  async createFile(_ptyId: string, filePath: string): Promise<void> {
    const handle = await fs.promises.open(filePath, 'wx')
    await handle.close()
  }

  async deletePath(_ptyId: string, targetPath: string, options?: { recursive?: boolean }): Promise<void> {
    const stats = await fs.promises.lstat(targetPath)
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (options?.recursive) {
        await fs.promises.rm(targetPath, { recursive: true, force: false })
        return
      }
      await fs.promises.rmdir(targetPath)
      return
    }
    await fs.promises.unlink(targetPath)
  }

  async renamePath(_ptyId: string, sourcePath: string, targetPath: string): Promise<void> {
    await fs.promises.rename(sourcePath, targetPath)
  }

  async writeFileBytes(_ptyId: string, filePath: string, content: Buffer): Promise<void> {
    await fs.promises.writeFile(filePath, content)
  }

  private normalizeDecodedLocalPath(decodedPath: string): string | null {
    if (typeof decodedPath !== 'string' || decodedPath.length === 0) {
      return null
    }
    const sanitized = decodedPath.replace(/[\u0000-\u001f\u007f]/g, '')
    if (!path.isAbsolute(sanitized)) {
      return null
    }
    return sanitized
  }
}
