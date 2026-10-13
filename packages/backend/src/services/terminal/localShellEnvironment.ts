/** Build a new terminal's environment without reusing its parent's prompt runtime. */
export const buildLocalShellEnvironment = (
  inherited: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env = { ...inherited }
  const hasCmuxIntegration = Boolean(
    env.CMUX_SHELL_INTEGRATION_DIR ||
    env.CMUX_SHELL_INTEGRATION === '1' ||
    env.CMUX_LOAD_GHOSTTY_BASH_INTEGRATION === '1' ||
    env.CMUX_LOAD_GHOSTTY_ZSH_INTEGRATION === '1',
  )
  if (hasCmuxIntegration) {
    // cmux exports its bootstrap/prompt program, but not its Bash functions.
    // Treat the whole inherited program as parent-runtime state, not portable
    // user configuration. The new shell reloads the user's startup files.
    delete env.PROMPT_COMMAND
    // Absence means enabled to cmux's bootstrap. Keep CLI/socket context intact.
    env.CMUX_SHELL_INTEGRATION = '0'
    env.CMUX_LOAD_GHOSTTY_BASH_INTEGRATION = '0'
    env.CMUX_LOAD_GHOSTTY_ZSH_INTEGRATION = '0'
  }
  return env
}
