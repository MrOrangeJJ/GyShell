import type { PanelTabDisplayModePreference } from '@gyshell/shared'

export type AppLanguage = 'en' | 'zh-CN'

export interface TerminalUiSettings {
  fontSize: number
  lineHeight: number
  scrollback: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  copyOnSelect: boolean
  rightClickToPaste: boolean
  commandDraftShortcut: string
}

export interface PanelTabsUiSettings {
  displayMode: PanelTabDisplayModePreference
}

export interface CommandDraftUiSettings {
  profileId: string
}

export type ChatDisplayMode = 'classic' | 'seamless'

export interface ChatUiSettings {
  displayMode: ChatDisplayMode
}

export interface RuntimeUiSettings {
  preventSleepWhileRunning?: boolean
}

export interface UiSettings {
  uiSchemaVersion: 1
  language: AppLanguage
  themeId: string
  terminal: TerminalUiSettings
  panelTabs: PanelTabsUiSettings
  commandDraft: CommandDraftUiSettings
  chat: ChatUiSettings
  runtime?: RuntimeUiSettings
  monitorEnabledSources?: string[]
  macosFullDiskAccessPromptedVersion?: string
  macosFullDiskAccessCheckedInstallation?: string
}
