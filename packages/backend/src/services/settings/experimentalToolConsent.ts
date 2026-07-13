import { BUILTIN_TOOL_INFO } from '../AgentHelper/builtInToolMetadata'

export const EXPERIMENTAL_TOOL_CONFIRMATION_REQUIRED =
  'experimental_tool_confirmation_required' as const

export interface ExperimentalToolConfirmationRequired {
  kind: typeof EXPERIMENTAL_TOOL_CONFIRMATION_REQUIRED
  experimentalToolNames: string[]
}

export function getExperimentalToolsEnabledByTransition(
  current: Record<string, boolean> | null | undefined,
  next: Record<string, boolean> | null | undefined
): string[] {
  const currentState = current ?? {}
  const nextState = next ?? {}

  return BUILTIN_TOOL_INFO.filter((tool) => {
    if (tool.experimental !== true) return false
    const defaultEnabled = tool.defaultEnabled ?? true
    const wasEnabled =
      typeof currentState[tool.name] === 'boolean'
        ? currentState[tool.name]
        : defaultEnabled
    const willBeEnabled =
      typeof nextState[tool.name] === 'boolean'
        ? nextState[tool.name]
        : defaultEnabled
    return !wasEnabled && willBeEnabled
  }).map((tool) => tool.name)
}

export function assertSettingsPatchDoesNotEnableExperimentalTools(
  current: Record<string, boolean> | null | undefined,
  settingsPatch: unknown
): void {
  if (!settingsPatch || typeof settingsPatch !== 'object') return
  const tools = (settingsPatch as Record<string, unknown>).tools
  if (!tools || typeof tools !== 'object') return
  const builtIn = (tools as Record<string, unknown>).builtIn
  if (!builtIn || typeof builtIn !== 'object') return

  const next = { ...(current ?? {}) }
  Object.entries(builtIn as Record<string, unknown>).forEach(
    ([name, enabled]) => {
      const definition = BUILTIN_TOOL_INFO.find((tool) => tool.name === name)
      if (definition && typeof enabled !== 'boolean') {
        throw new Error(
          `Built-in tool "${name}" must be enabled or disabled with a boolean value.`
        )
      }
      if (typeof enabled === 'boolean') next[name] = enabled
    }
  )
  const experimentalToolNames = getExperimentalToolsEnabledByTransition(
    current,
    next
  )
  if (experimentalToolNames.length > 0) {
    throw new Error(
      `Experimental tools require an explicit risk confirmation before enablement: ${experimentalToolNames.join(
        ', '
      )}. Use tools:setBuiltInEnabled instead of settings:set.`
    )
  }
}

export function buildExperimentalToolConfirmationRequired(
  toolNames: readonly string[]
): ExperimentalToolConfirmationRequired {
  return {
    kind: EXPERIMENTAL_TOOL_CONFIRMATION_REQUIRED,
    experimentalToolNames: [...new Set(toolNames)].sort()
  }
}

export function getUnacknowledgedExperimentalTools(
  requiredToolNames: readonly string[],
  acknowledgedToolNames: readonly string[] | null | undefined
): string[] {
  const acknowledged = new Set(
    (acknowledgedToolNames ?? []).filter(
      (name): name is string => typeof name === 'string'
    )
  )
  return requiredToolNames.filter((name) => !acknowledged.has(name))
}

export function isExperimentalToolConfirmationRequired(
  value: unknown
): value is ExperimentalToolConfirmationRequired {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ExperimentalToolConfirmationRequired>
  return (
    candidate.kind === EXPERIMENTAL_TOOL_CONFIRMATION_REQUIRED &&
    Array.isArray(candidate.experimentalToolNames) &&
    candidate.experimentalToolNames.every((name) => typeof name === 'string')
  )
}
