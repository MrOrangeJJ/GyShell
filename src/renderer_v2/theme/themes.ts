import type { TerminalColorScheme } from './terminalColorSchemes'
import { TABBY_DEFAULT_DARK, TABBY_DEFAULT_LIGHT } from './terminalColorSchemes'
import { builtInSchemes } from './builtInSchemes'

export type ThemeId = string

export interface AppTheme {
  id: ThemeId
  name: string
  terminal: TerminalColorScheme
}

export const BUILTIN_THEMES: AppTheme[] = [
  { id: 'gyshell-dark', name: 'Default Dark', terminal: TABBY_DEFAULT_DARK },
  { id: 'gyshell-light', name: 'Default Light', terminal: TABBY_DEFAULT_LIGHT },
  ...builtInSchemes.map((s) => ({
    id: s.name,
    name: s.name,
    terminal: s
  }))
]

export function getAllThemes(customThemes: TerminalColorScheme[] = []): AppTheme[] {
  const custom = customThemes.map((theme) => ({
    id: theme.name,
    name: theme.name,
    terminal: theme
  }))
  return [...BUILTIN_THEMES, ...custom]
}

export function resolveTheme(themeId: string | undefined, customThemes: TerminalColorScheme[] = []): AppTheme {
  const custom = customThemes.find((t) => t.name === themeId)
  if (custom) {
    return { id: custom.name, name: custom.name, terminal: custom }
  }
  return BUILTIN_THEMES.find((t) => t.id === themeId) ?? BUILTIN_THEMES[0]
}


