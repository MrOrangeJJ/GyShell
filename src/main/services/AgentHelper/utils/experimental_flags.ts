import type { AppSettings, ExperimentalFlags } from '../../../types'

export type RunExperimentalFlags = ExperimentalFlags

function isRunExperimentalFlags(value: any): value is RunExperimentalFlags {
  return (
    value &&
    typeof value.runtimeThinkingCorrectionEnabled === 'boolean' &&
    typeof value.taskFinishGuardEnabled === 'boolean' &&
    typeof value.firstTurnThinkingModelEnabled === 'boolean'
  )
}

export function getRunExperimentalFlagsFromSettings(settings: AppSettings | null): RunExperimentalFlags {
  return {
    runtimeThinkingCorrectionEnabled: settings?.experimental?.runtimeThinkingCorrectionEnabled !== false,
    taskFinishGuardEnabled: settings?.experimental?.taskFinishGuardEnabled !== false,
    firstTurnThinkingModelEnabled: settings?.experimental?.firstTurnThinkingModelEnabled === true
  }
}

export function resolveRunExperimentalFlags(
  context: any,
  settings: AppSettings | null
): RunExperimentalFlags {
  if (isRunExperimentalFlags(context?.lockedExperimentalFlags)) {
    return context.lockedExperimentalFlags
  }
  return getRunExperimentalFlagsFromSettings(settings)
}
