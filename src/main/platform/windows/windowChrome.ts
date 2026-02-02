import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { TerminalColorScheme } from '../../../renderer_v2/theme/terminalColorSchemes'
import { resolveTheme } from '../../../renderer_v2/theme/themes'

export function getWindowsBrowserWindowOptions(
  themeId?: string,
  customThemes: TerminalColorScheme[] = []
): BrowserWindowConstructorOptions {
  const theme = resolveTheme(themeId, customThemes)
  const bg = theme.terminal.background
  const fg = theme.terminal.foreground
  return {
    titleBarStyle: 'hidden',
    backgroundColor: bg,
    // Make the native window controls area match our TopBar background
    // (TopBar is 38px tall in CSS)
    titleBarOverlay: {
      color: bg,
      symbolColor: fg,
      height: 38
    },
    autoHideMenuBar: true
  }
}

export function applyWindowsWindowTweaks(win: BrowserWindow): void {
  // Remove menu so "File Edit View..." doesn't show up and Alt doesn't toggle it
  win.removeMenu()
}

export function updateWindowsTheme(
  win: BrowserWindow,
  themeId?: string,
  customThemes: TerminalColorScheme[] = []
): void {
  const theme = resolveTheme(themeId, customThemes)
  const bg = theme.terminal.background
  const fg = theme.terminal.foreground

  win.setBackgroundColor(bg)
  // titleBarOverlay is Windows only (win32)
  if (process.platform === 'win32') {
    win.setTitleBarOverlay({
      color: bg,
      symbolColor: fg,
      height: 38
    })
  }
}
