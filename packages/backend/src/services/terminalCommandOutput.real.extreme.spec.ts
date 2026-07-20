import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TerminalService, type CommandOutputSnapshot } from './TerminalService'
import type { CommandResult } from '../types'
import { readCommandOutput } from './AgentHelper/tools/terminal_tools'
import { formatInitialCommandOutput } from './AgentHelper/tools/command_output_contract'

const REAL_TEST_ENV = 'GYSHELL_RUN_REAL_PTY_TESTS'
const REAL_TEST_FLAG = '--run-real-pty'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const compactTerminalWhitespace = (value: string): string => value.replace(/\s+/g, '')

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

const runTrackedCommand = async (
  service: TerminalService,
  terminalId: string,
  command: string,
  timeoutMs = 30_000,
): Promise<{ result: CommandResult; snapshot: CommandOutputSnapshot }> => {
  const taskId = await service.runCommandNoWait(terminalId, command)
  try {
    await waitUntil(
      () => service.getCommandOutputSnapshot(terminalId, taskId)?.executionState !== 'running',
      `Timed out waiting for ${terminalId}: ${command.slice(0, 80)}`,
      timeoutMs,
    )
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(
        service.getCommandOutputSnapshot(terminalId, taskId),
      )}; task=${JSON.stringify(
        service.getCommandTask(terminalId, taskId),
      )}; terminalTail=${JSON.stringify(
        service.getBufferDelta(terminalId, 0).slice(-12_000),
      )}`,
    )
  }
  const result = await service.waitForTask(terminalId, taskId)
  const snapshot = service.getCommandOutputSnapshot(terminalId, taskId)
  assert(snapshot, `Missing immutable command snapshot for ${taskId}`)
  return { result, snapshot }
}

const waitForShellPrompt = async (
  service: TerminalService,
  terminalId: string,
): Promise<void> => {
  await waitUntil(
    () => {
      const snapshot = service.getTerminalRuntimeSnapshot(terminalId)
      return (
        snapshot?.runtimeState === 'ready' &&
        snapshot.shellInputState === 'idle'
      )
    },
    `Shell ${terminalId} did not reach a usable prompt`,
  )
  // Give the initial prompt hook a chance to publish its first boundary marker.
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const runShellMatrix = async (shell: string): Promise<void> => {
  const shellName = shell.split('/').pop() || 'shell'
  const terminalId = `real-output-${shellName}-${process.pid}`
  const service = new TerminalService()
  let focusedLiveDisplay: string | undefined
  service.setRawEventPublisher((channel, payload) => {
    const event = payload as { terminalId?: string; data?: string }
    if (
      focusedLiveDisplay !== undefined &&
      channel === 'terminal:data' &&
      event.terminalId === terminalId
    ) {
      focusedLiveDisplay += event.data || ''
    }
  })

  const previousPromptCommand = process.env.PROMPT_COMMAND
  const previousZdotDir = process.env.ZDOTDIR
  const zshFixtureDir = shellName === 'zsh'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-real-zsh-profile-'))
    : undefined
  if (shellName === 'bash') {
    process.env.PROMPT_COMMAND =
      'GYSHELL_EXISTING_PROMPT_COUNT=$(( ${GYSHELL_EXISTING_PROMPT_COUNT:-0} + 1 )); printf PROMPT_NOISE'
  } else if (zshFixtureDir) {
    fs.writeFileSync(
      path.join(zshFixtureDir, '.zshrc'),
      'gyshell_real_user_preexec() { printf "ZSH_PREEXEC_NOISE\\n"; [[ "$1" == *GYSHELL_ABORT_BEFORE_START* ]] && sleep 2; return 0; }\n' +
        'preexec_functions+=(gyshell_real_user_preexec)\n' +
        'gyshell_real_user_precmd() { printf ZSH_PROMPT_NOISE; return 0; }\n' +
        'precmd_functions+=(gyshell_real_user_precmd)\n',
      'utf8',
    )
    process.env.ZDOTDIR = zshFixtureDir
  }
  try {
    await service.createTerminal({
      type: 'local',
      id: terminalId,
      title: `Real output ${shellName}`,
      shell,
      cols: 40,
      rows: 24,
    })
  } finally {
    if (previousPromptCommand === undefined) {
      delete process.env.PROMPT_COMMAND
    } else {
      process.env.PROMPT_COMMAND = previousPromptCommand
    }
    if (previousZdotDir === undefined) {
      delete process.env.ZDOTDIR
    } else {
      process.env.ZDOTDIR = previousZdotDir
    }
  }

  try {
    await waitForShellPrompt(service, terminalId)

    const visibleCommand = 'printf __gyshell_x'
    const visibleBaseline = service.getCurrentOffset(terminalId)
    focusedLiveDisplay = ''
    const visibleResult = await runTrackedCommand(
      service,
      terminalId,
      visibleCommand,
    )
    const visibleLiveData = focusedLiveDisplay
    focusedLiveDisplay = undefined
    assertEqual(
      visibleResult.snapshot.output,
      '__gyshell_x',
      `${shellName} focused display fixture must retain exact command output`,
    )
    await waitUntil(
      () => service.getRecentOutput(terminalId, 24).includes('__gyshell_x'),
      `${shellName} headless terminal did not render the focused command output`,
    )
    for (const surface of [
      { name: 'terminal:data', value: visibleLiveData },
      { name: 'ring buffer', value: service.getBufferDelta(terminalId, visibleBaseline) },
      { name: 'headless terminal', value: service.getRecentOutput(terminalId, 24) },
    ]) {
      // xterm inserts visual line breaks when a prompt plus command exceeds the
      // terminal width. Compact whitespace so the assertion follows the cells
      // the user sees and still catches a private dispatcher split by wrapping.
      const compactSurface = compactTerminalWhitespace(surface.value)
      const compactCommand = compactTerminalWhitespace(visibleCommand)
      assertEqual(
        compactSurface.split(compactCommand).length - 1,
        1,
        `${shellName} ${surface.name} must show the original command exactly once`,
      )
      assert(
        surface.value.includes('__gyshell_x'),
        `${shellName} ${surface.name} must retain private-looking user output`,
      )
      if (shellName === 'zsh') {
        assert(
          surface.value.includes('ZSH_PREEXEC_NOISE'),
          `${shellName} ${surface.name} must retain safe user preexec-hook output`,
        )
      }
      assert(
        !/__gyshell_[0-9a-f]{32}_dispatch/.test(compactSurface) &&
          !compactSurface.includes('_command_exit') &&
          !compactSurface.includes('builtintrap'),
        `${shellName} ${surface.name} exposed the private Unix dispatcher`,
      )
    }

    if (shellName === 'zsh') {
      service.resize(terminalId, 4, 100)
      await new Promise((resolve) => setTimeout(resolve, 50))

      const narrowCommand = 'printf OK'
      const narrowBaseline = service.getCurrentOffset(terminalId)
      focusedLiveDisplay = ''
      const narrowResult = await runTrackedCommand(service, terminalId, narrowCommand)
      const narrowLiveData = focusedLiveDisplay
      focusedLiveDisplay = undefined
      assertEqual(narrowResult.snapshot.output, 'OK', 'narrow zsh capture must remain exact')
      const narrowSurfaces = [
        { name: 'terminal:data', value: narrowLiveData },
        { name: 'ring buffer', value: service.getBufferDelta(terminalId, narrowBaseline) },
        { name: 'headless terminal', value: service.getRecentOutput(terminalId, 2000) },
      ]
      for (const surface of narrowSurfaces) {
        const compactSurface = compactTerminalWhitespace(surface.value)
        assertEqual(
          compactSurface.split(compactTerminalWhitespace(narrowCommand)).length - 1,
          1,
          `4-column zsh ${surface.name} must show the original command exactly once`,
        )
        assert(
          !compactSurface.includes('_command_exit') &&
            !compactSurface.includes('builtintrap') &&
            !compactSurface.includes('dispatch_restore'),
          `4-column zsh ${surface.name} exposed redrawn private dispatcher fragments`,
        )
      }
      assert(
        narrowLiveData.length < 2048,
        `4-column zsh emitted an unexpectedly large hidden-command projection (${narrowLiveData.length} bytes)`,
      )

      const abortCommand = 'printf GYSHELL_ABORT_BEFORE_START'
      const abortBaseline = service.getCurrentOffset(terminalId)
      focusedLiveDisplay = ''
      const abortTaskId = await service.runCommandNoWait(terminalId, abortCommand)
      const abortController = new AbortController()
      setTimeout(() => abortController.abort(), 50)
      const abortResult = await service.waitForTask(terminalId, abortTaskId, {
        signal: abortController.signal,
      })
      assertEqual(abortResult.executionState, 'aborted', 'narrow zsh fixture must abort before preexec')
      await waitUntil(
        () => service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand === true,
        'narrow zsh did not release its hidden-display guard at the authenticated prompt',
        5_000,
      )
      const abortLiveData = focusedLiveDisplay
      focusedLiveDisplay = undefined
      for (const surface of [
        { name: 'terminal:data', value: abortLiveData },
        { name: 'ring buffer', value: service.getBufferDelta(terminalId, abortBaseline) },
      ]) {
        const compactSurface = compactTerminalWhitespace(surface.value)
        assert(
          !compactSurface.includes('__gyshell_') &&
            !compactSurface.includes('_command_exit') &&
            !compactSurface.includes('builtintrap'),
          `aborted 4-column zsh ${surface.name} exposed private dispatcher text`,
        )
      }

      const recovered = await runTrackedCommand(service, terminalId, 'printf RECOVERED')
      assertEqual(
        recovered.snapshot.output,
        'RECOVERED',
        'narrow zsh must accept and capture the command after an early abort',
      )
      service.resize(terminalId, 40, 24)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    if (shellName === 'zsh') {
      const existingPromptHook = await runTrackedCommand(
        service,
        terminalId,
        "printf 'hook-boundary\\n'",
      )
      assertEqual(
        existingPromptHook.snapshot.output,
        'hook-boundary\n',
        'zsh must close capture before an inherited precmd hook prints prompt content',
      )
      assertEqual(
        existingPromptHook.result.exitCode,
        0,
        'zsh prompt hooks must not replace the command exit status',
      )
    }

    if (shellName === 'bash') {
      const existingPromptHook = await runTrackedCommand(
        service,
        terminalId,
        `printf '%s' "\${GYSHELL_EXISTING_PROMPT_COUNT:-missing}"`,
      )
      assert(
        /^\d+$/.test(existingPromptHook.snapshot.output),
        `bash must preserve and run an inherited PROMPT_COMMAND: ${JSON.stringify(existingPromptHook.snapshot.output)}`,
      )
      assertEqual(
        existingPromptHook.snapshot.capture.state,
        'complete',
        'existing Bash prompt hooks must not open a false command boundary',
      )
    }

    const markerLookalike = await runTrackedCommand(
      service,
      terminalId,
      "printf 'before__GYSHELL_READY__after\\n'",
    )
    assertEqual(
      markerLookalike.snapshot.output,
      'before__GYSHELL_READY__after\n',
      `${shellName} must preserve initialization-marker lookalikes after startup`,
    )
    assertEqual(
      markerLookalike.snapshot.capture.state,
      'complete',
      'preserving a marker lookalike must not weaken capture completeness',
    )

    const manyLines = await runTrackedCommand(service, terminalId, 'seq 1 6000')
    const numericLines = manyLines.snapshot.output.trimEnd().split('\n')
    assertEqual(
      numericLines.length,
      6000,
      `${shellName} must retain every line beyond xterm scrollback; edges=${JSON.stringify({
        head: numericLines.slice(0, 4),
        tail: numericLines.slice(-4),
        nonNumeric: numericLines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => !/^\d+$/.test(line))
          .slice(0, 8)
          .map(({ line, index }) => ({
            line,
            index,
            context: numericLines.slice(Math.max(0, index - 2), index + 3),
          })),
      })}`,
    )
    assertEqual(numericLines[0], '1', `${shellName} must retain the first line`)
    assertEqual(numericLines.at(-1), '6000', `${shellName} must retain the final line`)
    assertEqual(manyLines.snapshot.capture.state, 'complete', `${shellName} line capture must be complete`)

    const oneMiB = await runTrackedCommand(
      service,
      terminalId,
      "head -c 1048576 /dev/zero | tr '\\0' x",
      60_000,
    )
    assertEqual(
      oneMiB.snapshot.output.length,
      1_048_576,
      `${shellName} must retain a 1 MiB single line; tail=${JSON.stringify(
        oneMiB.snapshot.output.slice(-160),
      )}; capture=${JSON.stringify(oneMiB.snapshot.capture)}; result=${JSON.stringify({
        executionState: oneMiB.result.executionState,
        exitCode: oneMiB.result.exitCode,
        outputLength: oneMiB.result.stdoutDelta.length,
        terminalStatus: oneMiB.result.terminalStatus,
      })}`,
    )
    assert(/^x+$/.test(oneMiB.snapshot.output), `${shellName} single-line capture was corrupted`)
    assertEqual(oneMiB.snapshot.capture.state, 'complete', `${shellName} single-line capture must be complete`)
    assertEqual(
      oneMiB.snapshot.capture.retainedUtf8Bytes,
      1_048_576,
      `${shellName} capture byte count must be exact`,
    )
    const firstNonce = service.getCommandTask(
      terminalId,
      manyLines.result.history_command_match_id,
    )?.activeShellNonce
    const secondNonce = service.getCommandTask(
      terminalId,
      oneMiB.result.history_command_match_id,
    )?.activeShellNonce
    assert(firstNonce && secondNonce, `${shellName} must bind modern boundaries to nonces`)
    assert(firstNonce !== secondNonce, `${shellName} must not reuse a boundary nonce`)

    const unicodeText = '汉字🙂é'
    const unicode = await runTrackedCommand(
      service,
      terminalId,
      `printf '%s' '${unicodeText}'`,
    )
    assertEqual(unicode.snapshot.output, unicodeText, `${shellName} must preserve Unicode scalars exactly`)

    const controls = await runTrackedCommand(
      service,
      terminalId,
      "printf 'one\\rtwo\\rthree\\n\\033[31mred\\033[0m'",
    )
    assertEqual(
      controls.snapshot.output,
      'one\ntwo\nthree\nred',
      `${shellName} transcript projection must remain append-only`,
    )
    assertEqual(
      controls.snapshot.capture.terminalControlsObserved,
      true,
      `${shellName} must disclose stripped terminal controls`,
    )

    const terminfoReset = await runTrackedCommand(
      service,
      terminalId,
      'printf before; tput sgr0; printf after',
    )
    assertEqual(
      terminfoReset.snapshot.output,
      'beforeafter',
      `${shellName} must consume the complete ISO-2022 ESC ( B designation emitted by sgr0`,
    )
    assertEqual(
      terminfoReset.snapshot.capture.state,
      'complete',
      `${shellName} a terminated terminfo reset must remain a complete capture`,
    )

    const nonzero = await runTrackedCommand(service, terminalId, "printf failure; false")
    assertEqual(nonzero.snapshot.output, 'failure', `${shellName} must preserve nonzero output`)
    assertEqual(nonzero.result.exitCode, 1, `${shellName} must preserve the shell exit code`)
    assertEqual(nonzero.snapshot.executionState, 'finished', `${shellName} nonzero exit is still a known outcome`)

    const interleaved = await runTrackedCommand(
      service,
      terminalId,
      "printf 'stdout-'; printf 'stderr-' >&2; printf 'tail'",
    )
    assertEqual(
      interleaved.snapshot.output,
      'stdout-stderr-tail',
      `${shellName} must preserve PTY stdout/stderr arrival order`,
    )

    const whitespace = await runTrackedCommand(
      service,
      terminalId,
      "printf '\n  padded  \n\n'",
    )
    assertEqual(
      whitespace.snapshot.output,
      '\n  padded  \n\n',
      `${shellName} canonical capture must preserve leading, trailing, and blank-line whitespace; terminal_tail=${JSON.stringify(
        service.getBufferDelta(terminalId, 0).slice(-4_000),
      )}`,
    )

    await runTrackedCommand(service, terminalId, 'export GYSHELL_REAL_TEST_VALUE=survives')
    const persistentState = await runTrackedCommand(
      service,
      terminalId,
      "printf '%s' \"$GYSHELL_REAL_TEST_VALUE\"",
    )
    assertEqual(
      persistentState.snapshot.output,
      'survives',
      `${shellName} command dispatch must preserve interactive shell state`,
    )

    await runTrackedCommand(
      service,
      terminalId,
      shellName === 'bash'
        ? 'declare GYSHELL_DECLARED_PERSIST=declared'
        : 'typeset GYSHELL_DECLARED_PERSIST=declared',
    )
    const declaredState = await runTrackedCommand(
      service,
      terminalId,
      `printf '%s' "\${GYSHELL_DECLARED_PERSIST-unset}"`,
    )
    assertEqual(
      declaredState.snapshot.output,
      'declared',
      `${shellName} agent commands must retain top-level declaration semantics`,
    )

    await runTrackedCommand(service, terminalId, 'set -- first second')
    const positionalState = await runTrackedCommand(
      service,
      terminalId,
      `printf '%s|%s|%s' "$#" "$1" "$2"`,
    )
    assertEqual(
      positionalState.snapshot.output,
      '2|first|second',
      `${shellName} agent commands must mutate the interactive positional parameters`,
    )

    await runTrackedCommand(service, terminalId, 'false')
    const priorExitState = await runTrackedCommand(
      service,
      terminalId,
      `printf '%s' "$?"`,
    )
    assertEqual(
      priorExitState.snapshot.output,
      '1',
      `${shellName} hidden dispatch bookends must preserve the previous shell status`,
    )

    if (shellName === 'bash') {
      const pathSetup = await runTrackedCommand(
        service,
        terminalId,
        'GYSHELL_REAL_SAVED_PATH=$PATH; PATH=/definitely/not/here',
      )
      assertEqual(
        pathSetup.result.exitCode,
        0,
        'bash fixture must establish an unavailable PATH',
      )
      const builtinWithoutPath = await runTrackedCommand(
        service,
        terminalId,
        'builtin printf PATH_BUILTIN_OK; PATH=$GYSHELL_REAL_SAVED_PATH; unset GYSHELL_REAL_SAVED_PATH',
      )
      assertEqual(
        builtinWithoutPath.snapshot.output,
        'PATH_BUILTIN_OK',
        'bash syntax tracking must not require an external executable from PATH',
      )
      assertEqual(
        builtinWithoutPath.result.exitCode,
        0,
        'a successful bash builtin must keep exit 0 when PATH cannot resolve external env',
      )

      const topLevelLocal = await runTrackedCommand(service, terminalId, 'local GYSHELL_LOCAL=invalid')
      assert(
        (topLevelLocal.result.exitCode || 0) !== 0,
        'bash local must remain invalid at interactive top level',
      )
      const topLevelReturn = await runTrackedCommand(service, terminalId, 'return 7')
      assert(
        (topLevelReturn.result.exitCode || 0) !== 0,
        'bash return must remain invalid at interactive top level',
      )
      const extdebug = await runTrackedCommand(
        service,
        terminalId,
        'shopt -s extdebug; false; printf SHOULD_PRINT',
      )
      assertEqual(
        extdebug.snapshot.output,
        'SHOULD_PRINT',
        'bash DEBUG instrumentation must not skip payload commands under extdebug',
      )
      await runTrackedCommand(service, terminalId, 'shopt -u extdebug')

      service.write(
        terminalId,
        `trap 'printf "USER_DEBUG:%s\\n" "$BASH_COMMAND"' DEBUG\n`,
      )
      await waitUntil(
        () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'idle',
        'bash did not return to an idle prompt after installing a user DEBUG trap',
      )
      const userDebugTrap = await runTrackedCommand(
        service,
        terminalId,
        `printf 'DEBUG_PAYLOAD'`,
      )
      assertEqual(
        userDebugTrap.snapshot.output,
        `USER_DEBUG:printf 'DEBUG_PAYLOAD'\nDEBUG_PAYLOAD`,
        'bash must run a user DEBUG trap for the payload without exposing private dispatch commands',
      )
      service.write(terminalId, 'trap - DEBUG\n')
      await waitUntil(
        () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'idle',
        'bash did not return to an idle prompt after clearing the user DEBUG trap',
      )
    }

    await runTrackedCommand(
      service,
      terminalId,
      'printf GYSHELL_HISTORY_SENTINEL >/dev/null',
    )
    const history = await runTrackedCommand(service, terminalId, 'fc -ln -3')
    assert(
      history.snapshot.output.includes('GYSHELL_HISTORY_SENTINEL'),
      `${shellName} history must retain the original user command`,
    )
    assert(
      !/__gyshell_[0-9a-f]{32}_dispatch/.test(history.snapshot.output),
      `${shellName} history must not expose the private dispatch wrapper`,
    )

    const clearPromptHooks = shellName === 'bash'
      ? `PROMPT_COMMAND=''`
      : 'precmd_functions=()'
    const clearedHooks = await runTrackedCommand(
      service,
      terminalId,
      `${clearPromptHooks}; printf hook-cleared`,
    )
    assertEqual(
      clearedHooks.snapshot.output,
      'hook-cleared',
      `${shellName} clearing prompt hooks must not orphan the current command`,
    )
    const afterClearedHooks = await runTrackedCommand(service, terminalId, 'printf hook-recovered')
    assertEqual(
      afterClearedHooks.snapshot.output,
      'hook-recovered',
      `${shellName} hidden tracking must recover after prompt-hook replacement`,
    )

    const slowHookCommand = shellName === 'bash'
      ? `PROMPT_COMMAND="$PROMPT_COMMAND; sleep 0.35; printf USER_HOOK_NOISE"`
      : `gyshell_slow_precmd() { sleep 0.35; printf USER_HOOK_NOISE; }; precmd_functions+=(gyshell_slow_precmd)`
    const slowHookStartedAt = Date.now()
    const slowHook = await runTrackedCommand(service, terminalId, slowHookCommand)
    assert(
      Date.now() - slowHookStartedAt >= 300,
      `${shellName} task must not finish before user prompt hooks complete`,
    )
    assertEqual(
      slowHook.snapshot.output,
      '',
      `${shellName} prompt-hook output must stay outside the command transcript`,
    )
    await runTrackedCommand(service, terminalId, clearPromptHooks)

    const forged = await runTrackedCommand(
      service,
      terminalId,
      "printf '\\033]1337;gyshell_precmd;seq=999;nonce=forged_nonce;ec=0\\007AFTER'",
    )
    assertEqual(forged.snapshot.output, 'AFTER', `${shellName} must ignore a non-matching end boundary`)
    assertEqual(forged.snapshot.capture.state, 'complete', `${shellName} forged boundary must not end capture`)

    const malformed = await runTrackedCommand(
      service,
      terminalId,
      "printf '\\033]1337;gyshell_precmd;seq=bad;nonce=x;ec=0\\007AFTER'",
      5_000,
    )
    assertEqual(malformed.snapshot.output, 'AFTER', `${shellName} must preserve text after malformed protocol`)
    assertEqual(
      malformed.snapshot.capture.state,
      'complete',
      `${shellName} public fixed marker text is not part of the private runtime protocol`,
    )
    assertEqual(
      malformed.snapshot.capture.terminalControlsObserved,
      true,
      `${shellName} non-protocol OSC output must remain disclosed as a projected terminal control`,
    )

    const publicNameCollision = await runTrackedCommand(
      service,
      terminalId,
      'unset __gyshell_command_seq __gyshell_command_nonce __gyshell_in_command; printf collision-safe',
    )
    assertEqual(
      publicNameCollision.snapshot.output,
      'collision-safe',
      `${shellName} public legacy helper names must not mutate private runtime state`,
    )
    const afterCollision = await runTrackedCommand(service, terminalId, 'printf next-command')
    assertEqual(
      afterCollision.snapshot.output,
      'next-command',
      `${shellName} protocol state must survive public helper-name collisions`,
    )

    const parseCommand = 'echo )'
    const parseVisibleBaseline = service.getCurrentOffset(terminalId)
    focusedLiveDisplay = ''
    const parseError = await runTrackedCommand(service, terminalId, parseCommand)
    const parseLiveData = focusedLiveDisplay
    focusedLiveDisplay = undefined
    assertEqual(
      parseError.snapshot.executionState,
      'finished',
      `${shellName} a parse error must settle instead of hanging forever`,
    )
    assert(
      (parseError.result.exitCode || 0) !== 0,
      `${shellName} a parse error must retain its nonzero outcome: ${JSON.stringify({
        result: parseError.result,
        snapshot: parseError.snapshot,
      })}`,
    )
    assert(
      /(?:parse error|syntax error)/i.test(parseError.snapshot.output),
      `${shellName} a parse error must retain its diagnostic: ${JSON.stringify(parseError.snapshot.output)}`,
    )
    assert(
      !parseError.snapshot.output.includes('PROMPT_NOISE'),
      `${shellName} prompt-hook output must stay outside parse diagnostics`,
    )
    assert(
      parseError.snapshot.capture.state === 'complete' ||
        parseError.snapshot.capture.state === 'unknown',
      `${shellName} parse-error capture must be either paired-complete or explicitly unverified`,
    )
    await waitUntil(
      () => /(?:parse error|syntax error)/i.test(service.getRecentOutput(terminalId, 24)),
      `${shellName} headless terminal did not render the parse diagnostic`,
    )
    for (const surface of [
      { name: 'terminal:data', value: parseLiveData },
      { name: 'ring buffer', value: service.getBufferDelta(terminalId, parseVisibleBaseline) },
      { name: 'headless terminal', value: service.getRecentOutput(terminalId, 24) },
    ]) {
      const compactSurface = compactTerminalWhitespace(surface.value)
      const compactCommand = compactTerminalWhitespace(parseCommand)
      assertEqual(
        compactSurface.split(compactCommand).length - 1,
        1,
        `${shellName} ${surface.name} must show the parse-error command exactly once`,
      )
      assert(
        /(?:parse error|syntax error)/i.test(surface.value),
        `${shellName} ${surface.name} must retain the parse diagnostic`,
      )
      assert(
        !/__gyshell_[0-9a-f]{32}_dispatch/.test(compactSurface) &&
          !compactSurface.includes('_command_exit'),
        `${shellName} ${surface.name} exposed private dispatch text for a parse error`,
      )
    }

    const nowaitTaskId = await service.runCommandNoWait(
      terminalId,
      "for i in 1 2 3; do printf '%s' \"$i\"; sleep 0.15; done",
    )
    await waitUntil(
      () => (service.getCommandOutputSnapshot(terminalId, nowaitTaskId)?.output.length || 0) > 0,
      `${shellName} nowait command never exposed a running prefix`,
    )
    const runningPrefix = service.getCommandOutputSnapshot(terminalId, nowaitTaskId)
    assert(runningPrefix, `${shellName} missing running snapshot`)
    assertEqual(runningPrefix.executionState, 'running', `${shellName} nowait prefix must report running`)
    await waitUntil(
      () => service.getCommandOutputSnapshot(terminalId, nowaitTaskId)?.executionState === 'finished',
      `${shellName} nowait command never completed`,
    )
    const completedNowait = service.getCommandOutputSnapshot(terminalId, nowaitTaskId)
    assert(completedNowait, `${shellName} missing completed nowait snapshot`)
    assert(
      completedNowait.output.startsWith(runningPrefix.output),
      `${shellName} nowait output must grow monotonically`,
    )
    assertEqual(completedNowait.output, '123', `${shellName} nowait output must finish exactly`)

    const abortController = new AbortController()
    const abortPromise = service.runCommandAndWait(
      terminalId,
      `${clearPromptHooks}; printf before-interrupt; sleep 10`,
      { signal: abortController.signal, interruptOnAbort: true },
    )
    await waitUntil(
      () => {
        const activeTaskId = service.getActiveTaskId(terminalId)
        return activeTaskId
          ? (service.getCommandOutputSnapshot(terminalId, activeTaskId)?.output || '').includes(
              'before-interrupt',
            )
          : false
      },
      `${shellName} interrupt fixture never exposed its prefix`,
    )
    abortController.abort()
    const aborted = await abortPromise
    assertEqual(aborted.executionState, 'aborted', `${shellName} user interrupt must be typed as aborted`)
    assert(
      aborted.capture?.state !== 'complete',
      `${shellName} an immediately returned interrupt must not overclaim capture completeness`,
    )
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'idle',
      `${shellName} shell did not recover its prompt after interrupt`,
    )

    const busyTaskId = await service.runCommandNoWait(terminalId, 'sleep 0.4')
    await waitUntil(
      () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'busy',
      `${shellName} preexec never marked the shell busy`,
    )
    assertEqual(
      service.getTerminalRuntimeSnapshot(terminalId)?.canRunCommand,
      false,
      `${shellName} busy shell must reject another agent command`,
    )
    await waitUntil(
      () => service.getCommandOutputSnapshot(terminalId, busyTaskId)?.executionState === 'finished',
      `${shellName} busy-state command never completed`,
    )

    const detachedTaskId = await service.runCommandNoWait(
      terminalId,
      'seq 1 20000; sleep 30',
    )
    await waitUntil(
      () =>
        service
          .getCommandOutputSnapshot(terminalId, detachedTaskId)
          ?.output.endsWith('20000\n') === true,
      `${shellName} detached-history fixture never retained its large prefix`,
      30_000,
    )
    service.kill(terminalId)
    const detached = service.getCommandOutputSnapshot(
      terminalId,
      detachedTaskId,
    )
    assert(detached, `${shellName} terminal close discarded command history`)
    assertEqual(
      detached.executionState,
      'outcome_unknown',
      `${shellName} terminal close must not forge a definitive outcome`,
    )
    assert(
      detached.output.startsWith('1\n2\n') && detached.output.endsWith('20000\n'),
      `${shellName} terminal close must retain the exact observed transcript prefix`,
    )
    const detachedInitial = formatInitialCommandOutput({
      terminalId,
      historyCommandMatchId: detachedTaskId,
      executionState: detached.executionState,
      output: detached.output,
      capture: detached.capture,
    })
    assertEqual(
      detachedInitial.contract.presentation.state,
      'excerpt',
      `${shellName} large detached history must use bounded initial presentation`,
    )
    const detachedCursor = detachedInitial.contract.presentation.nextCursor
    assert(detachedCursor, `${shellName} detached history omitted its page cursor`)
    const detachedPage = await readCommandOutput(
      {
        tabIdOrName: terminalId,
        history_command_match_id: detachedTaskId,
        cursor: detachedCursor,
        maxBytes: 4096,
      },
      {
        sessionId: 'real-detached-history',
        messageId: `real-detached-${shellName}`,
        terminalService: service,
        sendEvent: () => {},
      } as any,
    )
    assert(
      detachedPage.includes('61\n'),
      `${shellName} detached cursor did not recover the first omitted retained line`,
    )
    assert(
      detachedPage.includes('- tab_still_exists: false'),
      `${shellName} detached paging must disclose that the visual tab is closed`,
    )
  } finally {
    service.kill(terminalId)
    if (zshFixtureDir) {
      fs.rmSync(zshFixtureDir, { recursive: true, force: true })
    }
  }
}

const run = async (): Promise<void> => {
  if (
    process.env[REAL_TEST_ENV] !== '1' &&
    !process.argv.includes(REAL_TEST_FLAG)
  ) {
    console.log(
      `SKIP real PTY tests (pass ${REAL_TEST_FLAG} or set ${REAL_TEST_ENV}=1 to run)`,
    )
    return
  }
  if (process.platform === 'win32') {
    console.log('SKIP Unix real PTY tests on Windows')
    return
  }

  const shells = ['/bin/zsh', '/bin/bash'].filter((shell) => fs.existsSync(shell))
  assert(shells.length > 0, 'No supported local shell is available for real PTY tests')
  for (const shell of shells) {
    await runShellMatrix(shell)
    console.log(`PASS real PTY command-output matrix: ${shell}`)
  }
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
