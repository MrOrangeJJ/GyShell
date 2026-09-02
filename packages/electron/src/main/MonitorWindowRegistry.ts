import { isValidTerminalRuntimeId } from '@gyshell/shared'

export interface MonitorOwnerService {
  start: (terminalId: string, ownerId: string, intervalMs?: number) => void
  stop: (terminalId: string, ownerId: string) => void
}

export interface MonitorWindowTarget {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, data: unknown) => void
  once: (event: 'destroyed', listener: () => void) => void
}

interface MonitorWindowState {
  target: MonitorWindowTarget
  retainedTerminalIds: Set<string>
  subscribedTerminalIds: Set<string>
}

const readTerminalId = (terminalId: unknown): string | undefined =>
  isValidTerminalRuntimeId(terminalId) ? terminalId : undefined

const ownerIdForWindow = (windowId: number): string => `window:${windowId}`

export class MonitorWindowRegistry {
  private windows = new Map<number, MonitorWindowState>()

  constructor(private readonly service: MonitorOwnerService) {}

  retain(target: MonitorWindowTarget, terminalId: string, intervalMs?: number): void {
    const normalizedTerminalId = readTerminalId(terminalId)
    if (!normalizedTerminalId) {
      return
    }
    const state = this.ensureWindowState(target)
    if (state.retainedTerminalIds.has(normalizedTerminalId)) {
      return
    }
    state.retainedTerminalIds.add(normalizedTerminalId)
    this.service.start(normalizedTerminalId, ownerIdForWindow(target.id), intervalMs)
  }

  release(target: MonitorWindowTarget, terminalId: string): void {
    const normalizedTerminalId = readTerminalId(terminalId)
    if (!normalizedTerminalId) {
      return
    }
    const state = this.windows.get(target.id)
    if (!state || !state.retainedTerminalIds.delete(normalizedTerminalId)) {
      return
    }
    this.service.stop(normalizedTerminalId, ownerIdForWindow(target.id))
  }

  subscribe(target: MonitorWindowTarget, terminalId: string): void {
    const normalizedTerminalId = readTerminalId(terminalId)
    if (!normalizedTerminalId) {
      return
    }
    this.ensureWindowState(target).subscribedTerminalIds.add(normalizedTerminalId)
  }

  unsubscribe(target: MonitorWindowTarget, terminalId: string): void {
    const normalizedTerminalId = readTerminalId(terminalId)
    if (!normalizedTerminalId) {
      return
    }
    this.windows.get(target.id)?.subscribedTerminalIds.delete(normalizedTerminalId)
  }

  publish(channel: string, data: unknown): void {
    const terminalId = readTerminalId(
      (data as { terminalId?: string } | null)?.terminalId,
    )
    if (!terminalId) {
      return
    }
    this.windows.forEach((state, windowId) => {
      if (state.target.isDestroyed()) {
        this.unregisterWindow(windowId)
        return
      }
      if (!state.subscribedTerminalIds.has(terminalId)) {
        return
      }
      try {
        state.target.send(channel, data)
      } catch {
        this.unregisterWindow(windowId)
      }
    })
  }

  private ensureWindowState(target: MonitorWindowTarget): MonitorWindowState {
    const existing = this.windows.get(target.id)
    if (existing) {
      return existing
    }
    const state: MonitorWindowState = {
      target,
      retainedTerminalIds: new Set<string>(),
      subscribedTerminalIds: new Set<string>(),
    }
    this.windows.set(target.id, state)
    target.once('destroyed', () => {
      this.unregisterWindow(target.id)
    })
    return state
  }

  private unregisterWindow(windowId: number): void {
    const state = this.windows.get(windowId)
    if (!state) {
      return
    }
    const ownerId = ownerIdForWindow(windowId)
    state.retainedTerminalIds.forEach((terminalId) => {
      this.service.stop(terminalId, ownerId)
    })
    this.windows.delete(windowId)
  }
}
