import type { ChatMessage, UIUpdateAction } from "./types";
import { extractCommandOutputDisplayText } from "@gyshell/shared";

export interface SessionState {
  id: string;
  title: string;
  messages: ChatMessage[];
  isThinking: boolean;
  isBusy: boolean;
  lockedProfileId: string | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  messagesCount: number;
  lastMessagePreview?: string;
  loaded: boolean;
  uiRevision?: number;
}

const isCommandOutputLifecycleUpdate = (update: UIUpdateAction): boolean =>
  update.type === "UPDATE_MESSAGE" &&
  update.patch.metadata?.commandOutput !== undefined;

export function shouldReplayUiUpdateAfterSnapshot(
  update: UIUpdateAction,
  uiRevision?: number,
): boolean {
  if (
    typeof uiRevision === "number" &&
    Number.isFinite(uiRevision) &&
    typeof update.uiRevision === "number" &&
    Number.isFinite(update.uiRevision)
  ) {
    return update.uiRevision > uiRevision;
  }
  return update.type === "SESSION_RENAMED";
}

export class UiUpdateBootstrapBuffer {
  private buffering = false;
  private nextSequence = 0;
  private pending: Array<{ sequence: number; update: UIUpdateAction }> = [];
  private coveredBySnapshot: Array<{
    sequence: number;
    update: UIUpdateAction;
  }> = [];

  begin(): void {
    this.buffering = true;
    this.nextSequence = 0;
    this.pending = [];
    this.coveredBySnapshot = [];
  }

  handle(
    update: UIUpdateAction,
    apply: (pendingUpdate: UIUpdateAction) => void,
  ): void {
    if (this.buffering) {
      this.pending.push({ sequence: this.nextSequence, update });
      this.nextSequence += 1;
      return;
    }
    apply(update);
  }

  discardCoveredBySnapshot(uiRevision?: number, sessionId?: string): void {
    const normalizedRevision =
      typeof uiRevision === "number" && Number.isFinite(uiRevision)
        ? uiRevision
        : null;
    const normalizedSessionId = String(sessionId || "").trim();
    const retained: typeof this.pending = [];
    this.pending.forEach((entry) => {
      if (
        normalizedSessionId &&
        entry.update.sessionId !== normalizedSessionId
      ) {
        retained.push(entry);
        return;
      }
      if (
        shouldReplayUiUpdateAfterSnapshot(
          entry.update,
          normalizedRevision ?? undefined,
        )
      ) {
        retained.push(entry);
        return;
      }
      this.coveredBySnapshot.push(entry);
    });
    this.pending = retained;
  }

  end(
    apply: (pendingUpdate: UIUpdateAction) => void,
    options?: { snapshotInstalled?: boolean },
  ): void {
    this.buffering = false;
    const entries =
      options?.snapshotInstalled === false
        ? [...this.coveredBySnapshot, ...this.pending].sort(
            (left, right) => left.sequence - right.sequence,
          )
        : this.pending;
    this.pending = [];
    this.coveredBySnapshot = [];
    entries.forEach((entry) => apply(entry.update));
  }
}

export function createSessionState(
  id: string,
  title = "New Chat",
): SessionState {
  return {
    id,
    title,
    messages: [],
    isThinking: false,
    isBusy: false,
    lockedProfileId: null,
  };
}

export function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

export function cloneSession(session: SessionState): SessionState {
  return {
    ...session,
    messages: session.messages.map(cloneMessage),
  };
}

export function applyRenameToUnloadedSession(
  session: SessionState | undefined,
  meta: SessionMeta | undefined,
  title: string,
  updatedAt: number,
): boolean {
  if (!meta || meta.loaded) {
    return false;
  }
  if (session) {
    session.title = title;
  }
  meta.title = title;
  meta.updatedAt = updatedAt;
  return true;
}

export function createUnloadedRenamedSession(
  sessionId: string,
  title: string,
  updatedAt: number,
  existingSession?: SessionState,
): { session: SessionState; meta: SessionMeta } {
  const session = existingSession || createSessionState(sessionId, title);
  session.title = title;
  return {
    session,
    meta: {
      id: sessionId,
      title,
      updatedAt,
      messagesCount: 0,
      loaded: false,
    },
  };
}

