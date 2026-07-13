import type { TerminalTab } from '../../../types'
import type { ICommandPolicyRuntime } from '../../runtimeContracts'
import type { TerminalRuntimeSnapshot } from '../../TerminalService'
import type { ToolExecutionContext } from '../types'
import {
  readCommandOutput,
  readTerminalTab,
  reconnectTerminalTab,
  runCommand,
  writeStdin
} from './terminal_tools'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertIncludes = (value: string, expected: string, message: string): void => {
  if (!value.includes(expected)) {
    throw new Error(`${message}. expected substring=${expected} actual=${value}`)
  }
}

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

class FakeCommandPolicyRuntime implements ICommandPolicyRuntime {
  evaluateCalls = 0
  approvalCalls = 0

  setFeedbackWaiter(): void {}

  getPolicyFilePath(): string {
    return '/tmp/policy.md'
  }

  async getLists() {
    return { allowlist: [], denylist: [], asklist: [] }
  }

  async addRule() {
    return { allowlist: [], denylist: [], asklist: [] }
  }

  async deleteRule() {
    return { allowlist: [], denylist: [], asklist: [] }
  }

  async evaluate(): Promise<'allow' | 'deny' | 'ask'> {
    this.evaluateCalls += 1
    return 'allow'
  }

  async requestApproval(): Promise<boolean> {
    this.approvalCalls += 1
    return true
  }
}

class FakeTerminalService {
  readonly terminal: TerminalTab
  readonly writeCalls: string[] = []
  readonly writeInputSequenceCalls: string[][] = []
  reconnectCalls = 0
  recentOutput = 'stale output from before disconnect'

  constructor(runtimeState: TerminalTab['runtimeState'] = 'exited') {
    this.terminal = {
      id: 'ssh-disconnected',
      ptyId: 'pty-ssh-disconnected',
      title: 'Disconnected SSH',
      cols: 80,
      rows: 24,
      type: 'ssh',
      capabilities: { supportsFilesystem: true } as any,
      isInitializing: runtimeState === 'initializing',
      runtimeState,
      lastExitCode: runtimeState === 'exited' ? 255 : undefined
    }
  }

  resolveTerminal(idOrName: string): { found: TerminalTab[]; bestMatch?: TerminalTab } {
    if (idOrName === this.terminal.id || idOrName === this.terminal.title) {
      return { found: [this.terminal], bestMatch: this.terminal }
    }
    return { found: [] }
  }

  getTerminalRuntimeSnapshot(terminalId: string): TerminalRuntimeSnapshot | null {
    if (terminalId !== this.terminal.id) return null
    const runtimeState =
      this.terminal.runtimeState ?? (this.terminal.isInitializing ? 'initializing' : 'unknown')
    const isReady = runtimeState === 'ready'
    return {
      id: this.terminal.id,
      title: this.terminal.title,
      type: this.terminal.type,
      runtimeState,
      isInitializing: this.terminal.isInitializing === true,
      lastExitCode: this.terminal.lastExitCode,
      reconnectable: this.terminal.type === 'ssh' && runtimeState === 'exited',
      canRunCommand: isReady,
      canWrite: isReady,
      canUseFilesystem: isReady
    }
  }

  getRecentOutput(): string {
    return this.recentOutput
  }

  async runCommandAndWait(): Promise<string> {
    throw new Error('runCommandAndWait should not be called for disconnected terminals')
  }

  async runCommandNoWait(): Promise<string> {
    throw new Error('runCommandNoWait should not be called for disconnected terminals')
  }

  write(_terminalId: string, data: string): void {
    this.writeCalls.push(data)
  }

  async writeInputSequence(
    _terminalId: string,
    sequence: readonly string[]
  ): Promise<void> {
    this.writeInputSequenceCalls.push([...sequence])
    this.writeCalls.push(...sequence)
  }

  getCommandTask(_terminalId: string, commandId: string) {
    return {
      id: commandId,
      command: 'echo retained',
      type: 'wait' as const,
      status: 'finished' as const,
      startOffset: 0,
      output: 'retained command output\n',
      startTime: Date.now()
    }
  }

  getCommandTasks() {
    return []
  }

  getActiveTaskId(): string | undefined {
    return undefined
  }

  async reconnectTerminal(): Promise<TerminalTab> {
    this.reconnectCalls += 1
    this.terminal.runtimeState = 'ready'
    this.terminal.isInitializing = false
    this.terminal.lastExitCode = undefined
    return this.terminal
  }
}

