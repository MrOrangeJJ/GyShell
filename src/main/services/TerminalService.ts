import pkg from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
const { Terminal } = pkg
import path from 'path'
import os from 'os'
import type { TerminalBackend, TerminalConfig, TerminalTab, CommandResult, ConnectionType, FileStatInfo, CommandTask } from '../types'
import { NodePtyBackend } from './NodePtyBackend'
import { SSHBackend } from './SSHBackend'
import { escapeShellPathList } from './ShellUtility'
import { v4 as uuidv4 } from 'uuid'

const MAX_BUFFER_SIZE = 100000 // 100KB
const SCROLLBACK_SIZE = 5000 // Keep up to 5000 lines in virtual terminal
// We do NOT print any wrapper/marker commands in the terminal.
// Instead, we rely on shell integration hooks (installed at shell startup by NodePtyBackend)
// that emit invisible OSC markers on command boundaries.
const OSC_PRECMD_PREFIX = '\x1b]1337;gyshell_precmd'
const OSC_SUFFIX = '\x07'

function stripGyShellOscMarkers(s: string): string {
  return s.replace(/\x1b]1337;gyshell_(?:preexec|precmd)[^\x07]*\x07/g, '')
}

interface RingBuffer {
  content: string
  offset: number
}

export class TerminalService {
  private backends: Map<ConnectionType, TerminalBackend> = new Map()
  private terminals: Map<string, TerminalTab> = new Map()
  private buffers: Map<string, RingBuffer> = new Map()
  private headlessPtys: Map<string, TerminalType> = new Map()
  private selectionByTerminal: Map<string, string> = new Map()
  private tasksByTerminal: Map<string, Record<string, CommandTask>> = new Map()
  private activeTaskByTerminal: Map<string, string> = new Map()
  private oscParseBufByTerminal: Map<string, string> = new Map()
  private onTaskFinishedCallbacks: Map<string, (result: CommandResult) => void> = new Map()
  private hasPrintedBanner = false

  constructor() {
    this.backends.set('local', new NodePtyBackend())
    this.backends.set('ssh', new SSHBackend())
  }

  private getBackend(type: ConnectionType): TerminalBackend {
    const backend = this.backends.get(type)
    if (!backend) {
      throw new Error(`No backend found for connection type: ${type}`)
    }
    return backend
  }

  private async printBanner(terminalId: string): Promise<void> {
    if (this.hasPrintedBanner) return
    this.hasPrintedBanner = true

    // ANSI Shadow font for "GyShell"
    // Using \x1b[36m for Cyan color
    const banner = `\r\n\x1b[36m  ____         ____  _          _ _ \r\n / ___|_   _  / ___|| |__   ___| | |\r\n| |  _| | | | \\___ \\| '_ \\ / _ \\ | |\r\n| |_| | |_| |  ___) | | | |  __/ | |\r\n \\____|\\__, | |____/|_| |_|\\___|_|_|\r\n       |___/                        \x1b[0m\r\n`

    // Small delay to ensure shell is ready
    setTimeout(() => {
      // Use handleData to inject the banner directly into the UI and headless terminal
      // without sending it as a command to the underlying PTY process.
      this.handleData(terminalId, banner)
    }, 500)
  }

  async createTerminal(config: TerminalConfig): Promise<TerminalTab> {
    // Idempotent: renderer may call createTab more than once (dev reload / re-mount).
    const existing = this.terminals.get(config.id)
    if (existing) {
      // Keep size updated
      existing.cols = config.cols
      existing.rows = config.rows
      // Keep title updated (required)
      existing.title = config.title
      
      const headless = this.headlessPtys.get(config.id)
      if (headless) {
        headless.resize(config.cols, config.rows)
      }
      
      return existing
    }

    const backend = this.getBackend(config.type)
    const ptyId = await backend.spawn(config)

    const tab: TerminalTab = {
      id: config.id,
      ptyId,
      title: config.title,
      cols: config.cols,
      rows: config.rows,
      type: config.type,
      isInitializing: config.type === 'ssh' || (config.type === 'local' && os.platform() === 'win32') // Enable silence mode for SSH and local Windows
    }

    // Initialize Headless Terminal for AI context
    const headless = new Terminal({
      cols: config.cols,
      rows: config.rows,
      scrollback: SCROLLBACK_SIZE,
      allowProposedApi: true
    })

    this.terminals.set(config.id, tab)
    this.buffers.set(config.id, { content: '', offset: 0 })
    this.headlessPtys.set(config.id, headless)

    // Setup data handler
    backend.onData(ptyId, (data: string) => {
      this.handleData(config.id, data)
    })

    // Setup exit handler
    backend.onExit(ptyId, (code: number) => {
      this.handleExit(config.id, code)
    })

    // Print banner for the first local terminal
    if (config.type === 'local') {
      this.printBanner(config.id)
    }

    return tab
  }

