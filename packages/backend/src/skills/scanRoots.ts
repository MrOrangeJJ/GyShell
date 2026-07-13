import path from 'node:path'
import os from 'node:os'

export interface SkillScanRootOptions {
  primaryRoot: string
  homeDir?: string
}

export function resolveDefaultSkillScanRoots(options: SkillScanRootOptions): string[] {
  const primaryRoot = path.resolve(options.primaryRoot)
  const homeDir = (options.homeDir || os.homedir() || '').trim()

  const roots: string[] = [primaryRoot]

  if (homeDir) {
    roots.push(path.join(homeDir, '.agents', 'skills'))
  }

  return [...new Set(roots.map((root) => path.resolve(root)))]
}
