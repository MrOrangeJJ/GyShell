import type { ChatMessage, UIUpdateAction } from "./protocol";

export interface SessionState {
  id: string;
  title: string;
  messages: ChatMessage[];
  isThinking: boolean;
  isBusy: boolean;
  lockedProfileId: string | null;
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

export function applyRenameToUnloadedSession(
  session: SessionState | undefined,
  meta:
    | {
        title: string;
        updatedAt: number;
        loaded: boolean;
      }
    | undefined,
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
): {
  session: SessionState;
  meta: {
    id: string;
    title: string;
    updatedAt: number;
    messagesCount: number;
    loaded: boolean;
  };
} {
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
  meta: {
    title: string;
    updatedAt: number;
    loaded: boolean;
    uiRevision?: number;
  },
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
    case "UPDATE_MESSAGE":
      session.isBusy = true;
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

export function reorderSessionIdsByUpdatedAt(
  sessionIds: readonly string[],
  sessionMeta: Record<string, { updatedAt: number } | undefined>,
): string[] {
  return [...sessionIds].sort(
    (left, right) =>
      (sessionMeta[right]?.updatedAt || 0) -
      (sessionMeta[left]?.updatedAt || 0),
  );
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
      const msg = update.message;
      session.messages.push(msg);
      if (msg.type !== "tokens_count") {
        session.isBusy = true;
      }

      if (msg.role === "user") {
        session.isThinking = true;
        const firstUser =
          session.messages.filter((item) => item.role === "user").length === 1;
        const currentTitle = String(session.title || "").trim();
        if (firstUser && (!currentTitle || currentTitle === "New Chat")) {
          session.title = autoTitle(msg.content);
        }
      }
      break;
    }
    case "INSERT_MESSAGE": {
      const msg = update.message;
      const anchorIndex = findInsertAnchorIndex(session, update);
      if (anchorIndex < 0) break;
      const existingIndex = session.messages.findIndex(
        (item) => item.id === msg.id,
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
        msg,
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
      const msg = session.messages.find((item) => item.id === update.messageId);
      if (msg) {
        msg.content += update.content;
        session.isBusy = true;
      }
      break;
    }
    case "APPEND_OUTPUT": {
      const msg = session.messages.find((item) => item.id === update.messageId);
      if (msg) {
        msg.metadata = {
          ...(msg.metadata ?? {}),
          output: `${msg.metadata?.output ?? ""}${update.outputDelta ?? ""}`,
        };
        session.isBusy = true;
      }
      break;
    }
    case "UPDATE_MESSAGE": {
      const msg = session.messages.find((item) => item.id === update.messageId);
      if (msg) {
        Object.assign(msg, update.patch);
        session.isBusy = true;
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

export function findLatestPendingAsk(
  session: SessionState,
): ChatMessage | undefined {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message.type === "ask" && !message.metadata?.decision) {
      return message;
    }
  }
  return undefined;
}

export function compactMessageSummary(
  message: ChatMessage,
  showDetails: boolean,
): string {
  const short = (text: string, max = 120) => {
    const normalized = normalizeCompactText(text);
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1)}...`;
  };

  if (message.type === "text") {
    return short(message.content, showDetails ? 400 : 160);
  }

  if (message.type === "command") {
    const command = message.content || message.metadata?.command || "";
    const output = normalizeCompactText(message.metadata?.output ?? "");
    const suffix = showDetails && output ? ` | ${short(output, 140)}` : "";
    return `$ ${short(command, 80)}${suffix}`;
  }

  if (message.type === "tool_call") {
    const name = message.metadata?.toolName ?? "tool";
    return `${name}: ${short(message.content, showDetails ? 180 : 80)}`;
  }

  if (message.type === "file_edit") {
    const file = message.metadata?.filePath ?? "unknown file";
    const action = message.metadata?.action ?? "edited";
    const stats = summarizeDiff(message.metadata?.diff ?? "");
    return `${action} ${file}${stats}`;
  }

  if (
    message.type === "sub_tool" ||
    message.type === "reasoning" ||
    message.type === "compaction"
  ) {
    const title = message.metadata?.subToolTitle ?? "sub tool";
    const hint = message.metadata?.subToolHint
      ? ` (${message.metadata.subToolHint})`
      : "";
    return `${title}${hint}`;
  }

  if (message.type === "compaction_boundary") {
    return "[CTX COMPACTED]";
  }

  if (message.type === "ask") {
    const command = message.metadata?.command || message.content || "";
    return `permission required: ${short(command, 120)}`;
  }

  if (message.type === "alert") return `alert: ${short(message.content, 120)}`;
  if (message.type === "error") return `error: ${short(message.content, 120)}`;

  return short(message.content, 120);
}

function normalizeCompactText(input: string): string {
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
      /\[MENTION_PASS_CHAT:#([^#\]\r\n]+)(?:##([^#\]\r\n]+))?(?:#\])?/g,
      (_m, _sessionId: string, title: string) =>
        `@Pass Chat: ${decodeMentionComponent(title || "Chat")}`,
    )
    .replace(/`{3,}[\s\S]*?`{3,}/g, " [code block] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#>[\\\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeMentionComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function summarizeDiff(diff: string): string {
  if (!diff) return "";

  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@")
    )
      continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  if (!parts.length) return "";
  return ` (${parts.join(" ")})`;
}

function autoTitle(content: string): string {
  const normalized = normalizeCompactText(content || "");
  if (!normalized) return "New Chat";
  if (normalized.length <= 48) return normalized;
  return `${normalized.slice(0, 47)}...`;
}
