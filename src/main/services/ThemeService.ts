import fs from 'fs/promises'
import path from 'path'
import { app, shell } from 'electron'
import type { TerminalColorScheme } from '../../renderer_v2/theme/terminalColorSchemes'

const DEFAULT_CUSTOM_THEMES: TerminalColorScheme[] = [
  {
    name: 'Custom Demo',
    foreground: '#e6e6e6',
    background: '#1b1b1b',
    cursor: '#e6e6e6',
    colors: [
      '#1b1b1b',
      '#ff6b6b',
      '#62d196',
      '#f4bf75',
      '#6aa6ff',
      '#c792ea',
      '#5fd7d7',
      '#e6e6e6',
      '#3a3a3a',
      '#ff8a8a',
      '#7ee3ad',
      '#ffd08a',
      '#86b7ff',
      '#d3a6ff',
      '#7ee9e9',
      '#ffffff'
    ]
  }
]

export class ThemeService {
  private customThemes: TerminalColorScheme[] = []

  getCustomThemePath(): string {
    const baseDir = app.getPath('userData')
    return path.join(baseDir, 'custom-themes.json')
  }

  async ensureCustomThemeFile(): Promise<void> {
    const filePath = this.getCustomThemePath()
    try {
      await fs.access(filePath)
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(DEFAULT_CUSTOM_THEMES, null, 2))
    }
  }

  async openCustomThemeFile(): Promise<void> {
    await this.ensureCustomThemeFile()
    await shell.openPath(this.getCustomThemePath())
  }

  getCustomThemes(): TerminalColorScheme[] {
    return this.customThemes
  }

  async loadCustomThemes(): Promise<TerminalColorScheme[]> {
    await this.ensureCustomThemeFile()
    const filePath = this.getCustomThemePath()
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      const normalized = this.normalizeThemes(parsed)
      this.customThemes = normalized
      return normalized
    } catch (err) {
      console.warn('[ThemeService] Failed to load custom themes:', err)
      this.customThemes = []
      return []
    }
  }

  private normalizeThemes(raw: unknown): TerminalColorScheme[] {
    if (!Array.isArray(raw)) return []
    const out: TerminalColorScheme[] = []
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const name = String((entry as any).name || '').trim()
      const foreground = String((entry as any).foreground || '').trim()
      const background = String((entry as any).background || '').trim()
      const cursor = String((entry as any).cursor || '').trim()
      const colors = Array.isArray((entry as any).colors) ? (entry as any).colors.map(String) : []
      if (!name || !foreground || !background || !cursor || colors.length < 16) continue
      const selection = (entry as any).selection ? String((entry as any).selection) : undefined
      const selectionForeground = (entry as any).selectionForeground
        ? String((entry as any).selectionForeground)
        : undefined
      const cursorAccent = (entry as any).cursorAccent ? String((entry as any).cursorAccent) : undefined
      out.push({
        name,
        foreground,
        background,
        cursor,
        colors: colors.slice(0, 16),
        selection,
        selectionForeground,
        cursorAccent
      })
    }
    return out
  }
}
