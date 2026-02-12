import type { GatewayEvent, IClientTransport } from './types'

/**
 * TransportHub is a transport-only registry and broadcaster.
 * It keeps GatewayService orchestration logic decoupled from client fan-out details.
 */
export class TransportHub {
  private transports: Map<string, IClientTransport> = new Map()

  register(transport: IClientTransport): void {
    this.transports.set(transport.id, transport)
  }

  unregister(transportId: string): void {
    this.transports.delete(transportId)
  }

  emitEvent(event: GatewayEvent): void {
    this.transports.forEach((transport) => {
      transport.emitEvent(event)
    })
  }

  send(channel: string, data: any): void {
    this.transports.forEach((transport) => {
      transport.send(channel, data)
    })
  }

  sendUIUpdate(action: any): void {
    this.transports.forEach((transport) => {
      transport.sendUIUpdate(action)
    })
  }

  forEach(fn: (transport: IClientTransport) => void): void {
    this.transports.forEach(fn)
  }

  size(): number {
    return this.transports.size
  }

  getIds(): string[] {
    return Array.from(this.transports.keys())
  }
}

