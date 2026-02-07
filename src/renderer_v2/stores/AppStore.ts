import { action, computed, makeObservable, observable, runInAction, toJS } from 'mobx'
import { v4 as uuidv4 } from 'uuid'
import type { ITheme } from '@xterm/xterm'
import type { AppSettings, TerminalConfig, AppLanguage, ModelDefinition, ProxyEntry, TunnelEntry } from '../lib/ipcTypes'
import { applyAppThemeFromTerminalScheme } from '../theme/appTheme'
import { resolveTheme } from '../theme/themes'
import { toXtermTheme } from '../theme/xtermTheme'
import type { TerminalColorScheme } from '../theme/terminalColorSchemes'
import { I18nStore } from './I18nStore'
import { ChatStore } from './ChatStore'
import { LayoutStore } from './LayoutStore'

const upsertById = <T extends { id: string }>(list: T[], entry: T): T[] => {
  const idx = list.findIndex((x) => x.id === entry.id)
  if (idx === -1) return [...list, entry]
  const next = list.slice()
  next[idx] = entry
  return next
}

const removeById = <T extends { id: string }>(list: T[], id: string): T[] =>
  list.filter((x) => x.id !== id)

export type AppView = 'main' | 'settings' | 'connections'
export type SettingsSection = 'general' | 'theme' | 'models' | 'security' | 'tools' | 'skills'

export type McpToolSummary = Awaited<ReturnType<Window['gyshell']['tools']['getMcp']>>[number]
export type BuiltInToolSummary = Awaited<ReturnType<Window['gyshell']['tools']['getBuiltIn']>>[number]
export type SkillSummary = Awaited<ReturnType<Window['gyshell']['skills']['getAll']>>[number]
export type CommandPolicyLists = Awaited<ReturnType<Window['gyshell']['settings']['getCommandPolicyLists']>>

export interface TerminalTabModel {
  id: string
  title: string
  config: TerminalConfig
  connectionRef?: { type: 'local' } | { type: 'ssh'; entryId: string }
}

export class AppStore {
  view: AppView = 'main'
  settings: AppSettings | null = null
  isBootstrapped = false
  settingsSection: SettingsSection = 'general'

  terminalTabs: TerminalTabModel[] = []
  activeTerminalId: string | null = null
  terminalSelections: Record<string, string> = {}

  xtermTheme: ITheme = {}
  customThemes: TerminalColorScheme[] = []
  i18n = new I18nStore()
  chat = new ChatStore()
  layout = new LayoutStore(this)
  mcpTools: McpToolSummary[] = []
  builtInTools: BuiltInToolSummary[] = []
  skills: SkillSummary[] = []
  commandPolicyLists: CommandPolicyLists = { allowlist: [], denylist: [], asklist: [] }

  constructor() {
    makeObservable(this, {
      view: observable,
      settings: observable,
      isBootstrapped: observable,
      settingsSection: observable,
      terminalTabs: observable,
      activeTerminalId: observable,
      terminalSelections: observable,
      xtermTheme: observable,
      customThemes: observable,
      i18n: observable,
      chat: observable,
      layout: observable,
      mcpTools: observable,
      builtInTools: observable,
      skills: observable,
      commandPolicyLists: observable,
      isSettings: computed,
      isConnections: computed,
      activeTerminal: computed,
      openSettings: action,
      closeSettings: action,
      toggleSettings: action,
      openConnections: action,
      closeOverlay: action,
      bootstrap: action,
      createLocalTab: action,
      createSshTab: action,
      saveSshConnection: action,
      deleteSshConnection: action,
      closeTab: action,
      setActiveTerminal: action,
      setTerminalSelection: action,
      setSettingsSection: action,
      setThemeId: action,
      setLanguage: action,
      setTerminalSettings: action,
      saveModel: action,
      deleteModel: action,
      saveProfile: action,
      deleteProfile: action,
      setActiveProfile: action,
      saveProxy: action,
      deleteProxy: action,
      saveTunnel: action,
      deleteTunnel: action,
      setCommandPolicyMode: action,
      openCommandPolicyFile: action,
      loadCommandPolicyLists: action,
      addCommandPolicyRule: action,
      deleteCommandPolicyRule: action,
      loadTools: action,
      loadSkills: action,
      openSkillsFolder: action,
      reloadSkills: action,
      createSkill: action,
      editSkill: action,
      deleteSkill: action,
      openCustomThemeFile: action,
      reloadCustomThemes: action,
      openMcpConfig: action,
      reloadMcpTools: action,
      setMcpToolEnabled: action,
      setBuiltInToolEnabled: action,
      setSkillEnabled: action,
      setRecursionLimit: action,
      sendChatMessage: action,
      getUniqueTitle: action
    })
    this.chat.setQueueRunner((sessionId, content) => this.sendChatMessage(sessionId, content, { mode: 'queue' }))
  }

