import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { writeAndEditSchema, writeAndEdit } from './tools/edit_tools'
import { readFileSchema, runReadFile } from './tools/read_tools'
import { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema,
  runCommand, 
  runCommandNowait, 
  readTerminalTab, 
  readCommandOutput,
  writeStdin
} from './tools/terminal_tools'
import { 
  BUILTIN_TOOL_INFO, 
  buildReadFileDescription,
  WAIT_TERMINAL_IDLE_DESCRIPTION
} from './prompts'
import type { ReadFileSupport } from './types'
import { waitSchema, waitTerminalIdleSchema, waitCommandEndSchema, wait, waitTerminalIdle, waitCommandEnd } from './tools/wait_tools'
import { 
  skillToolSchema, 
  buildSkillToolDescription,
  createSkillSchema,
  runCreateSkillTool
} from './tools/skill_tools'

// Re-export schemas for AgentService to use
export { 
  editFileSchema, 
  writeAndEditSchema 
} from './tools/edit_tools'

export { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema
} from './tools/terminal_tools'

export { readFileSchema } from './tools/read_tools'
export { waitSchema, waitTerminalIdleSchema, waitCommandEndSchema } from './tools/wait_tools'
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
      name: 'create_or_edit',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'create_or_edit')?.description ?? '',
      schema: writeAndEditSchema
    },
    {
      name: 'skill',
      description: buildSkillToolDescription([]), // Placeholder, will be updated by AgentService
      schema: skillToolSchema
    },
    {
      name: 'create_skill',
      description: 'Create a new skill with specialized instructions and add it to the available skills list. Use this to persist complex workflows or expert knowledge that you can reuse later.',
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
      name: 'wait_command_end',
      description: 'Wait for the currently running command in the terminal tab to finish. Use this when you started a command with nowait but now need its output or exit code to proceed.',
      schema: waitCommandEndSchema
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
  wait,
  waitTerminalIdle,
  writeAndEdit,
  runReadFile,
  runCreateSkillTool,
  waitCommandEnd
}
