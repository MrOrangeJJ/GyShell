import { app, BrowserWindow, ipcMain, screen, Menu, shell } from 'electron'
import { join } from 'path'
import { resolveTheme } from '../renderer_v2/theme/themes'
import { SettingsService } from './services/SettingsService'
import { TerminalService } from './services/TerminalService'
import { AgentService_v2 } from './services/AgentService_v2'
import { CommandPolicyService } from './services/CommandPolicy/CommandPolicyService'
import { ModelCapabilityService } from './services/ModelCapabilityService'
import { McpToolService } from './services/McpToolService'
import { BUILTIN_TOOL_INFO } from './services/AgentHelper/tools'
import { ThemeService } from './services/ThemeService'
import { applyPlatformWindowTweaks, getPlatformBrowserWindowOptions } from './platform/windowChrome'
import { SkillService } from './services/SkillService'
import { UIHistoryService } from './services/UIHistoryService'
import { GatewayService } from './services/Gateway/GatewayService'
import { TempFileService } from './services/TempFileService'

let mainWindow: BrowserWindow | null = null
let settingsService: SettingsService
let terminalService: TerminalService
let agentService: AgentService_v2
let commandPolicyService: CommandPolicyService
let modelCapabilityService: ModelCapabilityService
let mcpToolService: McpToolService
let themeService: ThemeService
let skillService: SkillService
let uiHistoryService: UIHistoryService
let gatewayService: GatewayService
let tempFileService: TempFileService

function createWindow(): void {
  const settings = settingsService.getSettings()
  const savedWindow = settings.layout?.window

  let width = 800
  let height = 500
  let x: number | undefined
  let y: number | undefined

  if (savedWindow) {
    width = savedWindow.width
    height = savedWindow.height
    x = savedWindow.x
    y = savedWindow.y
  } else {
  // Match WaveTerm-like default sizing: fill most of the work area, but capped.
  // (Wave uses: width/height = workArea - 200, caps 2000x1200, mins 800x500)
  const { width: workAreaW, height: workAreaH } = screen.getPrimaryDisplay().workAreaSize
    width = Math.min(Math.max(workAreaW - 200, 800), 2000)
    height = Math.min(Math.max(workAreaH - 200, 500), 1200)
  }

  const platformWindowOptions = getPlatformBrowserWindowOptions(
    settingsService.getSettings().themeId,
    themeService.getCustomThemes()
  )

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 800,
    minHeight: 500,
    ...platformWindowOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Prevent Electron from using the sandboxed renderer bundle in dev.
      // This avoids a known class of startup console errors where the sandbox bundle fails early.
      sandbox: false
    }
  })

  // Load the app
  if (!app.isPackaged) {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!devUrl) {
      throw new Error('Missing ELECTRON_RENDERER_URL (electron-vite dev server URL)')
    }
    mainWindow.loadURL(`${devUrl}/index.html`)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  applyPlatformWindowTweaks(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only allow http/https protocols for safety
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Check if the URL is different from the main window URL and is an external protocol
    if (url !== mainWindow?.webContents.getURL() && (url.startsWith('http:') || url.startsWith('https:'))) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // Save window bounds on resize or move
  const saveBounds = () => {
    if (!mainWindow) return
    const bounds = mainWindow.getBounds()
    settingsService.setSettings({
      layout: {
        window: bounds
      }
    })
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
}

function setupIpcHandlers(): void {
  // System
  ipcMain.handle('system:openExternal', async (_, url: string) => {
    if (url && (url.startsWith('http:') || url.startsWith('https:'))) {
      await shell.openExternal(url)
    }
  })

  // Settings
  ipcMain.handle('settings:get', async () => {
    return settingsService.getSettings()
  })

  ipcMain.handle('settings:set', async (_, settings) => {
    const before = settingsService.getSettings()
    settingsService.setSettings(settings)
    const currentSettings = settingsService.getSettings()
    agentService.updateSettings(currentSettings)

    // Sync Windows title bar overlay at runtime when theme changes
    if (
      process.platform === 'win32' &&
      mainWindow &&
      before.themeId !== currentSettings.themeId &&
      typeof mainWindow.setTitleBarOverlay === 'function'
    ) {
      const theme = resolveTheme(currentSettings.themeId, themeService.getCustomThemes())
      const bg = theme.terminal.background
      const fg = theme.terminal.foreground
      mainWindow.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 38 })
      mainWindow.setBackgroundColor(bg)
    }
  })

  ipcMain.handle('models:probe', async (_evt, model) => {
    return await modelCapabilityService.probe(model)
  })

  ipcMain.handle('settings:openCommandPolicyFile', async () => {
    await commandPolicyService.openPolicyFile()
  })

  ipcMain.handle('settings:getCommandPolicyLists', async () => {
    return await commandPolicyService.getLists()
  })

  ipcMain.handle('settings:addCommandPolicyRule', async (_evt, listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => {
    return await commandPolicyService.addRule(listName, rule)
  })

  ipcMain.handle('settings:deleteCommandPolicyRule', async (_evt, listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => {
    return await commandPolicyService.deleteRule(listName, rule)
  })

  // Tools (MCP)
  ipcMain.handle('tools:openMcpConfig', async () => {
    await mcpToolService.openConfigFile()
  })

  ipcMain.handle('tools:reloadMcp', async () => {
    return await mcpToolService.reloadAll()
  })

  ipcMain.handle('tools:getMcp', async () => {
    return mcpToolService.getSummaries()
  })

  ipcMain.handle('tools:setMcpEnabled', async (_, name: string, enabled: boolean) => {
    return await mcpToolService.setServerEnabled(name, enabled)
  })

  ipcMain.handle('tools:getBuiltIn', async () => {
    const settings = settingsService.getSettings()
    const enabledMap = settings.tools?.builtIn ?? {}
    return BUILTIN_TOOL_INFO.map((tool) => ({
      name: tool.name,
      description: tool.description,
      enabled: enabledMap[tool.name] ?? true
    }))
  })

  // Themes (Custom)
  ipcMain.handle('themes:openCustomConfig', async () => {
    await themeService.openCustomThemeFile()
  })

  ipcMain.handle('themes:reloadCustom', async () => {
    return await themeService.loadCustomThemes()
  })

  ipcMain.handle('themes:getCustom', async () => {
    return await themeService.loadCustomThemes()
  })

  // Terminal
  ipcMain.handle('terminal:createTab', async (_, config) => {
    const tab = await terminalService.createTerminal(config)
    return { id: tab.id }
  })

  ipcMain.handle('terminal:write', async (_, terminalId: string, data: string) => {
    terminalService.write(terminalId, data)
  })

  ipcMain.handle('terminal:writePaths', async (_, terminalId: string, paths: string[]) => {
    terminalService.writePaths(terminalId, paths)
  })

  ipcMain.handle('terminal:resize', async (_, terminalId: string, cols: number, rows: number) => {
    terminalService.resize(terminalId, cols, rows)
  })

  ipcMain.handle('terminal:kill', async (_, terminalId: string) => {
    terminalService.kill(terminalId)
  })

  ipcMain.handle('terminal:setSelection', async (_, terminalId: string, selectionText: string) => {
    terminalService.setSelection(terminalId, selectionText)
  })

  // Agent
  ipcMain.handle('agent:replyCommandApproval', async (_, approvalId: string, decision: 'allow' | 'deny') => {
    commandPolicyService.resolveApproval(approvalId, decision)
  })

  // UI
  ipcMain.handle(
    'ui:showContextMenu',
    async (event, payload: { id: string; canCopy: boolean; canPaste: boolean }) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return

      const menu = Menu.buildFromTemplate([
        {
          label: 'Copy',
          enabled: payload.canCopy,
          click: () => {
            window.webContents.send('ui:contextMenuAction', { id: payload.id, action: 'copy' })
          }
        },
        {
          label: 'Paste',
          enabled: payload.canPaste,
          click: () => {
            window.webContents.send('ui:contextMenuAction', { id: payload.id, action: 'paste' })
          }
        }
      ])

      menu.popup({ window })
    }
  )
}

