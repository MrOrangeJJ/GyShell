import type {
  IGatewayRuntime,
  StartTaskInput,
  StartTaskOptions,
} from "./types";
import {
  WebSocketClientTransport,
  type IWebSocketConnectionLike,
} from "./WebSocketClientTransport";
import { WebSocketServer } from "ws";
import type {
  FileTransferTaskSnapshot,
  ListFileTransfersOptions,
  StartFileTransferInput,
} from "../FileTransferService";

type WebSocketRpcMethod =
  | "gateway:ping"
  | "gateway:isSameMachine"
  | "gateway:createSession"
  | "session:list"
  | "session:get"
  | "agent:exportHistory"
  | "agent:getAllChatHistory"
  | "agent:loadChatSession"
  | "agent:getUiMessages"
  | "terminal:list"
  | "terminal:createTab"
  | "terminal:write"
  | "terminal:writePaths"
  | "terminal:resize"
  | "terminal:kill"
  | "terminal:reconnect"
  | "terminal:setSelection"
  | "terminal:getBufferDelta"
  | "terminal:generateCommandDraft"
  | "filesystem:list"
  | "filesystem:readTextFile"
  | "filesystem:readFileBase64"
  | "filesystem:writeTextFile"
  | "filesystem:writeFileBase64"
  | "filesystem:transferEntries"
  | "filesystem:startTransfer"
  | "filesystem:getTransfer"
  | "filesystem:listTransfers"
  | "filesystem:cancelTransfer"
  | "filesystem:cancelTransferTask"
  | "filesystem:createDirectory"
  | "filesystem:createFile"
  | "filesystem:deletePath"
  | "filesystem:renamePath"
  | "system:saveImageAttachment"
  | "models:getProfiles"
  | "models:setActiveProfile"
  | "models:probe"
  | "skills:reload"
  | "skills:getAll"
  | "skills:getEnabled"
  | "skills:create"
  | "skills:delete"
  | "skills:list"
  | "skills:setEnabled"
  | "memory:get"
  | "memory:setContent"
  | "agentSettings:get"
  | "agentSettings:saveCurrent"
  | "agentSettings:apply"
  | "agentSettings:overwrite"
  | "agentSettings:delete"
  | "settings:get"
  | "settings:set"
  | "settings:getCommandPolicyLists"
  | "settings:addCommandPolicyRule"
  | "settings:deleteCommandPolicyRule"
  | "tools:reloadMcp"
  | "tools:getMcp"
  | "tools:setMcpEnabled"
  | "tools:getBuiltIn"
  | "tools:setBuiltInEnabled"
  | "agent:startTask"
  | "agent:startTaskAsync"
  | "agent:stopTask"
  | "agent:replyMessage"
  | "agent:replyCommandApproval"
  | "agent:deleteChatSession"
  | "agent:deleteChatSessions"
  | "agent:renameSession"
  | "agent:branchFromMessage"
  | "agent:rollbackToMessage";

type FileTransferConflictStrategy = "error" | "overwrite" | "rename";

interface WebSocketRpcRequest {
  id?: string | number;
  method: WebSocketRpcMethod | string;
  params?: Record<string, any>;
}

export interface WebSocketAccessTokenAuth {
  verifyToken: (token: string) => Promise<boolean> | boolean;
  allowLocalhostWithoutToken?: boolean;
}

export interface IWebSocketServerLike {
  on(
    event: "connection",
    listener: (socket: IWebSocketConnectionLike, request?: any) => void,
  ): void;
  on(event: "error", listener: (error: unknown) => void): void;
  close(callback?: (error?: Error) => void): void;
}

export type WebSocketServerFactory = (options: {
  host: string;
  port: number;
}) => IWebSocketServerLike;

export interface IWebSocketGatewayAdapterLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface WebSocketIpFilter {
  mode: "lan" | "custom";
  /** Parsed CIDR strings for custom mode */
  allowedCidrs: string[];
}

