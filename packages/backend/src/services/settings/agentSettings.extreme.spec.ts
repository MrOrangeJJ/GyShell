import {
  BACKEND_SETTINGS_SCHEMA_VERSION,
  DEFAULT_BACKEND_SETTINGS,
  migrateBackendSettings,
} from './migrations'
import {
  AGENT_RECURSION_LIMIT,
  getAgentSettingProfileId,
  normalizeAgentSettingState,
} from './agentSettings'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
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

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const defaults = {
  experimental: {
    runtimeThinkingCorrectionEnabled: true,
    loopGuardEnabled: true,
    taskFinishGuardEnabled: true,
    firstTurnThinkingModelEnabled: false,
    execCommandActionModelEnabled: true,
    writeStdinActionModelEnabled: true,
  },
}

runCase('migrates v3 settings to the current schema with empty agent settings', () => {
  const migrated = migrateBackendSettings({
    schemaVersion: 3,
    commandPolicyMode: 'safe',
    memory: { enabled: false },
  })

  assertEqual(migrated.schemaVersion, 6, 'schema version should be v6')
  assertDeepEqual(
    migrated.agentSettings,
    { profiles: [], activeProfileId: null },
    'agent settings should be initialized',
  )
  assertEqual(
    migrated.memory?.enabled,
    false,
    'memory enabled flag should be preserved',
  )
})

runCase('normalizes model request parameters during schema migration', () => {
  const migrated = migrateBackendSettings({
    schemaVersion: 4,
    models: {
      items: [
        {
          id: 'model-1',
          name: 'Model',
          model: 'provider-model',
          maxTokens: 128000,
          requestParameters: {
            temperature: 0.65,
            max_completion_tokens: 2048,
            tools: [],
          },
          supportsStructuredOutput: false,
          supportsObjectToolChoice: false,
        },
      ],
      profiles: [],
      activeProfileId: '',
    },
  } as any)

  assertEqual(migrated.schemaVersion, 6, 'model parameter migration should reach v6')
  assertDeepEqual(
    migrated.models.items[0].requestParameters,
    { temperature: 0.65, max_completion_tokens: 2048 },
    'migration should preserve safe parameters and remove runtime-owned fields',
  )
})

runCase('normalizes malformed profiles and stale active ids', () => {
  const validSnapshot = {
    version: 1,
    security: {
      commandPolicyMode: 'smart',
      commandPolicyLists: {
        allowlist: ['ls *', 'ls *', ''],
        denylist: ['rm -rf /'],
        asklist: [],
      },
    },
    tools: {
      builtIn: { exec_command: true, bad: 'yes' },
      mcp: { search: false },
    },
    skills: { docs: true },
    memory: { enabled: false },
    workflow: {
      recursionLimit: 500,
      experimental: { firstTurnThinkingModelEnabled: true },
    },
    model: {
      activeProfileId: 'model-profile-1',
      activeProfileName: 'Fast',
    },
  }

  const state = normalizeAgentSettingState(
    {
      profiles: [
        null,
        { id: 'custom', slotNumber: 1, snapshot: validSnapshot },
        {
          id: getAgentSettingProfileId(1),
          slotNumber: 1,
          snapshot: validSnapshot,
        },
        {
          id: getAgentSettingProfileId(1),
          slotNumber: 1,
          snapshot: validSnapshot,
        },
        {
          id: getAgentSettingProfileId(6 as any),
          slotNumber: 6,
          snapshot: validSnapshot,
        },
      ],
      activeProfileId: getAgentSettingProfileId(3 as any),
    },
    defaults,
  )

  assertEqual(state.profiles.length, 1, 'one valid profile should remain')
  assertEqual(
    state.profiles[0].id,
    getAgentSettingProfileId(1),
    'profile id should be canonical',
  )
  assertEqual(state.activeProfileId, null, 'stale active id should be cleared')
  assertDeepEqual(
    state.profiles[0].snapshot.security.commandPolicyLists.allowlist,
    ['ls *'],
    'command policy lists should be deduped and trimmed',
  )
  assertEqual(
    state.profiles[0].snapshot.workflow.experimental
      .firstTurnThinkingModelEnabled,
    true,
    'explicit experimental flag should be preserved',
  )
  assertEqual(
    state.profiles[0].snapshot.workflow.experimental
      .runtimeThinkingCorrectionEnabled,
    true,
    'missing experimental flag should use default',
  )
})

const profileWithRecursionLimit = (recursionLimit: number) => ({
  id: getAgentSettingProfileId(1),
  slotNumber: 1,
  name: 'Slot 1',
  createdAt: 1,
  updatedAt: 1,
  snapshot: {
    version: 1,
    security: {
      commandPolicyMode: 'safe',
      commandPolicyLists: { allowlist: [], denylist: [], asklist: [] },
    },
    tools: { builtIn: {}, mcp: {} },
    skills: {},
    memory: { enabled: true },
    workflow: { recursionLimit, experimental: {} },
    model: { activeProfileId: '' },
  },
})

