import { BrowserWindow, ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import type { IGateway, GatewayEvent, GatewayEventType, SessionContext } from './types';
import type { TerminalService } from '../TerminalService';
import type { AgentService_v2 } from '../AgentService_v2';
import type { UIHistoryService } from '../UIHistoryService';
import type { CommandPolicyService } from '../CommandPolicy/CommandPolicyService';
import type { TempFileService } from '../TempFileService';
import type { SkillService } from '../SkillService';
import { BUILTIN_TOOL_INFO } from '../AgentHelper/tools';

export class GatewayService extends EventEmitter implements IGateway {
  private sessions: Map<string, SessionContext> = new Map();
  private eventBus: EventEmitter = new EventEmitter();
  private feedbackBus: EventEmitter = new EventEmitter();
  private feedbackCache: Map<string, any> = new Map();

  constructor(
    private terminalService: TerminalService,
    private agentService: AgentService_v2,
    private uiHistoryService: UIHistoryService,
    _commandPolicyService: CommandPolicyService,
    private tempFileService: TempFileService,
    private skillService: SkillService
  ) {
    super();
    this.setupIpcHandlers();
    this.setupInternalSubscriptions();
  }

  private setupInternalSubscriptions() {
    // UIHistoryService subscribes to all agent events for persistence
    this.subscribe('agent:event', (event) => {
      const actions = this.uiHistoryService.recordEvent(event.sessionId!, event.payload);
      
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        // 1. Send processed UI Action (for core UI like message list)
        actions.forEach(action => win.webContents.send('agent:ui-update', action));
        
        // 2. Send raw Agent Event (for auxiliary components like Banners, status lights, etc.)
        win.webContents.send('agent:event', { 
          sessionId: event.sessionId, 
          event: event.payload 
        });
      });
    });
  }

  private setupIpcHandlers() {
    // Take over IPC originally in AgentService
    ipcMain.handle('agent:startTask', async (_, sessionId: string, terminalId: string, userText: string) => {
      return this.dispatchTask(sessionId, userText, terminalId);
    });

    ipcMain.handle('agent:stopTask', async (_, sessionId: string) => {
      return this.stopTask(sessionId);
    });

    ipcMain.handle('agent:replyMessage', async (_, messageId: string, payload: any) => {
      console.log(`[GatewayService] Received replyMessage for messageId=${messageId}:`, payload);
      this.feedbackCache.set(messageId, payload);
      this.feedbackBus.emit(`feedback:${messageId}`, payload);
      return { ok: true };
    });

    ipcMain.handle('agent:deleteChatSession', async (_, sessionId: string) => {
      await this.stopTask(sessionId);
      this.agentService.deleteChatSession(sessionId);
      this.uiHistoryService.deleteSession(sessionId);
      this.sessions.delete(sessionId);
    });

    ipcMain.handle('agent:exportHistory', async (_, sessionId: string) => {
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

      const { dialog } = await import('electron');
      const baseName = safeFileBaseName(uiSession?.title || backendSession.title);
      const ts = formatTimestamp(new Date());
      const { filePath } = await dialog.showSaveDialog({
        title: 'Export Conversation History',
        defaultPath: `${baseName}_${ts}.json`,
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (filePath) {
        const fs = await import('fs');
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
    });

    // Forward other query-type IPCs
    ipcMain.handle('agent:getAllChatHistory', () => this.agentService.getAllChatHistory());
    ipcMain.handle('agent:loadChatSession', (_, id) => this.agentService.loadChatSession(id));
    ipcMain.handle('agent:getUiMessages', (_, id) => this.uiHistoryService.getMessages(id));
    ipcMain.handle('agent:rollbackToMessage', async (_, sessionId: string, messageId: string) => {
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
    ipcMain.handle('system:saveTempPaste', async (_, content: string) => {
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

    ipcMain.handle('skills:openFile', async (_evt, fileName: string) => {
      await this.skillService.openSkillFile(fileName);
    });

    ipcMain.handle('skills:delete', async (_evt, fileName: string) => {
      await this.skillService.deleteSkillFile(fileName);
      return await this.skillService.getAll();
    });

    ipcMain.handle('skills:setEnabled', async (_, name: string, enabled: boolean) => {
      // This will update settings via SettingsService internally
      const settings = (global as any).settingsService.getSettings();
      const nextSkills = { ...(settings.tools?.skills ?? {}) };
      nextSkills[name] = enabled;
      (global as any).settingsService.setSettings({ tools: { builtIn: settings.tools?.builtIn ?? {}, skills: nextSkills } });
      
      // Notify AgentService to refresh its tool definitions
      this.agentService.updateSettings((global as any).settingsService.getSettings());
      
      // Broadcast to all windows that skills have been updated
      const windows = BrowserWindow.getAllWindows();
      const enabledSkills = await this.skillService.getEnabledSkills();
      windows.forEach(win => {
        win.webContents.send('skills:updated', enabledSkills);
      });

      return enabledSkills;
    });

    ipcMain.handle('tools:setBuiltInEnabled', async (_, name: string, enabled: boolean) => {
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
  }

  async createSession(terminalId: string): Promise<string> {
    const sessionId = uuidv4();
    const context: SessionContext = {
      sessionId,
      boundTerminalId: terminalId,
      activeRunId: null,
      abortController: null,
      status: 'idle',
      metadata: {}
    };
    this.sessions.set(sessionId, context);
    return sessionId;
  }

  getSession(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  async dispatchTask(sessionId: string, input: string, terminalId?: string): Promise<void> {
    let context = this.sessions.get(sessionId);
    if (!context) {
      const tid = terminalId || this.terminalService.getAllTerminals()[0]?.id || '';
      context = {
        sessionId,
        boundTerminalId: tid,
        activeRunId: null,
        abortController: null,
        status: 'idle',
        metadata: {}
      };
      this.sessions.set(sessionId, context);
    }

    if (context.status !== 'idle') {
      await this.stopTask(sessionId);
    }

    const runId = uuidv4();
    const abortController = new AbortController();

    context.activeRunId = runId;
    context.abortController = abortController;
    context.status = 'running';

    try {
      // AgentService has been refactored as stateless run
      await this.agentService.run(context, input, abortController.signal);
    } catch (error: any) {
      console.error(`[GatewayService] Task execution error (sessionId=${sessionId}):`, error);
      if (this.agentService['helpers'].isAbortError(error)) {
        // User stopped manually, not treated as an error, handled by stopTask
        return;
      }
      // Error broadcasting is now handled inside agentService.run for better detail capture,
      // but we keep a fallback here just in case.
    } finally {
      if (context.activeRunId === runId) {
        // Unified cleanup of run state
        this.clearRunState(context);
        // 1. Send DONE action (for UI state like isThinking)
        this.broadcast({ type: 'agent:event', sessionId, payload: { type: 'done' } });
        // 2. Send SESSION_READY action (for admission control and queue scheduling)
        // This MUST be sent after clearRunState to ensure backend is truly idle
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(win => {
          win.webContents.send('agent:ui-update', { type: 'SESSION_READY', sessionId });
        });
        this.uiHistoryService.flush(sessionId);
      }
    }
  }

  async stopTask(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (context && context.abortController) {
      context.abortController.abort();
      this.clearRunState(context);
      // Sync UI and disk immediately when manually stopped
      this.broadcast({ type: 'agent:event', sessionId, payload: { type: 'done' } });
      
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        win.webContents.send('agent:ui-update', { type: 'SESSION_READY', sessionId });
      });
      
      this.uiHistoryService.flush(sessionId);
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

    // 2. Send to frontend
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      win.webContents.send('gateway:event', fullEvent);
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
