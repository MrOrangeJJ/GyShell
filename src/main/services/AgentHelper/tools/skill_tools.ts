import { z } from 'zod'
import type { SkillInfo, SkillService } from '../../SkillService'
import { USEFUL_SKILL_TAG } from '../prompts'

export const skillToolSchema = z.object({
  name: z.string().describe('The skill identifier from available_skills')
})

export const createOrRewriteSkillSchema = z.object({
  name: z.string().describe('The display name of the skill (e.g. "React Component Generator")'),
  description: z.string().describe('A clear description of what this skill does and when to use it.'),
  content: z.string().describe('The complete new skill content in Markdown format. For rewrites, provide the full replacement content.')
})

export function buildSkillToolDescription(skills: SkillInfo[]): string {
  const header = [
    'Load a skill to get detailed instructions for a specific task.',
    'Skills provide specialized knowledge, step-by-step guidance, and may include supporting files (scripts, references).',
    'You MUST choose a valid skill name from the list below.',
    'When a skill is loaded, you will receive its instructions and a list of any available supporting files in its directory.'
  ]

  const available = (skills || []).flatMap((s) => [
    '  <skill>',
    `    <name>${s.name}</name>`,
    `    <description>${s.description}</description>`,
    `    <type>${s.isNested ? 'Nested (Complex)' : 'Flat (Simple)'}</type>`,
    '  </skill>'
  ])

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

export async function runCreateOrRewriteSkillTool(
  args: unknown,
  skillService: SkillService,
  signal?: AbortSignal
): Promise<SkillToolResult> {
  if (!skillService) {
    return { kind: 'error', message: 'Error: SkillService is not initialized.' }
  }
  if (signal?.aborted) throw new Error('AbortError')

  const validated = createOrRewriteSkillSchema.safeParse(args)
  if (!validated.success) {
    return { 
      kind: 'error', 
      message: `Error: Invalid parameters for create_or_rewrite_skill: ${validated.error.message}` 
    }
  }

  const { name, description, content } = validated.data

  try {
    const { skill, action } = await skillService.createOrRewriteSkill(name, description, content)
    const actionMessage =
      action === 'rewritten'
        ? 'Successfully rewrote existing skill'
        : 'Successfully created and added new skill'
    return {
      kind: 'text',
      message: `${actionMessage}: "${skill.name}". You can now see it in the available skills list and use it with the "skill" tool.`
    }
  } catch (err) {
    return {
      kind: 'error',
      message: `Error: Failed to create or rewrite skill: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
