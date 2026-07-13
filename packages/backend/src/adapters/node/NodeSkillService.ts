import path from 'node:path'
import os from 'node:os'
import type { NodeSettingsService } from './NodeSettingsService'
import {
  FileSkillStore,
  type SkillInfo,
  type CreateSkillResult
} from '../../skills/FileSkillStore'
import { resolveDefaultSkillScanRoots } from '../../skills/scanRoots'

export type { SkillInfo, CreateSkillResult }

export class NodeSkillService {
  private readonly skillsDir: string
  private readonly scanRoots: string[]
  private readonly core: FileSkillStore

  constructor(dataDir: string, private readonly settingsService?: NodeSettingsService) {
    this.skillsDir = path.join(dataDir, 'skills')
    this.scanRoots = this.resolveScanRoots()
    this.core = new FileSkillStore({
      getScanRoots: () => this.scanRoots,
      getPrimaryRoot: () => this.skillsDir,
      getSkillEnabledMap: () => this.settingsService?.getSettings().tools?.skills ?? {},
      logger: {
        error: (message, error) => console.error(message, error)
      }
    })
  }

  getSkillsDir(): string {
    return this.skillsDir
  }

  async reload(): Promise<SkillInfo[]> {
    return this.core.reload()
  }

  async getAll(): Promise<SkillInfo[]> {
    return this.core.getAll()
  }

  async getEnabledSkills(): Promise<SkillInfo[]> {
    return this.core.getEnabledSkills()
  }

  async readSkillContentByName(name: string): Promise<{ info: SkillInfo; content: string }> {
    return this.core.readSkillContentByName(name)
  }

  async createSkill(name: string, description: string, content: string): Promise<CreateSkillResult> {
    return this.core.createSkill(name, description, content)
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    return this.core.createSkillFromTemplate()
  }

  async deleteSkillFile(fileName: string): Promise<void> {
    return this.core.deleteSkillFile(fileName)
  }

  private resolveScanRoots(): string[] {
    return resolveDefaultSkillScanRoots({
      primaryRoot: this.skillsDir,
      homeDir: os.homedir()
    })
  }
}
