import type { IGatewayRuntime, StartTaskOptions } from './types';
import { WebSocketClientTransport, type IWebSocketConnectionLike } from './WebSocketClientTransport';

type WebSocketRpcMethod =
  | 'gateway:ping'
  | 'gateway:createSession'
  | 'terminal:list'
  | 'models:getProfiles'
  | 'models:setActiveProfile'
  | 'agent:startTask'
  | 'agent:stopTask'
  | 'agent:replyMessage'
  | 'agent:replyCommandApproval'
  | 'agent:deleteChatSession'
  | 'agent:renameSession'
  | 'agent:rollbackToMessage';

interface WebSocketRpcRequest {
  id?: string | number;
  method: WebSocketRpcMethod | string;
  params?: Record<string, any>;
}

export interface IWebSocketServerLike {
  on(event: 'connection', listener: (socket: IWebSocketConnectionLike, request?: any) => void): void;
  close(callback?: (error?: Error) => void): void;
}

export type WebSocketServerFactory = (options: { host: string; port: number }) => IWebSocketServerLike;

export interface IWebSocketGatewayAdapterLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface WebSocketGatewayAdapterOptions {
  host: string;
  port: number;
  terminalBridge?: {
    listTerminals: () => Array<{ id: string; title: string; type: string }>;
  };
  profileBridge?: {
    getProfiles: () => {
      activeProfileId: string;
      profiles: Array<{ id: string; name: string; globalModelId: string; modelName?: string }>;
    };
    setActiveProfile: (profileId: string) => {
      activeProfileId: string;
      profiles: Array<{ id: string; name: string; globalModelId: string; modelName?: string }>;
    };
  };
  serverFactory?: WebSocketServerFactory;
  logger?: IWebSocketGatewayAdapterLogger;
}

class WebSocketRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createDefaultWebSocketServerFactory(): WebSocketServerFactory {
  return ({ host, port }) => {
    const wsModule = require('ws');
    const WebSocketServerCtor = wsModule.WebSocketServer ?? wsModule.Server;
    if (!WebSocketServerCtor) {
      throw new Error('Cannot create websocket server: ws.WebSocketServer is unavailable.');
    }
    return new WebSocketServerCtor({ host, port });
  };
}

/**
 * Websocket adapter for Gateway runtime. It is transport-only and does not own business logic.
 */
export class WebSocketGatewayAdapter {
  private server: IWebSocketServerLike | null = null;
  private transportIdBySocket: Map<IWebSocketConnectionLike, string> = new Map();
  private readonly serverFactory: WebSocketServerFactory;
  private readonly logger: IWebSocketGatewayAdapterLogger;

