import { z } from 'zod'

export const thinkSchema = z.object({})

export const thinkingEndSchema = z.object({})

export const waitSchema = z.object({
  seconds: z.number().min(5).max(60).describe('Number of seconds to wait (5-60)')
})

export const waitTerminalIdleSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab to monitor')
})
