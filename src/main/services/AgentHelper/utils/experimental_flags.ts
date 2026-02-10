import type { AppSettings } from '../../../types'

export interface RunExperimentalFlags {
  runtimeThinkingCorrectionEnabled: boolean
  taskFinishGuardEnabled: boolean
}

export function getRunExperimentalFlagsFromSettings(settings: AppSettings | null): RunExperimentalFlags {
  return {
    runtimeThinkingCorrectionEnabled: settings?.experimental?.runtimeThinkingCorrectionEnabled !== false,
    taskFinishGuardEnabled: settings?.experimental?.taskFinishGuardEnabled !== false
  }
}

export function resolveRunExperimentalFlags(
  context: any,
  settings: AppSettings | null
): RunExperimentalFlags {
  if (
    typeof context?.lockedRuntimeThinkingCorrectionEnabled === 'boolean' &&
    typeof context?.lockedTaskFinishGuardEnabled === 'boolean'
  ) {
    return {
      runtimeThinkingCorrectionEnabled: context.lockedRuntimeThinkingCorrectionEnabled,
      taskFinishGuardEnabled: context.lockedTaskFinishGuardEnabled
    }
  }
  return getRunExperimentalFlagsFromSettings(settings)
}
