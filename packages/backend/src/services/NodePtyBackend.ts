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
import { pipeline } from 'node:stream/promises'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import {
  isLocalConnectionConfig,
  type TerminalCommandTrackingToken,
  type TerminalCommandTrackingUpdate,
  type TerminalBackend,
  type TerminalConfig,
  type TerminalExecOptions,
  type FileSystemEntry,
  type FileStatInfo,
} from '../types'
import {
  buildWindowsPowerShellEncodedCommand,
  parseWindowsBuildNumber,
  parseWindowsPromptMarkerLine,
  shouldUseWindowsPowerShellSidecar,
  WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX,
  WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX,
  WINDOWS_POWERSHELL_LOCAL_SIDECAR_DIR_PREFIX,
  WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS,
  type WindowsCommandTrackingMode,
  type WindowsPromptMarkerState,
} from './windowsPowerShellTracking'

const execFileAsync = promisify(execFile)

const GYSHELL_READY_MARKER = '__GYSHELL_READY__'

interface PtyInstance {
  pty: pty.IPty
  dataCallbacks: Set<(data: string) => void>
  exitCallbacks: Set<(code: number) => void>
  oscBuffer: string
  isInitializing?: boolean
  buffer?: string
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
    if (this.commandTrackingModeByPtyId.get(ptyId) !== 'windows-powershell-sidecar') {
      return undefined
    }
    const cachedSnapshot = this.promptMarkerStateByPtyId.get(ptyId) || null
    const snapshot = await this.refreshPromptMarkerState(ptyId, {
      allowCachedFallback: false,
    })
    if (!snapshot && !cachedSnapshot) {
      const resetOk = await this.resetPromptMarkerFile(ptyId)
      return {
        mode: 'windows-powershell-sidecar',
        baselineSequence: 0,
        awaitingInitialFreshMarker: !resetOk,
        dispatchMode: this.commandRequestPathByPtyId.get(ptyId) ? 'prompt-file' : undefined,
        displayMode: this.commandRequestPathByPtyId.get(ptyId) ? 'synthetic-transcript' : undefined,
        commandRequestPath: this.commandRequestPathByPtyId.get(ptyId),
        commandOutputPath: this.commandOutputPathByPtyId.get(ptyId),
      }
    }
    const resolvedSnapshot = snapshot || cachedSnapshot
    if (!resolvedSnapshot) {
      return undefined
    }
    return {
      mode: 'windows-powershell-sidecar',
      baselineSequence: resolvedSnapshot.sequence,
      awaitingInitialFreshMarker: !snapshot && !!cachedSnapshot,
      dispatchMode: this.commandRequestPathByPtyId.get(ptyId) ? 'prompt-file' : undefined,
      displayMode: this.commandRequestPathByPtyId.get(ptyId) ? 'synthetic-transcript' : undefined,
      commandRequestPath: this.commandRequestPathByPtyId.get(ptyId),
      commandOutputPath: this.commandOutputPathByPtyId.get(ptyId),
    }
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
    const snapshot = await this.refreshPromptMarkerState(ptyId, {
      allowCachedFallback: !token.awaitingInitialFreshMarker,
    })
    if (!snapshot || snapshot.sequence <= token.baselineSequence) {
      return undefined
    }
    if (token.awaitingInitialFreshMarker) {
      const dispatchedAtMs = token.dispatchedAtMs || 0
      if (snapshot.modifiedAtMs !== undefined && snapshot.modifiedAtMs <= dispatchedAtMs) {
        token.baselineSequence = snapshot.sequence
        return undefined
      }
      token.awaitingInitialFreshMarker = false
    }
    const output = await this.readCommandOutputFile(token.commandOutputPath || this.commandOutputPathByPtyId.get(ptyId))
    return {
      mode: 'windows-powershell-sidecar',
      sequence: snapshot.sequence,
      exitCode: snapshot.exitCode,
      cwd: snapshot.cwd,
      homeDir: snapshot.homeDir,
      output,
    }
  }

  async refreshSessionState(ptyId: string): Promise<void> {
    if (this.commandTrackingModeByPtyId.get(ptyId) !== 'windows-powershell-sidecar') {
      return
    }
    await this.refreshPromptMarkerState(ptyId)
  }

  private stripReadyMarker(chunk: string): string {
    if (!chunk.includes(GYSHELL_READY_MARKER)) return chunk
    return chunk.replace(/__GYSHELL_READY__/g, '')
  }

  private cleanupTempArtifacts(ptyId: string): void {
    this.commandTrackingModeByPtyId.delete(ptyId)
    this.promptMarkerPathByPtyId.delete(ptyId)
    this.commandRequestPathByPtyId.delete(ptyId)
    this.commandOutputPathByPtyId.delete(ptyId)
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
    options?: { allowCachedFallback?: boolean }
  ): Promise<WindowsPromptMarkerState | null> {
    const markerPath = this.promptMarkerPathByPtyId.get(ptyId)
    if (!markerPath) {
      return this.promptMarkerStateByPtyId.get(ptyId) || null
    }
    try {
      const stats = await fs.promises.stat(markerPath)
      const raw = await fs.promises.readFile(markerPath, 'utf8')
      const lines = raw.split(/\r?\n/)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = parseWindowsPromptMarkerLine(lines[index] || '')
        if (!parsed) {
          continue
        }
        const next: WindowsPromptMarkerState = {
          sequence: parsed.sequence,
          exitCode: parsed.exitCode,
          cwd: parsed.cwd ? this.normalizeDecodedLocalPath(parsed.cwd) || undefined : undefined,
          homeDir: parsed.homeDir ? this.normalizeDecodedLocalPath(parsed.homeDir) || undefined : undefined,
          modifiedAtMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : undefined,
        }
        this.promptMarkerStateByPtyId.set(ptyId, next)
        if (next.cwd) {
          this.cwdByPtyId.set(ptyId, next.cwd)
        }
        if (next.homeDir) {
          this.homeDirByPtyId.set(ptyId, next.homeDir)
        }
        return next
      }
    } catch (error: any) {
      if (!(error?.code === 'ENOENT')) {
        // ignore transient best-effort read failures
      }
    }
    if (options?.allowCachedFallback === false) {
      return null
    }
    return this.promptMarkerStateByPtyId.get(ptyId) || null
  }

  private async resetPromptMarkerFile(ptyId: string): Promise<boolean> {
    const markerPath = this.promptMarkerPathByPtyId.get(ptyId)
    if (!markerPath) {
      return false
    }
    try {
      await fs.promises.mkdir(path.dirname(markerPath), { recursive: true })
      await fs.promises.writeFile(markerPath, '', 'utf8')
      return true
    } catch {
      return false
    }
  }

  private async readCommandOutputFile(filePath?: string): Promise<string | undefined> {
    if (!filePath) {
      return undefined
    }
    try {
      const text = await fs.promises.readFile(filePath, 'utf8')
      return text.replace(/^\ufeff/, '')
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return undefined
      }
      return undefined
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
    const cwdCandidate = localConfig.cwd || os.homedir()
    const cwd = fs.existsSync(cwdCandidate) ? cwdCandidate : os.homedir()
    const env = this.getSafeEnv()

    // Fix for Chinese characters rendering issues in packaged apps
    // Setting LC_ALL and LANG to UTF-8 ensures the shell and sub-processes use UTF-8 encoding
    const localeEnv = {
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    }

    const {
      args,
      envOverrides,
      tmpPath,
      commandTrackingMode,
      promptMarkerPath,
      commandRequestPath,
      commandOutputPath,
    } = this.buildShellIntegration(shell)
    const mergedEnv = { ...env, ...localeEnv, ...envOverrides }

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: config.cols || 80,
      rows: config.rows || 24,
      cwd,
      env: mergedEnv,
      useConpty: os.platform() === 'win32',
    })

    const isWindows = os.platform() === 'win32'
    const instance: PtyInstance = {
      pty: ptyProcess,
      dataCallbacks: new Set(),
      exitCallbacks: new Set(),
      oscBuffer: '',
      isInitializing: isWindows,
      buffer: '',
    }

    ptyProcess.onData((data) => {
      const chunk = data.toString()
      if (instance.isInitializing) {
        instance.buffer += chunk
        if (instance.buffer!.includes(GYSHELL_READY_MARKER)) {
          instance.isInitializing = false
          const parts = instance.buffer!.split(GYSHELL_READY_MARKER)
          if (parts.length > 1) {
            const realContent = this.stripReadyMarker(parts.slice(1).join(GYSHELL_READY_MARKER)).trimStart()
            if (realContent) {
              this.consumeOscMarkers(config.id, realContent)
              instance.dataCallbacks.forEach((callback) => callback(realContent))
            }
          }
          instance.buffer = ''
        }
      } else {
        const sanitizedChunk = this.stripReadyMarker(chunk)
        this.consumeOscMarkers(config.id, sanitizedChunk)
        if (sanitizedChunk) {
          instance.dataCallbacks.forEach((callback) => callback(sanitizedChunk))
        }
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      instance.exitCallbacks.forEach((callback) => callback(exitCode))
      this.ptys.delete(config.id)
      this.cwdByPtyId.delete(config.id)
      this.homeDirByPtyId.delete(config.id)
      this.cleanupTempArtifacts(config.id)
    })

    this.ptys.set(config.id, instance)
    if (tmpPath) this.tmpPathsByPtyId.set(config.id, tmpPath)
    if (commandTrackingMode) this.commandTrackingModeByPtyId.set(config.id, commandTrackingMode)
    if (promptMarkerPath) this.promptMarkerPathByPtyId.set(config.id, promptMarkerPath)
    if (commandRequestPath) this.commandRequestPathByPtyId.set(config.id, commandRequestPath)
    if (commandOutputPath) this.commandOutputPathByPtyId.set(config.id, commandOutputPath)
    return config.id
  }

  /**
   * Inject "invisible" command boundary markers via shell integration hooks.
   * This avoids printing any wrapper/marker commands in the terminal.
   *
   * Markers (OSC) are emitted on:
   * - bash: DEBUG trap (preexec-ish) and PROMPT_COMMAND (precmd-ish)
   * - zsh: preexec + precmd hooks
   */
  private buildShellIntegration(shellPath: string): {
    args: string[]
    envOverrides: Record<string, string>
    tmpPath?: string
    commandTrackingMode?: WindowsCommandTrackingMode
    promptMarkerPath?: string
    commandRequestPath?: string
    commandOutputPath?: string
  } {
    const shellBase = path.basename(shellPath).toLowerCase()
    const packagedCliDirectory = process.env[PACKAGED_CLI_DIRECTORY_ENV]
    const packagedCliPathSnippet = buildPackagedCliPathShellSnippet(packagedCliDirectory)

    // zsh integration via ZDOTDIR/.zshrc (no visible setup commands)
    if (shellBase.includes('zsh')) {
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
        `gyshell_preexec() { builtin printf "\\\\033]1337;gyshell_preexec\\\\007"; }\n` +
        `gyshell_precmd() { local ec=$? cwd_b64; cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n"); builtin printf "\\\\033]1337;gyshell_precmd;ec=%s;cwd_b64=%s\\\\007" "$ec" "$cwd_b64"; }\n` +
        `add-zsh-hook preexec gyshell_preexec\n` +
        `add-zsh-hook precmd gyshell_precmd\n`
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
        '__gyshell_in_command=0',
        '__gyshell_preexec() {',
        '  # DEBUG trap fires a lot; only emit once per user command.',
        '  # Avoid firing for PROMPT_COMMAND / our own helper.',
        '  case "$BASH_COMMAND" in',
        '    __gyshell_precmd*|__gyshell_preexec* ) return ;;',
        '  esac',
        '  if [ "$__gyshell_in_command" = "0" ]; then',
        '    __gyshell_in_command=1',
        '    builtin printf "\\033]1337;gyshell_preexec\\007"',
        '  fi',
        '}',
        "trap '__gyshell_preexec' DEBUG",
        '',
        '__gyshell_precmd() {',
        '  local ec=$?',
        '  local cwd_b64',
        '  __gyshell_in_command=0',
        '  cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n")',
        '  builtin printf "\\033]1337;gyshell_precmd;ec=%s;cwd_b64=%s\\007" "${ec}" "${cwd_b64}"',
        '}',
        // Preserve existing PROMPT_COMMAND if set
        'PROMPT_COMMAND="__gyshell_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
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
      const b64 = this.buildWindowsPowerShellEncodedCommand(
        commandTrackingMode,
        promptMarkerPath,
        commandRequestPath,
        commandOutputPath
      )
      // If it's cmd.exe, we'll force it to powershell via arguments
      const isCmd = shellBase.includes('cmd.exe')
      if (isCmd) {
        return {
          args: ['/K', 'powershell', '-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', b64],
          envOverrides: {},
          tmpPath,
          promptMarkerPath,
          commandRequestPath,
          commandOutputPath,
          commandTrackingMode,
        }
      }
      return {
        args: ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', b64],
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
    commandOutputPath?: string
  ): string {
    return buildWindowsPowerShellEncodedCommand({
      readyMarker: GYSHELL_READY_MARKER,
      commandTrackingMode,
      promptMarkerPath,
      commandRequestPath,
      commandOutputPath,
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
    }
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

  private consumeOscMarkers(ptyId: string, chunk: string): void {
    const instance = this.ptys.get(ptyId)
    if (!instance) return
    instance.oscBuffer += chunk

    const prefix = '\x1b]1337;gyshell_precmd'
    const suffix = '\x07'

    while (true) {
      const start = instance.oscBuffer.indexOf(prefix)
      if (start === -1) break
      const end = instance.oscBuffer.indexOf(suffix, start)
      if (end === -1) break

      const marker = instance.oscBuffer.slice(start, end)
      const cwdMatch = marker.match(/cwd_b64=([^;]+)/)
      if (cwdMatch && cwdMatch[1]) {
        try {
          const decoded = Buffer.from(cwdMatch[1], 'base64').toString('utf8')
          const normalized = this.normalizeDecodedLocalPath(decoded)
          if (normalized) {
            this.cwdByPtyId.set(ptyId, normalized)
          }
        } catch {
          // ignore decode errors
        }
      }

      const homeMatch = marker.match(/home_b64=([^;]+)/)
      if (homeMatch && homeMatch[1]) {
        try {
          const decoded = Buffer.from(homeMatch[1], 'base64').toString('utf8')
          const normalized = this.normalizeDecodedLocalPath(decoded)
          if (normalized) {
            this.homeDirByPtyId.set(ptyId, normalized)
          }
        } catch {
          // ignore decode errors
        }
      }

      instance.oscBuffer = instance.oscBuffer.slice(end + suffix.length)
    }

    if (instance.oscBuffer.length > 8192) {
      instance.oscBuffer = instance.oscBuffer.slice(-4096)
    }
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
