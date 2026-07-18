import { migrateBackendSettings } from './migrations'
import {
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
  recursionLimit: 200,
  experimental: {
    runtimeThinkingCorrectionEnabled: true,
    taskFinishGuardEnabled: true,
    firstTurnThinkingModelEnabled: false,
    execCommandActionModelEnabled: true,
    writeStdinActionModelEnabled: true,
  },
}

runCase('migrates v3 settings to schema v5 with empty agent settings', () => {
  const migrated = migrateBackendSettings({
    schemaVersion: 3,
    commandPolicyMode: 'safe',
    memory: { enabled: false },
  })

  assertEqual(migrated.schemaVersion, 5, 'schema version should be v5')
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

  assertEqual(migrated.schemaVersion, 5, 'model parameter migration should reach v5')
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

console.log('All agent settings normalization extreme tests passed.')