function createContext(
  terminalService: FakeTerminalService,
  commandPolicyService = new FakeCommandPolicyRuntime()
): { context: ToolExecutionContext; events: any[]; commandPolicyService: FakeCommandPolicyRuntime } {
  const events: any[] = []
  return {
    events,
    commandPolicyService,
    context: {
      sessionId: 'session-terminal-tools',
      messageId: 'message-terminal-tools',
      terminalService: terminalService as any,
      sendEvent: (_sessionId, event) => events.push(event),
      commandPolicyService,
      commandPolicyMode: 'standard'
    }
  }
}

async function run(): Promise<void> {
  {
    const terminalService = new FakeTerminalService('ready')
    const { context } = createContext(terminalService)
    let terminalBoundaryCount = 0
    ;(terminalService as any).runCommandAndWait = async () => ({
      stdoutDelta: 'Terminal exited before command completion.',
      exitCode: 255,
      history_command_match_id: 'exited-command',
      runtimeBoundary: true
    })
    const result = await runCommand(
      {
        tabIdOrName: 'ssh-disconnected',
        command: 'may-have-run',
        waitMode: 'wait'
      },
      context,
      {
        onRuntimeBoundary: () => {
          terminalBoundaryCount += 1
        }
      }
    )

    assertIncludes(
      result,
      'command outcome is unknown',
      'terminal exit must not be reported as ordinary command completion'
    )
    assertEqual(
      result.includes('The command has finished executing'),
      false,
      'terminal exit must not use the successful completion wording'
    )
    assertEqual(
      terminalBoundaryCount,
      1,
      'terminal exit must notify the batch executor about its runtime boundary'
    )
  }

  {
    const terminalService = new FakeTerminalService('exited')
    const { context, events } = createContext(terminalService)
    const result = await readTerminalTab(
      { tabIdOrName: 'ssh-disconnected', lines: 20 },
      context
    )
    assertIncludes(result, 'terminal_status:', 'read_terminal_tab should include terminal status')
    assertIncludes(result, '- runtime_state: exited', 'read_terminal_tab should report disconnected state')
    assertIncludes(result, 'retained history', 'read_terminal_tab should warn that output is retained history')
    assertIncludes(result, 'stale output from before disconnect', 'read_terminal_tab should preserve retained output')

    const deltas = events.filter((event) => event.type === 'sub_tool_delta')
    assertEqual(deltas.length, 1, 'read_terminal_tab should emit one output delta')
    assertEqual(deltas[0]?.outputDelta, result, 'read_terminal_tab output delta should match its returned result')
  }

  {
    const terminalService = new FakeTerminalService('exited')
    const policy = new FakeCommandPolicyRuntime()
    const { context } = createContext(terminalService, policy)
    const result = await runCommand(
      { tabIdOrName: 'ssh-disconnected', command: 'pwd', waitMode: 'wait' },
      context
    )
    assertIncludes(result, 'is disconnected', 'exec_command should report disconnected terminal')
    assertIncludes(result, 'reconnect_terminal_tab', 'exec_command should point to reconnect action')
    assertEqual(policy.evaluateCalls, 0, 'exec_command should not evaluate command policy for disconnected terminal')
  }

  {
    const terminalService = new FakeTerminalService('exited')
    const policy = new FakeCommandPolicyRuntime()
    const { context } = createContext(terminalService, policy)
    const result = await writeStdin(
      { tabIdOrName: 'ssh-disconnected', sequence: ['ETX'] },
      context
    )
    assertIncludes(result, 'is disconnected', 'write_stdin should report disconnected terminal')
    assertEqual(policy.evaluateCalls, 0, 'write_stdin should not evaluate command policy for disconnected terminal')
    assertEqual(terminalService.writeCalls.length, 0, 'write_stdin should not write to disconnected terminal')
  }

  {
    const terminalService = new FakeTerminalService('ready')
    const { context } = createContext(terminalService)
    const result = await writeStdin(
      { tabIdOrName: 'ssh-disconnected', sequence: ['ETX', 'continue'] },
      context
    )
    assertIncludes(result, 'Sent sequence: ETX, continue', 'write_stdin should report its sequence')
    assertEqual(
      JSON.stringify(terminalService.writeInputSequenceCalls),
      JSON.stringify([['\x03', 'continue']]),
      'write_stdin should submit one atomic, control-code-resolved sequence'
    )
  }

  {
    const terminalService = new FakeTerminalService('ready')
    const controller = new AbortController()
    const { context, events } = createContext(terminalService)
    const registrations: any[] = []
    let waitStarted = false
    context.signal = controller.signal
    context.registerBackgroundExecCommand = (command) => {
      registrations.push(command)
    }
    ;(terminalService as any).getCommandTask = (
      _terminalId: string,
      commandId: string
    ) => ({
      id: commandId,
      command: 'long-running',
      type: 'wait' as const,
      status: 'running' as const,
      startOffset: 0,
      startTime: Date.now()
    })
    ;(terminalService as any).getActiveTaskId = () => 'continuing-command'
    ;(terminalService as any).runCommandAndWait = async (
      _terminalId: string,
      _command: string,
      options: { signal?: AbortSignal }
    ) =>
      await new Promise((_, reject) => {
        waitStarted = true
        const onAbort = (): void => {
          const error = new Error('AbortError') as Error & {
            history_command_match_id?: string
            commandContinues?: boolean
          }
          error.name = 'AbortError'
          error.history_command_match_id = 'continuing-command'
          error.commandContinues = true
          reject(error)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    const running = runCommand(
      {
        tabIdOrName: 'ssh-disconnected',
        command: 'long-running',
        waitMode: 'wait'
      },
      context
    )
    await waitUntil(() => waitStarted, 'command should dispatch before stop')
    controller.abort()
    const outcome = await Promise.allSettled([running])

    assertEqual(outcome[0]?.status, 'rejected', 'stop should preserve AbortError')
    assertEqual(
      registrations[0]?.historyCommandMatchId,
      'continuing-command',
      'dispatched command should remain registered for completion tracking'
    )
    assertEqual(
      events.some((event) => event.type === 'command_finished'),
      false,
      'stop should not report a still-running command as finished'
    )
  }

  {
    const terminalService = new FakeTerminalService('ready')
    const controller = new AbortController()
    const { context } = createContext(terminalService)
    const registrations: any[] = []
    let waitStarted = false
    context.signal = controller.signal
    context.registerBackgroundExecCommand = (command) => {
      registrations.push(command)
    }
    ;(terminalService as any).getCommandTask = (
      _terminalId: string,
      commandId: string
    ) => ({
      id: commandId,
      command: 'already-exited',
      type: 'wait' as const,
      status: 'aborted' as const,
      startOffset: 0,
      startTime: Date.now(),
      endTime: Date.now(),
      exitCode: 255
    })
    ;(terminalService as any).getActiveTaskId = () => undefined
    ;(terminalService as any).runCommandAndWait = async (
      _terminalId: string,
      _command: string,
      options: { signal?: AbortSignal }
    ) =>
      await new Promise((_, reject) => {
        waitStarted = true
        const onAbort = (): void => {
          const error = new Error('AbortError') as Error & {
            history_command_match_id?: string
            commandContinues?: boolean
          }
          error.name = 'AbortError'
          error.history_command_match_id = 'already-exited-command'
          error.commandContinues = true
          reject(error)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    const running = runCommand(
      {
        tabIdOrName: 'ssh-disconnected',
        command: 'already-exited',
        waitMode: 'wait'
      },
      context
    )
    await waitUntil(() => waitStarted, 'stale continuing fixture should begin waiting')
    controller.abort()
    const outcome = await Promise.allSettled([running])

    assertEqual(outcome[0]?.status, 'rejected', 'stop should preserve the abort outcome')
    assertEqual(
      registrations.length,
      0,
      'an aborted and inactive task must never register a background guard'
    )
  }

  {
    const terminalService = new FakeTerminalService('exited')
    const { context } = createContext(terminalService)
    const result = await readCommandOutput(
      {
        tabIdOrName: 'ssh-disconnected',
        history_command_match_id: 'cmd-retained',
        offset: 0,
        limit: 10
      },
      context
    )
    assertIncludes(result, 'terminal_status:', 'read_command_output should include terminal status')
    assertIncludes(result, '- runtime_state: exited', 'read_command_output should report disconnected state')
    assertIncludes(result, 'retained command output', 'read_command_output should still expose retained command output')
  }

  {
    const terminalService = new FakeTerminalService('exited')
    const { context } = createContext(terminalService)
    const result = await reconnectTerminalTab(
      { tabIdOrName: 'ssh-disconnected' },
      context
    )
    assertIncludes(result, 'Reconnect succeeded', 'reconnect_terminal_tab should report success')
    assertIncludes(result, '- runtime_state: ready', 'reconnect_terminal_tab should report ready state after reconnect')
    assertEqual(terminalService.reconnectCalls, 1, 'reconnect_terminal_tab should call reconnect once')
  }

  console.log('PASS terminal_tools.extreme.spec: all 7 cases passed')
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
