export const PACKAGED_CLI_DIRECTORY_ENV = 'GYSHELL_PACKAGED_CLI_DIRECTORY'

/**
 * Re-assert the packaged CLI directory after interactive shell profiles run.
 * Profiles are allowed to replace PATH, so setting only the parent process
 * environment is insufficient for the local terminal embedded in GyShell.
 */
export function buildPackagedCliPathShellSnippet(packagedCliDirectory?: string): string {
  const directoryValue = packagedCliDirectory
    ? quotePosixShellLiteral(packagedCliDirectory)
    : `"\${${PACKAGED_CLI_DIRECTORY_ENV}:-}"`
  return [
    `__gyshell_packaged_cli_dir=${directoryValue}`,
    // Git Bash/MSYS and Cygwin need a POSIX path. A raw Windows drive path
    // would otherwise be split at its colon when inserted into PATH.
    'case "$__gyshell_packaged_cli_dir" in',
    '  [A-Za-z]:\\\\*|[A-Za-z]:/*)',
    '    if command -v cygpath >/dev/null 2>&1; then',
    '      __gyshell_packaged_cli_posix_dir=$(cygpath -u "$__gyshell_packaged_cli_dir" 2>/dev/null || true)',
    '      if [ -n "$__gyshell_packaged_cli_posix_dir" ]; then',
    '        __gyshell_packaged_cli_dir=$__gyshell_packaged_cli_posix_dir',
    '      fi',
    '      unset __gyshell_packaged_cli_posix_dir',
    '    fi',
    '    ;;',
    'esac',
    'if [ -n "$__gyshell_packaged_cli_dir" ]; then',
    '  case "${PATH:-}" in',
    '    "$__gyshell_packaged_cli_dir"|"$__gyshell_packaged_cli_dir":*) ;;',
    '    *) export PATH="$__gyshell_packaged_cli_dir${PATH:+:${PATH}}" ;;',
    '  esac',
    'fi',
    'unset __gyshell_packaged_cli_dir',
  ].join('\n')
}

export function buildPackagedCliFishInitCommand(packagedCliDirectory?: string): string {
  if (packagedCliDirectory) {
    return `set -l __gyshell_packaged_cli_dir ${quoteFishShellLiteral(packagedCliDirectory)}; set -gx PATH "$__gyshell_packaged_cli_dir" $PATH; set -e __gyshell_packaged_cli_dir`
  }
  const directoryReference = `$${PACKAGED_CLI_DIRECTORY_ENV}`
  return `if set -q ${PACKAGED_CLI_DIRECTORY_ENV}; set -gx PATH "${directoryReference}" $PATH; end`
}

export function buildPackagedCliNushellInitCommand(packagedCliDirectory?: string): string {
  if (packagedCliDirectory) {
    return `$env.PATH = ($env.PATH | prepend ${JSON.stringify(packagedCliDirectory)})`
  }
  return `if ('${PACKAGED_CLI_DIRECTORY_ENV}' in $env) { $env.PATH = ($env.PATH | prepend $env.${PACKAGED_CLI_DIRECTORY_ENV}) }`
}

export function quotePosixShellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function quoteFishShellLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
