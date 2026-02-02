import * as pty from 'node-pty'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { TerminalBackend, TerminalConfig, LocalConnectionConfig } from '../types'

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
    const candidates = [shell, this.getDefaultShell(), '/bin/zsh', '/bin/bash'].filter(
      (x): x is string => !!x
    )
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
    if (config.type !== 'local') {
      throw new Error('NodePtyBackend only supports local connections')
    }
    const localConfig = config as LocalConnectionConfig

    const shell = this.pickShell(localConfig.shell)
    const cwdCandidate = localConfig.cwd || os.homedir()
    const cwd = fs.existsSync(cwdCandidate) ? cwdCandidate : os.homedir()
    const env = this.getSafeEnv()

    const { args, envOverrides, tmpPath } = this.buildShellIntegration(shell)
    const mergedEnv = { ...env, ...envOverrides }

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: config.cols || 80,
      rows: config.rows || 24,
      cwd,
      env: mergedEnv,
      useConpty: os.platform() === 'win32'
    })

    const isWindows = os.platform() === 'win32'
    const instance: PtyInstance = {
      pty: ptyProcess,
      dataCallbacks: new Set(),
      exitCallbacks: new Set(),
      oscBuffer: '',
      isInitializing: isWindows,
      buffer: ''
    }

    ptyProcess.onData((data) => {
      const chunk = data.toString()
      if (instance.isInitializing) {
        instance.buffer += chunk
        if (instance.buffer!.includes('__GYSHELL_READY__')) {
          instance.isInitializing = false
          const parts = instance.buffer!.split('__GYSHELL_READY__')
          if (parts.length > 1) {
            const realContent = parts.slice(1).join('__GYSHELL_READY__').trimStart()
            if (realContent) {
              this.consumeOscMarkers(config.id, realContent)
              instance.dataCallbacks.forEach((callback) => callback(realContent))
            }
          }
          instance.buffer = ''
        }
      } else {
        this.consumeOscMarkers(config.id, chunk)
      instance.dataCallbacks.forEach((callback) => callback(data))
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      instance.exitCallbacks.forEach((callback) => callback(exitCode))
      this.ptys.delete(config.id)
      this.cwdByPtyId.delete(config.id)
      this.homeDirByPtyId.delete(config.id)
      const tmp = this.tmpPathsByPtyId.get(config.id)
      if (tmp) {
        this.tmpPathsByPtyId.delete(config.id)
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    })

    this.ptys.set(config.id, instance)
    if (tmpPath) this.tmpPathsByPtyId.set(config.id, tmpPath)
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
  } {
    const shellBase = path.basename(shellPath).toLowerCase()

    // zsh integration via ZDOTDIR/.zshrc (no visible setup commands)
    if (shellBase.includes('zsh')) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-zsh-'))
      // Login shell reads: .zshenv -> .zprofile -> .zshrc -> .zlogin (all under ZDOTDIR)
      // We proxy to user's originals to preserve environment and behaviors.
      fs.writeFileSync(
        path.join(tmpDir, '.zshenv'),
        `# gyshell integration (generated)\n` +
          `if [ -f "$HOME/.zshenv" ]; then source "$HOME/.zshenv"; fi\n`,
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmpDir, '.zprofile'),
        `# gyshell integration (generated)\n` +
          `if [ -f "$HOME/.zprofile" ]; then source "$HOME/.zprofile"; fi\n`,
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmpDir, '.zlogin'),
        `# gyshell integration (generated)\n` +
          `if [ -f "$HOME/.zlogin" ]; then source "$HOME/.zlogin"; fi\n`,
        'utf8'
      )

      const rcPath = path.join(tmpDir, '.zshrc')
      const script =
        `# gyshell integration (generated)\n` +
        `if [ -f "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi\n` +
        `autoload -Uz add-zsh-hook 2>/dev/null || true\n` +
        // Use explicit hex escapes for portability across shells
        // Fix: Use %s for exit code inside the string to avoid printf consuming it as a separate arg
        `gyshell_preexec() { printf '%b' '\\\\x1b]1337;gyshell_preexec\\\\x07'; }\n` +
        `gyshell_precmd() { local ec=$?; printf '%b' "\\\\x1b]1337;gyshell_precmd;ec=\${ec};cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n")\\\\x07"; }\n` +
        `add-zsh-hook preexec gyshell_preexec\n` +
        `add-zsh-hook precmd gyshell_precmd\n`
      fs.writeFileSync(rcPath, script, 'utf8')

      // -l: login shell, -i: interactive
      return { args: ['-l', '-i'], envOverrides: { ZDOTDIR: tmpDir }, tmpPath: tmpDir }
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
        '    printf "%b" "\\x1b]1337;gyshell_preexec\\x07"',
        '  fi',
        '}',
        "trap '__gyshell_preexec' DEBUG",
        '',
        '__gyshell_precmd() {',
        '  local ec=$?',
        '  __gyshell_in_command=0',
        '  printf "%b" "\\x1b]1337;gyshell_precmd;ec=${ec};cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n")\\x07"',
        '}',
        // Preserve existing PROMPT_COMMAND if set
        'PROMPT_COMMAND="__gyshell_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
        ''
      ].join('\n')
      fs.writeFileSync(rcPath, script, 'utf8')

      return {
        // NOTE: We intentionally do NOT use --login here; see comment above.
        args: ['--noprofile', '--rcfile', rcPath, '-i'],
        envOverrides: {},
        tmpPath: tmpDir
      }
    }

    // cmd.exe integration via PROMPT env var
    // PowerShell integration via -Command
    if (shellBase.includes('powershell') || shellBase.includes('pwsh') || shellBase.includes('cmd.exe')) {
      const b64 = this.buildWindowsPowerShellEncodedCommand()
      // If it's cmd.exe, we'll force it to powershell via arguments
      const isCmd = shellBase.includes('cmd.exe')
      if (isCmd) {
        return {
          args: ['/K', 'powershell', '-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', b64],
          envOverrides: {}
        }
      }
      return { args: ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', b64], envOverrides: {} }
    }

    // Unknown shell: no integration (fallback behavior handled in TerminalService).
    return { args: [], envOverrides: {} }
  }

  private buildWindowsPowerShellEncodedCommand(): string {
    const psInit = `
function Global:prompt {
  $ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { if ($?) { 0 } else { 1 } }
  $cwd_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path))
  $home_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME))
  Write-Host -NoNewline "$([char]27)]1337;gyshell_precmd;ec=$ec;cwd_b64=$cwd_b64;home_b64=$home_b64$([char]7)"
  return "PS $($PWD.Path)> "
}
Clear-Host
Write-Output "__GYSHELL_READY__"
`
    // PowerShell -EncodedCommand requires UTF-16LE.
    return Buffer.from(psInit, 'utf16le').toString('base64')
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

  async writeFile(_ptyId: string, filePath: string, content: string): Promise<void> {
    await fs.promises.writeFile(filePath, content, 'utf8')
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
      shell: this.getDefaultShell()
    }
  }

  async statFile(_ptyId: string, filePath: string): Promise<{ exists: boolean; isDirectory: boolean }> {
    try {
      const stat = await fs.promises.stat(filePath)
      return { exists: true, isDirectory: stat.isDirectory() }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { exists: false, isDirectory: false }
      }
      throw err
    }
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
          if (decoded) this.cwdByPtyId.set(ptyId, decoded)
        } catch {
          // ignore decode errors
        }
      }

      const homeMatch = marker.match(/home_b64=([^;]+)/)
      if (homeMatch && homeMatch[1]) {
        try {
          const decoded = Buffer.from(homeMatch[1], 'base64').toString('utf8')
          if (decoded) this.homeDirByPtyId.set(ptyId, decoded)
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
}
