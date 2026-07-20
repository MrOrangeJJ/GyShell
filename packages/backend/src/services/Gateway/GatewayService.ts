import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import type {
  IGatewayRuntime,
  GatewayEvent,
  GatewayEventType,
  SessionContext,
  IClientTransport,
  StartTaskOptions,
  StartTaskInput,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
} from "./types";
import type { UIHistoryService } from "../UIHistoryService";
import type { UIUpdateAction } from "../../types/ui-chat";
import type {
  IAgentRuntime,
  ICommandPolicyRuntime,
  IGatewayTerminalRuntime,
  IMcpRuntime,
  ISettingsRuntime,
} from "../runtimeContracts";
import { getRunExperimentalFlagsFromSettings } from "../AgentHelper/utils/experimental_flags";
import {
  type QueuedAgentInsertion,
  type QueuedAgentInsertionInput,
  type RunBackgroundExecCommand,
  type RunBackgroundExecCommandInput,
  type RunBackgroundFileTransfer,
  type RunBackgroundFileTransferInput,
} from "../AgentHelper/queuedInsertions";
import { TransportHub } from "./TransportHub";

type QueuedInsertionWaiterEntry = {
  sessionId: string;
  resolve: (available: boolean) => void;
  cleanup: () => void;
};

export interface GatewayRunStateSnapshot {
  activeSessionIds: string[];
  activeCount: number;
}

type GatewayRunStateListener = (snapshot: GatewayRunStateSnapshot) => void;

export class GatewayService extends EventEmitter implements IGatewayRuntime {
  private sessions: Map<string, SessionContext> = new Map();
  private eventBus: EventEmitter = new EventEmitter();
  private feedbackBus: EventEmitter = new EventEmitter();
  private feedbackCache: Map<string, any> = new Map();
  private transportHub: TransportHub = new TransportHub();
  private queuedInsertionsByAgentRun: Map<string, QueuedAgentInsertion[]> =
    new Map();
  private queuedInsertionWaitersByAgentRun: Map<
    string,
    Set<QueuedInsertionWaiterEntry>
  > = new Map();
  private backgroundExecCommandsByAgentRun: Map<
    string,
    Map<string, RunBackgroundExecCommand>
  > = new Map();
  private backgroundFileTransfersByAgentRun: Map<
    string,
    Map<string, RunBackgroundFileTransfer>
  > = new Map();
  private runStateListeners: Set<GatewayRunStateListener> = new Set();
  private registeredRendererSessionOwners: Map<string, Set<string>> = new Map();
  private deletedSessionIds: Set<string> = new Set();
  private uiRevision = 0;
  private lastRunStateKey = "";

