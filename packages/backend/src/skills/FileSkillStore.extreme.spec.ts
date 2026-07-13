import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileSkillStore } from './FileSkillStore'
import { resolveDefaultSkillScanRoots } from './scanRoots'

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gyshell-skill-store-'))
  try {
    await fn(tempDir)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

const exists = async (targetPath: string): Promise<boolean> =>
  fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false)

const writeFlatSkill = async (root: string, fileName: string, name: string): Promise<void> => {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, fileName),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', '# Instructions'].join('\n'),
    'utf8'
  )
}

const run = async (): Promise<void> => {
  await runCase('default scan roots load only GyShell and ~/.agents skills', async () => {
    await withTempDir(async (tempDir) => {
      const primaryRoot = path.join(tempDir, 'gyshell-data', 'skills')
      const homeDir = path.join(tempDir, 'home')
      const agentsRoot = path.join(homeDir, '.agents', 'skills')
      const excludedRoots = [
        path.join(homeDir, '.claude', 'skills'),
        path.join(homeDir, '.codex', 'skills'),
        path.join(homeDir, '.config', 'agents', 'skills'),
        path.join(tempDir, 'app-data', 'agents', 'skills'),
        path.join(tempDir, 'codex-home', 'skills')
      ]

      await writeFlatSkill(primaryRoot, 'gyshell.md', 'gyshell-only')
      await writeFlatSkill(agentsRoot, 'agents.md', 'agents-only')
      for (const [index, root] of excludedRoots.entries()) {
        await writeFlatSkill(root, `excluded-${index}.md`, `excluded-${index}`)
      }

      const previousAppData = process.env.APPDATA
      const previousCodexHome = process.env.CODEX_HOME
      process.env.APPDATA = path.join(tempDir, 'app-data')
      process.env.CODEX_HOME = path.join(tempDir, 'codex-home')

      try {
        const scanRoots = resolveDefaultSkillScanRoots({ primaryRoot, homeDir })
        assertEqual(scanRoots.length, 2, 'default scan root count should be limited to two')
        assertEqual(scanRoots[0], path.resolve(primaryRoot), 'primary root should have highest priority')
        assertEqual(scanRoots[1], path.resolve(agentsRoot), '~/.agents/skills should be the only external root')

        const store = new FileSkillStore({
          getPrimaryRoot: () => primaryRoot,
          getScanRoots: () => scanRoots
        })
        const skills = await store.reload()

        assertEqual(skills.length, 2, 'only skills from the two supported roots should load')
        assertEqual(
          skills.map((skill) => skill.name).join(','),
          'agents-only,gyshell-only',
          'skills from excluded compatibility roots must not load'
        )
      } finally {
        if (previousAppData === undefined) delete process.env.APPDATA
        else process.env.APPDATA = previousAppData
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = previousCodexHome
      }
    })
  })

  await runCase('reload creates only the primary skill directory and skips a missing external root', async () => {
    await withTempDir(async (tempDir) => {
      const primaryRoot = path.join(tempDir, 'gyshell-data', 'skills')
      const missingAgentsRoot = path.join(tempDir, 'home', '.agents', 'skills')

      const store = new FileSkillStore({
        getPrimaryRoot: () => primaryRoot,
        getScanRoots: () => [primaryRoot, missingAgentsRoot]
      })

      const skills = await store.reload()

      assertEqual(skills.length, 0, 'reload should not synthesize skills for empty roots')
      assert(await exists(primaryRoot), 'reload should create the primary skills root')
      assert(!(await exists(missingAgentsRoot)), 'reload must not create missing agents compatibility roots')
    })
  })

  await runCase('createSkillFromTemplate still creates the primary skill directory', async () => {
    await withTempDir(async (tempDir) => {
      const primaryRoot = path.join(tempDir, 'gyshell-data', 'skills')
      const store = new FileSkillStore({
        getPrimaryRoot: () => primaryRoot,
        getScanRoots: () => [primaryRoot]
      })

      const created = await store.createSkillFromTemplate()

      assert(await exists(primaryRoot), 'createSkillFromTemplate should create the primary skills root')
      assertEqual(created.filePath, path.join(primaryRoot, created.fileName), 'created skill should live in the primary root')
      assertEqual(created.baseDir, primaryRoot, 'created skill metadata should point to the primary root')
    })
  })
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
