import { v4 as uuidv4 } from "uuid";
import type { AgentEvent, AgentEventType } from "../types";
import type {
  ChatMessage,
  UIChatSession,
  UIUpdateAction,
} from "../types/ui-chat";
import type { UISessionSummaryRecord } from "./history/historyTypes";
import { HistorySqliteStore } from "./history/HistorySqliteStore";
import {
  buildAutoSessionTitle,
  buildUiSessionSummary,
  normalizeCompactionBoundaryMarkers,
  sanitizeUiSession,
} from "./history/uiHistoryHelpers";

export type HistoryExportMode = "simple" | "detailed";
export type UISessionSummary = UISessionSummaryRecord;

interface UIHistoryServiceOptions {
  store?: HistorySqliteStore;
}

export class UIHistoryService {
  private readonly store: HistorySqliteStore;
  private sessionsCache: Record<string, UIChatSession> = {};
  private sessionSummaryCache: Record<string, UISessionSummary> = {};
  private dirtySessions: Set<string> = new Set();

  constructor(options?: UIHistoryServiceOptions) {
    this.store = options?.store || new HistorySqliteStore();
    this.sessionSummaryCache = this.buildSessionSummaryCache(
      this.store.listUiSessionSummaries(),
    );
  }

  private buildSessionSummaryCache(
    summaries: UISessionSummary[],
  ): Record<string, UISessionSummary> {
    const cache: Record<string, UISessionSummary> = {};
    for (const summary of summaries) {
      cache[summary.id] = summary;
    }
    return cache;
  }

  private getOrLoadSession(sessionId: string): UIChatSession | null {
    const cached = this.sessionsCache[sessionId];
    if (cached) {
      return cached;
    }
    const loaded = this.store.loadUiSession(sessionId);
    if (!loaded) {
      return null;
    }
    const sanitized = sanitizeUiSession(loaded);
    this.sessionsCache[sessionId] = sanitized;
    this.syncSessionSummary(sessionId);
    return sanitized;
  }

  private syncSessionSummary(sessionId: string): void {
    const session = this.sessionsCache[sessionId];
    if (!session) {
      delete this.sessionSummaryCache[sessionId];
      return;
    }
    this.sessionSummaryCache[sessionId] = buildUiSessionSummary(session);
  }

  recordEvent(sessionId: string, event: AgentEvent): UIUpdateAction[] {
    let session = this.getOrLoadSession(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        title: "New Chat",
        messages: [],
        updatedAt: Date.now(),
      };
      this.sessionsCache[sessionId] = session;
    }
    session.updatedAt = Date.now();

