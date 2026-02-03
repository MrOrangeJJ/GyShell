import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { writeAndEditSchema, writeAndEdit } from './edit_tools'
import { readFileSchema, runReadFile } from './read_tools'
import { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  sendCharSchema, 
  waitTerminalIdleSchema,
  runCommand, 
  runCommandNowait, 
  readTerminalTab, 
  readCommandOutput,
  sendChar,
  waitTerminalIdle
} from './terminal_tools'
import { 
  BUILTIN_TOOL_INFO, 
  THINK_TOOL_DESCRIPTION, 
  THINKING_END_TOOL_DESCRIPTION, 
  buildReadFileDescription,
  WAIT_TERMINAL_IDLE_DESCRIPTION
} from './prompts'
import type { ReadFileSupport } from './types'
import { thinkSchema, thinkingEndSchema, waitSchema } from './thinking_tools'
import { skillToolSchema, buildSkillToolDescription } from './skill_tools'
import type { SkillInfo } from '../SkillService'

// Re-export schemas for AgentService to use
export { 
  editFileSchema, 
  writeAndEditSchema 
} from './edit_tools'

export { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  sendCharSchema,
  waitTerminalIdleSchema
} from './terminal_tools'

export { readFileSchema } from './read_tools'
export { thinkSchema, thinkingEndSchema, waitSchema } from './thinking_tools'
export { skillToolSchema } from './skill_tools'

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
      name: 'send_char',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'send_char')?.description ?? '',
      schema: sendCharSchema
    },
    {
      name: 'create_or_edit',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'create_or_edit')?.description ?? '',
      schema: writeAndEditSchema
    },
    {
      name: 'think',
      description: THINK_TOOL_DESCRIPTION,
      schema: thinkSchema
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
    }
  ].map((tool) => convertToOpenAITool(tool))
}

export function buildToolsForThinkingModel(skills: SkillInfo[]) {
  return [
    {
      name: 'skill',
      description: buildSkillToolDescription(skills),
      schema: skillToolSchema
    },
    {
      name: 'thinking_end',
      description: THINKING_END_TOOL_DESCRIPTION,
      schema: thinkingEndSchema
    },
    {
      name: 'read_terminal_tab',
      description: 'Read the recent visible output of a specific terminal tab to get context for your analysis.',
      schema: readTerminalTabSchema
    }
  ].map((tool) => convertToOpenAITool(tool))
}

export function getThinkingModeAllowedToolNames(): string[] {
  return ['skill', 'thinking_end', 'read_terminal_tab']
}

export const TOOLS_FOR_MODEL = buildToolsForModel({ image: false })

// Aggregated Tool Implementations
export const toolImplementations = {
  runCommand,
  runCommandNowait,
  readTerminalTab,
  readCommandOutput,
  sendChar,
  waitTerminalIdle,
  writeAndEdit,
  runReadFile
}
