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
import { ElectronGatewayIpcAdapter } from './services/Gateway/ElectronGatewayIpcAdapter'
import { ElectronWindowTransport } from './services/Gateway/ElectronWindowTransport'
import { WebSocketGatewayAdapter } from './services/Gateway/WebSocketGatewayAdapter'
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
let tempFileService: TempFileService
let versionService: VersionService
let webSocketGatewayAdapter: WebSocketGatewayAdapter | null = null

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

  modelCapabilityService = new ModelCapabilityService()
  agentService = new AgentService_v2(terminalService, commandPolicyService, mcpToolService, skillService, uiHistoryService)
  const gatewayService = new GatewayService(
    terminalService, 
    agentService, 
    uiHistoryService, 
    commandPolicyService, 
    settingsService,
    mcpToolService
  )
  gatewayService.registerTransport(new ElectronWindowTransport())
  const ipcAdapter = new ElectronGatewayIpcAdapter(
    gatewayService,
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
  ipcAdapter.registerHandlers()

  const shouldEnableWebSocketGateway = /^(1|true)$/i.test(process.env.GYSHELL_WS_ENABLE || '')
  if (shouldEnableWebSocketGateway) {
    const wsPort = Number(process.env.GYSHELL_WS_PORT || 17888)
    const wsHost = process.env.GYSHELL_WS_HOST || '127.0.0.1'
    const validPort = Number.isInteger(wsPort) && wsPort > 0 && wsPort < 65536
    if (!validPort) {
      console.error(`[Main] Invalid GYSHELL_WS_PORT: ${process.env.GYSHELL_WS_PORT}`)
    } else {
      try {
        webSocketGatewayAdapter = new WebSocketGatewayAdapter(gatewayService, {
          host: wsHost,
          port: wsPort,
          terminalBridge: {
            listTerminals: () =>
              terminalService.getAllTerminals().map((terminal) => ({
                id: terminal.id,
                title: terminal.title,
                type: terminal.type
              }))
          },
          profileBridge: {
            getProfiles: () => {
              const settingsSnapshot = settingsService.getSettings()
              const modelNameById = new Map(settingsSnapshot.models.items.map((model) => [model.id, model.model]))
              return {
                activeProfileId: settingsSnapshot.models.activeProfileId,
                profiles: settingsSnapshot.models.profiles.map((profile) => ({
                  id: profile.id,
                  name: profile.name,
                  globalModelId: profile.globalModelId,
                  modelName: modelNameById.get(profile.globalModelId)
                }))
              }
            },
            setActiveProfile: (profileId: string) => {
              const settingsSnapshot = settingsService.getSettings()
              const exists = settingsSnapshot.models.profiles.some((profile) => profile.id === profileId)
              if (!exists) {
                throw new Error(`Profile not found: ${profileId}`)
              }
              settingsService.setSettings({
                models: {
                  items: settingsSnapshot.models.items,
                  profiles: settingsSnapshot.models.profiles,
                  activeProfileId: profileId
                }
              })
              const nextSettings = settingsService.getSettings()
              agentService.updateSettings(nextSettings)

              const modelNameById = new Map(nextSettings.models.items.map((model) => [model.id, model.model]))
              return {
                activeProfileId: nextSettings.models.activeProfileId,
                profiles: nextSettings.models.profiles.map((profile) => ({
                  id: profile.id,
                  name: profile.name,
                  globalModelId: profile.globalModelId,
                  modelName: modelNameById.get(profile.globalModelId)
                }))
              }
            }
          }
        })
        webSocketGatewayAdapter.start()
      } catch (error) {
        console.error('[Main] Failed to start websocket gateway server:', error)
      }
    }
  }

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
  if (webSocketGatewayAdapter) {
    try {
      await webSocketGatewayAdapter.stop()
    } catch (error) {
      console.error('[Main] Failed to stop websocket gateway server:', error)
    } finally {
      webSocketGatewayAdapter = null
    }
  }
  if (tempFileService) {
    await tempFileService.cleanup()
  }
  app.quit()
})
