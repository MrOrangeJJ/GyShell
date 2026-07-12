import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NodePtyBackend } from './NodePtyBackend'
import { buildPackagedCliPathShellSnippet, PACKAGED_CLI_DIRECTORY_ENV } from './terminal/packagedCliEnvironment'

interface ShellIntegration {
  args: string[]
  envOverrides: Record<string, string>
  tmpPath?: string
}

function buildIntegration(shellPath: string): ShellIntegration {
  return (
    new NodePtyBackend() as unknown as {
      buildShellIntegration(path: string): ShellIntegration
    }
  ).buildShellIntegration(shellPath)
}

function cleanupIntegration(integration: ShellIntegration): void {
  if (integration.tmpPath) {
    fs.rmSync(integration.tmpPath, { recursive: true, force: true })
  }
}

const cliDirectory = '/opt/GyShell Test/resources/cli/bin'

if (process.platform !== 'win32' && fs.existsSync('/bin/sh')) {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-cygpath-test-'))
  const fakeCygpath = path.join(fakeBin, 'cygpath')
  fs.writeFileSync(
    fakeCygpath,
    '#!/bin/sh\n[ "$1" = -u ] || exit 2\nprintf \'/c/Program Files/GyShell/resources/cli/bin\\n\'\n',
    'utf8'
  )
  fs.chmodSync(fakeCygpath, 0o755)
  try {
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        `${buildPackagedCliPathShellSnippet('C:\\Program Files\\GyShell\\resources\\cli\\bin')}\nprintf '%s' "$PATH"`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: fakeBin },
      }
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(result.stdout, `/c/Program Files/GyShell/resources/cli/bin:${fakeBin}`)
    console.log('PASS Git Bash/MSYS drive paths are converted before PATH insertion')
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true })
  }
}

