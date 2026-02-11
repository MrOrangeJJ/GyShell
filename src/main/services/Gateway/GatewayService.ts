import { ipcMain, shell, Menu, BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import type { IGateway, GatewayEvent, GatewayEventType, SessionContext, IClientTransport, StartTaskOptions } from './types';
import { ElectronWindowTransport } from './ElectronWindowTransport';
import type { TerminalService } from '../TerminalService';
import type { AgentService_v2 } from '../AgentService_v2';
import type { UIHistoryService, HistoryExportMode } from '../UIHistoryService';
import type { CommandPolicyService } from '../CommandPolicy/CommandPolicyService';
import type { TempFileService } from '../TempFileService';
import type { SkillService } from '../SkillService';
import type { SettingsService } from '../SettingsService';
import type { ModelCapabilityService } from '../ModelCapabilityService';
import type { McpToolService } from '../McpToolService';
import type { ThemeService } from '../ThemeService';
import type { VersionService } from '../VersionService';
import { BUILTIN_TOOL_INFO } from '../AgentHelper/tools';
import { getRunExperimentalFlagsFromSettings } from '../AgentHelper/utils/experimental_flags';
import { resolveTheme } from '../../../renderer_v2/theme/themes';

export class GatewayService extends EventEmitter implements IGateway {
  private sessions: Map<string, SessionContext> = new Map();
  private eventBus: EventEmitter = new EventEmitter();
  private feedbackBus: EventEmitter = new EventEmitter();
  private feedbackCache: Map<string, any> = new Map();
  private transports: Map<string, IClientTransport> = new Map();

  constructor(
    private terminalService: TerminalService,
    private agentService: AgentService_v2,
    private uiHistoryService: UIHistoryService,
    private commandPolicyService: CommandPolicyService,
    private tempFileService: TempFileService,
    private skillService: SkillService,
    private settingsService: SettingsService,
    private modelCapabilityService: ModelCapabilityService,
    private mcpToolService: McpToolService,
    private themeService: ThemeService,
    private versionService: VersionService
  ) {
    super();
    // Register default Electron transport
    this.registerTransport(new ElectronWindowTransport());
    
    this.setupIpcHandlers();
    this.setupInternalSubscriptions();
    this.setupServiceSubscriptions();
  }

  public registerTransport(transport: IClientTransport) {
    this.transports.set(transport.id, transport);
  }

  public unregisterTransport(transportId: string) {
    this.transports.delete(transportId);
  }

  private setupServiceSubscriptions() {
    // MCP tool status updates
    this.mcpToolService.on('updated', (summary) => {
      this.transports.forEach(t => t.send('tools:mcpUpdated', summary));
    });
  }

  private setupInternalSubscriptions() {
    // UIHistoryService subscribes to all agent events for persistence
    this.subscribe('agent:event', (event) => {
      const actions = this.uiHistoryService.recordEvent(event.sessionId!, event.payload);
      
      this.transports.forEach(transport => {
        // 1. Send processed UI Action (for core UI like message list)
        actions.forEach(action => transport.sendUIUpdate(action));
        
        // 2. Send raw Agent Event (for auxiliary components like Banners, status lights, etc.)
        transport.emitEvent(event);
      });
    });
  }

  private setupIpcHandlers() {
    // Take over IPC originally in AgentService
    ipcMain.handle(
      'agent:startTask',
      async (_: any, sessionId: string, terminalId: string, userText: string, options?: StartTaskOptions) => {
        return this.dispatchTask(sessionId, userText, terminalId, options);
      }
    );

    ipcMain.handle('agent:stopTask', async (_: any, sessionId: string) => {
      return this.stopTask(sessionId);
    });

    ipcMain.handle('agent:replyMessage', async (_: any, messageId: string, payload: any) => {
      console.log(`[GatewayService] Received replyMessage for messageId=${messageId}:`, payload);
      this.feedbackCache.set(messageId, payload);
      this.feedbackBus.emit(`feedback:${messageId}`, payload);
      return { ok: true };
    });

    ipcMain.handle('agent:deleteChatSession', async (_: any, sessionId: string) => {
      await this.stopTask(sessionId);
      this.agentService.deleteChatSession(sessionId);
      this.uiHistoryService.deleteSession(sessionId);
      this.sessions.delete(sessionId);
    });

    ipcMain.handle('agent:renameSession', async (_: any, sessionId: string, newTitle: string) => {
      this.agentService.renameChatSession(sessionId, newTitle);
    });

    ipcMain.handle('agent:replyCommandApproval', async (_: any, approvalId: string, decision: 'allow' | 'deny') => {
      this.feedbackBus.emit(`feedback:${approvalId}`, { decision });
    });

    ipcMain.handle('agent:exportHistory', async (_: any, sessionId: string, mode: HistoryExportMode = 'detailed') => {
      await this.waitForRunCompletionIfAny(sessionId);
      const backendSession = this.agentService.exportChatSession(sessionId);
      if (!backendSession) {
        throw new Error(`Session with ID ${sessionId} not found`);
      }
      const uiSession = this.uiHistoryService.getSession(sessionId);

      const safeFileBaseName = (input: string): string => {
        const raw = String(input || '').trim();
        const cleaned = raw
          .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
          .replace(/\s+/g, ' ')
          .trim();
        const normalized = cleaned.replace(/^[. ]+|[. ]+$/g, '');
        return normalized || 'conversation';
      };

      const formatTimestamp = (d: Date): string => {
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      };

      const { dialog } = require('electron');
      const baseName = safeFileBaseName(uiSession?.title || backendSession.title);
      const ts = formatTimestamp(new Date());
      const isSimple = mode === 'simple';
      const { filePath } = await dialog.showSaveDialog({
        title: isSimple ? 'Export Conversation (Markdown)' : 'Export Conversation History',
        defaultPath: isSimple ? `${baseName}_${ts}.md` : `${baseName}_${ts}.json`,
        filters: isSimple
          ? [
              { name: 'Markdown', extensions: ['md'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          : [
              { name: 'JSON', extensions: ['json'] },
              { name: 'All Files', extensions: ['*'] }
            ]
      });

      if (filePath) {
        const fs = require('fs');
        if (isSimple) {
          const markdown = this.uiHistoryService.toReadableMarkdown(
            uiSession?.messages || [],
            uiSession?.title || backendSession.title
          );
          await fs.promises.writeFile(filePath, markdown, 'utf8');
        } else {
          const historyToExport = {
            sessionId: backendSession.id,
            title: uiSession?.title || backendSession.title,
            boundTerminalTabId: backendSession.boundTerminalTabId,
            lastCheckpointOffset: backendSession.lastCheckpointOffset,
            createdAt: new Date(backendSession.createdAt).toISOString(),
            updatedAt: new Date(backendSession.updatedAt).toISOString(),
            frontendMessages: uiSession?.messages || [],
            backendMessages: backendSession.messages.map((msg: any) => ({
              messageId: msg.id,
              messageType: msg.type,
              messageData: msg.data
            }))
          };
          await fs.promises.writeFile(filePath, JSON.stringify(historyToExport, null, 2));
        }
      }
    });

    // Forward other query-type IPCs
    ipcMain.handle('agent:getAllChatHistory', () => this.agentService.getAllChatHistory());
    ipcMain.handle('agent:loadChatSession', (_: any, id: string) => this.agentService.loadChatSession(id));
    ipcMain.handle('agent:getUiMessages', (_: any, id: string) => this.uiHistoryService.getMessages(id));
    ipcMain.handle('agent:rollbackToMessage', async (_: any, sessionId: string, messageId: string) => {
      // 1. Stop currently running task if any
      await this.stopTask(sessionId);

      // 2. Emit rollback event to sync UIHistoryService and frontend UI
      this.broadcast({
        type: 'agent:event',
        sessionId,
        payload: { 
          type: 'rollback', 
          messageId 
        }
      });

      // 3. Let AgentService handle backend history rollback (disk operation)
      return this.agentService.rollbackToMessage(sessionId, messageId);
    });

    // System/Temp File handlers
    ipcMain.handle('system:saveTempPaste', async (_: any, content: string) => {
      return await this.tempFileService.saveTempPaste(content);
    });

    // Skill handlers
    ipcMain.handle('skills:openFolder', async () => {
      await this.skillService.openSkillsFolder();
    });

    ipcMain.handle('skills:reload', async () => {
      return await this.skillService.reload();
    });

    ipcMain.handle('skills:getAll', async () => {
      return await this.skillService.getAll();
    });

    ipcMain.handle('skills:getEnabled', async () => {
      return await this.skillService.getEnabledSkills();
    });

    ipcMain.handle('skills:create', async () => {
      return await this.skillService.createSkillFromTemplate();
    });

    ipcMain.handle('skills:openFile', async (_evt: any, fileName: string) => {
      await this.skillService.openSkillFile(fileName);
    });

    ipcMain.handle('skills:delete', async (_evt: any, fileName: string) => {
      await this.skillService.deleteSkillFile(fileName);
      return await this.skillService.getAll();
    });

    ipcMain.handle('skills:setEnabled', async (_: any, name: string, enabled: boolean) => {
      // This will update settings via SettingsService internally
      const settings = (global as any).settingsService.getSettings();
      const nextSkills = { ...(settings.tools?.skills ?? {}) };
      nextSkills[name] = enabled;
      (global as any).settingsService.setSettings({ tools: { builtIn: settings.tools?.builtIn ?? {}, skills: nextSkills } });
      
      // Notify AgentService to refresh its tool definitions
      this.agentService.updateSettings((global as any).settingsService.getSettings());
      
      // Broadcast to all windows that skills have been updated
      const enabledSkills = await this.skillService.getEnabledSkills();
      this.transports.forEach(t => t.send('skills:updated', enabledSkills));

      return enabledSkills;
    });

    ipcMain.handle('tools:setBuiltInEnabled', async (_: any, name: string, enabled: boolean) => {
      const settings = (global as any).settingsService.getSettings();
      const nextBuiltIn = { ...(settings.tools?.builtIn ?? {}) };
      nextBuiltIn[name] = enabled;
      (global as any).settingsService.setSettings({ tools: { builtIn: nextBuiltIn, skills: settings.tools?.skills ?? {} } });
      this.agentService.updateSettings((global as any).settingsService.getSettings());
      return BUILTIN_TOOL_INFO.map((tool) => ({
        name: tool.name,
        description: tool.description,
        enabled: nextBuiltIn[tool.name] ?? true
      }));
    });

    // --- System ---
    ipcMain.handle('system:openExternal', async (_: any, url: string) => {
      if (url && (url.startsWith('http:') || url.startsWith('https:'))) {
        await shell.openExternal(url);
      }
    });

    // --- Settings ---
    ipcMain.handle('settings:get', async () => {
      return this.settingsService.getSettings();
    });

    ipcMain.handle('settings:set', async (_: any, settings: any) => {
      const before = this.settingsService.getSettings();
      this.settingsService.setSettings(settings);
      const currentSettings = this.settingsService.getSettings();
      this.agentService.updateSettings(currentSettings);

      // Sync Windows title bar overlay at runtime when theme changes
      if (
        process.platform === 'win32' &&
        before.themeId !== currentSettings.themeId
      ) {
        const theme = resolveTheme(currentSettings.themeId, this.themeService.getCustomThemes());
        const bg = theme.terminal.background;
        const fg = theme.terminal.foreground;
        
        // This is a platform-specific UI tweak, we still need BrowserWindow here 
        // as it's about the native window frame, not the client content.
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(win => {
          if (typeof win.setTitleBarOverlay === 'function') {
            win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 38 });
            win.setBackgroundColor(bg);
          }
        });
      }
    });

    ipcMain.handle('models:probe', async (_evt: any, model: any) => {
      if (!this.modelCapabilityService) {
        throw new Error('Model capability service is not initialized')
      }
      return await this.modelCapabilityService.probe(model);
    });

    ipcMain.handle('settings:openCommandPolicyFile', async () => {
      await this.commandPolicyService.openPolicyFile();
    });

    ipcMain.handle('settings:getCommandPolicyLists', async () => {
      return await this.commandPolicyService.getLists();
    });

    ipcMain.handle('settings:addCommandPolicyRule', async (_evt: any, listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => {
      return await this.commandPolicyService.addRule(listName, rule);
    });

    ipcMain.handle('settings:deleteCommandPolicyRule', async (_evt: any, listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => {
      return await this.commandPolicyService.deleteRule(listName, rule);
    });

    // --- Tools (MCP) ---
    ipcMain.handle('tools:openMcpConfig', async () => {
      await this.mcpToolService.openConfigFile();
    });

    ipcMain.handle('tools:reloadMcp', async () => {
      return await this.mcpToolService.reloadAll();
    });

    ipcMain.handle('tools:getMcp', async () => {
      return this.mcpToolService.getSummaries();
    });

    ipcMain.handle('tools:setMcpEnabled', async (_: any, name: string, enabled: boolean) => {
      return await this.mcpToolService.setServerEnabled(name, enabled);
    });

    ipcMain.handle('tools:getBuiltIn', async () => {
      const settings = this.settingsService.getSettings();
      const enabledMap = settings.tools?.builtIn ?? {};
      return BUILTIN_TOOL_INFO.map((tool) => ({
        name: tool.name,
        description: tool.description,
        enabled: enabledMap[tool.name] ?? true
      }));
    });

    // --- Themes (Custom) ---
    ipcMain.handle('themes:openCustomConfig', async () => {
      await this.themeService.openCustomThemeFile();
    });

    ipcMain.handle('themes:reloadCustom', async () => {
      return await this.themeService.loadCustomThemes();
    });

    ipcMain.handle('themes:getCustom', async () => {
      return await this.themeService.loadCustomThemes();
    });

    // --- Version ---
    ipcMain.handle('version:getState', async () => {
      return this.versionService.getState();
    });

    ipcMain.handle('version:check', async () => {
      return await this.versionService.checkForUpdates();
    });

    // --- Terminal ---
    ipcMain.handle('terminal:createTab', async (_: any, config: any) => {
      const tab = await this.terminalService.createTerminal(config);
      return { id: tab.id };
    });

    ipcMain.handle('terminal:write', async (_: any, terminalId: string, data: string) => {
      this.terminalService.write(terminalId, data);
    });

    ipcMain.handle('terminal:writePaths', async (_: any, terminalId: string, paths: string[]) => {
      this.terminalService.writePaths(terminalId, paths);
    });

    ipcMain.handle('terminal:resize', async (_: any, terminalId: string, cols: number, rows: number) => {
      this.terminalService.resize(terminalId, cols, rows);
    });

    ipcMain.handle('terminal:kill', async (_: any, terminalId: string) => {
      this.terminalService.kill(terminalId);
    });

    ipcMain.handle('terminal:setSelection', async (_: any, terminalId: string, selectionText: string) => {
      this.terminalService.setSelection(terminalId, selectionText);
    });

    // --- UI ---
    ipcMain.handle(
      'ui:showContextMenu',
      async (event: any, payload: { id: string; canCopy: boolean; canPaste: boolean }) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;

        const menu = Menu.buildFromTemplate([
          {
            label: 'Copy',
            enabled: payload.canCopy,
            click: () => {
              window.webContents.send('ui:contextMenuAction', { id: payload.id, action: 'copy' });
            }
          },
          {
            label: 'Paste',
            enabled: payload.canPaste,
            click: () => {
              window.webContents.send('ui:contextMenuAction', { id: payload.id, action: 'paste' });
            }
          }
        ]);

        menu.popup({ window });
      }
    );
  }

  async createSession(terminalId: string): Promise<string> {
    const sessionId = uuidv4();
    const context = this.createEmptySessionContext(sessionId, terminalId);
    this.sessions.set(sessionId, context);
    return sessionId;
  }

  getSession(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  async dispatchTask(sessionId: string, input: string, terminalId?: string, options?: StartTaskOptions): Promise<void> {
    let context = this.sessions.get(sessionId);
    if (!context) {
      const tid = terminalId || this.terminalService.getAllTerminals()[0]?.id || '';
      context = this.createEmptySessionContext(sessionId, tid);
      this.sessions.set(sessionId, context);
    }

    this.ensureSessionProfileLock(context);

    if (context.status !== 'idle') {
      await this.stopTask(sessionId, {
        waitForCompletion: true,
        preserveProfileLock: true
      });
    } else {
      // Handle race: status already idle but previous run finalization not finished yet.
      await this.waitForRunCompletionIfAny(sessionId);
    }

    const runId = uuidv4();
    const abortController = new AbortController();
    let resolveRunCompletion: () => void = () => {};
    const runCompletion = new Promise<void>((resolve) => {
      resolveRunCompletion = resolve;
    });

    context.activeRunId = runId;
    context.abortController = abortController;
    context.status = 'running';
    context.metadata.runCompletion = runCompletion;
    context.metadata.runId = runId;

    try {
      // AgentService has been refactored as stateless run
      await this.agentService.run(context, input, abortController.signal, options?.startMode || 'normal');
    } catch (error: any) {
      console.error(`[GatewayService] Task execution error (sessionId=${sessionId}):`, error);
      if (this.agentService['helpers'].isAbortError(error)) {
        // User stopped manually, not treated as an error, handled by stopTask
        return;
      }
      // Error broadcasting is now handled inside agentService.run for better detail capture,
      // but we keep a fallback here just in case.
    } finally {
      resolveRunCompletion();
      // clear completion tracker for this run id
      if (context.metadata.runId === runId) {
        delete context.metadata.runCompletion;
        delete context.metadata.runId;
      }
      if (context.activeRunId === runId) {
        // Unified cleanup of run state
        this.clearRunState(context);
        this.releaseSessionProfileLock(context);
        // 1. Send DONE action (for UI state like isThinking)
        this.broadcast({ type: 'agent:event', sessionId, payload: { type: 'done' } });
        // 2. Send SESSION_READY action (for admission control and queue scheduling)
        // This MUST be sent after clearRunState to ensure backend is truly idle
        this.transports.forEach(t => t.sendUIUpdate({ type: 'SESSION_READY', sessionId }));
        this.uiHistoryService.flush(sessionId);
      }
    }
  }

  async stopTask(
    sessionId: string,
    options?: { waitForCompletion?: boolean; preserveProfileLock?: boolean }
  ): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (context && context.abortController) {
      const runCompletion = context.metadata.runCompletion as Promise<void> | undefined;
      context.abortController.abort();
      this.clearRunState(context);
      if (!options?.preserveProfileLock) {
        this.releaseSessionProfileLock(context);
      }
      // Sync UI and disk immediately on a real stop.
      // For inserted-message restart flow, dispatchTask will continue with a new run immediately,
      // so we intentionally avoid emitting SESSION_READY here.
      if (!options?.preserveProfileLock) {
        this.broadcast({ type: 'agent:event', sessionId, payload: { type: 'done' } });
        this.transports.forEach(t => t.sendUIUpdate({ type: 'SESSION_READY', sessionId }));
        this.uiHistoryService.flush(sessionId);
      }
      if (options?.waitForCompletion && runCompletion) {
        await runCompletion.catch(() => undefined);
      }
      return;
    }
    if (context && options?.waitForCompletion) {
      const runCompletion = context.metadata.runCompletion as Promise<void> | undefined;
      if (runCompletion) {
        await runCompletion.catch(() => undefined);
      }
    }
  }

  private async waitForRunCompletionIfAny(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (!context) return;
    const runCompletion = context.metadata.runCompletion as Promise<void> | undefined;
    if (runCompletion) {
      await runCompletion.catch(() => undefined);
    }
  }

  private clearRunState(context: SessionContext) {
    context.status = 'idle';
    context.activeRunId = null;
    context.abortController = null;
    // Clean up cache for this session's messages if any remain
    // (In a real scenario, we might need a way to map messageId to sessionId here,
    // but for now, the cache is self-cleaning on read)
  }

  private releaseSessionProfileLock(context: SessionContext) {
    if (context.lockedProfileId) {
      this.agentService.releaseSessionModelBinding(context.sessionId);
    }
    context.lockedProfileId = null;
    context.lockedExperimentalFlags = null;
  }

  private createEmptySessionContext(sessionId: string, boundTerminalId: string): SessionContext {
    return {
      sessionId,
      boundTerminalId,
      activeRunId: null,
      lockedProfileId: null,
      lockedExperimentalFlags: null,
      abortController: null,
      status: 'idle',
      metadata: {}
    };
  }

  private ensureSessionProfileLock(context: SessionContext): void {
    if (context.lockedProfileId) return;
    const settings = this.settingsService.getSettings();
    context.lockedProfileId = settings.models.activeProfileId || '';
    context.lockedExperimentalFlags = getRunExperimentalFlagsFromSettings(settings);
  }

  async pauseTask(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (context) context.status = 'paused';
  }

  async resumeTask(_sessionId: string): Promise<void> {
    // Future implementation of re-trigger logic
  }

  // Event distribution method, renamed to broadcast to avoid conflict with EventEmitter's emit
  broadcast(event: Omit<GatewayEvent, 'id' | 'timestamp'>): void {
    const fullEvent: GatewayEvent = {
      ...event,
      id: uuidv4(),
      timestamp: Date.now()
    };

    // 1. Internal bus distribution (for other Services like UIHistoryService)
    this.eventBus.emit(fullEvent.type, fullEvent);

    // 2. Send to frontend via all transports
    this.transports.forEach(transport => {
      transport.emitEvent(fullEvent);
    });
  }

  // Raw data distribution for non-GatewayEvent messages (e.g. terminal data)
  broadcastRaw(channel: string, data: any): void {
    this.transports.forEach(transport => {
      transport.send(channel, data);
    });
  }

  subscribe(type: GatewayEventType, handler: (event: GatewayEvent) => void): () => void {
    this.eventBus.on(type, handler);
    return () => this.eventBus.off(type, handler);
  }

  async waitForFeedback<T>(messageId: string, timeoutMs: number = 120000): Promise<T | null> {
    // 1. Check cache first (in case frontend replied before backend started waiting)
    if (this.feedbackCache.has(messageId)) {
      const cached = this.feedbackCache.get(messageId);
      this.feedbackCache.delete(messageId);
      console.log(`[GatewayService] Using cached feedback for messageId=${messageId}`);
      return cached as T;
    }

    return new Promise((resolve) => {
      const eventName = `feedback:${messageId}`;
      const timer = setTimeout(() => {
        this.feedbackBus.off(eventName, handler);
        resolve(null);
      }, timeoutMs);

      const handler = (payload: T) => {
        clearTimeout(timer);
        this.feedbackBus.off(eventName, handler);
        this.feedbackCache.delete(messageId); // Cleanup cache if it was set during waiting
        resolve(payload);
      };

      this.feedbackBus.on(eventName, handler);
    });
  }
}
