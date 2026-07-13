export const WRITE_STDIN_TOOL_DESCRIPTION = [
  'Send characters to a specific terminal tab WITHOUT a trailing newline.',
  'If the target terminal tab is disconnected or not ready, this tool returns an explicit terminal_status instead of pretending input was sent.',
  'This is a specialized, advanced tool for control/interactive programs (e.g. vim, tmux, REPLs) and for sending C0 control characters like Ctrl+C.',
  'For normal commands, always use exec_command/run_command instead.',
  '',
  'Send a list of items in order. Each item may be either:',
  '- a normal string (any length), or',
  '- a C0 control character name (must be the whole item).',
  'If an item is a C0 name, it MUST be its own list item.',
  'Example: ["helloworld", "ESC", ":wq"]',
  'Example: ["CAN", "DC3"] sends Ctrl+X then Ctrl+S',
  '',
  'Available C0 control characters (name -> meaning [Common Key]):',
  'NUL: Null',
  'SOH: Start of Heading [Ctrl+A]',
  'STX: Start of Text [Ctrl+B]',
  'ETX: End of Text [Ctrl+C]',
  'EOT: End of Transmission [Ctrl+D]',
  'ENQ: Enquiry [Ctrl+E]',
  'ACK: Acknowledge [Ctrl+F]',
  'BEL: Bell [Ctrl+G]',
  'BS: Backspace [Ctrl+H]',
  'HT: Horizontal Tab [Tab / Ctrl+I]',
  'LF: Line Feed [Ctrl+J]',
  'VT: Vertical Tab [Ctrl+K]',
  'FF: Form Feed [Ctrl+L]',
  'CR: Carriage Return [Enter / Ctrl+M]',
  'SO: Shift Out [Ctrl+N]',
  'SI: Shift In [Ctrl+O]',
  'DLE: Data Link Escape [Ctrl+P]',
  'DC1: Device Control 1 (XON) [Ctrl+Q]',
  'DC2: Device Control 2 [Ctrl+R]',
  'DC3: Device Control 3 (XOFF) [Ctrl+S]',
  'DC4: Device Control 4 [Ctrl+T]',
  'NAK: Negative Acknowledge [Ctrl+U]',
  'SYN: Synchronous Idle [Ctrl+V]',
  'ETB: End of Transmission Block [Ctrl+W]',
  'CAN: Cancel [Ctrl+X]',
  'EM: End of Medium [Ctrl+Y]',
  'SUB: Substitute [Ctrl+Z]',
  'ESC: Escape [ESC / Ctrl+[]',
  'FS: File Separator [Ctrl+\\]',
  'GS: Group Separator [Ctrl+]]',
  'RS: Record Separator [Ctrl+^]',
  'US: Unit Separator [Ctrl+_]',
  'DEL: Delete'
].join('\n')

export const WRITE_FILE_TOOL_DESCRIPTION = [
  'Create or overwrite a file by writing the full file content.',
  'If the target terminal tab is disconnected or not ready, this tool returns an explicit terminal_status and does not modify files.',
  'Use this tool when you need to create a new file or intentionally replace the entire contents of an existing file.',
  '',
  'Key rules:',
  '- Always provide the complete desired file content in content.',
  '- Do not use this tool for small targeted replacements inside an existing file; use edit_file instead.',
  '- Use absolute paths when possible; relative paths resolve from the tab working directory.',
  '',
  'Inputs:',
  '- tabIdOrName: ID or name of the terminal tab.',
  '- filePath: file path to create or overwrite.',
  '- content: full file contents to write.'
].join('\n')

export const EDIT_FILE_TOOL_DESCRIPTION = [
  'Edit a file by replacing an exact string with another string.',
  'If the target terminal tab is disconnected or not ready, this tool returns an explicit terminal_status and does not modify files.',
  'Use this tool for targeted changes to existing files.',
  '',
  'Key rules:',
  '- oldString must match the file exactly, including indentation and line breaks.',
  '- newString must be different from oldString.',
  '- If oldString appears multiple times, include more surrounding context or set replaceAll=true.',
  '- Use absolute paths when possible; relative paths resolve from the tab working directory.',
  '',
  'Inputs:',
  '- tabIdOrName: ID or name of the terminal tab.',
  '- filePath: file path to edit.',
  '- oldString: exact text to replace.',
  '- newString: replacement text.',
  '- replaceAll: replace every occurrence of oldString.'
].join('\n')

