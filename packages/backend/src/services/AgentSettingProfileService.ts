import type {
  AgentSettingProfile,
  AgentSettingSnapshot,
  AgentSettingState,
  BackendSettings,
} from '../types'
import type {
  ISettingsRuntime,
  ICommandPolicyRuntime,
  IMcpRuntime,
  ISkillRuntime,
  IMemoryRuntime,
} from './runtimeContracts'
import type {
  CommandPolicyListName,
  CommandPolicyLists,
} from './CommandPolicy/CommandPolicyService'
import type { McpServerSummary } from './McpToolService'
import type { SkillInfo } from './SkillService'
import type { MemorySnapshot } from '../memory/FileMemoryStore'
import {
  getAgentSettingProfileId,
  getFirstAvailableAgentSettingSlotNumber,
  normalizeAgentSettingState,
  normalizeBooleanMap,
  normalizeCommandPolicyMode,
  normalizeAgentSettingCommandPolicyLists,
  normalizeAgentSettingProfileId,
  sortAgentSettingProfiles,
} from './settings/agentSettings'
import {
  buildBuiltInToolStatusSummary,
  buildSkillStatusSummary,
} from './Gateway/toolingSummary'
import {
  assertSettingsPatchDoesNotEnableExperimentalTools,
  buildExperimentalToolConfirmationRequired,
  getExperimentalToolsEnabledByTransition,
  getUnacknowledgedExperimentalTools,
  type ExperimentalToolConfirmationRequired,
} from './settings/experimentalToolConsent'

export interface AgentSettingOperationResult {
  settings: BackendSettings
  agentSettings: AgentSettingState
  commandPolicyLists: CommandPolicyLists
  mcpTools: McpServerSummary[]
  builtInTools: ReturnType<typeof buildBuiltInToolStatusSummary>
  skills: ReturnType<typeof buildSkillStatusSummary>
  memory: MemorySnapshot
  warnings: string[]
}

export type AgentSettingApplyResult =
  | AgentSettingOperationResult
  | ExperimentalToolConfirmationRequired

export type BuiltInToolMutationResult =
  | ReturnType<typeof buildBuiltInToolStatusSummary>
  | ExperimentalToolConfirmationRequired

interface AgentSettingProfileServiceOptions {
  settingsService: ISettingsRuntime
  commandPolicyService: ICommandPolicyRuntime
  mcpToolService: IMcpRuntime
  skillService: ISkillRuntime
  memoryService: IMemoryRuntime
  onSettingsChanged?: (settings: BackendSettings) => void | Promise<void>
  onActiveProfileSnapshotChanged?: (
    settings: BackendSettings,
  ) => void | Promise<void>
}

