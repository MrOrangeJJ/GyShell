import { v4 as uuidv4 } from 'uuid';
import type { GatewayEvent, IClientTransport } from './types';

export interface IWebSocketConnectionLike {
  on(event: 'message' | 'close' | 'error', listener: (...args: any[]) => void): void;
  send(data: string): void;
}

export interface IWebSocketTransportLogger {
  warn(message: string, error?: unknown): void;
}

/**
 * Client transport implementation for a single websocket connection.
 */
export class WebSocketClientTransport implements IClientTransport {
  public readonly id: string = `ws-${uuidv4()}`;
  public readonly type: 'websocket' = 'websocket';

  constructor(
    private socket: IWebSocketConnectionLike,
    private logger: IWebSocketTransportLogger = console
  ) {}

  send(channel: string, data: any): void {
    this.safeSend({
      type: 'gateway:raw',
      channel,
      payload: data
    });
  }

  emitEvent(event: GatewayEvent): void {
    this.safeSend({
      type: 'gateway:event',
      payload: event
    });
  }

  sendUIUpdate(action: any): void {
    this.safeSend({
      type: 'gateway:ui-update',
      payload: action
    });
  }

  private safeSend(payload: Record<string, any>): void {
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn(`[WebSocketClientTransport] Failed to send payload on transport ${this.id}.`, error);
    }
  }
}

