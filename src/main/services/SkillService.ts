import fs from 'fs/promises'
import path from 'path'
import { app, shell } from 'electron'
import { z } from 'zod'

export const SkillInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  fileName: z.string().min(1),
  filePath: z.string().min(1)
})

export type SkillInfo = z.infer<typeof SkillInfoSchema>

type ParsedMarkdown = {
  frontmatter: Record<string, string>
  content: string
}

function isSafeSkillFileName(fileName: string): boolean {
  if (!fileName) return false
  if (fileName.includes('..')) return false
  if (fileName.includes('/') || fileName.includes('\\')) return false
  if (!fileName.toLowerCase().endsWith('.md')) return false
  return true
}

function parseFrontmatter(raw: string): ParsedMarkdown {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, content: raw }
  }

  const endIdx = normalized.indexOf('\n---', 4)
  if (endIdx === -1) {
    return { frontmatter: {}, content: raw }
  }

  const fmBlock = normalized.slice(4, endIdx).trimEnd()
  const rest = normalized.slice(endIdx + '\n---'.length)
  const content = rest.replace(/^\n+/, '')

  const lines = fmBlock.split('\n')
  const fm: Record<string, string> = {}

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = (m[2] ?? '').trim()

    // Block scalar: key: |   (or >)
    if (value === '|' || value === '>') {
      const buf: string[] = []
      // consume subsequent indented lines
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]
        if (!/^\s+/.test(next)) break
        buf.push(next.replace(/^\s{1,}/, ''))
        i = j
      }
      value = buf.join('\n').trim()
    } else {
      // strip simple quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
    }

    fm[key] = value
  }

  return { frontmatter: fm, content }
}

function defaultSkillTemplate(now: Date): string {
  const ts = now.toISOString()
  return [
    '---',
    `name: my-skill-${now.getTime()}`,
    'description: What is this skill for, and when should it be used?',
    '---',
    '',
    '# Goal',
    '',
    '- Describe what you want the agent to accomplish.',
    '',
    '# Steps',
    '',
    '1. Step one...',
    '2. Step two...',
    '',
    '# Notes',
    '',
    '- Risks / constraints / required validations.',
    '',
    `<!-- createdAt: ${ts} -->`,
    ''
  ].join('\n')
}

export class SkillService {
  private cache: SkillInfo[] = []

  getSkillsDir(): string {
    const baseDir = app.getPath('userData')
    return path.join(baseDir, 'skills')
  }

  async ensureSkillsDir(): Promise<void> {
    const dir = this.getSkillsDir()
    await fs.mkdir(dir, { recursive: true })
  }

  async openSkillsFolder(): Promise<void> {
    await this.ensureSkillsDir()
    await shell.openPath(this.getSkillsDir())
  }

  async openSkillFile(fileName: string): Promise<void> {
    if (!isSafeSkillFileName(fileName)) {
      throw new Error('Invalid skill file name')
    }
    await this.ensureSkillsDir()
    const filePath = path.join(this.getSkillsDir(), fileName)
    await shell.openPath(filePath)
  }

  async deleteSkillFile(fileName: string): Promise<void> {
    if (!isSafeSkillFileName(fileName)) {
      throw new Error('Invalid skill file name')
    }
    await this.ensureSkillsDir()
    const filePath = path.join(this.getSkillsDir(), fileName)
    await fs.unlink(filePath)
    await this.reload()
  }

  async createSkill(name: string, description: string, content: string): Promise<SkillInfo> {
    await this.ensureSkillsDir()
    // Convert name to a safe file name (e.g., "My Skill" -> "my-skill.md")
    const safeBaseName = name.toLowerCase().replace(/[^a-z0-9]/g, '-')
    const fileName = `${safeBaseName}-${Date.now()}.md`
    const filePath = path.join(this.getSkillsDir(), fileName)
    
    const fullContent = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      content
    ].join('\n')

    await fs.writeFile(filePath, fullContent, 'utf-8')
    await this.reload()
    
    const created = this.cache.find((s) => s.fileName === fileName)
    if (created) return created
    return {
      name,
      description,
      fileName,
      filePath
    }
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    await this.ensureSkillsDir()
    const now = new Date()
    const fileName = `skill-${now.getTime()}.md`
    const filePath = path.join(this.getSkillsDir(), fileName)
    await fs.writeFile(filePath, defaultSkillTemplate(now), 'utf-8')
    await this.reload()
    const created = this.cache.find((s) => s.fileName === fileName)
    if (created) return created
    return {
      name: `skill-${now.getTime()}`,
      description: 'New skill',
      fileName,
      filePath
    }
  }

  async reload(): Promise<SkillInfo[]> {
    await this.ensureSkillsDir()
    const dir = this.getSkillsDir()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))

    const result: SkillInfo[] = []
    for (const fileName of mdFiles) {
      const filePath = path.join(dir, fileName)
      try {
        const raw = await fs.readFile(filePath, 'utf-8')
        const parsed = parseFrontmatter(raw)
        const name = String(parsed.frontmatter.name || '').trim()
        const description = String(parsed.frontmatter.description || '').trim()
        if (!name || !description) continue
        const info: SkillInfo = { name, description, fileName, filePath }
        const ok = SkillInfoSchema.safeParse(info)
        if (ok.success) result.push(ok.data)
      } catch {
        // ignore unreadable/invalid files
      }
    }

    this.cache = result
    return this.cache
  }

  async getAll(): Promise<SkillInfo[]> {
    if (this.cache.length === 0) {
      await this.reload()
    }
    return this.cache
  }

  async readSkillContentByName(name: string): Promise<{ info: SkillInfo; content: string }> {
    const skills = await this.getAll()
    const match = skills.find((s) => s.name === name)
    if (!match) {
      throw new Error(`Skill "${name}" not found`)
    }
    const raw = await fs.readFile(match.filePath, 'utf-8')
    const parsed = parseFrontmatter(raw)
    return { info: match, content: parsed.content.trim() }
  }
}