export class AgentSettingProfileService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: AgentSettingProfileServiceOptions) {}

  getState(): AgentSettingState {
    return this.getNormalizedAgentSettings(
      this.options.settingsService.getSettings(),
    )
  }

  async saveCurrent(): Promise<AgentSettingOperationResult> {
    return this.runMutation(async () => {
      const initialSettings = this.options.settingsService.getSettings()
      const initialState = this.getNormalizedAgentSettings(initialSettings)
      const slotNumber = getFirstAvailableAgentSettingSlotNumber(
        initialState.profiles,
      )
      if (!slotNumber) {
        throw new Error('All Agent Setting slots are already saved.')
      }

      await this.updateActiveProfileSnapshot()
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const now = Date.now()
      const profileId = getAgentSettingProfileId(slotNumber)
      const snapshot = await this.createCurrentSnapshot(settings)
      await this.copyActiveMemoryToProfile(settings, profileId)

      const profile: AgentSettingProfile = {
        id: profileId,
        slotNumber,
        createdAt: now,
        updatedAt: now,
        snapshot,
      }
      const nextState: AgentSettingState = {
        profiles: sortAgentSettingProfiles([...state.profiles, profile]),
        activeProfileId: profileId,
      }
      await this.persistAgentSettings(
        { ...settings, agentSettings: nextState },
        nextState,
      )
      return await this.buildResult([])
    })
  }

  async overwrite(profileId: string): Promise<AgentSettingOperationResult> {
    return this.runMutation(async () => {
      const normalizedProfileId = this.requireProfileId(profileId)
      const initialSettings = this.options.settingsService.getSettings()
      const initialState = this.getNormalizedAgentSettings(initialSettings)
      const initialProfile = initialState.profiles.find(
        (profile) => profile.id === normalizedProfileId,
      )
      if (!initialProfile) {
        throw new Error(
          `Agent Setting profile not found: ${normalizedProfileId}`,
        )
      }

      await this.updateActiveProfileSnapshot()
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const snapshot = await this.createCurrentSnapshot(settings)
      await this.copyActiveMemoryToProfile(settings, normalizedProfileId)
      const now = Date.now()
      const nextProfiles = state.profiles.map((profile) =>
        profile.id === normalizedProfileId
          ? {
              ...profile,
              updatedAt: now,
              snapshot,
            }
          : profile,
      )
      const nextState: AgentSettingState = {
        profiles: sortAgentSettingProfiles(nextProfiles),
        activeProfileId: normalizedProfileId,
      }
      await this.persistAgentSettings(
        { ...settings, agentSettings: nextState },
        nextState,
      )
      return await this.buildResult([])
    })
  }

  async delete(profileId: string): Promise<AgentSettingOperationResult> {
    return this.runMutation(async () => {
      const normalizedProfileId = this.requireProfileId(profileId)
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const nextProfiles = state.profiles.filter(
        (profile) => profile.id !== normalizedProfileId,
      )
      if (nextProfiles.length === state.profiles.length) {
        throw new Error(
          `Agent Setting profile not found: ${normalizedProfileId}`,
        )
      }
      const nextState: AgentSettingState = {
        profiles: nextProfiles,
        activeProfileId:
          state.activeProfileId === normalizedProfileId
            ? null
            : state.activeProfileId,
      }
      await this.persistAgentSettings(
        { ...settings, agentSettings: nextState },
        nextState,
      )
      return await this.buildResult([])
    })
  }

  async apply(
    profileId: string,
    acknowledgedExperimentalToolNames: readonly string[] = [],
  ): Promise<AgentSettingApplyResult> {
    return this.runMutation(async () => {
      const normalizedProfileId = this.requireProfileId(profileId)
      await this.updateActiveProfileSnapshot()
      const settings = this.options.settingsService.getSettings()
      const state = this.getNormalizedAgentSettings(settings)
      const profile = state.profiles.find(
        (entry) => entry.id === normalizedProfileId,
      )
      if (!profile) {
        throw new Error(
          `Agent Setting profile not found: ${normalizedProfileId}`,
        )
      }

      const warnings: string[] = []
      const snapshot = profile.snapshot
      const nextBuiltIn = this.buildAppliedBuiltInTools(
        settings.tools?.builtIn ?? {},
        snapshot.tools.builtIn,
      )
      const requiredExperimentalTools =
        getExperimentalToolsEnabledByTransition(
          settings.tools?.builtIn,
          nextBuiltIn,
        )
      const unacknowledgedExperimentalTools =
        getUnacknowledgedExperimentalTools(
          requiredExperimentalTools,
          acknowledgedExperimentalToolNames,
        )
      if (unacknowledgedExperimentalTools.length > 0) {
        return buildExperimentalToolConfirmationRequired(
          requiredExperimentalTools,
        )
      }

      const mcpTools = await this.applyMcpSnapshot(snapshot.tools.mcp)
      await this.applyCommandPolicySnapshot(
        snapshot.security.commandPolicyLists,
      )

      const currentSettings = this.options.settingsService.getSettings()
      const currentSkills = await this.options.skillService.getAll()
      const nextSettings = this.createAppliedSettings(
        currentSettings,
        snapshot,
        normalizedProfileId,
        currentSkills,
        warnings,
      )
      const nextState: AgentSettingState = {
        profiles: state.profiles,
        activeProfileId: normalizedProfileId,
      }
      await this.persistAgentSettings(
        { ...nextSettings, agentSettings: nextState },
        nextState,
      )

      return await this.buildResult(warnings, mcpTools)
    })
  }

  async setBuiltInToolEnabled(
    name: string,
    enabled: boolean,
    acknowledgedExperimentalToolNames: readonly string[] = [],
  ): Promise<BuiltInToolMutationResult> {
    return this.runMutation(async () => {
      const settings = this.options.settingsService.getSettings()
      const currentBuiltIn = settings.tools?.builtIn ?? {}
      const nextBuiltIn = { ...currentBuiltIn, [name]: enabled }
      const requiredExperimentalTools =
        getExperimentalToolsEnabledByTransition(currentBuiltIn, nextBuiltIn)
      const unacknowledgedExperimentalTools =
        getUnacknowledgedExperimentalTools(
          requiredExperimentalTools,
          acknowledgedExperimentalToolNames,
        )
      if (unacknowledgedExperimentalTools.length > 0) {
        return buildExperimentalToolConfirmationRequired(
          requiredExperimentalTools,
        )
      }

      this.options.settingsService.setSettings({
        tools: {
          builtIn: nextBuiltIn,
          skills: settings.tools?.skills ?? {},
        },
      })
      await this.updateActiveProfileSnapshot()
      const nextSettings = this.options.settingsService.getSettings()
      await this.options.onSettingsChanged?.(nextSettings)
      return buildBuiltInToolStatusSummary(nextSettings.tools?.builtIn)
    })
  }

  async setMcpToolEnabled(
    name: string,
    enabled: boolean,
  ): Promise<McpServerSummary[]> {
    return this.runMutation(async () => {
      const summaries = await this.options.mcpToolService.setServerEnabled(
        name,
        enabled,
      )
      const profileUpdated = await this.updateActiveProfileSnapshot()
      if (profileUpdated) {
        await this.options.onSettingsChanged?.(
          this.options.settingsService.getSettings(),
        )
      }
      return summaries
    })
  }

  async reloadMcpTools(): Promise<McpServerSummary[]> {
    return this.runMutation(async () => {
      const summaries = await this.options.mcpToolService.reloadAll()
      const profileUpdated = await this.updateActiveProfileSnapshot()
      if (profileUpdated) {
        await this.options.onSettingsChanged?.(
          this.options.settingsService.getSettings(),
        )
      }
      return summaries
    })
  }

  async reloadSkills(): Promise<SkillInfo[]> {
    return this.runMutation(async () => {
      const skills = await this.options.skillService.reload()
      const profileUpdated = await this.updateActiveProfileSnapshot()
      if (profileUpdated) {
        await this.options.onSettingsChanged?.(
          this.options.settingsService.getSettings(),
        )
      }
      return skills
    })
  }

  async createSkillFromTemplate(): Promise<SkillInfo> {
    return this.runMutation(async () => {
      const createSkill = this.options.skillService.createSkillFromTemplate
      if (!createSkill) {
        throw new Error('Skill creation is not available in this runtime.')
      }
      const skill = await createSkill.call(this.options.skillService)
      const profileUpdated = await this.updateActiveProfileSnapshot()
      if (profileUpdated) {
        await this.options.onSettingsChanged?.(
          this.options.settingsService.getSettings(),
        )
      }
      return skill
    })
  }

  async deleteSkillFile(fileName: string): Promise<SkillInfo[]> {
    return this.runMutation(async () => {
      const deleteSkillFile = this.options.skillService.deleteSkillFile
      if (!deleteSkillFile) {
        throw new Error('Skill deletion is not available in this runtime.')
      }
      await deleteSkillFile.call(this.options.skillService, fileName)
      const skills = await this.options.skillService.getAll()
      const profileUpdated = await this.updateActiveProfileSnapshot()
      if (profileUpdated) {
        await this.options.onSettingsChanged?.(
          this.options.settingsService.getSettings(),
        )
      }
      return skills
    })
  }

  async setSkillEnabled(
    name: string,
    enabled: boolean,
  ): Promise<ReturnType<typeof buildSkillStatusSummary>> {
    return this.runMutation(async () => {
      const settings = this.options.settingsService.getSettings()
      const nextSkills = { ...(settings.tools?.skills ?? {}) }
      nextSkills[name] = enabled
      this.options.settingsService.setSettings({
        tools: {
          builtIn: settings.tools?.builtIn ?? {},
          skills: nextSkills,
        },
      })
      await this.updateActiveProfileSnapshot()
      const nextSettings = this.options.settingsService.getSettings()
      await this.options.onSettingsChanged?.(nextSettings)
      return buildSkillStatusSummary(
        await this.options.skillService.getAll(),
        nextSettings.tools?.skills,
      )
    })
  }

  async addCommandPolicyRule(
    listName: CommandPolicyListName,
    rule: string,
  ): Promise<CommandPolicyLists> {
    return this.runMutation(async () => {
      const lists = await this.options.commandPolicyService.addRule(
        listName,
        rule,
      )
      const profileUpdated = await this.updateActiveProfileSnapshot()
      if (profileUpdated) {
        await this.options.onSettingsChanged?.(
          this.options.settingsService.getSettings(),
        )
      }
      return lists
    })
  }

  async deleteCommandPolicyRule(
    listName: CommandPolicyListName,
    rule: string,
  ): Promise<CommandPolicyLists> {
    return this.runMutation(async () => {
      const lists = await this.options.commandPolicyService.deleteRule(
        listName,
        rule,
      )
      const profileUpdated = await this.updateActiveProfileSnapshot()
      if (profileUpdated) {
        await this.options.onSettingsChanged?.(
          this.options.settingsService.getSettings(),
        )
      }
      return lists
    })
  }

  async applySettingsPatch(
    settingsPatch: Partial<BackendSettings>,
    beforeCommit?: () => Promise<void>,
  ): Promise<BackendSettings> {
    return this.runMutation(async () => {
      assertSettingsPatchDoesNotEnableExperimentalTools(
        this.options.settingsService.getSettings().tools?.builtIn,
        settingsPatch,
      )
      await beforeCommit?.()
      assertSettingsPatchDoesNotEnableExperimentalTools(
        this.options.settingsService.getSettings().tools?.builtIn,
        settingsPatch,
      )
      this.options.settingsService.setSettings(settingsPatch)
      await this.updateActiveProfileSnapshot()
      const nextSettings = this.options.settingsService.getSettings()
      await this.options.onSettingsChanged?.(nextSettings)
      return nextSettings
    })
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation, operation)
    this.mutationQueue = pending.catch(() => undefined)
    return await pending
  }

  private requireProfileId(profileId: string): string {
    const normalizedProfileId = normalizeAgentSettingProfileId(profileId)
    if (!normalizedProfileId) {
      throw new Error(`Invalid Agent Setting profile id: ${profileId}`)
    }
    return normalizedProfileId
  }

  private getNormalizedAgentSettings(
    settings: BackendSettings,
  ): AgentSettingState {
    return normalizeAgentSettingState(settings.agentSettings, {
      recursionLimit: settings.recursionLimit ?? 200,
      experimental: settings.experimental!,
    })
  }

  private getActiveMemoryProfileId(settings: BackendSettings): string | null {
    return settings.agentSettings?.activeProfileId || null
  }

  private async copyActiveMemoryToProfile(
    settings: BackendSettings,
    profileId: string,
  ): Promise<void> {
    if (this.options.memoryService.copyMemory) {
      await this.options.memoryService.copyMemory(
        this.getActiveMemoryProfileId(settings),
        profileId,
      )
      return
    }
    const content = await this.options.memoryService.readMemory(
      this.getActiveMemoryProfileId(settings),
    )
    await this.options.memoryService.writeMemory(content, profileId)
  }

  private async createCurrentSnapshot(
    settings: BackendSettings,
  ): Promise<AgentSettingSnapshot> {
    const commandPolicyLists =
      await this.options.commandPolicyService.getLists()
    const mcpTools = this.options.mcpToolService.getSummaries()
    const skills = await this.options.skillService.getAll()
    const activeProfile = settings.models.profiles.find(
      (profile) => profile.id === settings.models.activeProfileId,
    )

    return {
      version: 1,
      security: {
        commandPolicyMode: normalizeCommandPolicyMode(
          settings.commandPolicyMode,
        ),
        commandPolicyLists:
          normalizeAgentSettingCommandPolicyLists(commandPolicyLists),
      },
      tools: {
        builtIn: normalizeBooleanMap(settings.tools?.builtIn),
        mcp: Object.fromEntries(
          mcpTools.map((tool) => [tool.name, tool.enabled !== false]),
        ),
      },
      skills: Object.fromEntries(
        skills.map((skill) => [
          skill.name,
          settings.tools?.skills?.[skill.name] !== false,
        ]),
      ),
      memory: {
        enabled: settings.memory?.enabled !== false,
      },
      workflow: {
        recursionLimit: settings.recursionLimit ?? 200,
        experimental: {
          runtimeThinkingCorrectionEnabled:
            settings.experimental?.runtimeThinkingCorrectionEnabled !== false,
          taskFinishGuardEnabled:
            settings.experimental?.taskFinishGuardEnabled !== false,
          firstTurnThinkingModelEnabled:
            settings.experimental?.firstTurnThinkingModelEnabled === true,
          execCommandActionModelEnabled:
            settings.experimental?.execCommandActionModelEnabled !== false,
          writeStdinActionModelEnabled:
            settings.experimental?.writeStdinActionModelEnabled !== false,
        },
      },
      model: {
        activeProfileId: settings.models.activeProfileId || '',
        activeProfileName: activeProfile?.name,
      },
    }
  }

  private async updateActiveProfileSnapshot(): Promise<boolean> {
    const settings = this.options.settingsService.getSettings()
    const state = this.getNormalizedAgentSettings(settings)
    const activeProfileId = state.activeProfileId
    if (!activeProfileId) {
      return false
    }

    const snapshot = await this.createCurrentSnapshot(settings)
    const now = Date.now()
    const nextState: AgentSettingState = {
      profiles: state.profiles.map((profile) =>
        profile.id === activeProfileId
          ? {
              ...profile,
              updatedAt: now,
              snapshot,
            }
          : profile,
      ),
      activeProfileId,
    }
    this.options.settingsService.setSettings({ agentSettings: nextState })
    await this.options.onActiveProfileSnapshotChanged?.(
      this.options.settingsService.getSettings(),
    )
    return true
  }

  private async applyCommandPolicySnapshot(
    lists: CommandPolicyLists,
  ): Promise<void> {
    if (this.options.commandPolicyService.setLists) {
      await this.options.commandPolicyService.setLists(lists)
      return
    }

    const currentLists = await this.options.commandPolicyService.getLists()
    for (const listName of ['allowlist', 'denylist', 'asklist'] as const) {
      for (const rule of currentLists[listName]) {
        await this.options.commandPolicyService.deleteRule(listName, rule)
      }
      for (const rule of lists[listName]) {
        await this.options.commandPolicyService.addRule(listName, rule)
      }
    }
  }

  private async applyMcpSnapshot(
    enabledByName: Record<string, boolean>,
  ): Promise<McpServerSummary[]> {
    const current = this.options.mcpToolService.getSummaries()
    const currentNames = new Set(current.map((tool) => tool.name))
    const filtered = Object.fromEntries(
      Object.entries(enabledByName).filter(
        ([name, enabled]) =>
          currentNames.has(name) && typeof enabled === 'boolean',
      ),
    )

    if (this.options.mcpToolService.setServerEnabledBatch) {
      return await this.options.mcpToolService.setServerEnabledBatch(filtered)
    }

    let next = current
    for (const [name, enabled] of Object.entries(filtered)) {
      next = await this.options.mcpToolService.setServerEnabled(name, enabled)
    }
    return next
  }

  private createAppliedSettings(
    currentSettings: BackendSettings,
    snapshot: AgentSettingSnapshot,
    profileId: string,
    currentSkills: SkillInfo[],
    warnings: string[],
  ): BackendSettings {
    const nextBuiltIn = this.buildAppliedBuiltInTools(
      currentSettings.tools?.builtIn ?? {},
      snapshot.tools.builtIn,
    )

    const currentSkillNames = new Set(currentSkills.map((skill) => skill.name))
    const nextSkills = { ...(currentSettings.tools?.skills ?? {}) }
    Object.entries(snapshot.skills).forEach(([name, enabled]) => {
      if (currentSkillNames.has(name)) {
        nextSkills[name] = enabled
      }
    })

    const modelProfileExists = currentSettings.models.profiles.some(
      (entry) => entry.id === snapshot.model.activeProfileId,
    )
    if (!modelProfileExists && snapshot.model.activeProfileId) {
      warnings.push(
        `Saved model profile "${snapshot.model.activeProfileName || snapshot.model.activeProfileId}" no longer exists. Current model profile was preserved.`,
      )
    }

    return {
      ...currentSettings,
      commandPolicyMode: snapshot.security.commandPolicyMode,
      tools: {
        builtIn: nextBuiltIn,
        skills: nextSkills,
      },
      memory: {
        enabled: snapshot.memory.enabled,
      },
      recursionLimit: snapshot.workflow.recursionLimit,
      experimental: snapshot.workflow.experimental,
      models: {
        ...currentSettings.models,
        activeProfileId: modelProfileExists
          ? snapshot.model.activeProfileId
          : currentSettings.models.activeProfileId,
      },
      agentSettings: {
        profiles: this.getNormalizedAgentSettings(currentSettings).profiles,
        activeProfileId: profileId,
      },
    }
  }

  private buildAppliedBuiltInTools(
    currentBuiltIn: Record<string, boolean>,
    snapshotBuiltIn: Record<string, boolean>,
  ): Record<string, boolean> {
    const nextBuiltIn = { ...currentBuiltIn }
    Object.entries(snapshotBuiltIn).forEach(([name, enabled]) => {
      if (Object.prototype.hasOwnProperty.call(currentBuiltIn, name)) {
        nextBuiltIn[name] = enabled
      }
    })
    return nextBuiltIn
  }

  private async persistAgentSettings(
    nextSettings: BackendSettings,
    nextState: AgentSettingState,
  ): Promise<void> {
    this.options.settingsService.setSettings({
      commandPolicyMode: nextSettings.commandPolicyMode,
      tools: nextSettings.tools,
      memory: nextSettings.memory,
      recursionLimit: nextSettings.recursionLimit,
      experimental: nextSettings.experimental,
      models: nextSettings.models,
      agentSettings: nextState,
    })
    const settings = this.options.settingsService.getSettings()
    await this.options.onSettingsChanged?.(settings)
  }

  private async buildResult(
    warnings: string[],
    mcpTools?: McpServerSummary[],
  ): Promise<AgentSettingOperationResult> {
    const settings = this.options.settingsService.getSettings()
    const allSkills = await this.options.skillService.getAll()
    const activeProfileId = settings.agentSettings?.activeProfileId || null
    return {
      settings,
      agentSettings: this.getNormalizedAgentSettings(settings),
      commandPolicyLists: await this.options.commandPolicyService.getLists(),
      mcpTools: mcpTools ?? this.options.mcpToolService.getSummaries(),
      builtInTools: buildBuiltInToolStatusSummary(settings.tools?.builtIn),
      skills: buildSkillStatusSummary(allSkills, settings.tools?.skills),
      memory:
        await this.options.memoryService.getMemorySnapshot(activeProfileId),
      warnings,
    }
  }
}
