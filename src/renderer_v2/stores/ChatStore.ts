import { makeObservable, observable, action, runInAction, computed, ObservableMap } from 'mobx'
import { v4 as uuidv4 } from 'uuid'
import { ChatQueueStore, type QueueItem } from './ChatQueueStore'

export type MessageType = 'text' | 'command' | 'tool_call' | 'file_edit' | 'sub_tool' | 'alert' | 'error' | 'ask' | 'tokens_count'

export interface ChatMessage {
  id: string
  backendMessageId?: string
  role: 'user' | 'assistant' | 'system'
  type: MessageType
  content: string
  renderMode?: 'normal' | 'sub'
  metadata?: {
    tabName?: string
    commandId?: string
    exitCode?: number
    output?: string
    diff?: string
    filePath?: string
    action?: 'created' | 'edited' | 'error'
    collapsed?: boolean
    isNowait?: boolean
    toolName?: string
    subToolTitle?: string
    subToolHint?: string
    subToolLevel?: 'info' | 'warning' | 'error'
    approvalId?: string
    decision?: 'allow' | 'deny'
    command?: string
    modelName?: string
    totalTokens?: number
    maxTokens?: number
    details?: string
  }
  timestamp: number
  streaming?: boolean
}

export interface ChatSession {
  id: string
  title: string
  messagesById: ObservableMap<string, ChatMessage>
  messageIds: string[]
  isThinking: boolean
  isSessionBusy: boolean
}

export class ChatStore {
  sessions: ChatSession[] = []
  activeSessionId: string | null = null
  queue = new ChatQueueStore()
  private queueRunner?: (sessionId: string, content: string) => boolean

  constructor() {
    makeObservable(this, {
      sessions: observable,
      activeSessionId: observable,
      activeSession: computed,
      activeSessionLatestTokens: computed,
      activeSessionLatestMaxTokens: computed,
      createSession: action,
      setActiveSession: action,
      closeSession: action,
      addMessage: action,
      updateMessage: action,
      removeMessage: action,
      setThinking: action,
      setSessionBusy: action,
      clear: action,
      handleUiUpdate: action,
      loadChatHistory: action,
      deleteChatSession: action,
      rollbackToMessage: action,
      setQueueRunner: action,
      startQueue: action,
      stopQueue: action,
      addQueueItem: action,
      removeQueueItem: action,
      moveQueueItem: action
    })

    // Create default session
    this.createSession('New Chat')
  }

  get activeSession(): ChatSession | null {
    return this.sessions.find(s => s.id === this.activeSessionId) || null
  }

