import {
  ipcMain,
  shell,
  Menu,
  BrowserWindow,
  app,
  nativeImage,
} from "electron";
import type { IpcMainInvokeEvent, NativeImage } from "electron";
import type {
  StartTaskOptions,
  StartTaskInput,
  IGatewayRuntime,
} from "../../../backend/src/services/Gateway/types";
import type { TerminalService } from "../../../backend/src/services/TerminalService";
import {
  FileSystemService,
  FILESYSTEM_TRANSFER_CANCELLED_CODE,
  isFileSystemTransferCancelledError,
} from "../../../backend/src/services/FileSystemService";
import type { FileTransferService } from "../../../backend/src/services/FileTransferService";
import type { AgentService_v2 } from "../../../backend/src/services/AgentService_v2";
import type {
  UIHistoryService,
  HistoryExportMode,
} from "../../../backend/src/services/UIHistoryService";
import type { CommandPolicyService } from "../../../backend/src/services/CommandPolicy/CommandPolicyService";
import type { ImageAttachmentService } from "../../../backend/src/services/ImageAttachmentService";
import type { SkillService } from "../../../backend/src/services/SkillService";
import type { MemoryService } from "../../../backend/src/services/MemoryService";
import type { SettingsService } from "../../../backend/src/services/SettingsService";
import type { ModelCapabilityService } from "../../../backend/src/services/ModelCapabilityService";
import type { McpToolService } from "../../../backend/src/services/McpToolService";
import type { VersionService } from "../../../backend/src/services/VersionService";
import type { TerminalCommandDraftService } from "../../../backend/src/services/TerminalCommandDraftService";
import type { AgentSettingProfileService } from "../../../backend/src/services/AgentSettingProfileService";
import type { WsGatewayAccess } from "../../../backend/src/types";
import {
  buildBuiltInToolStatusSummary,
  buildSkillStatusSummary,
} from "../../../backend/src/services/Gateway/toolingSummary";
import { resolveTheme } from "../../../shared/src/theme/themes";
import type { WebSocketGatewayControlService } from "../../../backend/src/services/Gateway/WebSocketGatewayControlService";
import type { UiSettingsStore } from "../settings/UiSettingsStore";
import type { ThemeConfigStore } from "../theme/ThemeConfigStore";
import { normalizeSyncSettingsPatch } from "./settingsSyncPatch";

type AccessTokenRuntime = {
  listTokens: () => Promise<
    Array<{ id: string; name: string; createdAt: number }>
  >;
  createToken: (
    name: string,
  ) => Promise<{ id: string; name: string; createdAt: number; token: string }>;
  deleteToken: (id: string) => Promise<boolean>;
};

const FALLBACK_DRAG_ICON_SIZE = 32;

/**
 * macOS requires `webContents.startDrag` to receive a non-empty icon. We prefer the
 * real OS file icon (via `app.getFileIcon`), and fall back to a neutral square so the
 * drag never throws when the icon cannot be resolved.
 */