export const CREATE_OR_EDIT_TOOL_DESCRIPTION = [
  'File creation and editing capability. When enabled, the agent may use write_file to create or overwrite full files and edit_file to replace exact strings in files.',
  'This is a user-visible permission setting, not a model-facing tool name.'
].join('\n')

export const EXEC_COMMAND_DESCRIPTION =
  'Execute a shell command in a specific terminal tab. This appends a trailing "\\n" to run the command automatically. If you do NOT want auto-execute, use write_stdin instead. You must provide waitMode: "wait" (synchronous; wait for command result) or "nowait" (asynchronous; return immediately). If the terminal is disconnected or not ready, the tool returns an explicit terminal_status and does not run the command. Command output may be truncated; use read_command_output with history_command_match_id and terminalId to read full output.'
export const READ_TERMINAL_TAB_DESCRIPTION =
  'Read the recent visible output and runtime status of a specific terminal tab. If the tab is disconnected, the output is retained history and may be stale.'
export const READ_COMMAND_OUTPUT_DESCRIPTION =
  'Read historical output of a specific command by history_command_match_id and terminal tab. Supports offset/limit for paging large outputs. The result includes terminal_status so you can tell whether the tab is still connected.'
export const READ_FILE_DESCRIPTION =
  'Read a file from a specific terminal tab. If the terminal is disconnected or not ready, the tool returns an explicit terminal_status instead of a raw backend session error.'
export const WAIT_TOOL_DESCRIPTION =
  "Pause execution for a specified number of seconds (5-120). Use this for short, fixed-duration pauses when you need to wait for an external event that doesn't affect the terminal (e.g., waiting for a web server to start up)."
export const WAIT_TERMINAL_IDLE_DESCRIPTION =
  "Wait until the terminal output becomes stable (no changes for a few seconds) or a timeout (120s) is reached. Use this for commands that don't emit standard OSC exit markers but eventually stop printing text (e.g., some build tools or log watchers). If the terminal is disconnected or not ready, the tool returns an explicit terminal_status instead of treating stale output as idle."
export const RECONNECT_TERMINAL_TAB_DESCRIPTION = [
  'Attempt to reconnect an existing disconnected SSH terminal tab that has not been closed by the user.',
  'Use this when a terminal-targeting tool reports terminal_status with runtime_state=exited and reconnectable=true, or when the user asks to reconnect that tab.',
  'This preserves the same terminal tab id and retained output buffer. It does not recreate tabs that were closed by the user, and it only supports disconnected SSH tabs.',
  'After reconnect succeeds, verify the remote working directory and environment before continuing.'
].join('\n')
export const CREATE_TERMINAL_TAB_DESCRIPTION = [
  "Create a new terminal tab from one of the user's saved connection options.",
  'Use the exact connectionId shown in the dynamically generated saved connection list. Local creates a new local shell; SSH creates a new connection using credentials and routing settings stored by GyShell.',
  'This is an experimental, side-effecting tool. Its availability means the user already enabled and accepted the risk, so do not request another approval before calling it.',
  'A newly created SSH terminal may still be initializing. Use the returned terminal id for later terminal tools and verify the working directory and environment before continuing.'
].join('\n')
export const CLOSE_TERMINAL_TAB_DESCRIPTION = [
  'Close an existing terminal tab and terminate its backend session.',
  'This can stop running commands, disconnect SSH, cancel terminal-scoped transfers, and close port forwards. The closed tab and retained terminal output are removed from GyShell.',
  'This is an experimental, destructive tool. Its availability means the user already enabled and accepted the risk, so do not request another approval before calling it.',
  'Use the exact terminal tab id or an unambiguous tab name.'
].join('\n')
export const COPY_BETWEEN_TABS_DESCRIPTION = [
  'Start an asynchronous file copy between two different terminal tabs on different machines. Use this only for cross-terminal-tab file transfer; do not use it for copying within one tab or between two tabs connected to the same machine.',
  'If either source or target terminal is disconnected or not ready, this tool returns an explicit terminal_status for that side and does not start a transfer.',
  'This tool supports copy only. It never cuts, moves, or deletes source files.',
  'It returns immediately after the transfer task is queued. It does not wait for scanning or file bytes to finish. Use read_file_transfer_status with the returned transferId to monitor progress or verify final status.',
  'Default conflictStrategy is "rename" to keep both files. Use "overwrite" only when the user explicitly asked to replace target files.'
].join('\n')
export const READ_FILE_TRANSFER_STATUS_DESCRIPTION =
  'Read progress and final status for file transfer tasks started by copy_between_tabs. Use transferId to inspect one transfer, or omit it to list active transfers for this agent run.'

