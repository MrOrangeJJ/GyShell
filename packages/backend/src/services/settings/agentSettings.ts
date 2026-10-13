import type {
  AgentSettingCommandPolicyLists,
  AgentSettingProfile,
  AgentSettingSlotNumber,
  AgentSettingSnapshot,
  AgentSettingState,
  CommandPolicyMode,
  ExperimentalFlags,
} from '../../types'
import { isObject } from './objectMerge'

export const MAX_AGENT_SETTING_PROFILES = 5
export const AGENT_SETTING_SLOT_NUMBERS = [1, 2, 3, 4, 5] as const
export const AGENT_SETTING_SNAPSHOT_VERSION = 1

export const getAgentSettingProfileId = (
  slotNumber: AgentSettingSlotNumber,
): string => `agent-setting-slot-${slotNumber}`

export function normalizeAgentSettingProfileId(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  return AGENT_SETTING_SLOT_NUMBERS.some(
    (slotNumber) => getAgentSettingProfileId(slotNumber) === raw,
  )
    ? raw
    : null
}

export function normalizeAgentSettingSlotNumber(
  value: unknown,
): AgentSettingSlotNumber | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return AGENT_SETTING_SLOT_NUMBERS.includes(value as AgentSettingSlotNumber)
    ? (value as AgentSettingSlotNumber)
    : null
}

export function getAgentSettingSlotNumberFromId(
  profileId: string,
): AgentSettingSlotNumber | null {
  return (
    AGENT_SETTING_SLOT_NUMBERS.find(
      (slotNumber) => getAgentSettingProfileId(slotNumber) === profileId,
    ) ?? null
  )
}

export function normalizeBooleanMap(value: unknown): Record<string, boolean> {
  if (!isObject(value)) return {}
  const next: Record<string, boolean> = {}
  Object.entries(value).forEach(([key, enabled]) => {
    const normalizedKey = String(key || '').trim()
    if (!normalizedKey || typeof enabled !== 'boolean') return
    next[normalizedKey] = enabled
  })
  return next
}

export function normalizeCommandPolicyMode(value: unknown): CommandPolicyMode {
  return value === 'safe' || value === 'smart' || value === 'standard'
    ? value
    : 'standard'
}

export function normalizeAgentSettingCommandPolicyLists(
  value: unknown,
): AgentSettingCommandPolicyLists {
  const source = isObject(value) ? value : {}
  const normalizeList = (list: unknown): string[] =>
    Array.isArray(list)
      ? Array.from(
          new Set(
            list
              .map((item) => String(item || '').trim())
              .filter((item) => item.length > 0),
          ),
        ).sort((left, right) => left.localeCompare(right))
      : []
  return {
    allowlist: normalizeList(source.allowlist),
    denylist: normalizeList(source.denylist),
    asklist: normalizeList(source.asklist),
  }
}

export function normalizeExperimentalFlags(
  value: unknown,
  defaults: ExperimentalFlags,
): ExperimentalFlags {
  const source = isObject(value) ? value : {}
  return {
    runtimeThinkingCorrectionEnabled:
      typeof source.runtimeThinkingCorrectionEnabled === 'boolean'
        ? source.runtimeThinkingCorrectionEnabled
        : defaults.runtimeThinkingCorrectionEnabled,
    loopGuardEnabled:
      typeof source.loopGuardEnabled === 'boolean'
        ? source.loopGuardEnabled
        : defaults.loopGuardEnabled,
    taskFinishGuardEnabled:
      typeof source.taskFinishGuardEnabled === 'boolean'
        ? source.taskFinishGuardEnabled
        : defaults.taskFinishGuardEnabled,
    firstTurnThinkingModelEnabled:
      typeof source.firstTurnThinkingModelEnabled === 'boolean'
        ? source.firstTurnThinkingModelEnabled
        : defaults.firstTurnThinkingModelEnabled,
    execCommandActionModelEnabled:
      typeof source.execCommandActionModelEnabled === 'boolean'
        ? source.execCommandActionModelEnabled
        : defaults.execCommandActionModelEnabled,
    writeStdinActionModelEnabled:
      typeof source.writeStdinActionModelEnabled === 'boolean'
        ? source.writeStdinActionModelEnabled
        : defaults.writeStdinActionModelEnabled,
  }
}