export function applyUiUpdateToUnloadedSession(
  session: SessionState,
  meta: SessionMeta,
  update: UIUpdateAction,
  updatedAt: number,
): void {
  switch (update.type) {
    case "SESSION_RENAMED":
      session.title = update.title;
      break;
    case "ADD_MESSAGE": {
      if (update.message.type !== "tokens_count") {
        session.isBusy = true;
      }
      if (update.message.role === "user") {
        session.isThinking = true;
        const currentTitle = String(session.title || "").trim();
        if (!currentTitle || currentTitle === "New Chat") {
          session.title = autoTitle(update.message.content);
        }
      }
      break;
    }
    case "INSERT_MESSAGE":
    case "APPEND_CONTENT":
    case "APPEND_OUTPUT":
      session.isBusy = true;
      break;
    case "UPDATE_MESSAGE":
      if (!isCommandOutputLifecycleUpdate(update)) {
        session.isBusy = true;
      }
      break;
    case "DONE":
      session.isThinking = false;
      break;
    case "SESSION_PROFILE_LOCKED":
      session.isBusy = true;
      session.lockedProfileId = update.lockedProfileId || null;
      break;
    case "SESSION_READY":
      session.isBusy = false;
      session.lockedProfileId = null;
      break;
    case "ROLLBACK":
      session.isThinking = false;
      session.isBusy = false;
      break;
    case "REMOVE_MESSAGE":
      break;
  }
  meta.title = session.title;
  meta.updatedAt = updatedAt;
  if (
    typeof update.uiRevision === "number" &&
    Number.isFinite(update.uiRevision)
  ) {
    meta.uiRevision = update.uiRevision;
  }
}

export function applyUiUpdate(
  session: SessionState,
  update: UIUpdateAction,
): void {
  switch (update.type) {
    case "SESSION_RENAMED": {
      session.title = update.title;
      break;
    }
    case "ADD_MESSAGE": {
      const message = cloneMessage(update.message);
      // Keep reasoning/compaction transient in frontend: once any new message arrives, old transient activity banners are removed.
      session.messages = session.messages.filter(
        (item) => item.type !== "reasoning" && item.type !== "compaction",
      );
      session.messages.push(message);

      if (message.type !== "tokens_count") {
        session.isBusy = true;
      }

      if (message.role === "user") {
        session.isThinking = true;
        const firstUser =
          session.messages.filter((item) => item.role === "user").length === 1;
        const currentTitle = String(session.title || "").trim();
        if (firstUser && (!currentTitle || currentTitle === "New Chat")) {
          session.title = autoTitle(message.content);
        }
      }
      break;
    }
    case "INSERT_MESSAGE": {
      const message = cloneMessage(update.message);
      const anchorIndex = findInsertAnchorIndex(session, update);
      if (anchorIndex < 0) break;
      const existingIndex = session.messages.findIndex(
        (item) => item.id === message.id,
      );
      if (existingIndex >= 0) {
        session.messages.splice(existingIndex, 1);
      }
      const adjustedAnchorIndex =
        existingIndex >= 0 && existingIndex < anchorIndex
          ? anchorIndex - 1
          : anchorIndex;
      session.messages.splice(
        update.placement === "after"
          ? adjustedAnchorIndex + 1
          : adjustedAnchorIndex,
        0,
        message,
      );
      session.messages = normalizeCompactionBoundaryMessages(session.messages);
      break;
    }
    case "REMOVE_MESSAGE": {
      session.messages = session.messages.filter(
        (item) => item.id !== update.messageId,
      );
      break;
    }
    case "APPEND_CONTENT": {
      const message = session.messages.find(
        (item) => item.id === update.messageId,
      );
      if (message) {
        message.content += update.content;
        session.isBusy = true;
      }
      break;
    }
    case "APPEND_OUTPUT": {
      const message = session.messages.find(
        (item) => item.id === update.messageId,
      );
      if (message) {
        message.metadata = {
          ...(message.metadata ?? {}),
          output: `${message.metadata?.output ?? ""}${update.outputDelta ?? ""}`,
        };
        session.isBusy = true;
      }
      break;
    }
    case "UPDATE_MESSAGE": {
      const message = session.messages.find(
        (item) => item.id === update.messageId,
      );
      if (message) {
        Object.assign(message, update.patch);
        if (!isCommandOutputLifecycleUpdate(update)) {
          session.isBusy = true;
        }
      }
      break;
    }
    case "DONE": {
      session.isThinking = false;
      session.messages.forEach((item) => {
        item.streaming = false;
      });
      break;
    }
    case "SESSION_PROFILE_LOCKED": {
      session.isBusy = true;
      session.lockedProfileId = update.lockedProfileId || null;
      break;
    }
    case "SESSION_READY": {
      session.isBusy = false;
      session.lockedProfileId = null;
      break;
    }
    case "ROLLBACK": {
      const index = session.messages.findIndex(
        (item) => item.backendMessageId === update.messageId,
      );
      if (index >= 0) {
        session.messages = normalizeCompactionBoundaryMessages(
          session.messages.slice(0, index),
        );
      }
      session.isThinking = false;
      session.isBusy = false;
      break;
    }
  }
}

