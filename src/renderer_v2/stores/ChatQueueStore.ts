import { makeObservable, observable, action } from 'mobx'
import { v4 as uuidv4 } from 'uuid'

export type QueueState = 'editing' | 'running'

export interface QueueItem {
  id: string
  content: string
  createdAt: number
}

export class ChatQueueStore {
  modeBySession: Record<string, boolean> = {}
  queuesBySession: Record<string, QueueItem[]> = {}
  statesBySession: Record<string, QueueState> = {}

  constructor() {
    makeObservable(this, {
      modeBySession: observable,
      queuesBySession: observable,
      statesBySession: observable,
      setQueueMode: action,
      setState: action,
      addItem: action,
      removeItem: action,
      moveItem: action,
      shiftItem: action,
      unshiftItem: action,
      clearSession: action
    })
  }

  setQueueMode(enabled: boolean, sessionId: string): void {
    this.modeBySession[sessionId] = enabled
    if (enabled) {
      this.setState(sessionId, 'editing')
    }
  }

  isQueueMode(sessionId: string): boolean {
    return !!this.modeBySession[sessionId]
  }

  setState(sessionId: string, state: QueueState): void {
    this.statesBySession[sessionId] = state
  }

  getState(sessionId: string): QueueState {
    return this.statesBySession[sessionId] || 'editing'
  }

  isRunning(sessionId: string): boolean {
    return this.getState(sessionId) === 'running'
  }

  getQueue(sessionId: string): QueueItem[] {
    return this.queuesBySession[sessionId] || []
  }

  addItem(sessionId: string, content: string): QueueItem {
    const item: QueueItem = {
      id: uuidv4(),
      content,
      createdAt: Date.now()
    }
    const current = this.getQueue(sessionId)
    this.queuesBySession[sessionId] = [...current, item]
    return item
  }

  removeItem(sessionId: string, itemId: string): void {
    const current = this.getQueue(sessionId)
    this.queuesBySession[sessionId] = current.filter((item) => item.id !== itemId)
  }

  moveItem(sessionId: string, fromIndex: number, toIndex: number): void {
    const current = this.getQueue(sessionId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) return
    if (fromIndex === toIndex) return
    const next = current.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    this.queuesBySession[sessionId] = next
  }

  shiftItem(sessionId: string): QueueItem | null {
    const current = this.getQueue(sessionId)
    if (current.length === 0) return null
    const [first, ...rest] = current
    this.queuesBySession[sessionId] = rest
    return first
  }

  unshiftItem(sessionId: string, item: QueueItem): void {
    const current = this.getQueue(sessionId)
    this.queuesBySession[sessionId] = [item, ...current]
  }

  clearSession(sessionId: string): void {
    delete this.modeBySession[sessionId]
    delete this.queuesBySession[sessionId]
    delete this.statesBySession[sessionId]
  }
}
