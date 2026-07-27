import {
  app,
  BrowserWindow,
  ipcMain,
  powerSaveBlocker,
  powerMonitor,
  screen,
  shell,
} from "electron";
import { join, resolve } from "path";
import { SettingsService } from "../../../backend/src/services/SettingsService";
import { UiSettingsStore } from "../settings/UiSettingsStore";
import { TerminalService } from "../../../backend/src/services/TerminalService";
import { FileSystemService } from "../../../backend/src/services/FileSystemService";
import { FileTransferService } from "../../../backend/src/services/FileTransferService";
import { AgentService_v2 } from "../../../backend/src/services/AgentService_v2";
import { CommandPolicyService } from "../../../backend/src/services/CommandPolicy/CommandPolicyService";
import { ModelCapabilityService } from "../../../backend/src/services/ModelCapabilityService";
import { McpToolService } from "../../../backend/src/services/McpToolService";
import { ThemeConfigStore } from "../theme/ThemeConfigStore";
import {
  applyPlatformWindowTweaks,
  getPlatformBrowserWindowOptions,
} from "./platform/windowChrome";
import { SkillService } from "../../../backend/src/services/SkillService";
import { MemoryService } from "../../../backend/src/services/MemoryService";
import { UIHistoryService } from "../../../backend/src/services/UIHistoryService";
import { ChatHistoryService } from "../../../backend/src/services/ChatHistoryService";
import { GatewayService } from "../../../backend/src/services/Gateway/GatewayService";
import { ElectronGatewayIpcAdapter } from "../gateway/ElectronGatewayIpcAdapter";
import { ElectronWindowTransport } from "../gateway/ElectronWindowTransport";
import { WebSocketGatewayAdapter } from "../../../backend/src/services/Gateway/WebSocketGatewayAdapter";
import {
  WebSocketGatewayControlService,
  resolveWsGatewayPolicyFromEnv,
} from "../../../backend/src/services/Gateway/WebSocketGatewayControlService";
import { ImageAttachmentService } from "../../../backend/src/services/ImageAttachmentService";
import { VersionService } from "../../../backend/src/services/VersionService";
import { AccessTokenService } from "../../../backend/src/services/AccessToken/AccessTokenService";
import { TerminalCommandDraftService } from "../../../backend/src/services/TerminalCommandDraftService";
import { ElectronAppSettingsMigration } from "../settings/ElectronAppSettingsMigration";
import { cleanupDeprecatedCliLaunchers } from "./DeprecatedCliCleanupService";
import {
  configurePackagedCliEnvironment,
  initializePackagedCliIntegration,
} from "./CliIntegrationService";
import {
  buildBuiltInToolStatusSummary,
} from "../../../backend/src/services/Gateway/toolingSummary";
import { TerminalStateStore } from "../../../backend/src/services/terminal/TerminalStateStore";
import { createAutoTerminalConfig } from "../../../backend/src/services/terminal/terminalConnectionSupport";
import { MobileWebServerService } from "../services/MobileWebServerService";
import { ResourceMonitorService } from "../../../backend/src/services/ResourceMonitorService";
import { MonitorWindowRegistry } from "./MonitorWindowRegistry";
import {
  DetachedWindowRegistry,
  type DetachedWindowTabOwnership,
  type DetachedWindowTabTarget,
} from "./DetachedWindowRegistry";
import {
  broadcastTerminalRecoveryHint,
  isDisplayMetricsRecoveryRelevant,
} from "./terminalRecovery";
import { HistoryMigrationCoordinator } from "./HistoryMigrationCoordinator";
import { HistorySqliteStore } from "../../../backend/src/services/history/HistorySqliteStore";
import { HistoryStorageMigration } from "../../../backend/src/services/history/HistoryStorageMigration";
import { SleepBlockerService } from "./SleepBlockerService";
import { AgentSettingProfileService } from "../../../backend/src/services/AgentSettingProfileService";
import {
  isExperimentalToolConfirmationRequired,
} from "../../../backend/src/services/settings/experimentalToolConsent";

let mainWindow: BrowserWindow | null = null;
let settingsService: SettingsService;
let uiSettingsStore: UiSettingsStore;
let terminalService: TerminalService;
let fileSystemService: FileSystemService;
let fileTransferService: FileTransferService;
let agentService: AgentService_v2;
let commandPolicyService: CommandPolicyService;
let modelCapabilityService: ModelCapabilityService;
let mcpToolService: McpToolService;
let themeStore: ThemeConfigStore;
let skillService: SkillService;
let memoryService: MemoryService;
let uiHistoryService: UIHistoryService;
let imageAttachmentService: ImageAttachmentService;
let versionService: VersionService;
let accessTokenService: AccessTokenService;
let terminalCommandDraftService: TerminalCommandDraftService;
let webSocketGatewayControlService: WebSocketGatewayControlService | null =
  null;