  constructor(
    private terminalService: IGatewayTerminalRuntime,
    private agentService: IAgentRuntime,
    private uiHistoryService: UIHistoryService,
    private commandPolicyService: ICommandPolicyRuntime,
    private settingsService: ISettingsRuntime,
    private mcpToolService: IMcpRuntime,
  ) {
    super();

    this.terminalService.setRawEventPublisher((channel, data) =>
      this.broadcastRaw(channel, data),
    );
    this.agentService.setEventPublisher((sessionId, event) => {
      this.broadcast({
        type: "agent:event",
        sessionId,
        payload: event,
      });
    });
    this.agentService.setFeedbackWaiter((messageId, timeoutMs) =>
      this.waitForFeedback(messageId, timeoutMs),
    );
    this.agentService.setQueuedInsertionProvider?.((sessionId, agentRunId) =>
      this.peekQueuedInsertions(sessionId, agentRunId),
    );
    this.agentService.setQueuedInsertionAcknowledger?.(
      (sessionId, agentRunId, itemIds) =>
        this.acknowledgeQueuedInsertions(sessionId, agentRunId, itemIds),
    );
    this.agentService.setQueuedInsertionAvailabilityWaiter?.(
      (sessionId, agentRunId, signal) =>
        this.waitForQueuedInsertion(sessionId, agentRunId, signal),
    );
    this.agentService.setQueuedInsertionEnqueuer?.((sessionId, insertion) =>
      this.enqueueQueuedInsertion(sessionId, insertion),
    );
    this.agentService.setBackgroundExecCommandRegistrar?.(
      (sessionId, command) =>
        this.registerBackgroundExecCommand(sessionId, command),
    );
    this.agentService.setBackgroundExecCommandCompleter?.(
      (sessionId, command) =>
        this.completeBackgroundExecCommand(sessionId, command),
    );
    this.agentService.setUnfinishedBackgroundExecCommandProvider?.(
      (sessionId, agentRunId) =>
        this.consumeUnfinishedBackgroundExecCommands(sessionId, agentRunId),
    );
    this.agentService.setBackgroundFileTransferRegistrar?.(
      (sessionId, transfer) =>
        this.registerBackgroundFileTransfer(sessionId, transfer),
    );
    this.agentService.setBackgroundFileTransferCompleter?.(
      (sessionId, transfer) =>
        this.completeBackgroundFileTransfer(sessionId, transfer),
    );
    this.agentService.setUnfinishedBackgroundFileTransferProvider?.(
      (sessionId, agentRunId) =>
        this.consumeUnfinishedBackgroundFileTransfers(sessionId, agentRunId),
    );
    this.commandPolicyService.setFeedbackWaiter((messageId, timeoutMs) =>
      this.waitForFeedback(messageId, timeoutMs),
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

  public onRunStateChanged(listener: GatewayRunStateListener): () => void {
    this.runStateListeners.add(listener);
    listener(this.getRunStateSnapshot());
    return () => this.runStateListeners.delete(listener);
  }

  private setupServiceSubscriptions() {
    // MCP tool status updates
    this.mcpToolService.on("updated", (summary) => {
      this.transportHub.send("tools:mcpUpdated", summary);
    });
  }

  private setupInternalSubscriptions() {
    // UIHistoryService subscribes to all agent events for persistence
    this.subscribe("agent:event", (event) => {
      const sessionId = String(event.sessionId || "").trim();
      if (!sessionId || this.deletedSessionIds.has(sessionId)) {
        return;
      }
      const actions = this.uiHistoryService.recordEvent(
        sessionId,
        event.payload,
      );

      // 1. Send processed UI Actions (for core UI like message list)
      actions.forEach((action) => this.sendUIUpdate(action));
      // 2. Send raw Agent Event (for auxiliary components like Banners, status lights, etc.)
      this.transportHub.emitEvent(event);
      const commandOutput = event.payload.commandOutput;
      if (
        event.payload.type === "command_finished" &&
        event.payload.isNowait === true &&
        commandOutput !== undefined
      ) {
        // Every typed background transition is its own durability boundary.
        // In particular, a manual stop clears the foreground run before the
        // exec_command AbortError handler can publish its still-running
        // replacement. Relying on dispatchTask's finally-flush would then
        // leave that late running snapshot dirty only in memory. Persist both
        // the running handoff and the eventual settled replacement so a
        // restart can conservatively recover either state.
        try {
          this.uiHistoryService.flush(sessionId, {
            preserveLiveTransientState: true,
          });
        } catch (error) {
          console.error(
            `[GatewayService] Failed to persist background command transition for ${sessionId}:`,
            error,
          );
        }
      }
    });
  }

  private sendUIUpdate(action: UIUpdateAction): void {
    this.uiRevision += 1;
    this.transportHub.sendUIUpdate({
      ...action,
      uiRevision: this.uiRevision,
    } satisfies UIUpdateAction);
  }

  getUiRevision(): number {
    return this.uiRevision;
  }

  async createSession(): Promise<string> {
    const sessionId = uuidv4();
    this.deletedSessionIds.delete(sessionId);
    const context = this.createEmptySessionContext(sessionId);
    this.sessions.set(sessionId, context);
    return sessionId;
  }

  registerSession(sessionId: string, ownerId = "renderer"): void {
    const normalizedSessionId = String(sessionId || "").trim();
    const normalizedOwnerId = String(ownerId || "").trim() || "renderer";
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }
    if (this.deletedSessionIds.has(normalizedSessionId)) {
      throw new Error(`Session has been deleted: ${normalizedSessionId}`);
    }
    const owners =
      this.registeredRendererSessionOwners.get(normalizedSessionId) ||
      new Set<string>();
    owners.add(normalizedOwnerId);
    this.registeredRendererSessionOwners.set(normalizedSessionId, owners);
  }

  unregisterSession(sessionId: string, ownerId = "renderer"): void {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return;
    const owners =
      this.registeredRendererSessionOwners.get(normalizedSessionId);
    if (!owners) return;
    owners.delete(String(ownerId || "").trim() || "renderer");
    if (owners.size === 0) {
      this.registeredRendererSessionOwners.delete(normalizedSessionId);
    }
  }

  unregisterSessionOwner(ownerId: string): void {
    const normalizedOwnerId = String(ownerId || "").trim();
    if (!normalizedOwnerId) return;
    this.registeredRendererSessionOwners.forEach((owners, sessionId) => {
      owners.delete(normalizedOwnerId);
      if (owners.size === 0) {
        this.registeredRendererSessionOwners.delete(sessionId);
      }
    });
  }

  getSession(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  async dispatchTask(
    sessionId: string,
    input: StartTaskInput,
    options?: StartTaskOptions,
  ): Promise<void> {
    if (this.deletedSessionIds.has(sessionId)) {
      throw new Error(`Session has been deleted: ${sessionId}`);
    }
    let context = this.sessions.get(sessionId);
    if (!context) {
      context = this.createEmptySessionContext(sessionId);
      this.sessions.set(sessionId, context);
    }

    this.ensureSessionProfileLock(context);
    const preserveAgentRun =
      context.status !== "idle" && options?.startMode === "inserted";
    const inheritedAgentRunId = preserveAgentRun
      ? this.getContextAgentRunId(context) || uuidv4()
      : undefined;
    if (inheritedAgentRunId) {
      context.metadata.agentRunId = inheritedAgentRunId;
      context.metadata.agentRunRestartInProgress = inheritedAgentRunId;
    }

    if (context.status !== "idle") {
      await this.stopTask(sessionId, {
        waitForCompletion: true,
        preserveProfileLock: true,
        preserveAgentRun,
      });
    } else {
      // Handle race: status already idle but previous run finalization not finished yet.
      await this.waitForRunCompletionIfAny(sessionId);
    }

    const runId = uuidv4();
    const agentRunId = inheritedAgentRunId || uuidv4();
    const abortController = new AbortController();
    let resolveRunCompletion: () => void = () => {};
    const runCompletion = new Promise<void>((resolve) => {
      resolveRunCompletion = resolve;
    });

    context.activeRunId = runId;
    context.abortController = abortController;
    context.status = "running";
    context.metadata.runCompletion = runCompletion;
    context.metadata.runId = runId;
    context.metadata.agentRunId = agentRunId;
    if (context.metadata.agentRunRestartInProgress === agentRunId) {
      delete context.metadata.agentRunRestartInProgress;
    }
    this.publishRunStateChanged();

    try {
      // AgentService has been refactored as stateless run
      await this.agentService.run(
        context,
        input,
        abortController.signal,
        options?.startMode || "normal",
      );
    } catch (error: any) {
      const isAbortError =
        typeof this.agentService.isAbortError === "function"
          ? this.agentService.isAbortError(error)
          : error instanceof Error &&
            (error.name === "AbortError" || error.message === "AbortError");
      if (isAbortError) {
        // User stopped manually, not treated as an error, handled by stopTask
        return;
      }
      console.error(
        `[GatewayService] Task execution error (sessionId=${sessionId}):`,
        error,
      );
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
        this.cleanupAgentRun(agentRunId);
        this.clearRunState(context);
        this.releaseSessionProfileLock(context);
        if (context.metadata.agentRunId === agentRunId) {
          delete context.metadata.agentRunId;
        }
        if (context.metadata.agentRunRestartInProgress === agentRunId) {
          delete context.metadata.agentRunRestartInProgress;
        }
        // 1. Send DONE action (for UI state like isThinking)
        this.broadcast({
          type: "agent:event",
          sessionId,
          payload: { type: "done" },
        });
        // 2. Send SESSION_READY action (for admission control and queue scheduling)
        // This MUST be sent after clearRunState to ensure backend is truly idle
        this.sendUIUpdate({ type: "SESSION_READY", sessionId });
        this.uiHistoryService.flush(sessionId);
      }
    }
  }

  async stopTask(
    sessionId: string,
    options?: {
      waitForCompletion?: boolean;
      preserveProfileLock?: boolean;
      preserveAgentRun?: boolean;
    },
  ): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (context && context.abortController) {
      const runCompletion = context.metadata.runCompletion as
        | Promise<void>
        | undefined;
      const agentRunId = this.getContextAgentRunId(context);
      context.abortController.abort();
      this.clearRunState(context);
      if (!options?.preserveAgentRun) {
        this.cleanupAgentRun(agentRunId);
        if (agentRunId && context.metadata.agentRunId === agentRunId) {
          delete context.metadata.agentRunId;
        }
        if (
          agentRunId &&
          context.metadata.agentRunRestartInProgress === agentRunId
        ) {
          delete context.metadata.agentRunRestartInProgress;
        }
      }
      if (!options?.preserveProfileLock) {
        this.releaseSessionProfileLock(context);
      }
      // Sync UI and disk immediately on a real stop.
      // For inserted-message restart flow, dispatchTask will continue with a new run immediately,
      // so we intentionally avoid emitting SESSION_READY here.
      if (!options?.preserveProfileLock) {
        this.broadcast({
          type: "agent:event",
          sessionId,
          payload: { type: "done" },
        });
        this.sendUIUpdate({ type: "SESSION_READY", sessionId });
        this.uiHistoryService.flush(sessionId);
      }
      if (options?.waitForCompletion && runCompletion) {
        await runCompletion.catch(() => undefined);
      }
      return;
    }
    if (context && options?.waitForCompletion) {
      const runCompletion = context.metadata.runCompletion as
        | Promise<void>
        | undefined;
      if (runCompletion) {
        await runCompletion.catch(() => undefined);
      }
    }
  }

