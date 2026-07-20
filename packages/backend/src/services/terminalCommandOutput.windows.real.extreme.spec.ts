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
const CONNECTION_NAME = process.env.GYSHELL_REAL_WINDOWS_CONNECTION || 'WIN'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
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
  service.setRawEventPublisher(() => {})
  await service.createTerminal(config)
  try {
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(config.id)?.canRunCommand === true,
      `Saved SSH connection ${CONNECTION_NAME} did not become command-ready.`,
    )
    const startupOutput = service.getBufferDelta(config.id, 0)
    for (const privateBootstrapFragment of [
      '__GYSHELL_',
      '__gyshell_',
      '__GyShell_Internal',
      '-EncodedCommand',
    ]) {
      assert(
        !startupOutput.includes(privateBootstrapFragment),
        `Windows SSH startup exposed private bootstrap data: ${privateBootstrapFragment}`,
      )
    }

    const unicode = await runTracked(
      service,
      config.id,
      `Write-Output '汉字🙂é'`,
    )
    assert(unicode.snapshot.output === '汉字🙂é\n', 'PowerShell Unicode output changed')
    assert(unicode.snapshot.capture.state === 'complete', 'Unicode capture must be complete')

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
      `Hidden probe invented a missing native status variable: ${JSON.stringify(absentNativeStatus.snapshot.output)}`,
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

    const priorStatus = await runTracked(
      service,
      config.id,
      `Write-Output ('PRIOR_OK=' + $? + ';PRIOR_NATIVE=' + $LASTEXITCODE + ';TOP_ERROR=' + $Error[0].Exception.Message)`,
    )
    assert(
      priorStatus.snapshot.output.trim() ===
        'PRIOR_OK=False;PRIOR_NATIVE=37;TOP_ERROR=STRUCTURED_ERROR_SENTINEL',
      `Hidden probe changed the previous PowerShell status: ${JSON.stringify(priorStatus.snapshot.output)}`,
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
      `Hidden probe changed the previous native status: ${JSON.stringify(priorNativeFailure.snapshot.output)}`,
    )
    const priorSuccessfulPowerShell = await runTracked(
      service,
      config.id,
      `Write-Output ('PRIOR_OK=' + $? + ';PRIOR_NATIVE=' + $LASTEXITCODE)`,
    )
    assert(
      priorSuccessfulPowerShell.snapshot.output.trim() ===
        'PRIOR_OK=True;PRIOR_NATIVE=29',
      `Successful PowerShell status did not survive the hidden probe: ${JSON.stringify(priorSuccessfulPowerShell.snapshot.output)}`,
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
