import {
  makeObservable,
  observable,
  action,
  runInAction,
  computed,
  ObservableMap,
} from "mobx";
import { v4 as uuidv4 } from "uuid";
import { ChatQueueStore, type QueueItem } from "./ChatQueueStore";
import type { InputImageAttachment, UserInputPayload } from "../lib/userInput";
import { WINDOW_CONTEXT } from "../lib/windowing";
import {
  createChatTextGeometryShape,
  extractCommandOutputDisplayText,
  parseCommandOutputContractV1,
  type ChatMessageGeometry,
  type CommandOutputContractV1,
  type UiMessageGeometryIndex,
} from "@gyshell/shared";

const SESSION_REGISTRATION_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_600];
const CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE = 512;
const CHAT_GEOMETRY_PAGE_CHUNK_LIMIT = 8;
const CHAT_GEOMETRY_PREVIEW_LIMIT = 512;
const CHAT_FULL_PAYLOAD_MAX_MESSAGES = 128;
const CHAT_FULL_PAYLOAD_MAX_CHARACTERS = 8_000_000;
const CHAT_FULL_PAYLOAD_REQUEST_MAX_MESSAGES = 16;
const CHAT_GEOMETRY_OUTPUT_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set([
  "command",
  "tool_call",
  "file_edit",
  "sub_tool",
  "reasoning",
]);
const CHAT_STRUCTURAL_METADATA_STRING_FIELDS = [
  "tabName",
  "commandId",
  "filePath",
  "toolName",
  "subToolTitle",
  "subToolHint",
  "approvalId",
  "command",
  "modelName",
  "compactionBoundaryTargetBackendMessageId",
  "compactionBoundaryPreviousBackendMessageId",
  "compactionBoundarySummaryBackendMessageId",
] as const;

const isSessionRegistrationHandlerUnavailable = (error: unknown): boolean =>
  /No handler registered for ['"]agent:registerSession['"]/i.test(
    error instanceof Error ? error.message : String(error),
  );

const waitForSessionRegistrationRetry = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const buildAutoSessionTitle = (content: string): string => {
  const normalized = String(content || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "New Chat";
};

export type MessageType =
  | "text"
  | "command"
  | "tool_call"
  | "file_edit"
  | "sub_tool"
  | "reasoning"
  | "compaction"
  | "compaction_boundary"
  | "alert"
  | "error"
  | "ask"
  | "tokens_count";

export interface ChatMessage {
  id: string;
  backendMessageId?: string;
  role: "user" | "assistant" | "system";
  type: MessageType;
  content: string;
  metadata?: {
    tabName?: string;
    commandId?: string;
    exitCode?: number;
    output?: string;
    diff?: string;
    filePath?: string;
    action?: "created" | "edited" | "error";
    collapsed?: boolean;
    isNowait?: boolean;
    commandOutput?: CommandOutputContractV1;
    toolName?: string;
    subToolTitle?: string;
    subToolHint?: string;
    subToolLevel?: "info" | "warning" | "error";
    approvalId?: string;
    decision?: "allow" | "deny";
    command?: string;
    modelName?: string;
    totalTokens?: number;
    maxTokens?: number;
    details?: string;
    inputKind?: "normal" | "inserted";
    inputImages?: InputImageAttachment[];
    compactionBoundaryTargetBackendMessageId?: string;
    compactionBoundaryPreviousBackendMessageId?: string;
    compactionBoundarySummaryBackendMessageId?: string;
    compactionBoundaryProtectedNormalRounds?: number;
  };
  timestamp: number;
  streaming?: boolean;
  deferredPayload?: {
    fields: Array<
      "content" | "output" | "diff" | "details" | "inputImages" | "metadata"
    >;
  };
  geometry?: ChatMessageGeometry;
  payloadState?: "geometry" | "page" | "full";
}

export interface ChatSession {
  id: string;
  title: string;
  updatedAt?: number;
  messagesById: ObservableMap<string, ChatMessage>;
  messageIds: string[];
  renderListVersion: number;
  isThinking: boolean;
  isSessionBusy: boolean;
  lockedProfileId: string | null;
  totalMessageCount?: number;
  loadedStartPosition?: number | null;
  loadedEndPosition?: number | null;
  hasOlderMessages?: boolean;
  hasNewerMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  isLoadingNewerMessages?: boolean;
  hasLoadedMessagePage?: boolean;
  uiRevision?: number;
  geometryLoaded?: boolean;
  loadedPayloadPositions?: Set<number>;
  messagePositionById?: Map<string, number>;
}

interface SessionMetadataPayload {
  id: string;
  title: string;
  updatedAt?: number;
  messagesCount?: number;
  isBusy?: boolean;
  lockedProfileId?: string | null;
  uiRevision?: number;
  revisionPresent?: boolean;
}

interface UiMessagePagePayload {
  sessionId: string;
  entries: Array<{ position: number; message: ChatMessage }>;
  totalCount: number;
  startPosition: number | null;
  endPosition: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  uiRevision: number;
  metadata?: SessionMetadataPayload | null;
  revisionPresent?: boolean;
}

interface ChatHydrationPayload {
  id: string;
  exists: boolean;
  loaded: boolean;
  title: string | null;
  updatedAt?: number;
  messages: ChatMessage[];
  page?: UiMessagePagePayload | null;
  isBusy: boolean;
  lockedProfileId: string | null;
  totalMessageCount: number;
  uiRevision: number;
}

const normalizeBoundaryBackendId = (value: unknown): string => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
};

const normalizeCompactionBoundaryMessageOrder = (
  messages: ChatMessage[],
): ChatMessage[] => {
  if (messages.length === 0) return messages;

  const baseMessages: ChatMessage[] = [];
  const boundaryMessages: ChatMessage[] = [];
  messages.forEach((message) => {
    if (message.type === "compaction_boundary") {
      boundaryMessages.push({
        ...message,
        role: "system",
        content: "",
        streaming: false,
      });
      return;
    }
    baseMessages.push(message);
  });

  if (boundaryMessages.length === 0) return messages;

  const normalized = [...baseMessages];
  const seenBoundaryKeys = new Set<string>();

  boundaryMessages.forEach((boundary) => {
    const targetBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryTargetBackendMessageId,
    );
    const previousBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundaryPreviousBackendMessageId,
    );
    const summaryBackendId = normalizeBoundaryBackendId(
      boundary.metadata?.compactionBoundarySummaryBackendMessageId,
    );
    const boundaryKey =
      summaryBackendId ||
      targetBackendId ||
      previousBackendId ||
      boundary.backendMessageId ||
      boundary.id;
    if (seenBoundaryKeys.has(boundaryKey)) return;

    if (targetBackendId) {
      const targetIndex = normalized.findIndex(
        (message) => message.backendMessageId === targetBackendId,
      );
      if (targetIndex < 0) return;
      normalized.splice(targetIndex, 0, boundary);
      seenBoundaryKeys.add(boundaryKey);
      return;
    }

    if (previousBackendId) {
      const previousIndex = normalized.findIndex(
        (message) => message.backendMessageId === previousBackendId,
      );
      if (previousIndex < 0) return;
      normalized.splice(previousIndex + 1, 0, boundary);
      seenBoundaryKeys.add(boundaryKey);
    }
  });

  return normalized;
};

export class ChatStore {
  sessions: ChatSession[] = [];
  sessionInventoryHydrated = false;
  activeSessionId: string | null = null;
  queue = new ChatQueueStore();
  private queueRunner?: (
    sessionId: string,
    input: UserInputPayload,
  ) => Promise<boolean>;
  private sessionsChangedListener?: (sessionIds: string[]) => void;
  private ownedBackendSessionIds = new Set<string>();
  private sessionOwnershipVersions = new Map<string, number>();
  private sessionRegistrationPromises = new Map<string, Promise<void>>();
  private pendingUiUpdatesBySession = new Map<
    string,
    Array<{ sequence: number; update: any }>
  >();
  private recentUiUpdatesBySession = new Map<
    string,
    Array<{ sequence: number; update: any }>
  >();
  private uiUpdateSequence = 0;
  private sessionLoadPromises = new Map<string, Promise<void>>();
  private fullMessageLoadPromises = new Map<string, Promise<ChatMessage[]>>();
  private fullMessageLoadByIdPromises = new Map<
    string,
    Promise<ChatMessage | undefined>
  >();
  private readonly initialMessagePageSize = 300;
  private readonly maxLoadedMessagesPerSession = WINDOW_CONTEXT.safeMode
    ? 300
    : 600;
  private geometryLoadPromises = new Map<string, Promise<boolean>>();
  private messageRangeLoadPromises = new Map<string, Promise<boolean>>();
  private pagePayloadChunksBySession = new Map<string, Map<number, true>>();
  private fullPayloadRetentionBySession = new Map<
    string,
    Map<string, number>
  >();
  private geometryPlaceholdersBySession = new Map<
    string,
    Map<string, ChatMessage>
  >();

  constructor() {
    makeObservable(this, {
      sessions: observable,
      sessionInventoryHydrated: observable,
      activeSessionId: observable,
      activeSession: computed,
      activeSessionLatestTokens: computed,
      activeSessionLatestMaxTokens: computed,
      hydrateSessionInventoryFromLayout: action,
      hydrateSessionsFromBackend: action,
      createSession: action,
      ensureSession: action,
      setActiveSession: action,
      closeSession: action,
      addMessage: action,
      updateMessage: action,
      removeMessage: action,
      setThinking: action,
      setSessionBusy: action,
      clear: action,
      handleUiUpdate: action,
      hydrateSessionFromBackend: action,
      loadChatHistory: action,
      loadOlderMessages: action,
      loadNewerMessages: action,
      loadMessagesAroundPosition: action,
      loadMessageRange: action,
      loadFullMessages: action,
      searchMessages: action,
      deleteChatSession: action,
      deleteChatSessions: action,
      renameChatSession: action,
      branchFromMessage: action,
      rollbackToMessage: action,
      setSessionLockedProfile: action,
      setQueueRunner: action,
      setSessionsChangedListener: action,
      setQueueMode: action,
      startQueue: action,
      stopQueue: action,
      addQueueItem: action,
      removeQueueItem: action,
      moveQueueItem: action,
    });

    // Create default session
    this.createSession("New Chat");
  }

  private createEmptySession(
    id: string,
    title: string,
    options?: { loaded?: boolean },
  ): ChatSession {
    const loaded = options?.loaded === true;
    return {
      id,
      title,
      updatedAt: loaded ? Date.now() : undefined,
      // Message payloads are immutable snapshots at the map boundary. A
      // shallow map avoids creating one MobX observable proxy per historical
      // message, metadata object, and geometry bucket.
      messagesById: observable.map<string, ChatMessage>(undefined, {
        deep: false,
      }),
      messageIds: [],
      renderListVersion: 0,
      isThinking: false,
      isSessionBusy: false,
      lockedProfileId: null,
      totalMessageCount: 0,
      loadedStartPosition: loaded ? 0 : null,
      loadedEndPosition: loaded ? -1 : null,
      hasOlderMessages: false,
      hasNewerMessages: false,
      isLoadingOlderMessages: false,
      isLoadingNewerMessages: false,
      hasLoadedMessagePage: loaded,
      uiRevision: 0,
      geometryLoaded: false,
      loadedPayloadPositions: new Set<number>(),
      messagePositionById: new Map<string, number>(),
    };
  }

  private markEmptySessionLoaded(session: ChatSession): void {
    session.totalMessageCount = 0;
    session.loadedStartPosition = 0;
    session.loadedEndPosition = -1;
    session.hasOlderMessages = false;
    session.hasNewerMessages = false;
    session.hasLoadedMessagePage = true;
  }

  private bumpSessionRenderListVersion(session: ChatSession): void {
    session.renderListVersion += 1;
  }