export interface WebSocketGatewayAdapterOptions {
  host: string;
  port: number;
  accessTokenAuth?: WebSocketAccessTokenAuth;
  ipFilter?: WebSocketIpFilter;
  agentBridge?: {
    exportHistory?: (
      sessionId: string,
      mode: "simple" | "detailed",
    ) => unknown | Promise<unknown>;
    getAllChatHistory?: () => unknown | Promise<unknown>;
    loadChatSession?: (sessionId: string) => unknown | Promise<unknown>;
    getUiMessages?: (sessionId: string) => unknown | Promise<unknown>;
  };
  terminalBridge?: {
    listTerminals: () => Array<{ id: string; title: string; type: string }>;
    createTab?: (
      config: Record<string, any>,
    ) => Promise<{ id: string }> | { id: string };
    write?: (terminalId: string, data: string) => void | Promise<void>;
    writePaths?: (terminalId: string, paths: string[]) => void | Promise<void>;
    resize?: (
      terminalId: string,
      cols: number,
      rows: number,
    ) => void | Promise<void>;
    kill?: (terminalId: string) => void | Promise<void>;
    reconnect?: (terminalId: string) => Promise<{ id: string }> | { id: string };
    setSelection?: (
      terminalId: string,
      selectionText: string,
    ) => void | Promise<void>;
    getBufferDelta?: (
      terminalId: string,
      fromOffset: number,
    ) =>
      | {
          data: string;
          offset: number;
          remoteOs?: "unix" | "windows";
          windowsRelease?: string;
        }
      | Promise<{
          data: string;
          offset: number;
          remoteOs?: "unix" | "windows";
          windowsRelease?: string;
        }>;
    generateCommandDraft?: (
      terminalId: string,
      prompt: string,
      profileId: string,
    ) => { command: string } | Promise<{ command: string }>;
  };
  filesystemBridge?: {
    listDirectory?: (
      terminalId: string,
      dirPath?: string,
    ) =>
      | Promise<{ path: string; entries: Array<Record<string, any>> }>
      | { path: string; entries: Array<Record<string, any>> };
    readTextFile?: (
      terminalId: string,
      filePath: string,
      options?: { maxBytes?: number },
    ) =>
      | Promise<{
          path: string;
          content: string;
          size: number;
          encoding: "utf8";
        }>
      | { path: string; content: string; size: number; encoding: "utf8" };
    readFileBase64?: (
      terminalId: string,
      filePath: string,
      options?: { maxBytes?: number },
    ) =>
      | Promise<{
          path: string;
          contentBase64: string;
          size: number;
          mimeType: string;
        }>
      | { path: string; contentBase64: string; size: number; mimeType: string };
    writeTextFile?: (
      terminalId: string,
      filePath: string,
      content: string,
    ) => Promise<void> | void;
    writeFileBase64?: (
      terminalId: string,
      filePath: string,
      contentBase64: string,
      options?: { maxBytes?: number },
    ) => Promise<void> | void;
    transferEntries?: (
      sourceTerminalId: string,
      sourcePaths: string[],
      targetTerminalId: string,
      targetDirPath: string,
      options?: {
        mode?: "copy" | "move";
        transferId?: string;
        chunkSize?: number;
        overwrite?: boolean;
        conflictStrategy?: FileTransferConflictStrategy;
      },
    ) =>
      | Promise<{
          mode: "copy" | "move";
          totalBytes: number;
          transferredFiles: number;
          totalFiles: number;
        }>
      | {
          mode: "copy" | "move";
          totalBytes: number;
          transferredFiles: number;
          totalFiles: number;
        };
    startTransfer?: (
      input: StartFileTransferInput,
    ) => FileTransferTaskSnapshot | Promise<FileTransferTaskSnapshot>;
    getTransfer?: (
      transferId: string,
    ) =>
      | FileTransferTaskSnapshot
      | null
      | Promise<FileTransferTaskSnapshot | null>;
    listTransfers?: (
      options?: ListFileTransfersOptions,
    ) => FileTransferTaskSnapshot[] | Promise<FileTransferTaskSnapshot[]>;
    cancelTransfer?: (
      transferId: string,
    ) =>
      | FileTransferTaskSnapshot
      | null
      | Promise<FileTransferTaskSnapshot | null>;
    cancelTransferTask?: (
      transferId: string,
    ) =>
      | FileTransferTaskSnapshot
      | null
      | Promise<FileTransferTaskSnapshot | null>;
    createDirectory?: (
      terminalId: string,
      dirPath: string,
    ) => Promise<void> | void;
    createFile?: (terminalId: string, filePath: string) => Promise<void> | void;
    deletePath?: (
      terminalId: string,
      targetPath: string,
      options?: { recursive?: boolean },
    ) => Promise<void> | void;
    renamePath?: (
      terminalId: string,
      sourcePath: string,
      targetPath: string,
    ) => Promise<void> | void;
  };
  profileBridge?: {
    getProfiles: () => {
      activeProfileId: string;
      profiles: Array<{
        id: string;
        name: string;
        globalModelId: string;
        modelName?: string;
      }>;
    };
    setActiveProfile: (profileId: string) =>
      | {
          activeProfileId: string;
          profiles: Array<{
            id: string;
            name: string;
            globalModelId: string;
            modelName?: string;
          }>;
        }
      | Promise<{
          activeProfileId: string;
          profiles: Array<{
            id: string;
            name: string;
            globalModelId: string;
            modelName?: string;
          }>;
        }>;
    probeModel?: (model: unknown) => unknown | Promise<unknown>;
  };
  systemBridge?: {
    saveImageAttachment?: (payload: {
      dataBase64: string;
      fileName?: string;
      mimeType?: string;
      previewDataUrl?: string;
    }) => Promise<unknown> | unknown;
  };
  skillBridge?: {
    reload?: () => unknown | Promise<unknown>;
    getAll?: () => unknown | Promise<unknown>;
    getEnabled?: () => unknown | Promise<unknown>;
    create?: () => unknown | Promise<unknown>;
    delete?: (fileName: string) => unknown | Promise<unknown>;
    listSkills: () =>
      | Array<{ name: string; description?: string; enabled: boolean }>
      | Promise<
          Array<{ name: string; description?: string; enabled: boolean }>
        >;
    setSkillEnabled?: (
      name: string,
      enabled: boolean,
    ) =>
      | Array<{ name: string; description?: string; enabled: boolean }>
      | Promise<
          Array<{ name: string; description?: string; enabled: boolean }>
        >;
  };
  memoryBridge?: {
    get?: () =>
      | { filePath: string; content: string }
      | Promise<{ filePath: string; content: string }>;
    setContent?: (
      content: string,
    ) =>
      | { filePath: string; content: string }
      | Promise<{ filePath: string; content: string }>;
  };
  agentSettingsBridge?: {
    get?: () => unknown | Promise<unknown>;
    saveCurrent?: () => unknown | Promise<unknown>;
    apply?: (
      profileId: string,
      acknowledgedExperimentalToolNames: string[],
    ) => unknown | Promise<unknown>;
    overwrite?: (profileId: string) => unknown | Promise<unknown>;
    delete?: (profileId: string) => unknown | Promise<unknown>;
  };
  settingsBridge?: {
    getSettings?: () => unknown | Promise<unknown>;
    setSettings?: (settings: Record<string, any>) => unknown | Promise<unknown>;
  };
  commandPolicyBridge?: {
    getLists?: () => unknown | Promise<unknown>;
    addRule?: (
      listName: "allowlist" | "denylist" | "asklist",
      rule: string,
    ) => unknown | Promise<unknown>;
    deleteRule?: (
      listName: "allowlist" | "denylist" | "asklist",
      rule: string,
    ) => unknown | Promise<unknown>;
  };
  toolsBridge?: {
    reloadMcp?: () => unknown | Promise<unknown>;
    getMcp?: () => unknown | Promise<unknown>;
    setMcpEnabled?: (
      name: string,
      enabled: boolean,
    ) => unknown | Promise<unknown>;
    getBuiltIn?: () => unknown | Promise<unknown>;
    setBuiltInEnabled?: (
      name: string,
      enabled: boolean,
      acknowledgedExperimentalToolNames: string[],
    ) => unknown | Promise<unknown>;
  };
  serverFactory?: WebSocketServerFactory;
  logger?: IWebSocketGatewayAdapterLogger;
}

class WebSocketRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createDefaultWebSocketServerFactory(): WebSocketServerFactory {
  return ({ host, port }) => {
    return new WebSocketServer({
      host,
      port,
    }) as unknown as IWebSocketServerLike;
  };
}

/**
 * Websocket adapter for Gateway runtime. It is transport-only and does not own business logic.
 */
export class WebSocketGatewayAdapter {
  private server: IWebSocketServerLike | null = null;
  private transportIdBySocket: Map<IWebSocketConnectionLike, string> =
    new Map();
  private isSameMachineBySocket: WeakMap<IWebSocketConnectionLike, boolean> =
    new WeakMap();
  private readonly serverFactory: WebSocketServerFactory;
  private readonly logger: IWebSocketGatewayAdapterLogger;