let mobileWebServerService: MobileWebServerService | null = null;
let resourceMonitorService: ResourceMonitorService;
let monitorWindowRegistry: MonitorWindowRegistry;
const detachedWindowRegistry = new DetachedWindowRegistry<BrowserWindow>();
let historyStore: HistorySqliteStore | null = null;
let sleepBlockerService: SleepBlockerService | null = null;
let agentSettingProfileService: AgentSettingProfileService;

type AppWindowRole = "main" | "detached";

interface CreateWindowOptions {
  role?: AppWindowRole;
  detachedStateToken?: string;
  sourceClientId?: string;
  tabOwnership?: DetachedWindowTabOwnership;
}

const DETACHED_WINDOW_DEFAULT_WIDTH_SCALE = 0.5;
const DETACHED_WINDOW_DEFAULT_HEIGHT_SCALE = 0.75;

function createWindow(options?: CreateWindowOptions): BrowserWindow {
  const role: AppWindowRole =
    options?.role === "detached" ? "detached" : "main";
  const isMainWindow = role === "main";
  const settings = settingsService.getSettings();
  const uiSettings = uiSettingsStore.getSettings();
  const savedWindow = isMainWindow ? settings.layout?.window : undefined;

  let width = isMainWindow ? 800 : 980;
  let height = isMainWindow ? 500 : 720;
  let x: number | undefined;
  let y: number | undefined;

  if (savedWindow) {
    width = savedWindow.width;
    height = savedWindow.height;
    x = savedWindow.x;
    y = savedWindow.y;
  } else {
    // Match WaveTerm-like default sizing: fill most of the work area, but capped.
    // (Wave uses: width/height = workArea - 200, caps 2000x1200, mins 800x500)
    const { width: workAreaW, height: workAreaH } =
      screen.getPrimaryDisplay().workAreaSize;
    if (isMainWindow) {
      width = Math.min(Math.max(workAreaW - 200, 800), 2000);
      height = Math.min(Math.max(workAreaH - 200, 500), 1200);
    } else {
      const defaultDetachedWidth = Math.min(
        Math.max(workAreaW - 280, 760),
        1800,
      );
      const defaultDetachedHeight = Math.min(
        Math.max(workAreaH - 220, 420),
        1200,
      );
      width = Math.max(
        Math.round(defaultDetachedWidth * DETACHED_WINDOW_DEFAULT_WIDTH_SCALE),
        520,
      );
      height = Math.max(
        Math.round(
          defaultDetachedHeight * DETACHED_WINDOW_DEFAULT_HEIGHT_SCALE,
        ),
        340,
      );
    }
  }

  const platformWindowOptions = getPlatformBrowserWindowOptions(
    uiSettings.themeId,
    themeStore.getCustomThemes(),
  );

  const windowInstance = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: isMainWindow ? 800 : 520,
    minHeight: isMainWindow ? 500 : 340,
    ...platformWindowOptions,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium's built-in PDF viewer is exposed as a plugin in Electron.
      plugins: true,
      // Prevent Electron from using the sandboxed renderer bundle in dev.
      // This avoids a known class of startup console errors where the sandbox bundle fails early.
      sandbox: false,
    },
  });
  if (isMainWindow) {
    mainWindow = windowInstance;
  } else {
    detachedWindowRegistry.register(
      windowInstance,
      options?.tabOwnership,
    );
  }

  const query = new URLSearchParams();
  if (!isMainWindow) {
    query.set("windowRole", "detached");
    if (
      typeof options?.detachedStateToken === "string" &&
      options.detachedStateToken.trim().length > 0
    ) {
      query.set("detachedStateToken", options.detachedStateToken.trim());
    }
    if (
      typeof options?.sourceClientId === "string" &&
      options.sourceClientId.trim().length > 0
    ) {
      query.set("sourceClientId", options.sourceClientId.trim());
    }
  }
  const queryString = query.toString();
  const urlSuffix = queryString.length > 0 ? `?${queryString}` : "";

  // Load the app
  if (!app.isPackaged) {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (!devUrl) {
      throw new Error(
        "Missing ELECTRON_RENDERER_URL (electron-vite dev server URL)",
      );
    }
    windowInstance.loadURL(`${devUrl}/index.html${urlSuffix}`);
    if (isMainWindow) {
      windowInstance.webContents.openDevTools();
    }
  } else {
    if (queryString.length > 0) {
      const queryPayload: Record<string, string> = {};
      query.forEach((value, key) => {
        queryPayload[key] = value;
      });
      windowInstance.loadFile(join(__dirname, "../renderer/index.html"), {
        query: queryPayload,
      });
    } else {
      windowInstance.loadFile(join(__dirname, "../renderer/index.html"));
    }
  }

  applyPlatformWindowTweaks(windowInstance);

  if (isMainWindow) {
    windowInstance.on("close", () => {
      // Detached workspaces are intentionally subordinate to the main workspace.
      // Closing the main window is treated as shutting down the whole app UI,
      // not as a request to preserve child windows independently or to retarget
      // their rollback routing to some future main renderer.
      const detachedWindows = BrowserWindow.getAllWindows().filter(
        (win) => win !== windowInstance && !win.isDestroyed(),
      );
      // Tell detached renderers this is a cascade shutdown so they skip
      // detached-closing rollback broadcasts back into the main workspace.
      detachedWindows.forEach((win) => {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send("windowing:detachedWindowCascadeClosing");
        }
      });
      detachedWindows.forEach((win) => {
        setTimeout(() => {
          if (win !== windowInstance && !win.isDestroyed()) {
            win.close();
          }
        }, 0);
      });
    });
  }

  windowInstance.on("closed", () => {
    if (isMainWindow) {
      mainWindow = null;
    } else {
      detachedWindowRegistry.unregister(windowInstance);
    }
  });

  // Open external links in the default browser
  windowInstance.webContents.setWindowOpenHandler(({ url }) => {
    // Only allow http/https protocols for safety
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  windowInstance.webContents.on("will-navigate", (event, url) => {
    // Check if the URL is different from the main window URL and is an external protocol
    if (
      url !== windowInstance.webContents.getURL() &&
      (url.startsWith("http:") || url.startsWith("https:"))
    ) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (!isMainWindow) {
    return windowInstance;
  }

  // Save window bounds on resize or move
  const saveBounds = () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    settingsService.setSettings({
      layout: {
        window: bounds,
      },
    });
  };
  windowInstance.on("resize", saveBounds);
  windowInstance.on("move", saveBounds);
  return windowInstance;
}

export async function startElectronMain(): Promise<void> {
  await app.whenReady();

  configurePackagedCliEnvironment();

  try {
    cleanupDeprecatedCliLaunchers();
  } catch (error) {
    console.warn("[Main] Failed to clean up deprecated gyll launchers:", error);
  }

  const projectRoot = resolve(__dirname, "../..");

  const userDataDir = app.getPath("userData");
  if (!(process.env.GYSHELL_STORE_DIR || "").trim()) {
    process.env.GYSHELL_STORE_DIR = userDataDir;
  }
  const historyMigrationCoordinator = new HistoryMigrationCoordinator();
  historyMigrationCoordinator.registerHandlers();

  // Run Electron-only data migrations before services consume persisted state.
  const settingsMigration = new ElectronAppSettingsMigration();
  settingsMigration.run();

  settingsService = new SettingsService();
  uiSettingsStore = new UiSettingsStore();
  themeStore = new ThemeConfigStore();
  await themeStore.loadCustomThemes();
  const primaryWindow = createWindow();
  void initializePackagedCliIntegration(primaryWindow).catch((error) => {
    console.warn("[Main] Failed to initialize gyll integration:", error);
  });

  const startRuntimeInitialization = () => {
    historyMigrationCoordinator.run(async () => {
      try {
        const historyMigration = new HistoryStorageMigration({
          baseDir: userDataDir,
          onStateChange: (state) =>
            historyMigrationCoordinator.updateProgressState(state),
        });
        await historyMigration.run();
        const terminalStateStore = new TerminalStateStore(
          join(userDataDir, "terminal-tabs-state.json"),
        );
        terminalService = new TerminalService({
          terminalStateStore,
        });
        fileSystemService = new FileSystemService(terminalService);
        fileTransferService = new FileTransferService(
          fileSystemService,
          terminalService,
        );
        resourceMonitorService = new ResourceMonitorService(terminalService);
        commandPolicyService = new CommandPolicyService();
        mcpToolService = new McpToolService();
        historyStore = new HistorySqliteStore();
        uiHistoryService = new UIHistoryService({ store: historyStore });
        imageAttachmentService = new ImageAttachmentService(userDataDir);
        versionService = new VersionService();
        accessTokenService = new AccessTokenService();
        terminalCommandDraftService = new TerminalCommandDraftService(
          terminalService,
          settingsService,
        );

        skillService = new SkillService(settingsService);
        memoryService = new MemoryService();
        void memoryService.ensureMemoryFile();
        agentSettingProfileService = new AgentSettingProfileService({
          settingsService,
          commandPolicyService,
          mcpToolService,
          skillService,
          memoryService,
          onSettingsChanged: (settings) =>
            agentService.updateSettings(settings),
          onActiveProfileSnapshotChanged: (settings) =>
            gatewayService.broadcastRaw("settings:updated", settings),
        });

        modelCapabilityService = new ModelCapabilityService();
        const chatHistoryService = new ChatHistoryService({
          store: historyStore,
        });
        agentService = new AgentService_v2(
          terminalService,
          commandPolicyService,
          mcpToolService,
          skillService,
          memoryService,
          uiHistoryService,
          chatHistoryService,
          imageAttachmentService,
          fileTransferService,
        );
        const gatewayService = new GatewayService(
          terminalService,
          agentService,
          uiHistoryService,
          commandPolicyService,
          settingsService,
          mcpToolService,
        );
        fileTransferService.setRawEventPublisher((channel, data) =>
          gatewayService.broadcastRaw(channel, data),
        );
        sleepBlockerService = new SleepBlockerService(powerSaveBlocker);
        const syncSleepBlockerSetting = (
          settings = uiSettingsStore.getSettings(),
        ) => {
          sleepBlockerService?.setEnabled(
            settings.runtime?.preventSleepWhileRunning !== false,
          );
        };
        syncSleepBlockerSetting();
        const unsubscribeSleepBlockerSettings = uiSettingsStore.onChange(
          syncSleepBlockerSetting,
        );
        const unsubscribeRunState = gatewayService.onRunStateChanged(
          (snapshot) => {
            sleepBlockerService?.setReasonActive(
              "agent-running",
              snapshot.activeCount > 0,
            );
          },
        );
        app.once("before-quit", () => {
          unsubscribeRunState();
          unsubscribeSleepBlockerSettings();
          sleepBlockerService?.dispose();
          sleepBlockerService = null;
        });
        const terminalRestoreResult =
          await terminalService.restorePersistedTerminals();
        if (
          terminalRestoreResult.restored.length > 0 ||
          terminalRestoreResult.failed.length > 0
        ) {
          console.log(
            `[Main] Terminal restore completed. restored=${terminalRestoreResult.restored.length} failed=${terminalRestoreResult.failed.length}`,
          );
          if (terminalRestoreResult.failed.length > 0) {
            terminalRestoreResult.failed.forEach((item) => {
              console.warn(
                `[Main] Terminal restore failed for ${item.id}: ${item.reason}`,
              );
            });
          }
        }
        gatewayService.registerTransport(new ElectronWindowTransport());
        const broadcastAgentSettingResult = (result: {
          settings: unknown;
          commandPolicyLists: unknown;
          mcpTools: unknown;
          builtInTools: unknown;
          skills: unknown;
          memory: unknown;
        }) => {
          gatewayService.broadcastRaw("settings:updated", result.settings);
          gatewayService.broadcastRaw(
            "settings:commandPolicyListsUpdated",
            result.commandPolicyLists,
          );
          gatewayService.broadcastRaw("tools:mcpUpdated", result.mcpTools);
          gatewayService.broadcastRaw(
            "tools:builtInUpdated",
            result.builtInTools,
          );
          gatewayService.broadcastRaw("skills:updated", result.skills);
          gatewayService.broadcastRaw("memory:updated", result.memory);
        };
        webSocketGatewayControlService = new WebSocketGatewayControlService({
          createAdapter: (host, port, ipFilter) =>
            new WebSocketGatewayAdapter(gatewayService, {
              host,
              port,
              accessTokenAuth: {
                verifyToken: (token: string) =>
                  accessTokenService.verifyToken(token),
                allowLocalhostWithoutToken: true,
              },
              ipFilter,
              terminalBridge: {
                listTerminals: () =>
                  terminalService.getDisplayTerminals().map((terminal) => ({
                    id: terminal.id,
                    title: terminal.title,
                    type: terminal.type,
                    cols: terminal.cols,
                    rows: terminal.rows,
                    runtimeState: terminal.runtimeState,
                    lastExitCode: terminal.lastExitCode,
                  })),
                createTab: async (config) => {
                  const snapshot = terminalService.getDisplayTerminals();
                  const normalized = createAutoTerminalConfig(snapshot, config);
                  const tab = await terminalService.createTerminal(
                    normalized as any,
                  );
                  return { id: tab.id };
                },
                write: async (terminalId, data) => {
                  terminalService.write(terminalId, data);
                },
                writePaths: async (terminalId, paths) => {
                  terminalService.writePaths(terminalId, paths);
                },
                resize: async (terminalId, cols, rows) => {
                  terminalService.resize(terminalId, cols, rows);
                },
                kill: async (terminalId) => {
                  if (terminalService.getDisplayTerminals().length <= 1) {
                    throw new Error("Cannot close the last terminal tab.");
                  }
                  terminalService.kill(terminalId);
                },
                reconnect: async (terminalId) => {
                  const tab =
                    await terminalService.reconnectTerminal(terminalId);
                  return { id: tab.id };
                },
                setSelection: async (terminalId, selectionText) => {
                  terminalService.setSelection(terminalId, selectionText);
                },
                getBufferDelta: async (terminalId, fromOffset) => {
                  const data = terminalService.getBufferDelta(
                    terminalId,
                    fromOffset,
                  );
                  const offset = terminalService.getCurrentOffset(terminalId);
                  return {
                    data,
                    offset,
                    ...terminalService.getRenderMetadata(terminalId),
                  };
                },
                generateCommandDraft: async (terminalId, prompt, profileId) => {
                  return await terminalCommandDraftService.generateCommandDraft(
                    {
                      terminalId,
                      prompt,
                      profileId,
                    },
                  );
                },
              },
              filesystemBridge: {
                listDirectory: async (terminalId, dirPath) => {
                  return await fileSystemService.listDirectory(
                    terminalId,
                    dirPath,
                  );
                },
                readTextFile: async (terminalId, filePath, options) => {
                  return await fileSystemService.readTextFile(
                    terminalId,
                    filePath,
                    options,
                  );
                },
                readFileBase64: async (terminalId, filePath, options) => {
                  return await fileSystemService.readFileBase64(
                    terminalId,
                    filePath,
                    options,
                  );
                },
                writeTextFile: async (terminalId, filePath, content) => {
                  await fileSystemService.writeTextFile(
                    terminalId,
                    filePath,
                    content,
                  );
                },
                writeFileBase64: async (
                  terminalId,
                  filePath,
                  contentBase64,
                  options,
                ) => {
                  await fileSystemService.writeFileBase64(
                    terminalId,
                    filePath,
                    contentBase64,
                    options,
                  );
                },
                transferEntries: async (
                  sourceTerminalId,
                  sourcePaths,
                  targetTerminalId,
                  targetDirPath,
                  options,
                ) => {
                  return await fileSystemService.transferEntries(
                    sourceTerminalId,
                    sourcePaths,
                    targetTerminalId,
                    targetDirPath,
                    options,
                  );
                },
                startTransfer: async (input) => {
                  return fileTransferService.startTransfer(input);
                },
                getTransfer: async (transferId) => {
                  return fileTransferService.getTransfer(transferId);
                },
                listTransfers: async (options) => {
                  return fileTransferService.listTransfers(options);
                },
                cancelTransfer: async (transferId) => {
                  return fileTransferService.cancelTransfer(transferId);
                },
                cancelTransferTask: async (transferId) => {
                  return fileTransferService.cancelTransfer(transferId);
                },
                createDirectory: async (terminalId, dirPath) => {
                  await fileSystemService.createDirectory(terminalId, dirPath);
                },
                createFile: async (terminalId, filePath) => {
                  await fileSystemService.createFile(terminalId, filePath);
                },
                deletePath: async (terminalId, targetPath, options) => {
                  await fileSystemService.deletePath(
                    terminalId,
                    targetPath,
                    options,
                  );
                },
                renamePath: async (terminalId, sourcePath, targetPath) => {
                  await fileSystemService.renamePath(
                    terminalId,
                    sourcePath,
                    targetPath,
                  );
                },
              },
              profileBridge: {
                getProfiles: () => {
                  const settingsSnapshot = settingsService.getSettings();
                  const modelNameById = new Map(
                    settingsSnapshot.models.items.map((model) => [
                      model.id,
                      model.model,
                    ]),
                  );
                  return {
                    activeProfileId: settingsSnapshot.models.activeProfileId,
                    profiles: settingsSnapshot.models.profiles.map(
                      (profile) => ({
                        id: profile.id,
                        name: profile.name,
                        globalModelId: profile.globalModelId,
                        modelName: modelNameById.get(profile.globalModelId),
                      }),
                    ),
                  };
                },
                setActiveProfile: async (profileId: string) => {
                  const settingsSnapshot = settingsService.getSettings();
                  const exists = settingsSnapshot.models.profiles.some(
                    (profile) => profile.id === profileId,
                  );
                  if (!exists) {
                    throw new Error(`Profile not found: ${profileId}`);
                  }
                  await agentSettingProfileService.applySettingsPatch({
                    models: {
                      items: settingsSnapshot.models.items,
                      profiles: settingsSnapshot.models.profiles,
                      activeProfileId: profileId,
                    },
                  });
                  const nextSettings = settingsService.getSettings();

                  const modelNameById = new Map(
                    nextSettings.models.items.map((model) => [
                      model.id,
                      model.model,
                    ]),
                  );
                  return {
                    activeProfileId: nextSettings.models.activeProfileId,
                    profiles: nextSettings.models.profiles.map((profile) => ({
                      id: profile.id,
                      name: profile.name,
                      globalModelId: profile.globalModelId,
                      modelName: modelNameById.get(profile.globalModelId),
                    })),
                  };
                },
                probeModel: async (model: any) => {
                  return await modelCapabilityService.probe(model);
                },
              },
              agentBridge: {
                exportHistory: async (sessionId, mode) => {
                  await gatewayService.waitForRunCompletion(sessionId);
                  const backendSession =
                    agentService.exportChatSession(sessionId);
                  if (!backendSession) {
                    throw new Error(`Session with ID ${sessionId} not found`);
                  }
                  const uiSession = uiHistoryService.getSession(sessionId);
                  if (mode === "simple") {
                    const markdown = uiHistoryService.toReadableMarkdown(
                      uiSession?.messages || [],
                      uiSession?.title || backendSession.title,
                    );
                    return {
                      sessionId,
                      mode,
                      title: uiSession?.title || backendSession.title,
                      content: markdown,
                    };
                  }
                  return {
                    sessionId: backendSession.id,
                    mode,
                    title: uiSession?.title || backendSession.title,
                    lastCheckpointOffset: backendSession.lastCheckpointOffset,
                    createdAt: new Date(backendSession.createdAt).toISOString(),
                    updatedAt: new Date(backendSession.updatedAt).toISOString(),
                    frontendMessages: uiSession?.messages || [],
                    backendMessages: backendSession.messages.map(
                      (msg: any) => ({
                        messageId: msg.id,
                        messageType: msg.type,
                        messageData: msg.data,
                      }),
                    ),
                  };
                },
                getAllChatHistory: () => agentService.getAllChatHistory(),
                loadChatSession: (sessionId) =>
                  agentService.loadChatSession(sessionId),
                getUiMessages: (sessionId) =>
                  uiHistoryService.getMessages(sessionId),
              },
              systemBridge: {
                saveImageAttachment: async (payload: {
                  dataBase64: string;
                  fileName?: string;
                  mimeType?: string;
                  previewDataUrl?: string;
                }) => {
                  return await imageAttachmentService.saveImageAttachment(
                    payload,
                  );
                },
              },
              skillBridge: {
                reload: async () => {
                  return await agentSettingProfileService.reloadSkills();
                },
                getAll: async () => {
                  return await skillService.getAll();
                },
                getEnabled: async () => {
                  return await skillService.getEnabledSkills();
                },
                create: async () => {
                  return await agentSettingProfileService.createSkillFromTemplate();
                },
                delete: async (fileName: string) => {
                  return await agentSettingProfileService.deleteSkillFile(
                    fileName,
                  );
                },
                listSkills: async () => {
                  const settingsSnapshot = settingsService.getSettings();
                  const enabledMap = settingsSnapshot.tools?.skills ?? {};
                  const skills = await skillService.getAll();
                  return skills.map((skill) => ({
                    name: skill.name,
                    description: skill.description,
                    enabled: enabledMap[skill.name] !== false,
                  }));
                },
                setSkillEnabled: async (name: string, enabled: boolean) => {
                  const summary =
                    await agentSettingProfileService.setSkillEnabled(
                      name,
                      enabled,
                    );
                  gatewayService.broadcastRaw("skills:updated", summary);
                  return summary;
                },
              },
              memoryBridge: {
                get: async () => {
                  return await memoryService.getMemorySnapshot(
                    settingsService.getSettings().agentSettings
                      ?.activeProfileId || null,
                  );
                },
                setContent: async (content: string) => {
                  const snapshot = await memoryService.writeMemory(
                    content,
                    settingsService.getSettings().agentSettings
                      ?.activeProfileId || null,
                  );
                  gatewayService.broadcastRaw("memory:updated", snapshot);
                  return snapshot;
                },
              },
              agentSettingsBridge: {
                get: () => agentSettingProfileService.getState(),
                saveCurrent: async () => {
                  const result = await agentSettingProfileService.saveCurrent();
                  broadcastAgentSettingResult(result);
                  return result;
                },
                apply: async (
                  profileId: string,
                  acknowledgedExperimentalToolNames: string[],
                ) => {
                  const result =
                    await agentSettingProfileService.apply(
                      profileId,
                      acknowledgedExperimentalToolNames,
                    );
                  if (!isExperimentalToolConfirmationRequired(result)) {
                    broadcastAgentSettingResult(result);
                  }
                  return result;
                },
                overwrite: async (profileId: string) => {
                  const result =
                    await agentSettingProfileService.overwrite(profileId);
                  broadcastAgentSettingResult(result);
                  return result;
                },
                delete: async (profileId: string) => {
                  const result =
                    await agentSettingProfileService.delete(profileId);
                  broadcastAgentSettingResult(result);
                  return result;
                },
              },
              settingsBridge: {
                getSettings: () => settingsService.getSettings(),
                setSettings: async (patch) => {
                  if ((patch as any)?.gateway?.ws) {
                    throw new Error(
                      "settings.gateway.ws is not configurable via websocket RPC.",
                    );
                  }
                  const next =
                    await agentSettingProfileService.applySettingsPatch(
                      patch as any,
                    );
                  return next;
                },
              },
              commandPolicyBridge: {
                getLists: async () => {
                  return await commandPolicyService.getLists();
                },
                addRule: async (listName, rule) => {
                  return await agentSettingProfileService.addCommandPolicyRule(
                    listName,
                    rule,
                  );
                },
                deleteRule: async (listName, rule) => {
                  return await agentSettingProfileService.deleteCommandPolicyRule(
                    listName,
                    rule,
                  );
                },
              },
              toolsBridge: {
                reloadMcp: async () => {
                  return await agentSettingProfileService.reloadMcpTools();
                },
                getMcp: () => mcpToolService.getSummaries(),
                setMcpEnabled: async (name, enabled) => {
                  return await agentSettingProfileService.setMcpToolEnabled(
                    name,
                    enabled,
                  );
                },
                getBuiltIn: () => {
                  const settings = settingsService.getSettings();
                  return buildBuiltInToolStatusSummary(settings.tools?.builtIn);
                },
                setBuiltInEnabled: async (
                  name,
                  enabled,
                  acknowledgedExperimentalToolNames,
                ) => {
                  const result =
                    await agentSettingProfileService.setBuiltInToolEnabled(
                      name,
                      enabled,
                      acknowledgedExperimentalToolNames,
                    );
                  if (!isExperimentalToolConfirmationRequired(result)) {
                    gatewayService.broadcastRaw(
                      "tools:builtInUpdated",
                      result,
                    );
                  }
                  return result;
                },
              },
            }),
        });
        // Initialize mobile web server
        // Packaged: bundled into app resources via electron-builder extraResources
        // Dev: point directly to the mobile-web build output (no copy needed)
        const mobileWebRuntimePath = app.isPackaged
          ? join(process.resourcesPath, "mobile-web")
          : join(projectRoot, "apps", "mobile-web", "dist");
        mobileWebServerService = new MobileWebServerService(
          mobileWebRuntimePath,
          () => {
            const gatewayState = webSocketGatewayControlService?.getState();
            if (!gatewayState?.running) {
              return null;
            }
            return {
              port: gatewayState.port,
            };
          },
        );

        const ipcAdapter = new ElectronGatewayIpcAdapter(
          gatewayService,
          terminalService,
          terminalCommandDraftService,
          agentService,
          uiHistoryService,
          commandPolicyService,
          imageAttachmentService,
          skillService,
          memoryService,
          settingsService,
          uiSettingsStore,
          modelCapabilityService,
          mcpToolService,
          themeStore,
          versionService,
          webSocketGatewayControlService,
          agentSettingProfileService,
          accessTokenService,
          fileSystemService,
          fileTransferService,
          mobileWebServerService,
        );
        ipcAdapter.registerHandlers();

        // Resource monitor IPC handlers
        monitorWindowRegistry = new MonitorWindowRegistry(
          resourceMonitorService,
        );
        resourceMonitorService.setPublisher((channel, data) => {
          monitorWindowRegistry.publish(channel, data);
        });

        ipcMain.handle(
          "monitor:start",
          async (event: any, terminalId: string, intervalMs?: number) => {
            monitorWindowRegistry.retain(event.sender, terminalId, intervalMs);
            return { ok: true };
          },
        );

        ipcMain.handle(
          "monitor:stop",
          async (event: any, terminalId: string) => {
            monitorWindowRegistry.release(event.sender, terminalId);
            return { ok: true };
          },
        );

        ipcMain.handle(
          "monitor:subscribe",
          async (event: any, terminalId: string) => {
            monitorWindowRegistry.subscribe(event.sender, terminalId);
            return { ok: true };
          },
        );

        ipcMain.handle(
          "monitor:unsubscribe",
          async (event: any, terminalId: string) => {
            monitorWindowRegistry.unsubscribe(event.sender, terminalId);
            return { ok: true };
          },
        );

        ipcMain.handle(
          "monitor:snapshot",
          async (_: any, terminalId: string) => {
            return await resourceMonitorService.collectSnapshot(terminalId);
          },
        );

        ipcMain.handle(
          "monitor:isMonitoring",
          async (_: any, terminalId: string) => {
            return {
              monitoring: resourceMonitorService.isMonitoring(terminalId),
            };
          },
        );

        // Window controls — used by the Linux custom title bar in TopBar
        ipcMain.handle("window:minimize", (event: any) => {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win && !win.isDestroyed()) win.minimize();
        });

        ipcMain.handle("window:maximize", (event: any) => {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win && !win.isDestroyed()) {
            if (win.isMaximized()) win.unmaximize();
            else win.maximize();
          }
        });

        ipcMain.handle("window:close", (event: any) => {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win && !win.isDestroyed()) win.close();
        });

        ipcMain.handle(
          "windowing:openDetached",
          async (
            event: any,
            detachedStateToken: string,
            sourceClientId: string,
            options?: {
              tabOwnership?: DetachedWindowTabOwnership;
              focusTarget?: DetachedWindowTabTarget;
            },
          ) => {
            const token = String(detachedStateToken || "").trim();
            if (!token) {
              throw new Error("Missing detached state token.");
            }
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            if (!senderWindow || senderWindow.isDestroyed()) {
              throw new Error("Failed to resolve source window.");
            }
            const focusTarget = options?.focusTarget
              ? {
                  kind: options.focusTarget.kind,
                  tabId: String(options.focusTarget.tabId || "").trim(),
                }
              : null;
            if (focusTarget?.tabId) {
              const existingWindow =
                detachedWindowRegistry.focusWindowHostingTab(
                  focusTarget,
                );
              if (existingWindow) {
                if (!existingWindow.webContents.isDestroyed()) {
                  existingWindow.webContents.send(
                    "windowing:activateTab",
                    focusTarget,
                  );
                }
                return { ok: true, reused: true };
              }
            }
            createWindow({
              role: "detached",
              detachedStateToken: token,
              sourceClientId: String(sourceClientId || "").trim(),
              tabOwnership: options?.tabOwnership,
            });
            return { ok: true, reused: false };
          },
        );

        ipcMain.handle(
          "windowing:updateTabOwnership",
          async (
            event: any,
            ownership?: DetachedWindowTabOwnership,
          ) => {
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            if (!senderWindow || senderWindow.isDestroyed()) {
              throw new Error("Failed to resolve source window.");
            }
            return {
              ok: true,
              registered: detachedWindowRegistry.updateOwnership(
                senderWindow,
                ownership,
              ),
            };
          },
        );

        ipcMain.handle(
          "windowing:closeDetachedWindows",
          async (event: any) => {
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            if (
              !senderWindow ||
              senderWindow.isDestroyed() ||
              senderWindow !== mainWindow
            ) {
              throw new Error(
                "Only the main window can close detached workspaces.",
              );
            }

            const detachedWindows = detachedWindowRegistry.getWindows();
            const tabsByKind = detachedWindowRegistry.collectOwnership();
            detachedWindows.forEach((window) => {
              if (!window.webContents.isDestroyed()) {
                window.webContents.send(
                  "windowing:detachedWindowCascadeClosing",
                );
              }
            });
            await Promise.all(
              detachedWindows.map(
                (window) =>
                  new Promise<void>((resolveClose) => {
                    if (window.isDestroyed()) {
                      resolveClose();
                      return;
                    }
                    let settled = false;
                    const finish = () => {
                      if (settled) return;
                      settled = true;
                      clearTimeout(timeout);
                      resolveClose();
                    };
                    const timeout = setTimeout(finish, 1500);
                    window.once("closed", finish);
                    setTimeout(() => {
                      if (!window.isDestroyed()) {
                        window.close();
                      }
                    }, 0);
                }),
              ),
            );
            const remainingDetachedWindows =
              detachedWindowRegistry.getWindows();
            return {
              ok: remainingDetachedWindows.length === 0,
              closed:
                detachedWindows.length - remainingDetachedWindows.length,
              tabsByKind,
            };
          },
        );

        const settingsSnapshot = settingsService.getSettings();
        const startupPolicy = resolveWsGatewayPolicyFromEnv({
          env: process.env,
          defaultPolicy: {
            access: settingsSnapshot.gateway.ws.access,
            port: settingsSnapshot.gateway.ws.port,
            allowedCidrs: settingsSnapshot.gateway.ws.allowedCidrs,
          },
          enableVarName: "GYSHELL_WS_ENABLE",
          hostVarName: "GYSHELL_WS_HOST",
          portVarName: "GYSHELL_WS_PORT",
        });
        try {
          await webSocketGatewayControlService.applyPolicy(startupPolicy);
        } catch (error) {
          console.error(
            "[Main] Failed to apply websocket gateway startup policy:",
            error,
          );
        }

        // Load skills and MCP tools (best-effort)
        void agentSettingProfileService.reloadSkills().catch((error) => {
          console.warn("[Main] Failed to reload skills:", error);
        });
        void agentSettingProfileService.reloadMcpTools().catch((error) => {
          console.warn("[Main] Failed to reload MCP tools:", error);
        });

        // Update agent with current settings
        const settings = settingsService.getSettings();
        agentService.updateSettings(settings);

        historyMigrationCoordinator.markReady();
      } catch (error) {
        if (historyMigrationCoordinator.getState().status !== "error") {
          historyMigrationCoordinator.markError(error, {
            title: "Application startup failed",
            message: historyMigrationCoordinator.getState().detectedLegacy
              ? "Conversation history migration finished, but GyShell could not finish startup."
              : "GyShell could not finish startup after preparing history storage.",
          });
        }
        console.error("[Main] Failed to finish Electron startup:", error);
      }
    });
  };

  if (primaryWindow.webContents.isLoadingMainFrame()) {
    primaryWindow.webContents.once("did-finish-load", () => {
      startRuntimeInitialization();
    });
    primaryWindow.webContents.once("did-fail-load", () => {
      startRuntimeInitialization();
    });
  } else {
    startRuntimeInitialization();
  }

  const broadcastRecoveryHint = (
    reason: "resume" | "unlock-screen" | "display-metrics-changed",
  ) => {
    broadcastTerminalRecoveryHint(BrowserWindow.getAllWindows(), reason);
  };

  powerMonitor.on("resume", () => {
    broadcastRecoveryHint("resume");
  });

  powerMonitor.on("unlock-screen", () => {
    broadcastRecoveryHint("unlock-screen");
  });

  screen.on("display-metrics-changed", (_event, _display, changedMetrics) => {
    if (!isDisplayMetricsRecoveryRelevant(changedMetrics)) {
      return;
    }
    broadcastRecoveryHint("display-metrics-changed");
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.on("window-all-closed", async () => {
  if (terminalService) {
    terminalService.flushPersistedState();
  }
  if (uiHistoryService) {
    try {
      uiHistoryService.flush();
    } catch (error) {
      console.error("[Main] Failed to flush UI history state:", error);
    }
  }
  if (historyStore) {
    try {
      historyStore.close();
    } catch (error) {
      console.error("[Main] Failed to close history store:", error);
    } finally {
      historyStore = null;
    }
  }
  if (webSocketGatewayControlService) {
    try {
      await webSocketGatewayControlService.stop();
    } catch (error) {
      console.error("[Main] Failed to stop websocket gateway server:", error);
    } finally {
      webSocketGatewayControlService = null;
    }
  }
  if (mobileWebServerService) {
    try {
      await mobileWebServerService.stop();
    } catch (error) {
      console.error("[Main] Failed to stop mobile web server:", error);
    } finally {
      mobileWebServerService = null;
    }
  }
  app.quit();
});
