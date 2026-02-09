import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { TerminalTab } from '../../types'
import { z } from 'zod'

/**
 * Prompt constants and utilities for AgentService_v2
 */

export const SYS_INFO_MARKER = 'SYSTEM_INFO_MSG:\n'
export const TAB_CONTEXT_MARKER = 'TAB_CONTEXT_MSG:\n'
export const USER_INPUT_TAG = 'USER_REQUEST_IS:\n'
export const USER_INSERTED_INPUT_TAG = 'USER_INTERRUPT_INSERTED_REQUEST:\n'
export const CONTINUE_INSTRUCTION_TAG = 'AGENT_CONTINUE_INSTRUCTION:\n'
export const USER_INPUT_TAGS = [USER_INPUT_TAG, USER_INSERTED_INPUT_TAG] as const
export const NORMAL_USER_INPUT_TAGS = [USER_INPUT_TAG] as const
export const USER_INSERTED_INPUT_INSTRUCTION =
  'The user inserted a message mid-run. Based on the latest input, decide whether to adjust and continue the previous task, or stop the previous path and switch to a new task.'

export function hasAnyUserInputTag(content: unknown): boolean {
  if (typeof content !== 'string') return false
  return USER_INPUT_TAGS.some((tag) => content.includes(tag))
}

export function hasAnyNormalUserInputTag(content: unknown): boolean {
  if (typeof content !== 'string') return false
  return NORMAL_USER_INPUT_TAGS.some((tag) => content.includes(tag))
}


export const USEFUL_SKILL_TAG = 'USEFUL_SKILL_DETAIL:\n'
export const FILE_CONTENT_TAG = 'FILE_CONTENT:\n'
export const TERMINAL_CONTENT_TAG = 'TERMINAL_CONTENT:\n'
export const USER_PASTE_CONTENT_TAG = FILE_CONTENT_TAG

// --- Tool Descriptions ---