  getUniqueTitle(baseTitle: string): string {
    const existingTitles = this.terminalTabs.map((t) => t.title)
    if (!existingTitles.includes(baseTitle)) {
      return baseTitle
    }

    let counter = 1
    let newTitle = `${baseTitle} (${counter})`
    while (existingTitles.includes(newTitle)) {
      counter++
      newTitle = `${baseTitle} (${counter})`
    }
    return newTitle
  }

  get isSettings(): boolean {
    return this.view === 'settings'
  }

  get isConnections(): boolean {
    return this.view === 'connections'
  }

  get activeTerminal(): TerminalTabModel | null {
    if (!this.activeTerminalId) return null
    return this.terminalTabs.find((t) => t.id === this.activeTerminalId) ?? null
  }

  openSettings(): void {
    this.view = 'settings'
  }

  closeSettings(): void {
    this.view = 'main'
  }

  toggleSettings(): void {
    this.view = this.view === 'settings' ? 'main' : 'settings'
  }

  openConnections(): void {
    this.view = 'connections'
  }

  closeOverlay(): void {
    this.view = 'main'
  }

  setSettingsSection(section: SettingsSection): void {
    this.settingsSection = section
  }

  async setLanguage(lang: AppLanguage): Promise<void> {
    this.i18n.setLocale(lang)
    runInAction(() => {
      if (this.settings) {
        this.settings = { ...this.settings, language: lang }
      }
    })
    await window.gyshell.settings.set({ language: lang })
  }

  async setTerminalSettings(terminal: Partial<AppSettings['terminal']>): Promise<void> {
    let nextTerminal: AppSettings['terminal'] | undefined
    runInAction(() => {
      if (this.settings) {
        this.settings.terminal = {
          ...this.settings.terminal,
          ...terminal
        }
        nextTerminal = toJS(this.settings.terminal)
      }
    })
    if (nextTerminal) {
      await window.gyshell.settings.set({ terminal: nextTerminal })
    }
  }

  async setThemeId(themeId: string): Promise<void> {
    // optimistic UI: apply immediately
    const theme = resolveTheme(themeId, this.customThemes)
    applyAppThemeFromTerminalScheme(theme.terminal)
    const xtermTheme = toXtermTheme(theme.terminal, { transparentBackground: true })
    runInAction(() => {
      this.xtermTheme = xtermTheme
      if (this.settings) {
        this.settings = { ...this.settings, themeId }
      }
    })

    try {
      await window.gyshell.settings.set({ themeId })
    } catch (err) {
      console.error('Failed to persist themeId', err)
      // best-effort rollback by reloading
      try {
        const settings = await window.gyshell.settings.get()
        const t = resolveTheme(settings.themeId, this.customThemes)
        applyAppThemeFromTerminalScheme(t.terminal)
        runInAction(() => {
          this.settings = settings
          this.xtermTheme = toXtermTheme(t.terminal, { transparentBackground: true })
        })
      } catch {
        // ignore
      }
    }
  }

