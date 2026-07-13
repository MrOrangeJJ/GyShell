import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import {
  editFile,
  editFileSchema,
  writeAndEdit,
  writeFile,
  writeFileSchema
} from './tools/edit_tools'
import { readFileSchema, runReadFile } from './tools/read_tools'
import { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema,
  reconnectTerminalTabSchema,
  runCommand, 
  runCommandNowait, 
  readTerminalTab, 
  readCommandOutput,
  writeStdin,
  reconnectTerminalTab
} from './tools/terminal_tools'
import {
  buildCreateTerminalTabDescription,
  closeTerminalTab,
  closeTerminalTabSchema,
  createTerminalTab,
  createTerminalTabSchema,
  listSavedTerminalConnectionOptions
} from './tools/terminal_tab_lifecycle_tools'
import { buildTerminalConfigFromSavedConnection } from '../terminal/terminalConnectionSupport'
import { 
  BUILTIN_TOOL_INFO, 
  EDIT_FILE_TOOL_DESCRIPTION,
  WRITE_FILE_TOOL_DESCRIPTION,
  buildReadFileDescription,
  WAIT_TERMINAL_IDLE_DESCRIPTION
} from './prompts'
import { EDIT_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME } from './tool_capabilities'
import type { ReadFileSupport } from './types'
import { waitSchema, waitTerminalIdleSchema, wait, waitTerminalIdle } from './tools/wait_tools'
import {
  copyBetweenTabsSchema,
  readFileTransferStatusSchema,
  copyBetweenTabs,
  readFileTransferStatus
} from './tools/file_transfer_tools'
import { 
  skillToolSchema, 
  buildSkillToolDescription,
  createSkillSchema,
  runCreateSkillTool
} from './tools/skill_tools'

// Re-export schemas for AgentService to use
export { 
  editFileSchema, 
  writeAndEditSchema,
  writeFileSchema
} from './tools/edit_tools'

export { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema,
  reconnectTerminalTabSchema
} from './tools/terminal_tools'

export {
  buildCreateTerminalTabDescription,
  buildTerminalConfigFromSavedConnection,
  closeTerminalTabSchema,
  createTerminalTabSchema,
  listSavedTerminalConnectionOptions
}

export { readFileSchema } from './tools/read_tools'
export { waitSchema, waitTerminalIdleSchema } from './tools/wait_tools'
export { copyBetweenTabsSchema, readFileTransferStatusSchema } from './tools/file_transfer_tools'
export { skillToolSchema, createSkillSchema, buildSkillToolDescription } from './tools/skill_tools'

export { BUILTIN_TOOL_INFO } from './prompts'

export type { ToolExecutionContext, ReadFileSupport } from './types'

// Build Tool Definitions
export function buildToolsForModel(readFileSupport: ReadFileSupport) {
  return [
    {
      name: 'exec_command',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'exec_command')?.description ?? '',
      schema: execCommandSchema
    },
    {
      name: 'read_terminal_tab',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_terminal_tab')?.description ?? '',
      schema: readTerminalTabSchema
    },
    {
      name: 'read_command_output',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_command_output')?.description ?? '',
      schema: readCommandOutputSchema
    },
    {
      name: 'read_file',
      description: buildReadFileDescription(readFileSupport),
      schema: readFileSchema,
    },
    {
      name: 'write_stdin',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'write_stdin')?.description ?? '',
      schema: writeStdinSchema
    },
    {
      name: 'reconnect_terminal_tab',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'reconnect_terminal_tab')?.description ?? '',
      schema: reconnectTerminalTabSchema
    },
    {
      name: 'create_terminal_tab',
      description: buildCreateTerminalTabDescription(undefined),
      schema: createTerminalTabSchema
    },
    {
      name: 'close_terminal_tab',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'close_terminal_tab')?.description ?? '',
      schema: closeTerminalTabSchema
    },
    {
      name: WRITE_FILE_TOOL_NAME,
      description: WRITE_FILE_TOOL_DESCRIPTION,
      schema: writeFileSchema
    },
    {
      name: EDIT_FILE_TOOL_NAME,
      description: EDIT_FILE_TOOL_DESCRIPTION,
      schema: editFileSchema
    },
    {
      name: 'skill',
      description: buildSkillToolDescription([]), // Placeholder, will be updated by AgentService
      schema: skillToolSchema
    },
    {
      name: 'create_skill',
      description: 'Create a new skill in GyShell skills. This tool only creates new skills and does not modify or overwrite existing ones. If the skill name already exists, the call must fail and you should choose a different name. If you need to modify an existing skill, use edit_file to edit that skill\'s md file directly, or write_file only when intentionally replacing the full file.',
      schema: createSkillSchema
    },
    {
      name: 'wait',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'wait')?.description ?? '',
      schema: waitSchema
    },
    {
      name: 'wait_terminal_idle',
      description: WAIT_TERMINAL_IDLE_DESCRIPTION,
      schema: waitTerminalIdleSchema
    },
    {
      name: 'copy_between_tabs',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'copy_between_tabs')?.description ?? '',
      schema: copyBetweenTabsSchema
    },
    {
      name: 'read_file_transfer_status',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_file_transfer_status')?.description ?? '',
      schema: readFileTransferStatusSchema
    }
  ].map((tool) => convertToOpenAITool(tool))
}

export const TOOLS_FOR_MODEL = buildToolsForModel({ image: false })

// Aggregated Tool Implementations
export const toolImplementations = {
  runCommand,
  runCommandNowait,
  readTerminalTab,
  readCommandOutput,
  writeStdin,
  reconnectTerminalTab,
  createTerminalTab,
  closeTerminalTab,
  wait,
  waitTerminalIdle,
  copyBetweenTabs,
  readFileTransferStatus,
  writeFile,
  editFile,
  writeAndEdit,
  runReadFile,
  runCreateSkillTool
}