  constructor(
    private gateway: IGatewayRuntime,
    private options: WebSocketGatewayAdapterOptions
  ) {
    this.serverFactory = options.serverFactory ?? createDefaultWebSocketServerFactory();
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.server) return;
    this.server = this.serverFactory({ host: this.options.host, port: this.options.port });
    this.server.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.logger.info(`[WebSocketGatewayAdapter] Listening on ws://${this.options.host}:${this.options.port}`);
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
    this.logger.info('[WebSocketGatewayAdapter] Stopped.');
  }

  private handleConnection(socket: IWebSocketConnectionLike, request?: any): void {
    const remote = request?.socket?.remoteAddress || 'unknown';
    const transport = new WebSocketClientTransport(socket, this.logger);
    this.transportIdBySocket.set(socket, transport.id);
    this.gateway.registerTransport(transport);
    this.logger.info(`[WebSocketGatewayAdapter] Client connected: ${remote} (${transport.id})`);

    socket.on('message', (raw: unknown) => {
      void this.handleIncomingMessage(socket, raw);
    });

    socket.on('close', () => {
      this.cleanupSocket(socket);
    });

    socket.on('error', (error: unknown) => {
      this.logger.warn(`[WebSocketGatewayAdapter] Client socket error (${transport.id}).`, error);
    });
  }

  private cleanupSocket(socket: IWebSocketConnectionLike): void {
    const transportId = this.transportIdBySocket.get(socket);
    if (!transportId) return;
    this.transportIdBySocket.delete(socket);
    this.gateway.unregisterTransport(transportId);
    this.logger.info(`[WebSocketGatewayAdapter] Client disconnected: ${transportId}`);
  }

  private async handleIncomingMessage(socket: IWebSocketConnectionLike, raw: unknown): Promise<void> {
    let requestId: string | undefined;
    try {
      const parsed = this.parseRequest(raw);
      requestId = parsed.id !== undefined ? String(parsed.id) : undefined;
      const result = await this.executeRequest(parsed);
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
        `[WebSocketGatewayAdapter] Dropped invalid notification (${rpcError.code}): ${rpcError.message}`
      );
    }
  }

  private parseRequest(raw: unknown): WebSocketRpcRequest {
    const text = this.coerceRawMessage(raw);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WebSocketRpcError('BAD_JSON', 'Incoming websocket message is not valid JSON.');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new WebSocketRpcError('BAD_REQUEST', 'Websocket request payload must be an object.');
    }
    const request = payload as WebSocketRpcRequest;
    if (typeof request.method !== 'string' || request.method.length === 0) {
      throw new WebSocketRpcError('BAD_REQUEST', 'Websocket request method must be a non-empty string.');
    }
    return request;
  }

  private coerceRawMessage(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    if (Array.isArray(raw)) {
      return Buffer.concat(raw.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))).toString(
        'utf8'
      );
    }
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    throw new WebSocketRpcError('BAD_REQUEST', 'Unsupported websocket payload type.');
  }

  private async executeRequest(request: WebSocketRpcRequest): Promise<any> {
    const params = request.params ?? {};
    switch (request.method) {
      case 'gateway:ping':
        return { pong: true, ts: Date.now() };
      case 'gateway:createSession': {
        const terminalId = this.readOptionalStringParam(params, 'terminalId') ?? this.getDefaultTerminalId();
        const sessionId = await this.gateway.createSession(terminalId);
        return { sessionId };
      }
      case 'terminal:list': {
        if (!this.options.terminalBridge) {
          throw new WebSocketRpcError('UNSUPPORTED', 'Terminal listing is not available on this websocket gateway.');
        }
        return { terminals: this.options.terminalBridge.listTerminals() };
      }
      case 'models:getProfiles': {
        if (!this.options.profileBridge) {
          throw new WebSocketRpcError('UNSUPPORTED', 'Model profile APIs are not available on this websocket gateway.');
        }
        return this.options.profileBridge.getProfiles();
      }
      case 'models:setActiveProfile': {
        if (!this.options.profileBridge) {
          throw new WebSocketRpcError('UNSUPPORTED', 'Model profile APIs are not available on this websocket gateway.');
        }
        const profileId = this.readStringParam(params, 'profileId');
        try {
          return this.options.profileBridge.setActiveProfile(profileId);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to set active profile.';
          throw new WebSocketRpcError('BAD_REQUEST', message);
        }
      }
      case 'agent:startTask': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const userText = this.readStringParam(params, 'userText');
        const terminalId = this.readOptionalStringParam(params, 'terminalId');
        const options = this.readStartTaskOptions(params.options);
        await this.gateway.dispatchTask(sessionId, userText, terminalId, options);
        return { ok: true };
      }
      case 'agent:stopTask': {
        const sessionId = this.readStringParam(params, 'sessionId');
        await this.gateway.stopTask(sessionId);
        return { ok: true };
      }
      case 'agent:replyMessage': {
        const messageId = this.readStringParam(params, 'messageId');
        const payload = params.payload;
        return this.gateway.submitFeedback(messageId, payload);
      }
      case 'agent:replyCommandApproval': {
        const approvalId = this.readStringParam(params, 'approvalId');
        const decision = this.readStringParam(params, 'decision');
        if (decision !== 'allow' && decision !== 'deny') {
          throw new WebSocketRpcError('BAD_REQUEST', 'decision must be "allow" or "deny".');
        }
        return this.gateway.submitFeedback(approvalId, { decision });
      }
      case 'agent:deleteChatSession': {
        const sessionId = this.readStringParam(params, 'sessionId');
        await this.gateway.deleteChatSession(sessionId);
        return { ok: true };
      }
      case 'agent:renameSession': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const newTitle = this.readStringParam(params, 'newTitle');
        this.gateway.renameSession(sessionId, newTitle);
        return { ok: true };
      }
      case 'agent:rollbackToMessage': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const messageId = this.readStringParam(params, 'messageId');
        return await this.gateway.rollbackSessionToMessage(sessionId, messageId);
      }
      default:
        throw new WebSocketRpcError('UNKNOWN_METHOD', `Unsupported websocket method: ${request.method}`);
    }
  }

  private readStringParam(params: Record<string, any>, name: string): string {
    const value = params[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new WebSocketRpcError('BAD_REQUEST', `Missing or invalid parameter: ${name}`);
    }
    return value;
  }

  private readOptionalStringParam(params: Record<string, any>, name: string): string | undefined {
    const value = params[name];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
      throw new WebSocketRpcError('BAD_REQUEST', `Invalid parameter type for ${name}`);
    }
    return value;
  }

  private readStartTaskOptions(raw: unknown): StartTaskOptions | undefined {
    if (!raw) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new WebSocketRpcError('BAD_REQUEST', 'Invalid start task options.');
    }
    const options = raw as StartTaskOptions;
    if (options.startMode && options.startMode !== 'normal' && options.startMode !== 'inserted') {
      throw new WebSocketRpcError('BAD_REQUEST', 'options.startMode must be "normal" or "inserted".');
    }
    return options;
  }

  private getDefaultTerminalId(): string {
    if (!this.options.terminalBridge) {
      throw new WebSocketRpcError('BAD_REQUEST', 'terminalId is required when terminal bridge is unavailable.');
    }
    const terminals = this.options.terminalBridge.listTerminals();
    if (!terminals.length) {
      throw new WebSocketRpcError('BAD_REQUEST', 'No terminal is available on backend.');
    }
    return terminals[0].id;
  }

  private normalizeRpcError(error: unknown): WebSocketRpcError {
    if (error instanceof WebSocketRpcError) return error;
    if (error instanceof Error) return new WebSocketRpcError('INTERNAL_ERROR', error.message);
    return new WebSocketRpcError('INTERNAL_ERROR', 'Unexpected websocket adapter error.');
  }

  private sendRpcSuccess(socket: IWebSocketConnectionLike, id: string, result: unknown): void {
    this.safeSocketSend(socket, {
      type: 'gateway:response',
      id,
      ok: true,
      result
    });
  }

  private sendRpcFailure(socket: IWebSocketConnectionLike, id: string, code: string, message: string): void {
    this.safeSocketSend(socket, {
      type: 'gateway:response',
      id,
      ok: false,
      error: { code, message }
    });
  }

  private safeSocketSend(socket: IWebSocketConnectionLike, payload: Record<string, any>): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn('[WebSocketGatewayAdapter] Failed to send RPC response.', error);
    }
  }
}