  constructor(
    private gateway: IGatewayRuntime,
    private options: WebSocketGatewayAdapterOptions,
  ) {
    this.serverFactory =
      options.serverFactory ?? createDefaultWebSocketServerFactory();
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.server) return;
    this.server = this.serverFactory({
      host: this.options.host,
      port: this.options.port,
    });
    this.server.on("error", (error) => {
      this.logger.error("[WebSocketGatewayAdapter] Server error.", error);
    });
    this.server.on("connection", (socket, request) =>
      this.handleConnection(socket, request),
    );
    this.logger.info(
      `[WebSocketGatewayAdapter] Listening on ws://${this.options.host}:${this.options.port}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.transportIdBySocket.clear();
    this.logger.info("[WebSocketGatewayAdapter] Stopped.");
  }

  private handleConnection(
    socket: IWebSocketConnectionLike,
    request?: any,
  ): void {
    const pendingMessages: unknown[] = [];
    const state = {
      authorized: false,
      closed: false,
    };

    socket.on("message", (raw: unknown) => {
      if (!state.authorized) {
        pendingMessages.push(raw);
        return;
      }
      void this.handleIncomingMessage(socket, raw);
    });

    socket.on("close", () => {
      state.closed = true;
      if (!state.authorized) return;
      this.cleanupSocket(socket);
    });

    socket.on("error", (error: unknown) => {
      if (!state.authorized) {
        this.logger.warn(
          "[WebSocketGatewayAdapter] Client socket error before authorization.",
          error,
        );
        return;
      }
      const transportId = this.transportIdBySocket.get(socket) || "unknown";
      this.logger.warn(
        `[WebSocketGatewayAdapter] Client socket error (${transportId}).`,
        error,
      );
    });

    void this.authorizeAndAttach(socket, request, state, pendingMessages);
  }

  private async authorizeAndAttach(
    socket: IWebSocketConnectionLike,
    request: any | undefined,
    state: { authorized: boolean; closed: boolean },
    pendingMessages: unknown[],
  ): Promise<void> {
    const remote = request?.socket?.remoteAddress || "unknown";

    // Check IP filter first (for lan/custom modes)
    const ipFilterError = this.resolveIpFilterError(remote);
    if (ipFilterError) {
      this.logger.warn(
        `[WebSocketGatewayAdapter] Rejected client ${remote}: ${ipFilterError}`,
      );
      this.closeSocketUnauthorized(socket);
      return;
    }

    const authError = await this.resolveConnectionAuthError(request);
    if (authError) {
      this.logger.warn(
        `[WebSocketGatewayAdapter] Rejected client ${remote}: ${authError}`,
      );
      this.closeSocketUnauthorized(socket);
      return;
    }
    if (state.closed) {
      return;
    }

    const transport = new WebSocketClientTransport(socket, this.logger);
    this.transportIdBySocket.set(socket, transport.id);
    this.isSameMachineBySocket.set(
      socket,
      this.isLoopbackAddress(String(remote)),
    );
    this.gateway.registerTransport(transport);
    state.authorized = true;
    this.logger.info(
      `[WebSocketGatewayAdapter] Client connected: ${remote} (${transport.id})`,
    );

    for (const raw of pendingMessages.splice(0)) {
      void this.handleIncomingMessage(socket, raw);
    }
  }

  private async resolveConnectionAuthError(
    request?: any,
  ): Promise<string | null> {
    const auth = this.options.accessTokenAuth;
    if (!auth) return null;

    const allowLocalWithoutToken = auth.allowLocalhostWithoutToken !== false;
    const isLocalConnection = this.isLoopbackAddress(
      String(request?.socket?.remoteAddress || ""),
    );
    if (allowLocalWithoutToken && isLocalConnection) {
      return null;
    }

    const token = this.extractAccessToken(request);
    if (!token) {
      return "missing access token";
    }

    try {
      const valid = await auth.verifyToken(token);
      if (!valid) {
        return "invalid access token";
      }
      return null;
    } catch (error) {
      this.logger.warn(
        "[WebSocketGatewayAdapter] Access token verification failed.",
        error,
      );
      return "token verification failed";
    }
  }

  private extractAccessToken(request?: any): string | null {
    const fromAuthHeader = this.readBearerToken(
      request?.headers?.authorization,
    );
    if (fromAuthHeader) return fromAuthHeader;

    const fromHeader = this.readHeaderToken(
      request?.headers?.["x-access-token"],
    );
    if (fromHeader) return fromHeader;

    const rawUrl = typeof request?.url === "string" ? request.url : "";
    if (!rawUrl) return null;
    try {
      const parsed = new URL(rawUrl, "ws://localhost");
      const fromQuery = parsed.searchParams.get("access_token");
      if (fromQuery && fromQuery.trim()) {
        return fromQuery.trim();
      }
    } catch {
      return null;
    }
    return null;
  }

  private readBearerToken(raw: unknown): string | null {
    const header = this.readHeaderToken(raw);
    if (!header) return null;
    const matched = /^Bearer\s+(.+)$/i.exec(header);
    if (!matched) return null;
    const token = matched[1].trim();
    return token || null;
  }

  private readHeaderToken(raw: unknown): string | null {
    if (typeof raw === "string") {
      const token = raw.trim();
      return token || null;
    }
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry !== "string") continue;
        const token = entry.trim();
        if (token) return token;
      }
    }
    return null;
  }

  private isLoopbackAddress(rawAddress: string): boolean {
    const normalized = rawAddress
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    if (!normalized) return false;

    const withoutZone = normalized.split("%")[0];
    if (withoutZone === "localhost" || withoutZone === "::1") return true;
    if (withoutZone.startsWith("127.")) return true;
    if (withoutZone.startsWith("::ffff:")) {
      return this.isLoopbackAddress(withoutZone.slice("::ffff:".length));
    }
    return false;
  }

  private resolveRemoteIpv4(rawAddress: string): string | null {
    const normalized = rawAddress
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    const withoutZone = normalized.split("%")[0];
    if (withoutZone.startsWith("::ffff:")) {
      return withoutZone.slice("::ffff:".length);
    }
    // Return as-is if it looks like IPv4
    if (/^\d+\.\d+\.\d+\.\d+$/.test(withoutZone)) {
      return withoutZone;
    }
    return null;
  }

  private parseIpv4ToNum(ipStr: string): number | null {
    const parts = ipStr.split(".");
    if (parts.length !== 4) return null;
    let num = 0;
    for (const part of parts) {
      const n = parseInt(part, 10);
      if (isNaN(n) || n < 0 || n > 255) return null;
      num = (num * 256 + n) >>> 0;
    }
    return num;
  }

  private isIpv4InCidr(ipNum: number, cidr: string): boolean {
    const slashIdx = cidr.indexOf("/");
    if (slashIdx < 0) {
      const ip = this.parseIpv4ToNum(cidr.trim());
      return ip !== null && ip === ipNum;
    }
    const networkIp = this.parseIpv4ToNum(cidr.slice(0, slashIdx).trim());
    const prefix = parseInt(cidr.slice(slashIdx + 1), 10);
    if (networkIp === null || isNaN(prefix) || prefix < 0 || prefix > 32)
      return false;
    if (prefix === 0) return true;
    const mask = (~0 << (32 - prefix)) >>> 0;
    return (ipNum & mask) >>> 0 === (networkIp & mask) >>> 0;
  }

  private isPrivateLanAddress(ipStr: string): boolean {
    const ipNum = this.parseIpv4ToNum(ipStr);
    if (ipNum === null) return false;
    const LAN_CIDRS = [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
    ];
    return LAN_CIDRS.some((cidr) => this.isIpv4InCidr(ipNum, cidr));
  }

  private resolveIpFilterError(rawAddress: string): string | null {
    const filter = this.options.ipFilter;
    if (!filter) return null;
    if (this.isLoopbackAddress(rawAddress)) {
      return null;
    }

    const ipv4 = this.resolveRemoteIpv4(rawAddress);
    if (!ipv4) {
      // Non-IPv4 addresses (pure IPv6) are blocked in lan/custom modes
      return "connection not allowed by IP filter";
    }

    if (filter.mode === "lan") {
      if (!this.isPrivateLanAddress(ipv4)) {
        return "not a LAN address";
      }
      return null;
    }

    if (filter.mode === "custom") {
      const allowed = filter.allowedCidrs.some((cidr) => {
        const ipNum = this.parseIpv4ToNum(ipv4);
        return ipNum !== null && this.isIpv4InCidr(ipNum, cidr.trim());
      });
      if (!allowed) {
        return "IP not in allowed ranges";
      }
      return null;
    }

    return null;
  }

  private closeSocketUnauthorized(socket: IWebSocketConnectionLike): void {
    try {
      if (typeof socket.close === "function") {
        socket.close(1008, "Unauthorized");
        return;
      }
    } catch {
      // noop
    }

    try {
      if (typeof socket.terminate === "function") {
        socket.terminate();
      }
    } catch {
      // noop
    }
  }

  private cleanupSocket(socket: IWebSocketConnectionLike): void {
    const transportId = this.transportIdBySocket.get(socket);
    if (!transportId) return;
    this.isSameMachineBySocket.delete(socket);
    this.transportIdBySocket.delete(socket);
    this.gateway.unregisterTransport(transportId);
    this.logger.info(
      `[WebSocketGatewayAdapter] Client disconnected: ${transportId}`,
    );
  }

  private async handleIncomingMessage(
    socket: IWebSocketConnectionLike,
    raw: unknown,
  ): Promise<void> {
    let requestId: string | undefined;
    try {
      const parsed = this.parseRequest(raw);
      requestId = parsed.id !== undefined ? String(parsed.id) : undefined;
      const result = await this.executeRequest(parsed, socket);
      if (requestId) {
        this.sendRpcSuccess(socket, requestId, result);
      }
    } catch (error) {
      const rpcError = this.normalizeRpcError(error);
      if (requestId) {
        this.sendRpcFailure(socket, requestId, rpcError.code, rpcError.message);
        return;
      }
      this.logger.warn(
        `[WebSocketGatewayAdapter] Dropped invalid notification (${rpcError.code}): ${rpcError.message}`,
      );
    }
  }

  private parseRequest(raw: unknown): WebSocketRpcRequest {
    const text = this.coerceRawMessage(raw);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WebSocketRpcError(
        "BAD_JSON",
        "Incoming websocket message is not valid JSON.",
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        "Websocket request payload must be an object.",
      );
    }
    const request = payload as WebSocketRpcRequest;
    if (typeof request.method !== "string" || request.method.length === 0) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        "Websocket request method must be a non-empty string.",
      );
    }
    return request;
  }

  private coerceRawMessage(raw: unknown): string {
    if (typeof raw === "string") return raw;
    if (Buffer.isBuffer(raw)) return raw.toString("utf8");
    if (Array.isArray(raw)) {
      return Buffer.concat(
        raw.map((chunk) =>
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        ),
      ).toString("utf8");
    }
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
    throw new WebSocketRpcError(
      "BAD_REQUEST",
      "Unsupported websocket payload type.",
    );
  }

  private async executeRequest(
    request: WebSocketRpcRequest,
    socket: IWebSocketConnectionLike,
  ): Promise<any> {
    const params = request.params ?? {};
    switch (request.method) {
      case "gateway:ping":
        return { pong: true, ts: Date.now() };
      case "gateway:isSameMachine":
        return { sameMachine: this.isSameMachineBySocket.get(socket) === true };
      case "gateway:createSession": {
        const sessionId = await this.gateway.createSession();
        return { sessionId };
      }
      case "session:list": {
        const sessions = this.gateway.listSessionSummaries();
        return {
          sessions,
          uiRevision: sessions[0]?.uiRevision ?? this.gateway.getUiRevision(),
        };
      }
      case "session:get": {
        const sessionId = this.readStringParam(params, "sessionId");
        const session = this.gateway.getSessionSnapshot(sessionId);
        if (!session) {
          throw new WebSocketRpcError(
            "NOT_FOUND",
            `Session not found: ${sessionId}`,
          );
        }
        return { session };
      }
      case "agent:exportHistory": {
        const bridge = this.options.agentBridge;
        if (!bridge?.exportHistory) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agent:exportHistory is not available on this websocket gateway.",
          );
        }
        const sessionId = this.readStringParam(params, "sessionId");
        const mode = params.mode;
        const normalizedMode =
          mode === "simple" || mode === "detailed" ? mode : "detailed";
        return await bridge.exportHistory(sessionId, normalizedMode);
      }
      case "agent:getAllChatHistory": {
        const bridge = this.options.agentBridge;
        if (!bridge?.getAllChatHistory) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agent:getAllChatHistory is not available on this websocket gateway.",
          );
        }
        return await bridge.getAllChatHistory();
      }
      case "agent:loadChatSession": {
        const bridge = this.options.agentBridge;
        if (!bridge?.loadChatSession) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agent:loadChatSession is not available on this websocket gateway.",
          );
        }
        const id = this.readStringParam(params, "id");
        return await bridge.loadChatSession(id);
      }
      case "agent:getUiMessages": {
        const bridge = this.options.agentBridge;
        if (!bridge?.getUiMessages) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agent:getUiMessages is not available on this websocket gateway.",
          );
        }
        const id = this.readStringParam(params, "id");
        return await bridge.getUiMessages(id);
      }
      case "terminal:list": {
        if (!this.options.terminalBridge) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Terminal listing is not available on this websocket gateway.",
          );
        }
        return { terminals: this.options.terminalBridge.listTerminals() };
      }
      case "terminal:createTab": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.createTab) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Terminal creation is not available on this websocket gateway.",
          );
        }
        const config = this.readObjectParam(params, "config");
        const created = await bridge.createTab(config);
        return { id: created.id };
      }
      case "terminal:write": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.write) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Terminal write is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const data = this.readStringParam(params, "data");
        await bridge.write(terminalId, data);
        return { ok: true };
      }
      case "terminal:writePaths": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.writePaths) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "terminal:writePaths is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const paths = params.paths;
        if (
          !Array.isArray(paths) ||
          paths.some((item) => typeof item !== "string")
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "paths must be string array.",
          );
        }
        await bridge.writePaths(terminalId, paths);
        return { ok: true };
      }
      case "terminal:resize": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.resize) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Terminal resize is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const cols = this.readIntegerParam(params, "cols", 1, 1000);
        const rows = this.readIntegerParam(params, "rows", 1, 1000);
        await bridge.resize(terminalId, cols, rows);
        return { ok: true };
      }
      case "terminal:kill": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.kill) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Terminal close is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        await bridge.kill(terminalId);
        return { ok: true };
      }
      case "terminal:reconnect": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.reconnect) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "terminal:reconnect is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        return await bridge.reconnect(terminalId);
      }
      case "terminal:setSelection": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.setSelection) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "terminal:setSelection is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const selectionText = params.selectionText;
        if (typeof selectionText !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "selectionText must be string.",
          );
        }
        await bridge.setSelection(terminalId, selectionText);
        return { ok: true };
      }
      case "terminal:getBufferDelta": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.getBufferDelta) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "terminal:getBufferDelta is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const fromOffset = this.readIntegerParam(
          params,
          "fromOffset",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        return await bridge.getBufferDelta(terminalId, fromOffset);
      }
      case "terminal:generateCommandDraft": {
        const bridge = this.options.terminalBridge;
        if (!bridge?.generateCommandDraft) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "terminal:generateCommandDraft is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const prompt = this.readStringParam(params, "prompt");
        const profileId = this.readStringParam(params, "profileId");
        return await bridge.generateCommandDraft(terminalId, prompt, profileId);
      }
      case "filesystem:list": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.listDirectory) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:list is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const rawDirPath = params.dirPath;
        if (
          rawDirPath !== undefined &&
          rawDirPath !== null &&
          typeof rawDirPath !== "string"
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "dirPath must be string when provided.",
          );
        }
        return await bridge.listDirectory(
          terminalId,
          typeof rawDirPath === "string" ? rawDirPath : undefined,
        );
      }
      case "filesystem:readTextFile": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.readTextFile) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:readTextFile is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const filePath = this.readStringParam(params, "filePath");
        const maxBytes = this.readOptionalPositiveIntegerParam(
          params,
          "maxBytes",
        );
        return await bridge.readTextFile(
          terminalId,
          filePath,
          maxBytes ? { maxBytes } : undefined,
        );
      }
      case "filesystem:readFileBase64": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.readFileBase64) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:readFileBase64 is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const filePath = this.readStringParam(params, "filePath");
        const maxBytes = this.readOptionalPositiveIntegerParam(
          params,
          "maxBytes",
        );
        return await bridge.readFileBase64(
          terminalId,
          filePath,
          maxBytes ? { maxBytes } : undefined,
        );
      }
      case "filesystem:writeTextFile": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.writeTextFile) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:writeTextFile is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const filePath = this.readStringParam(params, "filePath");
        const content = this.readStringParam(params, "content");
        await bridge.writeTextFile(terminalId, filePath, content);
        return { ok: true };
      }
      case "filesystem:writeFileBase64": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.writeFileBase64) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:writeFileBase64 is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const filePath = this.readStringParam(params, "filePath");
        const contentBase64 = this.readStringParam(params, "contentBase64");
        const maxBytes = this.readOptionalPositiveIntegerParam(
          params,
          "maxBytes",
        );
        await bridge.writeFileBase64(
          terminalId,
          filePath,
          contentBase64,
          maxBytes ? { maxBytes } : undefined,
        );
        return { ok: true };
      }
      case "filesystem:transferEntries": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.transferEntries) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:transferEntries is not available on this websocket gateway.",
          );
        }
        const sourceTerminalId = this.readStringParam(
          params,
          "sourceTerminalId",
        );
        const targetTerminalId = this.readStringParam(
          params,
          "targetTerminalId",
        );
        const targetDirPath = this.readStringParam(params, "targetDirPath");
        const rawSourcePaths = params.sourcePaths;
        if (
          !Array.isArray(rawSourcePaths) ||
          rawSourcePaths.some((item) => typeof item !== "string")
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "sourcePaths must be string[].",
          );
        }
        const mode = params.mode;
        if (mode !== undefined && mode !== "copy" && mode !== "move") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            'mode must be "copy" or "move" when provided.',
          );
        }
        const transferId = params.transferId;
        if (transferId !== undefined && typeof transferId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "transferId must be string when provided.",
          );
        }
        const overwrite = params.overwrite;
        if (overwrite !== undefined && typeof overwrite !== "boolean") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "overwrite must be boolean when provided.",
          );
        }
        const conflictStrategy = params.conflictStrategy;
        if (
          conflictStrategy !== undefined &&
          conflictStrategy !== "error" &&
          conflictStrategy !== "overwrite" &&
          conflictStrategy !== "rename"
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            'conflictStrategy must be "error", "overwrite", or "rename" when provided.',
          );
        }
        const chunkSize = this.readOptionalPositiveIntegerParam(
          params,
          "chunkSize",
        );
        return await bridge.transferEntries(
          sourceTerminalId,
          rawSourcePaths,
          targetTerminalId,
          targetDirPath,
          {
            ...(mode !== undefined ? { mode } : {}),
            ...(transferId !== undefined ? { transferId } : {}),
            ...(overwrite !== undefined ? { overwrite } : {}),
            ...(conflictStrategy !== undefined ? { conflictStrategy } : {}),
            ...(chunkSize !== undefined ? { chunkSize } : {}),
          },
        );
      }
      case "filesystem:startTransfer": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.startTransfer) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:startTransfer is not available on this websocket gateway.",
          );
        }
        const sourceTerminalId = this.readStringParam(
          params,
          "sourceTerminalId",
        );
        const targetTerminalId = this.readStringParam(
          params,
          "targetTerminalId",
        );
        const targetDirPath = this.readStringParam(params, "targetDirPath");
        const rawSourcePaths = params.sourcePaths;
        if (
          !Array.isArray(rawSourcePaths) ||
          rawSourcePaths.some((item) => typeof item !== "string")
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "sourcePaths must be string[].",
          );
        }
        const origin = params.origin === undefined ? "user" : params.origin;
        if (origin !== "user" && origin !== "agent") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            'origin must be "user" or "agent" when provided.',
          );
        }
        const mode = params.mode;
        if (mode !== undefined && mode !== "copy" && mode !== "move") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            'mode must be "copy" or "move" when provided.',
          );
        }
        const transferId = params.transferId;
        if (transferId !== undefined && typeof transferId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "transferId must be string when provided.",
          );
        }
        const overwrite = params.overwrite;
        if (overwrite !== undefined && typeof overwrite !== "boolean") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "overwrite must be boolean when provided.",
          );
        }
        const requireDistinctMachine = params.requireDistinctMachine;
        if (
          requireDistinctMachine !== undefined &&
          typeof requireDistinctMachine !== "boolean"
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "requireDistinctMachine must be boolean when provided.",
          );
        }
        const conflictStrategy = params.conflictStrategy;
        if (
          conflictStrategy !== undefined &&
          conflictStrategy !== "error" &&
          conflictStrategy !== "overwrite" &&
          conflictStrategy !== "rename"
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            'conflictStrategy must be "error", "overwrite", or "rename" when provided.',
          );
        }
        const chunkSize = this.readOptionalPositiveIntegerParam(
          params,
          "chunkSize",
        );
        const sessionId =
          params.sessionId === undefined ? undefined : params.sessionId;
        if (sessionId !== undefined && typeof sessionId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "sessionId must be string when provided.",
          );
        }
        const agentRunId =
          params.agentRunId === undefined ? undefined : params.agentRunId;
        if (agentRunId !== undefined && typeof agentRunId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "agentRunId must be string when provided.",
          );
        }
        const toolMessageId =
          params.toolMessageId === undefined ? undefined : params.toolMessageId;
        if (toolMessageId !== undefined && typeof toolMessageId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "toolMessageId must be string when provided.",
          );
        }
        return await bridge.startTransfer({
          origin,
          sourceTerminalId,
          sourcePaths: rawSourcePaths,
          targetTerminalId,
          targetDirPath,
          ...(mode !== undefined ? { mode } : {}),
          ...(transferId !== undefined ? { transferId } : {}),
          ...(overwrite !== undefined ? { overwrite } : {}),
          ...(requireDistinctMachine !== undefined
            ? { requireDistinctMachine }
            : {}),
          ...(conflictStrategy !== undefined ? { conflictStrategy } : {}),
          ...(chunkSize !== undefined ? { chunkSize } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(agentRunId !== undefined ? { agentRunId } : {}),
          ...(toolMessageId !== undefined ? { toolMessageId } : {}),
        });
      }
      case "filesystem:getTransfer": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.getTransfer) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:getTransfer is not available on this websocket gateway.",
          );
        }
        const transferId = this.readStringParam(params, "transferId");
        return await bridge.getTransfer(transferId);
      }
      case "filesystem:listTransfers": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.listTransfers) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:listTransfers is not available on this websocket gateway.",
          );
        }
        const includeCompleted = params.includeCompleted;
        if (
          includeCompleted !== undefined &&
          typeof includeCompleted !== "boolean"
        ) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "includeCompleted must be boolean when provided.",
          );
        }
        const origin = params.origin;
        if (origin !== undefined && origin !== "user" && origin !== "agent") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            'origin must be "user" or "agent" when provided.',
          );
        }
        const terminalId = params.terminalId;
        if (terminalId !== undefined && typeof terminalId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "terminalId must be string when provided.",
          );
        }
        const sessionId = params.sessionId;
        if (sessionId !== undefined && typeof sessionId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "sessionId must be string when provided.",
          );
        }
        const agentRunId = params.agentRunId;
        if (agentRunId !== undefined && typeof agentRunId !== "string") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "agentRunId must be string when provided.",
          );
        }
        return await bridge.listTransfers({
          ...(includeCompleted !== undefined ? { includeCompleted } : {}),
          ...(origin !== undefined ? { origin } : {}),
          ...(terminalId !== undefined ? { terminalId } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(agentRunId !== undefined ? { agentRunId } : {}),
        });
      }
      case "filesystem:cancelTransfer":
      case "filesystem:cancelTransferTask": {
        const bridge = this.options.filesystemBridge;
        const cancelTransferTask =
          bridge?.cancelTransferTask || bridge?.cancelTransfer;
        if (!cancelTransferTask) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            `${request.method} is not available on this websocket gateway.`,
          );
        }
        const transferId = this.readStringParam(params, "transferId");
        return await cancelTransferTask(transferId);
      }
      case "filesystem:createDirectory": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.createDirectory) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:createDirectory is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const dirPath = this.readStringParam(params, "dirPath");
        await bridge.createDirectory(terminalId, dirPath);
        return { ok: true };
      }
      case "filesystem:createFile": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.createFile) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:createFile is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const filePath = this.readStringParam(params, "filePath");
        await bridge.createFile(terminalId, filePath);
        return { ok: true };
      }
      case "filesystem:deletePath": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.deletePath) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:deletePath is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const targetPath = this.readStringParam(params, "targetPath");
        const rawRecursive = params.recursive;
        if (rawRecursive !== undefined && typeof rawRecursive !== "boolean") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "recursive must be boolean when provided.",
          );
        }
        await bridge.deletePath(
          terminalId,
          targetPath,
          rawRecursive === undefined ? undefined : { recursive: rawRecursive },
        );
        return { ok: true };
      }
      case "filesystem:renamePath": {
        const bridge = this.options.filesystemBridge;
        if (!bridge?.renamePath) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "filesystem:renamePath is not available on this websocket gateway.",
          );
        }
        const terminalId = this.readStringParam(params, "terminalId");
        const sourcePath = this.readStringParam(params, "sourcePath");
        const targetPath = this.readStringParam(params, "targetPath");
        await bridge.renamePath(terminalId, sourcePath, targetPath);
        return { ok: true };
      }
      case "system:saveImageAttachment": {
        const bridge = this.options.systemBridge;
        if (!bridge?.saveImageAttachment) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "system:saveImageAttachment is not available on this websocket gateway.",
          );
        }
        const payload = this.readSaveImageAttachmentPayload(params.payload);
        return await bridge.saveImageAttachment(payload);
      }
      case "models:getProfiles": {
        if (!this.options.profileBridge) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Model profile APIs are not available on this websocket gateway.",
          );
        }
        return this.options.profileBridge.getProfiles();
      }
      case "models:setActiveProfile": {
        if (!this.options.profileBridge) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Model profile APIs are not available on this websocket gateway.",
          );
        }
        const profileId = this.readStringParam(params, "profileId");
        try {
          return await this.options.profileBridge.setActiveProfile(profileId);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to set active profile.";
          throw new WebSocketRpcError("BAD_REQUEST", message);
        }
      }
      case "models:probe": {
        if (!this.options.profileBridge?.probeModel) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "models:probe is not available on this websocket gateway.",
          );
        }
        return await this.options.profileBridge.probeModel(params.model);
      }
      case "skills:reload": {
        if (!this.options.skillBridge?.reload) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "skills:reload is not available on this websocket gateway.",
          );
        }
        return await this.options.skillBridge.reload();
      }
      case "skills:getAll": {
        if (!this.options.skillBridge?.getAll) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "skills:getAll is not available on this websocket gateway.",
          );
        }
        return await this.options.skillBridge.getAll();
      }
      case "skills:getEnabled": {
        if (!this.options.skillBridge?.getEnabled) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "skills:getEnabled is not available on this websocket gateway.",
          );
        }
        return await this.options.skillBridge.getEnabled();
      }
      case "skills:create": {
        if (!this.options.skillBridge?.create) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "skills:create is not available on this websocket gateway.",
          );
        }
        return await this.options.skillBridge.create();
      }
      case "skills:delete": {
        if (!this.options.skillBridge?.delete) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "skills:delete is not available on this websocket gateway.",
          );
        }
        const fileName = this.readStringParam(params, "fileName");
        return await this.options.skillBridge.delete(fileName);
      }
      case "skills:list": {
        if (!this.options.skillBridge) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Skill APIs are not available on this websocket gateway.",
          );
        }
        const skills = await this.options.skillBridge.listSkills();
        return { skills };
      }
      case "skills:setEnabled": {
        if (!this.options.skillBridge?.setSkillEnabled) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "Skill mutation APIs are not available on this websocket gateway.",
          );
        }
        const name = this.readStringParam(params, "name");
        const enabled = params.enabled;
        if (typeof enabled !== "boolean") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "enabled must be boolean.",
          );
        }
        const skills = await this.options.skillBridge.setSkillEnabled(
          name,
          enabled,
        );
        return { skills };
      }
      case "memory:get": {
        if (!this.options.memoryBridge?.get) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "memory:get is not available on this websocket gateway.",
          );
        }
        return await this.options.memoryBridge.get();
      }
      case "memory:setContent": {
        if (!this.options.memoryBridge?.setContent) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "memory:setContent is not available on this websocket gateway.",
          );
        }
        const content = params.content;
        if (typeof content !== "string") {
          throw new WebSocketRpcError("BAD_REQUEST", "content must be string.");
        }
        return await this.options.memoryBridge.setContent(content);
      }
      case "agentSettings:get": {
        if (!this.options.agentSettingsBridge?.get) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agentSettings:get is not available on this websocket gateway.",
          );
        }
        return await this.options.agentSettingsBridge.get();
      }
      case "agentSettings:saveCurrent": {
        if (!this.options.agentSettingsBridge?.saveCurrent) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agentSettings:saveCurrent is not available on this websocket gateway.",
          );
        }
        return await this.options.agentSettingsBridge.saveCurrent();
      }
      case "agentSettings:apply": {
        if (!this.options.agentSettingsBridge?.apply) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agentSettings:apply is not available on this websocket gateway.",
          );
        }
        const profileId = this.readStringParam(params, "profileId");
        const acknowledgedExperimentalToolNames = Array.isArray(
          params.acknowledgedExperimentalToolNames,
        )
          ? params.acknowledgedExperimentalToolNames.filter(
              (name): name is string => typeof name === "string",
            )
          : [];
        return await this.options.agentSettingsBridge.apply(
          profileId,
          acknowledgedExperimentalToolNames,
        );
      }
      case "agentSettings:overwrite": {
        if (!this.options.agentSettingsBridge?.overwrite) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agentSettings:overwrite is not available on this websocket gateway.",
          );
        }
        const profileId = this.readStringParam(params, "profileId");
        return await this.options.agentSettingsBridge.overwrite(profileId);
      }
      case "agentSettings:delete": {
        if (!this.options.agentSettingsBridge?.delete) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "agentSettings:delete is not available on this websocket gateway.",
          );
        }
        const profileId = this.readStringParam(params, "profileId");
        return await this.options.agentSettingsBridge.delete(profileId);
      }
      case "settings:get": {
        if (!this.options.settingsBridge?.getSettings) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "settings:get is not available on this websocket gateway.",
          );
        }
        return await this.options.settingsBridge.getSettings();
      }
      case "settings:set": {
        if (!this.options.settingsBridge?.setSettings) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "settings:set is not available on this websocket gateway.",
          );
        }
        const settings = this.readObjectParam(params, "settings");
        return await this.options.settingsBridge.setSettings(settings);
      }
      case "settings:getCommandPolicyLists": {
        if (!this.options.commandPolicyBridge?.getLists) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "settings:getCommandPolicyLists is not available on this websocket gateway.",
          );
        }
        return await this.options.commandPolicyBridge.getLists();
      }
      case "settings:addCommandPolicyRule": {
        if (!this.options.commandPolicyBridge?.addRule) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "settings:addCommandPolicyRule is not available on this websocket gateway.",
          );
        }
        const listName = this.readPolicyListNameParam(params, "listName");
        const rule = this.readStringParam(params, "rule");
        return await this.options.commandPolicyBridge.addRule(listName, rule);
      }
      case "settings:deleteCommandPolicyRule": {
        if (!this.options.commandPolicyBridge?.deleteRule) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "settings:deleteCommandPolicyRule is not available on this websocket gateway.",
          );
        }
        const listName = this.readPolicyListNameParam(params, "listName");
        const rule = this.readStringParam(params, "rule");
        return await this.options.commandPolicyBridge.deleteRule(
          listName,
          rule,
        );
      }
      case "tools:reloadMcp": {
        if (!this.options.toolsBridge?.reloadMcp) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "tools:reloadMcp is not available on this websocket gateway.",
          );
        }
        return await this.options.toolsBridge.reloadMcp();
      }
      case "tools:getMcp": {
        if (!this.options.toolsBridge?.getMcp) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "tools:getMcp is not available on this websocket gateway.",
          );
        }
        return await this.options.toolsBridge.getMcp();
      }
      case "tools:setMcpEnabled": {
        if (!this.options.toolsBridge?.setMcpEnabled) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "tools:setMcpEnabled is not available on this websocket gateway.",
          );
        }
        const name = this.readStringParam(params, "name");
        const enabled = params.enabled;
        if (typeof enabled !== "boolean") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "enabled must be boolean.",
          );
        }
        return await this.options.toolsBridge.setMcpEnabled(name, enabled);
      }
      case "tools:getBuiltIn": {
        if (!this.options.toolsBridge?.getBuiltIn) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "tools:getBuiltIn is not available on this websocket gateway.",
          );
        }
        return await this.options.toolsBridge.getBuiltIn();
      }
      case "tools:setBuiltInEnabled": {
        if (!this.options.toolsBridge?.setBuiltInEnabled) {
          throw new WebSocketRpcError(
            "METHOD_NOT_FOUND",
            "tools:setBuiltInEnabled is not available on this websocket gateway.",
          );
        }
        const name = this.readStringParam(params, "name");
        const enabled = params.enabled;
        if (typeof enabled !== "boolean") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "enabled must be boolean.",
          );
        }
        const acknowledgedExperimentalToolNames = Array.isArray(
          params.acknowledgedExperimentalToolNames,
        )
          ? params.acknowledgedExperimentalToolNames.filter(
              (toolName): toolName is string => typeof toolName === "string",
            )
          : [];
        return await this.options.toolsBridge.setBuiltInEnabled(
          name,
          enabled,
          acknowledgedExperimentalToolNames,
        );
      }
      case "agent:startTask": {
        const sessionId = this.readStringParam(params, "sessionId");
        const userInput = this.readStartTaskInput(params);
        const options = this.readStartTaskOptions(params.options);
        await this.gateway.dispatchTask(sessionId, userInput, options);
        return { ok: true };
      }
      case "agent:startTaskAsync": {
        const sessionId = this.readStringParam(params, "sessionId");
        const userInput = this.readStartTaskInput(params);
        const options = this.readStartTaskOptions(params.options);
        void this.gateway
          .dispatchTask(sessionId, userInput, options)
          .catch((error) => {
            this.logger.error(
              `[WebSocketGatewayAdapter] Async task failed (session=${sessionId}).`,
              error,
            );
          });
        return { ok: true };
      }
      case "agent:stopTask": {
        const sessionId = this.readStringParam(params, "sessionId");
        await this.gateway.stopTask(sessionId);
        return { ok: true };
      }
      case "agent:replyMessage": {
        const messageId = this.readStringParam(params, "messageId");
        const payload = params.payload;
        return this.gateway.submitFeedback(messageId, payload);
      }
      case "agent:replyCommandApproval": {
        const approvalId = this.readStringParam(params, "approvalId");
        const decision = this.readStringParam(params, "decision");
        if (decision !== "allow" && decision !== "deny") {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            'decision must be "allow" or "deny".',
          );
        }
        return this.gateway.submitFeedback(approvalId, { decision });
      }
      case "agent:deleteChatSession": {
        const sessionId = this.readStringParam(params, "sessionId");
        await this.gateway.deleteChatSession(sessionId);
        return { ok: true };
      }
      case "agent:deleteChatSessions": {
        const sessionIds = Array.isArray(params.sessionIds)
          ? params.sessionIds.filter(
              (value) => typeof value === "string" && value.length > 0,
            )
          : [];
        if (sessionIds.length === 0) {
          throw new WebSocketRpcError(
            "BAD_REQUEST",
            "sessionIds must be a non-empty string array.",
          );
        }
        await this.gateway.deleteChatSessions(sessionIds);
        return { ok: true };
      }
      case "agent:renameSession": {
        const sessionId = this.readStringParam(params, "sessionId");
        const newTitle = this.readStringParam(params, "newTitle");
        this.gateway.renameSession(sessionId, newTitle);
        return { ok: true };
      }
      case "agent:branchFromMessage": {
        const sessionId = this.readStringParam(params, "sessionId");
        const messageId = this.readStringParam(params, "messageId");
        return await this.gateway.branchSessionFromMessage(
          sessionId,
          messageId,
        );
      }
      case "agent:rollbackToMessage": {
        const sessionId = this.readStringParam(params, "sessionId");
        const messageId = this.readStringParam(params, "messageId");
        return await this.gateway.rollbackSessionToMessage(
          sessionId,
          messageId,
        );
      }
      default:
        throw new WebSocketRpcError(
          "UNKNOWN_METHOD",
          `Unsupported websocket method: ${request.method}`,
        );
    }
  }

  private readStringParam(params: Record<string, any>, name: string): string {
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        `Missing or invalid parameter: ${name}`,
      );
    }
    return value;
  }

  private readIntegerParam(
    params: Record<string, any>,
    name: string,
    min: number,
    max: number,
  ): number {
    const value = params[name];
    if (!Number.isInteger(value)) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        `Missing or invalid parameter: ${name}`,
      );
    }
    if (value < min || value > max) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        `Parameter out of range: ${name}`,
      );
    }
    return value;
  }

  private readOptionalPositiveIntegerParam(
    params: Record<string, any>,
    name: string,
  ): number | undefined {
    const value = params[name];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        `${name} must be a positive integer when provided.`,
      );
    }
    return value;
  }

  private readObjectParam(
    params: Record<string, any>,
    name: string,
  ): Record<string, any> {
    const value = params[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        `Missing or invalid parameter: ${name}`,
      );
    }
    return value as Record<string, any>;
  }

  private readPolicyListNameParam(
    params: Record<string, any>,
    name: string,
  ): "allowlist" | "denylist" | "asklist" {
    const value = params[name];
    if (value !== "allowlist" && value !== "denylist" && value !== "asklist") {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        `${name} must be one of allowlist|denylist|asklist.`,
      );
    }
    return value;
  }

  private readStartTaskOptions(raw: unknown): StartTaskOptions | undefined {
    if (!raw) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new WebSocketRpcError("BAD_REQUEST", "Invalid start task options.");
    }
    const options = raw as StartTaskOptions;
    if (
      options.startMode &&
      options.startMode !== "normal" &&
      options.startMode !== "inserted"
    ) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        'options.startMode must be "normal" or "inserted".',
      );
    }
    return options;
  }

  private readStartTaskInput(params: Record<string, any>): StartTaskInput {
    const userInput = params.userInput;
    if (typeof userInput === "string") {
      return userInput;
    }
    if (
      userInput &&
      typeof userInput === "object" &&
      !Array.isArray(userInput)
    ) {
      const payload = userInput as { text?: unknown; images?: unknown };
      const text = typeof payload.text === "string" ? payload.text : "";
      const images = this.readInputImages(payload.images);
      return {
        text,
        ...(images.length > 0 ? { images } : {}),
      };
    }

    const legacyUserText = params.userText;
    if (typeof legacyUserText === "string") {
      return legacyUserText;
    }
    throw new WebSocketRpcError("BAD_REQUEST", "Missing user input payload.");
  }

  private readInputImages(raw: unknown): Array<{
    attachmentId: string;
    fileName?: string;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
    previewDataUrl?: string;
    status?: "ready" | "missing";
  }> {
    if (!raw) return [];
    if (!Array.isArray(raw)) {
      throw new WebSocketRpcError("BAD_REQUEST", "images must be an array.");
    }
    return raw.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new WebSocketRpcError(
          "BAD_REQUEST",
          `images[${index}] must be an object.`,
        );
      }
      const entry = item as Record<string, unknown>;
      const attachmentId =
        typeof entry.attachmentId === "string" ? entry.attachmentId.trim() : "";
      if (!attachmentId) {
        throw new WebSocketRpcError(
          "BAD_REQUEST",
          `images[${index}] requires attachmentId.`,
        );
      }
      const fileName =
        typeof entry.fileName === "string" && entry.fileName.trim()
          ? entry.fileName.trim()
          : undefined;
      const mimeType =
        typeof entry.mimeType === "string" && entry.mimeType.trim()
          ? entry.mimeType.trim()
          : undefined;
      const sizeBytes = Number.isFinite(entry.sizeBytes as number)
        ? Number(entry.sizeBytes)
        : undefined;
      const sha256 =
        typeof entry.sha256 === "string" && entry.sha256.trim()
          ? entry.sha256.trim()
          : undefined;
      const previewDataUrl =
        typeof entry.previewDataUrl === "string" && entry.previewDataUrl.trim()
          ? entry.previewDataUrl.trim()
          : undefined;
      const status =
        entry.status === "ready" || entry.status === "missing"
          ? entry.status
          : undefined;
      return {
        attachmentId,
        ...(fileName ? { fileName } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof sizeBytes === "number" && sizeBytes >= 0
          ? { sizeBytes }
          : {}),
        ...(sha256 ? { sha256 } : {}),
        ...(previewDataUrl ? { previewDataUrl } : {}),
        ...(status ? { status } : {}),
      };
    });
  }

  private readSaveImageAttachmentPayload(raw: unknown): {
    dataBase64: string;
    fileName?: string;
    mimeType?: string;
    previewDataUrl?: string;
  } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new WebSocketRpcError("BAD_REQUEST", "payload must be an object.");
    }
    const payload = raw as Record<string, unknown>;
    const dataBase64 =
      typeof payload.dataBase64 === "string" ? payload.dataBase64.trim() : "";
    if (!dataBase64) {
      throw new WebSocketRpcError(
        "BAD_REQUEST",
        "payload.dataBase64 is required.",
      );
    }
    const fileName =
      typeof payload.fileName === "string" && payload.fileName.trim()
        ? payload.fileName.trim()
        : undefined;
    const mimeType =
      typeof payload.mimeType === "string" && payload.mimeType.trim()
        ? payload.mimeType.trim()
        : undefined;
    const previewDataUrl =
      typeof payload.previewDataUrl === "string" &&
      payload.previewDataUrl.trim()
        ? payload.previewDataUrl.trim()
        : undefined;
    return {
      dataBase64,
      ...(fileName ? { fileName } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(previewDataUrl ? { previewDataUrl } : {}),
    };
  }

  private normalizeRpcError(error: unknown): WebSocketRpcError {
    if (error instanceof WebSocketRpcError) return error;
    if (error instanceof Error)
      return new WebSocketRpcError("INTERNAL_ERROR", error.message);
    return new WebSocketRpcError(
      "INTERNAL_ERROR",
      "Unexpected websocket adapter error.",
    );
  }

  private sendRpcSuccess(
    socket: IWebSocketConnectionLike,
    id: string,
    result: unknown,
  ): void {
    this.safeSocketSend(socket, {
      type: "gateway:response",
      id,
      ok: true,
      result,
    });
  }

  private sendRpcFailure(
    socket: IWebSocketConnectionLike,
    id: string,
    code: string,
    message: string,
  ): void {
    this.safeSocketSend(socket, {
      type: "gateway:response",
      id,
      ok: false,
      error: { code, message },
    });
  }

  private safeSocketSend(
    socket: IWebSocketConnectionLike,
    payload: Record<string, any>,
  ): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn(
        "[WebSocketGatewayAdapter] Failed to send RPC response.",
        error,
      );
    }
  }
}