export const WRITE_STDIN_TOOL_DESCRIPTION = [
  'Send characters to a specific terminal tab WITHOUT a trailing newline.',
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

export const CREATE_OR_EDIT_TOOL_DESCRIPTION = [
  'Create or edit a file. Use write mode to replace the full file content, or edit mode to replace a specific string.',
  'If you need to create/write something into a file or edit a file, you MUST use this tool.',
  '',
  'Key rules:',
  '- For edit mode: provide oldString and newString. oldString must match the file exactly (including indentation and line breaks).',
  '- If oldString appears multiple times, include more context or set replaceAll=true.',
  '- For write mode: provide content (full file contents).',
  '- Use absolute paths when possible; relative paths resolve from the tab working directory.',
  '',
  'Inputs:',
  '- tabIdOrName: ID or name of the terminal tab.',
  '- filePath: file path to write/edit.',
  '- content: full file contents (write mode).',
  '- oldString/newString: exact text to replace (edit mode).',
  '- replaceAll: replace every occurrence in edit mode.'
].join('\n')

export const EXEC_COMMAND_DESCRIPTION =
  'Execute a shell command in a specific terminal tab. This appends a trailing "\\n" to run the command automatically. If you do NOT want auto-execute, use write_stdin instead. The system will decide whether to wait for completion. Command output may be truncated; use read_command_output with history_command_match_id and terminalId to read full output.'
export const READ_TERMINAL_TAB_DESCRIPTION = 'Read the recent visible output of a specific terminal tab.'
export const READ_COMMAND_OUTPUT_DESCRIPTION =
  'Read historical output of a specific command by history_command_match_id and terminal tab. Supports offset/limit for paging large outputs.'
export const READ_FILE_DESCRIPTION = 'Read a file from a specific terminal tab.'
export const WAIT_TOOL_DESCRIPTION = 'Pause execution for a specified number of seconds (5-60). Use this for short, fixed-duration pauses when you need to wait for an external event that doesn\'t affect the terminal (e.g., waiting for a web server to start up).'
export const WAIT_TERMINAL_IDLE_DESCRIPTION = 'Wait until the terminal output becomes stable (no changes for a few seconds) or a timeout (120s) is reached. Use this for commands that don\'t emit standard OSC exit markers but eventually stop printing text (e.g., some build tools or log watchers).'
export const WAIT_COMMAND_END_DESCRIPTION = 'Wait for the currently running command in the terminal tab to finish based on shell integration markers. This is the most reliable way to wait for a command that was started with nowait. Use this when you need the command\'s exit code and final output to proceed.'

export const BUILTIN_TOOL_INFO = [
  {
    name: 'exec_command',
    description: EXEC_COMMAND_DESCRIPTION
  },
  {
    name: 'read_terminal_tab',
    description: READ_TERMINAL_TAB_DESCRIPTION
  },
  {
    name: 'read_command_output',
    description: READ_COMMAND_OUTPUT_DESCRIPTION
  },
  {
    name: 'read_file',
    description: READ_FILE_DESCRIPTION
  },
  {
    name: 'write_stdin',
    description: WRITE_STDIN_TOOL_DESCRIPTION
  },
  {
    name: 'create_or_edit',
    description: CREATE_OR_EDIT_TOOL_DESCRIPTION
  },
  {
    name: 'wait',
    description: WAIT_TOOL_DESCRIPTION
  },
  {
    name: 'wait_terminal_idle',
    description: WAIT_TERMINAL_IDLE_DESCRIPTION
  },
  {
    name: 'wait_command_end',
    description: WAIT_COMMAND_END_DESCRIPTION
  }
]

export function buildReadFileDescription(support: { image: boolean }): string {
  const imageLine = support.image ? 'Image: Supported PNG/JPG/JPEG/GIF/WEBP' : 'Image: Not supported'
  return [
    'Prioritize using this tool to read files; only if the file we need to read is not supported by this tool should we consider other methods.',
    'Use offset/limit to read large files in chunks.',
    'Read a file from a specific terminal tab. It supports reading all common text file, plus',
    'PDF: Supported',
    imageLine,
  ].join('\n')
}


/**
 * Action model decision schema for exec_command.
 * Keep it here to keep AgentService_v2 minimal.
 */
export const COMMAND_POLICY_DECISION_SCHEMA = z.object({
  decision: z.enum(['wait', 'nowait']),
  reason: z.string()
})

/**
 * Action model decision schema for write_stdin.
 */
export const WRITE_STDIN_POLICY_DECISION_SCHEMA = z.object({
  decision: z.enum(['allow', 'block']),
  reason: z.string()
})

export const TASK_COMPLETION_DECISION_SCHEMA = z.object({
  is_fully_completed: z.boolean(),
  reason: z.string()
})

export const TASK_CONTINUE_INSTRUCTION_SCHEMA = z.object({
  continue_instruction: z.string()
})

/**
 * Create a system information prompt that lists available terminal tabs and their system info
 */
export function createSystemInfoPrompt(tabs: TerminalTab[]): HumanMessage {
  const tabInfos = tabs.map(t => {
    let base = `- ID: ${t.id}, Name: ${t.title}, Type: ${t.type}`
    if (t.systemInfo) {
      const s = t.systemInfo
      base += ` (OS: ${s.os}, Release: ${s.release}, Arch: ${s.arch}, Hostname: ${s.hostname}, ${s.isRemote ? 'Remote' : 'Local'})`
    }
    return base
  }).join('\n')

  const sysInfoText = `${SYS_INFO_MARKER}\nAvailable Terminal Tabs:\n${tabInfos}`
  
  return new HumanMessage(sysInfoText)
}

/**
 * Create a tab context prompt with the current tab's recent output
 */
export function createTabContextPrompt(tab: TerminalTab | undefined, recentOutput: string): HumanMessage {
  const tabId = tab?.id
  let contextText = `${TAB_CONTEXT_MARKER}\nYou are currently operating in the following terminal tab:
- Title: ${tab?.title || 'None'}
- ID: ${tabId || 'None'}
- Type: ${tab?.type || 'None'}`
  
  if (tab) {
    if (tab.remoteOs) contextText += `\n- Remote OS: ${tab.remoteOs}`
    if (tab.systemInfo) contextText += `\n- System Info: ${tab.systemInfo}`
    
    contextText += `\n\nThe following is the current visible state of this terminal tab:
${recentOutput || '(No output available)'}`
  }
  
  return new HumanMessage(contextText)
}


/**
 * System prompt for the main Agent.
 */
export function createBaseSystemPrompt(): SystemMessage {
  return new SystemMessage(
    [
      '# Role: GyShell Assistant',
      'You are GyShell Assistant, an AI-native shell assistant. Your mission is to help users accomplish tasks efficiently through the terminal.',
      '',
      '# Core Responsibility',
      'Your primary task is to fulfill user requests by utilizing all tools at your disposal. You must strictly adhere to the usage instructions and constraints defined in each tool\'s description.',
      '',
      '# Execution & Verification',
      '- **Completeness**: You must complete the user\'s request fully. Do not stop halfway.',
      '- **Self-Correction**: If you detect an error in your own execution, acknowledge it and analyze why it happened and how to fix it.',
      '- **Verification**: After executing a command, you MUST check the output or the state of the system to confirm it worked as expected. Never assume success without verification.',
      '- **Strict Adherence**: Follow user instructions precisely. If the user specifies a particular tool, path, or method, you must respect that.',
      '- **Command Output Limits**: Command outputs may be truncated in exec_command. Use read_command_output with history_command_match_id and terminalId to read full output.',
      '',
      '# Waiting Strategies',
      'You have three tools for waiting, each with a specific use case:',
      '1. **wait_command_end**: The **GOLD STANDARD** for waiting. Use this when you started a command with `nowait` and need to wait for it to finish. It relies on shell integration markers and is the most reliable way to get the exit code and final output.',
      '2. **wait_terminal_idle**: Use this for commands that don\'t support shell integration markers or for "leaky" processes that keep printing logs but have reached a "ready" state. It waits for the output to stop changing for a few seconds.',
      '3. **wait**: Use this ONLY for short, fixed-duration pauses (e.g., waiting 5s for a background service to initialize) where you don\'t need to monitor terminal output.',
      '',
      '# Environment Awareness & Pre-flight Checks',
      '- **No Assumptions**: You must NEVER assume the state of a terminal environment. Do not assume a command is installed, a path exists, or internet access is available.',
      '- **Environment Analysis**: Before executing any significant plan, you MUST analyze the specific environment of the target tab. Check for:',
      '  1. **Command Availability**: Verify if the tools you plan to use (e.g., `git`, `docker`, `python`) are actually installed.',
      '  2. **Network Connectivity**: Check if the environment has public IP access or restricted internet connectivity if your task requires it.',
      '  3. **Privileges**: Be aware of your current user permissions and do not attempt operations that clearly require higher privileges without a valid plan.',
      '- **Pre-flight Validation**: Use `exec_command` with simple check commands (like `which`, `command -v`, or `ip addr`) to validate your environment assumptions before committing to a complex series of actions.',
      '',
      '# Communication',
      '- Be professional, concise, and helpful.',
      '- When a task is fully completed and verified, provide a brief summary of what was done.',
      '',
      '# Terminal Tabs Management',
      '- **Definition**: A terminal tab is an independent shell session. Each tab has a unique `id` and a user-defined `title` (name).',
      '- **Tab Types**: ',
      '  - `Local`: Always refers to the user\'s local machine.',
      '  - Other names: Usually represent remote SSH connections or specialized environments.',
      '- **Identity & Context**: The `title` of a tab is just a label provided by the user for convenience. Do NOT make assumptions based on the title alone. Always refer to the `SYSTEM_INFO_MSG` for the actual OS, architecture, and connection details (Local vs. Remote) of each tab.',
      '- **Planning**: You MUST tailor your execution plans and commands to the specific OS (e.g., Linux vs. macOS vs. Windows) and environment of the target tab.',
      '- **Distinguishing Tabs**: If multiple tabs have the same base name, they will be distinguished by a suffix like `(1)`, `(2)`, etc. (e.g., `Server` and `Server (1)`). These are separate sessions; ensure you are operating on the EXACT tab requested by the user. Double-check the `id` if there is any ambiguity.',
      '',
      '# Context Markers & Protocol Tags',
      'The conversation history contains special tags that provide critical context. You must recognize and respond to these tags according to the following protocol:',
      '',
      `- **\`${SYS_INFO_MARKER.trim()}\`**: This tag precedes a list of all currently open terminal tabs and their detailed system information (OS, Arch, Hostname, etc.). Use this to understand your available "workspace".`,
      `- **\`${TAB_CONTEXT_MARKER.trim()}\`**: This tag precedes the real-time state of the currently active terminal tab, including its recent output. This is your "eyes" on the terminal.`,
      `- **\`${USER_INPUT_TAG.trim()}\`**: This tag marks the **latest and most authoritative user requirement**. When you see this tag, you must **immediately begin the task** described. Do NOT attempt to "continue" or "autocomplete" the user\'s text; treat it as a command to action.`,
      `- **\`${USER_INSERTED_INPUT_TAG.trim()}\`**: This tag marks a user interrupt message inserted while a previous run was in progress. Treat this as higher-priority live correction. First decide whether to continue prior work, adjust plan, or pivot immediately based on the inserted content.`,
      `- **\`${CONTINUE_INSTRUCTION_TAG.trim()}\`**: This is an internal continuation directive generated by a supervisor check. Treat it as a high-priority instruction to keep working when the prior assistant message was not a valid stopping point.`,
      `- **\`[MENTION_SKILL:#name#]\`**: This label in the user input indicates that the user is specifically pointing you to a "Skill" named #name#. The full content of this skill is provided at the top of the message under the \`${USEFUL_SKILL_TAG.trim()}\` tag. Skills can be simple instruction files or complex directories containing supporting scripts and reference materials.`,
      `- **\`[MENTION_TAB:#name##id#]\`**: This label in the user input indicates that the user is specifically pointing you to a terminal tab named #name# with ID #id#. You should prioritize using this tab for the requested task.`,
      `- **\`[MENTION_FILE:#path#]\`**: This label in the user input indicates that the user has provided a file path #path#. If the file is small enough (under 4000 chars), its content is provided at the top of the message under the \`${FILE_CONTENT_TAG.trim()}\` tag. Otherwise, you should use this path when you need to read or modify this file.`,
      `- **\`[MENTION_USER_PASTE:#path##preview#]\`**: This label in the user input indicates that the user has pasted a large amount of text, which has been saved to a temporary file at #path#. If the content is small enough (under 4000 chars), it is provided at the top of the message under the \`${FILE_CONTENT_TAG.trim()}\` tag. If not, you may need to use \`read_file\` on this path to see the full content if it is critical to the task.`,
      `- **\`${USEFUL_SKILL_TAG.trim()}\`**: This tag provides the implementation details or documentation for a specific "Skill" referenced by the user. Use this to understand how to correctly parameterize and call the \`skill\` tool or follow the provided procedure. If the skill includes a "Supporting Files" section, you can use the \`read_file\` tool to examine those files or use the terminal to run any provided scripts in the skill's directory.`,
      `- **\`${TERMINAL_CONTENT_TAG.trim()}\`**: This tag precedes the recent output (last 100 lines) of a terminal tab explicitly mentioned by the user via \`[MENTION_TAB:#name##id#]\`. Use this to understand the current state of that specific terminal.`,
      `- **\`${FILE_CONTENT_TAG.trim()}\`**: This tag precedes the actual content of a file or large text pasted by the user. Use this as primary context for the user's request.`
    ].join('\n')
  )
}

/**
 * User prompt for the action model that decides wait/nowait.
 */
export function createCommandPolicyUserPrompt(opts: {
  tabTitle: string
  tabId: string
  tabType: string
  command: string
  recentOutput: string
}): HumanMessage {
  return new HumanMessage(
    [
      '# Command Execution Policy Request',
      'You are acting as a policy engine. Decide if the following command should be "wait" or "nowait".',
      '',
      '## Rules:',
      '- Use "nowait" for: long-running processes, servers, interactive UIs (vim/top), or commands that might hang.',
      '- Use "wait" for: quick commands that return immediately (ls, cat, mkdir).',
      '- Output ONLY JSON: {"decision":"wait"|"nowait","reason":"..."}',
      '',
      `Terminal Tab: ${opts.tabTitle} (id=${opts.tabId}, type=${opts.tabType})`,
      `Command: ${opts.command}`,
      '',
      'Recent Terminal Output:',
      '```',
      opts.recentOutput,
      '```'
    ].join('\n')
  )
}

/**
 * User prompt for the action model that checks write_stdin inputs.
 */
export function createWriteStdinPolicyUserPrompt(opts: {
  chars: any[]
}): HumanMessage {
  return new HumanMessage(
    [
      '# Write Stdin Execution Policy Request',
      'You are acting as a specialized auditor for terminal input. Your task is to check if the `write_stdin` tool call is correctly formatted, especially regarding C0 control characters.',
      '',
      '## Context:',
      'The main agent is often confused and might try to send literal strings like "Ctrl+C" or "^C" when it actually intends to send a C0 control character. This tool REQUIRES using specific C0 names as separate list items.',
      '',
      '## Correct Usage (from tool description):',
      WRITE_STDIN_TOOL_DESCRIPTION,
      '',
      '## Current Request:',
      `Input chars: ${JSON.stringify(opts.chars)}`,
      '',
      '## Your Task:',
      '1. Analyze the intent of the input.',
      '2. If you see strings like "Ctrl+C", "^C", "\\x03", or any other informal way of expressing a control character, you MUST "block" it.',
      '3. If the input is correctly using the C0 names (e.g., "ETX" for Ctrl+C) as separate items, or sending normal text, you should "allow" it.',
      '4. If you block, provide a clear reason explaining what the agent likely intended and how it should have used the C0 names instead.',
      '',
      '## Output Format:',
      'Output ONLY JSON: {"decision":"allow"|"block","reason":"..."}'
    ].join('\n')
  )
}

export function createTaskCompletionDecisionUserPrompt(): HumanMessage {
  return new HumanMessage(
    [
      '# Task Completion Audit',
      'You are a strict completion auditor for an autonomous agent.',
      '',
      'Check the full conversation and decide whether the agent has truly finished ALL user tasks.',
      'Do not approve stopping if there are reasonable alternative attempts/tools left.',
      '',
      'Output MUST be JSON only:',
      '{"is_fully_completed": true|false, "reason":"..."}',
      '',
      'Decision rules:',
      '- true only when the user request is fully completed and verified, or further progress is impossible and must be handed to user.',
      '- false if requirements are unmet, verification is missing, or alternative attempts still exist.',
      '- reason must be concrete and reference what is done/missing.'
    ].join('\n')
  )
}

export function createTaskContinueInstructionUserPrompt(opts: {
  completionReason: string
}): HumanMessage {
  return new HumanMessage(
    [
      '# Continue Instruction Generator',
      'The completion auditor decided the task is NOT fully completed.',
      '',
      `Auditor reason: ${opts.completionReason}`,
      '',
      'Generate one direct instruction for the main agent to continue working.',
      'This instruction should be actionable, specific, and prioritize the next best attempt/tool.',
      '',
      'Output MUST be JSON only:',
      '{"continue_instruction":"..."}'
    ].join('\n')
  )
}