if (process.platform !== 'win32' && fs.existsSync('/bin/zsh')) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-zdotdir-test-'))
  const xdgZshDir = path.join(fakeHome, '.config', 'zsh')
  fs.mkdirSync(xdgZshDir, { recursive: true })
  fs.writeFileSync(path.join(fakeHome, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\n', 'utf8')
  fs.writeFileSync(
    path.join(xdgZshDir, '.zshrc'),
    'export PATH=/user-only\nexport GYSHELL_TEST_USER_ZSHRC=loaded\n',
    'utf8'
  )
  const originalHome = process.env.HOME
  const originalZdotDir = process.env.ZDOTDIR
  process.env.HOME = fakeHome
  delete process.env.ZDOTDIR
  const integration = buildIntegration('/bin/zsh')
  try {
    const result = spawnSync(
      '/bin/zsh',
      [
        ...integration.args,
        '-c',
        '[[ "$PATH" == "$GYSHELL_PACKAGED_CLI_DIRECTORY:"* ]] && [[ "$GYSHELL_TEST_USER_ZSHRC" == loaded ]]',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          PATH: '/parent-only',
          [PACKAGED_CLI_DIRECTORY_ENV]: cliDirectory,
          ...integration.envOverrides,
        },
      }
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    console.log('PASS XDG zsh profiles retain user config and packaged CLI precedence')
  } finally {
    cleanupIntegration(integration)
    fs.rmSync(fakeHome, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalZdotDir === undefined) delete process.env.ZDOTDIR
    else process.env.ZDOTDIR = originalZdotDir
  }
}

if (process.platform !== 'win32' && fs.existsSync('/bin/dash')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-dash-env-test-'))
  const originalEnvFile = path.join(root, 'user-env')
  fs.writeFileSync(
    originalEnvFile,
    'PATH=/user-only\nexport PATH\nGYSHELL_TEST_POSIX_ENV=loaded\nexport GYSHELL_TEST_POSIX_ENV\n',
    'utf8'
  )
  const previousEnv = process.env.ENV
  process.env.ENV = originalEnvFile
  const integration = buildIntegration('/bin/dash')
  try {
    const result = spawnSync(
      '/bin/dash',
      [
        ...integration.args,
        '-i',
        '-c',
        '[ "$PATH" = "$GYSHELL_PACKAGED_CLI_DIRECTORY:/user-only" ] && [ "$GYSHELL_TEST_POSIX_ENV" = loaded ]',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: '/parent-only',
          [PACKAGED_CLI_DIRECTORY_ENV]: cliDirectory,
          ...integration.envOverrides,
        },
      }
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    console.log('PASS POSIX ENV profiles retain user config and packaged CLI precedence')
  } finally {
    cleanupIntegration(integration)
    fs.rmSync(root, { recursive: true, force: true })
    if (previousEnv === undefined) delete process.env.ENV
    else process.env.ENV = previousEnv
  }
}

for (const [shellPath, option] of [
  ['/usr/bin/fish', '-C'],
  ['/usr/bin/nu', '-e'],
] as const) {
  const integration = buildIntegration(shellPath)
  assert.equal(integration.args[0], option)
  assert.match(integration.args[1] ?? '', /GYSHELL_PACKAGED_CLI_DIRECTORY/u)
  console.log(`PASS ${path.basename(shellPath)} receives a post-config PATH command`)
}

if (process.platform !== 'win32') {
  for (const shellPath of ['/bin/csh', '/bin/tcsh']) {
    const integration = buildIntegration(shellPath)
    try {
      assert.ok(integration.tmpPath)
      const profileName = path.basename(shellPath) === 'tcsh' ? '.tcshrc' : '.cshrc'
      const profile = fs.readFileSync(path.join(integration.tmpPath as string, profileName), 'utf8')
      assert.match(profile, /GYSHELL_PACKAGED_CLI_DIRECTORY/u)
      assert.match(profile, /source "\$HOME\//u)
      console.log(`PASS ${path.basename(shellPath)} receives a post-profile PATH wrapper`)
    } finally {
      cleanupIntegration(integration)
    }
  }
}

if (process.platform !== 'win32' && fs.existsSync('/bin/csh')) {
  const originalCliDirectory = process.env[PACKAGED_CLI_DIRECTORY_ENV]
  delete process.env[PACKAGED_CLI_DIRECTORY_ENV]
  const integration = buildIntegration('/bin/csh')
  try {
    const result = spawnSync('/bin/csh', [...integration.args, '-i', '-c', 'exit 0'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...integration.envOverrides,
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.doesNotMatch(result.stderr, /Undefined variable/u)
    console.log('PASS csh wrapper does not expand an unset packaged CLI variable')
  } finally {
    cleanupIntegration(integration)
    if (originalCliDirectory === undefined) {
      delete process.env[PACKAGED_CLI_DIRECTORY_ENV]
    } else {
      process.env[PACKAGED_CLI_DIRECTORY_ENV] = originalCliDirectory
    }
  }
}

if (process.platform !== 'win32' && fs.existsSync('/bin/tcsh')) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-tcsh-fallback-test-'))
  fs.writeFileSync(
    path.join(fakeHome, '.cshrc'),
    'setenv GYSHELL_TEST_USER_CSHRC loaded\nsetenv PATH /user-only\n',
    'utf8'
  )
  const originalHome = process.env.HOME
  const originalCliDirectory = process.env[PACKAGED_CLI_DIRECTORY_ENV]
  process.env.HOME = fakeHome
  process.env[PACKAGED_CLI_DIRECTORY_ENV] = cliDirectory
  const integration = buildIntegration('/bin/tcsh')
  try {
    const result = spawnSync(
      '/bin/tcsh',
      [
        ...integration.args,
        '-i',
        '-c',
        'if ( "$GYSHELL_TEST_USER_CSHRC" != loaded ) exit 7; if ( "$path[1]" != "$GYSHELL_PACKAGED_CLI_DIRECTORY" ) exit 8',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...integration.envOverrides,
        },
      }
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    console.log('PASS tcsh wrapper retains the native .cshrc fallback and CLI precedence')
  } finally {
    cleanupIntegration(integration)
    fs.rmSync(fakeHome, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalCliDirectory === undefined) {
      delete process.env[PACKAGED_CLI_DIRECTORY_ENV]
    } else {
      process.env[PACKAGED_CLI_DIRECTORY_ENV] = originalCliDirectory
    }
  }
}

console.log('All packaged CLI shell integration tests passed.')
