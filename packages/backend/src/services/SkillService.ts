import path from 'node:path'
import { app, shell } from 'electron'
import { SettingsService } from './SettingsService'
import {
  FileSkillStore,
  type SkillInfo,
  type CreateSkillResult
} from '../skills/FileSkillStore'
import { resolveDefaultSkillScanRoots } from '../skills/scanRoots'

export type { SkillInfo, CreateSkillResult }

export class SkillService {
  private settingsService?: SettingsService
  private readonly core: FileSkillStore

  constructor(settingsService?: SettingsService) {
    this.settingsService = settingsService
    this.core = new FileSkillStore({
      getScanRoots: () => this.getSkillsDirs(),
      getPrimaryRoot: () => this.getSkillsDirs()[0],
      getSkillEnabledMap: () => this.settingsService?.getSettings().tools?.skills ?? {},
      openPath: async (absolutePath: string) => {
        await shell.openPath(absolutePath)
      },
      logger: {
        error: (message, error) => console.error(message, error)
      }
    })
  }

  setSettingsService(settingsService: SettingsService): void {
    this.settingsService = settingsService
  }

  getSkillsDirs(): string[] {
    const baseDir = app.getPath('userData')
    return resolveDefaultSkillScanRoots({
      primaryRoot: path.join(baseDir, 'skills'),
      homeDir: app.getPath('home')
    })
  }

  async ensureSkillsDir(): Promise<void> {
    await this.core.ensureSkillsDir()
  }

  async openSkillsFolder(): Promise<void> {
    await this.core.openSkillsFolder()
  }

  async openSkillFile(fileName: string): Promise<void> {
    await this.core.openSkillFile(fileName)
  }

  async deleteSkillFile(fileName: string): Promise<void> {
    await this.core.deleteSkillFile(fileName)
  }

  async createSkill(
    name: string,
    description: string,
    content: string
  ): Promise<CreateSkillResult> {
    return this.core.createSkill(name, description, content)
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    return this.core.createSkillFromTemplate()
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
}