  private handleData(terminalId: string, data: string): void {
    const tab = this.terminals.get(terminalId)
    if (tab) {
      // Sync initialization state and remote OS
      if (tab.isInitializing) {
        // If we received data, it means backend's silence mode passed
        tab.isInitializing = false
      }

      if (tab.type === 'ssh') {
        const backend = this.getBackend('ssh') as SSHBackend
        if (!tab.remoteOs) {
          tab.remoteOs = backend.getRemoteOs(tab.ptyId)
        }
        if (!tab.systemInfo) {
          backend.getSystemInfo(tab.ptyId).then(info => {
            if (info) tab.systemInfo = info
          })
        }
      } else if (tab.type === 'local' && !tab.remoteOs) {
        const backend = this.getBackend('local')
        tab.remoteOs = backend.getRemoteOs(tab.ptyId)
        if (!tab.systemInfo) {
          backend.getSystemInfo(tab.ptyId).then(info => {
            if (info) tab.systemInfo = info
          })
        }
      }
    }

    // Write to headless terminal for rendering/normalization
    const headless = this.headlessPtys.get(terminalId)
    if (headless) {
      headless.write(data)
    }

    // Process OSC markers and strip markers from visual output
    const cleanedData = this.processIncomingData(terminalId, data)

    // Update ring buffer
    const buffer = this.buffers.get(terminalId)
    if (buffer) {
      buffer.content += cleanedData
      buffer.offset += cleanedData.length

      // Trim if exceeds max size
      if (buffer.content.length > MAX_BUFFER_SIZE) {
        const trimAmount = buffer.content.length - MAX_BUFFER_SIZE
        buffer.content = buffer.content.slice(trimAmount)
      }
    }

    // Send data to renderer
    if (cleanedData) {
      this.sendToRenderer('terminal:data', { terminalId, data: cleanedData })
    }
  }

  private processIncomingData(terminalId: string, rawChunk: string): string {
    let buf = this.oscParseBufByTerminal.get(terminalId) || ''
    buf += rawChunk

    let cleanedData = ''

    while (buf.length > 0) {
      const precmdIdx = buf.indexOf(OSC_PRECMD_PREFIX)
      if (precmdIdx === -1) {
        const cleaned = stripGyShellOscMarkers(buf)
        cleanedData += cleaned
        this.appendActiveTaskOutput(terminalId, cleaned)
        buf = ''
        break
      }

      const before = buf.slice(0, precmdIdx)
      const cleanedBefore = stripGyShellOscMarkers(before)
      cleanedData += cleanedBefore
      this.appendActiveTaskOutput(terminalId, cleanedBefore)

      const suffixIdx = buf.indexOf(OSC_SUFFIX, precmdIdx)
      if (suffixIdx === -1) {
        // Wait for the rest of the marker in the next chunk
        break
      }

      const markerContent = buf.slice(precmdIdx, suffixIdx)
      const ecMatch = markerContent.match(/ec=(\d+)/)
      const exitCode = ecMatch ? parseInt(ecMatch[1], 10) : undefined
      
      // Give headless xterm a tiny bit of time to finish rendering the last chunk
      // before we finalize the task and extract its output.
      setTimeout(() => {
        this.finishActiveTask(terminalId, exitCode)
      }, 50)

      buf = buf.slice(suffixIdx + OSC_SUFFIX.length)
    }

    this.oscParseBufByTerminal.set(terminalId, buf)
    return cleanedData
  }