    const actions = this.processEvent(session, event, sessionId);
    this.syncSessionSummary(sessionId);
    this.dirtySessions.add(sessionId);
    return actions;
  }

  flush(sessionId?: string): void {
    const sessionIds = sessionId
      ? this.dirtySessions.has(sessionId)
        ? [sessionId]
        : []
      : Array.from(this.dirtySessions);
    if (sessionIds.length === 0) {
      return;
    }

    const entries: Array<{
      session: UIChatSession;
      summary: UISessionSummary;
    }> = [];
    sessionIds.forEach((id) => {
      const session = this.sessionsCache[id];
      if (!session) {
        this.dirtySessions.delete(id);
        return;
      }
      const sanitized = sanitizeUiSession(session);
      this.sessionsCache[id] = sanitized;
      const summary = buildUiSessionSummary(sanitized);
      this.sessionSummaryCache[id] = summary;
      entries.push({ session: sanitized, summary });
    });
    if (entries.length > 0) {
      this.store.saveUiSessions(entries);
    }
    sessionIds.forEach((id) => this.dirtySessions.delete(id));
  }

  private processEvent(
    session: UIChatSession,
    event: AgentEvent,
    sessionId: string,
  ): UIUpdateAction[] {
    const type = event.type as AgentEventType;
    const actions: UIUpdateAction[] = [];

    if (type === "user_input") {
      const message = this.createMessage(
        {
          role: "user",
          type: "text",
          content: event.content || "",
          metadata: {
            inputKind: event.inputKind || "normal",
            ...(Array.isArray(event.inputImages) && event.inputImages.length > 0
              ? { inputImages: event.inputImages }
              : {}),
          },
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      this.checkAutoTitle(session, "user", event.content || "");
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "say") {
      const lastMessage = session.messages[session.messages.length - 1];
      const delta = event.content || event.outputDelta || "";
      if (
        lastMessage &&
        lastMessage.role === "assistant" &&
        lastMessage.type === "text" &&
        lastMessage.streaming
      ) {
        lastMessage.content += delta;
        actions.push({
          type: "APPEND_CONTENT",
          sessionId,
          messageId: lastMessage.id,
          content: delta,
        });
      } else {
        const stopAction = this.stopLatestStreaming(session, sessionId);
        if (stopAction) actions.push(stopAction);

        const message = this.createMessage(
          {
            role: "assistant",
            type: "text",
            content: delta,
            streaming: true,
            backendMessageId: event.messageId,
          },
          sessionId,
        );
        session.messages.push(message);
        actions.push({ type: "ADD_MESSAGE", sessionId, message });
      }
    } else if (type === "command_started") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const existingIndex = session.messages.findIndex(
        (message) =>
          message.backendMessageId === event.messageId &&
          message.type === "ask",
      );
      if (existingIndex !== -1) {
        session.messages.splice(existingIndex, 1);
      }

      const message = this.createMessage(
        {
          role: "assistant",
          type: "command",
          content: event.command || "",
          metadata: {
            commandId: event.commandId,
            tabName: event.tabName || "Terminal",
            output: "",
            isNowait: !!(event as any).isNowait,
            collapsed: false,
          },
          streaming: true,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "command_finished") {
      const existingIndex = session.messages.findIndex(
        (message) =>
          message.backendMessageId === event.messageId &&
          message.type === "ask",
      );
      if (existingIndex !== -1) {
        session.messages.splice(existingIndex, 1);
      }

      const message = event.commandId
        ? session.messages.find(
            (entry) => entry.metadata?.commandId === event.commandId,
          )
        : [...session.messages]
            .reverse()
            .find((entry) => entry.type === "command" && entry.streaming);

      if (message) {
        const patch = {
          metadata: {
            ...message.metadata,
            exitCode: event.exitCode,
            output:
              (message.metadata?.output || "") +
              (event.outputDelta || "") +
              (event.message ? `\nError: ${event.message}` : ""),
            isNowait: (event as any).isNowait ?? message.metadata?.isNowait,
          },
          streaming: false,
        };
        Object.assign(message, patch);
        actions.push({
          type: "UPDATE_MESSAGE",
          sessionId,
          messageId: message.id,
          patch,
        });
      }
    } else if (type === "tool_call") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "assistant",
          type: "tool_call",
          content: event.input || "",
          metadata: {
            output: event.output || "",
            toolName: event.toolName || "Tool Call",
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "file_edit") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "assistant",
          type: "file_edit",
          content: event.output || "",
          metadata: {
            toolName: event.toolName || "create_or_edit",
            filePath: event.filePath,
            action: event.action || "edited",
            diff: event.diff || "",
            output: event.output || "",
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "file_read") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "assistant",
          type: "sub_tool",
          content: event.output || "",
          metadata: {
            subToolTitle: `Read: ${event.filePath || "unknown"}`,
            subToolLevel:
              event.level ||
              (String(event.output || "").startsWith("Error:")
                ? "warning"
                : "info"),
            output: event.output || "",
            collapsed: true,
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "command_ask") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "system",
          type: "ask",
          content: event.command || "",
          metadata: {
            approvalId: event.approvalId,
            toolName: event.toolName || "Command",
            command: event.command || "",
            decision: (event as any).decision,
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "sub_tool_started") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);
      const messageType = this.getSubToolMessageType(event);

      const message = this.createMessage(
        {
          role: "assistant",
          type: messageType,
          content: "",
          metadata: {
            subToolTitle: event.title || event.toolName || "Sub Tool",
            subToolHint: event.hint,
            output: "",
            subToolLevel: event.level || "info",
            collapsed: true,
          },
          streaming: true,
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "sub_tool_delta") {
      const message = event.messageId
        ? session.messages.find(
            (entry) => entry.backendMessageId === event.messageId,
          )
        : [...session.messages]
            .reverse()
            .find(
              (entry) =>
                (entry.type === "sub_tool" ||
                  entry.type === "reasoning" ||
                  entry.type === "compaction") &&
                entry.streaming,
            );

      if (message) {
        const delta = event.outputDelta || "";
        message.metadata = {
          ...message.metadata,
          output: (message.metadata?.output || "") + delta,
        };
        actions.push({
          type: "APPEND_OUTPUT",
          sessionId,
          messageId: message.id,
          outputDelta: delta,
        });
      }
    } else if (type === "sub_tool_finished") {
      const message = event.messageId
        ? session.messages.find(
            (entry) => entry.backendMessageId === event.messageId,
          )
        : [...session.messages]
            .reverse()
            .find(
              (entry) =>
                (entry.type === "sub_tool" ||
                  entry.type === "reasoning" ||
                  entry.type === "compaction") &&
                entry.streaming,
            );
      if (message) {
        message.streaming = false;
        actions.push({
          type: "UPDATE_MESSAGE",
          sessionId,
          messageId: message.id,
          patch: { streaming: false },
        });
      }
    } else if (type === "compaction_boundary") {
      const boundaryTargetBackendMessageId = this.normalizeBackendMessageId(
        event.boundaryTargetMessageId,
      );
      const boundaryPreviousBackendMessageId = this.normalizeBackendMessageId(
        event.boundaryPreviousMessageId,
      );
      const boundarySummaryBackendMessageId = this.normalizeBackendMessageId(
        event.summaryMessageId,
      );
      if (
        !boundaryTargetBackendMessageId &&
        !boundaryPreviousBackendMessageId
      ) {
        return actions;
      }

      const message = this.createMessage(
        {
          role: "system",
          type: "compaction_boundary",
          content: "",
          metadata: {
            ...(boundaryTargetBackendMessageId
              ? {
                  compactionBoundaryTargetBackendMessageId:
                    boundaryTargetBackendMessageId,
                }
              : {}),
            ...(boundaryPreviousBackendMessageId
              ? {
                  compactionBoundaryPreviousBackendMessageId:
                    boundaryPreviousBackendMessageId,
                }
              : {}),
            ...(boundarySummaryBackendMessageId
              ? {
                  compactionBoundarySummaryBackendMessageId:
                    boundarySummaryBackendMessageId,
                }
              : {}),
            ...(typeof event.protectedNormalRounds === "number"
              ? {
                  compactionBoundaryProtectedNormalRounds:
                    event.protectedNormalRounds,
                }
              : {}),
          },
          streaming: false,
          backendMessageId: event.messageId,
        },
        sessionId,
      );

      const insertion = this.insertCompactionBoundaryMessage(session, message);
      if (insertion) {
        actions.push({
          type: "INSERT_MESSAGE",
          sessionId,
          message,
          anchorMessageId: insertion.anchorMessageId,
          anchorBackendMessageId: insertion.anchorBackendMessageId,
          placement: insertion.placement,
        });
      }
    } else if (type === "remove_message") {
      const message = event.messageId
        ? [...session.messages]
            .reverse()
            .find(
              (entry) =>
                entry.backendMessageId === event.messageId &&
                entry.role === "assistant",
            )
        : [...session.messages]
            .reverse()
            .find((entry) => entry.role === "assistant");
      if (message) {
        session.messages = session.messages.filter(
          (entry) => entry.id !== message.id,
        );
        actions.push({
          type: "REMOVE_MESSAGE",
          sessionId,
          messageId: message.id,
        });
      }
    } else if (type === "done") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);
      actions.push({ type: "DONE", sessionId });
      session.messages.forEach((message) => {
        message.streaming = false;
      });
    } else if (type === "alert") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "system",
          type: "alert",
          content: event.message || "Unknown alert",
          metadata: {
            subToolLevel: event.level || "warning",
          },
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if (type === "error") {
      const stopAction = this.stopLatestStreaming(session, sessionId);
      if (stopAction) actions.push(stopAction);

      const message = this.createMessage(
        {
          role: "system",
          type: "error",
          content: event.message || "Unknown error",
          metadata: {
            details: (event as any).details || "",
          },
          backendMessageId: event.messageId,
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
      actions.push({ type: "DONE", sessionId });
    } else if (type === "tokens_count") {
      const message = this.createMessage(
        {
          role: "system",
          type: "tokens_count",
          content: "",
          metadata: {
            modelName: event.modelName,
            totalTokens: event.totalTokens,
            maxTokens: event.maxTokens,
          },
        },
        sessionId,
      );
      session.messages.push(message);
      actions.push({ type: "ADD_MESSAGE", sessionId, message });
    } else if ((type as string) === "rollback") {
      const backendMessageId = (event as any).messageId;
      const index = session.messages.findIndex(
        (message) => message.backendMessageId === backendMessageId,
      );
      if (index !== -1) {
        session.messages = normalizeCompactionBoundaryMarkers(
          session.messages.slice(0, index),
        );
        this.dirtySessions.add(sessionId);
        actions.push({
          type: "ROLLBACK" as any,
          sessionId,
          messageId: backendMessageId,
        } as any);
      }
    }
    return actions;
  }

  private stopLatestStreaming(
    session: UIChatSession,
    sessionId: string,
  ): UIUpdateAction | null {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      if (!session.messages[index].streaming) {
        continue;
      }
      session.messages[index].streaming = false;
      return {
        type: "UPDATE_MESSAGE",
        sessionId,
        messageId: session.messages[index].id,
        patch: { streaming: false },
      };
    }
    return null;
  }

  private createMessage(
    message: Omit<ChatMessage, "id" | "timestamp">,
    _sessionId?: string,
  ): ChatMessage {
    return {
      ...message,
      id: uuidv4(),
      timestamp: Date.now(),
    };
  }

  private normalizeBackendMessageId(value: unknown): string {
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : "";
  }

  private findExistingCompactionBoundaryIndex(
    messages: ChatMessage[],
    boundary: ChatMessage,
  ): number {
    const summaryBackendId = this.normalizeBackendMessageId(
      boundary.metadata?.compactionBoundarySummaryBackendMessageId,
    );
    const targetBackendId = this.normalizeBackendMessageId(
      boundary.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    return messages.findIndex((message) => {
      if (message.type !== "compaction_boundary") return false;
      if (
        boundary.backendMessageId &&
        message.backendMessageId === boundary.backendMessageId
      ) {
        return true;
      }
      if (
        summaryBackendId &&
        message.metadata?.compactionBoundarySummaryBackendMessageId ===
          summaryBackendId
      ) {
        return true;
      }
      return (
        !!targetBackendId &&
        message.metadata?.compactionBoundaryTargetBackendMessageId ===
          targetBackendId
      );
    });
  }

  private insertCompactionBoundaryMessage(
    session: UIChatSession,
    message: ChatMessage,
  ): {
    anchorMessageId: string;
    anchorBackendMessageId: string;
    placement: "before" | "after";
  } | null {
    if (
      this.findExistingCompactionBoundaryIndex(session.messages, message) >= 0
    ) {
      session.messages = normalizeCompactionBoundaryMarkers(session.messages);
      return null;
    }

    const targetBackendId = this.normalizeBackendMessageId(
      message.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    const previousBackendId = this.normalizeBackendMessageId(
      message.metadata?.compactionBoundaryPreviousBackendMessageId,
    );

    if (targetBackendId) {
      const targetIndex = session.messages.findIndex(
        (entry) => entry.backendMessageId === targetBackendId,
      );
      if (targetIndex >= 0) {
        const anchor = session.messages[targetIndex];
        session.messages.splice(targetIndex, 0, message);
        return {
          anchorMessageId: anchor.id,
          anchorBackendMessageId: targetBackendId,
          placement: "before",
        };
      }
    }

    if (previousBackendId && !targetBackendId) {
      const previousIndex = session.messages.findIndex(
        (entry) => entry.backendMessageId === previousBackendId,
      );
      if (previousIndex >= 0) {
        const anchor = session.messages[previousIndex];
        session.messages.splice(previousIndex + 1, 0, message);
        return {
          anchorMessageId: anchor.id,
          anchorBackendMessageId: previousBackendId,
          placement: "after",
        };
      }
    }

    console.warn(
      `[UIHistoryService] Dropped compaction boundary marker because its UI anchor was not found (target=${targetBackendId || "none"}, previous=${previousBackendId || "none"}).`,
    );
    return null;
  }

  private getSubToolMessageType(event: AgentEvent): ChatMessage["type"] {
    const rawTitle = String(event.title || event.toolName || "")
      .trim()
      .toLowerCase();
    if (rawTitle.startsWith("reasoning")) return "reasoning";
    if (rawTitle.startsWith("compaction")) return "compaction";
    return "sub_tool";
  }

  private checkAutoTitle(
    session: UIChatSession,
    role: string,
    content: string,
  ): void {
    const currentTitle = String(session.title || "").trim();
    if (
      role === "user" &&
      session.messages.filter((message) => message.role === "user").length ===
        1 &&
      (!currentTitle || currentTitle === "New Chat")
    ) {
      session.title = buildAutoSessionTitle(content);
    }
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.getOrLoadSession(sessionId)?.messages || [];
  }

  getSession(sessionId: string): UIChatSession | null {
    return this.getOrLoadSession(sessionId);
  }

  getAllSessions(): UIChatSession[] {
    return this.store
      .listUiSessions()
      .map((session) => sanitizeUiSession(session));
  }

  getAllSessionSummaries(): UISessionSummary[] {
    return Object.values(this.sessionSummaryCache).sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }

  recordFeedbackDecision(
    feedbackId: string,
    decision: "allow" | "deny",
  ): UIUpdateAction | null {
    const normalizedId = String(feedbackId || "").trim();
    if (!normalizedId) return null;

    for (const summary of this.getAllSessionSummaries()) {
      const session = this.getOrLoadSession(summary.id);
      if (!session) continue;
      const message = [...session.messages].reverse().find((entry) => {
        if (entry.type !== "ask") return false;
        return (
          entry.backendMessageId === normalizedId ||
          entry.metadata?.approvalId === normalizedId
        );
      });
      if (!message) continue;
      if (message.metadata?.decision === decision) return null;

      message.metadata = {
        ...(message.metadata || {}),
        decision,
      };
      session.updatedAt = Date.now();
      this.syncSessionSummary(session.id);
      this.dirtySessions.add(session.id);
      this.flush(session.id);
      return {
        type: "UPDATE_MESSAGE",
        sessionId: session.id,
        messageId: message.id,
        patch: {
          metadata: { ...message.metadata },
        },
      };
    }
    return null;
  }

  deleteSession(sessionId: string): void {
    this.deleteSessions([sessionId]);
  }

  deleteSessions(sessionIds: string[]): void {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) {
      return;
    }
    ids.forEach((id) => {
      delete this.sessionsCache[id];
      delete this.sessionSummaryCache[id];
      this.dirtySessions.delete(id);
    });
    this.store.deleteUiSessions(ids);
  }

  renameSession(sessionId: string, newTitle: string): void {
    const updatedAt = Date.now();
    const session = this.getOrLoadSession(sessionId);
    if (session) {
      session.title = newTitle;
      session.updatedAt = updatedAt;
      this.syncSessionSummary(sessionId);
      this.dirtySessions.add(sessionId);
      this.flush(sessionId);
      return;
    }

    const summary = this.sessionSummaryCache[sessionId];
    if (!summary) {
      const createdSession: UIChatSession = {
        id: sessionId,
        title: newTitle,
        messages: [],
        updatedAt,
      };
      this.sessionsCache[sessionId] = createdSession;
      this.syncSessionSummary(sessionId);
      this.dirtySessions.add(sessionId);
      this.flush(sessionId);
      return;
    }
    this.sessionSummaryCache[sessionId] = {
      ...summary,
      title: newTitle,
      updatedAt,
    };
    this.store.renameUiSession(sessionId, newTitle, updatedAt);
  }

  rollbackToMessage(sessionId: string, backendMessageId: string): number {
    const session = this.getOrLoadSession(sessionId);
    if (!session) return 0;

    const index = session.messages.findIndex(
      (message) => message.backendMessageId === backendMessageId,
    );
    if (index === -1) return 0;

    const removedCount = session.messages.length - index;
    session.messages = normalizeCompactionBoundaryMarkers(
      session.messages.slice(0, index),
    );
    this.syncSessionSummary(sessionId);
    this.dirtySessions.add(sessionId);
    this.flush(sessionId);
    return removedCount;
  }

  branchFromMessage(
    sourceSessionId: string,
    branchSessionId: string,
    backendMessageId: string,
    title: string,
  ): {
    ok: boolean;
    sessionId?: string;
    title?: string;
    messageCount?: number;
    reason?: string;
  } {
    const source = this.getOrLoadSession(sourceSessionId);
    if (!source) {
      return { ok: false, reason: "Source UI session not found." };
    }
    const index = source.messages.findIndex(
      (message) => message.backendMessageId === backendMessageId,
    );
    if (index === -1) {
      return { ok: false, reason: "Branch target UI message not found." };
    }

    const updatedAt = Date.now();
    const branch: UIChatSession = {
      id: branchSessionId,
      title: title.trim() || "Branch",
      updatedAt,
      messages: normalizeCompactionBoundaryMarkers(
        source.messages.slice(0, index + 1).map((message) => ({
          ...JSON.parse(JSON.stringify(message)),
          id: uuidv4(),
          streaming: false,
        })),
      ),
    };
    this.sessionsCache[branchSessionId] = branch;
    this.syncSessionSummary(branchSessionId);
    this.dirtySessions.add(branchSessionId);
    this.flush(branchSessionId);

    return {
      ok: true,
      sessionId: branchSessionId,
      title: branch.title,
      messageCount: branch.messages.length,
    };
  }

  toReadableMarkdown(messages: ChatMessage[], title: string): string {
    const lines: string[] = [];
    lines.push(`# ${title || "Conversation"}`);
    lines.push("");
    lines.push(`Exported at: ${new Date().toISOString()}`);
    lines.push("");

    let visibleCount = 0;

    for (const message of messages) {
      const body = this.getReadableMessageBody(message);
      if (!body) continue;

      visibleCount += 1;
      lines.push(
        `## ${visibleCount}. ${message.role === "user" ? "User" : "Assistant"}`,
      );
      lines.push("");
      lines.push(body);
      lines.push("");
    }

    if (visibleCount === 0) {
      lines.push("No user/assistant content found in frontend UI history.");
      lines.push("");
    }

    return lines.join("\n");
  }

  toReadableMarkdownFragment(messages: ChatMessage[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      const body = this.getReadableMessageBody(message);
      if (body) parts.push(body);
    }
    return this.normalizeText(parts.join("\n\n"));
  }

  toReadableMarkdownFragmentByMessageIds(
    sessionId: string,
    messageIds: string[],
  ): string {
    const session = this.getOrLoadSession(sessionId);
    if (!session) return "";
    const ids = new Set(
      (messageIds || []).filter(
        (id) => typeof id === "string" && id.length > 0,
      ),
    );
    if (ids.size === 0) return "";
    const selected = session.messages.filter((message) => ids.has(message.id));
    return this.toReadableMarkdownFragment(selected);
  }

  private getReadableMessageBody(message: ChatMessage): string {
    if (message.role !== "user" && message.role !== "assistant") return "";
    if (message.role === "user") {
      const normalized = this.normalizeText(message.content);
      if (normalized) return normalized;
      if (
        Array.isArray(message.metadata?.inputImages) &&
        message.metadata.inputImages.length > 0
      ) {
        const lines = [
          "Attached images:",
          ...message.metadata.inputImages.map(
            (item) => `- ${item.fileName || item.attachmentId || "image"}`,
          ),
        ];
        return this.normalizeText(lines.join("\n"));
      }
      return "";
    }
    return this.extractAssistantRichContent(message);
  }

  private extractAssistantRichContent(message: ChatMessage): string {
    const chunks: string[] = [];

    switch (message.type) {
      case "text": {
        const text = this.normalizeText(message.content);
        if (text) chunks.push(text);
        break;
      }
      case "command": {
        const commandText = this.normalizeText(
          message.content || message.metadata?.command || "",
        );
        const outputText = this.normalizeText(message.metadata?.output || "");
        if (commandText) {
          chunks.push("Command:");
          chunks.push("```bash");
          chunks.push(commandText);
          chunks.push("```");
        }
        if (outputText) {
          chunks.push("Output:");
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      case "tool_call": {
        const inputText = this.normalizeText(message.content || "");
        const outputText = this.normalizeText(message.metadata?.output || "");
        const toolName = this.normalizeText(
          message.metadata?.toolName || "Tool Call",
        );
        chunks.push(`Tool: ${toolName}`);
        if (inputText) {
          chunks.push("Input:");
          chunks.push("```text");
          chunks.push(inputText);
          chunks.push("```");
        }
        if (outputText) {
          chunks.push("Output:");
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      case "file_edit": {
        const filePath = this.normalizeText(message.metadata?.filePath || "");
        const outputText = this.normalizeText(
          message.metadata?.output || message.content || "",
        );
        const diffText = this.normalizeText(message.metadata?.diff || "");
        const action = this.normalizeText(message.metadata?.action || "edited");
        chunks.push(`File Edit (${action})${filePath ? `: ${filePath}` : ""}`);
        if (outputText) {
          chunks.push("Result:");
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        if (diffText) {
          chunks.push("Diff:");
          chunks.push("```diff");
          chunks.push(diffText);
          chunks.push("```");
        }
        break;
      }
      case "sub_tool": {
        const title = this.normalizeText(
          message.metadata?.subToolTitle || "Sub Tool",
        );
        const outputText = this.normalizeText(
          message.metadata?.output || message.content || "",
        );
        chunks.push(`Sub Tool: ${title}`);
        if (outputText) {
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      case "compaction": {
        const title = this.normalizeText(
          message.metadata?.subToolTitle || "Compaction",
        );
        const outputText = this.normalizeText(
          message.metadata?.output || message.content || "",
        );
        chunks.push(`Compaction: ${title}`);
        if (outputText) {
          chunks.push("```text");
          chunks.push(outputText);
          chunks.push("```");
        }
        break;
      }
      default: {
        const text = this.normalizeText(message.content);
        if (text) chunks.push(text);
      }
    }

    return this.normalizeText(chunks.join("\n\n"));
  }

  private normalizeText(input: string): string {
    return String(input || "")
      .replace(/\r\n?/g, "\n")
      .trim();
  }
}