  async waitForRunCompletion(sessionId: string): Promise<void> {
    await this.waitForRunCompletionIfAny(sessionId);
  }

  listSessionSummaries(): GatewaySessionSummary[] {
    const uiRevision = this.uiRevision;
    const uiSummaryById = new Map(
      this.uiHistoryService
        .getAllSessionSummaries()
        .map((session) => [session.id, session] as const),
    );
    const storedById = new Map(
      this.agentService
        .listStoredChatSessionSummaries()
        .map((session) => [session.id, session] as const),
    );
    const knownSessionIds = new Set<string>([
      ...uiSummaryById.keys(),
      ...storedById.keys(),
      ...this.sessions.keys(),
    ]);

    return Array.from(knownSessionIds)
      .map((sessionId) => {
        const uiSummary = uiSummaryById.get(sessionId);
        const storedSession = storedById.get(sessionId);
        const context = this.sessions.get(sessionId);
        const isBusy = context ? context.status !== "idle" : false;
        const lockedProfileId =
          isBusy && context ? context.lockedProfileId || null : null;

        return {
          id: sessionId,
          title: this.resolveSessionTitle(
            uiSummary?.title,
            storedSession?.title,
            context,
          ),
          updatedAt: this.resolveSessionUpdatedAt(
            uiSummary?.updatedAt,
            storedSession?.updatedAt,
            context,
          ),
          messagesCount: this.resolveSessionMessageCount(
            uiSummary,
            storedSession,
          ),
          lastMessagePreview: this.normalizeSessionPreview(
            uiSummary?.lastMessagePreview || "",
          ),
          isBusy,
          lockedProfileId,
          uiRevision,
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getSessionSnapshot(sessionId: string): GatewaySessionSnapshot | null {
    const session = this.uiHistoryService.getSession(sessionId);
    const storedSession = this.agentService.exportChatSession(sessionId);
    const context = this.sessions.get(sessionId);
    if (!session && !storedSession && !context) return null;

    const resolvedSessionId = session?.id || storedSession?.id || sessionId;
    const isBusy = context ? context.status !== "idle" : false;
    const lockedProfileId = isBusy ? context?.lockedProfileId || null : null;
    return {
      id: resolvedSessionId,
      title: this.resolveSessionTitle(
        session?.title,
        storedSession?.title,
        context,
      ),
      updatedAt: this.resolveSessionUpdatedAt(
        session?.updatedAt,
        storedSession?.updatedAt,
        context,
      ),
      messages: (session?.messages || []).map((message) => ({
        ...message,
        metadata: message.metadata ? { ...message.metadata } : undefined,
      })),
      isBusy,
      lockedProfileId,
      uiRevision: this.uiRevision,
    };
  }

  submitFeedback(messageId: string, payload: any): { ok: true } {
    this.feedbackCache.set(messageId, payload);
    this.feedbackBus.emit(`feedback:${messageId}`, payload);
    const decision = payload?.decision;
    if (decision === "allow" || decision === "deny") {
      const update = this.uiHistoryService.recordFeedbackDecision(
        messageId,
        decision,
      );
      if (update) this.sendUIUpdate(update);
    }
    return { ok: true };
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    const wasAlreadyDeleted = this.deletedSessionIds.has(sessionId);
    this.deletedSessionIds.add(sessionId);
    try {
      await this.stopTask(sessionId);
      this.agentService.deleteChatSession(sessionId);
    } catch (error) {
      if (!wasAlreadyDeleted) {
        this.deletedSessionIds.delete(sessionId);
      }
      throw error;
    }
    this.sessions.delete(sessionId);
    this.registeredRendererSessionOwners.delete(sessionId);
    this.cleanupSessionAgentRuns(sessionId);
  }

  async deleteChatSessions(sessionIds: string[]): Promise<void> {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) {
      return;
    }
    const newlyTombstonedIds = ids.filter(
      (id) => !this.deletedSessionIds.has(id),
    );
    ids.forEach((id) => this.deletedSessionIds.add(id));
    try {
      await Promise.all(ids.map((id) => this.stopTask(id)));
      this.agentService.deleteChatSessions(ids);
    } catch (error) {
      newlyTombstonedIds.forEach((id) => this.deletedSessionIds.delete(id));
      throw error;
    }
    ids.forEach((id) => {
      this.sessions.delete(id);
      this.registeredRendererSessionOwners.delete(id);
      this.cleanupSessionAgentRuns(id);
    });
  }

  renameSession(sessionId: string, newTitle: string): void {
    const normalizedSessionId = String(sessionId || "").trim();
    const isRegistered =
      (this.registeredRendererSessionOwners.get(normalizedSessionId)?.size ||
        0) > 0;
    if (
      !normalizedSessionId ||
      this.deletedSessionIds.has(normalizedSessionId) ||
      (!isRegistered && !this.getSessionSnapshot(normalizedSessionId))
    ) {
      throw new Error(`Session not found: ${normalizedSessionId || sessionId}`);
    }

    this.agentService.renameChatSession(normalizedSessionId, newTitle);
    this.sendUIUpdate({
      type: "SESSION_RENAMED",
      sessionId: normalizedSessionId,
      title: newTitle,
    } satisfies UIUpdateAction);
  }

  async rollbackSessionToMessage(
    sessionId: string,
    messageId: string,
  ): Promise<{ ok: boolean; removedCount: number }> {
    await this.stopTask(sessionId);
    this.broadcast({
      type: "agent:event",
      sessionId,
      payload: {
        type: "rollback",
        messageId,
      },
    });
    return this.agentService.rollbackToMessage(sessionId, messageId);
  }

  async branchSessionFromMessage(
    sessionId: string,
    messageId: string,
  ): Promise<{
    ok: boolean;
    sessionId?: string;
    title?: string;
    messageCount?: number;
    reason?: string;
  }> {
    const sourceContext = this.sessions.get(sessionId);
    if (sourceContext && sourceContext.status !== "idle") {
      return {
        ok: false,
        reason: "Cannot branch a session while it is running.",
      };
    }

    const branchSessionId = uuidv4();
    this.sessions.set(
      branchSessionId,
      this.createEmptySessionContext(branchSessionId),
    );
    const result = this.agentService.branchFromMessage(
      sessionId,
      messageId,
      branchSessionId,
    );
    if (!result.ok) {
      this.sessions.delete(branchSessionId);
    }
    return result;
  }

  private async waitForRunCompletionIfAny(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (!context) return;
    const runCompletion = context.metadata.runCompletion as
      | Promise<void>
      | undefined;
    if (runCompletion) {
      await runCompletion.catch(() => undefined);
    }
  }

  private enqueueQueuedInsertion(
    sessionId: string,
    insertion: QueuedAgentInsertionInput,
  ): void {
    const content = String(insertion.content || "").trim();
    if (!content) return;
    const agentRunId = insertion.originAgentRunId;
    if (!agentRunId || !this.isAgentRunAcceptingEvents(sessionId, agentRunId)) {
      return;
    }

    const current = this.queuedInsertionsByAgentRun.get(agentRunId) || [];
    if (
      insertion.dedupeKey &&
      current.some((item) => item.dedupeKey === insertion.dedupeKey)
    ) {
      return;
    }

    current.push({
      ...insertion,
      content,
      id: uuidv4(),
      sessionId,
      agentRunId,
      createdAt: Date.now(),
    });
    this.queuedInsertionsByAgentRun.set(agentRunId, current);
    this.resolveQueuedInsertionWaiters(sessionId, agentRunId, true);
  }

  private peekQueuedInsertions(
    sessionId: string,
    agentRunId: string,
  ): QueuedAgentInsertion[] {
    if (!this.isAgentRunAcceptingEvents(sessionId, agentRunId)) return [];
    return [...(this.queuedInsertionsByAgentRun.get(agentRunId) || [])];
  }

  private acknowledgeQueuedInsertions(
    sessionId: string,
    agentRunId: string,
    itemIds: string[],
  ): void {
    if (!this.isAgentRunAcceptingEvents(sessionId, agentRunId)) return;
    const ids = new Set(itemIds.filter(Boolean));
    if (ids.size === 0) return;
    const items = this.queuedInsertionsByAgentRun.get(agentRunId) || [];
    const remaining = items.filter((item) => !ids.has(item.id));
    if (remaining.length > 0) {
      this.queuedInsertionsByAgentRun.set(agentRunId, remaining);
    } else {
      this.queuedInsertionsByAgentRun.delete(agentRunId);
    }
  }

  private waitForQueuedInsertion(
    sessionId: string,
    agentRunId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.isAgentRunAcceptingEvents(sessionId, agentRunId)) {
      return Promise.resolve(false);
    }
    if ((this.queuedInsertionsByAgentRun.get(agentRunId)?.length || 0) > 0) {
      return Promise.resolve(true);
    }
    if (signal?.aborted) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let entry!: QueuedInsertionWaiterEntry;
      const onAbort = () => {
        entry.cleanup();
        resolve(false);
      };
      entry = {
        sessionId,
        resolve,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
          const waiters = this.queuedInsertionWaitersByAgentRun.get(agentRunId);
          if (!waiters) return;
          waiters.delete(entry);
          if (waiters.size === 0) {
            this.queuedInsertionWaitersByAgentRun.delete(agentRunId);
          }
        },
      };

      const waiters =
        this.queuedInsertionWaitersByAgentRun.get(agentRunId) || new Set();
      waiters.add(entry);
      this.queuedInsertionWaitersByAgentRun.set(agentRunId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private resolveQueuedInsertionWaiters(
    sessionId: string,
    agentRunId: string,
    available: boolean,
  ): void {
    const waiters = this.queuedInsertionWaitersByAgentRun.get(agentRunId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (sessionId && waiter.sessionId !== sessionId) continue;
      waiter.cleanup();
      waiter.resolve(available);
    }
  }

  private registerBackgroundExecCommand(
    sessionId: string,
    command: RunBackgroundExecCommandInput,
  ): void {
    const agentRunId = command.originAgentRunId;
    if (!agentRunId || !this.isAgentRunAcceptingEvents(sessionId, agentRunId)) {
      return;
    }
    const current =
      this.backgroundExecCommandsByAgentRun.get(agentRunId) ||
      new Map<string, RunBackgroundExecCommand>();
    const existing = current.get(command.historyCommandMatchId);
    current.set(command.historyCommandMatchId, {
      ...existing,
      ...command,
      id: command.historyCommandMatchId,
      sessionId,
      agentRunId,
      createdAt: existing?.createdAt || Date.now(),
      completedAt: existing?.completedAt,
      exitCode: existing?.exitCode,
      guardNotifiedAt: existing?.guardNotifiedAt,
    });
    this.backgroundExecCommandsByAgentRun.set(agentRunId, current);
  }

  private completeBackgroundExecCommand(
    sessionId: string,
    command: RunBackgroundExecCommandInput & { exitCode?: number },
  ): void {
    const agentRunId = command.originAgentRunId;
    if (!agentRunId || !this.isAgentRunAcceptingEvents(sessionId, agentRunId)) {
      return;
    }
    const current =
      this.backgroundExecCommandsByAgentRun.get(agentRunId) ||
      new Map<string, RunBackgroundExecCommand>();
    const existing = current.get(command.historyCommandMatchId);
    current.set(command.historyCommandMatchId, {
      ...existing,
      ...command,
      id: command.historyCommandMatchId,
      sessionId,
      agentRunId,
      createdAt: existing?.createdAt || Date.now(),
      completedAt: Date.now(),
      exitCode: command.exitCode,
      guardNotifiedAt: existing?.guardNotifiedAt,
    });
    this.backgroundExecCommandsByAgentRun.set(agentRunId, current);
  }

  private consumeUnfinishedBackgroundExecCommands(
    sessionId: string,
    agentRunId: string,
  ): RunBackgroundExecCommand[] {
    if (!this.isAgentRunAcceptingEvents(sessionId, agentRunId)) return [];
    const current = this.backgroundExecCommandsByAgentRun.get(agentRunId);
    if (!current) return [];
    const now = Date.now();
    const unfinished = Array.from(current.values()).filter(
      (command) => !command.completedAt && !command.guardNotifiedAt,
    );
    unfinished.forEach((command) => {
      command.guardNotifiedAt = now;
      current.set(command.historyCommandMatchId, command);
    });
    return unfinished;
  }

  private registerBackgroundFileTransfer(
    sessionId: string,
    transfer: RunBackgroundFileTransferInput,
  ): void {
    const agentRunId = transfer.originAgentRunId;
    if (!agentRunId || !this.isAgentRunAcceptingEvents(sessionId, agentRunId)) {
      return;
    }
    const current =
      this.backgroundFileTransfersByAgentRun.get(agentRunId) ||
      new Map<string, RunBackgroundFileTransfer>();
    const existing = current.get(transfer.transferId);
    current.set(transfer.transferId, {
      ...existing,
      ...transfer,
      id: transfer.transferId,
      sessionId,
      agentRunId,
      createdAt: existing?.createdAt || Date.now(),
      completedAt: existing?.completedAt,
      status: existing?.status,
      error: existing?.error,
      guardNotifiedAt: existing?.guardNotifiedAt,
    });
    this.backgroundFileTransfersByAgentRun.set(agentRunId, current);
  }

  private completeBackgroundFileTransfer(
    sessionId: string,
    transfer: RunBackgroundFileTransferInput & {
      status?: string;
      error?: string;
    },
  ): void {
    const agentRunId = transfer.originAgentRunId;
    if (!agentRunId || !this.isAgentRunAcceptingEvents(sessionId, agentRunId)) {
      return;
    }
    const current =
      this.backgroundFileTransfersByAgentRun.get(agentRunId) ||
      new Map<string, RunBackgroundFileTransfer>();
    const existing = current.get(transfer.transferId);
    current.set(transfer.transferId, {
      ...existing,
      ...transfer,
      id: transfer.transferId,
      sessionId,
      agentRunId,
      createdAt: existing?.createdAt || Date.now(),
      completedAt: Date.now(),
      status: transfer.status,
      error: transfer.error,
      guardNotifiedAt: existing?.guardNotifiedAt,
    });
    this.backgroundFileTransfersByAgentRun.set(agentRunId, current);
  }

  private consumeUnfinishedBackgroundFileTransfers(
    sessionId: string,
    agentRunId: string,
  ): RunBackgroundFileTransfer[] {
    if (!this.isAgentRunAcceptingEvents(sessionId, agentRunId)) return [];
    const current = this.backgroundFileTransfersByAgentRun.get(agentRunId);
    if (!current) return [];
    const now = Date.now();
    const unfinished = Array.from(current.values()).filter(
      (transfer) => !transfer.completedAt && !transfer.guardNotifiedAt,
    );
    unfinished.forEach((transfer) => {
      transfer.guardNotifiedAt = now;
      current.set(transfer.transferId, transfer);
    });
    return unfinished;
  }

  private isAgentRunAcceptingEvents(
    sessionId: string,
    agentRunId: string,
  ): boolean {
    const context = this.sessions.get(sessionId);
    if (!context) return false;
    return (
      context.metadata.agentRunId === agentRunId ||
      context.metadata.agentRunRestartInProgress === agentRunId
    );
  }

  private getContextAgentRunId(context: SessionContext): string | undefined {
    return typeof context.metadata.agentRunId === "string"
      ? context.metadata.agentRunId
      : undefined;
  }

  private cleanupAgentRun(agentRunId: string | undefined): void {
    if (!agentRunId) return;
    this.queuedInsertionsByAgentRun.delete(agentRunId);
    this.resolveQueuedInsertionWaiters("", agentRunId, false);
    this.queuedInsertionWaitersByAgentRun.delete(agentRunId);
    this.backgroundExecCommandsByAgentRun.delete(agentRunId);
    this.backgroundFileTransfersByAgentRun.delete(agentRunId);
  }

  private cleanupSessionAgentRuns(sessionId: string): void {
    for (const [agentRunId, items] of this.queuedInsertionsByAgentRun) {
      if (items.some((item) => item.sessionId === sessionId)) {
        this.queuedInsertionsByAgentRun.delete(agentRunId);
      }
    }
    for (const [agentRunId, commands] of this
      .backgroundExecCommandsByAgentRun) {
      if (
        Array.from(commands.values()).some(
          (item) => item.sessionId === sessionId,
        )
      ) {
        this.backgroundExecCommandsByAgentRun.delete(agentRunId);
      }
    }
    for (const [agentRunId, transfers] of this
      .backgroundFileTransfersByAgentRun) {
      if (
        Array.from(transfers.values()).some(
          (item) => item.sessionId === sessionId,
        )
      ) {
        this.backgroundFileTransfersByAgentRun.delete(agentRunId);
      }
    }
  }

  private clearRunState(context: SessionContext) {
    const wasActive = context.status !== "idle";
    context.status = "idle";
    context.activeRunId = null;
    context.abortController = null;
    // Clean up cache for this session's messages if any remain
    // (In a real scenario, we might need a way to map messageId to sessionId here,
    // but for now, the cache is self-cleaning on read)
    if (wasActive) {
      this.publishRunStateChanged();
    }
  }

  private releaseSessionProfileLock(context: SessionContext) {
    if (context.lockedProfileId) {
      this.agentService.releaseSessionModelBinding(context.sessionId);
    }
    context.lockedProfileId = null;
    context.lockedExperimentalFlags = null;
  }

  private createEmptySessionContext(sessionId: string): SessionContext {
    return {
      sessionId,
      activeRunId: null,
      lockedProfileId: null,
      lockedExperimentalFlags: null,
      abortController: null,
      status: "idle",
      metadata: {
        createdAt: Date.now(),
      },
    };
  }

  private resolveSessionTitle(
    uiTitle?: string,
    storedTitle?: string,
    context?: SessionContext,
  ): string {
    const preferredTitle = [uiTitle, storedTitle].find(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    if (preferredTitle) {
      return preferredTitle;
    }
    if (context) {
      return "New Chat";
    }
    return "Recovered Session";
  }

  private resolveSessionUpdatedAt(
    uiUpdatedAt?: number,
    storedUpdatedAt?: number,
    context?: SessionContext,
  ): number {
    if (typeof uiUpdatedAt === "number" && Number.isFinite(uiUpdatedAt)) {
      return uiUpdatedAt;
    }
    if (
      typeof storedUpdatedAt === "number" &&
      Number.isFinite(storedUpdatedAt)
    ) {
      return storedUpdatedAt;
    }
    const contextCreatedAt = context?.metadata?.createdAt;
    if (
      typeof contextCreatedAt === "number" &&
      Number.isFinite(contextCreatedAt)
    ) {
      return contextCreatedAt;
    }
    return Date.now();
  }

  private resolveSessionMessageCount(
    uiSummary: { messagesCount?: number } | undefined,
    storedSession?: { messages?: unknown[]; messagesCount?: number },
  ): number {
    if (
      typeof uiSummary?.messagesCount === "number" &&
      Number.isFinite(uiSummary.messagesCount)
    ) {
      return uiSummary.messagesCount;
    }
    if (
      typeof storedSession?.messagesCount === "number" &&
      Number.isFinite(storedSession.messagesCount)
    ) {
      return storedSession.messagesCount;
    }
    if (Array.isArray(storedSession?.messages)) {
      return storedSession.messages.length;
    }
    return 0;
  }

  private ensureSessionProfileLock(context: SessionContext): void {
    if (context.lockedProfileId) return;
    const settings = this.settingsService.getSettings();
    context.lockedProfileId = settings.models.activeProfileId || "";
    context.lockedExperimentalFlags =
      getRunExperimentalFlagsFromSettings(settings);
    this.sendUIUpdate({
      type: "SESSION_PROFILE_LOCKED",
      sessionId: context.sessionId,
      lockedProfileId: context.lockedProfileId || null,
    });
  }

  async pauseTask(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (context && context.status !== "paused") {
      context.status = "paused";
      this.publishRunStateChanged();
    }
  }

  async resumeTask(_sessionId: string): Promise<void> {
    // Future implementation of re-trigger logic
  }

  // Event distribution method, renamed to broadcast to avoid conflict with EventEmitter's emit
  broadcast(event: Omit<GatewayEvent, "id" | "timestamp">): void {
    const fullEvent: GatewayEvent = {
      ...event,
      id: uuidv4(),
      timestamp: Date.now(),
    };

    // 1. Internal bus distribution (for other Services like UIHistoryService)
    this.eventBus.emit(fullEvent.type, fullEvent);

    // 2. Send to frontend via all transports.
    // agent:event is emitted by the internal subscription path after UI action generation,
    // so we skip direct fan-out here to avoid duplicate delivery.
    if (fullEvent.type !== "agent:event") {
      this.transportHub.emitEvent(fullEvent);
    }
  }

  // Raw data distribution for non-GatewayEvent messages (e.g. terminal data)
  broadcastRaw(channel: string, data: any): void {
    this.transportHub.send(channel, data);
  }

  subscribe(
    type: GatewayEventType,
    handler: (event: GatewayEvent) => void,
  ): () => void {
    this.eventBus.on(type, handler);
    return () => this.eventBus.off(type, handler);
  }

  async waitForFeedback<T>(
    messageId: string,
    timeoutMs: number = 120000,
  ): Promise<T | null> {
    // 1. Check cache first (in case frontend replied before backend started waiting)
    if (this.feedbackCache.has(messageId)) {
      const cached = this.feedbackCache.get(messageId);
      this.feedbackCache.delete(messageId);
      console.log(
        `[GatewayService] Using cached feedback for messageId=${messageId}`,
      );
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

  private normalizeSessionPreview(input: string): string {
    return String(input || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  private getRunStateSnapshot(): GatewayRunStateSnapshot {
    const activeSessionIds = Array.from(this.sessions.values())
      .filter((context) => context.status !== "idle")
      .map((context) => context.sessionId)
      .sort();
    return {
      activeSessionIds,
      activeCount: activeSessionIds.length,
    };
  }

  private publishRunStateChanged(): void {
    const snapshot = this.getRunStateSnapshot();
    const stateKey = snapshot.activeSessionIds.join("\0");
    if (stateKey === this.lastRunStateKey) return;
    this.lastRunStateKey = stateKey;
    this.runStateListeners.forEach((listener) => listener(snapshot));
  }
}
