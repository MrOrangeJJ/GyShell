import type { TerminalColorScheme } from './terminalColorSchemes'

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (full.length !== 6) return null
  const n = Number.parseInt(full, 16)
  if (Number.isNaN(n)) return null
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

function luminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0.5
  const srgb = [rgb.r, rgb.g, rgb.b].map((v) => v / 255)
  const lin = srgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

// amount: -1..1 (negative = darker, positive = lighter)
function shade(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const t = amount < 0 ? 0 : 255
  const p = Math.abs(amount)
  return rgbToHex(
    rgb.r + (t - rgb.r) * p,
    rgb.g + (t - rgb.g) * p,
    rgb.b + (t - rgb.b) * p
  )
}

export function applyAppThemeFromTerminalScheme(scheme: TerminalColorScheme): void {
  const root = document.documentElement.style

  // Map Tabby-like terminal scheme into our UI tokens
  const bg = scheme.background
  const fg = scheme.foreground
  const accent = scheme.colors[4] // Tabby uses accentIndex=4
  const isDark = luminance(bg) < 0.5

  root.setProperty('--app-bg', bg)
  root.setProperty('--panel-bg', shade(bg, 0.06))
  root.setProperty('--panel-bg-2', shade(bg, 0.02))

  root.setProperty('--fg', fg)
  root.setProperty('--fg-muted', shade(fg, -0.25))
  root.setProperty('--fg-faint', shade(fg, -0.45))

  root.setProperty('--accent', accent)
  root.setProperty('--accent-2', scheme.colors[5])

  // Border/control tokens must adapt in light mode, otherwise icons/controls look "off"
  if (isDark) {
    root.setProperty('--border', 'rgba(255, 255, 255, 0.08)')
    root.setProperty('--border-strong', 'rgba(255, 255, 255, 0.14)')
    root.setProperty('--control-bg', 'rgba(255, 255, 255, 0.06)')
    root.setProperty('--control-bg-hover', 'rgba(255, 255, 255, 0.09)')
    root.setProperty('--control-bg-active', 'rgba(255, 255, 255, 0.12)')
    root.setProperty('--shadow', '0 10px 30px rgba(0, 0, 0, 0.45)')
  } else {
    root.setProperty('--border', 'rgba(0, 0, 0, 0.10)')
    root.setProperty('--border-strong', 'rgba(0, 0, 0, 0.18)')
    root.setProperty('--control-bg', 'rgba(0, 0, 0, 0.04)')
    root.setProperty('--control-bg-hover', 'rgba(0, 0, 0, 0.06)')
    root.setProperty('--control-bg-active', 'rgba(0, 0, 0, 0.09)')
    root.setProperty('--shadow', '0 10px 30px rgba(0, 0, 0, 0.18)')
  }

  // Keep danger/success mapped to terminal red/green
  root.setProperty('--danger', scheme.colors[1])
  root.setProperty('--success', scheme.colors[2])
  root.setProperty('--warning', scheme.colors[3])
}


