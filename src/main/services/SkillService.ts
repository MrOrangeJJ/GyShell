import fs from 'fs/promises'
import path from 'path'
import { app, shell } from 'electron'
import { z } from 'zod'
import { SettingsService } from './SettingsService'

export const SkillInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  fileName: z.string().min(1), // For nested structures, this is SKILL.md
  filePath: z.string().min(1), // Full path to SKILL.md
  baseDir: z.string().min(1),  // Skill root directory (the folder containing SKILL.md)
  scanRoot: z.string().min(1), // The root directory that was scanned
  isNested: z.boolean(),       // Whether it's a nested structure
  supportingFiles: z.array(z.string()).optional() // List of relative paths
})

export type SkillInfo = z.infer<typeof SkillInfoSchema>
export type CreateOrRewriteSkillResult = {
  skill: SkillInfo
  action: 'created' | 'rewritten'
}

type ParsedMarkdown = {
  frontmatter: Record<string, string>
  content: string
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

async function getSupportingFiles(dir: string, skillFilePath: string): Promise<string[]> {
  const files: string[] = []
  
  async function scan(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (fullPath === skillFilePath) continue
      if (entry.name.startsWith('.')) continue

      if (entry.isDirectory()) {
        await scan(fullPath)
      } else {
        files.push(path.relative(dir, fullPath))
      }
    }
  }

  try {
    await scan(dir)
  } catch (err) {
    console.error(`[SkillService] Failed to scan supporting files in ${dir}`, err)
  }
  
  return files
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
  private settingsService?: SettingsService

  constructor(settingsService?: SettingsService) {
    this.settingsService = settingsService
  }

  setSettingsService(settingsService: SettingsService) {
    this.settingsService = settingsService
  }

  getSkillsDirs(): string[] {
    const dirs: string[] = []
    
    // 1. GyShell specific data directory (highest priority)
    const baseDir = app.getPath('userData')
    dirs.push(path.join(baseDir, 'skills'))

    // 2. Compatibility directories (Referencing Goose/Claude specifications)
    const homeDir = app.getPath('home')
    if (homeDir) {
      dirs.push(path.join(homeDir, '.claude', 'skills'))
      dirs.push(path.join(homeDir, '.agents', 'skills'))
      
      // Compatibility for common Windows AppData paths
      if (process.platform === 'win32') {
        const appData = process.env.APPDATA
        if (appData) {
          dirs.push(path.join(appData, 'agents', 'skills'))
        }
      } else {
        // Compatibility for common macOS/Linux .config paths
        dirs.push(path.join(homeDir, '.config', 'agents', 'skills'))
      }
    }

    return [...new Set(dirs)] // Deduplicate
  }

  async ensureSkillsDir(): Promise<void> {
    const dirs = this.getSkillsDirs()
    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true })
      } catch (err) {
        // Ignore directories that cannot be created (likely permission issues)
      }
    }
  }

  async openSkillsFolder(): Promise<void> {
    const primaryDir = this.getSkillsDirs()[0]
    await fs.mkdir(primaryDir, { recursive: true })
    await shell.openPath(primaryDir)
  }

  async openSkillFile(fileName: string): Promise<void> {
    // Search for the file in all directories
    const dirs = this.getSkillsDirs()
    for (const dir of dirs) {
      const filePath = path.join(dir, fileName)
      const exists = await fs.access(filePath).then(() => true).catch(() => false)
      if (exists) {
        await shell.openPath(filePath)
        return
      }
    }
    throw new Error(`Skill file "${fileName}" not found in any skill directory`)
  }

  async deleteSkillFile(fileName: string): Promise<void> {
    const dirs = this.getSkillsDirs()
    for (const dir of dirs) {
      const filePath = path.join(dir, fileName)
      const exists = await fs.access(filePath).then(() => true).catch(() => false)
      if (exists) {
        await fs.unlink(filePath)
        await this.reload()
        return
      }
    }
    throw new Error(`Skill file "${fileName}" not found`)
  }

  async createOrRewriteSkill(
    name: string,
    description: string,
    content: string
  ): Promise<CreateOrRewriteSkillResult> {
    const primaryDir = this.getSkillsDirs()[0]
    await fs.mkdir(primaryDir, { recursive: true })

    const fullContent = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      content
    ].join('\n')

    await this.reload()

    const existingInPrimary = this.cache.find(
      (s) => s.name === name && s.scanRoot === primaryDir
    )

    if (existingInPrimary) {
      await fs.writeFile(existingInPrimary.filePath, fullContent, 'utf-8')
      await this.reload()
      const rewritten = this.cache.find((s) => s.filePath === existingInPrimary.filePath)
      if (rewritten) {
        return { skill: rewritten, action: 'rewritten' }
      }
      return {
        skill: {
          ...existingInPrimary,
          description
        },
        action: 'rewritten'
      }
    }

    // Convert name to a safe file name (e.g., "My Skill" -> "my-skill-123.md")
    const safeBaseName = name.toLowerCase().replace(/[^a-z0-9]/g, '-')
    const fileName = `${safeBaseName}-${Date.now()}.md`
    const filePath = path.join(primaryDir, fileName)
    await fs.writeFile(filePath, fullContent, 'utf-8')
    await this.reload()

    const created = this.cache.find((s) => s.fileName === fileName)
    if (created) return { skill: created, action: 'created' }
    return {
      skill: {
        name,
        description,
        fileName,
        filePath,
        baseDir: primaryDir,
        scanRoot: primaryDir,
        isNested: false
      },
      action: 'created'
    }
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    const primaryDir = this.getSkillsDirs()[0]
    await fs.mkdir(primaryDir, { recursive: true })
    
    const now = new Date()
    const fileName = `skill-${now.getTime()}.md`
    const filePath = path.join(primaryDir, fileName)
    await fs.writeFile(filePath, defaultSkillTemplate(now), 'utf-8')
    await this.reload()
    const created = this.cache.find((s) => s.fileName === fileName)
    if (created) return created
    return {
      name: `skill-${now.getTime()}`,
      description: 'New skill',
      fileName,
      filePath,
      baseDir: primaryDir,
      scanRoot: primaryDir,
      isNested: false
    }
  }

  async reload(): Promise<SkillInfo[]> {
    const dirs = this.getSkillsDirs()
    const result: SkillInfo[] = []
    const seenNames = new Set<string>()

    for (const dir of dirs) {
      try {
        const exists = await fs.access(dir).then(() => true).catch(() => false)
        if (!exists) continue

        const entries = await fs.readdir(dir, { withFileTypes: true })
        
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue

          if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            // Mode A: Flat file
            const filePath = path.join(dir, entry.name)
            try {
              const raw = await fs.readFile(filePath, 'utf-8')
              const parsed = parseFrontmatter(raw)
              const name = String(parsed.frontmatter.name || '').trim()
              const description = String(parsed.frontmatter.description || '').trim()
              if (!name || !description || seenNames.has(name)) continue

              const info: SkillInfo = {
                name,
                description,
                fileName: entry.name,
                filePath,
                baseDir: dir,
                scanRoot: dir,
                isNested: false
              }
              const ok = SkillInfoSchema.safeParse(info)
              if (ok.success) {
                result.push(ok.data)
                seenNames.add(name)
              }
            } catch {
              // ignore
            }
          } else if (entry.isDirectory()) {
            // Mode B: Nested directory (SKILL.md)
            const skillDir = path.join(dir, entry.name)
            const skillFilePath = path.join(skillDir, 'SKILL.md')
            
            try {
              const skillExists = await fs.access(skillFilePath).then(() => true).catch(() => false)
              if (!skillExists) continue

              const raw = await fs.readFile(skillFilePath, 'utf-8')
              const parsed = parseFrontmatter(raw)
              const name = String(parsed.frontmatter.name || '').trim()
              const description = String(parsed.frontmatter.description || '').trim()
              if (!name || !description || seenNames.has(name)) continue

              const supportingFiles = await getSupportingFiles(skillDir, skillFilePath)

              const info: SkillInfo = {
                name,
                description,
                fileName: 'SKILL.md',
                filePath: skillFilePath,
                baseDir: skillDir,
                scanRoot: dir,
                isNested: true,
                supportingFiles
              }
              const ok = SkillInfoSchema.safeParse(info)
              if (ok.success) {
                result.push(ok.data)
                seenNames.add(name)
              }
            } catch {
              // ignore
            }
          }
        }
      } catch (err) {
        console.error(`[SkillService] Failed to reload skills from ${dir}`, err)
      }
    }

    this.cache = result.sort((a, b) => a.name.localeCompare(b.name))
    return this.cache
  }

  async getAll(): Promise<SkillInfo[]> {
    if (this.cache.length === 0) {
      await this.reload()
    }
    return this.cache
  }

  async getEnabledSkills(): Promise<SkillInfo[]> {
    const all = await this.getAll()
    if (!this.settingsService) return all
    
    const settings = this.settingsService.getSettings()
    const skillStates = settings.tools?.skills ?? {}
    
    return all.filter(s => skillStates[s.name] !== false)
  }

  async readSkillContentByName(name: string): Promise<{ info: SkillInfo; content: string }> {
    const skills = await this.getAll()
    const match = skills.find((s) => s.name === name)
    if (!match) {
      throw new Error(`Skill "${name}" not found`)
    }
    const raw = await fs.readFile(match.filePath, 'utf-8')
    const parsed = parseFrontmatter(raw)
    
    // Inject resource list into content if it exists
    let enrichedContent = parsed.content.trim()
    if (match.isNested && match.supportingFiles && match.supportingFiles.length > 0) {
      // Ensure absolute paths using path.join with match.baseDir
      const filesList = match.supportingFiles.map((f: string) => {
        const absolutePath = path.isAbsolute(f) ? f : path.join(match.baseDir, f)
        return `- ${absolutePath}`
      }).join('\n')
      
      enrichedContent += `\n\n## Supporting Files\n\nSkill directory: ${match.baseDir}\n\nThe following supporting files are available (absolute paths):\n${filesList}\n\nUse the "read_file" tool to access these files as needed, or run scripts as directed using the terminal.`
    }

    return { info: match, content: enrichedContent }
  }
}
