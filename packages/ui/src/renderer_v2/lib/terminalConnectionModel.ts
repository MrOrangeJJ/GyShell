import {
  getTerminalConnectionCapabilities,
  getTerminalConnectionTypeDefinition,
  type TerminalConnectionCapabilities,
  type TerminalConnectionIconKind,
} from '@gyshell/shared'
import type { TerminalConfig } from './ipcTypes'

export interface TerminalConnectionRef {
  type: string
  entryId?: string
}

export const resolveTerminalConnectionCapabilities = (
  config: Pick<TerminalConfig, 'type'> | { type: string },
): TerminalConnectionCapabilities =>
  getTerminalConnectionCapabilities(config.type)

export const supportsFilesystemForTerminalConfig = (
  config: Pick<TerminalConfig, 'type'> | { type: string },
): boolean => resolveTerminalConnectionCapabilities(config).supportsFilesystem

export const getTerminalConnectionIconKind = (
  type: string,
): TerminalConnectionIconKind =>
  getTerminalConnectionTypeDefinition(type).iconKind

export const canReconnectTerminalRuntime = (
  config: Pick<TerminalConfig, 'type'> | { type: string },
  runtimeState: unknown,
): boolean => config.type === 'ssh' && runtimeState === 'exited'

export const resolveTerminalRuntimeIndicatorState = (
  type: string,
  runtimeState: 'initializing' | 'ready' | 'exited',
): 'initializing' | 'ready' | 'exited' | 'inactive' => {
  const iconKind = getTerminalConnectionIconKind(type)
  if (iconKind === 'remote') {
    return runtimeState === 'ready' ? 'ready' : 'inactive'
  }
  return runtimeState
}
