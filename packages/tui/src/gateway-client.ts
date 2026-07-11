import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type {
  GatewayEvent,
  GatewayIncomingEnvelope,
  RpcRequest,
  UIUpdateAction,
} from './protocol'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type GatewayClientEvents = {
  uiUpdate: (action: UIUpdateAction) => void
  gatewayEvent: (event: GatewayEvent) => void
  raw: (channel: string, payload: unknown) => void
  close: (code: number, reason: string) => void
  error: (error: Error) => void
}

export function shouldReplayUiUpdateAfterSnapshot(
  update: UIUpdateAction,
  uiRevision?: number,
): boolean {
  if (
    typeof uiRevision === 'number' &&
    Number.isFinite(uiRevision) &&
    typeof update.uiRevision === 'number' &&
    Number.isFinite(update.uiRevision)
  ) {
    return update.uiRevision > uiRevision
  }
  return update.type === 'SESSION_RENAMED'
}

export class GatewayClient {
  private socket: WebSocket | null = null
  private readonly emitter = new EventEmitter()
  private readonly pending = new Map<string, PendingRequest>()
  private pendingUiUpdates: UIUpdateAction[] = []
  private nextRequestId = 1

  constructor(
    private readonly url: string,
    private readonly accessToken?: string
  ) {}

  async connect(timeoutMs = 3000): Promise<void> {
    if (this.socket) return

    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {}
      const token = String(this.accessToken || '').trim()
      if (token) {
        headers.authorization = `Bearer ${token}`
      }
      const socket = new WebSocket(this.url, { headers })
      this.socket = socket

      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`Connection timeout (${timeoutMs}ms): ${this.url}`))
      }, timeoutMs)

      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })

      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })

      socket.on('message', (raw) => {
        this.handleIncoming(raw)
      })

      socket.on('close', (code, reason) => {
        const text = reason?.toString('utf8') ?? ''
        this.rejectPending(new Error(`Socket closed (${code}): ${text || 'no reason'}`))
        this.emitter.emit('close', code, text)
      })

      socket.on('error', (error) => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        this.emitClientError(normalized)
      })
    })
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async ping(): Promise<void> {
    await this.request('gateway:ping', {})
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway socket is not connected')
    }

    const id = String(this.nextRequestId++)
    const payload: RpcRequest = { id, method, params }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })

      try {
        socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    this.pendingUiUpdates = []
    if (!socket) return
    try {
      socket.close()
    } catch {
      socket.terminate()
    }
  }

  discardBufferedUiUpdatesCoveredBySnapshot(
    uiRevision?: number,
    sessionId?: string,
  ): void {
    const normalizedRevision =
      typeof uiRevision === 'number' && Number.isFinite(uiRevision)
        ? uiRevision
        : null
    const normalizedSessionId = String(sessionId || '').trim()
    this.pendingUiUpdates = this.pendingUiUpdates.filter((update) => {
      if (normalizedSessionId && update.sessionId !== normalizedSessionId) {
        return true
      }
      return shouldReplayUiUpdateAfterSnapshot(
        update,
        normalizedRevision ?? undefined,
      )
    })
  }

  on<K extends keyof GatewayClientEvents>(event: K, handler: GatewayClientEvents[K]): () => void {
    this.emitter.on(event, handler)
    if (event === 'uiUpdate' && this.pendingUiUpdates.length > 0) {
      const pending = this.pendingUiUpdates.splice(0, this.pendingUiUpdates.length)
      const uiUpdateHandler = handler as GatewayClientEvents['uiUpdate']
      pending.forEach((update) => uiUpdateHandler(update))
    }
    return () => {
      this.emitter.off(event, handler)
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer)
      item.reject(error)
      this.pending.delete(id)
    }
  }

  private handleIncoming(raw: WebSocket.RawData): void {
    const text = this.coerceMessage(raw)

    let payload: GatewayIncomingEnvelope | null = null
    try {
      payload = JSON.parse(text) as GatewayIncomingEnvelope
    } catch {
      this.emitClientError(new Error(`Invalid JSON from gateway: ${text.slice(0, 120)}`))
      return
    }

    if (!payload || typeof payload !== 'object' || !('type' in payload)) return

    if (payload.type === 'gateway:response') {
      const pending = this.pending.get(payload.id)
      if (!pending) return

      clearTimeout(pending.timer)
      this.pending.delete(payload.id)

      if (payload.ok) {
        pending.resolve(payload.result)
      } else {
        pending.reject(new Error(`${payload.error.code}: ${payload.error.message}`))
      }
      return
    }

    if (payload.type === 'gateway:ui-update') {
      if (this.emitter.listenerCount('uiUpdate') === 0) {
        this.pendingUiUpdates.push(payload.payload)
      } else {
        this.emitter.emit('uiUpdate', payload.payload)
      }
      return
    }

    if (payload.type === 'gateway:event') {
      this.emitter.emit('gatewayEvent', payload.payload)
      return
    }

    if (payload.type === 'gateway:raw') {
      this.emitter.emit('raw', payload.channel, payload.payload)
      return
    }
  }

  private coerceMessage(raw: WebSocket.RawData): string {
    if (typeof raw === 'string') return raw
    if (raw instanceof Buffer) return raw.toString('utf8')
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
    return String(raw)
  }

  private emitClientError(error: Error): void {
    if (this.emitter.listenerCount('error') === 0) return
    this.emitter.emit('error', error)
  }
}