export interface BuiltInToolInfo {
  name: string
  agentDescription: string
  userDescription: string
  defaultEnabled?: boolean
  experimental?: boolean
}

export const BUILTIN_TOOL_INFO: readonly BuiltInToolInfo[] = [
  {
    name: 'exec_command',
    agentDescription: EXEC_COMMAND_DESCRIPTION,
    userDescription: 'Run a shell command in a terminal tab.'
  },
  {
    name: 'read_terminal_tab',
    agentDescription: READ_TERMINAL_TAB_DESCRIPTION,
    userDescription: 'Read recent output from a terminal tab.'
  },
  {
    name: 'read_command_output',
    agentDescription: READ_COMMAND_OUTPUT_DESCRIPTION,
    userDescription: 'Read saved output from a previously run command.'
  },
  {
    name: 'read_file',
    agentDescription: READ_FILE_DESCRIPTION,
    userDescription: 'Read supported files from a terminal tab.'
  },
  {
    name: 'write_stdin',
    agentDescription: WRITE_STDIN_TOOL_DESCRIPTION,
    userDescription: 'Send text or control keys to an interactive terminal.'
  },
  {
    name: 'reconnect_terminal_tab',
    agentDescription: RECONNECT_TERMINAL_TAB_DESCRIPTION,
    userDescription: 'Reconnect a disconnected SSH terminal tab.'
  },
  {
    name: 'create_terminal_tab',
    agentDescription: CREATE_TERMINAL_TAB_DESCRIPTION,
    userDescription: 'Create a terminal tab from a saved connection.',
    defaultEnabled: false,
    experimental: true
  },
  {
    name: 'close_terminal_tab',
    agentDescription: CLOSE_TERMINAL_TAB_DESCRIPTION,
    userDescription: 'Close a terminal tab and end its session.',
    defaultEnabled: false,
    experimental: true
  },
  {
    name: 'create_or_edit',
    agentDescription: CREATE_OR_EDIT_TOOL_DESCRIPTION,
    userDescription: 'Create, overwrite, or edit files in a terminal tab.'
  },
  {
    name: 'wait',
    agentDescription: WAIT_TOOL_DESCRIPTION,
    userDescription: 'Pause the agent for a short, fixed duration.'
  },
  {
    name: 'wait_terminal_idle',
    agentDescription: WAIT_TERMINAL_IDLE_DESCRIPTION,
    userDescription: 'Wait for terminal output to become idle.'
  },
  {
    name: 'copy_between_tabs',
    agentDescription: COPY_BETWEEN_TABS_DESCRIPTION,
    userDescription: 'Copy files between terminal tabs on different machines.',
    defaultEnabled: false,
    experimental: true
  },
  {
    name: 'read_file_transfer_status',
    agentDescription: READ_FILE_TRANSFER_STATUS_DESCRIPTION,
    userDescription: 'Check the progress of agent-initiated file transfers.',
    defaultEnabled: false,
    experimental: true
  }
]

export function getBuiltInToolAgentDescription(name: string): string {
  return BUILTIN_TOOL_INFO.find((tool) => tool.name === name)?.agentDescription ?? ''
}

export function buildReadFileDescription(support: { image: boolean }): string {
  const imageLine = support.image
    ? 'Image: Supported PNG/JPG/JPEG/GIF/WEBP'
    : 'Image: Not supported'
  return [
    'Prioritize using this tool to read files; only if the file we need to read is not supported by this tool should we consider other methods.',
    'Use offset/limit to read large files in chunks.',
    'Read a file from a specific terminal tab. It supports reading all common text file, plus',
    'PDF: Supported',
    imageLine
  ].join('\n')
}
