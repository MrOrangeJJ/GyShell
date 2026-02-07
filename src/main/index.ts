import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { SettingsService } from './services/SettingsService'
import { TerminalService } from './services/TerminalService'
import { AgentService_v2 } from './services/AgentService_v2'
import { CommandPolicyService } from './services/CommandPolicy/CommandPolicyService'
import { ModelCapabilityService } from './services/ModelCapabilityService'
import { McpToolService } from './services/McpToolService'
import { ThemeService } from './services/ThemeService'
import { applyPlatformWindowTweaks, getPlatformBrowserWindowOptions } from './platform/windowChrome'
import { SkillService } from './services/SkillService'
import { UIHistoryService } from './services/UIHistoryService'
import { GatewayService } from './services/Gateway/GatewayService'
import { TempFileService } from './services/TempFileService'
import { VersionService } from './services/VersionService'

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
let versionService: VersionService

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

app.whenReady().then(async () => {
  // Initialize services
  settingsService = new SettingsService()
  terminalService = new TerminalService()
  commandPolicyService = new CommandPolicyService()
  mcpToolService = new McpToolService()
  themeService = new ThemeService()
  uiHistoryService = new UIHistoryService()
  tempFileService = new TempFileService()
  versionService = new VersionService()
  
  // Cleanup old pastes on startup
  void tempFileService.cleanup()

  // Ensure skills dir exists + initial scan (best-effort)
  skillService = new SkillService(settingsService)
  void skillService.reload()

  agentService = new AgentService_v2(terminalService, commandPolicyService, mcpToolService, skillService, uiHistoryService)
  gatewayService = new GatewayService(
    terminalService, 
    agentService, 
    uiHistoryService, 
    commandPolicyService, 
    tempFileService, 
    skillService,
    settingsService,
    modelCapabilityService,
    mcpToolService,
    themeService,
    versionService
  )
  // Mount to global for AgentHelper and Gateway (temporary solution)
  ;(global as any).gateway = gatewayService;
  ;(global as any).settingsService = settingsService;
  modelCapabilityService = new ModelCapabilityService()

  // Load MCP tools (best-effort)
  void mcpToolService.reloadAll()

  // Update agent with current settings
  const settings = settingsService.getSettings()
  agentService.updateSettings(settings)

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
