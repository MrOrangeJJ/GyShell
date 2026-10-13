import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { TerminalService } from './TerminalService'

const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

const foreignEnvironment = {
  CMUX_BUNDLE_ID: 'com.cmuxterm.app',
  CMUX_SHELL_INTEGRATION: '1',
  CMUX_LOAD_GHOSTTY_BASH_INTEGRATION: '1',
  CMUX_SHELL_INTEGRATION_DIR: '/fixture/cmux/shell-integration',
}

const runCase = async (
  name: string,
  inheritedEnvironment: Record<string, string>,
  bashrc: string,
  expectedHook: string,
  shell = '/bin/bash',
): Promise<void> => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-parent-hooks-'))
  const service = new TerminalService()
  const terminalId = `parent-hooks-${name}-${process.pid}`
  const savedEnvironment = { ...process.env }
  let transcript = ''
  service.setRawEventPublisher((channel, payload) => {
    const event = payload as { terminalId?: string; data?: string }
    if (channel === 'terminal:data' && event.terminalId === terminalId) {
      transcript += event.data || ''
    }
  })
  try {
    fs.writeFileSync(path.join(fixture, '.bash_profile'), '', 'utf8')
    fs.writeFileSync(path.join(fixture, '.bashrc'), bashrc, 'utf8')
    // Keep the host's launch environment and dotfiles out of this fixture.
    for (const key of Object.keys(process.env)) {
      if (/^(CMUX_|GHOSTTY_|PROMPT_COMMAND$|BASH_ENV$|ENV$)/.test(key)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, inheritedEnvironment, { HOME: fixture, HISTFILE: '/dev/null' })
    try {
      await service.createTerminal({
        type: 'local', id: terminalId, title: name,
        shell, cwd: fixture, cols: 120, rows: 24,
      })
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnvironment)) delete process.env[key]
      }
      Object.assign(process.env, savedEnvironment)
    }
    await waitUntil(
      () => transcript.includes('FIXTURE_PROMPT>'),
      `${name}: shell did not display its first prompt`,
    )
    assert.doesNotMatch(transcript, /(?:__bp_\w+|_cmux_\w+): command not found/, name)
    assert.ok(transcript.includes(expectedHook), `${name}: user hook did not run`)
    assert.ok(!transcript.includes('FOREIGN_BOOTSTRAP_RAN'), `${name}: foreign bootstrap ran`)

    const runCommand = async (command: string) => {
      await waitUntil(
        () => service.getTerminalRuntimeSnapshot(terminalId)?.shellInputState === 'idle',
        `${name}: shell is not ready for the next command`,
      ).catch((error) => {
        throw new Error(`${error}; runtime=${JSON.stringify(service.getTerminalRuntimeSnapshot(terminalId))}; transcript=${JSON.stringify(transcript.slice(-4000))}`)
      })
      const taskId = await service.runCommandNoWait(terminalId, command)
      await waitUntil(
        () => service.getCommandOutputSnapshot(terminalId, taskId)?.executionState === 'finished',
        `${name}: command did not complete: ${command}`,
      )
      const result = await service.waitForTask(terminalId, taskId)
      const snapshot = service.getCommandOutputSnapshot(terminalId, taskId)
      assert.ok(snapshot, `${name}: command snapshot is missing`)
      return { exitCode: result.exitCode, output: snapshot.output }
    }
    const result = await runCommand('printf "TRACKED_OUTPUT\\n"; (exit 7)')
    assert.equal(result.exitCode, 7, `${name}: prompt hook changed command exit status`)
    assert.equal(result.output.trim(), 'TRACKED_OUTPUT', `${name}: prompt noise entered command output`)

    await runCommand('export PROMPT_COMMAND')
    const exported = await runCommand(
      '/bin/bash --noprofile --norc -c \'printf "CHILD_PROMPT=%s" "${PROMPT_COMMAND-unset}"\'',
    )
    assert.equal(exported.output.trim(), 'CHILD_PROMPT=unset', `${name}: runtime hooks leaked to a child`)

    // Exercise a real nested interactive shell, including its first prompt.
    const nestedStart = transcript.length
    const nestedTaskId = await service.runCommandNoWait(terminalId, '/bin/bash --noprofile --norc -i')
    await waitUntil(
      () => /bash-[\d.]+[$#] /.test(transcript.slice(nestedStart)),
      `${name}: nested shell did not display a prompt`,
    )
    assert.doesNotMatch(transcript.slice(nestedStart), /command not found/, `${name}: broken nested prompt`)
    await service.writeInputSequence(terminalId, ['exit\r'], { inputOwner: 'active-task' })
    await waitUntil(
      () => service.getCommandOutputSnapshot(terminalId, nestedTaskId)?.executionState === 'finished',
      `${name}: parent shell did not resume`,
    )
    assert.equal((await runCommand('printf RESUMED')).output.trim(), 'RESUMED')
    console.log(`PASS real PTY parent-hook isolation: ${name}`)
  } finally {
    service.kill(terminalId)
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

const run = async (): Promise<void> => {
  if (!process.argv.includes('--run-real-pty')) {
    console.log('SKIP parent-hook PTY tests (pass --run-real-pty to run)')
    return
  }
  if (process.platform === 'win32' || !fs.existsSync('/bin/bash')) {
    console.log('SKIP parent-hook PTY tests: /bin/bash is unavailable')
    return
  }
  const userConfig = [
    "PS1='FIXTURE_PROMPT> '",
    'user_precmd() { printf USER_HOOK; }',
    'PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }user_precmd"',
    '',
  ].join('\n')
  await runCase('initialized-cmux', {
    ...foreignEnvironment,
    PROMPT_COMMAND: '__bp_precmd_invoke_cmd; _cmux_prompt_command; __bp_interactive_mode',
  }, userConfig, 'USER_HOOK')
  await runCase('pending-cmux-bootstrap', {
    ...foreignEnvironment,
    PROMPT_COMMAND: 'printf FOREIGN_BOOTSTRAP_RAN; PROMPT_COMMAND=_cmux_prompt_command; : __cmux_bash_bootstrap_marker__',
  }, userConfig, 'USER_HOOK')
  const installedBootstrap = '/Applications/cmux.app/Contents/Resources/shell-integration/cmux-bash-bootstrap.bash'
  if (fs.existsSync(installedBootstrap)) {
    await runCase('installed-cmux-bootstrap', {
      ...foreignEnvironment,
      PROMPT_COMMAND: fs.readFileSync(installedBootstrap, 'utf8'),
    }, userConfig, 'USER_HOOK')
  }
  await runCase('ordinary-inherited-hook', {
    PROMPT_COMMAND: 'printf INHERITED_USER_HOOK',
  }, userConfig, 'INHERITED_USER_HOOK')
  // PROMPT_COMMAND arrays are executed as arrays only in Bash 5.1 and later.
  const arrayShell = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'].find((shell) => {
    if (!fs.existsSync(shell)) return false
    const version = execFileSync(shell, ['--noprofile', '--norc', '-c', 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], { encoding: 'utf8' })
    const [major, minor] = version.split('.').map(Number)
    return major > 5 || (major === 5 && minor >= 1)
  })
  if (arrayShell) {
    await runCase('exported-user-array', {}, [
      "PS1='FIXTURE_PROMPT> '",
      'user_precmd() { printf ARRAY_USER_HOOK; }',
      'PROMPT_COMMAND=(user_precmd)',
      'export PROMPT_COMMAND',
      '',
    ].join('\n'), 'ARRAY_USER_HOOK', arrayShell)
  } else {
    console.log('SKIP array prompt hooks: Bash 5.1 or later is unavailable')
  }
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