const createFallbackDragIcon = (): NativeImage => {
  const side = FALLBACK_DRAG_ICON_SIZE;
  const bitmap = Buffer.alloc(side * side * 4);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = 0x8a; // B
    bitmap[offset + 1] = 0x8a; // G
    bitmap[offset + 2] = 0x8a; // R
    bitmap[offset + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(bitmap, { width: side, height: side });
};

const resolveDragIcon = async (filePath: string): Promise<NativeImage> => {
  try {
    const icon = await app.getFileIcon(filePath, { size: "normal" });
    if (icon && !icon.isEmpty()) return icon;
  } catch {
    // fall through to the neutral fallback icon below
  }
  return createFallbackDragIcon();
};

export class ElectronGatewayIpcAdapter {
  private registeredSessionOwnerWebContentsIds = new Set<number>();

  constructor(
    private gateway: IGatewayRuntime,
    private terminalService: TerminalService,
    private terminalCommandDraftService: TerminalCommandDraftService,
    private agentService: AgentService_v2,
    private uiHistoryService: UIHistoryService,
    private commandPolicyService: CommandPolicyService,
    private imageAttachmentService: ImageAttachmentService,
    private skillService: SkillService,
    private memoryService: MemoryService,
    private settingsService: SettingsService,
    private uiSettingsStore: UiSettingsStore,
    private modelCapabilityService: ModelCapabilityService,
    private mcpToolService: McpToolService,
    private themeStore: ThemeConfigStore,
    private versionService: VersionService,
    private wsGatewayControlService: WebSocketGatewayControlService,
    private agentSettingProfileService: AgentSettingProfileService,
    private accessTokenService: AccessTokenRuntime = {
      listTokens: async () => [],
      createToken: async () => {
        throw new Error("Access token service is not configured.");
      },
      deleteToken: async () => false,
    },
    private fileSystemService?: FileSystemService,
    private fileTransferService?: FileTransferService,
    private mobileWebServerService?: import("../services/MobileWebServerService").MobileWebServerService,
  ) {}

  private getRendererSessionOwner(event: IpcMainInvokeEvent): string {
    const webContentsId = event.sender.id;
    const ownerId = `electron-webcontents:${webContentsId}`;
    if (this.registeredSessionOwnerWebContentsIds.has(webContentsId)) {
      return ownerId;
    }

    this.registeredSessionOwnerWebContentsIds.add(webContentsId);
    const releaseOwner = () => {
      this.gateway.unregisterSessionOwner(ownerId);
    };
    event.sender.on("did-navigate", releaseOwner);
    event.sender.on("render-process-gone", releaseOwner);
    event.sender.once("destroyed", () => {
      this.registeredSessionOwnerWebContentsIds.delete(webContentsId);
      releaseOwner();
    });
    return ownerId;
  }

  private updateWindowsThemeIfNeeded(): void {
    if (process.platform !== "win32") return;
    const uiSettings = this.uiSettingsStore.getSettings();
    const theme = resolveTheme(
      uiSettings.themeId,
      this.themeStore.getCustomThemes(),
    );
    const bg = theme.terminal.background;
    const fg = theme.terminal.foreground;
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (typeof win.setTitleBarOverlay === "function") {
        win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 38 });
        win.setBackgroundColor(bg);
      }
    });
  }

  private getActiveAgentSettingProfileId(): string | null {
    return (
      this.settingsService.getSettings().agentSettings?.activeProfileId || null
    );
  }

  private broadcastAgentSettingResult(result: {
    settings: unknown;
    commandPolicyLists: unknown;
    mcpTools: unknown;
    builtInTools: unknown;
    skills: unknown;
    memory: unknown;
  }): void {
    this.agentService.updateSettings(this.settingsService.getSettings());
    this.gateway.broadcastRaw("settings:updated", result.settings);
    this.gateway.broadcastRaw(
      "settings:commandPolicyListsUpdated",
      result.commandPolicyLists,
    );
    this.gateway.broadcastRaw("tools:mcpUpdated", result.mcpTools);
    this.gateway.broadcastRaw("tools:builtInUpdated", result.builtInTools);
    this.gateway.broadcastRaw("skills:updated", result.skills);
    this.gateway.broadcastRaw("memory:updated", result.memory);
  }

  registerHandlers(): void {
    // Agent runtime
    ipcMain.handle(
      "agent:registerSession",
      async (event: IpcMainInvokeEvent, sessionId: string) => {
        this.gateway.registerSession(
          sessionId,
          this.getRendererSessionOwner(event),
        );
      },
    );

    ipcMain.handle(
      "agent:unregisterSession",
      async (event: IpcMainInvokeEvent, sessionId: string) => {
        this.gateway.unregisterSession(
          sessionId,
          this.getRendererSessionOwner(event),
        );
      },
    );

    ipcMain.handle(
      "agent:startTask",
      async (
        _: any,
        sessionId: string,
        userInput: StartTaskInput,
        options?: StartTaskOptions,
      ) => {
        return this.gateway.dispatchTask(sessionId, userInput, options);
      },
    );

    ipcMain.handle("agent:stopTask", async (_: any, sessionId: string) => {
      return this.gateway.stopTask(sessionId);
    });

    ipcMain.handle(
      "agent:replyMessage",
      async (_: any, messageId: string, payload: any) => {
        console.log(
          `[ElectronGatewayIpcAdapter] Received replyMessage for messageId=${messageId}:`,
          payload,
        );
        return this.gateway.submitFeedback(messageId, payload);
      },
    );

    ipcMain.handle(
      "agent:replyCommandApproval",
      async (_: any, approvalId: string, decision: "allow" | "deny") => {
        return this.gateway.submitFeedback(approvalId, { decision });
      },
    );

    ipcMain.handle(
      "agent:deleteChatSession",
      async (_: any, sessionId: string) => {
        await this.gateway.deleteChatSession(sessionId);
      },
    );

    ipcMain.handle(
      "agent:deleteChatSessions",
      async (_: any, sessionIds: string[]) => {
        await this.gateway.deleteChatSessions(sessionIds);
      },
    );

    ipcMain.handle(
      "agent:renameSession",
      async (_: any, sessionId: string, newTitle: string) => {
        this.gateway.renameSession(sessionId, newTitle);
      },
    );

    ipcMain.handle(
      "agent:exportHistory",
      async (
        _: any,
        sessionId: string,
        mode: HistoryExportMode = "detailed",
      ) => {
        await this.gateway.waitForRunCompletion(sessionId);
        const backendSession = this.agentService.exportChatSession(sessionId);
        if (!backendSession) {
          throw new Error(`Session with ID ${sessionId} not found`);
        }
        const uiSession = this.uiHistoryService.getSession(sessionId);

        const safeFileBaseName = (input: string): string => {
          const raw = String(input || "").trim();
          const cleaned = raw
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
            .replace(/\s+/g, " ")
            .trim();
          const normalized = cleaned.replace(/^[. ]+|[. ]+$/g, "");
          return normalized || "conversation";
        };

        const formatTimestamp = (d: Date): string => {
          const pad = (n: number) => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
        };

        const { dialog } = require("electron");
        const baseName = safeFileBaseName(
          uiSession?.title || backendSession.title,
        );
        const ts = formatTimestamp(new Date());
        const isSimple = mode === "simple";
        const { filePath } = await dialog.showSaveDialog({
          title: isSimple
            ? "Export Conversation (Markdown)"
            : "Export Conversation History",
          defaultPath: isSimple
            ? `${baseName}_${ts}.md`
            : `${baseName}_${ts}.json`,
          filters: isSimple
            ? [
                { name: "Markdown", extensions: ["md"] },
                { name: "All Files", extensions: ["*"] },
              ]
            : [
                { name: "JSON", extensions: ["json"] },
                { name: "All Files", extensions: ["*"] },
              ],
        });

        if (filePath) {
          const fs = require("fs");
          if (isSimple) {
            const markdown = this.uiHistoryService.toReadableMarkdown(
              uiSession?.messages || [],
              uiSession?.title || backendSession.title,
            );
            await fs.promises.writeFile(filePath, markdown, "utf8");
          } else {
            const historyToExport = {
              sessionId: backendSession.id,
              title: uiSession?.title || backendSession.title,
              lastCheckpointOffset: backendSession.lastCheckpointOffset,
              createdAt: new Date(backendSession.createdAt).toISOString(),
              updatedAt: new Date(backendSession.updatedAt).toISOString(),
              frontendMessages: uiSession?.messages || [],
              backendMessages: backendSession.messages.map((msg: any) => ({
                messageId: msg.id,
                messageType: msg.type,
                messageData: msg.data,
              })),
            };
            await fs.promises.writeFile(
              filePath,
              JSON.stringify(historyToExport, null, 2),
            );
          }
        }
      },
    );

    ipcMain.handle("agent:getAllChatHistory", () =>
      this.agentService.getAllChatHistory(),
    );
    ipcMain.handle("agent:loadChatSession", (_: any, id: string) =>
      this.agentService.loadChatSession(id),
    );
    ipcMain.handle("agent:getUiMessages", (_: any, id: string) =>
      this.uiHistoryService.getMessages(id),
    );
    ipcMain.handle(
      "agent:formatMessagesMarkdown",
      (_: any, sessionId: string, messageIds: string[]) => {
        return this.uiHistoryService.toReadableMarkdownFragmentByMessageIds(
          sessionId,
          messageIds,
        );
      },
    );
    ipcMain.handle("session:list", () => {
      const sessions = this.gateway.listSessionSummaries();
      return {
        sessions,
        uiRevision: sessions[0]?.uiRevision ?? this.gateway.getUiRevision(),
      };
    });
    ipcMain.handle("session:get", (_: any, sessionId: string) => {
      const session = this.gateway.getSessionSnapshot(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return { session };
    });
    ipcMain.handle(
      "agent:rollbackToMessage",
      async (_: any, sessionId: string, messageId: string) => {
        return this.gateway.rollbackSessionToMessage(sessionId, messageId);
      },
    );
    ipcMain.handle(
      "agent:branchFromMessage",
      async (_: any, sessionId: string, messageId: string) => {
        return this.gateway.branchSessionFromMessage(sessionId, messageId);
      },
    );

    ipcMain.handle(
      "system:saveImageAttachment",
      async (
        _: any,
        payload: {
          dataBase64: string;
          fileName?: string;
          mimeType?: string;
          previewDataUrl?: string;
        },
      ) => {
        return await this.imageAttachmentService.saveImageAttachment(payload);
      },
    );

    ipcMain.handle("system:openExternal", async (_: any, url: string) => {
      if (url && (url.startsWith("http:") || url.startsWith("https:"))) {
        await shell.openExternal(url);
      }
    });

    // Native drag-out: hand local on-disk files to the OS (Finder/desktop/other apps).
    // The renderer only sends real local absolute paths (local terminals); remote
    // entries are never routed here since their bytes are not on this machine.
    ipcMain.on(
      "system:startFileDrag",
      async (event: any, filePaths: unknown) => {
        const paths = Array.isArray(filePaths)
          ? filePaths.filter(
              (path): path is string =>
                typeof path === "string" && path.trim().length > 0,
            )
          : [];
        if (paths.length === 0) return;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) return;
        const icon = await resolveDragIcon(paths[0]);
        if (win.isDestroyed()) return;
        try {
          win.webContents.startDrag({
            file: paths[0],
            ...(paths.length > 1 ? { files: paths } : {}),
            icon,
          });
        } catch (error) {
          console.error("[system:startFileDrag] failed to start drag:", error);
        }
      },
    );

    ipcMain.handle("gateway:isSameMachine", async () => {
      return { sameMachine: true };
    });

    // Skills
    ipcMain.handle("skills:openFolder", async () => {
      await this.skillService.openSkillsFolder();
    });

    ipcMain.handle("skills:reload", async () => {
      return await this.skillService.reload();
    });

    ipcMain.handle("skills:getAll", async () => {
      return await this.skillService.getAll();
    });

    ipcMain.handle("skills:getEnabled", async () => {
      return await this.skillService.getEnabledSkills();
    });

    ipcMain.handle("skills:create", async () => {
      return await this.skillService.createSkillFromTemplate();
    });

    ipcMain.handle("skills:openFile", async (_evt: any, fileName: string) => {
      await this.skillService.openSkillFile(fileName);
    });

    ipcMain.handle("skills:delete", async (_evt: any, fileName: string) => {
      await this.skillService.deleteSkillFile(fileName);
      return await this.skillService.getAll();
    });

    ipcMain.handle(
      "skills:setEnabled",
      async (_: any, name: string, enabled: boolean) => {
        const settings = this.settingsService.getSettings();
        const nextSkills = { ...(settings.tools?.skills ?? {}) };
        nextSkills[name] = enabled;
        this.settingsService.setSettings({
          tools: { builtIn: settings.tools?.builtIn ?? {}, skills: nextSkills },
        });
        this.agentService.updateSettings(this.settingsService.getSettings());

        const nextSettings = this.settingsService.getSettings();
        const allSkills = await this.skillService.getAll();
        const summary = buildSkillStatusSummary(
          allSkills,
          nextSettings.tools?.skills,
        );
        this.gateway.broadcastRaw("skills:updated", summary);
        return summary;
      },
    );

    // Memory
    ipcMain.handle("memory:list", async () => {
      const runtime = this.memoryService as any;
      if (typeof runtime.getAll === "function") {
        return await runtime.getAll();
      }
      const snapshot = await this.memoryService.getMemorySnapshot();
      return [snapshot];
    });

    ipcMain.handle("memory:setRule", async (_: any, content: string) => {
      const runtime = this.memoryService as any;
      if (
        typeof runtime.setRuleContent === "function" &&
        typeof runtime.getRuleContent === "function"
      ) {
        await runtime.setRuleContent(String(content ?? ""));
        return await runtime.getRuleContent();
      }
      const snapshot = await this.memoryService.writeMemory(
        String(content ?? ""),
      );
      this.gateway.broadcastRaw("memory:updated", snapshot);
      return snapshot.content;
    });

    ipcMain.handle("memory:get", async () => {
      return await this.memoryService.getMemorySnapshot(
        this.getActiveAgentSettingProfileId(),
      );
    });

    ipcMain.handle("memory:setContent", async (_: any, content: string) => {
      const snapshot = await this.memoryService.writeMemory(
        String(content ?? ""),
        this.getActiveAgentSettingProfileId(),
      );
      this.gateway.broadcastRaw("memory:updated", snapshot);
      return snapshot;
    });

    ipcMain.handle("memory:openFile", async () => {
      const snapshot = await this.memoryService.getMemorySnapshot(
        this.getActiveAgentSettingProfileId(),
      );
      await shell.openPath(snapshot.filePath);
    });

    ipcMain.handle("agentSettings:get", async () => {
      return this.agentSettingProfileService.getState();
    });

    ipcMain.handle("agentSettings:saveCurrent", async () => {
      const result = await this.agentSettingProfileService.saveCurrent();
      this.broadcastAgentSettingResult(result);
      return result;
    });

    ipcMain.handle("agentSettings:apply", async (_: any, profileId: string) => {
      const result = await this.agentSettingProfileService.apply(profileId);
      this.broadcastAgentSettingResult(result);
      return result;
    });

    ipcMain.handle(
      "agentSettings:overwrite",
      async (_: any, profileId: string) => {
        const result =
          await this.agentSettingProfileService.overwrite(profileId);
        this.broadcastAgentSettingResult(result);
        return result;
      },
    );

    ipcMain.handle(
      "agentSettings:delete",
      async (_: any, profileId: string) => {
        const result = await this.agentSettingProfileService.delete(profileId);
        this.broadcastAgentSettingResult(result);
        return result;
      },
    );

    // Settings / tools / themes / models
    ipcMain.handle("settings:get", async () => {
      return this.settingsService.getSettings();
    });

    ipcMain.handle("settings:set", async (_: any, settings: any) => {
      if (settings?.gateway?.ws) {
        await this.applyWsGatewayConfig(settings.gateway.ws);
      }
      this.settingsService.setSettings(settings);
      const currentSettings = this.settingsService.getSettings();
      this.agentService.updateSettings(currentSettings);
    });

    ipcMain.on("settings:setSync", (event: any, settings: any) => {
      try {
        const patch = normalizeSyncSettingsPatch(settings);
        this.settingsService.setSettings(patch);
        const currentSettings = this.settingsService.getSettings();
        this.agentService.updateSettings(currentSettings);
        event.returnValue = { ok: true };
      } catch (error) {
        event.returnValue = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    ipcMain.handle(
      "settings:setWsGatewayAccess",
      async (_: any, access: WsGatewayAccess) => {
        const current = this.settingsService.getSettings();
        return this.applyWsGatewayConfig({
          access,
          port: current.gateway.ws.port,
          allowedCidrs: current.gateway.ws.allowedCidrs,
        });
      },
    );

    ipcMain.handle(
      "settings:setWsGatewayConfig",
      async (
        _: any,
        ws: { access: WsGatewayAccess; port: number; allowedCidrs?: string[] },
      ) => {
        return this.applyWsGatewayConfig(ws);
      },
    );

    ipcMain.handle("access-tokens:list", async () => {
      return await this.accessTokenService.listTokens();
    });

    ipcMain.handle("access-tokens:create", async (_: any, name: string) => {
      return await this.accessTokenService.createToken(name);
    });

    ipcMain.handle("access-tokens:delete", async (_: any, id: string) => {
      return await this.accessTokenService.deleteToken(id);
    });

    ipcMain.handle("ui-settings:get", async () => {
      return this.uiSettingsStore.getSettings();
    });

    ipcMain.handle("ui-settings:set", async (_: any, settings: any) => {
      this.uiSettingsStore.setSettings(settings);
      this.updateWindowsThemeIfNeeded();
    });

    ipcMain.handle("models:probe", async (_evt: any, model: any) => {
      return await this.modelCapabilityService.probe(model);
    });

    ipcMain.handle("settings:openCommandPolicyFile", async () => {
      await this.commandPolicyService.openPolicyFile();
    });

    ipcMain.handle("settings:getCommandPolicyLists", async () => {
      return await this.commandPolicyService.getLists();
    });

    ipcMain.handle(
      "settings:addCommandPolicyRule",
      async (
        _evt: any,
        listName: "allowlist" | "denylist" | "asklist",
        rule: string,
      ) => {
        return await this.commandPolicyService.addRule(listName, rule);
      },
    );

    ipcMain.handle(
      "settings:deleteCommandPolicyRule",
      async (
        _evt: any,
        listName: "allowlist" | "denylist" | "asklist",
        rule: string,
      ) => {
        return await this.commandPolicyService.deleteRule(listName, rule);
      },
    );

    ipcMain.handle("tools:openMcpConfig", async () => {
      await this.mcpToolService.openConfigFile();
    });

    ipcMain.handle("tools:reloadMcp", async () => {
      return await this.mcpToolService.reloadAll();
    });

    ipcMain.handle("tools:getMcp", async () => {
      return this.mcpToolService.getSummaries();
    });

    ipcMain.handle(
      "tools:setMcpEnabled",
      async (_: any, name: string, enabled: boolean) => {
        return await this.mcpToolService.setServerEnabled(name, enabled);
      },
    );

    ipcMain.handle("tools:getBuiltIn", async () => {
      const settings = this.settingsService.getSettings();
      return buildBuiltInToolStatusSummary(settings.tools?.builtIn);
    });

    ipcMain.handle(
      "tools:setBuiltInEnabled",
      async (_: any, name: string, enabled: boolean) => {
        const settings = this.settingsService.getSettings();
        const nextBuiltIn = { ...(settings.tools?.builtIn ?? {}) };
        nextBuiltIn[name] = enabled;
        this.settingsService.setSettings({
          tools: { builtIn: nextBuiltIn, skills: settings.tools?.skills ?? {} },
        });
        const nextSettings = this.settingsService.getSettings();
        this.agentService.updateSettings(nextSettings);
        const summary = buildBuiltInToolStatusSummary(
          nextSettings.tools?.builtIn,
        );
        this.gateway.broadcastRaw("tools:builtInUpdated", summary);
        return summary;
      },
    );

    ipcMain.handle("themes:openCustomConfig", async () => {
      await this.themeStore.openCustomThemeFile();
    });

    ipcMain.handle("themes:reloadCustom", async () => {
      const themes = await this.themeStore.loadCustomThemes();
      this.updateWindowsThemeIfNeeded();
      return themes;
    });

    ipcMain.handle("themes:getCustom", async () => {
      return await this.themeStore.loadCustomThemes();
    });

    ipcMain.handle("version:getState", async () => {
      return this.versionService.getState();
    });

    ipcMain.handle("version:check", async () => {
      return await this.versionService.checkForUpdates();
    });

    // Terminal
    ipcMain.handle("terminal:list", async () => {
      return {
        terminals: this.terminalService
          .getDisplayTerminals()
          .map((terminal) => ({
            id: terminal.id,
            title: terminal.title,
            type: terminal.type,
            cols: terminal.cols,
            rows: terminal.rows,
            runtimeState: terminal.runtimeState,
            lastExitCode: terminal.lastExitCode,
            remoteOs: terminal.remoteOs,
            systemInfo: terminal.systemInfo,
            monitorIdentity:
              this.terminalService.getMonitorIdentity(terminal.id) ?? undefined,
          })),
      };
    });

    ipcMain.handle("terminal:createTab", async (_: any, config: any) => {
      const tab = await this.terminalService.createTerminal(config);
      return { id: tab.id };
    });

    ipcMain.handle("terminal:reconnect", async (_: any, terminalId: string) => {
      const tab = await this.terminalService.reconnectTerminal(terminalId);
      return { id: tab.id };
    });

    ipcMain.handle(
      "terminal:write",
      async (_: any, terminalId: string, data: string) => {
        this.terminalService.write(terminalId, data);
      },
    );

    ipcMain.handle(
      "terminal:writePaths",
      async (_: any, terminalId: string, paths: string[]) => {
        this.terminalService.writePaths(terminalId, paths);
      },
    );

    ipcMain.handle(
      "terminal:resize",
      async (_: any, terminalId: string, cols: number, rows: number) => {
        this.terminalService.resize(terminalId, cols, rows);
      },
    );

    ipcMain.handle("terminal:kill", async (_: any, terminalId: string) => {
      this.terminalService.kill(terminalId);
    });

    ipcMain.handle(
      "terminal:setSelection",
      async (_: any, terminalId: string, selectionText: string) => {
        this.terminalService.setSelection(terminalId, selectionText);
      },
    );

    ipcMain.handle(
      "terminal:getBufferDelta",
      async (_: any, terminalId: string, fromOffset: number) => {
        const data = this.terminalService.getBufferDelta(
          terminalId,
          fromOffset,
        );
        const offset = this.terminalService.getCurrentOffset(terminalId);
        return {
          data,
          offset,
          ...this.terminalService.getRenderMetadata(terminalId),
        };
      },
    );

    ipcMain.handle(
      "terminal:generateCommandDraft",
      async (_: any, terminalId: string, prompt: string, profileId: string) => {
        return await this.terminalCommandDraftService.generateCommandDraft({
          terminalId,
          prompt,
          profileId,
        });
      },
    );

    // Filesystem
    const requireFileSystemService = (): FileSystemService => {
      if (!this.fileSystemService) {
        throw new Error("Filesystem APIs are not configured.");
      }
      return this.fileSystemService;
    };
    const requireFileTransferService = (): FileTransferService => {
      if (!this.fileTransferService) {
        throw new Error("File transfer APIs are not configured.");
      }
      return this.fileTransferService;
    };
    // Legacy direct-transfer IPC used by older renderer/web clients. New filesystem
    // panel flows use filesystem:startTransfer + filesystem:cancelTransferTask.
    const activeTransferAbortControllers = new Map<string, AbortController>();
    ipcMain.handle(
      "filesystem:list",
      async (_: any, terminalId: string, dirPath?: string) => {
        return await requireFileSystemService().listDirectory(
          terminalId,
          dirPath,
        );
      },
    );

    ipcMain.handle(
      "filesystem:readTextFile",
      async (
        _: any,
        terminalId: string,
        filePath: string,
        options?: { maxBytes?: number },
      ) => {
        return await requireFileSystemService().readTextFile(
          terminalId,
          filePath,
          options,
        );
      },
    );

    ipcMain.handle(
      "filesystem:readFileBase64",
      async (
        _: any,
        terminalId: string,
        filePath: string,
        options?: { maxBytes?: number },
      ) => {
        return await requireFileSystemService().readFileBase64(
          terminalId,
          filePath,
          options,
        );
      },
    );

    ipcMain.handle(
      "filesystem:writeTextFile",
      async (_: any, terminalId: string, filePath: string, content: string) => {
        await requireFileSystemService().writeTextFile(
          terminalId,
          filePath,
          content,
        );
        return { ok: true };
      },
    );

    ipcMain.handle(
      "filesystem:writeFileBase64",
      async (
        _: any,
        terminalId: string,
        filePath: string,
        contentBase64: string,
        options?: { maxBytes?: number },
      ) => {
        await requireFileSystemService().writeFileBase64(
          terminalId,
          filePath,
          contentBase64,
          options,
        );
        return { ok: true };
      },
    );

    ipcMain.handle(
      "filesystem:transferEntries",
      async (
        event: any,
        sourceTerminalId: string,
        sourcePaths: string[],
        targetTerminalId: string,
        targetDirPath: string,
        options?: {
          mode?: "copy" | "move";
          transferId?: string;
          chunkSize?: number;
          overwrite?: boolean;
          conflictStrategy?: "error" | "overwrite" | "rename";
        },
      ) => {
        const transferId =
          typeof options?.transferId === "string" &&
          options.transferId.trim().length > 0
            ? options.transferId.trim()
            : `fs-transfer:${Date.now()}`;
        const mode = options?.mode === "move" ? "move" : "copy";
        const controller = new AbortController();
        const existingController =
          activeTransferAbortControllers.get(transferId);
        if (existingController) {
          existingController.abort();
        }
        activeTransferAbortControllers.set(transferId, controller);
        let lastEmitAt = 0;
        let lastEmitBytes = -1;

        try {
          return await requireFileSystemService().transferEntries(
            sourceTerminalId,
            sourcePaths,
            targetTerminalId,
            targetDirPath,
            {
              mode,
              overwrite: options?.overwrite === true,
              conflictStrategy: options?.conflictStrategy,
              chunkSize: options?.chunkSize,
              transferId,
              signal: controller.signal,
              onProgress: (progress) => {
                const now = Date.now();
                const shouldEmit =
                  progress.eof ||
                  progress.bytesTransferred === 0 ||
                  now - lastEmitAt >= 120 ||
                  progress.bytesTransferred - lastEmitBytes >= 64 * 1024;
                if (!shouldEmit) {
                  return;
                }
                lastEmitAt = now;
                lastEmitBytes = progress.bytesTransferred;
                event.sender.send("filesystem:transferProgress", {
                  transferId,
                  mode,
                  sourceTerminalId,
                  targetTerminalId,
                  targetDirPath,
                  sourcePaths,
                  bytesTransferred: progress.bytesTransferred,
                  totalBytes: progress.totalBytes,
                  transferredFiles: progress.transferredFiles,
                  totalFiles: progress.totalFiles,
                  eof: progress.eof,
                });
              },
            },
          );
        } catch (error) {
          if (
            controller.signal.aborted ||
            isFileSystemTransferCancelledError(error)
          ) {
            const cancelledError = new Error(
              "Transfer cancelled by user.",
            ) as Error & { code: string };
            cancelledError.code = FILESYSTEM_TRANSFER_CANCELLED_CODE;
            throw cancelledError;
          }
          throw error;
        } finally {
          activeTransferAbortControllers.delete(transferId);
        }
      },
    );

    ipcMain.handle(
      "filesystem:cancelTransfer",
      async (_: any, transferId: string) => {
        if (typeof transferId !== "string" || transferId.trim().length <= 0) {
          return { ok: false };
        }
        const key = transferId.trim();
        const controller = activeTransferAbortControllers.get(key);
        if (!controller) {
          return { ok: false };
        }
        controller.abort();
        return { ok: true };
      },
    );

    ipcMain.handle("filesystem:startTransfer", async (_: any, input: any) => {
      return requireFileTransferService().startTransfer(input);
    });

    ipcMain.handle(
      "filesystem:getTransfer",
      async (_: any, transferId: string) => {
        return requireFileTransferService().getTransfer(transferId);
      },
    );

    ipcMain.handle(
      "filesystem:listTransfers",
      async (_: any, options?: any) => {
        return requireFileTransferService().listTransfers(options);
      },
    );

    ipcMain.handle(
      "filesystem:cancelTransferTask",
      async (_: any, transferId: string) => {
        return requireFileTransferService().cancelTransfer(transferId);
      },
    );

    ipcMain.handle(
      "filesystem:createDirectory",
      async (_: any, terminalId: string, dirPath: string) => {
        await requireFileSystemService().createDirectory(terminalId, dirPath);
        return { ok: true };
      },
    );

    ipcMain.handle(
      "filesystem:createFile",
      async (_: any, terminalId: string, filePath: string) => {
        await requireFileSystemService().createFile(terminalId, filePath);
        return { ok: true };
      },
    );

    ipcMain.handle(
      "filesystem:deletePath",
      async (
        _: any,
        terminalId: string,
        targetPath: string,
        options?: { recursive?: boolean },
      ) => {
        await requireFileSystemService().deletePath(
          terminalId,
          targetPath,
          options,
        );
        return { ok: true };
      },
    );

    ipcMain.handle(
      "filesystem:renamePath",
      async (
        _: any,
        terminalId: string,
        sourcePath: string,
        targetPath: string,
      ) => {
        await requireFileSystemService().renamePath(
          terminalId,
          sourcePath,
          targetPath,
        );
        return { ok: true };
      },
    );

    // UI
    // Mobile web server
    ipcMain.handle("mobileWeb:getStatus", async () => {
      if (!this.mobileWebServerService) return { running: false };
      return this.mobileWebServerService.getStatus();
    });

    ipcMain.handle("mobileWeb:start", async () => {
      if (!this.mobileWebServerService)
        throw new Error("Mobile web service not available");
      const settings = this.settingsService.getSettings();
      const preferredPort = settings.gateway?.mobileWeb?.port ?? null;
      return await this.mobileWebServerService.start(preferredPort);
    });

    ipcMain.handle("mobileWeb:stop", async () => {
      if (!this.mobileWebServerService) return { ok: true };
      await this.mobileWebServerService.stop();
      return { ok: true };
    });

    ipcMain.handle("mobileWeb:setPort", async (_: any, port: number | null) => {
      if (this.mobileWebServerService?.getStatus().running) {
        throw new Error("Stop the mobile web server before changing its port");
      }
      const normalizedPort =
        typeof port === "number" &&
        Number.isInteger(port) &&
        port > 0 &&
        port < 65536
          ? port
          : null;
      const currentSettings = this.settingsService.getSettings();
      this.settingsService.setSettings({
        gateway: {
          ws: currentSettings.gateway.ws,
          mobileWeb: { port: normalizedPort },
        },
      });
      this.agentService.updateSettings(this.settingsService.getSettings());
      return { ok: true };
    });

    ipcMain.handle(
      "ui:showContextMenu",
      async (
        event: any,
        payload: { id: string; canCopy: boolean; canPaste: boolean },
      ) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;

        const menu = Menu.buildFromTemplate([
          {
            label: "Copy",
            enabled: payload.canCopy,
            click: () => {
              window.webContents.send("ui:contextMenuAction", {
                id: payload.id,
                action: "copy",
              });
            },
          },
          {
            label: "Paste",
            enabled: payload.canPaste,
            click: () => {
              window.webContents.send("ui:contextMenuAction", {
                id: payload.id,
                action: "paste",
              });
            },
          },
        ]);

        menu.popup({ window });
      },
    );
  }

  private async applyWsGatewayConfig(ws: {
    access: WsGatewayAccess;
    port: number;
    allowedCidrs?: string[];
  }) {
    if (
      ws.access !== "disabled" &&
      ws.access !== "localhost" &&
      ws.access !== "internet" &&
      ws.access !== "lan" &&
      ws.access !== "custom"
    ) {
      throw new Error(
        `Invalid websocket gateway access mode: ${String(ws.access)}`,
      );
    }
    const port = Number(ws.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      throw new Error(`Invalid websocket gateway port: ${String(ws.port)}`);
    }
    const allowedCidrs = Array.isArray(ws.allowedCidrs)
      ? ws.allowedCidrs
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
      : [];
    const nextWs = {
      access: ws.access,
      port,
      allowedCidrs,
    };
    await this.wsGatewayControlService.applyPolicy(nextWs);
    this.settingsService.setSettings({
      gateway: {
        ws: nextWs,
      },
    });
    const nextSettings = this.settingsService.getSettings();
    this.agentService.updateSettings(nextSettings);
    return nextSettings.gateway.ws;
  }
}