  get activeSessionLatestTokens(): number {
    const session = this.activeSession
    if (!session) return 0
    // Traverse messageIds from end to start
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i])
      if (msg && msg.type === 'tokens_count') {
        return msg.metadata?.totalTokens || 0
      }
    }
    return 0
  }

  get activeSessionLatestMaxTokens(): number {
    const session = this.activeSession
    if (!session) return 0
    // Traverse messageIds from end to start
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i])
      if (msg && msg.type === 'tokens_count') {
        return msg.metadata?.maxTokens || 0
      }
    }
    return 0
  }

  createSession(title: string = 'New Chat'): string {
    const id = uuidv4()
    const session: ChatSession = {
      id,
      title,
      messagesById: observable.map<string, ChatMessage>(),
      messageIds: [],
      isThinking: false,
      isSessionBusy: false
    }
    runInAction(() => {
      this.sessions.push(session)
      this.activeSessionId = id
    })
    return id
  }

  setActiveSession(id: string) {
    this.activeSessionId = id
  }

  closeSession(id: string) {
    const idx = this.sessions.findIndex(s => s.id === id)
    if (idx === -1) return

    const nextSessions = this.sessions.filter(s => s.id !== id)
    let nextActiveId = this.activeSessionId

    if (this.activeSessionId === id) {
        nextActiveId = nextSessions[idx - 1]?.id || nextSessions[0]?.id || null
    }

    runInAction(() => {
        this.sessions = nextSessions
        this.activeSessionId = nextActiveId
    })
    this.queue.clearSession(id)

    if (this.sessions.length === 0) {
        this.createSession()
    }
  }

  addMessage(msg: Omit<ChatMessage, 'id' | 'timestamp'>, sessionId: string): string {
    const id = uuidv4()
    const fullMsg: ChatMessage = {
      ...msg,
      id,
      timestamp: Date.now()
    }
    
    runInAction(() => {
      const session = this.sessions.find(s => s.id === sessionId)
      if (session) {
        session.messagesById.set(id, fullMsg)
        session.messageIds.push(id)
        // Auto-update title based on first user message if title is default
        if (msg.role === 'user') {
          const userMsgCount = session.messageIds.filter(msgId => {
            const m = session.messagesById.get(msgId)
            return m && m.role === 'user'
          }).length
          if (userMsgCount === 1) {
            session.title = msg.content.slice(0, 20) + (msg.content.length > 20 ? '...' : '')
          }
        }
      }
    })
    return id
  }

  updateMessage(id: string, patch: Partial<ChatMessage>, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return

    const msg = session.messagesById.get(id)
    if (msg) {
      runInAction(() => {
        Object.assign(msg, patch)
      })
    }
  }

  removeMessage(id: string, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return
    runInAction(() => {
      session.messagesById.delete(id)
      session.messageIds = session.messageIds.filter(msgId => msgId !== id)
    })
  }

  setThinking(thinking: boolean, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (session) {
        runInAction(() => {
            session.isThinking = thinking
        })
    }
  }

  setSessionBusy(busy: boolean, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (session) {
        runInAction(() => {
            session.isSessionBusy = busy
        })
    }
  }

  clear() {
    if (!this.activeSessionId) return
    const session = this.sessions.find(s => s.id === this.activeSessionId)
    if (session) {
        runInAction(() => {
            session.messagesById.clear()
            session.messageIds = []
        })
    }
  }

  handleUiUpdate(update: any) {
    const { type, sessionId } = update
    const session = this.sessions.find((s) => s.id === sessionId)
    if (!session) return

    runInAction(() => {
      switch (type) {
        case 'ADD_MESSAGE': {
          const msg = update.message
          session.messagesById.set(msg.id, msg)
          session.messageIds.push(msg.id)
          // Auto-update title logic if needed (backend also does this, but for UX we can do it here too)
          if (msg.role === 'user') {
            const userMsgCount = session.messageIds.filter(msgId => {
              const m = session.messagesById.get(msgId)
              return m && m.role === 'user'
            }).length
            if (userMsgCount === 1) {
              session.title = msg.content.slice(0, 20) + (msg.content.length > 20 ? '...' : '')
            }
          }
          break
        }
        case 'APPEND_CONTENT': {
          const msg = session.messagesById.get(update.messageId)
          if (msg) {
            msg.content += update.content
          }
          break
        }
        case 'APPEND_OUTPUT': {
          const msg = session.messagesById.get(update.messageId)
          if (msg) {
            msg.metadata = { ...(msg.metadata || {}), output: (msg.metadata?.output || '') + (update.outputDelta || '') }
          }
          break
        }
        case 'UPDATE_MESSAGE': {
          const msg = session.messagesById.get(update.messageId)
          if (msg) {
            Object.assign(msg, update.patch)
          }
          break
        }
        case 'DONE':
          session.isThinking = false
          break
        case 'SESSION_READY':
          session.isSessionBusy = false
          if (this.queue.isRunning(sessionId)) {
            this.runNextQueueItem(sessionId)
          }
          break
      }
    })

    if (type === 'ADD_MESSAGE' && update.message?.role === 'user') {
      runInAction(() => {
        session.isThinking = true
        session.isSessionBusy = true
      })
    }

    if (type === 'ADD_MESSAGE' && update.message?.type === 'error') {
      this.stopQueue(sessionId)
      return
    }
  }

  async loadChatHistory(sessionId: string): Promise<void> {
    try {
      // Get all history first to find the title
      const allHistory = await this.getAllChatHistory()
      const sessionInfo = allHistory.find(h => h.id === sessionId)

      // Load UI messages from backend
      const messages = await window.gyshell.agent.getUiMessages(sessionId)
      
      runInAction(() => {
        const existingSession = this.sessions.find(s => s.id === sessionId)
        if (existingSession) {
          // Convert array to Map + IDs
          existingSession.messagesById.clear()
          existingSession.messageIds = []
          messages.forEach(msg => {
            existingSession.messagesById.set(msg.id, msg)
            existingSession.messageIds.push(msg.id)
          })
          existingSession.isThinking = false
          if (sessionInfo?.title) {
            existingSession.title = sessionInfo.title
          }
        } else {
          const messagesById = observable.map<string, ChatMessage>()
          const messageIds: string[] = []
          messages.forEach(msg => {
            messagesById.set(msg.id, msg)
            messageIds.push(msg.id)
          })
          this.sessions.push({
            id: sessionId,
            title: sessionInfo?.title || 'Loaded Session',
            messagesById,
            messageIds,
            isThinking: false,
            isSessionBusy: false
          })
        }

        this.activeSessionId = sessionId
      })

      // Also load backend session for agent context
      await window.gyshell.agent.loadChatSession(sessionId)
    } catch (error) {
      console.error('Failed to load chat history:', error)
      throw error
    }
  }

  async getAllChatHistory(): Promise<any[]> {
    try {
      // Get backend sessions for all available sessions
      return await window.gyshell.agent.getAllChatHistory()
    } catch (error) {
      console.error('Failed to get chat history:', error)
      return []
    }
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    try {
      await window.gyshell.agent.deleteChatSession(sessionId)
      
      runInAction(() => {
        this.sessions = this.sessions.filter(s => s.id !== sessionId)
        if (this.activeSessionId === sessionId) {
          this.activeSessionId = null
        }
      })
      this.queue.clearSession(sessionId)
    } catch (error) {
      console.error('Failed to delete chat session:', error)
      throw error
    }
  }

  rollbackToMessage(sessionId: string, backendMessageId: string): void {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return
    
    // Find the index of the message to rollback to
    const idx = session.messageIds.findIndex(msgId => {
      const msg = session.messagesById.get(msgId)
      return msg && msg.backendMessageId === backendMessageId
    })
    if (idx === -1) return

    runInAction(() => {
      // Remove messages after the rollback point
      const keptIds = session.messageIds.slice(0, idx)
      const removedIds = session.messageIds.slice(idx)
      
      // Delete from Map
      removedIds.forEach(msgId => session.messagesById.delete(msgId))
      
      // Update IDs array
      session.messageIds = keptIds
      session.isThinking = false
    })
  }

  setQueueRunner(runner: (sessionId: string, content: string) => boolean): void {
    this.queueRunner = runner
  }

  addQueueItem(sessionId: string, content: string): QueueItem | null {
    const trimmed = String(content || '').trim()
    if (!trimmed) return null
    return this.queue.addItem(sessionId, trimmed)
  }

  removeQueueItem(sessionId: string, itemId: string): void {
    this.queue.removeItem(sessionId, itemId)
  }

  moveQueueItem(sessionId: string, fromIndex: number, toIndex: number): void {
    this.queue.moveItem(sessionId, fromIndex, toIndex)
  }

  startQueue(sessionId: string): void {
    if (this.queue.isRunning(sessionId)) return
    if (this.queue.getQueue(sessionId).length === 0) return
    this.queue.setState(sessionId, 'running')
    this.runNextQueueItem(sessionId)
  }

  stopQueue(sessionId: string): void {
    if (!sessionId) return
    this.queue.setState(sessionId, 'editing')
  }

  private runNextQueueItem(sessionId: string): void {
    const next = this.queue.shiftItem(sessionId)
    if (!next) {
      this.queue.setState(sessionId, 'editing')
      return
    }
    if (!this.queueRunner || !this.queueRunner(sessionId, next.content)) {
      this.queue.unshiftItem(sessionId, next)
      this.queue.setState(sessionId, 'editing')
      return
    }
  }
}