  private async invokeSessionRegistrationWithRetry(
    sessionId: string,
    ownershipVersion: number,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= SESSION_REGISTRATION_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      if (
        attempt > 0 &&
        (!this.ownedBackendSessionIds.has(sessionId) ||
          this.sessionOwnershipVersions.get(sessionId) !== ownershipVersion)
      ) {
        return;
      }
      try {
        await window.gyshell.agent.registerSession(sessionId);
        return;
      } catch (error) {
        const retryDelay = SESSION_REGISTRATION_RETRY_DELAYS_MS[attempt];
        if (
          retryDelay === undefined ||
          !isSessionRegistrationHandlerUnavailable(error)
        ) {
          throw error;
        }
        await waitForSessionRegistrationRetry(retryDelay);
      }
    }
  }

  private registerSessionWithBackend(sessionId: string): void {
    if (
      typeof window === "undefined" ||
      typeof window.gyshell?.agent?.registerSession !== "function"
    ) {
      return;
    }
    if (this.ownedBackendSessionIds.has(sessionId)) {
      return;
    }
    this.ownedBackendSessionIds.add(sessionId);
    const ownershipVersion =
      (this.sessionOwnershipVersions.get(sessionId) || 0) + 1;
    this.sessionOwnershipVersions.set(sessionId, ownershipVersion);
    const previous = this.sessionRegistrationPromises.get(sessionId);
    const registration = (previous || Promise.resolve())
      .then(() =>
        this.invokeSessionRegistrationWithRetry(sessionId, ownershipVersion),
      )
      .catch((error) => {
        if (this.sessionOwnershipVersions.get(sessionId) === ownershipVersion) {
          this.ownedBackendSessionIds.delete(sessionId);
        }
        console.error(`Failed to register chat session ${sessionId}:`, error);
      });
    this.sessionRegistrationPromises.set(sessionId, registration);
    void registration.then(() => {
      if (this.sessionRegistrationPromises.get(sessionId) === registration) {
        this.sessionRegistrationPromises.delete(sessionId);
      }
    });
  }

  private unregisterSessionWithBackend(sessionId: string): void {
    if (!this.ownedBackendSessionIds.delete(sessionId)) {
      return;
    }
    this.sessionOwnershipVersions.set(
      sessionId,
      (this.sessionOwnershipVersions.get(sessionId) || 0) + 1,
    );
    if (
      typeof window === "undefined" ||
      typeof window.gyshell?.agent?.unregisterSession !== "function"
    ) {
      this.sessionRegistrationPromises.delete(sessionId);
      return;
    }
    const previous = this.sessionRegistrationPromises.get(sessionId);
    const unregister = (previous || Promise.resolve())
      .then(() => window.gyshell.agent.unregisterSession(sessionId))
      .catch((error) => {
        console.error(`Failed to unregister chat session ${sessionId}:`, error);
      });
    this.sessionRegistrationPromises.set(sessionId, unregister);
    void unregister.then(() => {
      if (this.sessionRegistrationPromises.get(sessionId) === unregister) {
        this.sessionRegistrationPromises.delete(sessionId);
      }
    });
  }

  registerSessionOwnership(sessionId: string): void {
    this.registerSessionWithBackend(sessionId);
  }

  unregisterSessionOwnership(sessionId: string): void {
    this.unregisterSessionWithBackend(sessionId);
  }

  private async ensureSessionOwnershipRegistered(
    sessionId: string,
  ): Promise<boolean> {
    let failedStableRegistrations = 0;
    while (failedStableRegistrations < 2) {
      this.registerSessionWithBackend(sessionId);
      const ownershipVersion = this.sessionOwnershipVersions.get(sessionId);
      const pendingOperation = this.sessionRegistrationPromises.get(sessionId);
      await pendingOperation;

      if (
        this.sessionOwnershipVersions.get(sessionId) !== ownershipVersion ||
        (this.sessionRegistrationPromises.get(sessionId) &&
          this.sessionRegistrationPromises.get(sessionId) !== pendingOperation)
      ) {
        continue;
      }
      if (this.ownedBackendSessionIds.has(sessionId)) {
        return true;
      }
      failedStableRegistrations += 1;
    }
    return false;
  }

  get activeSession(): ChatSession | null {
    return this.sessions.find((s) => s.id === this.activeSessionId) || null;
  }

  get activeSessionLatestTokens(): number {
    return this.getLatestTokens(this.activeSessionId);
  }

  get activeSessionLatestMaxTokens(): number {
    return this.getLatestMaxTokens(this.activeSessionId);
  }

  getLatestTokens(sessionId: string | null): number {
    const session = this.getSessionById(sessionId);
    if (!session) return 0;
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i]);
      if (msg && msg.type === "tokens_count") {
        return msg.metadata?.totalTokens || 0;
      }
    }
    return 0;
  }

  getLatestMaxTokens(sessionId: string | null): number {
    const session = this.getSessionById(sessionId);
    if (!session) return 0;
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i]);
      if (msg && msg.type === "tokens_count") {
        return msg.metadata?.maxTokens || 0;
      }
    }
    return 0;
  }

  getSessionById(sessionId: string | null): ChatSession | null {
    if (!sessionId) return null;
    return this.sessions.find((session) => session.id === sessionId) || null;
  }

  setSessionsChangedListener(listener?: (sessionIds: string[]) => void): void {
    this.sessionsChangedListener = listener;
  }

  private emitSessionsChanged(): void {
    this.sessionsChangedListener?.(this.sessions.map((session) => session.id));
  }

  hydrateSessionInventoryFromLayout(
    sessionIds: string[],
    preferredActiveSessionId?: string | null,
  ): void {
    const ids = Array.from(
      new Set(
        (sessionIds || []).filter(
          (id) => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (ids.length === 0) {
      this.sessionInventoryHydrated = true;
      return;
    }

    const existingById = new Map(
      this.sessions.map((session) => [session.id, session]),
    );
    this.sessions
      .filter((session) => !ids.includes(session.id))
      .forEach((session) => {
        this.clearGeometryRuntimeState(session.id);
        this.unregisterSessionWithBackend(session.id);
      });
    const nextSessions = ids.map(
      (id) =>
        existingById.get(id) ||
        this.createEmptySession(id, "New Chat", { loaded: false }),
    );
    nextSessions.forEach((session) =>
      this.registerSessionWithBackend(session.id),
    );
    this.sessions = nextSessions;
    const normalizedPreferredActiveId =
      typeof preferredActiveSessionId === "string" &&
      preferredActiveSessionId.length > 0
        ? preferredActiveSessionId
        : null;
    const preferredActiveExists =
      !!normalizedPreferredActiveId &&
      nextSessions.some(
        (session) => session.id === normalizedPreferredActiveId,
      );
    const currentActiveExists =
      !!this.activeSessionId &&
      nextSessions.some((session) => session.id === this.activeSessionId);

    if (preferredActiveExists) {
      this.activeSessionId = normalizedPreferredActiveId;
    } else if (!currentActiveExists) {
      this.activeSessionId = nextSessions[0]?.id || null;
    }
    this.sessionInventoryHydrated = true;
  }

  private isTranscriptUiUpdate(updateType: unknown): boolean {
    return new Set([
      "ADD_MESSAGE",
      "INSERT_MESSAGE",
      "REMOVE_MESSAGE",
      "APPEND_CONTENT",
      "APPEND_OUTPUT",
      "UPDATE_MESSAGE",
      "ROLLBACK",
    ]).has(String(updateType || ""));
  }

  private doesUiUpdateAdvanceSessionRecency(updateType: unknown): boolean {
    switch (String(updateType || "")) {
      case "ADD_MESSAGE":
      case "INSERT_MESSAGE":
      case "REMOVE_MESSAGE":
      case "UPDATE_MESSAGE":
      case "ROLLBACK":
      case "SESSION_RENAMED":
        return true;
      default:
        return false;
    }
  }

  private advanceSessionRecencyFromUiUpdate(
    session: ChatSession,
    update: any,
  ): void {
    if (!this.doesUiUpdateAdvanceSessionRecency(update?.type)) return;
    const incomingRevision = this.normalizeUiRevision(update?.uiRevision);
    if (
      incomingRevision > 0 &&
      (session.uiRevision || 0) > 0 &&
      incomingRevision <= (session.uiRevision || 0)
    ) {
      return;
    }
    const messageTimestamp = Number(update?.message?.timestamp);
    session.updatedAt = Number.isFinite(messageTimestamp)
      ? Math.max(session.updatedAt || 0, messageTimestamp)
      : Date.now();
  }

  private normalizeUiRevision(value: unknown): number {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }

  private isUiRevisionStale(
    incomingRevision: number,
    currentRevision: number,
  ): boolean {
    return (
      currentRevision > 0 &&
      (incomingRevision === 0 || incomingRevision < currentRevision)
    );
  }

  private createGeometryPreview(value: string): {
    value: string;
    deferred: boolean;
  } {
    const normalized = String(value || "");
    if (normalized.length <= CHAT_GEOMETRY_PREVIEW_LIMIT) {
      return { value: normalized, deferred: false };
    }
    const headLength = Math.ceil(CHAT_GEOMETRY_PREVIEW_LIMIT / 2);
    const tailLength = Math.floor(CHAT_GEOMETRY_PREVIEW_LIMIT / 2);
    let headEnd = headLength;
    if (
      headEnd > 0 &&
      headEnd < normalized.length &&
      /[\uD800-\uDBFF]/.test(normalized[headEnd - 1]) &&
      /[\uDC00-\uDFFF]/.test(normalized[headEnd])
    ) {
      headEnd -= 1;
    }
    let tailStart = normalized.length - tailLength;
    if (
      tailStart > 0 &&
      tailStart < normalized.length &&
      /[\uD800-\uDBFF]/.test(normalized[tailStart - 1]) &&
      /[\uDC00-\uDFFF]/.test(normalized[tailStart])
    ) {
      tailStart += 1;
    }
    return {
      value: `${normalized.slice(0, headEnd)}${normalized.slice(tailStart)}`,
      deferred: true,
    };
  }

  private createGeometryPlaceholder(message: ChatMessage): ChatMessage {
    const geometry = message.geometry || this.createLiveMessageGeometry(message);
    const needsContent =
      message.type !== "tokens_count" &&
      message.type !== "compaction_boundary";
    const needsOutput = CHAT_GEOMETRY_OUTPUT_MESSAGE_TYPES.has(message.type);
    const needsDiff = message.type === "file_edit";
    const needsDetails = message.type === "error";
    const output = extractCommandOutputDisplayText(
      String(message.metadata?.output || ""),
    );
    const contentPreview = this.createGeometryPreview(
      needsContent ? message.content : "",
    );
    const outputPreview = this.createGeometryPreview(
      needsOutput ? output : "",
    );
    const diffPreview = this.createGeometryPreview(
      needsDiff ? String(message.metadata?.diff || "") : "",
    );
    const detailsPreview = this.createGeometryPreview(
      needsDetails ? String(message.metadata?.details || "") : "",
    );
    const deferredFields: NonNullable<
      ChatMessage["deferredPayload"]
    >["fields"] = [];
    const defer = (
      field: NonNullable<ChatMessage["deferredPayload"]>["fields"][number],
    ): void => {
      if (!deferredFields.includes(field)) deferredFields.push(field);
    };
    if (contentPreview.deferred) defer("content");
    if (outputPreview.deferred) defer("output");
    if (diffPreview.deferred) defer("diff");
    if (detailsPreview.deferred) defer("details");

    const sourceMetadata = message.metadata || {};
    const metadata: NonNullable<ChatMessage["metadata"]> = {};
    for (const field of CHAT_STRUCTURAL_METADATA_STRING_FIELDS) {
      const value = sourceMetadata[field];
      if (typeof value !== "string" || value.length === 0) continue;
      const preview = this.createGeometryPreview(value);
      metadata[field] = preview.value as never;
      if (preview.deferred) defer("metadata");
    }
    for (const field of [
      "exitCode",
      "action",
      "collapsed",
      "isNowait",
      "subToolLevel",
      "decision",
      "totalTokens",
      "maxTokens",
      "inputKind",
      "compactionBoundaryProtectedNormalRounds",
    ] as const) {
      const value = sourceMetadata[field];
      if (value !== undefined) metadata[field] = value as never;
    }
    const commandOutput = parseCommandOutputContractV1(
      sourceMetadata.commandOutput,
    );
    if (commandOutput) metadata.commandOutput = commandOutput;
    if (outputPreview.value) metadata.output = outputPreview.value;
    if (diffPreview.value) metadata.diff = diffPreview.value;
    if (detailsPreview.value) metadata.details = detailsPreview.value;
    const inputImageCount = Array.isArray(sourceMetadata.inputImages)
      ? sourceMetadata.inputImages.length
      : geometry.inputImageCount || 0;
    if (inputImageCount > 0) defer("inputImages");

    return {
      id: message.id,
      backendMessageId: message.backendMessageId,
      role: message.role,
      type: message.type,
      content: contentPreview.value,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      timestamp: message.timestamp,
      streaming: message.streaming,
      geometry: {
        ...geometry,
        inputImageCount,
      },
      payloadState: "geometry",
      ...(deferredFields.length > 0
        ? { deferredPayload: { fields: deferredFields } }
        : {}),
    };
  }

  private rememberGeometryPlaceholder(
    session: ChatSession,
    message: ChatMessage,
  ): void {
    if (
      !session.geometryLoaded ||
      message.streaming === true ||
      message.type === "ask" ||
      message.deferredPayload?.fields.length
    ) {
      return;
    }
    const placeholders =
      this.geometryPlaceholdersBySession.get(session.id) || new Map();
    placeholders.set(message.id, this.createGeometryPlaceholder(message));
    this.geometryPlaceholdersBySession.set(session.id, placeholders);
  }

  private estimateFullPayloadCharacters(message: ChatMessage): number {
    let total = String(message.content || "").length;
    if (!message.metadata) return total;
    try {
      total += JSON.stringify(message.metadata).length;
    } catch {
      total += String(message.metadata.output || "").length;
      total += String(message.metadata.diff || "").length;
      total += String(message.metadata.details || "").length;
    }
    return total;
  }

  private touchFullPayload(
    session: ChatSession,
    message: ChatMessage,
  ): void {
    if (
      message.payloadState !== "full" ||
      message.streaming === true ||
      message.type === "ask"
    ) {
      return;
    }
    const retention =
      this.fullPayloadRetentionBySession.get(session.id) || new Map();
    retention.delete(message.id);
    retention.set(message.id, this.estimateFullPayloadCharacters(message));
    this.fullPayloadRetentionBySession.set(session.id, retention);
  }

  private pruneFullPayloads(
    session: ChatSession,
    protectedMessageIds: ReadonlySet<string> = new Set(),
  ): void {
    const retention = this.fullPayloadRetentionBySession.get(session.id);
    const placeholders = this.geometryPlaceholdersBySession.get(session.id);
    if (!retention || !placeholders) return;

    for (const messageId of Array.from(retention.keys())) {
      if (session.messagesById.get(messageId)?.payloadState !== "full") {
        retention.delete(messageId);
      }
    }
    let totalCharacters = Array.from(retention.values()).reduce(
      (total, size) => total + size,
      0,
    );
    for (const [messageId, size] of Array.from(retention.entries())) {
      if (
        retention.size <= CHAT_FULL_PAYLOAD_MAX_MESSAGES &&
        totalCharacters <= CHAT_FULL_PAYLOAD_MAX_CHARACTERS
      ) {
        break;
      }
      if (protectedMessageIds.has(messageId)) continue;
      const message = session.messagesById.get(messageId);
      const placeholder = placeholders.get(messageId);
      if (
        !message ||
        !placeholder ||
        message.streaming === true ||
        message.type === "ask"
      ) {
        continue;
      }
      session.messagesById.set(messageId, placeholder);
      const position = session.messagePositionById?.get(messageId);
      if (typeof position === "number") {
        session.loadedPayloadPositions?.delete(position);
      }
      retention.delete(messageId);
      totalCharacters -= size;
    }
  }

  private clearGeometryRuntimeState(sessionId: string): void {
    this.geometryPlaceholdersBySession.delete(sessionId);
    this.pagePayloadChunksBySession.delete(sessionId);
    this.fullPayloadRetentionBySession.delete(sessionId);
  }

  private trackGeometryMessagePayload(
    session: ChatSession,
    message: ChatMessage,
    options?: { protect?: boolean },
  ): void {
    if (!session.geometryLoaded) return;
    this.rememberGeometryPlaceholder(session, message);
    this.touchFullPayload(session, message);
    this.pruneFullPayloads(
      session,
      options?.protect ? new Set([message.id]) : undefined,
    );
  }

  private createLiveMessageGeometry(message: ChatMessage): ChatMessageGeometry {
    const output = extractCommandOutputDisplayText(
      String(message.metadata?.output || ""),
    );
    return {
      contentShape: createChatTextGeometryShape(message.content),
      ...(output ? { outputShape: createChatTextGeometryShape(output) } : {}),
      ...(message.metadata?.diff
        ? { diffShape: createChatTextGeometryShape(message.metadata.diff) }
        : {}),
      ...(message.metadata?.details
        ? {
            detailsShape: createChatTextGeometryShape(message.metadata.details),
          }
        : {}),
      inputImageCount: Array.isArray(message.metadata?.inputImages)
        ? message.metadata.inputImages.length
        : message.geometry?.inputImageCount || 0,
    };
  }

  private refreshLiveMessageGeometry(
    session: ChatSession,
    message: ChatMessage,
  ): ChatMessage {
    if (
      !session.geometryLoaded ||
      message.deferredPayload?.fields.length ||
      typeof session.messagePositionById?.get(message.id) !== "number"
    ) {
      return message;
    }
    return {
      ...message,
      geometry: this.createLiveMessageGeometry(message),
    };
  }

  private mergeLiveMessage(
    session: ChatSession,
    previous: ChatMessage | undefined,
    incoming: ChatMessage,
  ): ChatMessage {
    if (!session.geometryLoaded) return incoming;
    return {
      ...incoming,
      payloadState: incoming.deferredPayload?.fields.length ? "page" : "full",
      ...(previous?.geometry ? { geometry: previous.geometry } : {}),
    };
  }

  private rebuildGeometryPositionMap(
    session: ChatSession,
    options?: { clearLoadedPayloadPositions?: boolean },
  ): void {
    if (!session.geometryLoaded) return;
    session.messagePositionById = new Map(
      session.messageIds.map((messageId, position) => [messageId, position]),
    );
    if (options?.clearLoadedPayloadPositions) {
      const loadedPositions = new Set<number>();
      const pageChunkStarts = new Set<number>();
      session.messageIds.forEach((messageId, position) => {
        const message = session.messagesById.get(messageId);
        if (!message) return;
        if (
          message.payloadState === "page" ||
          message.payloadState === "full" ||
          !message.deferredPayload?.fields.length
        ) {
          loadedPositions.add(position);
        }
        if (message.payloadState === "page") {
          pageChunkStarts.add(
            Math.floor(position / CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE) *
              CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE,
          );
        }
      });
      session.loadedPayloadPositions = loadedPositions;
      this.pagePayloadChunksBySession.set(session.id, new Map());
      this.touchGeometryPagePayloadChunks(session, pageChunkStarts);
    }
    // Geometry mode owns the complete ordered ID list, including live
    // transients appended after the durable index. Structural mutations can
    // therefore keep the public total exact instead of preserving a stale
    // paged-history count.
    session.totalMessageCount = session.messageIds.length;
    session.loadedStartPosition = session.messageIds.length > 0 ? 0 : null;
    session.loadedEndPosition =
      session.messageIds.length > 0 ? session.messageIds.length - 1 : null;
    session.hasOlderMessages = false;
    session.hasNewerMessages = false;
  }

  private createMessageFromGeometryEntry(
    entry: UiMessageGeometryIndex["entries"][number],
  ): ChatMessage {
    const metadata = {
      ...(entry.metadata || {}),
      ...(entry.projection.output ? { output: entry.projection.output } : {}),
      ...(entry.projection.diff ? { diff: entry.projection.diff } : {}),
      ...(entry.projection.details
        ? { details: entry.projection.details }
        : {}),
    };
    const hasMetadata = Object.keys(metadata).length > 0;
    const deferredFields = entry.projection.deferredFields || [];
    const message: ChatMessage = {
      id: entry.id,
      backendMessageId: entry.backendMessageId,
      role: entry.role,
      type: entry.type,
      content: entry.projection.content || "",
      ...(hasMetadata ? { metadata } : {}),
      timestamp: entry.timestamp,
      streaming: entry.streaming,
      geometry: entry.geometry,
      payloadState: "geometry",
      ...(deferredFields.length > 0
        ? { deferredPayload: { fields: deferredFields } }
        : {}),
    };
    return message;
  }

  private applyMessageGeometryIndex(
    session: ChatSession,
    index: UiMessageGeometryIndex,
  ): void {
    const existingMessages = [...session.messagesById.values()];
    const existingById = new Map(
      existingMessages.map((message) => [message.id, message]),
    );
    const incomingIds = index.entries.map((entry) => entry.id);
    const geometryPlaceholderById = new Map<string, ChatMessage>();
    const incomingById = new Map(
      index.entries.map((entry) => {
        const previous = existingById.get(entry.id);
        const geometryMessage = this.createMessageFromGeometryEntry(entry);
        geometryPlaceholderById.set(entry.id, geometryMessage);
        return [
          entry.id,
          previous?.payloadState === "full" || previous?.streaming === true
            ? {
                ...previous,
                geometry: geometryMessage.geometry,
                payloadState:
                  previous.payloadState ||
                  (previous.deferredPayload?.fields.length ? "page" : "full"),
              }
            : geometryMessage,
        ] as const;
      }),
    );
    this.geometryPlaceholdersBySession.set(
      session.id,
      geometryPlaceholderById,
    );
    this.pagePayloadChunksBySession.set(session.id, new Map());
    this.fullPayloadRetentionBySession.set(session.id, new Map());
    session.geometryLoaded = true;
    session.loadedPayloadPositions = new Set(
      index.entries
        .filter((entry) => !entry.projection.deferredFields?.length)
        .map((entry) => entry.position),
    );
    session.messagePositionById = new Map(
      index.entries.map((entry) => [entry.id, entry.position]),
    );
    session.messagesById.clear();
    incomingById.forEach((message, id) =>
      session.messagesById.set(id, message),
    );
    const incomingIdSet = new Set(incomingIds);
    existingMessages.forEach((message) => {
      if (incomingIdSet.has(message.id)) return;
      const position = incomingIds.length;
      incomingIds.push(message.id);
      session.messagePositionById?.set(message.id, position);
      const preservedMessage: ChatMessage = {
        ...message,
        payloadState: message.payloadState === "full" ? "full" : "page",
      };
      session.messagesById.set(message.id, preservedMessage);
      if (!preservedMessage.deferredPayload?.fields.length) {
        session.loadedPayloadPositions?.add(position);
      }
    });
    session.messageIds = incomingIds;
    session.totalMessageCount = Math.max(index.totalCount, incomingIds.length);
    session.loadedStartPosition = incomingIds.length > 0 ? 0 : null;
    session.loadedEndPosition =
      incomingIds.length > 0 ? incomingIds.length - 1 : null;
    session.hasOlderMessages = false;
    session.hasNewerMessages = false;
    session.hasLoadedMessagePage = true;
    session.uiRevision = Math.max(
      session.uiRevision || 0,
      index.uiRevision || 0,
    );
    incomingById.forEach((message) => {
      if (message.payloadState === "full") {
        this.rememberGeometryPlaceholder(session, message);
        this.touchFullPayload(session, message);
      }
    });
    this.pruneFullPayloads(session);
    this.bumpSessionRenderListVersion(session);
  }

  private evictGeometryPagePayloadChunk(
    session: ChatSession,
    chunkStart: number,
  ): void {
    const geometryPlaceholders = this.geometryPlaceholdersBySession.get(
      session.id,
    );
    if (!geometryPlaceholders) return;
    const chunkEnd = Math.min(
      session.messageIds.length - 1,
      chunkStart + CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE - 1,
    );
    for (let position = chunkStart; position <= chunkEnd; position += 1) {
      const messageId = session.messageIds[position];
      const message = messageId
        ? session.messagesById.get(messageId)
        : undefined;
      if (
        !message ||
        message.payloadState !== "page" ||
        message.streaming === true ||
        message.type === "ask"
      ) {
        continue;
      }
      const geometryPlaceholder = geometryPlaceholders.get(messageId);
      if (!geometryPlaceholder) continue;
      session.messagesById.set(messageId, geometryPlaceholder);
      session.loadedPayloadPositions?.delete(position);
    }
  }

  private touchGeometryPagePayloadChunks(
    session: ChatSession,
    chunkStarts: Iterable<number>,
  ): void {
    const chunks =
      this.pagePayloadChunksBySession.get(session.id) || new Map<number, true>();
    for (const chunkStart of chunkStarts) {
      chunks.delete(chunkStart);
      chunks.set(chunkStart, true);
    }
    while (chunks.size > CHAT_GEOMETRY_PAGE_CHUNK_LIMIT) {
      const oldestChunkStart = chunks.keys().next().value;
      if (typeof oldestChunkStart !== "number") break;
      chunks.delete(oldestChunkStart);
      this.evictGeometryPagePayloadChunk(session, oldestChunkStart);
    }
    this.pagePayloadChunksBySession.set(session.id, chunks);
  }

  private mergeLoadedPageIntoGeometrySession(
    session: ChatSession,
    page: UiMessagePagePayload,
    retainRange?: { start: number; end: number },
  ): boolean {
    const incomingRevision = this.getPageRevision(page);
    if (
      page.revisionPresent !== false &&
      this.isUiRevisionStale(incomingRevision, session.uiRevision || 0)
    ) {
      return false;
    }
    this.applySessionMetadata(session, page.metadata || null);
    let insertedMessage = false;
    const touchedChunkStarts = new Set<number>();
    page.entries.forEach((entry) => {
      const position =
        typeof entry.position === "number"
          ? entry.position
          : session.messagePositionById?.get(entry.message.id);
      if (
        retainRange &&
        (typeof position !== "number" ||
          position < retainRange.start ||
          position > retainRange.end)
      ) {
        return;
      }
      if (typeof position !== "number") return;
      touchedChunkStarts.add(
        Math.floor(position / CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE) *
          CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE,
      );
      const previous = session.messagesById.get(entry.message.id);
      const alreadyIndexed = session.messagePositionById?.has(entry.message.id);
      session.messagePositionById?.set(entry.message.id, position);
      if (!alreadyIndexed) {
        const insertIndex = Math.min(position, session.messageIds.length);
        session.messageIds.splice(insertIndex, 0, entry.message.id);
        session.totalMessageCount = Math.max(
          session.totalMessageCount || 0,
          position + 1,
        );
        insertedMessage = true;
      }
      // A page response is bounded and may race a full-payload response for a
      // visible row. Never downgrade a full/live message back to its preview.
      if (
        previous?.payloadState === "full" ||
        (previous?.streaming === true && previous.payloadState !== "geometry")
      ) {
        session.loadedPayloadPositions?.add(position);
        return;
      }
      const next = {
        ...entry.message,
        payloadState: "page" as const,
        geometry: previous?.geometry || entry.message.geometry,
      };
      session.messagesById.set(entry.message.id, next);
      session.loadedPayloadPositions?.add(position);
    });
    if (insertedMessage) {
      this.rebuildGeometryPositionMap(session, {
        clearLoadedPayloadPositions: true,
      });
    }
    this.touchGeometryPagePayloadChunks(session, touchedChunkStarts);
    session.uiRevision = Math.max(session.uiRevision || 0, incomingRevision);
    this.bumpSessionRenderListVersion(session);
    return true;
  }

  private async loadMessageGeometryIndex(sessionId: string): Promise<boolean> {
    const getGeometry = (window.gyshell.agent as any).getUiMessageGeometry;
    if (typeof getGeometry !== "function") return false;
    const existing = this.geometryLoadPromises.get(sessionId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const raw = await getGeometry(sessionId);
        if (!raw || !Array.isArray(raw.entries)) return false;
        const current = this.getSessionById(sessionId);
        if (
          !current ||
          raw.sessionId !== sessionId ||
          this.isUiRevisionStale(
            this.normalizeUiRevision(raw.uiRevision),
            current.uiRevision || 0,
          )
        ) {
          return false;
        }
        runInAction(() => {
          this.applyMessageGeometryIndex(
            current,
            raw as UiMessageGeometryIndex,
          );
        });
        return true;
      } catch (error) {
        // Geometry is an optional desktop optimization. A missing handler,
        // stale preload, or a transient IPC failure must fall back to the
        // existing paged transcript path instead of blocking session hydration.
        console.warn(`Failed to load chat geometry for ${sessionId}:`, error);
        return false;
      }
    })();
    this.geometryLoadPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.geometryLoadPromises.get(sessionId) === promise) {
        this.geometryLoadPromises.delete(sessionId);
      }
    }
  }

  private getPageRevision(page: UiMessagePagePayload): number {
    return Math.max(
      this.normalizeUiRevision(page.uiRevision),
      this.normalizeUiRevision(page.metadata?.uiRevision),
    );
  }

  private isVersionedResponseStale(
    response: unknown,
    currentRevision: number,
  ): boolean {
    if (!response || typeof response !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(response, "uiRevision")) {
      // Older mobile/TUI/CLI-compatible transports do not expose revisions.
      return false;
    }
    return this.isUiRevisionStale(
      this.normalizeUiRevision((response as any).uiRevision),
      currentRevision,
    );
  }

  private recordUiUpdate(
    sessionId: string,
    update: any,
  ): {
    sequence: number;
    update: any;
  } {
    const recorded = { sequence: ++this.uiUpdateSequence, update };
    const recent = this.recentUiUpdatesBySession.get(sessionId) || [];
    recent.push(recorded);
    const maxRecent = 1_000;
    if (recent.length > maxRecent) {
      recent.splice(0, recent.length - maxRecent);
    }
    this.recentUiUpdatesBySession.set(sessionId, recent);
    return recorded;
  }

  private queuePendingUiUpdate(
    sessionId: string,
    recorded: { sequence: number; update: any },
  ): void {
    const pending = this.pendingUiUpdatesBySession.get(sessionId) || [];
    pending.push(recorded);
    const maxPending = 1_000;
    if (pending.length > maxPending) {
      pending.splice(0, pending.length - maxPending);
    }
    this.pendingUiUpdatesBySession.set(sessionId, pending);
  }

  private normalizeUiMessagePage(
    raw: unknown,
    sessionId: string,
  ): UiMessagePagePayload | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as any;
    if (!Array.isArray(value.entries)) return null;
    const entries = value.entries
      .map((entry: any) => {
        const position = Number(entry?.position);
        const message = entry?.message;
        if (
          !Number.isFinite(position) ||
          !message ||
          typeof message.id !== "string" ||
          message.id.length === 0
        ) {
          return null;
        }
        return {
          position: Math.floor(position),
          message: message as ChatMessage,
        };
      })
      .filter(
        (
          entry: { position: number; message: ChatMessage } | null,
        ): entry is { position: number; message: ChatMessage } => !!entry,
      )
      .sort(
        (
          left: { position: number; message: ChatMessage },
          right: { position: number; message: ChatMessage },
        ) => left.position - right.position,
      );
    const totalCount = Math.max(
      entries.length,
      Number.isFinite(Number(value.totalCount))
        ? Math.floor(Number(value.totalCount))
        : entries.length,
    );
    return {
      sessionId,
      entries,
      totalCount,
      startPosition:
        value.startPosition === null || value.startPosition === undefined
          ? (entries[0]?.position ?? null)
          : Math.max(0, Math.floor(Number(value.startPosition))),
      endPosition:
        value.endPosition === null || value.endPosition === undefined
          ? (entries[entries.length - 1]?.position ?? null)
          : Math.max(0, Math.floor(Number(value.endPosition))),
      hasOlder: value.hasOlder === true,
      hasNewer: value.hasNewer === true,
      uiRevision: Math.max(
        this.normalizeUiRevision(value.uiRevision),
        this.normalizeUiRevision(value.metadata?.uiRevision),
      ),
      metadata:
        value.metadata && typeof value.metadata === "object"
          ? {
              ...(value.metadata as SessionMetadataPayload),
              revisionPresent: Object.prototype.hasOwnProperty.call(
                value.metadata,
                "uiRevision",
              ),
            }
          : null,
      revisionPresent:
        Object.prototype.hasOwnProperty.call(value, "uiRevision") ||
        (value.metadata &&
          typeof value.metadata === "object" &&
          Object.prototype.hasOwnProperty.call(value.metadata, "uiRevision")),
    };
  }

  private applySessionMetadata(
    session: ChatSession,
    metadata: SessionMetadataPayload | null,
    fallbackTitle?: string | null,
  ): void {
    const incomingRevision = this.normalizeUiRevision(metadata?.uiRevision);
    const currentRevision = session.uiRevision || 0;
    const revisionPresent =
      metadata?.revisionPresent ?? metadata?.uiRevision !== undefined;
    if (
      revisionPresent &&
      this.isUiRevisionStale(incomingRevision, currentRevision)
    ) {
      return;
    }
    const title = String(metadata?.title || fallbackTitle || "").trim();
    if (title) session.title = title;
    if (
      typeof metadata?.updatedAt === "number" &&
      Number.isFinite(metadata.updatedAt)
    ) {
      session.updatedAt = metadata.updatedAt;
    }
    if (typeof metadata?.messagesCount === "number") {
      session.totalMessageCount = Math.max(
        0,
        Math.floor(metadata.messagesCount),
      );
    }
    if (metadata?.isBusy !== undefined) {
      session.isThinking = metadata.isBusy === true;
      session.isSessionBusy = metadata.isBusy === true;
    }
    if (metadata?.lockedProfileId !== undefined) {
      session.lockedProfileId = metadata.lockedProfileId || null;
    }
    session.uiRevision = Math.max(currentRevision, incomingRevision);
  }

  private applyMessagePage(
    session: ChatSession,
    page: UiMessagePagePayload,
    mode: "replace" | "prepend" | "append" = "replace",
  ): boolean {
    const incomingRevision = this.getPageRevision(page);
    if (
      page.revisionPresent !== false &&
      this.isUiRevisionStale(incomingRevision, session.uiRevision || 0)
    ) {
      return false;
    }

    this.applySessionMetadata(session, page.metadata || null);
    if (session.geometryLoaded) {
      return this.mergeLoadedPageIntoGeometrySession(session, page, {
        start: page.startPosition ?? 0,
        end: page.endPosition ?? Math.max(0, page.totalCount - 1),
      });
    }
    const incomingIds = page.entries.map((entry) => entry.message.id);
    const incomingIdSet = new Set(incomingIds);
    page.entries.forEach((entry) => {
      session.messagesById.set(entry.message.id, entry.message);
    });

    if (mode === "replace") {
      session.messagesById.clear();
      page.entries.forEach((entry) => {
        session.messagesById.set(entry.message.id, entry.message);
      });
      session.messageIds = [...incomingIds];
    } else if (mode === "prepend") {
      session.messageIds = [
        ...incomingIds,
        ...session.messageIds.filter((id) => !incomingIdSet.has(id)),
      ];
    } else {
      session.messageIds = [
        ...session.messageIds.filter((id) => !incomingIdSet.has(id)),
        ...incomingIds,
      ];
    }

    const previousStart = session.loadedStartPosition;
    const previousEnd = session.loadedEndPosition;
    session.totalMessageCount =
      mode === "replace"
        ? page.totalCount
        : Math.max(page.totalCount, session.totalMessageCount || 0);
    if (mode === "replace") {
      session.loadedStartPosition = page.startPosition;
      session.loadedEndPosition = page.endPosition;
    } else {
      session.loadedStartPosition =
        previousStart === null || previousStart === undefined
          ? page.startPosition
          : page.startPosition === null || page.startPosition === undefined
            ? previousStart
            : Math.min(previousStart, page.startPosition);
      session.loadedEndPosition =
        previousEnd === null || previousEnd === undefined
          ? page.endPosition
          : page.endPosition === null || page.endPosition === undefined
            ? previousEnd
            : Math.max(previousEnd, page.endPosition);
    }
    session.hasOlderMessages =
      page.hasOlder || (session.loadedStartPosition ?? 0) > 0;
    session.hasNewerMessages =
      page.hasNewer ||
      (session.loadedEndPosition ?? -1) < (session.totalMessageCount || 0) - 1;
    session.hasLoadedMessagePage = true;
    session.uiRevision = Math.max(session.uiRevision || 0, incomingRevision);
    this.enforceLoadedMessageCap(
      session,
      mode === "prepend" ? "newest" : mode === "append" ? "oldest" : "oldest",
    );
    this.bumpSessionRenderListVersion(session);
    return true;
  }

  private enforceLoadedMessageCap(
    session: ChatSession,
    evictSide: "oldest" | "newest",
  ): void {
    let removedCount = 0;
    while (session.messageIds.length > this.maxLoadedMessagesPerSession) {
      removedCount += 1;
      if (evictSide === "oldest") {
        const removedId = session.messageIds.shift();
        if (removedId) session.messagesById.delete(removedId);
      } else {
        const removedId = session.messageIds.pop();
        if (removedId) session.messagesById.delete(removedId);
      }
    }
    if (removedCount > 0) {
      if (
        evictSide === "oldest" &&
        typeof session.loadedStartPosition === "number"
      ) {
        session.loadedStartPosition += removedCount;
      }
      if (
        evictSide === "newest" &&
        typeof session.loadedEndPosition === "number"
      ) {
        session.loadedEndPosition -= removedCount;
      }
    }
    if (session.messageIds.length === 0) {
      session.loadedStartPosition = null;
      session.loadedEndPosition = null;
    }
    session.hasOlderMessages =
      typeof session.loadedStartPosition === "number" &&
      session.loadedStartPosition > 0;
    if (typeof session.totalMessageCount === "number") {
      session.hasNewerMessages =
        typeof session.loadedEndPosition === "number" &&
        session.loadedEndPosition < session.totalMessageCount - 1;
    }
  }

  private replayUiUpdatesAfterRevision(
    baselineRevision: number,
    updates: Array<{ sequence: number; update: any }>,
  ): void {
    updates
      .sort((left, right) => left.sequence - right.sequence)
      .forEach(({ update }) => {
        const revision = this.normalizeUiRevision(update?.uiRevision);
        if (revision > 0 && revision <= baselineRevision) return;
        this.applyUiUpdateNow(update);
      });
  }

  private replayPendingUiUpdates(
    sessionId: string,
    baselineRevision: number,
  ): void {
    const pending = this.pendingUiUpdatesBySession.get(sessionId);
    if (!pending || pending.length === 0) return;
    this.pendingUiUpdatesBySession.delete(sessionId);
    this.replayUiUpdatesAfterRevision(baselineRevision, pending);
  }

  private replayRecentUiUpdates(
    sessionId: string,
    baselineRevision: number,
  ): void {
    const recent = this.recentUiUpdatesBySession.get(sessionId) || [];
    this.replayUiUpdatesAfterRevision(baselineRevision, [...recent]);
  }

  private async resolveHydrationPayload(
    sessionId: string,
    fallbackTitle?: string | null,
    loadMessages = true,
  ): Promise<ChatHydrationPayload> {
    let metadata: SessionMetadataPayload | null = null;
    let legacySnapshot: Awaited<
      ReturnType<Window["gyshell"]["agent"]["getSessionSnapshot"]>
    > | null = null;
    let page: UiMessagePagePayload | null = null;

    const getMetadata = window.gyshell.agent.getSessionMetadata;
    if (typeof getMetadata === "function") {
      try {
        metadata = await getMetadata(sessionId);
      } catch (error) {
        console.warn(`Failed to read chat metadata for ${sessionId}:`, error);
      }
    }

    // Keep the old snapshot contract as a compatibility fallback for older
    // preload clients and non-desktop transports. Desktop never reaches this
    // path once the metadata API is available.
    if (!metadata) {
      try {
        legacySnapshot =
          await window.gyshell.agent.getSessionSnapshot(sessionId);
      } catch (error) {
        console.warn(
          `Failed to read legacy session snapshot for ${sessionId}:`,
          error,
        );
      }
    }

    if (loadMessages) {
      const getPage = window.gyshell.agent.getUiMessagePage;
      if (typeof getPage === "function") {
        try {
          page = this.normalizeUiMessagePage(
            await getPage(sessionId, { limit: this.initialMessagePageSize }),
            sessionId,
          );
        } catch (error) {
          console.warn(
            `Failed to read chat message page for ${sessionId}:`,
            error,
          );
        }
      }
      if (!page) {
        try {
          const messagesRaw =
            await window.gyshell.agent.getUiMessages(sessionId);
          const messages = Array.isArray(messagesRaw)
            ? (messagesRaw.filter(
                (item) => item && typeof item.id === "string",
              ) as ChatMessage[])
            : [];
          page = {
            sessionId,
            entries: messages.map((message, position) => ({
              position,
              message,
            })),
            totalCount: messages.length,
            startPosition: messages.length > 0 ? 0 : null,
            endPosition: messages.length > 0 ? messages.length - 1 : null,
            hasOlder: false,
            hasNewer: false,
            uiRevision: this.normalizeUiRevision(
              metadata?.uiRevision || legacySnapshot?.uiRevision,
            ),
            revisionPresent: false,
          };
        } catch (error) {
          console.warn(`Failed to read UI messages for ${sessionId}:`, error);
        }
      }
    }

    const normalizedFallbackTitle =
      typeof fallbackTitle === "string" && fallbackTitle.trim().length > 0
        ? fallbackTitle.trim()
        : null;
    const resolvedTitle =
      page?.metadata?.title ||
      metadata?.title ||
      legacySnapshot?.title ||
      normalizedFallbackTitle;
    const legacyMessageCount = Array.isArray(legacySnapshot?.messages)
      ? legacySnapshot.messages.length
      : 0;
    const totalMessageCount = Math.max(
      page?.totalCount || 0,
      Number(metadata?.messagesCount || 0),
      page?.entries.length || 0,
      legacyMessageCount,
    );
    const exists =
      !!metadata ||
      !!legacySnapshot ||
      !!resolvedTitle ||
      (page?.entries.length || 0) > 0;
    const messages = page?.entries.map((entry) => entry.message) || [];

    return {
      id: sessionId,
      exists,
      loaded: loadMessages && !!page,
      title: resolvedTitle || null,
      updatedAt: [
        page?.metadata?.updatedAt,
        metadata?.updatedAt,
        legacySnapshot?.updatedAt,
      ].find(
        (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
      ),
      messages,
      page,
      isBusy:
        page?.metadata?.isBusy === true ||
        metadata?.isBusy === true ||
        legacySnapshot?.isBusy === true,
      lockedProfileId:
        page?.metadata?.lockedProfileId ||
        metadata?.lockedProfileId ||
        legacySnapshot?.lockedProfileId ||
        null,
      totalMessageCount,
      uiRevision: Math.max(
        this.normalizeUiRevision(page?.metadata?.uiRevision),
        this.normalizeUiRevision(metadata?.uiRevision),
        this.normalizeUiRevision(legacySnapshot?.uiRevision),
        this.normalizeUiRevision(page?.uiRevision),
      ),
    };
  }

  async hydrateSessionsFromBackend(
    sessionIds: string[],
    preferredActiveSessionId?: string | null,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        (sessionIds || []).filter(
          (id) => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (ids.length === 0) return;

    let summaries: any[] = [];
    if (typeof window.gyshell.agent.listSessionSummaries === "function") {
      try {
        summaries = await window.gyshell.agent.listSessionSummaries();
      } catch (error) {
        console.warn("Failed to load session summaries:", error);
      }
    }
    if (summaries.length === 0) {
      summaries = await this.getAllChatHistory();
    }
    const summaryById = new Map<string, SessionMetadataPayload>();
    summaries.forEach((item) => {
      if (!item || typeof item.id !== "string") return;
      summaryById.set(item.id, item as SessionMetadataPayload);
    });

    // A layout can legitimately contain a session created by this renderer
    // before the backend inventory has flushed. Keep those ids as candidates;
    // validate missing entries with the lightweight metadata API below rather
    // than dropping them solely because the summary snapshot raced a write.
    const candidateIds = [...ids];
    const missingIds = candidateIds.filter((id) => !summaryById.has(id));
    if (missingIds.length > 0) {
      const getMetadata = window.gyshell.agent.getSessionMetadata;
      if (typeof getMetadata === "function") {
        const metadataResults = await Promise.all(
          missingIds.map(async (id) => {
            try {
              return [id, await getMetadata(id)] as const;
            } catch {
              return [id, null] as const;
            }
          }),
        );
        metadataResults.forEach(([id, metadata]) => {
          if (metadata) summaryById.set(id, metadata);
        });
      }
    }

    let validIds = candidateIds.filter((id) => summaryById.has(id));
    // Older transports do not expose summaries or metadata. Resolve their
    // inventory through the legacy snapshot contract as a compatibility path.
    if (validIds.length === 0 && candidateIds.length > 0) {
      const legacyPayloads = await Promise.all(
        candidateIds.map((id) => this.resolveHydrationPayload(id, null, false)),
      );
      legacyPayloads.forEach((payload) => {
        if (!payload.exists) return;
        summaryById.set(payload.id, {
          id: payload.id,
          title: payload.title || "New Chat",
          messagesCount: payload.totalMessageCount,
          isBusy: payload.isBusy,
          lockedProfileId: payload.lockedProfileId,
          uiRevision: payload.uiRevision,
        });
      });
      validIds = candidateIds.filter((id) => summaryById.has(id));
    }
    const validIdSet = new Set(validIds);
    this.sessions
      .filter((session) => !validIdSet.has(session.id))
      .forEach((session) => this.unregisterSessionWithBackend(session.id));

    const normalizedPreferredActiveId =
      typeof preferredActiveSessionId === "string" &&
      preferredActiveSessionId.length > 0
        ? preferredActiveSessionId
        : null;
    const existingActiveId =
      this.activeSessionId && validIds.includes(this.activeSessionId)
        ? this.activeSessionId
        : null;
    const activeId =
      (normalizedPreferredActiveId &&
      validIds.includes(normalizedPreferredActiveId)
        ? normalizedPreferredActiveId
        : existingActiveId) ||
      validIds[0] ||
      null;

    runInAction(() => {
      const existingById = new Map(
        this.sessions.map((session) => [session.id, session]),
      );
      let resolvedSessions = validIds.map((id) => {
        const session =
          existingById.get(id) ||
          this.createEmptySession(id, "New Chat", { loaded: false });
        this.applySessionMetadata(session, summaryById.get(id) || null);
        return session;
      });
      if (resolvedSessions.length === 0) {
        const fallbackSessionId = uuidv4();
        const fallback = this.createEmptySession(fallbackSessionId, "New Chat");
        this.markEmptySessionLoaded(fallback);
        resolvedSessions = [fallback];
        this.registerSessionWithBackend(fallbackSessionId);
      }
      this.sessions
        .filter(
          (session) => !resolvedSessions.some((next) => next.id === session.id),
        )
        .forEach((session) => {
          this.clearGeometryRuntimeState(session.id);
          this.unregisterSessionWithBackend(session.id);
        });
      this.sessions = resolvedSessions;
      this.activeSessionId =
        activeId && resolvedSessions.some((session) => session.id === activeId)
          ? activeId
          : resolvedSessions[0]?.id || null;
      this.sessionInventoryHydrated = true;
    });
    this.emitSessionsChanged();

    if (
      this.activeSessionId &&
      !this.sessionLoadPromises.has(this.activeSessionId)
    ) {
      await this.hydrateSessionFromBackend(this.activeSessionId, {
        activate: false,
        loadAgentContext: true,
      });
    }
  }

  createSession(
    title: string = "New Chat",
    options?: { activate?: boolean },
  ): string {
    const id = uuidv4();
    const session = this.createEmptySession(id, title, { loaded: true });
    runInAction(() => {
      this.sessions.push(session);
      if (options?.activate !== false) {
        this.activeSessionId = id;
      }
    });
    this.registerSessionWithBackend(id);
    this.emitSessionsChanged();
    return id;
  }

  ensureSession(id: string, title: string = "New Chat"): void {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return;
    }
    if (this.getSessionById(normalizedId)) {
      this.registerSessionWithBackend(normalizedId);
      return;
    }
    const normalizedTitle = String(title || "").trim() || "New Chat";
    const session = this.createEmptySession(normalizedId, normalizedTitle);
    runInAction(() => {
      this.sessions.push(session);
    });
    this.registerSessionWithBackend(normalizedId);
    this.emitSessionsChanged();
  }

  setActiveSession(id: string): void {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return;
    this.activeSessionId = normalizedId;
    const session = this.getSessionById(normalizedId);
    if (
      !session ||
      session.hasLoadedMessagePage ||
      this.sessionLoadPromises.has(normalizedId)
    ) {
      return;
    }
    void this.hydrateSessionFromBackend(normalizedId, {
      activate: false,
      loadAgentContext: true,
    }).catch((error) => {
      console.warn(
        `Failed to hydrate active chat session ${normalizedId}:`,
        error,
      );
    });
  }

  closeSession(id: string) {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;

    this.unregisterSessionWithBackend(id);

    const nextSessions = this.sessions.filter((s) => s.id !== id);
    let nextActiveId = this.activeSessionId;

    if (this.activeSessionId === id) {
      nextActiveId = nextSessions[idx - 1]?.id || nextSessions[0]?.id || null;
    }

    runInAction(() => {
      this.sessions = nextSessions;
      this.activeSessionId = nextActiveId;
    });
    this.clearGeometryRuntimeState(id);
    this.queue.clearSession(id);

    if (this.sessions.length === 0) {
      this.createSession();
      return;
    }
    this.emitSessionsChanged();
  }

  addMessage(
    msg: Omit<ChatMessage, "id" | "timestamp">,
    sessionId: string,
  ): string {
    const id = uuidv4();
    const fullMsg: ChatMessage = {
      ...msg,
      id,
      timestamp: Date.now(),
    };

    runInAction(() => {
      const session = this.sessions.find((s) => s.id === sessionId);
      if (session) {
        const nextMessage = session.geometryLoaded
          ? this.mergeLiveMessage(session, undefined, fullMsg)
          : fullMsg;
        session.messagesById.set(id, nextMessage);
        session.messageIds.push(id);
        session.updatedAt = nextMessage.timestamp;
        this.rebuildGeometryPositionMap(session);
        const nextPosition = session.messagePositionById?.get(id);
        if (typeof nextPosition === "number" && !nextMessage.deferredPayload) {
          session.loadedPayloadPositions?.add(nextPosition);
        }
        const renderedMessage = this.refreshLiveMessageGeometry(
          session,
          nextMessage,
        );
        if (renderedMessage !== nextMessage) {
          session.messagesById.set(id, renderedMessage);
        }
        this.trackGeometryMessagePayload(session, renderedMessage, {
          protect: true,
        });
        this.bumpSessionRenderListVersion(session);
        // Auto-update title based on first user message if title is default
        if (msg.role === "user") {
          const userMsgCount = session.messageIds.filter((msgId) => {
            const m = session.messagesById.get(msgId);
            return m && m.role === "user";
          }).length;
          const currentTitle = String(session.title || "").trim();
          if (
            userMsgCount === 1 &&
            (!currentTitle || currentTitle === "New Chat")
          ) {
            session.title = buildAutoSessionTitle(msg.content);
          }
        }
      }
    });
    return id;
  }

  updateMessage(id: string, patch: Partial<ChatMessage>, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const msg = session.messagesById.get(id);
    if (msg) {
      runInAction(() => {
        let nextMessage: ChatMessage = {
          ...msg,
          ...patch,
          metadata:
            patch.metadata === undefined
              ? msg.metadata
              : { ...(msg.metadata || {}), ...(patch.metadata || {}) },
        };
        if (session.geometryLoaded) {
          nextMessage = {
            ...nextMessage,
            payloadState: nextMessage.deferredPayload?.fields.length
              ? "page"
              : "full",
          };
          nextMessage = this.refreshLiveMessageGeometry(session, nextMessage);
        }
        session.messagesById.set(id, nextMessage);
        this.trackGeometryMessagePayload(session, nextMessage, {
          protect: true,
        });
        this.bumpSessionRenderListVersion(session);
      });
    }
  }

  removeMessage(id: string, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    runInAction(() => {
      session.messagesById.delete(id);
      session.messageIds = session.messageIds.filter((msgId) => msgId !== id);
      this.geometryPlaceholdersBySession.get(session.id)?.delete(id);
      this.fullPayloadRetentionBySession.get(session.id)?.delete(id);
      this.rebuildGeometryPositionMap(session, {
        clearLoadedPayloadPositions: true,
      });
      this.bumpSessionRenderListVersion(session);
    });
  }

  private normalizeCompactionBoundaryMessages(session: ChatSession): void {
    const orderedMessages = session.messageIds
      .map((messageId) => session.messagesById.get(messageId))
      .filter((message): message is ChatMessage => !!message);
    const normalized = normalizeCompactionBoundaryMessageOrder(orderedMessages);
    const normalizedIds = new Set(normalized.map((message) => message.id));

    orderedMessages.forEach((message) => {
      if (!normalizedIds.has(message.id)) {
        session.messagesById.delete(message.id);
      }
    });
    normalized.forEach((message) => {
      session.messagesById.set(message.id, message);
    });
    session.messageIds = normalized.map((message) => message.id);
  }

  private resolveInsertAnchorIndex(
    session: ChatSession,
    update: {
      anchorMessageId?: string;
      anchorBackendMessageId?: string;
    },
  ): number {
    if (typeof update.anchorMessageId === "string") {
      const byUiId = session.messageIds.indexOf(update.anchorMessageId);
      if (byUiId >= 0) return byUiId;
    }

    if (typeof update.anchorBackendMessageId === "string") {
      return session.messageIds.findIndex((messageId) => {
        const message = session.messagesById.get(messageId);
        return message?.backendMessageId === update.anchorBackendMessageId;
      });
    }

    return -1;
  }

  setThinking(thinking: boolean, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      runInAction(() => {
        session.isThinking = thinking;
      });
    }
  }

  setSessionBusy(busy: boolean, sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      runInAction(() => {
        session.isSessionBusy = busy;
      });
    }
  }

  setSessionLockedProfile(sessionId: string, profileId: string | null) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    runInAction(() => {
      session.lockedProfileId = profileId;
    });
  }

  clear() {
    if (!this.activeSessionId) return;
    const session = this.sessions.find((s) => s.id === this.activeSessionId);
    if (session) {
      runInAction(() => {
        this.clearGeometryRuntimeState(session.id);
        session.geometryLoaded = false;
        session.loadedPayloadPositions = new Set();
        session.messagePositionById = new Map();
        session.messagesById.clear();
        session.messageIds = [];
        this.markEmptySessionLoaded(session);
        this.bumpSessionRenderListVersion(session);
      });
    }
  }

  handleUiUpdate(update: any): void {
    const sessionId = String(update?.sessionId || "").trim();
    if (!sessionId) return;
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return;

    const recorded = this.recordUiUpdate(sessionId, update);
    const isHydrating = this.sessionLoadPromises.has(sessionId);
    const isUnloadedTranscriptUpdate =
      this.isTranscriptUiUpdate(update?.type) && !session.hasLoadedMessagePage;
    if (isHydrating || isUnloadedTranscriptUpdate) {
      this.queuePendingUiUpdate(sessionId, recorded);
      this.advanceSessionRecencyFromUiUpdate(session, update);
      if (update.type === "ADD_MESSAGE" && update.message?.role === "user") {
        session.isThinking = true;
        session.isSessionBusy = true;
      }
      return;
    }
    this.applyUiUpdateNow(update);
  }

  private applyUiUpdateNow(update: any): void {
    const { type, sessionId } = update;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      // Do not create a synthetic session from live updates.
      // If the session is not currently opened in the UI, keep UI stable and let
      // users load the real session explicitly from history.
      return;
    }
    const uiRevision = this.normalizeUiRevision(update?.uiRevision);
    const currentRevision = session.uiRevision || 0;
    // Versioned live actions are idempotent: equal revisions are replayed
    // duplicates, while unversioned actions remain compatible with legacy
    // transports that predate the revision contract.
    if (
      uiRevision > 0 &&
      currentRevision > 0 &&
      uiRevision <= currentRevision
    ) {
      return;
    }

    runInAction(() => {
      switch (type) {
        case "SESSION_RENAMED": {
          if (typeof update.title === "string") {
            session.title = update.title;
          }
          break;
        }
        case "ADD_MESSAGE": {
          const msg = update.message;
          if (!msg || typeof msg.id !== "string" || msg.id.length === 0) {
            break;
          }
          const previous = session.messagesById.get(msg.id);
          const existed = !!previous;
          const nextMessage = session.geometryLoaded
            ? this.mergeLiveMessage(session, previous, msg)
            : msg;
          session.messagesById.set(msg.id, nextMessage);
          if (!existed) {
            const previousTotal = Math.max(
              session.totalMessageCount || 0,
              session.messageIds.length,
            );
            session.messageIds.push(msg.id);
            session.totalMessageCount = previousTotal + 1;
            if (session.hasNewerMessages !== true) {
              session.loadedEndPosition = previousTotal;
              session.hasNewerMessages = false;
            }
            this.rebuildGeometryPositionMap(session);
            const nextPosition = session.messagePositionById?.get(msg.id);
            if (
              typeof nextPosition === "number" &&
              !nextMessage.deferredPayload
            ) {
              session.loadedPayloadPositions?.add(nextPosition);
            }
            const renderedMessage = this.refreshLiveMessageGeometry(
              session,
              nextMessage,
            );
            if (renderedMessage !== nextMessage) {
              session.messagesById.set(msg.id, renderedMessage);
            }
            this.trackGeometryMessagePayload(session, renderedMessage, {
              protect: true,
            });
            this.bumpSessionRenderListVersion(session);
          }
          if (existed) {
            const renderedMessage = this.refreshLiveMessageGeometry(
              session,
              nextMessage,
            );
            if (renderedMessage !== nextMessage) {
              session.messagesById.set(msg.id, renderedMessage);
            }
            this.trackGeometryMessagePayload(session, renderedMessage, {
              protect: true,
            });
            this.bumpSessionRenderListVersion(session);
          }
          // Auto-update title logic if needed (backend also does this, but for UX we can do it here too)
          if (!existed && msg.role === "user") {
            const userMsgCount = session.messageIds.filter((msgId) => {
              const m = session.messagesById.get(msgId);
              return m && m.role === "user";
            }).length;
            const currentTitle = String(session.title || "").trim();
            if (
              userMsgCount === 1 &&
              (!currentTitle || currentTitle === "New Chat")
            ) {
              session.title = buildAutoSessionTitle(msg.content);
            }
          }
          break;
        }
        case "INSERT_MESSAGE": {
          const msg = update.message;
          if (!msg || typeof msg.id !== "string" || msg.id.length === 0) {
            break;
          }
          const anchorIndex = this.resolveInsertAnchorIndex(session, update);
          if (anchorIndex < 0) {
            break;
          }

          const existingIndex = session.messageIds.indexOf(msg.id);
          if (existingIndex >= 0) {
            session.messageIds.splice(existingIndex, 1);
          }
          const nextMessage = session.geometryLoaded
            ? this.mergeLiveMessage(session, session.messagesById.get(msg.id), msg)
            : msg;
          session.messagesById.set(msg.id, nextMessage);

          const adjustedAnchorIndex =
            existingIndex >= 0 && existingIndex < anchorIndex
              ? anchorIndex - 1
              : anchorIndex;
          const insertIndex =
            update.placement === "after"
              ? adjustedAnchorIndex + 1
              : adjustedAnchorIndex;
          session.messageIds.splice(insertIndex, 0, msg.id);
          if (existingIndex < 0) {
            session.totalMessageCount =
              Math.max(
                session.totalMessageCount || 0,
                session.messageIds.length - 1,
              ) + 1;
            if (typeof session.loadedEndPosition === "number") {
              session.loadedEndPosition += 1;
            }
          }
          this.normalizeCompactionBoundaryMessages(session);
          this.rebuildGeometryPositionMap(session, {
            clearLoadedPayloadPositions: true,
          });
          const insertedMessage = session.messagesById.get(msg.id) || msg;
          const renderedMessage = this.refreshLiveMessageGeometry(
            session,
            insertedMessage,
          );
          if (renderedMessage !== insertedMessage) {
            session.messagesById.set(msg.id, renderedMessage);
          }
          this.trackGeometryMessagePayload(session, renderedMessage, {
            protect: true,
          });
          this.bumpSessionRenderListVersion(session);
          break;
        }
        case "REMOVE_MESSAGE": {
          const existed = session.messagesById.delete(update.messageId);
          this.geometryPlaceholdersBySession
            .get(session.id)
            ?.delete(update.messageId);
          this.fullPayloadRetentionBySession
            .get(session.id)
            ?.delete(update.messageId);
          session.messageIds = session.messageIds.filter(
            (id) => id !== update.messageId,
          );
          if (existed) {
            session.totalMessageCount = Math.max(
              0,
              (session.totalMessageCount || 1) - 1,
            );
            if (typeof session.loadedEndPosition === "number") {
              session.loadedEndPosition = Math.max(
                (session.loadedStartPosition || 0) - 1,
                session.loadedEndPosition - 1,
              );
            }
          }
          this.rebuildGeometryPositionMap(session, {
            clearLoadedPayloadPositions: true,
          });
          this.bumpSessionRenderListVersion(session);
          break;
        }
        case "APPEND_CONTENT": {
          const currentMessage = session.messagesById.get(update.messageId);
          if (currentMessage) {
            session.messagesById.set(currentMessage.id, {
              ...currentMessage,
              content: currentMessage.content + String(update.content || ""),
              ...(currentMessage.payloadState === "geometry"
                ? { payloadState: "page" as const }
                : {}),
            });
          }
          break;
        }
        case "APPEND_OUTPUT": {
          const currentMessage = session.messagesById.get(update.messageId);
          if (currentMessage) {
            session.messagesById.set(currentMessage.id, {
              ...currentMessage,
              metadata: {
                ...(currentMessage.metadata || {}),
                output:
                  (currentMessage.metadata?.output || "") +
                  String(update.outputDelta || ""),
              },
              ...(currentMessage.payloadState === "geometry"
                ? { payloadState: "page" as const }
                : {}),
            });
          }
          break;
        }
        case "UPDATE_MESSAGE": {
          const msg = session.messagesById.get(update.messageId);
          if (msg) {
            let nextMessage: ChatMessage = {
              ...msg,
              ...update.patch,
              metadata:
                update.patch?.metadata === undefined
                  ? msg.metadata
                  : {
                      ...(msg.metadata || {}),
                      ...(update.patch.metadata || {}),
                    },
            };
            if (session.geometryLoaded) {
              nextMessage = {
                ...nextMessage,
                payloadState: nextMessage.deferredPayload?.fields.length
                  ? "page"
                  : "full",
              };
              nextMessage = this.refreshLiveMessageGeometry(
                session,
                nextMessage,
              );
            }
            session.messagesById.set(msg.id, nextMessage);
            this.trackGeometryMessagePayload(session, nextMessage, {
              protect: true,
            });
            this.bumpSessionRenderListVersion(session);
          }
          break;
        }
        case "DONE":
          session.isThinking = false;
          break;
        case "SESSION_PROFILE_LOCKED":
          session.isSessionBusy = true;
          session.lockedProfileId = update.lockedProfileId || null;
          break;
        case "SESSION_READY":
          session.isSessionBusy = false;
          session.lockedProfileId = null;
          if (this.queue.shouldDispatchNextOnSessionReady(sessionId)) {
            void this.runNextQueueItem(sessionId);
          }
          break;
        case "ROLLBACK": {
          const rollbackIndex = session.messageIds.findIndex((messageId) => {
            const message = session.messagesById.get(messageId);
            return message?.backendMessageId === update.messageId;
          });
          if (rollbackIndex !== -1) {
            const removedIds = session.messageIds.slice(rollbackIndex);
            removedIds.forEach((messageId) => {
              session.messagesById.delete(messageId);
              this.geometryPlaceholdersBySession
                .get(session.id)
                ?.delete(messageId);
              this.fullPayloadRetentionBySession
                .get(session.id)
                ?.delete(messageId);
            });
            session.messageIds = session.messageIds.slice(0, rollbackIndex);
            const nextTotal =
              Math.max(0, session.loadedStartPosition || 0) + rollbackIndex;
            session.totalMessageCount = nextTotal;
            session.loadedEndPosition = nextTotal - 1;
            session.hasNewerMessages = false;
            this.normalizeCompactionBoundaryMessages(session);
            this.rebuildGeometryPositionMap(session, {
              clearLoadedPayloadPositions: true,
            });
            this.bumpSessionRenderListVersion(session);
          }
          session.isThinking = false;
          session.isSessionBusy = false;
          session.lockedProfileId = null;
          break;
        }
      }
      this.advanceSessionRecencyFromUiUpdate(session, update);
      if (uiRevision > 0) {
        session.uiRevision = Math.max(session.uiRevision || 0, uiRevision);
      }
    });

    if (type === "ADD_MESSAGE" && update.message?.role === "user") {
      runInAction(() => {
        session.isThinking = true;
        session.isSessionBusy = true;
      });
    }

    if (type === "ADD_MESSAGE" && update.message?.type === "error") {
      this.stopQueue(sessionId);
      return;
    }
  }

  private async hydrateSessionFromBackendInternal(
    sessionId: string,
    options?: {
      activate?: boolean;
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    const existing = this.sessions.find((session) => session.id === sessionId);
    const payload = await this.resolveHydrationPayload(
      sessionId,
      existing?.title || null,
      true,
    );
    if (!payload.exists) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    runInAction(() => {
      let session = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (!session) {
        session = this.createEmptySession(
          sessionId,
          payload.title || "Loaded Session",
        );
        this.sessions.push(session);
      }
      if (payload.page) {
        this.applyMessagePage(session, payload.page, "replace");
      }
      if (!payload.page) {
        this.applySessionMetadata(session, {
          id: payload.id,
          title: payload.title || session.title,
          updatedAt: payload.updatedAt,
          messagesCount: payload.totalMessageCount,
          isBusy: payload.isBusy,
          lockedProfileId: payload.lockedProfileId,
          uiRevision: payload.uiRevision,
        });
      }
      if (!payload.page && payload.totalMessageCount === 0) {
        this.markEmptySessionLoaded(session);
      }
      if (options?.activate !== false) {
        this.activeSessionId = sessionId;
      }
    });

    // The page is now the baseline. Allow live events to apply while replaying
    // only updates that are newer than the returned snapshot.
    const geometryLoaded = await this.loadMessageGeometryIndex(sessionId);
    if (geometryLoaded && payload.page) {
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (current) {
          this.mergeLoadedPageIntoGeometrySession(current, payload.page!, {
            start: payload.page!.startPosition ?? 0,
            end: payload.page!.endPosition ?? 0,
          });
        }
      });
    }
    const pendingMessageIds = Array.from(
      new Set(
        (this.pendingUiUpdatesBySession.get(sessionId) || []).flatMap(
          ({ update }) => {
            const ids: string[] = [];
            if (typeof update?.messageId === "string") ids.push(update.messageId);
            if (typeof update?.message?.id === "string") {
              ids.push(update.message.id);
            }
            return ids;
          },
        ),
      ),
    );
    this.replayPendingUiUpdates(sessionId, payload.uiRevision);
    this.sessionLoadPromises.delete(sessionId);
    if (pendingMessageIds.length > 0) {
      await this.loadFullMessages(sessionId, pendingMessageIds);
    }
    this.emitSessionsChanged();

    if (options?.loadAgentContext !== false) {
      const runtimeLoader = window.gyshell.agent.loadChatRuntimeSession;
      if (typeof runtimeLoader === "function") {
        await runtimeLoader(sessionId);
      } else {
        // Compatibility fallback for older preload bundles.
        await window.gyshell.agent.loadChatSession(sessionId);
      }
    }
  }

  async hydrateSessionFromBackend(
    sessionId: string,
    options?: {
      activate?: boolean;
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return;
    if (options?.activate !== false) {
      this.activeSessionId = normalizedSessionId;
    }
    const existingLoad = this.sessionLoadPromises.get(normalizedSessionId);
    if (existingLoad) {
      await existingLoad;
      return;
    }

    const loadPromise = this.hydrateSessionFromBackendInternal(
      normalizedSessionId,
      options,
    );
    this.sessionLoadPromises.set(normalizedSessionId, loadPromise);
    try {
      await loadPromise;
    } finally {
      if (this.sessionLoadPromises.get(normalizedSessionId) === loadPromise) {
        this.sessionLoadPromises.delete(normalizedSessionId);
      }
    }
  }

  async loadMessageRange(
    sessionId: string,
    startPosition: number,
    endPosition: number,
  ): Promise<boolean> {
    const session = this.getSessionById(sessionId);
    if (!session || !session.geometryLoaded) return false;
    const start = Math.max(0, Math.floor(startPosition));
    const end = Math.min(
      Math.max(start, Math.floor(endPosition)),
      Math.max(0, (session.totalMessageCount || 0) - 1),
    );
    const residentChunkStarts = new Set<number>();
    const requiredChunkStarts = new Set<number>();
    for (let position = start; position <= end; position += 1) {
      const messageId = session.messageIds[position];
      const message = messageId
        ? session.messagesById.get(messageId)
        : undefined;
      const chunkStart =
        Math.floor(position / CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE) *
        CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE;
      if (message?.payloadState === "page") {
        residentChunkStarts.add(chunkStart);
      }
      if (session.loadedPayloadPositions?.has(position)) continue;
      if (!message?.deferredPayload?.fields.length) {
        session.loadedPayloadPositions?.add(position);
        continue;
      }
      requiredChunkStarts.add(chunkStart);
    }

    runInAction(() => {
      const current = this.getSessionById(sessionId);
      if (current?.geometryLoaded) {
        this.touchGeometryPagePayloadChunks(current, residentChunkStarts);
      }
    });

    const loadChunk = (chunkStart: number): Promise<boolean> => {
      const key = `${sessionId}:${chunkStart}`;
      const existing = this.messageRangeLoadPromises.get(key);
      if (existing) return existing;
      const promise = (async () => {
        const currentBeforeRequest = this.getSessionById(sessionId);
        if (!currentBeforeRequest?.geometryLoaded) return false;
        const chunkEnd = Math.min(
          chunkStart + CHAT_GEOMETRY_PAYLOAD_CHUNK_SIZE - 1,
          Math.max(0, (currentBeforeRequest.totalMessageCount || 0) - 1),
        );
        let hasMissingPayload = false;
        for (let position = chunkStart; position <= chunkEnd; position += 1) {
          if (!currentBeforeRequest.loadedPayloadPositions?.has(position)) {
            hasMissingPayload = true;
            break;
          }
        }
        if (!hasMissingPayload) return true;

        const limit = chunkEnd - chunkStart + 1;
        const page = this.normalizeUiMessagePage(
          await window.gyshell.agent.getUiMessagePage(sessionId, {
            aroundPosition: chunkStart + Math.floor(limit / 2),
            limit,
          }),
          sessionId,
        );
        if (!page) return false;
        let applied = false;
        runInAction(() => {
          const current = this.getSessionById(sessionId);
          if (!current?.geometryLoaded) return;
          applied = this.mergeLoadedPageIntoGeometrySession(current, page);
        });
        return applied;
      })();
      this.messageRangeLoadPromises.set(key, promise);
      const releasePromise = (): void => {
        if (this.messageRangeLoadPromises.get(key) === promise) {
          this.messageRangeLoadPromises.delete(key);
        }
      };
      void promise.then(releasePromise, releasePromise);
      return promise;
    };

    const results = await Promise.all(
      Array.from(requiredChunkStarts, loadChunk),
    );
    return requiredChunkStarts.size === 0 || results.some(Boolean);
  }

  async loadOlderMessages(sessionId: string, limit = 300): Promise<boolean> {
    const session = this.getSessionById(sessionId);
    if (session?.geometryLoaded) {
      return false;
    }
    if (
      !session ||
      session.isLoadingOlderMessages ||
      session.hasOlderMessages !== true ||
      typeof session.loadedStartPosition !== "number"
    ) {
      return false;
    }
    const beforePosition = session.loadedStartPosition;
    runInAction(() => {
      session.isLoadingOlderMessages = true;
    });
    try {
      const page = this.normalizeUiMessagePage(
        await window.gyshell.agent.getUiMessagePage(sessionId, {
          beforePosition,
          limit,
        }),
        sessionId,
      );
      if (!page) return false;
      let applied = false;
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (!current) return;
        applied = this.applyMessagePage(current, page, "prepend");
      });
      return applied;
    } finally {
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (current) current.isLoadingOlderMessages = false;
      });
    }
  }

  async loadNewerMessages(sessionId: string, limit = 300): Promise<boolean> {
    const session = this.getSessionById(sessionId);
    if (session?.geometryLoaded) {
      return false;
    }
    if (
      !session ||
      session.isLoadingNewerMessages ||
      session.hasNewerMessages !== true ||
      typeof session.loadedEndPosition !== "number"
    ) {
      return false;
    }
    const afterPosition = session.loadedEndPosition;
    runInAction(() => {
      session.isLoadingNewerMessages = true;
    });
    try {
      const page = this.normalizeUiMessagePage(
        await window.gyshell.agent.getUiMessagePage(sessionId, {
          afterPosition,
          limit,
        }),
        sessionId,
      );
      if (!page) return false;
      let applied = false;
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (!current) return;
        applied = this.applyMessagePage(current, page, "append");
      });
      return applied;
    } finally {
      runInAction(() => {
        const current = this.getSessionById(sessionId);
        if (current) current.isLoadingNewerMessages = false;
      });
    }
  }

  async loadMessagesAroundPosition(
    sessionId: string,
    position: number,
    limit = 300,
  ): Promise<boolean> {
    const page = this.normalizeUiMessagePage(
      await window.gyshell.agent.getUiMessagePage(sessionId, {
        aroundPosition: Math.max(0, Math.floor(position)),
        limit,
      }),
      sessionId,
    );
    if (!page) return false;
    let applied = false;
    runInAction(() => {
      const session = this.getSessionById(sessionId);
      if (!session) return;
      applied = this.applyMessagePage(session, page, "replace");
      if (applied)
        this.replayRecentUiUpdates(sessionId, this.getPageRevision(page));
    });
    return applied;
  }

  private reconcileFullMessageWithRecentUpdates(
    sessionId: string,
    currentMessage: ChatMessage,
    incomingMessage: ChatMessage,
    responseRevision: number,
    requestSequence: number,
    responseRevisionPresent: boolean,
  ): ChatMessage | null {
    const currentRevision = this.getSessionById(sessionId)?.uiRevision || 0;
    const recent = this.recentUiUpdatesBySession.get(sessionId) || [];
    const newerUpdates = recent.filter(({ sequence, update }) => {
      const targetsMessage =
        update?.messageId === currentMessage.id ||
        (update?.type === "ROLLBACK" &&
          update.messageId === currentMessage.backendMessageId);
      if (!targetsMessage) return false;
      const revision = this.normalizeUiRevision(update?.uiRevision);
      return responseRevisionPresent
        ? revision > responseRevision ||
            (revision === 0 && sequence > requestSequence)
        : sequence > requestSequence;
    });

    // A full-payload response hydrates only fields that were deferred in the
    // current row. It must never replace live status, streaming, or unrelated
    // metadata from a newer renderer revision. Even when the response is old
    // because an unrelated session update raced it, the deferred fields remain
    // safe to hydrate; only message-targeted newer actions are replayed below.
    const deferredFields = new Set(
      currentMessage.deferredPayload?.fields || [],
    );
    const staleVersionedResponse =
      responseRevisionPresent &&
      currentRevision > 0 &&
      this.isUiRevisionStale(responseRevision, currentRevision);
    const unsafeUnversionedStreamingResponse =
      currentMessage.streaming === true &&
      !responseRevisionPresent &&
      newerUpdates.length === 0;
    if (unsafeUnversionedStreamingResponse) {
      return currentMessage;
    }
    const canHydrateStaleRow =
      !staleVersionedResponse ||
      newerUpdates.length > 0 ||
      currentMessage.streaming !== true;
    const hydratedFields = new Set<string>();
    let reconciled: ChatMessage = {
      ...currentMessage,
      metadata: currentMessage.metadata
        ? { ...currentMessage.metadata }
        : undefined,
    };
    const metadata = { ...(reconciled.metadata || {}) };

    if (deferredFields.has("metadata") && canHydrateStaleRow) {
      const payloadMetadataFields = new Set([
        "output",
        "diff",
        "details",
        "inputImages",
      ]);
      const mutableMetadata = metadata as Record<string, unknown>;
      Object.keys(mutableMetadata).forEach((key) => {
        if (!payloadMetadataFields.has(key)) delete mutableMetadata[key];
      });
      Object.entries(incomingMessage.metadata || {}).forEach(([key, value]) => {
        if (!payloadMetadataFields.has(key)) mutableMetadata[key] = value;
      });
      hydratedFields.add("metadata");
    }

    if (
      deferredFields.has("content") &&
      canHydrateStaleRow &&
      typeof incomingMessage.content === "string"
    ) {
      reconciled.content = incomingMessage.content;
      hydratedFields.add("content");
    }
    for (const field of ["output", "diff", "details", "inputImages"] as const) {
      if (!deferredFields.has(field) || !canHydrateStaleRow) continue;
      const incomingValue =
        incomingMessage.metadata?.[
        field as keyof NonNullable<ChatMessage["metadata"]>
      ];
      if (incomingValue !== undefined) {
        metadata[field] = incomingValue as never;
        hydratedFields.add(field);
      }
    }
    reconciled.metadata =
      Object.keys(metadata).length > 0 ? metadata : undefined;
    const remainingFields = [...deferredFields].filter(
      (field) => !hydratedFields.has(field),
    ) as Array<NonNullable<ChatMessage["deferredPayload"]>["fields"][number]>;
    reconciled.deferredPayload =
      remainingFields.length > 0 ? { fields: remainingFields } : undefined;

    // If the response is older than the current session, the newer live
    // actions above are replayed only when their sequence/revision is still
    // available in the bounded event log.
    for (const { update } of newerUpdates) {
      if (
        update?.type === "REMOVE_MESSAGE" &&
        update.messageId === reconciled.id
      ) {
        return null;
      }
      if (update?.messageId !== reconciled.id) continue;
      if (update.type === "APPEND_CONTENT") {
        reconciled.content += String(update.content || "");
      } else if (update.type === "APPEND_OUTPUT") {
        reconciled.metadata = {
          ...(reconciled.metadata || {}),
          output:
            (reconciled.metadata?.output || "") +
            String(update.outputDelta || ""),
        };
      } else if (update.type === "UPDATE_MESSAGE") {
        const patch = update.patch || {};
        reconciled = {
          ...reconciled,
          ...patch,
          metadata:
            patch.metadata === undefined
              ? reconciled.metadata
              : {
                  ...(reconciled.metadata || {}),
                  ...(patch.metadata || {}),
                },
        };
      }
    }
    return reconciled;
  }

  private async loadFullMessageBatch(
    sessionId: string,
    ids: string[],
  ): Promise<ChatMessage[]> {
    if (ids.length === 0) return [];
    const loadKey = `${sessionId}:${ids.join(":")}`;
    const existingLoad = this.fullMessageLoadPromises.get(loadKey);
    if (existingLoad) return existingLoad;
    const requestSequence = this.uiUpdateSequence;

    const loadPromise = (async (): Promise<ChatMessage[]> => {
      const getFullMessages = window.gyshell.agent.getFullUiMessages;
      const full =
        typeof getFullMessages === "function"
          ? await getFullMessages(sessionId, ids)
          : await window.gyshell.agent.getUiMessages(sessionId);
      const rawMessages = Array.isArray(full)
        ? full
        : Array.isArray((full as any)?.messages)
          ? (full as any).messages
          : [];
      const responseRevisionPresent =
        !Array.isArray(full) &&
        Object.prototype.hasOwnProperty.call(full, "uiRevision");
      const responseRevision = this.normalizeUiRevision(
        responseRevisionPresent ? (full as any)?.uiRevision : 0,
      );
      const current = this.getSessionById(sessionId);
      if (!current) return [];
      const requestedIds = new Set(ids);
      const messages: ChatMessage[] = [];
      for (const rawMessage of rawMessages as unknown[]) {
        if (
          !rawMessage ||
          typeof rawMessage !== "object" ||
          typeof (rawMessage as ChatMessage).id !== "string"
        ) {
          continue;
        }
        const incoming = rawMessage as ChatMessage;
        if (!requestedIds.has(incoming.id)) continue;
        const existing = current.messagesById.get(incoming.id);
        if (!existing) continue;
        const reconciled = this.reconcileFullMessageWithRecentUpdates(
          sessionId,
          existing,
          incoming,
          responseRevision,
          requestSequence,
          responseRevisionPresent,
        );
        if (reconciled) messages.push(reconciled);
      }
      runInAction(() => {
        const latest = this.getSessionById(sessionId);
        if (!latest) return;
        const protectedMessageIds = new Set<string>();
        let protectedCharacters = 0;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          const size = this.estimateFullPayloadCharacters(message);
          if (
            protectedMessageIds.size > 0 &&
            protectedCharacters + size > CHAT_FULL_PAYLOAD_MAX_CHARACTERS
          ) {
            break;
          }
          protectedMessageIds.add(message.id);
          protectedCharacters += size;
        }
        messages.forEach((message) => {
          if (!latest.messagesById.has(message.id)) return;
          const storedMessage = message.deferredPayload?.fields.length
            ? message
            : { ...message, payloadState: "full" as const };
          latest.messagesById.set(message.id, storedMessage);
          const position = latest.messagePositionById?.get(message.id);
          if (typeof position === "number") {
            latest.loadedPayloadPositions?.add(position);
          }
          if (storedMessage.payloadState === "full") {
            this.rememberGeometryPlaceholder(latest, storedMessage);
            this.touchFullPayload(latest, storedMessage);
          }
        });
        this.pruneFullPayloads(latest, protectedMessageIds);
        latest.uiRevision = Math.max(latest.uiRevision || 0, responseRevision);
        if (messages.length > 0) this.bumpSessionRenderListVersion(latest);
      });
      return messages;
    })();
    this.fullMessageLoadPromises.set(loadKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (this.fullMessageLoadPromises.get(loadKey) === loadPromise) {
        this.fullMessageLoadPromises.delete(loadKey);
      }
    }
  }

  async loadFullMessages(
    sessionId: string,
    messageIds: string[],
  ): Promise<ChatMessage[]> {
    const session = this.getSessionById(sessionId);
    if (!session) return [];
    const ids = Array.from(
      new Set(
        messageIds.filter(
          (messageId) =>
            !!messageId &&
            session.messagesById.get(messageId)?.deferredPayload !== undefined,
        ),
      ),
    );
    if (ids.length === 0) return [];

    const promiseById = new Map<string, Promise<ChatMessage | undefined>>();
    const missingIds: string[] = [];
    ids.forEach((messageId) => {
      const key = `${sessionId}:${messageId}`;
      const existing = this.fullMessageLoadByIdPromises.get(key);
      if (existing) {
        promiseById.set(messageId, existing);
      } else {
        missingIds.push(messageId);
      }
    });

    let previousBatch = Promise.resolve<void>(undefined);
    for (
      let offset = 0;
      offset < missingIds.length;
      offset += CHAT_FULL_PAYLOAD_REQUEST_MAX_MESSAGES
    ) {
      const batchIds = missingIds.slice(
        offset,
        offset + CHAT_FULL_PAYLOAD_REQUEST_MAX_MESSAGES,
      );
      const batchPromise = previousBatch.then(() =>
        this.loadFullMessageBatch(sessionId, batchIds),
      );
      previousBatch = batchPromise.then(
        () => undefined,
        () => undefined,
      );
      batchIds.forEach((messageId) => {
        const key = `${sessionId}:${messageId}`;
        const messagePromise = batchPromise.then((messages) =>
          messages.find((message) => message.id === messageId),
        );
        this.fullMessageLoadByIdPromises.set(key, messagePromise);
        promiseById.set(messageId, messagePromise);
        const release = (): void => {
          if (this.fullMessageLoadByIdPromises.get(key) === messagePromise) {
            this.fullMessageLoadByIdPromises.delete(key);
          }
        };
        void messagePromise.then(release, release);
      });
    }

    const messages = await Promise.all(
      ids.map((messageId) => promiseById.get(messageId)!),
    );
    return messages.filter((message): message is ChatMessage => !!message);
  }

  async searchMessages(
    sessionId: string,
    query: string,
    limit = 500,
  ): Promise<any> {
    const search = window.gyshell.agent.searchUiMessages;
    if (typeof search === "function") {
      const requestedRevision = this.getSessionById(sessionId)?.uiRevision || 0;
      const first = await search(sessionId, query, limit);
      const firstResponseRevision =
        this.getSessionById(sessionId)?.uiRevision || requestedRevision;
      if (!this.isVersionedResponseStale(first, firstResponseRevision)) {
        return first;
      }

      // Search is synchronous in the backend but its IPC response can arrive
      // after a live update. Retry once without showing a loading/error state;
      // if the second answer is still old, the caller keeps its current result.
      const currentRevision =
        this.getSessionById(sessionId)?.uiRevision || firstResponseRevision;
      const retry = await search(sessionId, query, limit);
      return this.isVersionedResponseStale(retry, currentRevision)
        ? null
        : retry;
    }
    const session = this.getSessionById(sessionId);
    const normalized = String(query || "")
      .trim()
      .toLowerCase();
    const matches = session
      ? session.messageIds
          .map((id, position) => ({
            id,
            position,
            message: session.messagesById.get(id),
          }))
          .filter(
            (entry) =>
              !!entry.message &&
              normalized.length > 0 &&
              String(entry.message.content || "")
                .toLowerCase()
                .includes(normalized),
          )
          .slice(0, limit)
          .map((entry) => ({
            messageId: entry.id,
            position: entry.position,
            preview: entry.message?.content || "",
          }))
      : [];
    return {
      sessionId,
      query: String(query || ""),
      matches,
      totalMatches: matches.length,
      truncated: false,
    };
  }

  async loadChatHistory(
    sessionId: string,
    options?: {
      activate?: boolean;
      loadAgentContext?: boolean;
    },
  ): Promise<void> {
    await this.hydrateSessionFromBackend(sessionId, {
      activate: options?.activate !== false,
      loadAgentContext: options?.loadAgentContext !== false,
    });
  }

  async getAllChatHistory(): Promise<any[]> {
    try {
      // Desktop history pickers only need summaries. Keep the legacy full
      // transcript endpoint as a fallback for older preload clients.
      if (typeof window.gyshell.agent.listSessionSummaries === "function") {
        return await window.gyshell.agent.listSessionSummaries();
      }
      return await window.gyshell.agent.getAllChatHistory();
    } catch (error) {
      console.error("Failed to get chat history:", error);
      return [];
    }
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    await this.deleteChatSessions([sessionId]);
  }

  async deleteChatSessions(sessionIds: string[]): Promise<void> {
    const ids = Array.from(
      new Set(sessionIds.filter((id) => id.trim().length > 0)),
    );
    if (ids.length === 0) {
      return;
    }
    try {
      if (ids.length === 1) {
        await window.gyshell.agent.deleteChatSession(ids[0]);
      } else {
        await window.gyshell.agent.deleteChatSessions(ids);
      }

      runInAction(() => {
        const deletedIds = new Set(ids);
        const wasActive = this.activeSessionId
          ? deletedIds.has(this.activeSessionId)
          : false;
        this.sessions = this.sessions.filter(
          (session) => !deletedIds.has(session.id),
        );

        if (wasActive) {
          if (this.sessions.length > 0) {
            this.activeSessionId = this.sessions[0].id;
          }
        }
      });
      ids.forEach((id) => {
        this.clearGeometryRuntimeState(id);
        this.ownedBackendSessionIds.delete(id);
        this.sessionOwnershipVersions.delete(id);
        this.sessionRegistrationPromises.delete(id);
        this.pendingUiUpdatesBySession.delete(id);
        this.recentUiUpdatesBySession.delete(id);
      });
      ids.forEach((id) => this.queue.clearSession(id));
      if (this.sessions.length === 0) {
        this.createSession();
        return;
      }
      this.emitSessionsChanged();
    } catch (error) {
      console.error("Failed to delete chat session(s):", error);
      throw error;
    }
  }

  async renameChatSession(sessionId: string, newTitle: string): Promise<void> {
    try {
      if (!(await this.ensureSessionOwnershipRegistered(sessionId))) {
        throw new Error(`Failed to register chat session ${sessionId}`);
      }
      await window.gyshell.agent.renameSession(sessionId, newTitle);
      runInAction(() => {
        const session = this.sessions.find((s) => s.id === sessionId);
        if (session) {
          session.title = newTitle;
          session.updatedAt = Date.now();
        }
      });
    } catch (error) {
      console.error("Failed to rename chat session:", error);
      throw error;
    }
  }

  async branchFromMessage(
    sessionId: string,
    backendMessageId: string,
  ): Promise<{
    ok: boolean;
    sessionId?: string;
    title?: string;
    messageCount?: number;
    reason?: string;
  }> {
    const result = await window.gyshell.agent.branchFromMessage(
      sessionId,
      backendMessageId,
    );
    if (!result?.ok || !result.sessionId) {
      throw new Error(result?.reason || "Failed to branch chat session.");
    }
    await this.hydrateSessionFromBackend(result.sessionId, {
      activate: true,
      loadAgentContext: true,
    });
    return result;
  }

  rollbackToMessage(sessionId: string, backendMessageId: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    // Find the index of the message to rollback to
    const idx = session.messageIds.findIndex((msgId) => {
      const msg = session.messagesById.get(msgId);
      return msg && msg.backendMessageId === backendMessageId;
    });
    if (idx === -1) return;

    runInAction(() => {
      // Remove messages after the rollback point
      const keptIds = session.messageIds.slice(0, idx);
      const removedIds = session.messageIds.slice(idx);

      // Delete from Map
      removedIds.forEach((msgId) => {
        session.messagesById.delete(msgId);
        this.geometryPlaceholdersBySession.get(session.id)?.delete(msgId);
        this.fullPayloadRetentionBySession.get(session.id)?.delete(msgId);
      });

      // Update IDs array
      session.messageIds = keptIds;
      this.normalizeCompactionBoundaryMessages(session);
      this.rebuildGeometryPositionMap(session, {
        clearLoadedPayloadPositions: true,
      });
      this.bumpSessionRenderListVersion(session);
      session.isThinking = false;
    });
  }

  setQueueRunner(
    runner: (sessionId: string, input: UserInputPayload) => Promise<boolean>,
  ): void {
    this.queueRunner = runner;
  }

  setQueueMode(sessionId: string, enabled: boolean): void {
    this.queue.setQueueMode(enabled, sessionId);
    const session = this.sessions.find((s) => s.id === sessionId);
    const isBusy = !!session?.isSessionBusy;
    if (enabled) {
      if (isBusy) {
        // Inherit active run from normal mode; queue continues seamlessly after current run.
        this.queue.startRun(sessionId);
      } else {
        this.queue.stopRun(sessionId);
      }
      return;
    }
    if (isBusy && this.queue.isRunning(sessionId)) {
      // Switching to normal while queue is running: finish current run, then stop queue dispatch.
      this.queue.requestStopAfterCurrent(sessionId);
    } else {
      this.queue.stopRun(sessionId);
    }
  }

  addQueueItem(
    sessionId: string,
    content: string,
    images?: InputImageAttachment[],
  ): QueueItem | null {
    const trimmed = String(content || "").trim();
    const normalizedImages = Array.isArray(images)
      ? images.filter((item) => {
          const hasAttachmentId = !!String(item?.attachmentId || "").trim();
          const hasLocalFile = (item as any)?.localFile instanceof File;
          return hasAttachmentId || hasLocalFile;
        })
      : [];
    if (!trimmed && normalizedImages.length === 0) return null;
    return this.queue.addItem(sessionId, trimmed, normalizedImages);
  }

  removeQueueItem(sessionId: string, itemId: string): void {
    this.queue.removeItem(sessionId, itemId);
  }

  moveQueueItem(sessionId: string, fromIndex: number, toIndex: number): void {
    this.queue.moveItem(sessionId, fromIndex, toIndex);
  }

  startQueue(sessionId: string): void {
    if (this.queue.isRunning(sessionId)) return;
    if (this.queue.getQueue(sessionId).length === 0) return;
    this.queue.startRun(sessionId);
    void this.runNextQueueItem(sessionId);
  }

  stopQueue(sessionId: string): void {
    if (!sessionId) return;
    this.queue.stopRun(sessionId);
  }

  private async runNextQueueItem(sessionId: string): Promise<void> {
    const next = this.queue.shiftItem(sessionId);
    if (!next) {
      this.queue.stopRun(sessionId);
      return;
    }
    if (!this.queue.isRunning(sessionId)) {
      this.queue.unshiftItem(sessionId, next);
      return;
    }
    if (
      !this.queueRunner ||
      !(await this.queueRunner(sessionId, {
        text: next.content,
        ...(Array.isArray(next.images) && next.images.length > 0
          ? { images: next.images }
          : {}),
      }))
    ) {
      this.queue.unshiftItem(sessionId, next);
      this.queue.stopRun(sessionId);
      return;
    }
  }
}
