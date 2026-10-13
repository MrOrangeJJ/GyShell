import type { BackendSettings, ExperimentalFlags } from '../../../types'

export type RunExperimentalFlags = ExperimentalFlags

function isRunExperimentalFlags(value: any): value is RunExperimentalFlags {
  return (
    value &&
    typeof value.runtimeThinkingCorrectionEnabled === 'boolean' &&
    typeof value.loopGuardEnabled === 'boolean' &&
    typeof value.taskFinishGuardEnabled === 'boolean' &&
    typeof value.firstTurnThinkingModelEnabled === 'boolean' &&
    typeof value.execCommandActionModelEnabled === 'boolean' &&
    typeof value.writeStdinActionModelEnabled === 'boolean'
  )
}

export function getRunExperimentalFlagsFromSettings(settings: BackendSettings | null): RunExperimentalFlags {
  return {
    runtimeThinkingCorrectionEnabled: settings?.experimental?.runtimeThinkingCorrectionEnabled !== false,
    loopGuardEnabled: settings?.experimental?.loopGuardEnabled !== false,
    taskFinishGuardEnabled: settings?.experimental?.taskFinishGuardEnabled !== false,
    firstTurnThinkingModelEnabled: settings?.experimental?.firstTurnThinkingModelEnabled === true,
    execCommandActionModelEnabled: settings?.experimental?.execCommandActionModelEnabled !== false,
    writeStdinActionModelEnabled: settings?.experimental?.writeStdinActionModelEnabled !== false
  }
}

export function resolveRunExperimentalFlags(
  context: any,
  settings: BackendSettings | null
): RunExperimentalFlags {
  if (isRunExperimentalFlags(context?.lockedExperimentalFlags)) {
    return context.lockedExperimentalFlags
  }
  return getRunExperimentalFlagsFromSettings(settings)
}
