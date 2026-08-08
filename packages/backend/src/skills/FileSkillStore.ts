import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'

export interface SkillInfo {
  name: string
  description: string
  fileName: string
  filePath: string
  baseDir: string
  scanRoot: string
  isNested: boolean
  supportingFiles?: string[]
}

export interface CreateSkillResult {
  skill: SkillInfo
}

interface ParsedMarkdown {
  frontmatter: Record<string, string>
  content: string
}

export interface FileSkillStoreOptions {
  getScanRoots: () => Promise<string[]> | string[]
  getPrimaryRoot: () => Promise<string> | string
  getSkillEnabledMap?: () => Record<string, boolean>
  openPath?: (absolutePath: string) => Promise<void>
  logger?: {
    error: (message: string, error?: unknown) => void
  }
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
  const frontmatter: Record<string, string> = {}

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!match) continue

    const key = match[1]
    let value = (match[2] ?? '').trim()

    // Support simple yaml block scalars: key: | / key: >
    if (value === '|' || value === '>') {
      const buffer: string[] = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]
        if (!/^\s+/.test(next)) break
        buffer.push(next.replace(/^\s+/, ''))
        i = j
      }
      value = buffer.join('\n').trim()
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    frontmatter[key] = value
  }

  return { frontmatter, content }
}

async function listSupportingFiles(dir: string, skillFilePath: string): Promise<string[]> {
  const files: string[] = []

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (fullPath === skillFilePath) continue
      files.push(path.relative(dir, fullPath))
    }
  }

  await walk(dir)
  return files.sort((a, b) => a.localeCompare(b))
}

async function resolvesToDirectory(entry: Dirent, entryPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false

  const targetStat = await fs.stat(entryPath).catch(() => null)
  return targetStat?.isDirectory() === true
}

function toSafeSkillFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'skill'}.md`
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

export class FileSkillStore {
  private cache: SkillInfo[] = []
  private readonly logger: { error: (message: string, error?: unknown) => void }

  constructor(private readonly options: FileSkillStoreOptions) {
    this.logger = options.logger ?? {
      error: (message: string, error?: unknown) => console.error(message, error)
    }
  }

  async ensureSkillsDir(): Promise<void> {
    const primary = await this.resolvePrimaryRoot()
    try {
      await fs.mkdir(primary, { recursive: true })
    } catch {
      // ignore permission-denied locations
    }
  }

  async openSkillsFolder(): Promise<void> {
    if (!this.options.openPath) {
      throw new Error('Open operation is not supported in this runtime')
    }
    const primary = await this.resolvePrimaryRoot()
    await fs.mkdir(primary, { recursive: true })
    await this.options.openPath(primary)
  }

  async openSkillFile(fileName: string): Promise<void> {
    if (!this.options.openPath) {
      throw new Error('Open operation is not supported in this runtime')
    }

    const roots = await this.resolveRoots()
    for (const dir of roots) {
      const filePath = path.join(dir, fileName)
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        await this.options.openPath(filePath)
        return
      }
    }

    throw new Error(`Skill file "${fileName}" not found in any skill directory`)
  }

  async deleteSkillFile(fileName: string): Promise<void> {
    const roots = await this.resolveRoots()
    for (const dir of roots) {
      const filePath = path.join(dir, fileName)
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      if (!exists) continue

      await fs.unlink(filePath)
      await this.reload()
      return
    }

    throw new Error(`Skill file "${fileName}" not found`)
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    const primary = await this.resolvePrimaryRoot()
    await fs.mkdir(primary, { recursive: true })

    const now = new Date()
    const fileName = `skill-${now.getTime()}.md`
    const filePath = path.join(primary, fileName)
    await fs.writeFile(filePath, defaultSkillTemplate(now), 'utf8')
    await this.reload()

    const created = this.cache.find((item) => item.filePath === filePath)
    if (!created) {
      throw new Error('Skill creation succeeded but metadata cache lookup failed')
    }
    return created
  }

  async createSkill(name: string, description: string, content: string): Promise<CreateSkillResult> {
    const primary = await this.resolvePrimaryRoot()
    await fs.mkdir(primary, { recursive: true })
    await this.reload()

    const existing = this.cache.find((item) => item.name === name)
    if (existing) {
      throw new Error(`Skill "${name}" already exists. Please use a different name.`)
    }

    const body = ['---', `name: ${name}`, `description: ${description}`, '---', '', content].join('\n')

    const preferredName = toSafeSkillFileName(name)
    let filePath = path.join(primary, preferredName)
    const pathTaken = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (pathTaken) {
      const base = preferredName.replace(/\.md$/i, '')
      filePath = path.join(primary, `${base}-${Date.now()}.md`)
    }

    await fs.writeFile(filePath, body, 'utf8')
    await this.reload()

    const created = this.cache.find((item) => item.filePath === filePath)
    if (!created) {
      throw new Error('Skill file created but metadata cache lookup failed')
    }

    return { skill: created }
  }

  async reload(): Promise<SkillInfo[]> {
    await this.ensureSkillsDir()

    const roots = await this.resolveRoots()
    const result: SkillInfo[] = []
    const seenNames = new Set<string>()

    for (const rootDir of roots) {
      const exists = await fs
        .access(rootDir)
        .then(() => true)
        .catch(() => false)
      if (!exists) continue

      let entries: Dirent[]
      try {
        entries = await fs.readdir(rootDir, { withFileTypes: true })
      } catch (error) {
        this.logger.error(`[FileSkillStore] Failed to read skill root: ${rootDir}`, error)
        continue
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue

        const entryPath = path.join(rootDir, entry.name)

        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const info = await this.tryBuildFlatSkillInfo(rootDir, entry.name, entryPath, seenNames)
          if (info) {
            result.push(info)
            seenNames.add(info.name)
          }
          continue
        }

        if (await resolvesToDirectory(entry, entryPath)) {
          const skillDir = entryPath
          const skillFilePath = path.join(skillDir, 'SKILL.md')
          const info = await this.tryBuildNestedSkillInfo(rootDir, skillDir, skillFilePath, seenNames)
          if (info) {
            result.push(info)
            seenNames.add(info.name)
          }
        }
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
    const states = this.options.getSkillEnabledMap?.() ?? {}
    return all.filter((skill) => states[skill.name] !== false)
  }

  async readSkillContentByName(name: string): Promise<{ info: SkillInfo; content: string }> {
    const skills = await this.getAll()
    const info = skills.find((item) => item.name === name)
    if (!info) {
      throw new Error(`Skill "${name}" not found`)
    }

    const raw = await fs.readFile(info.filePath, 'utf8')
    const parsed = parseFrontmatter(raw)
    let content = parsed.content.trim()

    if (info.isNested && info.supportingFiles && info.supportingFiles.length > 0) {
      const files = info.supportingFiles.map((relativePath) => `- ${path.join(info.baseDir, relativePath)}`).join('\n')
      content += `\n\n## Supporting Files\n\nSkill directory: ${info.baseDir}\n\n${files}`
    }

    return { info, content }
  }

  private async tryBuildFlatSkillInfo(
    scanRoot: string,
    fileName: string,
    filePath: string,
    seenNames: Set<string>
  ): Promise<SkillInfo | null> {
    const raw = await fs.readFile(filePath, 'utf8').catch(() => '')
    const parsed = parseFrontmatter(raw)
    const name = String(parsed.frontmatter.name || '').trim()
    const description = String(parsed.frontmatter.description || '').trim()
    if (!name || !description || seenNames.has(name)) {
      return null
    }

    return {
      name,
      description,
      fileName,
      filePath,
      baseDir: scanRoot,
      scanRoot,
      isNested: false
    }
  }

  private async tryBuildNestedSkillInfo(
    scanRoot: string,
    skillDir: string,
    skillFilePath: string,
    seenNames: Set<string>
  ): Promise<SkillInfo | null> {
    const exists = await fs
      .access(skillFilePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) return null

    const raw = await fs.readFile(skillFilePath, 'utf8').catch(() => '')
    const parsed = parseFrontmatter(raw)
    const name = String(parsed.frontmatter.name || '').trim()
    const description = String(parsed.frontmatter.description || '').trim()
    if (!name || !description || seenNames.has(name)) {
      return null
    }

    const supportingFiles = await listSupportingFiles(skillDir, skillFilePath)
    return {
      name,
      description,
      fileName: 'SKILL.md',
      filePath: skillFilePath,
      baseDir: skillDir,
      scanRoot,
      isNested: true,
      supportingFiles
    }
  }

  private async resolveRoots(): Promise<string[]> {
    const scanRoots = await Promise.resolve(this.options.getScanRoots())
    const primary = await this.resolvePrimaryRoot()
    const roots = [...scanRoots, primary]
    return Array.from(new Set(roots.map((entry) => path.resolve(entry))))
  }

  private async resolvePrimaryRoot(): Promise<string> {
    const value = await Promise.resolve(this.options.getPrimaryRoot())
    return path.resolve(value)
  }
}