  async setCommandPolicyMode(mode: AppSettings['commandPolicyMode']): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings = { ...this.settings, commandPolicyMode: mode }
      }
    })
    await window.gyshell.settings.set({ commandPolicyMode: mode })
  }

  async openCommandPolicyFile(): Promise<void> {
    await window.gyshell.settings.openCommandPolicyFile()
  }

  async loadCommandPolicyLists(): Promise<void> {
    try {
      const lists = await window.gyshell.settings.getCommandPolicyLists()
      runInAction(() => {
        this.commandPolicyLists = lists
      })
    } catch (err) {
      console.error('Failed to load command policy lists', err)
    }
  }

  async addCommandPolicyRule(listName: 'allowlist' | 'denylist' | 'asklist', rule: string): Promise<void> {
    const lists = await window.gyshell.settings.addCommandPolicyRule(listName, rule)
    runInAction(() => {
      this.commandPolicyLists = lists
    })
  }

  async deleteCommandPolicyRule(listName: 'allowlist' | 'denylist' | 'asklist', rule: string): Promise<void> {
    const lists = await window.gyshell.settings.deleteCommandPolicyRule(listName, rule)
    runInAction(() => {
      this.commandPolicyLists = lists
    })
  }

  async loadTools(): Promise<void> {
    try {
      const [mcpTools, builtInTools] = await Promise.all([
        window.gyshell.tools.getMcp(),
        window.gyshell.tools.getBuiltIn()
      ])
      runInAction(() => {
        this.mcpTools = mcpTools
        this.builtInTools = builtInTools
      })
    } catch (err) {
      console.error('Failed to load tools status', err)
    }
  }

  async loadSkills(): Promise<void> {
    try {
      const skills = await window.gyshell.skills.getAll()
      runInAction(() => {
        this.skills = skills
      })
    } catch (err) {
      console.error('Failed to load skills', err)
    }
  }

  async openSkillsFolder(): Promise<void> {
    await window.gyshell.skills.openFolder()
  }

  async reloadSkills(): Promise<void> {
    const skills = await window.gyshell.skills.reload()
    runInAction(() => {
      this.skills = skills
    })
  }

  async createSkill(): Promise<void> {
    await window.gyshell.skills.create()
    await this.reloadSkills()
  }

  async editSkill(fileName: string): Promise<void> {
    await window.gyshell.skills.openFile(fileName)
  }

  async deleteSkill(fileName: string): Promise<void> {
    const skills = await window.gyshell.skills.delete(fileName)
    runInAction(() => {
      this.skills = skills
    })
  }

  async openMcpConfig(): Promise<void> {
    await window.gyshell.tools.openMcpConfig()
  }

  async reloadMcpTools(): Promise<void> {
    const mcpTools = await window.gyshell.tools.reloadMcp()
    runInAction(() => {
      this.mcpTools = mcpTools
    })
  }

  async setMcpToolEnabled(name: string, enabled: boolean): Promise<void> {
    const mcpTools = await window.gyshell.tools.setMcpEnabled(name, enabled)
    runInAction(() => {
      this.mcpTools = mcpTools
    })
  }

  async setBuiltInToolEnabled(name: string, enabled: boolean): Promise<void> {
    const builtInTools = await window.gyshell.tools.setBuiltInEnabled(name, enabled)
    runInAction(() => {
      this.builtInTools = builtInTools
    })
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    const enabledSkills = await window.gyshell.skills.setEnabled(name, enabled)
    const settings = await window.gyshell.settings.get()
    runInAction(() => {
      this.settings = settings
      this.skills = this.skills.map(s => ({
        ...s,
        enabled: enabledSkills.some(es => es.name === s.name)
      }))
    })
  }

  async setRecursionLimit(limit: number): Promise<void> {
    runInAction(() => {
      if (this.settings) {
        this.settings.recursionLimit = limit
      }
    })
    await window.gyshell.settings.set({ recursionLimit: limit })
  }

  async openCustomThemeFile(): Promise<void> {
    await window.gyshell.themes.openCustomConfig()
  }

  async reloadCustomThemes(): Promise<void> {
    const themes = await window.gyshell.themes.reloadCustom()
    runInAction(() => {
      this.customThemes = themes
    })
    this.ensureThemeExists()
  }

  async bootstrap(): Promise<void> {
    if (this.isBootstrapped) return
    try {
      const [settings, customThemes] = await Promise.all([
        window.gyshell.settings.get(),
        window.gyshell.themes.getCustom()
      ])
      const theme = resolveTheme(settings.themeId, customThemes)
      applyAppThemeFromTerminalScheme(theme.terminal)
      const xtermTheme = toXtermTheme(theme.terminal, { transparentBackground: true })

      runInAction(() => {
        this.settings = settings
        this.xtermTheme = xtermTheme
        this.isBootstrapped = true
        this.i18n.setLocale(settings.language)
        this.customThemes = customThemes
        this.layout.bootstrap()
      })

      // Setup deterministic UI update listener (backend is the source of truth)
      window.gyshell.agent.onUiUpdate((action) => {
        this.chat.handleUiUpdate(action)
      })

      // Setup Terminal Exit Listener
      window.gyshell.terminal.onExit(({ terminalId }) => {
        // Only automatically close tab if it's NOT in initializing state.
        // If it was initializing (e.g. SSH connecting), we want to keep it open
        // so the user can see the error message.
        const tab = this.terminalTabs.find(t => t.id === terminalId)
        // Note: We can't easily check backend state here without a sync call,
        // but we can assume if it's an SSH tab that just failed, we should keep it.
        // A better way is to let the user manually close failed connections.
        if (tab && tab.config.type === 'local') {
          this.closeTab(terminalId)
        }
      })

      // MCP tool status updates
      window.gyshell.tools.onMcpUpdated((mcpTools) => {
        runInAction(() => {
          this.mcpTools = mcpTools
        })
      })

      // Skill status updates
      window.gyshell.skills.onUpdated((enabledSkills: SkillSummary[]) => {
        runInAction(() => {
          this.skills = this.skills.map(s => ({
            ...s,
            enabled: enabledSkills.some(es => es.name === s.name)
          }))
        })
      })

      // Ensure at least one terminal exists
      if (this.terminalTabs.length === 0) {
        this.createLocalTab()
      }

      // Load tools status
      void this.loadTools()
      void this.loadSkills()
      void this.loadCommandPolicyLists()
    } catch (err) {
      console.error('Failed to bootstrap settings', err)
      runInAction(() => {
        this.isBootstrapped = true
      })
      if (this.terminalTabs.length === 0) {
        this.createLocalTab()
      }
      void this.loadTools()
      void this.loadSkills()
      void this.loadCommandPolicyLists()
    }
  }

  createLocalTab(): void {
    const id = `local-${uuidv4()}`
    const title = this.getUniqueTitle('Local')
    const cfg: TerminalConfig = { type: 'local', id, title, cols: 80, rows: 24 }
    const tab: TerminalTabModel = { id, title, config: cfg, connectionRef: { type: 'local' } }
    this.terminalTabs.push(tab)
    this.activeTerminalId = id
  }

  createSshTab(entryId: string): void {
    const entry = this.settings?.connections?.ssh?.find((x) => x.id === entryId)
    if (!entry) {
      console.warn('SSH entry not found', entryId)
      return
    }
    const proxy = entry.proxyId
      ? this.settings?.connections?.proxies?.find((p) => p.id === entry.proxyId)
      : undefined
    const tunnels = (entry.tunnelIds ?? [])
      .map((id) => this.settings?.connections?.tunnels?.find((t) => t.id === id))
      .filter(Boolean) as any[]
    const id = `ssh-${uuidv4()}`
    const baseTitle = entry.name || `${entry.username}@${entry.host}`
    const title = this.getUniqueTitle(baseTitle)
    const jumpHost = (entry as any).jumpHost ? (toJS((entry as any).jumpHost) as any) : undefined
    const cfg: TerminalConfig = {
      type: 'ssh',
      id,
      title,
      cols: 80,
      rows: 24,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      authMethod: entry.authMethod,
      password: entry.password,
      privateKey: entry.privateKey,
      privateKeyPath: entry.privateKeyPath,
      passphrase: entry.passphrase,
      proxy,
      tunnels,
      jumpHost
    } as any
    const tab: TerminalTabModel = { id, title, config: cfg, connectionRef: { type: 'ssh', entryId } }
    this.terminalTabs.push(tab)
    this.activeTerminalId = id
  }

  async saveSshConnection(entry: AppSettings['connections']['ssh'][number]): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const plainEntry = toJS(entry)
    const list = current.connections.ssh.slice().map((x) => toJS(x))
    const nextList = upsertById(list, plainEntry)

    const nextConnections = { ...toJS(current.connections), ssh: nextList }

    runInAction(() => {
      if (this.settings) {
        this.settings.connections.ssh = nextList as any
      }
    })

    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async deleteSshConnection(id: string): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const list = removeById(current.connections.ssh, id).map((x) => toJS(x))
    const nextConnections = { ...toJS(current.connections), ssh: list }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.ssh = list as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async saveModel(model: ModelDefinition): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const items = current.models.items.slice().map((x) => toJS(x))
    const modelSnapshot = toJS(model)
    const plainModel: ModelDefinition = {
      ...modelSnapshot,
      // Ensure profile is a plain object for IPC cloning
      profile: modelSnapshot.profile ? toJS(modelSnapshot.profile) : undefined
    }
    let nextProfile: ModelDefinition['profile'] = {
      imageInputs: false,
      testedAt: Date.now(),
      ok: false,
      error: 'Probe failed'
    }
    try {
      const probeResult = await window.gyshell.models.probe(plainModel)
      nextProfile = {
        imageInputs: probeResult.imageInputs,
        testedAt: probeResult.testedAt,
        ok: probeResult.ok,
        error: probeResult.error
      }
    } catch (err) {
      nextProfile = {
        imageInputs: false,
        testedAt: Date.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
    const nextModel: ModelDefinition = {
      ...plainModel,
      profile: nextProfile
    }
    const nextItems = upsertById(items, nextModel)

    const nextModels = { ...toJS(current.models), items: nextItems }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async deleteModel(id: string): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const items = removeById(current.models.items, id).map((x) => toJS(x))
    const nextModels = { ...toJS(current.models), items }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async saveProfile(profile: AppSettings['models']['profiles'][number]): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const profiles = current.models.profiles.slice().map((x) => toJS(x))
    const plainProfile = toJS(profile)
    const nextProfiles = upsertById(profiles, plainProfile)

    const nextModels = { ...toJS(current.models), profiles: nextProfiles }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async deleteProfile(id: string): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const profiles = removeById(current.models.profiles, id).map((x) => toJS(x))
    // If active profile is deleted, reset to first available or default
    let activeProfileId = current.models.activeProfileId
    if (activeProfileId === id) {
        activeProfileId = profiles[0]?.id || ''
    }

    const nextModels = { ...toJS(current.models), profiles, activeProfileId }

    runInAction(() => {
      if (this.settings) {
        this.settings.models = nextModels as any
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async setActiveProfile(id: string): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const nextModels = { ...toJS(current.models), activeProfileId: id }

    runInAction(() => {
      if (this.settings) {
        this.settings.models.activeProfileId = id
      }
    })
    await window.gyshell.settings.set({ models: nextModels })
  }

  async saveProxy(entry: ProxyEntry): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const plainEntry = toJS(entry)
    const list = current.connections.proxies.slice().map((x) => toJS(x))
    const nextList = upsertById(list, plainEntry)

    const nextConnections = { ...toJS(current.connections), proxies: nextList }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.proxies = nextList as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async deleteProxy(id: string): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const list = removeById(current.connections.proxies, id).map((x) => toJS(x))
    const nextConnections = { ...toJS(current.connections), proxies: list }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.proxies = list as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async saveTunnel(entry: TunnelEntry): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const plainEntry = toJS(entry)
    const list = current.connections.tunnels.slice().map((x) => toJS(x))
    const nextList = upsertById(list, plainEntry)

    const nextConnections = { ...toJS(current.connections), tunnels: nextList }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.tunnels = nextList as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async deleteTunnel(id: string): Promise<void> {
    const current = this.settings ?? (await window.gyshell.settings.get())
    const list = removeById(current.connections.tunnels, id).map((x) => toJS(x))
    const nextConnections = { ...toJS(current.connections), tunnels: list }
    runInAction(() => {
      if (this.settings) {
        this.settings.connections.tunnels = list as any
      }
    })
    await window.gyshell.settings.set({ connections: nextConnections })
  }

  async closeTab(tabId: string): Promise<void> {
    const idx = this.terminalTabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return

    const wasActive = this.activeTerminalId === tabId
    const nextTabs = this.terminalTabs.slice()
    nextTabs.splice(idx, 1)

    let nextActive: string | null = this.activeTerminalId
    if (wasActive) {
      nextActive = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null
    }

    runInAction(() => {
      this.terminalTabs = nextTabs
      this.activeTerminalId = nextActive
    })

    // Kill backend session (best-effort)
    try {
      await window.gyshell.terminal.kill(tabId)
    } catch {
      // ignore
    }

    // Never leave the app without a terminal
    if (this.terminalTabs.length === 0) {
      this.createLocalTab()
    }
  }

  sendChatMessage(
    sessionId: string,
    content: string,
    options?: { mode?: 'normal' | 'queue' }
  ): boolean {
    const activeTabId = this.activeTerminalId
    const mode = options?.mode || 'normal'
    let targetSessionId = sessionId
    if (!targetSessionId) {
      targetSessionId = this.chat.createSession()
    }
    
    const session = this.chat.sessions.find(s => s.id === targetSessionId)
    const wasBusy = !!session?.isSessionBusy
    if (mode === 'queue' && session?.isSessionBusy) {
      console.warn('[AppStore] Session is busy, ignoring message:', content)
      return false
    }

    if (!activeTabId) {
      this.chat.addMessage(
        { role: 'system', type: 'text', content: 'No active terminal selected.' },
        targetSessionId
      )
      return false
    }

    this.chat.setThinking(true, targetSessionId)
    this.chat.setSessionBusy(true, targetSessionId)

    const selectionText = this.getTerminalSelection(activeTabId)
    window.gyshell.terminal.setSelection(activeTabId, selectionText).catch(() => {
      // ignore
    })
    const startMode = wasBusy && mode === 'normal' ? 'inserted' : 'normal'
    window.gyshell.agent.startTask(targetSessionId, activeTabId, content, { startMode })
    return true
  }

  setActiveTerminal(id: string): void {
    this.activeTerminalId = id
  }

  setTerminalSelection(terminalId: string, selectionText: string): void {
    this.terminalSelections = { ...this.terminalSelections, [terminalId]: selectionText }
  }

  getTerminalSelection(terminalId: string): string {
    return this.terminalSelections[terminalId] || ''
  }

  private ensureThemeExists(): void {
    if (!this.settings) return
    const themeId = this.settings.themeId
    const theme = resolveTheme(themeId, this.customThemes)
    if (theme.id !== themeId) {
      void this.setThemeId(theme.id)
    } else {
      applyAppThemeFromTerminalScheme(theme.terminal)
      runInAction(() => {
        this.xtermTheme = toXtermTheme(theme.terminal, { transparentBackground: true })
      })
    }
  }
}
