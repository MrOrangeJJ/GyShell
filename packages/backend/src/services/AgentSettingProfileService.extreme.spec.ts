import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendSettings } from '../types'
import { NodeSettingsService } from '../adapters/node/NodeSettingsService'
import { AgentSettingProfileService } from './AgentSettingProfileService'
import { migrateBackendSettings } from './settings/migrations'
import { deepMerge } from './settings/objectMerge'
import { getAgentSettingProfileId } from './settings/agentSettings'
import {
  assertSettingsPatchDoesNotEnableExperimentalTools,
  isExperimentalToolConfirmationRequired,
} from './settings/experimentalToolConsent'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}. expected=${expectedJson} actual=${actualJson}`)
  }
}

const assertRejects = async (
  fn: () => Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<void> => {
  try {
    await fn()
    throw new Error(`${message}: expected rejection`)
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error)
    if (!pattern.test(actualMessage)) {
      throw new Error(`${message}: unexpected error "${actualMessage}"`)
    }
  }
}

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

class MockSettingsService {
  settings: BackendSettings

  constructor(initial?: Partial<BackendSettings>) {
    this.settings = migrateBackendSettings(
      deepMerge(
        {
          models: {
            items: [
              {
                id: 'model-fast',
                name: 'Fast',
                model: 'fast',
                apiKey: 'key',
                maxTokens: 200000,
                structuredOutputMode: 'auto',
                supportsStructuredOutput: false,
                supportsObjectToolChoice: false,
              },
              {
                id: 'model-deep',
                name: 'Deep',
                model: 'deep',
                apiKey: 'key',
                maxTokens: 200000,
                structuredOutputMode: 'auto',
                supportsStructuredOutput: false,
                supportsObjectToolChoice: false,
              },
            ],
            profiles: [
              { id: 'profile-fast', name: 'Fast', globalModelId: 'model-fast' },
              { id: 'profile-deep', name: 'Deep', globalModelId: 'model-deep' },
            ],
            activeProfileId: 'profile-fast',
          },
          tools: {
            builtIn: {
              exec_command: true,
              read_file: true,
              write_stdin: false,
            },
            skills: {
              docs: true,
              deploy: false,
            },
          },
          recursionLimit: 300,
          experimental: {
            runtimeThinkingCorrectionEnabled: true,
            taskFinishGuardEnabled: true,
            firstTurnThinkingModelEnabled: false,
            execCommandActionModelEnabled: true,
            writeStdinActionModelEnabled: false,
          },
        } as Partial<BackendSettings>,
        initial ?? {},
      ),
    )
  }

  getSettings(): BackendSettings {
    return this.settings
  }

  setSettings(settings: Partial<BackendSettings>): void {
    this.settings = migrateBackendSettings(deepMerge(this.settings, settings))
  }
}

class MockCommandPolicyService {
  lists = {
    allowlist: ['ls *'],
    denylist: ['rm -rf /'],
    asklist: ['git push'],
  }

  setFeedbackWaiter(): void {}
  getPolicyFilePath(): string {
    return '/tmp/command-policy.json'
  }
  async getLists() {
    return {
      allowlist: [...this.lists.allowlist],
      denylist: [...this.lists.denylist],
      asklist: [...this.lists.asklist],
    }
  }
  async addRule(listName: keyof typeof this.lists, rule: string) {
    this.lists[listName] = Array.from(new Set([...this.lists[listName], rule]))
    return this.getLists()
  }
  async deleteRule(listName: keyof typeof this.lists, rule: string) {
    this.lists[listName] = this.lists[listName].filter((item) => item !== rule)
    return this.getLists()
  }
  async setLists(lists: typeof this.lists) {
    this.lists = {
      allowlist: [...lists.allowlist],
      denylist: [...lists.denylist],
      asklist: [...lists.asklist],
    }
    return this.getLists()
  }
  async evaluate(): Promise<'allow'> {
    return 'allow'
  }
  async requestApproval(): Promise<boolean> {
    return true
  }
}

class MockMcpToolService {
  tools = [
    { name: 'search', enabled: true, status: 'connected' as const },
    { name: 'files', enabled: false, status: 'disabled' as const },
  ]

  on(): this {
    return this
  }
  getConfigPath(): string {
    return '/tmp/mcp.json'
  }
  async reloadAll() {
    return this.getSummaries()
  }
  getSummaries() {
    return this.tools.map((tool) => ({ ...tool }))
  }
  async setServerEnabled(name: string, enabled: boolean) {
    this.tools = this.tools.map((tool) =>
      tool.name === name
        ? { ...tool, enabled, status: enabled ? 'connected' : 'disabled' }
        : tool,
    )
    return this.getSummaries()
  }
  async setServerEnabledBatch(enabledByName: Record<string, boolean>) {
    for (const [name, enabled] of Object.entries(enabledByName)) {
      await this.setServerEnabled(name, enabled)
    }
    return this.getSummaries()
  }
  isMcpToolName(): boolean {
    return false
  }
  getActiveTools(): any[] {
    return []
  }
  async invokeTool(): Promise<unknown> {
    return null
  }
}

class MockSkillService {
  skills = [
    { name: 'docs', description: 'Docs' },
    { name: 'deploy', description: 'Deploy' },
  ]

  async reload() {
    return this.getAll()
  }
  async getAll() {
    return this.skills.map((skill) => ({ ...skill })) as any[]
  }
  async getEnabledSkills() {
    return this.getAll()
  }
  async readSkillContentByName(): Promise<any> {
    throw new Error('not implemented')
  }
  async createSkill(): Promise<any> {
    throw new Error('not implemented')
  }
}

class MockMemoryService {
  files = new Map<string, string>([['default', 'default memory']])

  key(profileId?: string | null): string {
    return profileId || 'default'
  }
  async ensureMemoryFile(profileId?: string | null): Promise<string> {
    const key = this.key(profileId)
    if (!this.files.has(key)) {
      this.files.set(key, '# Memory\n')
    }
    return `/tmp/${key}/memory.md`
  }
  async getMemoryFilePath(profileId?: string | null): Promise<string> {
    return this.ensureMemoryFile(profileId)
  }
  async getMemorySnapshot(profileId?: string | null) {
    const filePath = await this.ensureMemoryFile(profileId)
    return { filePath, content: this.files.get(this.key(profileId)) || '' }
  }
  async readMemory(profileId?: string | null): Promise<string> {
    await this.ensureMemoryFile(profileId)
    return this.files.get(this.key(profileId)) || ''
  }
  async writeMemory(content: string, profileId?: string | null) {
    await this.ensureMemoryFile(profileId)
    this.files.set(this.key(profileId), content)
    return this.getMemorySnapshot(profileId)
  }
  async copyMemory(
    sourceProfileId?: string | null,
    targetProfileId?: string | null,
  ) {
    return this.writeMemory(
      await this.readMemory(sourceProfileId),
      targetProfileId,
    )
  }
}

const createHarness = () => {
  const settingsService = new MockSettingsService()
  const commandPolicyService = new MockCommandPolicyService()
  const mcpToolService = new MockMcpToolService()
  const skillService = new MockSkillService()
  const memoryService = new MockMemoryService()
  let settingsChangedCount = 0
  let activeProfileSnapshotChangedCount = 0
  const service = new AgentSettingProfileService({
    settingsService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    onSettingsChanged: () => {
      settingsChangedCount += 1
    },
    onActiveProfileSnapshotChanged: () => {
      activeProfileSnapshotChangedCount += 1
    },
  })
  return {
    service,
    settingsService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    get settingsChangedCount() {
      return settingsChangedCount
    },
    get activeProfileSnapshotChangedCount() {
      return activeProfileSnapshotChangedCount
    },
  }
}

const run = async (): Promise<void> => {
  await runCase(
    'saveCurrent creates a stable slot and copies active memory',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      const state = harness.settingsService.getSettings().agentSettings!
      assertEqual(state.profiles.length, 1, 'one profile should be saved')
      assertEqual(
        state.profiles[0].id,
        getAgentSettingProfileId(1),
        'slot 1 id should be used',
      )
      assertEqual(
        state.activeProfileId,
        getAgentSettingProfileId(1),
        'new slot should become active',
      )
      assertEqual(
        await harness.memoryService.readMemory(getAgentSettingProfileId(1)),
        'default memory',
        'slot memory should be copied from default',
      )
      assertEqual(
        state.profiles[0].snapshot.model.activeProfileId,
        'profile-fast',
        'active model profile should be captured',
      )
    },
  )

  await runCase(
    'saveCurrent caps at five slots and delete reuses the freed slot',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      await assertRejects(
        () => harness.service.saveCurrent(),
        /already saved/,
        'sixth save should fail',
      )
      await harness.service.delete(getAgentSettingProfileId(4))
      await harness.service.saveCurrent()
      const slots = harness.settingsService
        .getSettings()
        .agentSettings!.profiles.map((profile) => profile.slotNumber)
        .join(',')
      assertEqual(slots, '1,2,3,4,5', 'deleted slot number should be reused')
    },
  )

  await runCase(
    'saveCurrent refreshes the outgoing active profile before switching slots',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      const sourceSlotId = getAgentSettingProfileId(1)

      await harness.mcpToolService.setServerEnabled('search', false)
      await harness.commandPolicyService.addRule('allowlist', 'pwd')
      await harness.service.saveCurrent()

      await harness.service.setMcpToolEnabled('search', true)
      await harness.service.deleteCommandPolicyRule('allowlist', 'pwd')
      const result = await harness.service.apply(sourceSlotId)
      if (isExperimentalToolConfirmationRequired(result)) {
        throw new Error('source profile apply unexpectedly required confirmation')
      }

      assertEqual(
        harness.mcpToolService
          .getSummaries()
          .find((tool) => tool.name === 'search')?.enabled,
        false,
        'new-slot creation should save outgoing MCP state before switching',
      )
      assertDeepEqual(
        await harness.commandPolicyService.getLists(),
        {
          allowlist: ['ls *', 'pwd'],
          denylist: ['rm -rf /'],
          asklist: ['git push'],
        },
        'new-slot creation should save outgoing policy state before switching',
      )
    },
  )

  await runCase(
    'overwrite refreshes the outgoing active profile before switching slots',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      const overwriteTargetId = getAgentSettingProfileId(1)
      await harness.service.saveCurrent()
      const sourceSlotId = getAgentSettingProfileId(2)

      await harness.mcpToolService.setServerEnabled('search', false)
      await harness.service.overwrite(overwriteTargetId)
      await harness.service.setMcpToolEnabled('search', true)

      const result = await harness.service.apply(sourceSlotId)
      if (isExperimentalToolConfirmationRequired(result)) {
        throw new Error('source profile apply unexpectedly required confirmation')
      }
      assertEqual(
        harness.mcpToolService
          .getSummaries()
          .find((tool) => tool.name === 'search')?.enabled,
        false,
        'overwrite should save the outgoing slot before activating its target',
      )
    },
  )

  await runCase(
    'MCP reload refreshes and publishes the active profile snapshot',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      harness.mcpToolService.reloadAll = async () => {
        return await harness.mcpToolService.setServerEnabled('search', false)
      }

      await harness.service.reloadMcpTools()
      const profile = harness.settingsService
        .getSettings()
        .agentSettings!.profiles.find(
          (entry) => entry.id === getAgentSettingProfileId(1),
        )
      assertEqual(
        profile!.snapshot.tools.mcp.search,
        false,
        'MCP config reload should auto-save the loaded enabled state',
      )
      assertEqual(
        harness.activeProfileSnapshotChangedCount,
        1,
        'MCP config reload should publish the refreshed snapshot',
      )
    },
  )

  await runCase(
    'skill reload refreshes and publishes the active profile snapshot',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      harness.skillService.skills.push({
        name: 'new-skill',
        description: 'New skill',
      })

      await harness.service.reloadSkills()
      const profile = harness.settingsService
        .getSettings()
        .agentSettings!.profiles.find(
          (entry) => entry.id === getAgentSettingProfileId(1),
        )
      assertEqual(
        profile!.snapshot.skills['new-skill'],
        true,
        'skill reload should auto-save newly discovered skills',
      )
      assertEqual(
        harness.activeProfileSnapshotChangedCount,
        1,
        'skill reload should publish the refreshed snapshot',
      )
    },
  )

  await runCase(
    'apply restores saved subsets without creating missing tools or skills',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      const slotId = getAgentSettingProfileId(1)
      await harness.service.saveCurrent()
      const sourceSlotId = getAgentSettingProfileId(2)

      harness.settingsService.setSettings({
        commandPolicyMode: 'safe',
        tools: {
          builtIn: {
            exec_command: false,
            read_file: true,
            write_stdin: true,
            newly_added_builtin: true,
          },
          skills: {
            docs: false,
            deploy: true,
            newly_added_skill: false,
          },
        },
        models: {
          ...harness.settingsService.getSettings().models,
          activeProfileId: 'profile-deep',
        },
        recursionLimit: 900,
        experimental: {
          runtimeThinkingCorrectionEnabled: false,
          taskFinishGuardEnabled: false,
          firstTurnThinkingModelEnabled: true,
          execCommandActionModelEnabled: false,
          writeStdinActionModelEnabled: true,
        },
      })
      harness.commandPolicyService.lists = {
        allowlist: ['pwd'],
        denylist: [],
        asklist: [],
      }
      await harness.mcpToolService.setServerEnabled('search', false)
      await harness.mcpToolService.setServerEnabled('files', true)
      harness.skillService.skills = [{ name: 'docs', description: 'Docs' }]
      await harness.memoryService.writeMemory('changed default', null)
      await harness.memoryService.writeMemory('slot memory', slotId)

      const applyResult = await harness.service.apply(slotId)
      if (isExperimentalToolConfirmationRequired(applyResult)) {
        throw new Error('ordinary profile apply unexpectedly required confirmation')
      }
      const result = applyResult
      const settings = harness.settingsService.getSettings()
      assertEqual(
        settings.commandPolicyMode,
        'standard',
        'saved policy mode should be restored',
      )
      assertDeepEqual(
        await harness.commandPolicyService.getLists(),
        {
          allowlist: ['ls *'],
          denylist: ['rm -rf /'],
          asklist: ['git push'],
        },
        'command policy lists should be restored',
      )
      assertEqual(
        settings.tools.builtIn.exec_command,
        true,
        'saved built-in state should apply',
      )
      assertEqual(
        settings.tools.builtIn.newly_added_builtin,
        true,
        'new built-in absent from snapshot should remain unchanged',
      )
      assertEqual(
        settings.tools.skills?.docs,
        true,
        'existing skill should apply',
      )
      assertEqual(
        settings.tools.skills?.deploy,
        true,
        'missing current skill should remain unchanged',
      )
      assertEqual(
        settings.models.activeProfileId,
        'profile-fast',
        'saved active model profile should apply',
      )
      assertEqual(settings.recursionLimit, 300, 'recursion limit should apply')
      assertEqual(
        settings.experimental?.writeStdinActionModelEnabled,
        false,
        'workflow experimental flag should apply',
      )
      assertEqual(
        result.memory.content,
        'slot memory',
        'active memory should come from the applied slot',
      )
      assertEqual(
        harness.mcpToolService
          .getSummaries()
          .find((tool) => tool.name === 'search')?.enabled,
        true,
        'saved MCP state should apply',
      )

      const sourceApplyResult = await harness.service.apply(sourceSlotId)
      if (isExperimentalToolConfirmationRequired(sourceApplyResult)) {
        throw new Error(
          'source profile apply unexpectedly required confirmation',
        )
      }
      const restoredSourceSettings = harness.settingsService.getSettings()
      assertEqual(
        restoredSourceSettings.commandPolicyMode,
        'safe',
        'switching back should restore the source slot state saved before leaving',
      )
      assertEqual(
        restoredSourceSettings.models.activeProfileId,
        'profile-deep',
        'source slot should preserve the last active model profile',
      )
      assertEqual(
        harness.mcpToolService
          .getSummaries()
          .find((tool) => tool.name === 'search')?.enabled,
        false,
        'source slot should preserve the last MCP state',
      )
    },
  )

  await runCase(
    'apply preserves current model when saved model profile is missing',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      await harness.service.saveCurrent()
      harness.settingsService.setSettings({
        models: {
          items: harness.settingsService.getSettings().models.items,
          profiles: [
            {
              id: 'profile-deep',
              name: 'Deep',
              globalModelId: 'model-deep',
            },
          ],
          activeProfileId: 'profile-deep',
        },
      })
      const applyResult = await harness.service.apply(
        getAgentSettingProfileId(1),
      )
      if (isExperimentalToolConfirmationRequired(applyResult)) {
        throw new Error('ordinary profile apply unexpectedly required confirmation')
      }
      const result = applyResult
      assertEqual(
        harness.settingsService.getSettings().models.activeProfileId,
        'profile-deep',
        'current model profile should be preserved',
      )
      assertCondition(
        result.warnings.length === 1,
        'missing model should produce warning',
      )
    },
  )

  await runCase(
    'active profile snapshots update after every supported settings mutation',
    async () => {
      const harness = createHarness()
      await harness.service.saveCurrent()
      const slotId = getAgentSettingProfileId(1)

      await harness.service.applySettingsPatch({
        commandPolicyMode: 'smart',
        recursionLimit: 720,
        models: {
          ...harness.settingsService.getSettings().models,
          activeProfileId: 'profile-deep',
        },
      })
      await harness.service.setBuiltInToolEnabled('exec_command', false)
      await harness.service.setMcpToolEnabled('search', false)
      await harness.service.setSkillEnabled('docs', false)
      await harness.service.addCommandPolicyRule('allowlist', 'pwd')
      await harness.service.deleteCommandPolicyRule('denylist', 'rm -rf /')

      const profile = harness.settingsService
        .getSettings()
        .agentSettings!.profiles.find((entry) => entry.id === slotId)
      assertCondition(Boolean(profile), 'active profile should remain saved')
      assertEqual(
        profile!.snapshot.security.commandPolicyMode,
        'smart',
        'policy mode should auto-save into the active profile',
      )
      assertDeepEqual(
        profile!.snapshot.security.commandPolicyLists,
        {
          allowlist: ['ls *', 'pwd'],
          denylist: [],
          asklist: ['git push'],
        },
        'command policy list edits should auto-save into the active profile',
      )
      assertEqual(
        profile!.snapshot.tools.builtIn.exec_command,
        false,
        'built-in tool changes should auto-save into the active profile',
      )
      assertEqual(
        profile!.snapshot.tools.mcp.search,
        false,
        'MCP changes should auto-save into the active profile',
      )
      assertEqual(
        profile!.snapshot.skills.docs,
        false,
        'skill changes should auto-save into the active profile',
      )
      assertEqual(
        profile!.snapshot.workflow.recursionLimit,
        720,
        'workflow changes should auto-save into the active profile',
      )
      assertEqual(
        profile!.snapshot.model.activeProfileId,
        'profile-deep',
        'model selection should auto-save into the active profile',
      )
      assertEqual(
        harness.activeProfileSnapshotChangedCount,
        6,
        'each supported mutation should publish the refreshed profile snapshot',
      )
    },
  )

  await runCase(
    'auto-saved active profile snapshot survives settings service restart',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'gyshell-agent-settings-'))
      try {
        const settingsService = new NodeSettingsService(dataDir)
        settingsService.setSettings(new MockSettingsService().getSettings())
        const commandPolicyService = new MockCommandPolicyService()
        const mcpToolService = new MockMcpToolService()
        const skillService = new MockSkillService()
        const memoryService = new MockMemoryService()
        const service = new AgentSettingProfileService({
          settingsService,
          commandPolicyService,
          mcpToolService,
          skillService,
          memoryService,
        })

        await service.saveCurrent()
        await service.applySettingsPatch({ recursionLimit: 880 })
        await service.setMcpToolEnabled('search', false)

        const reloadedSettings = new NodeSettingsService(dataDir).getSettings()
        const reloadedProfile = reloadedSettings.agentSettings!.profiles.find(
          (profile) => profile.id === getAgentSettingProfileId(1),
        )
        assertCondition(
          Boolean(reloadedProfile),
          'saved profile should reload from disk',
        )
        assertEqual(
          reloadedProfile!.snapshot.workflow.recursionLimit,
          880,
          'reloaded profile should keep the last workflow edit',
        )
        assertEqual(
          reloadedProfile!.snapshot.tools.mcp.search,
          false,
          'reloaded profile should keep the last MCP edit',
        )
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )

  await runCase(
    'concurrent saves are serialized into unique slots',
    async () => {
      const harness = createHarness()
      await Promise.all([
        harness.service.saveCurrent(),
        harness.service.saveCurrent(),
      ])
      const slots = harness.settingsService
        .getSettings()
        .agentSettings!.profiles.map((profile) => profile.slotNumber)
        .join(',')
      assertEqual(slots, '1,2', 'concurrent saves should not collide')
      assertEqual(harness.settingsChangedCount, 2, 'both saves should persist')
    },
  )

  await runCase(
    'experimental tool enable requires acknowledgement at the serialized mutation boundary',
    async () => {
      const harness = createHarness()
      const firstAttempt = await harness.service.setBuiltInToolEnabled(
        'create_terminal_tab',
        true,
      )
      assertCondition(
        isExperimentalToolConfirmationRequired(firstAttempt),
        'unacknowledged experimental enable should return a challenge',
      )
      if (!isExperimentalToolConfirmationRequired(firstAttempt)) return
      assertDeepEqual(
        firstAttempt.experimentalToolNames,
        ['create_terminal_tab'],
        'challenge should identify the exact experimental tool',
      )
      assertEqual(
        harness.settingsService.getSettings().tools.builtIn.create_terminal_tab,
        false,
        'challenge must not mutate settings',
      )

      const enabled = await harness.service.setBuiltInToolEnabled(
        'create_terminal_tab',
        true,
        ['create_terminal_tab'],
      )
      assertCondition(
        !isExperimentalToolConfirmationRequired(enabled),
        'acknowledged experimental enable should apply',
      )
      assertEqual(
        harness.settingsService.getSettings().tools.builtIn.create_terminal_tab,
        true,
        'acknowledged enable should persist',
      )

      const [disabled, racedEnable] = await Promise.all([
        harness.service.setBuiltInToolEnabled('create_terminal_tab', false),
        harness.service.setBuiltInToolEnabled('create_terminal_tab', true),
      ])
      assertCondition(
        !isExperimentalToolConfirmationRequired(disabled),
        'disable should never require confirmation',
      )
      assertCondition(
        isExperimentalToolConfirmationRequired(racedEnable),
        'queued re-enable must re-check the latest committed state',
      )
      assertEqual(
        harness.settingsService.getSettings().tools.builtIn.create_terminal_tab,
        false,
        'unacknowledged raced re-enable must remain disabled',
      )

      harness.settingsService.setSettings({
        tools: {
          ...harness.settingsService.getSettings().tools,
          builtIn: {
            ...harness.settingsService.getSettings().tools.builtIn,
            create_terminal_tab: 'yes' as any,
          },
        },
      })
      const malformedStateAttempt =
        await harness.service.setBuiltInToolEnabled(
          'create_terminal_tab',
          true,
        )
      assertCondition(
        isExperimentalToolConfirmationRequired(malformedStateAttempt),
        'truthy non-boolean settings must be treated as the fail-closed default',
      )
    },
  )

  await runCase(
    'generic settings writes share the profile mutation boundary',
    async () => {
      const harness = createHarness()
      await harness.service.setBuiltInToolEnabled(
        'create_terminal_tab',
        true,
        ['create_terminal_tab'],
      )
      await harness.service.saveCurrent()
      const slotId = getAgentSettingProfileId(1)

      let signalMcpStarted: () => void = () => undefined
      const mcpStarted = new Promise<void>((resolve) => {
        signalMcpStarted = resolve
      })
      let releaseMcp: () => void = () => undefined
      const mcpRelease = new Promise<void>((resolve) => {
        releaseMcp = resolve
      })
      const applyBatch =
        harness.mcpToolService.setServerEnabledBatch.bind(
          harness.mcpToolService,
        )
      harness.mcpToolService.setServerEnabledBatch = async (enabledByName) => {
        signalMcpStarted()
        await mcpRelease
        return await applyBatch(enabledByName)
      }

      const applyPromise = harness.service.apply(slotId)
      await mcpStarted
      const current = harness.settingsService.getSettings()
      let patchSettled = false
      const patchPromise = harness.service
        .applySettingsPatch({
          tools: {
            builtIn: {
              ...current.tools.builtIn,
              create_terminal_tab: false,
            },
            skills: current.tools.skills,
          },
        })
        .then(() => {
          patchSettled = true
        })
      await Promise.resolve()
      assertEqual(
        patchSettled,
        false,
        'generic settings write should wait for the active profile mutation',
      )

      releaseMcp()
      const applyResult = await applyPromise
      assertCondition(
        !isExperimentalToolConfirmationRequired(applyResult),
        'an already-enabled profile should apply without a new challenge',
      )
      await patchPromise
      assertEqual(
        harness.settingsService.getSettings().tools.builtIn
          .create_terminal_tab,
        false,
        'the queued disable must commit after profile apply without being re-enabled',
      )
    },
  )

  await runCase(
    'profile apply challenges before any experimental enable side effects',
    async () => {
      const harness = createHarness()
      harness.settingsService.setSettings({
        tools: {
          ...harness.settingsService.getSettings().tools,
          builtIn: {
            ...harness.settingsService.getSettings().tools.builtIn,
            close_terminal_tab: true,
          },
        },
      })
      await harness.service.saveCurrent()
      const slotId = getAgentSettingProfileId(1)
      await harness.service.saveCurrent()
      await harness.service.setBuiltInToolEnabled('close_terminal_tab', false)

      const challenge = await harness.service.apply(slotId)
      assertCondition(
        isExperimentalToolConfirmationRequired(challenge),
        'profile apply should return an experimental confirmation challenge',
      )
      if (!isExperimentalToolConfirmationRequired(challenge)) return
      assertDeepEqual(
        challenge.experimentalToolNames,
        ['close_terminal_tab'],
        'profile challenge should list every newly enabled experimental tool',
      )
      assertEqual(
        harness.settingsService.getSettings().tools.builtIn.close_terminal_tab,
        false,
        'unconfirmed profile apply must not change built-in settings',
      )

      const applied = await harness.service.apply(
        slotId,
        challenge.experimentalToolNames,
      )
      assertCondition(
        !isExperimentalToolConfirmationRequired(applied),
        'confirmed profile apply should complete',
      )
      assertEqual(
        harness.settingsService.getSettings().tools.builtIn.close_terminal_tab,
        true,
        'confirmed profile apply should enable the saved experimental tool',
      )
    },
  )

  await runCase(
    'generic settings patches cannot bypass experimental confirmation',
    () => {
      const harness = createHarness()
      let errorMessage = ''
      try {
        assertSettingsPatchDoesNotEnableExperimentalTools(
          harness.settingsService.getSettings().tools.builtIn,
          {
            tools: {
              builtIn: { create_terminal_tab: true },
            },
          },
        )
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
      }
      assertCondition(
        /tools:setBuiltInEnabled/.test(errorMessage),
        'generic settings patch should be directed to the consent-aware endpoint',
      )

      assertCondition(
        (() => {
          try {
            assertSettingsPatchDoesNotEnableExperimentalTools(
              harness.settingsService.getSettings().tools.builtIn,
              {
                tools: {
                  builtIn: { create_terminal_tab: 'yes' },
                },
              },
            )
            return false
          } catch (error) {
            return /boolean value/.test(
              error instanceof Error ? error.message : String(error),
            )
          }
        })(),
        'generic settings patches should reject malformed known-tool values',
      )

      assertSettingsPatchDoesNotEnableExperimentalTools(
        harness.settingsService.getSettings().tools.builtIn,
        {
          tools: {
            builtIn: { create_terminal_tab: false },
          },
        },
      )
    },
  )
}

run()
  .then(() => {
    console.log('All agent setting profile service extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