runCase('v6 upgrade forces INF over any stored recursion limit', () => {
  for (const stored of [200, 640, 1, 2147483647, -5, 'abc', null]) {
    const migrated = migrateBackendSettings({
      schemaVersion: 5,
      commandPolicyMode: 'standard',
      recursionLimit: stored,
      agentSettings: {
        profiles: [profileWithRecursionLimit(500)],
        activeProfileId: getAgentSettingProfileId(1),
      },
    } as any)
    assertEqual(
      migrated.recursionLimit,
      AGENT_RECURSION_LIMIT,
      `stored recursion limit ${String(stored)} should become INF`,
    )
    assertEqual(
      migrated.agentSettings!.profiles[0].snapshot.workflow.recursionLimit,
      AGENT_RECURSION_LIMIT,
      'saved profile snapshot recursion limit should become INF',
    )
    assertEqual(
      migrated.agentSettings!.activeProfileId,
      getAgentSettingProfileId(1),
      'upgrade must keep the saved profile itself',
    )
  }
})

runCase('recursion limit stays INF after upgrade, whatever is patched in', () => {
  const migrated = migrateBackendSettings({
    schemaVersion: BACKEND_SETTINGS_SCHEMA_VERSION,
    recursionLimit: 300,
    agentSettings: {
      profiles: [profileWithRecursionLimit(300)],
      activeProfileId: null,
    },
  } as any)
  assertEqual(
    migrated.recursionLimit,
    AGENT_RECURSION_LIMIT,
    'a current-schema write must still pin the limit',
  )
  assertEqual(
    migrated.agentSettings!.profiles[0].snapshot.workflow.recursionLimit,
    AGENT_RECURSION_LIMIT,
    'a current-schema profile snapshot must still pin the limit',
  )
})

runCase('fresh installs default Command Policy Mode to smart', () => {
  assertEqual(
    DEFAULT_BACKEND_SETTINGS.commandPolicyMode,
    'smart',
    'store defaults should use smart mode',
  )
  assertEqual(
    DEFAULT_BACKEND_SETTINGS.recursionLimit,
    AGENT_RECURSION_LIMIT,
    'store defaults should use the INF recursion limit',
  )
  // Electron: no backend store and no legacy file.
  const electronFresh = migrateBackendSettings(undefined, undefined)
  assertEqual(electronFresh.commandPolicyMode, 'smart', 'electron fresh install')
  assertEqual(
    electronFresh.recursionLimit,
    AGENT_RECURSION_LIMIT,
    'electron fresh install recursion limit',
  )
  // Headless node backend: normalize(undefined) migrates an empty object, and
  // env bootstrap may add model fields without a schema version.
  assertEqual(
    migrateBackendSettings({}).commandPolicyMode,
    'smart',
    'node fresh install',
  )
  assertEqual(
    migrateBackendSettings({
      model: 'm',
      models: { items: [], profiles: [], activeProfileId: '' },
    }).commandPolicyMode,
    'smart',
    'node fresh install with env bootstrap',
  )
  // Electron constructs the store with defaults after migration; re-reading
  // the persisted result must not flip the mode.
  assertEqual(
    migrateBackendSettings(electronFresh).commandPolicyMode,
    'smart',
    'second start after a fresh install',
  )
})

runCase('upgrades keep the Command Policy Mode the user ran with', () => {
  for (const mode of ['safe', 'standard', 'smart'] as const) {
    for (const fromVersion of [3, 4, 5]) {
      assertEqual(
        migrateBackendSettings({ schemaVersion: fromVersion, commandPolicyMode: mode })
          .commandPolicyMode,
        mode,
        `stored ${mode} at v${fromVersion} should be kept`,
      )
    }
    assertEqual(
      migrateBackendSettings(undefined, { commandPolicyMode: mode }).commandPolicyMode,
      mode,
      `legacy-only stored ${mode} should be kept`,
    )
  }
  assertEqual(
    migrateBackendSettings({ schemaVersion: 5 }).commandPolicyMode,
    'standard',
    'an upgrading store without a mode keeps the pre-v6 default',
  )
  assertEqual(
    migrateBackendSettings({ schemaVersion: 5, commandPolicyMode: 'yolo' } as any)
      .commandPolicyMode,
    'standard',
    'an upgrading store with an invalid mode keeps the pre-v6 default',
  )
  assertEqual(
    migrateBackendSettings(undefined, { schemaVersion: 2, memory: { enabled: true } })
      .commandPolicyMode,
    'standard',
    'a legacy store without a mode keeps the pre-v6 default',
  )
  assertEqual(
    migrateBackendSettings(undefined, { memory: { enabled: true } }).commandPolicyMode,
    'standard',
    'an unversioned legacy store is still an upgrade',
  )
  assertEqual(
    migrateBackendSettings(
      { schemaVersion: 5, commandPolicyMode: 'safe' },
      { commandPolicyMode: 'smart' },
    ).commandPolicyMode,
    'safe',
    'the current store wins over the legacy store',
  )
  const upgraded = migrateBackendSettings({ schemaVersion: 5, commandPolicyMode: 'standard' })
  assertEqual(
    migrateBackendSettings(upgraded).commandPolicyMode,
    'standard',
    'later starts must not flip an upgraded user to smart',
  )
  assertEqual(
    migrateBackendSettings({ ...upgraded, commandPolicyMode: 'smart' }).commandPolicyMode,
    'smart',
    'users can still choose a mode after upgrading',
  )
})

console.log('All agent settings normalization extreme tests passed.')
