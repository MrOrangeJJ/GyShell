import type { ITheme } from '@xterm/xterm'
import type { TerminalColorScheme } from './terminalColorSchemes'

// Copied from Tabby (`tabby-terminal/src/frontends/xtermFrontend.ts`)
const COLOR_NAMES: Array<keyof ITheme> = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.replace('#', '').trim()
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  if (full.length !== 6) return null
  const n = Number.parseInt(full, 16)
  if (Number.isNaN(n)) return null
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#')) return color
  const rgb = hexToRgb(color)
  if (!rgb) return color
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

export function toXtermTheme(scheme: TerminalColorScheme, opts?: { transparentBackground?: boolean }): ITheme {
  const transparentBackground = opts?.transparentBackground ?? true

  const theme: ITheme = {
    foreground: scheme.foreground,
    selectionBackground: scheme.selection ?? '#88888888',
    selectionForeground: scheme.selectionForeground ?? undefined,
    background: transparentBackground ? '#00000000' : scheme.background,
    cursor: scheme.cursor,
    cursorAccent: scheme.cursorAccent,
    scrollbarSliderBackground: withAlpha(scheme.foreground, 0.4),
    scrollbarSliderHoverBackground: withAlpha(scheme.foreground, 0.5),
    scrollbarSliderActiveBackground: withAlpha(scheme.foreground, 0.6)
  }

  for (let i = 0; i < COLOR_NAMES.length; i++) {
    ;(theme as any)[COLOR_NAMES[i]] = scheme.colors[i]
  }

  return theme
}


