import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractCommandOutputDisplayText } from '@gyshell/shared'
import { TerminalService, type CommandOutputSnapshot } from './TerminalService'
import type { CommandResult, SSHConnectionConfig } from '../types'
import { readCommandOutput } from './AgentHelper/tools/terminal_tools'
import {
  formatInitialCommandOutput,
  parseCommandOutputEnvelopeContract,
} from './AgentHelper/tools/command_output_contract'

const RUN_FLAG = '--run-real-windows-ssh'
const FORCE_FIRST_INIT_RETRY_FLAG = '--force-first-init-retry'
const CONNECTION_NAME = process.env.GYSHELL_REAL_WINDOWS_CONNECTION || 'WIN'

const PRIVATE_WINDOWS_PROTOCOL_FRAGMENTS = [
  '__GyShell_InternalDispatch',
  '__GyShell_InternalRecordOutcome',
  '__GyShell_InternalUserCommandBlock',
  '__GYSHELL_PROMPT__',
  '__gyshell_',
  'GYSHELL_READY',
  'GYSHELL_COMMAND_PROTOCOL',
] as const

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const assertNoPrivateWindowsProtocolLeak = (
  label: string,
  ...surfaces: string[]
): void => {
  for (const fragment of PRIVATE_WINDOWS_PROTOCOL_FRAGMENTS) {
    const leakingSurfaceIndex = surfaces.findIndex((surface) =>
      surface.includes(fragment)
    )
    const leakingSurface =
      leakingSurfaceIndex >= 0 ? surfaces[leakingSurfaceIndex] : ''
    const fragmentOffset = leakingSurface.indexOf(fragment)
    const context = fragmentOffset >= 0
      ? leakingSurface.slice(
          Math.max(0, fragmentOffset - 240),
          fragmentOffset + fragment.length + 240,
        )
      : ''
    assert(
      leakingSurfaceIndex < 0,
      `${label} exposed private Windows protocol data on surface ${leakingSurfaceIndex}: ${fragment}; context=${JSON.stringify(context)}`,
    )
  }
}

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 60_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

const resolveTerminalStatePath = (): string =>
  process.env.GYSHELL_REAL_TERMINAL_STATE_PATH ||
  (process.platform === 'darwin'
    ? path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'gyshell',
        'terminal-tabs-state.json',
      )
    : path.join(os.homedir(), '.config', 'gyshell', 'terminal-tabs-state.json'))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isSavedSshConnection = (value: unknown): value is SSHConnectionConfig =>
  isRecord(value) &&
  value.type === 'ssh' &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  typeof value.host === 'string' &&
  typeof value.port === 'number' &&
  typeof value.username === 'string' &&
  (value.authMethod === 'password' || value.authMethod === 'privateKey') &&
  typeof value.cols === 'number' &&
  typeof value.rows === 'number'

const loadSavedConnection = (): SSHConnectionConfig => {
  const statePath = resolveTerminalStatePath()
  const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const terminals = isRecord(parsed) && Array.isArray(parsed.terminals)
    ? parsed.terminals
    : []
  const saved = terminals
    .map((terminal) =>
      isRecord(terminal) && 'config' in terminal ? terminal.config : terminal,
    )
    .find(
      (terminal): terminal is SSHConnectionConfig =>
        isSavedSshConnection(terminal) && terminal.title === CONNECTION_NAME,
    )
  if (!saved) {
    throw new Error(`Saved SSH connection ${CONNECTION_NAME} was not found.`)
  }
  return {
    ...saved,
    id: `real-windows-output-${process.pid}`,
    title: `Real Windows output ${process.pid}`,
    cols: 120,
    rows: 40,
  }
}

const runTracked = async (
  service: TerminalService,
  terminalId: string,
  command: string,
  timeoutMs = 90_000,
): Promise<{ result: CommandResult; snapshot: CommandOutputSnapshot }> => {
  const taskId = await service.runCommandNoWait(terminalId, command)
  await waitUntil(
    () => service.getCommandOutputSnapshot(terminalId, taskId)?.executionState !== 'running',
    `Windows command did not finish: ${command.slice(0, 80)}`,
    timeoutMs,
  )
  const result = await service.waitForTask(terminalId, taskId)
  const snapshot = service.getCommandOutputSnapshot(terminalId, taskId)
  assert(snapshot, `Missing Windows command snapshot ${taskId}`)
  return { result, snapshot }
}

