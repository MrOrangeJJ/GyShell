import Store from 'electron-store'
import type { AppSettings } from '../types'
import { BUILTIN_TOOL_INFO } from './AgentHelper/tools'

const DEFAULT_BUILTIN_TOOLS = BUILTIN_TOOL_INFO.reduce((acc: Record<string, boolean>, tool) => {
  acc[tool.name] = true
  return acc
}, {})

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 2,
  language: 'en',
  themeId: 'gyshell-dark',
  commandPolicyMode: 'standard',
  tools: {
    builtIn: DEFAULT_BUILTIN_TOOLS
  },
  // Current effective settings (runtime binding)
  model: '',
  baseUrl: '',
  apiKey: '',
  // registry/profile
  models: {
    items: [],
    profiles: [],
    activeProfileId: ''
  },
  // connections
  connections: {
    ssh: [],
    proxies: [],
    tunnels: []
  },
  terminal: {
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorStyle: 'block',
    cursorBlink: true,
    copyOnSelect: true,
    rightClickToPaste: true
  },
  layout: {
    panelSizes: [30, 70],
    panelOrder: ['chat', 'terminal']
  },
  recursionLimit: 200
}

function isObject(x: unknown): x is Record<string, any> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (!isObject(base) || !isObject(patch)) return { ...(base as any), ...(patch as any) }
  const out: any = { ...(base as any) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out
}

export class SettingsService {
  private store: Store<AppSettings>

  constructor() {
    this.store = new Store<AppSettings>({
      defaults: DEFAULT_SETTINGS,
      name: 'gyshell-settings'
    })

    // Best-effort migration from v1 -> v2
    this.ensureMigrated()
  }

  private ensureMigrated(): void {
    const raw: any = this.store.store
    // We only support schemaVersion 2 now.
    const merged = deepMerge(DEFAULT_SETTINGS, raw) as AppSettings
    
    // Ensure all model items have maxTokens
    if (merged.models?.items) {
      merged.models.items = merged.models.items.map(item => ({
        ...item,
        maxTokens: typeof item.maxTokens === 'number' ? item.maxTokens : 200000
      }))
    }

    const normalized = this.normalizeBuiltInTools(merged)

    // Recompute effective model from active profile
    const effectiveModel = this.computeEffectiveModel(normalized)

    // Ensure terminal settings are safe (fix for xterm crash)
    if (normalized.terminal) {
      if (typeof normalized.terminal.lineHeight !== 'number' || normalized.terminal.lineHeight < 1) {
        normalized.terminal.lineHeight = 1.2
      }
      if (typeof normalized.terminal.fontSize !== 'number' || normalized.terminal.fontSize < 6) {
        normalized.terminal.fontSize = 14
      }
    }

    const fixed = {
      ...normalized,
      model: effectiveModel,
      schemaVersion: 2
    }
    this.store.store = fixed as any
  }

  private normalizeBuiltInTools(settings: AppSettings): AppSettings {
    const builtIn = settings.tools?.builtIn ?? {}
    const normalizedBuiltIn = { ...DEFAULT_BUILTIN_TOOLS, ...builtIn }
    return {
      ...settings,
      tools: {
        builtIn: normalizedBuiltIn
      }
    }
  }

  private computeEffectiveModel(settings: AppSettings): string {
    const activeProfile = settings.models.profiles.find((p) => p.id === settings.models.activeProfileId)
    const globalId = activeProfile?.globalModelId
    const global = globalId ? settings.models.items.find((m) => m.id === globalId) : undefined
    return global?.model || ''
  }

  getSettings(): AppSettings {
    // ensure nested defaults/migration, then return store snapshot
    this.ensureMigrated()
    return this.store.store as AppSettings
  }

  setSettings(settings: Partial<AppSettings>): void {
    this.ensureMigrated()
    const current = this.store.store as AppSettings
    const merged = deepMerge(current, settings)
    const normalized = this.normalizeBuiltInTools(merged as AppSettings)

    // keep effective fields consistent
    const effectiveModel = this.computeEffectiveModel(normalized as AppSettings)
    
    // Auto-activate the first profile if none is active and profiles exist
    if (!normalized.models.activeProfileId && normalized.models.profiles.length > 0) {
      normalized.models.activeProfileId = normalized.models.profiles[0].id
    }

    const next: AppSettings = {
      ...(normalized as AppSettings),
      model: effectiveModel,
      // Ensure schema version is pinned
      schemaVersion: 2
    }

    this.store.store = next as any
  }
}

