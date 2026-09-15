import {
  DEFAULT_PANEL_TAB_DISPLAY_MODE,
  isPanelTabDisplayModePreference,
} from '@gyshell/shared'
import type { UiSettings } from './types'
import { deepMerge, isObject } from './objectMerge'

export const UI_SETTINGS_SCHEMA_VERSION = 1

export const DEFAULT_UI_SETTINGS: UiSettings = {
  uiSchemaVersion: UI_SETTINGS_SCHEMA_VERSION,
  language: 'en',
  themeId: 'gyshell-dark',
  terminal: {
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorStyle: 'block',
    cursorBlink: true,
    copyOnSelect: true,
    rightClickToPaste: true,
    commandDraftShortcut: 'Mod+O'
  },
  panelTabs: {
    displayMode: DEFAULT_PANEL_TAB_DISPLAY_MODE,
  },
  commandDraft: {
    profileId: '',
  },
  chat: {
    displayMode: 'classic',
  },
  runtime: {
    preventSleepWhileRunning: true,
  }
}

function pickUiSnapshot(raw: unknown): Partial<UiSettings> {
  if (!isObject(raw)) return {}
  return {
    uiSchemaVersion: raw.uiSchemaVersion,
    language: raw.language,
    themeId: raw.themeId,
    terminal: raw.terminal,
    panelTabs: raw.panelTabs,
    commandDraft: raw.commandDraft,
    chat: raw.chat,
    runtime: raw.runtime,
    monitorEnabledSources: raw.monitorEnabledSources,
    macosFullDiskAccessPromptedVersion: raw.macosFullDiskAccessPromptedVersion,
    macosFullDiskAccessCheckedInstallation: raw.macosFullDiskAccessCheckedInstallation,
  } as Partial<UiSettings>
}

function normalizeUiSettings(settings: UiSettings): UiSettings {
  const next = deepMerge(DEFAULT_UI_SETTINGS, settings)
  if (typeof next.terminal.lineHeight !== 'number' || next.terminal.lineHeight < 1) {
    next.terminal.lineHeight = 1.2
  }
  if (typeof next.terminal.fontSize !== 'number' || next.terminal.fontSize < 6) {
    next.terminal.fontSize = 14
  }
  if (typeof next.terminal.scrollback !== 'number' || next.terminal.scrollback < 0) {
    next.terminal.scrollback = 5000
  }
  if (typeof next.terminal.commandDraftShortcut !== 'string') {
    next.terminal.commandDraftShortcut = 'Mod+O'
  }
  if (!isPanelTabDisplayModePreference(next.panelTabs.displayMode)) {
    next.panelTabs.displayMode = DEFAULT_PANEL_TAB_DISPLAY_MODE
  }
  if (typeof next.commandDraft.profileId !== 'string') {
    next.commandDraft.profileId = ''
  }
  if (next.chat?.displayMode !== 'classic' && next.chat?.displayMode !== 'seamless') {
    next.chat = { displayMode: 'classic' }
  }
  if (typeof next.runtime?.preventSleepWhileRunning !== 'boolean') {
    next.runtime = {
      ...(next.runtime || {}),
      preventSleepWhileRunning: true,
    }
  }
  if (!Array.isArray(next.monitorEnabledSources)) {
    next.monitorEnabledSources = undefined
  }
  if (
    next.macosFullDiskAccessPromptedVersion !== undefined &&
    (typeof next.macosFullDiskAccessPromptedVersion !== 'string' ||
      next.macosFullDiskAccessPromptedVersion.trim().length === 0)
  ) {
    next.macosFullDiskAccessPromptedVersion = undefined
  }
  if (
    next.macosFullDiskAccessCheckedInstallation !== undefined &&
    (typeof next.macosFullDiskAccessCheckedInstallation !== 'string' ||
      next.macosFullDiskAccessCheckedInstallation.trim().length === 0)
  ) {
    next.macosFullDiskAccessCheckedInstallation = undefined
  }
  next.uiSchemaVersion = UI_SETTINGS_SCHEMA_VERSION
  return next
}

function migrateUiToV1(settings: Partial<UiSettings>): Partial<UiSettings> {
  const next = { ...(settings as any) }
  next.uiSchemaVersion = UI_SETTINGS_SCHEMA_VERSION
  return next
}

export function migrateUiSettings(raw: unknown, legacyRaw?: unknown): UiSettings {
  const legacySnapshot = pickUiSnapshot(legacyRaw)
  const rawSnapshot = pickUiSnapshot(raw)

  const rawVersion = isObject(raw) && typeof raw.uiSchemaVersion === 'number' ? raw.uiSchemaVersion : 0

  let merged = deepMerge(DEFAULT_UI_SETTINGS, legacySnapshot)
  merged = deepMerge(merged, rawSnapshot)

  if (rawVersion < UI_SETTINGS_SCHEMA_VERSION) {
    merged = deepMerge(merged, migrateUiToV1(merged as any) as any)
  }

  return normalizeUiSettings(merged)
}
