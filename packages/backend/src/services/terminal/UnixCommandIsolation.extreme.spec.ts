import {
  isolateUnixAgentCommand,
  shouldIsolateUnixAgentCommand,
} from './UnixCommandIsolation'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const main = async (): Promise<void> => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ['set -e; false', true],
    ['set -Ee; false', true],
    ['set -o errexit; false', true],
    ['if false; then exit 7; fi', true],
    ['for x in a; do false || exit $?; done', true],
    ['builtin exit 3', true],
    ['command exit 3', true],
    ['logout', true],
    ['exec false', true],
    [`trap 'exit 9' EXIT; false`, true],
    [`trap 'exit 9' 0; false`, true],
    [`trap 'printf x' INT`, false],
    ['exec 3>/tmp/gyshell-redirection-only', false],
    [`bash -c 'exit 7'`, false],
    [`docker exec c bash -lc 'set -e; false'`, false],
    [`printf '%s' 'exit 7'`, false],
    [`cat <<'EOF'\nexit 7\nEOF`, false],
    ['value=$(exit 7); printf x', false],
    ['( exit 7 )', false],
    ['f() { exit 7; }; printf defined', false],
    ['set +e; false', false],
    ['set -o pipefail; false | true', true],
    ['cd /tmp; export VALUE=retained', false],
    ['exit 7; if then', true],
  ]

  for (const [command, expected] of cases) {
    assertEqual(
      await shouldIsolateUnixAgentCommand(command),
      expected,
      `Unexpected Unix isolation classification for ${JSON.stringify(command)}`
    )
  }

  const isolated = isolateUnixAgentCommand("printf 'first\\n'; exit 7")
  assertEqual(
    isolated,
    "(\nprintf 'first\\n'; exit 7\n)",
    'Isolation must preserve the source verbatim inside one subshell'
  )

  console.log('PASS Unix command isolation extreme tests')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
