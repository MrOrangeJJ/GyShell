import Store from 'electron-store'
import type { ChatSession } from '../types'

export interface StoredChatSession {
  id: string
  title: string
  boundTerminalTabId: string
  messages: Array<{
    id: string
    type: string
    data: any
  }>
  lastCheckpointOffset: number
  createdAt: number
  updatedAt: number
}

export interface StoredChatHistory {
  sessions: StoredChatSession[]
}

const DEFAULT_HISTORY: StoredChatHistory = {
  sessions: []
}

export class ChatHistoryService {
  private store: Store<StoredChatHistory>

  constructor() {
    this.store = new Store<StoredChatHistory>({
      defaults: DEFAULT_HISTORY,
      name: 'gyshell-chat-history'
    })
  }

  saveSession(session: ChatSession): void {
    const sessions = this.store.get('sessions') as StoredChatSession[]
    const sessionIndex = sessions.findIndex((s: StoredChatSession) => s.id === session.id)
    
    const storedSession: StoredChatSession = {
      id: session.id,
      title: session.title,
      boundTerminalTabId: session.boundTerminalTabId,
      messages: Array.from(session.messages.entries()).map(([id, msg]) => ({
        id,
        type: (msg as any)._getType ? (msg as any)._getType() : 'unknown',
        data: msg
      })),
      lastCheckpointOffset: session.lastCheckpointOffset,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    if (sessionIndex >= 0) {
      sessions[sessionIndex] = storedSession
    } else {
      sessions.push(storedSession)
    }

    this.store.set('sessions', sessions)
  }

  loadSession(sessionId: string): ChatSession | null {
    const sessions = this.store.get('sessions') as StoredChatSession[]
    const storedSession = sessions.find((s: StoredChatSession) => s.id === sessionId)
    
    if (!storedSession) {
      return null
    }

    const messages = new Map<string, any>()
    for (const msg of storedSession.messages) {
      messages.set(msg.id, msg.data)
    }

    return {
      id: storedSession.id,
      title: storedSession.title,
      boundTerminalTabId: storedSession.boundTerminalTabId,
      messages,
      lastCheckpointOffset: storedSession.lastCheckpointOffset
    }
  }

  getAllSessions(): StoredChatSession[] {
    return this.store.get('sessions', [])
  }

  deleteSession(sessionId: string): void {
    const sessions = this.store.get('sessions') as StoredChatSession[]
    const filtered = sessions.filter((s: StoredChatSession) => s.id !== sessionId)
    this.store.set('sessions', filtered)
  }

  clearAll(): void {
    this.store.set('sessions', [])
  }

  renameSession(sessionId: string, newTitle: string): void {
    const sessions = this.store.get('sessions') as StoredChatSession[]
    const sessionIndex = sessions.findIndex((s: StoredChatSession) => s.id === sessionId)
    if (sessionIndex >= 0) {
      sessions[sessionIndex].title = newTitle
      sessions[sessionIndex].updatedAt = Date.now()
      this.store.set('sessions', sessions)
    }
  }

  exportSession(sessionId: string): StoredChatSession | null {
    const sessions = this.store.get('sessions') as StoredChatSession[]
    const storedSession = sessions.find((s: StoredChatSession) => s.id === sessionId)
    
    if (!storedSession) {
      return null
    }

    return storedSession
  }
}