const run = async (): Promise<void> => {
  if (!process.argv.includes(RUN_FLAG)) {
    console.log(`SKIP real Windows SSH tests (pass ${RUN_FLAG})`)
    return
  }

  const config = loadSavedConnection()
  const service = new TerminalService()
  const sshBackend = (service as any).getBackend('ssh') as any
  const forceFirstInitRetry = process.argv.includes(FORCE_FIRST_INIT_RETRY_FLAG)
  let initializationLaunchCount = 0
  let initializationRetryCount = 0
  if (forceFirstInitRetry) {
    const backendConstructor = sshBackend.constructor as any
    backendConstructor.WINDOWS_SHELL_INIT_RETRY_INTERVAL_MS = 4000
    const buildLaunchCommand =
      sshBackend.buildWindowsPowerShellLaunchCommand.bind(sshBackend)
    sshBackend.buildWindowsPowerShellLaunchCommand = (
      instance: unknown,
      readySequence: string,
    ): string => {
      initializationLaunchCount += 1
      const emittedReadySequence = initializationLaunchCount === 1
        ? readySequence.replace(';attempt=1\x07', ';attempt=999\x07')
        : readySequence
      assert(
        initializationLaunchCount !== 1 || emittedReadySequence !== readySequence,
        'The forced retry fixture could not replace the first readiness record.',
      )
      return buildLaunchCommand(instance, emittedReadySequence)
    }
    const buildRetryCommand =
      sshBackend.buildWindowsPowerShellRetryCommand.bind(sshBackend)
    sshBackend.buildWindowsPowerShellRetryCommand = (
      instance: unknown,
      readySequence: string,
    ): string | undefined => {
      initializationRetryCount += 1
      return buildRetryCommand(instance, readySequence)
    }
  }
  const prepareCommandTracking = sshBackend.prepareCommandTracking.bind(
    sshBackend,
  ) as (...args: unknown[]) => Promise<unknown>
  let prepareCommandTrackingCalls = 0
  sshBackend.prepareCommandTracking = async (...args: unknown[]) => {
    prepareCommandTrackingCalls += 1
    return await prepareCommandTracking(...args)
  }
  let liveTerminalData = ''
  service.setRawEventPublisher((channel, payload) => {
    const event = payload as { terminalId?: string; data?: string }
    if (channel === 'terminal:data' && event.terminalId === config.id) {
      liveTerminalData += event.data || ''
    }
  })
  await service.createTerminal(config)
  try {
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      `Saved SSH connection ${CONNECTION_NAME} did not become command-ready.`,
    )
    if (forceFirstInitRetry) {
      assert(
        initializationLaunchCount === 1 && initializationRetryCount >= 1,
        'The real Windows SSH fixture did not re-arm the first initialized PowerShell.',
      )
    }
    service.resize(config.id, 121, 41)
    service.resize(config.id, 120, 40)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const startupOutput = service.getBufferDelta(config.id, 0)
    assertNoPrivateWindowsProtocolLeak(
      'Windows SSH startup or resize',
      startupOutput,
      liveTerminalData,
    )
    for (const privateBootstrapFragment of ['-EncodedCommand', 'gyshell-init-ready']) {
      assert(
        !startupOutput.includes(privateBootstrapFragment) &&
          !liveTerminalData.includes(privateBootstrapFragment),
        `Windows SSH startup or resize exposed private bootstrap data: ${privateBootstrapFragment}`,
      )
    }

    const manualFeedback = `GYSHELL_MANUAL_FEEDBACK_${process.pid}`
    const manualDispatchStartedAt = Date.now()
    await service.writeInputSequence(config.id, [
      `Start-Sleep -Milliseconds 3000; Write-Output ('GYSHELL_MANUAL_'+'FEEDBACK_${process.pid}')`,
      '\r',
    ])
    const manualDispatchMs = Date.now() - manualDispatchStartedAt
    assert(
      manualDispatchMs < 1000,
      `PowerShell manual input waited ${manualDispatchMs}ms before reaching SSH.`,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert(
      service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === false,
      'PowerShell reopened the agent gate before the slow manual command reached its own prompt.',
    )
    await new Promise((resolve) => setTimeout(resolve, 2200))
    assert(
      service.getTerminalRuntimeSnapshot(config.id)?.shellInputState === 'busy',
      'PowerShell treated normal empty prompt polls as errors during a long manual command.',
    )
    await waitUntil(
      () => service.getBufferDelta(config.id, 0).includes(manualFeedback),
      'PowerShell manual input produced no terminal feedback.',
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      'PowerShell did not return to a verified prompt after manual input.',
    )

    const firstChainedFeedback = `GYSHELL_CHAIN_FIRST_${process.pid}`
    const secondChainedFeedback = `GYSHELL_CHAIN_SECOND_${process.pid}`
    await service.writeInputSequence(
      config.id,
      [
        `Write-Output ('GYSHELL_CHAIN_'+'FIRST_${process.pid}')`,
        '\r',
        `Start-Sleep -Milliseconds 1200; Write-Output ('GYSHELL_CHAIN_'+'SECOND_${process.pid}')`,
        '\r',
      ],
      { intervalMs: 100 },
    )
    await waitUntil(
      () => service.getBufferDelta(config.id, 0).includes(firstChainedFeedback),
      'The first queued manual PowerShell command produced no feedback.',
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert(
      service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === false,
      'The first queued prompt incorrectly completed the still-running second manual command.',
    )
    await waitUntil(
      () => service.getBufferDelta(config.id, 0).includes(secondChainedFeedback),
      'The second queued manual PowerShell command produced no feedback.',
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      'PowerShell did not verify the second queued manual command prompt.',
    )

    const readHostPrompt = `GYSHELL_READHOST_PROMPT_${process.pid}`
    const readHostValue = `GYSHELL_READHOST_VALUE_${process.pid}`
    await service.writeInputSequence(config.id, [
      `$__answer=Read-Host '${readHostPrompt}'; Write-Output ('GYSHELL_READHOST_VALUE_'+$__answer)`,
      '\r',
    ])
    await waitUntil(
      () => service.getBufferDelta(config.id, 0).includes(readHostPrompt),
      'PowerShell did not enter foreground Read-Host input.',
    )
    assert(
      service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === false,
      'PowerShell reopened the agent gate while Read-Host was waiting for stdin.',
    )
    await service.writeInputSequence(config.id, [`${process.pid}`, '\r'])
    await waitUntil(
      () => service.getBufferDelta(config.id, 0).includes(readHostValue),
      'PowerShell foreground stdin did not reach Read-Host.',
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      'A foreground stdin Enter reserved a nonexistent extra PowerShell prompt.',
    )

    assert(
      Number(prepareCommandTrackingCalls) === 0,
      'PowerShell startup and manual input performed destructive prompt-journal preparation.',
    )
    const historyBaseline = await runTracked(
      service,
      config.id,
      `$__target='. $global:'+'__GyShell_'+'InternalDispatch';$__history_path=(Get-PSReadLineOption).HistorySavePath;$__disk=if(Test-Path -LiteralPath $__history_path){@(Get-Content -LiteralPath $__history_path | Where-Object { $_ -ceq $__target }).Count}else{0};Write-Output $__disk`,
    )
    const psReadLineDispatcherHistoryBaseline = Number.parseInt(
      historyBaseline.snapshot.output.trim(),
      10,
    )
    assert(
      Number.isSafeInteger(psReadLineDispatcherHistoryBaseline) &&
        psReadLineDispatcherHistoryBaseline >= 0,
      `Could not establish the legacy PSReadLine dispatcher-history baseline: ${JSON.stringify(historyBaseline.snapshot.output)}`,
    )
    const prepareCallsBeforeAgentReadHost = prepareCommandTrackingCalls
    const agentReadHostPrompt = `GYSHELL_AGENT_READHOST_${process.pid}`
    const agentReadHostTaskId = await service.runCommandNoWait(
      config.id,
      `$__agent_answer=Read-Host '${agentReadHostPrompt}'; Write-Output ('GYSHELL_AGENT_ANSWER_'+$__agent_answer)`,
    )
    await waitUntil(
      () => service.getBufferDelta(config.id, 0).includes(agentReadHostPrompt),
      'The real sidecar agent command did not enter Read-Host.',
    )
    await service.writeInputSequence(
      config.id,
      [`${process.pid}`, '\r'],
      { inputOwner: 'active-task' },
    )
    const agentReadHostResult = await service.waitForTask(
      config.id,
      agentReadHostTaskId,
    )
    assert(
      agentReadHostResult.stdoutDelta.includes(
        `GYSHELL_AGENT_ANSWER_${process.pid}`,
      ),
      'Agent Read-Host stdin did not reach the tracked sidecar command.',
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      'Agent Read-Host stdin did not settle at its task prompt revision.',
    )

    const spoofOffset = service.getCurrentOffset(config.id)
    const spoofFeedback = `GYSHELL_SPOOF_DONE_${process.pid}`
    await service.writeInputSequence(
      config.id,
      [
        "Write-Output ('>'+'> ')",
        '\r',
        `Start-Sleep -Milliseconds 1200; Write-Output ('GYSHELL_SPOOF_'+'DONE_${process.pid}')`,
        '\r',
      ],
      { intervalMs: 100 },
    )
    await waitUntil(
      () => /(?:\r?\n)>> (?:\r?\n)/.test(
        service.getBufferDelta(config.id, spoofOffset),
      ),
      'PowerShell did not render the ordinary output used for continuation-spoof coverage.',
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert(
      service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === false,
      'Ordinary output shaped like a continuation prompt completed a newer command.',
    )
    await waitUntil(
      () => service.getBufferDelta(config.id, spoofOffset).includes(spoofFeedback),
      'PowerShell continuation-spoof regression command produced no feedback.',
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      'PowerShell did not verify the prompt after continuation-shaped output.',
    )

    const continuationOffset = service.getCurrentOffset(config.id)
    const continuationFeedback = `GYSHELL_CONTINUATION_${process.pid}`
    await service.writeInputSequence(config.id, ['if ($true) {', '\r'])
    await waitUntil(
      () => service.getBufferDelta(config.id, continuationOffset).includes('>> '),
      'PowerShell did not enter its continuation prompt.',
    )
    await service.writeInputSequence(config.id, [
      `Write-Output ('GYSHELL_'+'CONTINUATION_${process.pid}')`,
      '\r',
    ])
    await waitUntil(
      () =>
        (service
          .getBufferDelta(config.id, continuationOffset)
          .match(/>> /g) || []).length >= 2,
      'PowerShell did not retain the multiline continuation prompt.',
    )
    await service.writeInputSequence(config.id, ['}', '\r'])
    await waitUntil(
      () =>
        service
          .getBufferDelta(config.id, continuationOffset)
          .includes(continuationFeedback),
      'PowerShell multiline manual input produced no feedback.',
    )
    await waitUntil(
      () => {
        const continuationDisplay = service.getBufferDelta(
          config.id,
          continuationOffset,
        )
        const feedbackOffset = continuationDisplay.indexOf(continuationFeedback)
        return (
          feedbackOffset >= 0 &&
          continuationDisplay
            .slice(feedbackOffset + continuationFeedback.length)
            .includes('PS ')
        )
      },
      'PowerShell did not render its authenticated prompt after multiline input.',
    )

    await service.writeInputSequence(config.id, [
      'Start-Sleep -Seconds 30',
      '\r',
    ])
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert(
      service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === false,
      'A stale continuation prompt reopened the agent gate during the next command.',
    )
    const interruptStartedAt = Date.now()
    await service.writeInputSequence(config.id, ['\x03'])
    assert(
      Date.now() - interruptStartedAt < 1000,
      'PowerShell Ctrl-C was delayed before reaching SSH.',
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      'PowerShell waited for an extra prompt after Ctrl-C completed a pending command.',
      15_000,
    )
    assert(
      prepareCommandTrackingCalls === prepareCallsBeforeAgentReadHost + 1,
      'Only the explicit agent task should prepare command tracking.',
    )

    const unicode = await runTracked(
      service,
      config.id,
      `Write-Output '汉字🙂é'`,
    )
    assert(unicode.snapshot.output === '汉字🙂é\n', 'PowerShell Unicode output changed')
    assert(unicode.snapshot.capture.state === 'complete', 'Unicode capture must be complete')

    const progressRawOffset = liveTerminalData.length
    const progressDisplayOffset = service.getCurrentOffset(config.id)
    const computerInfoTaskId = await service.runCommandNoWait(
      config.id,
      'Get-ComputerInfo',
    )
    let resizeToggle = false
    const resizeDuringProgress = setInterval(() => {
      resizeToggle = !resizeToggle
      service.resize(
        config.id,
        resizeToggle ? 119 : 121,
        resizeToggle ? 39 : 41,
      )
    }, 100)
    let computerInfoResult: CommandResult
    try {
      await waitUntil(
        () =>
          service.getCommandOutputSnapshot(config.id, computerInfoTaskId)
            ?.executionState !== 'running',
        'Get-ComputerInfo did not finish during resize coverage.',
        120_000,
      )
      computerInfoResult = await service.waitForTask(
        config.id,
        computerInfoTaskId,
      )
    } finally {
      clearInterval(resizeDuringProgress)
      service.resize(config.id, 120, 40)
    }
    const computerInfoSnapshot = service.getCommandOutputSnapshot(
      config.id,
      computerInfoTaskId,
    )
    assert(computerInfoSnapshot, 'Missing Get-ComputerInfo command snapshot.')
    assert(
      computerInfoResult.executionState === 'finished' &&
        computerInfoSnapshot.output.length > 1000,
      `Get-ComputerInfo did not complete with substantive output: ${JSON.stringify({
        result: computerInfoResult,
        rawTail: liveTerminalData.slice(progressRawOffset).slice(-4000),
        displayTail: service
          .getBufferDelta(config.id, progressDisplayOffset)
          .slice(-4000),
      })}`,
    )
    assertNoPrivateWindowsProtocolLeak(
      'Get-ComputerInfo progress redraw and resize',
      liveTerminalData.slice(progressRawOffset),
      service.getBufferDelta(config.id, progressDisplayOffset),
      computerInfoSnapshot.output,
    )

    const directorySentinel = `GYSHELL_DIRECTORY_AFTER_${process.pid}`
    const directoryStartedAt = Date.now()
    const directoryInfo = await runTracked(
      service,
      config.id,
      `Get-Item -LiteralPath $env:TEMP; Write-Output '${directorySentinel}'`,
    )
    const directoryDurationMs = Date.now() - directoryStartedAt
    assert(
      directoryInfo.snapshot.output.includes(directorySentinel),
      'DirectoryInfo formatting swallowed the following pipeline output.',
    )
    assert(
      Buffer.byteLength(directoryInfo.snapshot.output, 'utf8') < 128 * 1024,
      `DirectoryInfo formatting produced pathological padding: ${Buffer.byteLength(directoryInfo.snapshot.output, 'utf8')} bytes`,
    )
    assert(
      directoryDurationMs < 15_000,
      `DirectoryInfo formatting took an unreasonable ${directoryDurationMs}ms.`,
    )

    const parseFailure = await runTracked(
      service,
      config.id,
      'Write-Output )',
    )
    assert(
      parseFailure.result.exitCode !== 0 &&
        parseFailure.snapshot.output.includes('Write-Output )') &&
        parseFailure.snapshot.output.includes('ParserError') &&
        parseFailure.snapshot.output.includes('FullyQualifiedErrorId'),
      `PowerShell parse failure lost user-source diagnostics: ${JSON.stringify(parseFailure.snapshot.output)}`,
    )
    assertNoPrivateWindowsProtocolLeak(
      'PowerShell parse failure',
      parseFailure.snapshot.output,
    )
    const parseRecovery = await runTracked(
      service,
      config.id,
      `Write-Output 'GYSHELL_PARSE_RECOVERY_${process.pid}'`,
    )
    assert(
      parseRecovery.snapshot.output.trim() ===
        `GYSHELL_PARSE_RECOVERY_${process.pid}`,
      'A parser error poisoned the next top-level PowerShell command.',
    )

    const scopeVariable = `GYSHELL_SCOPE_${process.pid}`
    const scopeFunction = `GYSHELL_SCOPE_FN_${process.pid}`
    await runTracked(
      service,
      config.id,
      `$global:${scopeVariable}='VARIABLE_OK'; function global:${scopeFunction} { 'FUNCTION_OK' }`,
    )
    const scopePersistence = await runTracked(
      service,
      config.id,
      `Write-Output ($global:${scopeVariable}+';'+(${scopeFunction}))`,
    )
    assert(
      scopePersistence.snapshot.output.trim() === 'VARIABLE_OK;FUNCTION_OK',
      `Agent commands lost top-level PowerShell scope: ${JSON.stringify(scopePersistence.snapshot.output)}`,
    )

    const seededEngineHistory = await runTracked(
      service,
      config.id,
      `$__target='. $global:'+'__GyShell_'+'InternalDispatch';$__now=Get-Date;1..3|ForEach-Object {[pscustomobject]@{CommandLine=$__target;ExecutionStatus='Completed';StartExecutionTime=$__now;EndExecutionTime=$__now}|Add-History};Write-Output ('SEEDED='+@(Get-History|Where-Object {$_.CommandLine -ceq $__target}).Count)`,
    )
    const seededEngineHistoryMatch = seededEngineHistory.snapshot.output
      .trim()
      .match(/^SEEDED=(\d+)$/)
    assert(
      seededEngineHistoryMatch !== null &&
        Number.parseInt(seededEngineHistoryMatch[1], 10) >= 3,
      `The real history fixture could not seed repeated exact dispatcher entries: ${JSON.stringify(seededEngineHistory.snapshot.output)}`,
    )

    const historyAudit = await runTracked(
      service,
      config.id,
      `$__target='. $global:'+'__GyShell_'+'InternalDispatch';$__engine=@(Get-History | Where-Object { $_.CommandLine -ceq $__target }).Count;$__history_path=(Get-PSReadLineOption).HistorySavePath;$__disk=if(Test-Path -LiteralPath $__history_path){@(Get-Content -LiteralPath $__history_path | Where-Object { $_ -ceq $__target }).Count}else{0};Write-Output ('ENGINE='+$__engine+';PSREADLINE='+$__disk)`,
    )
    const historyAuditMatch = historyAudit.snapshot.output.trim().match(
      /^ENGINE=(\d+);PSREADLINE=(\d+)$/,
    )
    assert(
      historyAuditMatch !== null &&
        historyAuditMatch[1] === '0' &&
        Number.parseInt(historyAuditMatch[2], 10) ===
          psReadLineDispatcherHistoryBaseline,
      `The private dispatcher entered PowerShell history: ${JSON.stringify(historyAudit.snapshot.output)}`,
    )

    const cancellationRawOffset = liveTerminalData.length
    const cancellationStartedAt = Date.now()
    const cancellationTaskId = await service.runCommandNoWait(
      config.id,
      `Start-Sleep -Seconds 30; Write-Output 'GYSHELL_CANCEL_MUST_NOT_FINISH_${process.pid}'`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    await service.writeInputSequence(
      config.id,
      ['\x03'],
      { inputOwner: 'active-task' },
    )
    await waitUntil(
      () =>
        service.getCommandOutputSnapshot(config.id, cancellationTaskId)
          ?.executionState !== 'running',
      'Ctrl-C did not settle the tracked PowerShell command.',
      15_000,
    )
    const cancellationResult = await service.waitForTask(
      config.id,
      cancellationTaskId,
    )
    assert(
      Date.now() - cancellationStartedAt < 15_000 &&
        !cancellationResult.stdoutDelta.includes('GYSHELL_CANCEL_MUST_NOT_FINISH'),
      `Ctrl-C did not stop the tracked command promptly: ${JSON.stringify(cancellationResult)}`,
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      'Tracked Ctrl-C did not restore a verified PowerShell prompt.',
      15_000,
    )
    assertNoPrivateWindowsProtocolLeak(
      'tracked Ctrl-C recovery',
      liveTerminalData.slice(cancellationRawOffset),
    )

    const repeatedPrepareBaseline = prepareCommandTrackingCalls
    const repeatedStartedAt = Date.now()
    for (let index = 0; index < 5; index += 1) {
      const repeated = await runTracked(
        service,
        config.id,
        `Write-Output 'GYSHELL_REPEAT_${process.pid}_${index}'`,
      )
      assert(
        repeated.snapshot.output.trim() ===
          `GYSHELL_REPEAT_${process.pid}_${index}`,
        `Repeated PowerShell command ${index} returned the wrong output.`,
      )
    }
    assert(
      prepareCommandTrackingCalls - repeatedPrepareBaseline === 5,
      'Each repeated agent command must perform exactly one tracking preparation.',
    )
    assert(
      Date.now() - repeatedStartedAt < 20_000,
      'Five trivial PowerShell commands incurred pathological dispatcher latency.',
    )

    const delayedStartedAt = Date.now()
    const delayedTaskId = await service.runCommandNoWait(
      config.id,
      `Write-Output '=== ports ==='; Start-Sleep -Milliseconds 1200; Write-Output 'no_task_ports'; Start-Sleep -Milliseconds 300; Write-Output 'DONE'`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const delayedPrefix = service.getCommandOutputSnapshot(
      config.id,
      delayedTaskId,
    )
    assert(delayedPrefix, 'Missing PowerShell delayed-output running snapshot')
    assert(
      delayedPrefix.executionState === 'running',
      `PowerShell command finalized before its delayed sections could run: ${JSON.stringify(delayedPrefix)}`,
    )
    await waitUntil(
      () =>
        service.getCommandOutputSnapshot(config.id, delayedTaskId)
          ?.executionState !== 'running',
      'PowerShell delayed-output command never reached a tracked completion',
    )
    const delayedResult = await service.waitForTask(config.id, delayedTaskId)
    const delayedFinal = service.getCommandOutputSnapshot(
      config.id,
      delayedTaskId,
    )
    assert(delayedFinal, 'Missing PowerShell delayed-output final snapshot')
    assert(
      delayedResult.executionState === 'finished' &&
        delayedFinal.capture.state === 'complete' &&
        Date.now() - delayedStartedAt >= 1200,
      `PowerShell delayed output did not finish authoritatively: ${JSON.stringify({ delayedResult, delayedFinal })}`,
    )
    assert(
      delayedFinal.output === '=== ports ===\nno_task_ports\nDONE\n',
      `PowerShell delayed sections were lost or reordered: ${JSON.stringify(delayedFinal.output)}`,
    )

    const large = await runTracked(
      service,
      config.id,
      `1..4000 | ForEach-Object { '{0:D5}:{1}' -f $_, ('x' * 16) }`,
    )
    assert(
      large.snapshot.capture.state === 'complete' &&
        Buffer.byteLength(large.snapshot.output, 'utf8') > 50 * 1024,
      'PowerShell large-output fixture must exceed the model-facing presentation limit while remaining completely captured',
    )
    const initialLarge = formatInitialCommandOutput({
      terminalId: config.id,
      historyCommandMatchId: large.result.history_command_match_id,
      executionState: large.snapshot.executionState,
      exitCode: large.snapshot.exitCode,
      output: large.snapshot.output,
      capture: large.snapshot.capture,
    })
    assert(
      initialLarge.contract.presentation.state === 'excerpt' &&
        typeof initialLarge.contract.presentation.nextCursor === 'string',
      'PowerShell large output must explicitly advertise an excerpt and recovery cursor',
    )
    assert(
      Buffer.byteLength(initialLarge.text, 'utf8') <= 50 * 1024,
      'PowerShell initial tool result exceeded the model-facing envelope limit',
    )

    let cursor: string | undefined =
      initialLarge.contract.presentation.nextCursor
    let recoveredSuffix = ''
    let pageCount = 0
    while (cursor) {
      const pageText = await readCommandOutput(
        {
          tabIdOrName: config.id,
          history_command_match_id: large.result.history_command_match_id,
          cursor,
          maxBytes: 4096,
        },
        {
          sessionId: 'real-windows-paging',
          messageId: `real-windows-page-${pageCount}`,
          terminalService: service,
          sendEvent: () => {},
        } as any,
      )
      const pageContract = parseCommandOutputEnvelopeContract(pageText)
      assert(pageContract, `PowerShell page ${pageCount} lost its typed contract`)
      recoveredSuffix += extractCommandOutputDisplayText(pageText)
      cursor = pageContract.presentation.nextCursor
      pageCount += 1
      assert(pageCount < 100, 'PowerShell cursor paging failed to make bounded progress')
    }
    let sixtiethNewline = -1
    for (let line = 0; line < 60; line += 1) {
      sixtiethNewline = large.snapshot.output.indexOf(
        '\n',
        sixtiethNewline + 1,
      )
    }
    assert(sixtiethNewline >= 0, 'PowerShell large-output fixture lost its first 60 lines')
    assert(
      recoveredSuffix === large.snapshot.output.slice(sixtiethNewline),
      'PowerShell cursor pages did not exactly recover every byte after the initial head excerpt',
    )
    assert(pageCount > 1, 'PowerShell large-output recovery did not exercise multiple pages')

    await runTracked(
      service,
      config.id,
      `Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue; $null=$null`,
    )
    const absentNativeStatus = await runTracked(
      service,
      config.id,
      `Write-Output ('PRIOR_OK=' + $? + ';NATIVE_EXISTS=' + (Test-Path Variable:Global:LASTEXITCODE))`,
    )
    assert(
      absentNativeStatus.snapshot.output.trim() ===
        'PRIOR_OK=True;NATIVE_EXISTS=False',
      `Hidden dispatch invented a missing native status variable: ${JSON.stringify(absentNativeStatus.snapshot.output)}`,
    )

    const dotSourcedStatus = await runTracked(
      service,
      config.id,
      `Microsoft.PowerShell.Utility\\Write-Error 'DOT_SOURCE_SEED' -ErrorAction Ignore; . { Write-Output ('DOT_OK=' + $?) }`,
    )
    assert(
      dotSourcedStatus.snapshot.output.trim() === 'DOT_OK=False',
      `Dot-sourcing changed the seeded PowerShell status: ${JSON.stringify(dotSourcedStatus.snapshot.output)}`,
    )

    const dotSourcedNativeStatus = await runTracked(
      service,
      config.id,
      `$global:LASTEXITCODE=37; . { Write-Output ('DOT_NATIVE=' + $LASTEXITCODE) }`,
    )
    assert(
      dotSourcedNativeStatus.snapshot.output.trim() === 'DOT_NATIVE=37',
      `Dot-sourcing changed the seeded native status: ${JSON.stringify(dotSourcedNativeStatus.snapshot.output)}`,
    )

    const structuredError = await runTracked(
      service,
      config.id,
      `Write-Error 'STRUCTURED_ERROR_SENTINEL'`,
    )
    assert(structuredError.result.exitCode !== 0, 'Write-Error must remain a failed outcome')
    for (const detail of [
      'STRUCTURED_ERROR_SENTINEL',
      'CategoryInfo',
      'FullyQualifiedErrorId',
    ]) {
      assert(
        structuredError.snapshot.output.includes(detail),
        `PowerShell structured error lost ${detail}: ${JSON.stringify(structuredError.snapshot.output)}`,
      )
    }
    assertNoPrivateWindowsProtocolLeak(
      'PowerShell nonterminating structured error',
      structuredError.snapshot.output,
    )

    const priorStatus = await runTracked(
      service,
      config.id,
      `Write-Output ('PRIOR_OK=' + $? + ';PRIOR_NATIVE=' + $LASTEXITCODE + ';TOP_ERROR=' + $Error[0].Exception.Message)`,
    )
    assert(
      priorStatus.snapshot.output.trim() ===
        'PRIOR_OK=False;PRIOR_NATIVE=37;TOP_ERROR=STRUCTURED_ERROR_SENTINEL',
      `Hidden dispatch changed the previous PowerShell status: ${JSON.stringify(priorStatus.snapshot.output)}`,
    )

    const terminatingError = await runTracked(
      service,
      config.id,
      `throw 'TERMINATING_ERROR_SENTINEL'`,
    )
    assert(
      terminatingError.result.exitCode !== 0 &&
        terminatingError.snapshot.output.includes(
          'TERMINATING_ERROR_SENTINEL',
        ) &&
        terminatingError.snapshot.output.includes('CategoryInfo') &&
        terminatingError.snapshot.output.includes('FullyQualifiedErrorId'),
      `PowerShell terminating error lost structured details: ${JSON.stringify(terminatingError.snapshot.output)}`,
    )
    assertNoPrivateWindowsProtocolLeak(
      'PowerShell terminating structured error',
      terminatingError.snapshot.output,
    )
    const priorTerminatingStatus = await runTracked(
      service,
      config.id,
      `Write-Output ('PRIOR_OK=' + $? + ';PRIOR_NATIVE=' + $LASTEXITCODE + ';TOP_ERROR=' + $Error[0].Exception.Message)`,
    )
    assert(
      priorTerminatingStatus.snapshot.output.trim() ===
        'PRIOR_OK=False;PRIOR_NATIVE=37;TOP_ERROR=TERMINATING_ERROR_SENTINEL',
      `Hidden dispatch changed the terminating-error status: ${JSON.stringify(priorTerminatingStatus.snapshot.output)}`,
    )

    const nativeFailure = await runTracked(
      service,
      config.id,
      `cmd.exe /d /c exit 29`,
    )
    assert(
      nativeFailure.result.executionState === 'outcome_unknown' &&
        nativeFailure.result.exitCode === undefined,
      `Ambiguous native attribution must remain conservative: ${JSON.stringify(nativeFailure.result)}`,
    )
    const priorNativeFailure = await runTracked(
      service,
      config.id,
      `Write-Output ('PRIOR_OK=' + $? + ';PRIOR_NATIVE=' + $LASTEXITCODE)`,
    )
    assert(
      priorNativeFailure.snapshot.output.trim() ===
        'PRIOR_OK=False;PRIOR_NATIVE=29',
      `Hidden dispatch changed the previous native status: ${JSON.stringify(priorNativeFailure.snapshot.output)}`,
    )
    const priorSuccessfulPowerShell = await runTracked(
      service,
      config.id,
      `Write-Output ('PRIOR_OK=' + $? + ';PRIOR_NATIVE=' + $LASTEXITCODE)`,
    )
    assert(
      priorSuccessfulPowerShell.snapshot.output.trim() ===
        'PRIOR_OK=True;PRIOR_NATIVE=29',
      `Successful PowerShell status did not survive hidden dispatch: ${JSON.stringify(priorSuccessfulPowerShell.snapshot.output)}`,
    )

    assertNoPrivateWindowsProtocolLeak(
      'complete Windows SSH interaction matrix',
      liveTerminalData,
      service.getBufferDelta(config.id, 0),
    )

    console.log(`PASS real Windows SSH command-output matrix: ${CONNECTION_NAME}`)
  } finally {
    service.kill(config.id)
  }
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
