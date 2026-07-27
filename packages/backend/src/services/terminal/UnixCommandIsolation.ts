import type { Node as SyntaxNode } from 'web-tree-sitter'

const SHELL_ISOLATING_ANCESTORS = new Set([
  'command_substitution',
  'process_substitution',
  'subshell',
])

const getCommandWords = (node: SyntaxNode): string[] => {
  const words: string[] = []
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (!child) continue
    if (
      child.type === 'command_name' ||
      child.type === 'word' ||
      child.type === 'number' ||
      child.type === 'string' ||
      child.type === 'raw_string' ||
      child.type === 'concatenation'
    ) {
      words.push(child.text)
    }
  }
  return words
}

const runsInCurrentShell = (node: SyntaxNode): boolean => {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (SHELL_ISOLATING_ANCESTORS.has(ancestor.type)) return false
    // Defining a function does not execute its body. Calls through a function
    // name remain intentionally dynamic and cannot be proven from this input.
    if (ancestor.type === 'function_definition') return false
  }
  return true
}

const changesPersistentShellOptions = (args: readonly string[]): boolean => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (
      arg === '-o' &&
      (args[index + 1] === 'errexit' || args[index + 1] === 'pipefail')
    ) return true
    if (/^-[A-Za-z]*e[A-Za-z]*$/.test(arg)) return true
  }
  return false
}

const changesExitTrap = (args: readonly string[]): boolean =>
  args.slice(1).some((arg) => arg === 'EXIT' || arg === '0')

const commandCanTerminateCurrentShell = (node: SyntaxNode): boolean => {
  const words = getCommandWords(node)
  if (words.length === 0) return false

  let name = words[0]
  let args = words.slice(1)
  if ((name === 'builtin' || name === 'command') && args.length > 0) {
    name = args[0]
    args = args.slice(1)
  }

  if (name === 'exit' || name === 'logout') return true
  if (name === 'exec') {
    // Redirection-only exec mutates the current shell's descriptors but does
    // not replace it. Isolate only exec invocations that name a program.
    return args.length > 0
  }
  if (name === 'trap') return changesExitTrap(args)
  return name === 'set' && changesPersistentShellOptions(args)
}

/**
 * Returns true when this input directly contains a builtin that can terminate
 * or persistently alter GyShell's long-lived interactive Unix shell. Quoted
 * nested shell programs, heredocs, command substitutions, and explicit
 * subshells are not attributed to the parent shell.
 */
export const shouldIsolateUnixAgentCommand = async (
  command: string
): Promise<boolean> => {
  try {
    // Keep parser/WASM loading off TerminalService module initialization and
    // all non-SSH command paths, including legacy CommonJS test harnesses.
    const { getBashParser } = await import('../CommandPolicy/commandParser')
    const parser = await getBashParser()
    const tree = parser.parse(command)
    if (!tree) return false
    return tree.rootNode
      .descendantsOfType('command')
      .some(
        (node: SyntaxNode) =>
          runsInCurrentShell(node) && commandCanTerminateCurrentShell(node)
      )
  } catch {
    // Classification must not turn a parser/runtime availability problem into
    // a rejected or semantically changed terminal command.
    return false
  }
}

export const isolateUnixAgentCommand = (command: string): string =>
  `(\n${command}\n)`