app.whenReady().then(async () => {
  // Initialize services
  settingsService = new SettingsService()
  terminalService = new TerminalService()
  commandPolicyService = new CommandPolicyService()
  mcpToolService = new McpToolService()
  themeService = new ThemeService()
  uiHistoryService = new UIHistoryService()
  tempFileService = new TempFileService()
  
  // Cleanup old pastes on startup
  void tempFileService.cleanup()

  // Ensure skills dir exists + initial scan (best-effort)
  skillService = new SkillService(settingsService)
  void skillService.reload()

  agentService = new AgentService_v2(terminalService, commandPolicyService, mcpToolService, skillService, uiHistoryService)
  gatewayService = new GatewayService(terminalService, agentService, uiHistoryService, commandPolicyService, tempFileService, skillService)
  // Mount to global for AgentHelper and Gateway (temporary solution)
  ;(global as any).gateway = gatewayService;
  ;(global as any).settingsService = settingsService;
  modelCapabilityService = new ModelCapabilityService()

  // Load MCP tools (best-effort)
  void mcpToolService.reloadAll()
  mcpToolService.on('updated', (summary) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((window) => {
      window.webContents.send('tools:mcpUpdated', summary)
    })
  })

  // Update agent with current settings
  const settings = settingsService.getSettings()
  agentService.updateSettings(settings)

  // Setup IPC handlers
  setupIpcHandlers()

  // Create window
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  if (tempFileService) {
    await tempFileService.cleanup()
  }
  app.quit()
})