  private handleExit(terminalId: string, code: number): void {
    const tab = this.terminals.get(terminalId)
    
    // Mark active task as aborted if terminal exits unexpectedly
    const activeTaskId = this.activeTaskByTerminal.get(terminalId)
    if (activeTaskId) {
      const task = this.getTaskMap(terminalId)[activeTaskId]
      if (task && task.status === 'running') {
        task.status = 'aborted'
        task.endTime = Date.now()
        task.exitCode = typeof code === 'number' ? code : -1
      }
      this.activeTaskByTerminal.delete(terminalId)
      this.onTaskFinishedCallbacks.delete(activeTaskId)
    }

    // If terminal was still initializing, we do NOT delete it from the map.
    // This allows the error message to remain visible in the UI.
    // We only delete if it was a normally running terminal.
    if (tab && !tab.isInitializing) {
      this.terminals.delete(terminalId)
      this.buffers.delete(terminalId)
      this.selectionByTerminal.delete(terminalId)
      this.oscParseBufByTerminal.delete(terminalId)
      this.tasksByTerminal.delete(terminalId)
      this.activeTaskByTerminal.delete(terminalId)
      
      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.dispose()
        this.headlessPtys.delete(terminalId)
      }
    }
    
    this.sendToRenderer('terminal:exit', { terminalId, code })
  }

  write(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      const backend = this.getBackend(terminal.type)
      backend.write(terminal.ptyId, data)
    }
  }

  writePaths(terminalId: string, paths: string[]): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal || paths.length === 0) return
    const backend = this.getBackend(terminal.type)
    const text = escapeShellPathList(paths)
    if (!text) return
    backend.write(terminal.ptyId, text)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      terminal.cols = cols
      terminal.rows = rows
      const backend = this.getBackend(terminal.type)
      backend.resize(terminal.ptyId, cols, rows)
      
      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.resize(cols, rows)
      }
    }
  }

  kill(terminalId: string): void {
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      const backend = this.getBackend(terminal.type)
      backend.kill(terminal.ptyId)
      
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
      this.tasksByTerminal.delete(terminalId)
      this.activeTaskByTerminal.delete(terminalId)
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

  async readFile(terminalId: string, filePath: string): Promise<Buffer> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getBackend(terminal.type)
    return backend.readFile(terminal.ptyId, resolvedPath)
  }

  async writeFile(terminalId: string, filePath: string, content: string): Promise<void> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getBackend(terminal.type)
    return backend.writeFile(terminal.ptyId, resolvedPath, content)
  }

  async statFile(terminalId: string, filePath: string): Promise<FileStatInfo> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getBackend(terminal.type)
    return backend.statFile(terminal.ptyId, resolvedPath)
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

  getBufferDelta(terminalId: string, fromOffset: number): string {
    const buffer = this.buffers.get(terminalId)
    if (!buffer) return ''

    const startIdx = Math.max(0, fromOffset - (buffer.offset - buffer.content.length))
    return buffer.content.slice(startIdx)
  }

  getCurrentOffset(terminalId: string): number {
    const buffer = this.buffers.get(terminalId)
    return buffer?.offset || 0
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

  // dynGetRecentOutput is no longer needed as getRecentOutput handles it

  getAllTerminals(): TerminalTab[] {
    return Array.from(this.terminals.values()).filter(t => !t.isInitializing)
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

  async runCommandNoWait(terminalId: string, command: string, onFinished?: (result: CommandResult) => void): Promise<string> {
    const taskId = await this.executeCommandInternal(terminalId, command, 'nowait', onFinished)
    return taskId
  }

  async runCommandAndWait(
    terminalId: string,
    command: string,
    opts?: { 
      signal?: AbortSignal; 
      interruptOnAbort?: boolean; 
      onFinished?: (result: CommandResult) => void;
      shouldSkip?: () => boolean;
    }
  ): Promise<CommandResult> {
    const taskId = await this.executeCommandInternal(terminalId, command, 'wait', opts?.onFinished)
    return this.waitForTask(terminalId, taskId, opts)
  }

  async waitForTask(
    terminalId: string,
    taskId: string,
    opts?: { 
      signal?: AbortSignal; 
      interruptOnAbort?: boolean;
      shouldSkip?: () => boolean;
    }
  ): Promise<CommandResult> {
    const startTime = Date.now()
    const timeoutMs = 120_000

    while (true) {
      if (opts?.signal?.aborted) {
        if (opts.interruptOnAbort !== false) {
          this.interrupt(terminalId)
          this.markTaskAborted(terminalId, taskId)
        }
        return { stdoutDelta: 'Command aborted by user.', exitCode: -2, history_command_match_id: taskId }
      }

      // Check if user manually skipped the wait
      if (opts?.shouldSkip?.()) {
        return { 
          stdoutDelta: 'USER_SKIPPED_WAIT', 
          exitCode: -3, 
          history_command_match_id: taskId 
        }
      }

      const task = this.getTaskMap(terminalId)[taskId]
      if (!task) {
        throw new Error(`Task ${taskId} not found.`)
      }

      if (task.status === 'finished') {
        return {
          stdoutDelta: task.output || '',
          exitCode: task.exitCode ?? -1,
          history_command_match_id: taskId
        }
      }

      if (Date.now() - startTime > timeoutMs) {
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
    onFinished?: (result: CommandResult) => void
  ): Promise<string> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }

    if (this.activeTaskByTerminal.has(terminalId)) {
      const activeTaskId = this.activeTaskByTerminal.get(terminalId)!
      const activeTask = this.getTaskMap(terminalId)[activeTaskId]
      const commandName = activeTask ? activeTask.command : 'unknown'
      throw new Error(
        `There is a running exec_command in the terminal tab: "${commandName}". If you need to end the previous command, use write_stdin to end it, otherwise wait until it finishes.`
      )
    }

    const taskId = uuidv4()
    const startOffset = this.getCurrentOffset(terminalId)
    const headless = this.headlessPtys.get(terminalId)

    const task: CommandTask = {
      id: taskId,
      command,
      type,
      status: 'running',
      startOffset,
      startTime: Date.now(),
      output: '',
      // Scheme 1: Record start line in headless buffer
      startAbsLine: headless ? headless.buffer.active.baseY + headless.buffer.active.cursorY : undefined
    }

    const taskMap = this.getTaskMap(terminalId)
    taskMap[taskId] = task
    this.activeTaskByTerminal.set(terminalId, taskId)
    if (onFinished) {
      this.onTaskFinishedCallbacks.set(taskId, onFinished)
    }

    const backend = this.getBackend(terminal.type)
    const eol = terminal.remoteOs === 'windows' ? '\r' : '\n'
    backend.write(terminal.ptyId, `${command}${eol}`)
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
  }

  private finishActiveTask(terminalId: string, exitCode?: number): void {
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) return
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || (task.status !== 'running' && task.status !== 'timeout')) return

    // Scheme 1: Extract rendered text from headless xterm buffer
    const headless = this.headlessPtys.get(terminalId)
    if (headless && task.startAbsLine !== undefined) {
      const buffer = headless.buffer.active
      const endAbsLine = buffer.baseY + buffer.cursorY
      const lines: string[] = []
      for (let i = task.startAbsLine; i <= endAbsLine; i++) {
        const line = buffer.getLine(i)
        if (line) {
          lines.push(line.translateToString(true))
        }
      }
      task.output = lines.join('\n').trimEnd()
    } else {
      // Fallback to raw buffer stripping
      task.output = this.stripEchoedCommand(task.output || '', task.command)
    }

    task.status = 'finished'
    task.endTime = Date.now()
    task.exitCode = exitCode
    task.endOffset = task.startOffset + task.output.length

    this.activeTaskByTerminal.delete(terminalId)

    const callback = this.onTaskFinishedCallbacks.get(taskId)
    if (callback) {
      this.onTaskFinishedCallbacks.delete(taskId)
      callback({ stdoutDelta: task.output, exitCode, history_command_match_id: taskId })
    }
  }

  private markTaskAborted(terminalId: string, taskId: string): void {
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || task.status !== 'running') return
    task.status = 'aborted'
    task.endTime = Date.now()
    task.exitCode = -2
    task.endOffset = task.startOffset + (task.output?.length || 0)
    this.activeTaskByTerminal.delete(terminalId)
    this.onTaskFinishedCallbacks.delete(taskId)
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

  private sendToRenderer(channel: string, data: unknown): void {
    if ((global as any).gateway) {
      (global as any).gateway.broadcastRaw(channel, data);
    } else {
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows()
      windows.forEach((window: any) => {
        window.webContents.send(channel, data)
      })
    }
  }
}