function findInsertAnchorIndex(
  session: SessionState,
  update: {
    anchorMessageId?: string;
    anchorBackendMessageId?: string;
  },
): number {
  if (typeof update.anchorMessageId === "string") {
    const byUiId = session.messages.findIndex(
      (item) => item.id === update.anchorMessageId,
    );
    if (byUiId >= 0) return byUiId;
  }

  if (typeof update.anchorBackendMessageId === "string") {
    return session.messages.findIndex(
      (item) => item.backendMessageId === update.anchorBackendMessageId,
    );
  }

  return -1;
}

function normalizeBoundaryBackendId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

function normalizeCompactionBoundaryMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  const boundaries = messages.filter(
    (message) => message.type === "compaction_boundary",
  );
  if (boundaries.length === 0) return messages;

  const baseMessages = messages.filter(
    (message) => message.type !== "compaction_boundary",
  );
  const normalized = [...baseMessages];
  const seenKeys = new Set<string>();

  boundaries.forEach((boundary) => {
    const targetBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    const previousBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryPreviousBackendMessageId,
    );
    const summaryBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundarySummaryBackendMessageId,
    );
    const key =
      summaryBackendId ||
      targetBackendId ||
      previousBackendId ||
      boundary.backendMessageId ||
      boundary.id;
    if (seenKeys.has(key)) return;

    const normalizedBoundary = {
      ...boundary,
      role: "system",
      content: "",
      streaming: false,
    } satisfies ChatMessage;

    if (targetBackendId) {
      const targetIndex = normalized.findIndex(
        (message) => message.backendMessageId === targetBackendId,
      );
      if (targetIndex < 0) return;
      normalized.splice(targetIndex, 0, normalizedBoundary);
      seenKeys.add(key);
      return;
    }

    if (previousBackendId) {
      const previousIndex = normalized.findIndex(
        (message) => message.backendMessageId === previousBackendId,
      );
      if (previousIndex < 0) return;
      normalized.splice(previousIndex + 1, 0, normalizedBoundary);
      seenKeys.add(key);
    }
  });

  return normalized;
}

export function autoTitle(content: string): string {
  const normalized = normalizeDisplayText(content || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "New Chat";
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47)}...`;
}

export function normalizeDisplayText(input: string): string {
  return String(input || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /\[MENTION_TAB:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g,
      (_m, name: string) => `@${name}`,
    )
    .replace(
      /\[MENTION_SKILL:#([^#\]\r\n]+)(?:#\])?/g,
      (_m, name: string) => `@${name}`,
    )
    .replace(
      /\[MENTION_FILE:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g,
      (_m, path: string) => path.split(/[/\\]/).pop() || path,
    )
    .replace(
      /\[MENTION_IMAGE:#([^#\]\r\n]+)(?:##([^#\]\r\n]+))?(?:#\])?/g,
      (_m, path: string, name: string) =>
        String(name || "").trim() || path.split(/[/\\]/).pop() || path,
    )
    .replace(
      /\[MENTION_PASS_CHAT:#([^#\]\r\n]+)(?:##([^#\]\r\n]+))?(?:#\])?/g,
      (_m, _sessionId: string, title: string) =>
        `@Pass Chat: ${decodeMentionComponent(title || "Chat")}`,
    )
    .replace(/\s+$/g, "");
}

function decodeMentionComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function trimOuterBlankLines(input: string): string {
  const normalized = String(input || "").replace(/\r/g, "");
  return normalized.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function isEmptyMessageContent(message: ChatMessage): boolean {
  if (
    Array.isArray(message.metadata?.inputImages) &&
    message.metadata.inputImages.length > 0
  ) {
    return false;
  }
  const content = normalizeDisplayText(message.content || "");
  const rawOutput = message.metadata?.output || "";
  const output = normalizeDisplayText(
    extractCommandOutputDisplayText(rawOutput),
  );
  return content.trim().length === 0 && output.trim().length === 0;
}

export function previewFromSession(session: SessionState): string {
  const latest = [...session.messages]
    .reverse()
    .find(
      (item) =>
        item.type !== "tokens_count" &&
        item.type !== "compaction_boundary" &&
        !isEmptyMessageContent(item),
    );

  if (!latest) return "";

  const rawOutput = latest.metadata?.output || "";
  const displayOutput = extractCommandOutputDisplayText(rawOutput);
  const base =
    latest.type === "command"
      ? displayOutput || latest.content
      : displayOutput ||
        latest.content ||
        (Array.isArray(latest.metadata?.inputImages) &&
        latest.metadata.inputImages.length > 0
          ? latest.metadata.inputImages
              .map((image) => image.fileName || image.attachmentId || "image")
              .join(", ")
          : "");

  return normalizeSessionPreview(base);
}

export function normalizeSessionPreview(input: string): string {
  return normalizeDisplayText(extractCommandOutputDisplayText(input))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export function reorderSessionIds(
  order: string[],
  metaMap: Record<string, SessionMeta>,
): string[] {
  return [...new Set(order)].sort((left, right) => {
    const a = metaMap[left];
    const b = metaMap[right];
    return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0);
  });
}
