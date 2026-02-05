import { z } from 'zod'
import type { SkillInfo, SkillService } from '../SkillService'
import { USEFUL_SKILL_TAG } from './prompts'

export const skillToolSchema = z.object({
  name: z.string().describe('The skill identifier from available_skills')
})

export function buildSkillToolDescription(skills: SkillInfo[]): string {
  const header = [
    'Load a skill to get detailed instructions for a specific task.',
    'Skills provide specialized knowledge and step-by-step guidance.',
    'You MUST choose a valid skill name from the list below.',
  ]

  const available = [
    ...(skills || []).flatMap((s) => [
      '  <skill>',
      `    <name>${s.name}</name>`,
      `    <description>${s.description}</description>`,
      '  </skill>'
    ])
  ]

  return [...header, '<available_skills>', ...available, '</available_skills>'].join('\n')
}

export type SkillToolResult =
  | { kind: 'text'; message: string }
  | { kind: 'error'; message: string }

export async function runSkillTool(
  args: unknown,
  skillService: SkillService,
  signal?: AbortSignal
): Promise<SkillToolResult> {
  if (!skillService) {
    return { kind: 'error', message: 'Error: SkillService is not initialized.' }
  }
  if (signal?.aborted) throw new Error('AbortError')
  
  const validated = skillToolSchema.safeParse(args)
  const skillName = validated.success ? validated.data.name : String((args as any)?.name || 'unknown')
  const skills = await skillService.getAll().catch(() => [])
  
  if (signal?.aborted) throw new Error('AbortError')
  
  const match = skills.find((s) => s.name === skillName)

  if (match) {
    const loaded = await skillService.readSkillContentByName(match.name)
    if (signal?.aborted) throw new Error('AbortError')
    
    const body = [
      USEFUL_SKILL_TAG,
      `name: ${loaded.info.name}`,
      `description: ${loaded.info.description}`,
      '',
      (loaded.content || '').trim(),
    ].join('\n')
    
    return {
      kind: 'text',
      message: body
    }
  }

  const availableSkillsInfo = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  return {
    kind: 'error',
    message:
      `Error: Skill "${skillName}" not found. You must provide a valid skill name.\n\n` +
      `Available skills:\n${availableSkillsInfo || 'None'}\n\n` +
      'Please ensure you use the exact name from the list above.'
  }
}