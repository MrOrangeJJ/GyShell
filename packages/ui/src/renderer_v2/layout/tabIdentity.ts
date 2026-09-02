import {
  isValidTerminalRuntimeId,
  readOpaqueNonBlankWellFormedString,
} from '@gyshell/shared'
import type { LayoutPanelTabBinding, PanelKind } from './types'

export const isTabbedPanelKind = (
  kind: PanelKind,
): kind is Extract<
  PanelKind,
  'chat' | 'terminal' | 'filesystem' | 'monitor'
> =>
  kind === 'chat' ||
  kind === 'terminal' ||
  kind === 'filesystem' ||
  kind === 'monitor'

export const isTerminalBackedPanelKind = (
  kind: PanelKind,
): kind is Extract<PanelKind, 'terminal' | 'filesystem' | 'monitor'> =>
  kind === 'terminal' || kind === 'filesystem' || kind === 'monitor'

/**
 * Reads a tab identity without rewriting it. Terminal-backed tabs additionally
 * use the backend's runtime-ID shape contract; exact registry membership stays
 * at the backend or Electron ownership boundary.
 */
export const readWindowingTabId = (
  kind: PanelKind,
  value: unknown,
): string | undefined => {
  if (!isTabbedPanelKind(kind)) return undefined
  const tabId = readOpaqueNonBlankWellFormedString(value)
  if (!tabId) return undefined
  return isTerminalBackedPanelKind(kind) && !isValidTerminalRuntimeId(tabId)
    ? undefined
    : tabId
}

export const normalizeWindowingTabIds = (
  kind: PanelKind,
  values: readonly unknown[],
): string[] => {
  const seen = new Set<string>()
  const tabIds: string[] = []
  values.forEach((value) => {
    const tabId = readWindowingTabId(kind, value)
    if (!tabId || seen.has(tabId)) return
    seen.add(tabId)
    tabIds.push(tabId)
  })
  return tabIds
}

/**
 * Normalizes a panel tab binding using exact, kind-aware identity semantics.
 * Exact duplicates collapse while whitespace- or case-distinct IDs remain
 * distinct identities.
 */
export const normalizePanelTabBinding = (
  kind: PanelKind,
  value: unknown,
): LayoutPanelTabBinding | undefined => {
  if (
    !isTabbedPanelKind(kind) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return undefined
  }

  const rawBinding = value as Partial<LayoutPanelTabBinding>
  if (!Array.isArray(rawBinding.tabIds)) return undefined
  const tabIds = normalizeWindowingTabIds(kind, rawBinding.tabIds)

  const activeTabId = readWindowingTabId(kind, rawBinding.activeTabId)
  const effectiveActiveTabId =
    activeTabId && tabIds.includes(activeTabId) ? activeTabId : tabIds[0]

  return {
    tabIds,
    ...(effectiveActiveTabId ? { activeTabId: effectiveActiveTabId } : {}),
  }
}
