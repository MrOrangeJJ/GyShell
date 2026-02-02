import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { TerminalColorScheme } from '../../renderer_v2/theme/terminalColorSchemes'
import { applyWindowsWindowTweaks, getWindowsBrowserWindowOptions, updateWindowsTheme } from './windows/windowChrome'

export function getPlatformBrowserWindowOptions(
  themeId?: string,
  customThemes: TerminalColorScheme[] = []
): BrowserWindowConstructorOptions {
  if (process.platform === 'win32') return getWindowsBrowserWindowOptions(themeId, customThemes)
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return { autoHideMenuBar: true }
}

export function applyPlatformWindowTweaks(win: BrowserWindow): void {
  if (process.platform === 'win32') applyWindowsWindowTweaks(win)
}

export function updatePlatformTheme(
  win: BrowserWindow,
  themeId?: string,
  customThemes: TerminalColorScheme[] = []
): void {
  if (process.platform === 'win32') updateWindowsTheme(win, themeId, customThemes)
}