export function normalizeAgentSettingSnapshot(
  value: unknown,
  defaults: { recursionLimit: number; experimental: ExperimentalFlags },
): AgentSettingSnapshot | null {
  if (!isObject(value)) return null
  const security = isObject(value.security) ? value.security : {}
  const tools = isObject(value.tools) ? value.tools : {}
  const memory = isObject(value.memory) ? value.memory : {}
  const workflow = isObject(value.workflow) ? value.workflow : {}
  const model = isObject(value.model) ? value.model : {}
  const rawRecursionLimit = Number(workflow.recursionLimit)

  return {
    version: AGENT_SETTING_SNAPSHOT_VERSION,
    security: {
      commandPolicyMode: normalizeCommandPolicyMode(security.commandPolicyMode),
      commandPolicyLists: normalizeAgentSettingCommandPolicyLists(
        security.commandPolicyLists,
      ),
    },
    tools: {
      builtIn: normalizeBooleanMap(tools.builtIn),
      mcp: normalizeBooleanMap(tools.mcp),
    },
    skills: normalizeBooleanMap(value.skills),
    memory: {
      enabled: memory.enabled !== false,
    },
    workflow: {
      recursionLimit:
        Number.isFinite(rawRecursionLimit) && rawRecursionLimit > 0
          ? Math.floor(rawRecursionLimit)
          : defaults.recursionLimit,
      experimental: normalizeExperimentalFlags(
        workflow.experimental,
        defaults.experimental,
      ),
    },
    model: {
      activeProfileId:
        typeof model.activeProfileId === 'string'
          ? model.activeProfileId.trim()
          : '',
      activeProfileName:
        typeof model.activeProfileName === 'string' &&
        model.activeProfileName.trim()
          ? model.activeProfileName.trim()
          : undefined,
    },
  }
}

export function sortAgentSettingProfiles(
  profiles: AgentSettingProfile[],
): AgentSettingProfile[] {
  return profiles
    .slice()
    .sort((left, right) => left.slotNumber - right.slotNumber)
}

export function normalizeAgentSettingState(
  value: unknown,
  defaults: { recursionLimit: number; experimental: ExperimentalFlags },
): AgentSettingState {
  const source = isObject(value) ? value : {}
  const seenSlots = new Set<AgentSettingSlotNumber>()
  const profiles: AgentSettingProfile[] = []
  const rawProfiles = Array.isArray(source.profiles) ? source.profiles : []

  rawProfiles.forEach((entry) => {
    if (!isObject(entry)) return
    const slotNumber = normalizeAgentSettingSlotNumber(entry.slotNumber)
    if (!slotNumber || seenSlots.has(slotNumber)) return
    const expectedId = getAgentSettingProfileId(slotNumber)
    if (normalizeAgentSettingProfileId(entry.id) !== expectedId) return
    const snapshot = normalizeAgentSettingSnapshot(entry.snapshot, defaults)
    if (!snapshot) return
    seenSlots.add(slotNumber)
    profiles.push({
      id: expectedId,
      slotNumber,
      createdAt:
        typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
          ? entry.createdAt
          : Date.now(),
      updatedAt:
        typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : Date.now(),
      snapshot,
    })
  })

  const sortedProfiles = sortAgentSettingProfiles(profiles).slice(
    0,
    MAX_AGENT_SETTING_PROFILES,
  )
  const activeProfileId = normalizeAgentSettingProfileId(source.activeProfileId)
  return {
    profiles: sortedProfiles,
    activeProfileId:
      activeProfileId &&
      sortedProfiles.some((profile) => profile.id === activeProfileId)
        ? activeProfileId
        : null,
  }
}

export function getFirstAvailableAgentSettingSlotNumber(
  profiles: AgentSettingProfile[],
): AgentSettingSlotNumber | null {
  const used = new Set(profiles.map((profile) => profile.slotNumber))
  return (
    AGENT_SETTING_SLOT_NUMBERS.find((slotNumber) => !used.has(slotNumber)) ??
    null
  )
}
