import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import type { IGatewayRuntime, GatewayEvent, GatewayEventType, SessionContext, IClientTransport, StartTaskOptions } from './types';
import type { TerminalService } from '../TerminalService';
import type { AgentService_v2 } from '../AgentService_v2';
import type { UIHistoryService } from '../UIHistoryService';
import type { CommandPolicyService } from '../CommandPolicy/CommandPolicyService';
import type { SettingsService } from '../SettingsService';
import type { McpToolService } from '../McpToolService';
import { getRunExperimentalFlagsFromSettings } from '../AgentHelper/utils/experimental_flags';
import { TransportHub } from './TransportHub';

export class GatewayService extends EventEmitter implements IGatewayRuntime {
  private sessions: Map<string, SessionContext> = new Map();
  private eventBus: EventEmitter = new EventEmitter();
  private feedbackBus: EventEmitter = new EventEmitter();
  private feedbackCache: Map<string, any> = new Map();
  private transportHub: TransportHub = new TransportHub();

  constructor(
    private terminalService: TerminalService,
    private agentService: AgentService_v2,
    private uiHistoryService: UIHistoryService,
    private commandPolicyService: CommandPolicyService,
    private settingsService: SettingsService,
    private mcpToolService: McpToolService
  ) {
    super();

    this.terminalService.setRawEventPublisher((channel, data) => this.broadcastRaw(channel, data));
    this.agentService.setEventPublisher((sessionId, event) => {
      this.broadcast({
        type: 'agent:event',
        sessionId,
        payload: event
      });
    });
    this.agentService.setFeedbackWaiter((messageId, timeoutMs) => this.waitForFeedback(messageId, timeoutMs));
    this.commandPolicyService.setFeedbackWaiter((messageId, timeoutMs) =>
      this.waitForFeedback(messageId, timeoutMs)
    );
    
    this.setupInternalSubscriptions();
    this.setupServiceSubscriptions();
  }

  public registerTransport(transport: IClientTransport) {
    this.transportHub.register(transport);
  }

  public unregisterTransport(transportId: string) {
    this.transportHub.unregister(transportId);
  }

  private setupServiceSubscriptions() {
    // MCP tool status updates
    this.mcpToolService.on('updated', (summary) => {
      this.transportHub.send('tools:mcpUpdated', summary);
    });
  }

  private setupInternalSubscriptions() {
    // UIHistoryService subscribes to all agent events for persistence
    this.subscribe('agent:event', (event) => {
      const actions = this.uiHistoryService.recordEvent(event.sessionId!, event.payload);
      
      // 1. Send processed UI Actions (for core UI like message list)
      actions.forEach(action => this.transportHub.sendUIUpdate(action));
      // 2. Send raw Agent Event (for auxiliary components like Banners, status lights, etc.)
      this.transportHub.emitEvent(event);
    });
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
      if (this.agentService['helpers'].isAbortError(error)) {
        // User stopped manually, not treated as an error, handled by stopTask
        return;
      }
      console.error(`[GatewayService] Task execution error (sessionId=${sessionId}):`, error);
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
        this.transportHub.sendUIUpdate({ type: 'SESSION_READY', sessionId });
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
        this.transportHub.sendUIUpdate({ type: 'SESSION_READY', sessionId });
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

  async waitForRunCompletion(sessionId: string): Promise<void> {
    await this.waitForRunCompletionIfAny(sessionId);
  }

  submitFeedback(messageId: string, payload: any): { ok: true } {
    this.feedbackCache.set(messageId, payload);
    this.feedbackBus.emit(`feedback:${messageId}`, payload);
    return { ok: true };
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    await this.stopTask(sessionId);
    this.agentService.deleteChatSession(sessionId);
    this.uiHistoryService.deleteSession(sessionId);
    this.sessions.delete(sessionId);
  }

  renameSession(sessionId: string, newTitle: string): void {
    this.agentService.renameChatSession(sessionId, newTitle);
  }

  async rollbackSessionToMessage(
    sessionId: string,
    messageId: string
  ): Promise<{ ok: boolean; removedCount: number }> {
    await this.stopTask(sessionId);
    this.broadcast({
      type: 'agent:event',
      sessionId,
      payload: {
        type: 'rollback',
        messageId
      }
    });
    return this.agentService.rollbackToMessage(sessionId, messageId);
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

    // 2. Send to frontend via all transports.
    // agent:event is emitted by the internal subscription path after UI action generation,
    // so we skip direct fan-out here to avoid duplicate delivery.
    if (fullEvent.type !== 'agent:event') {
      this.transportHub.emitEvent(fullEvent);
    }
  }

  // Raw data distribution for non-GatewayEvent messages (e.g. terminal data)
  broadcastRaw(channel: string, data: any): void {
    this.transportHub.send(channel, data);
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
