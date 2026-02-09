import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import type { AgentEvent, AgentEventType } from '../types'
import type { ChatMessage, UIChatSession, UIUpdateAction } from '../types/ui-chat'

const buildAutoSessionTitle = (content: string): string => {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim()
  return normalized || 'New Chat'
}

export type HistoryExportMode = 'simple' | 'detailed'

interface StoredUIHistory {
  sessions: Record<string, UIChatSession>
}

export class UIHistoryService {
  private store: Store<StoredUIHistory>
  // Keep UI history hot in memory to avoid sync electron-store overhead on every stream chunk.
  private sessionsCache: Record<string, UIChatSession>
  private dirtySessions: Set<string> = new Set()

  constructor() {
    this.store = new Store<StoredUIHistory>({
      name: 'gyshell-ui-history',
      defaults: { sessions: {} }
    })
    this.sessionsCache = this.sanitizeSessions(this.store.get('sessions') || {})
    this.saveSessions(this.sessionsCache)
  }

  private sanitizeSessions(sessions: Record<string, UIChatSession>): Record<string, UIChatSession> {
    const sanitized = JSON.parse(JSON.stringify(sessions)) as Record<string, UIChatSession>
    Object.values(sanitized).forEach(session => {
      session.messages = session.messages.filter(m => m.type !== 'ask') // Remove all hanging ask banners
      session.messages.forEach(m => {
        if (m.type === 'command' && m.streaming) {
          m.streaming = false
          if (m.metadata && m.metadata.exitCode === undefined) {
            m.metadata.exitCode = -1 // Mark as failed/interrupted
            m.metadata.output = (m.metadata.output || '') + '\n[Session closed before command finished]'
          }
        }
      })
      this.restoreLegacyAutoTitleIfTruncated(session)
    })
    return sanitized
  }

  private restoreLegacyAutoTitleIfTruncated(session: UIChatSession): void {
    const firstUserText = session.messages.find((m) => m.role === 'user')?.content
    if (!firstUserText) return

    const fullAutoTitle = buildAutoSessionTitle(firstUserText)
    const currentTitle = String(session.title || '').trim()
    if (!currentTitle || currentTitle === 'New Chat') {
      session.title = fullAutoTitle
      return
    }

    // Backward-compatible migration for historical truncated titles like "xxxxx..."
    if (currentTitle.endsWith('...')) {
      const prefix = currentTitle.slice(0, -3)
      if (prefix && fullAutoTitle.startsWith(prefix)) {
        session.title = fullAutoTitle
      }
    }
  }

  private saveSessions(sessions: Record<string, UIChatSession>): void {
    this.store.set('sessions', this.sanitizeSessions(sessions))
  }

  recordEvent(sessionId: string, event: AgentEvent): UIUpdateAction[] {
    if (!this.sessionsCache[sessionId]) {
      this.sessionsCache[sessionId] = {
        id: sessionId,
        title: 'New Chat',
        messages: [],
        updatedAt: Date.now()
      }
    }
    const session = this.sessionsCache[sessionId]
    session.updatedAt = Date.now()

    const actions = this.processEvent(session, event, sessionId)
    // Mark dirty but do not persist immediately (critical for smooth streaming UX).
    this.dirtySessions.add(sessionId)
    return actions
  }

  /**
   * Flush UI history to disk. By design we persist at low frequency
   * (e.g. on task completion / error / delete / rollback), not on every event.
   */
  flush(sessionId?: string): void {
    if (sessionId) {
      // Only flush if this session has changes; still writes full sessions map
      // because electron-store persists the underlying JSON file as a whole.
      if (!this.dirtySessions.has(sessionId)) return
    } else if (this.dirtySessions.size === 0) {
      return
    }

    this.saveSessions(this.sessionsCache)
    if (sessionId) this.dirtySessions.delete(sessionId)
    else this.dirtySessions.clear()
  }

  private processEvent(session: UIChatSession, event: AgentEvent, sessionId: string): UIUpdateAction[] {
    const type = event.type as AgentEventType
    const actions: UIUpdateAction[] = []

    if (type === 'user_input') {
      const message = this.createMessage({
        role: 'user',
        type: 'text',
        content: event.content || '',
        metadata: {
          inputKind: event.inputKind || 'normal'
        },
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      this.checkAutoTitle(session, 'user', event.content || '')
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'say') {
      const lastMsg = session.messages[session.messages.length - 1]
      const delta = event.content || event.outputDelta || ''
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.type === 'text' && lastMsg.streaming) {
        lastMsg.content += delta
        actions.push({ type: 'APPEND_CONTENT', sessionId, messageId: lastMsg.id, content: delta })
      } else {
        const stopAction = this.stopLatestStreaming(session, sessionId)
        if (stopAction) actions.push(stopAction)

        const message = this.createMessage({
          role: 'assistant',
          type: 'text',
          content: delta,
          streaming: true,
          backendMessageId: event.messageId
        }, sessionId)
        session.messages.push(message)
        actions.push({ type: 'ADD_MESSAGE', sessionId, message })
      }
    } else if (type === 'command_started') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)

      // CRITICAL FIX: If there was a pending 'ask' message with the same backendMessageId, 
      // remove it from history to prevent it from reappearing on reload.
      const existingIdx = session.messages.findIndex(m => m.backendMessageId === event.messageId && m.type === 'ask')
      if (existingIdx !== -1) {
        session.messages.splice(existingIdx, 1)
      }

      const message = this.createMessage({
        role: 'assistant',
        type: 'command',
        content: event.command || '',
        metadata: {
          commandId: event.commandId,
          tabName: event.tabName || 'Terminal',
          output: '',
          isNowait: !!(event as any).isNowait,
          collapsed: false
        },
        streaming: true,
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'command_finished') {
      // If this is a finished event for a rejected command, we might need to clear the ask message too
      const existingIdx = session.messages.findIndex(m => m.backendMessageId === event.messageId && m.type === 'ask')
      if (existingIdx !== -1) {
        session.messages.splice(existingIdx, 1)
      }

      const msg = event.commandId
        ? session.messages.find((m) => m.metadata?.commandId === event.commandId)
        : [...session.messages].reverse().find((m) => m.type === 'command' && m.streaming)

      if (msg) {
        const patch = {
          metadata: {
            ...msg.metadata,
            exitCode: event.exitCode,
            output: (msg.metadata?.output || '') + (event.outputDelta || '') + (event.message ? `\nError: ${event.message}` : ''),
            isNowait: (event as any).isNowait ?? msg.metadata?.isNowait
          },
          streaming: false
        }
        Object.assign(msg, patch)
        actions.push({ type: 'UPDATE_MESSAGE', sessionId, messageId: msg.id, patch })
      }
    } else if (type === 'tool_call') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)

      const message = this.createMessage({
        role: 'assistant',
        type: 'tool_call',
        content: event.input || '',
        metadata: {
          output: event.output || '',
          toolName: event.toolName || 'Tool Call'
        },
        streaming: false,
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'file_edit') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)

      const message = this.createMessage({
        role: 'assistant',
        type: 'file_edit',
        content: event.output || '',
        metadata: {
          toolName: event.toolName || 'create_or_edit',
          filePath: event.filePath,
          action: event.action || 'edited',
          diff: event.diff || '',
          output: event.output || ''
        },
        streaming: false,
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'file_read') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)

      const message = this.createMessage({
        role: 'assistant',
        type: 'sub_tool',
        content: event.output || '',
        metadata: {
          subToolTitle: `Read: ${event.filePath || 'unknown'}`,
          subToolLevel: event.level || (String(event.output || '').startsWith('Error:') ? 'warning' : 'info'),
          output: event.output || '',
          collapsed: true
        },
        streaming: false,
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'command_ask') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)

      const message = this.createMessage({
        role: 'system',
        type: 'ask',
        content: event.command || '',
        metadata: {
          approvalId: event.approvalId,
          toolName: event.toolName || 'Command',
          command: event.command || '',
          decision: (event as any).decision
        },
        streaming: false,
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'sub_tool_started') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)
      const isReasoning = this.isReasoningSubToolEvent(event)

      const message = this.createMessage({
        role: 'assistant',
        type: isReasoning ? 'reasoning' : 'sub_tool',
        content: '',
        metadata: {
          subToolTitle: event.title || event.toolName || 'Sub Tool',
          subToolHint: event.hint,
          output: '',
          collapsed: true
        },
        streaming: true,
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'sub_tool_delta') {
      const msg = event.messageId
        ? session.messages.find((m) => m.backendMessageId === event.messageId)
        : [...session.messages].reverse().find((m) => m.type === 'sub_tool' && m.streaming)

      if (msg) {
        const delta = event.outputDelta || ''
        msg.metadata = {
          ...msg.metadata,
          output: (msg.metadata?.output || '') + delta
        }
        actions.push({ type: 'APPEND_OUTPUT', sessionId, messageId: msg.id, outputDelta: delta })
      }
    } else if (type === 'sub_tool_finished') {
      const msg = event.messageId
        ? session.messages.find((m) => m.backendMessageId === event.messageId)
        : [...session.messages].reverse().find((m) => m.type === 'sub_tool' && m.streaming)
      if (msg) {
        msg.streaming = false
        actions.push({ type: 'UPDATE_MESSAGE', sessionId, messageId: msg.id, patch: { streaming: false } })
      }
    } else if (type === 'remove_message') {
      const msg = event.messageId
        ? [...session.messages]
            .reverse()
            .find((m) => m.backendMessageId === event.messageId && m.role === 'assistant')
        : [...session.messages].reverse().find((m) => m.role === 'assistant')
      if (msg) {
        session.messages = session.messages.filter((m) => m.id !== msg.id)
        actions.push({ type: 'REMOVE_MESSAGE', sessionId, messageId: msg.id })
      }
    } else if (type === 'done') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)
      actions.push({ type: 'DONE', sessionId })
      // Ensure no messages are in streaming state under done status
      session.messages.forEach(m => { m.streaming = false; });
    } else if (type === 'alert') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)

      const message = this.createMessage({
        role: 'system',
        type: 'alert',
        content: event.message || 'Unknown alert',
        metadata: {
          subToolLevel: event.level || 'warning'
        },
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if (type === 'error') {
      const stopAction = this.stopLatestStreaming(session, sessionId)
      if (stopAction) actions.push(stopAction)

      const message = this.createMessage({
        role: 'system',
        type: 'error',
        content: event.message || 'Unknown error',
        metadata: {
          details: (event as any).details || ''
        },
        backendMessageId: event.messageId
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
      actions.push({ type: 'DONE', sessionId })
    } else if (type === 'tokens_count') {
      const message = this.createMessage({
        role: 'system',
        type: 'tokens_count',
        content: '',
        metadata: {
          modelName: event.modelName,
          totalTokens: event.totalTokens,
          maxTokens: event.maxTokens
        }
      }, sessionId)
      session.messages.push(message)
      actions.push({ type: 'ADD_MESSAGE', sessionId, message })
    } else if ((type as string) === 'rollback') {
      // Core: handle rollback of memory cache
      const mid = (event as any).messageId;
      const idx = session.messages.findIndex(m => m.backendMessageId === mid);
      if (idx !== -1) {
        session.messages = session.messages.slice(0, idx);
        this.dirtySessions.add(sessionId);
        // Notify frontend UI to execute corresponding rollback Action
        actions.push({ type: 'ROLLBACK' as any, sessionId, messageId: mid } as any);
      }
    }
    return actions
  }

  private stopLatestStreaming(session: UIChatSession, sessionId: string): UIUpdateAction | null {
    const messages = session.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].streaming) {
        messages[i].streaming = false
        return { type: 'UPDATE_MESSAGE', sessionId, messageId: messages[i].id, patch: { streaming: false } }
      }
    }
    return null
  }

  private createMessage(msg: Omit<ChatMessage, 'id' | 'timestamp'>, _sessionId?: string): ChatMessage {
    return {
      ...msg,
      id: uuidv4(),
      timestamp: Date.now()
    }
  }

  private isReasoningSubToolEvent(event: AgentEvent): boolean {
    const rawTitle = String(event.title || event.toolName || '').trim().toLowerCase()
    return rawTitle.startsWith('reasoning')
  }

  private checkAutoTitle(session: UIChatSession, role: string, content: string): void {
    if (role === 'user' && session.messages.filter((m) => m.role === 'user').length === 1) {
      session.title = buildAutoSessionTitle(content)
    }
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.sessionsCache[sessionId]?.messages || []
  }

  getSession(sessionId: string): UIChatSession | null {
    return this.sessionsCache[sessionId] || null
  }

  getAllSessions(): UIChatSession[] {
    return Object.values(this.sessionsCache).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  deleteSession(sessionId: string): void {
    delete this.sessionsCache[sessionId]
    this.dirtySessions.delete(sessionId)
    this.saveSessions(this.sessionsCache)
  }

  renameSession(sessionId: string, newTitle: string): void {
    if (this.sessionsCache[sessionId]) {
      this.sessionsCache[sessionId].title = newTitle
      this.sessionsCache[sessionId].updatedAt = Date.now()
      this.dirtySessions.add(sessionId)
      this.flush(sessionId)
    }
  }

  rollbackToMessage(sessionId: string, backendMessageId: string): number {
    const session = this.sessionsCache[sessionId]
    if (!session) return 0

    const idx = session.messages.findIndex((m) => m.backendMessageId === backendMessageId)
    if (idx === -1) return 0

    const removedCount = session.messages.length - idx
    session.messages = session.messages.slice(0, idx)
    this.dirtySessions.add(sessionId)
    // Rollback is user-driven and low-frequency; persist immediately.
    this.flush(sessionId)
    return removedCount
  }

  toReadableMarkdown(messages: ChatMessage[], title: string): string {
    const lines: string[] = []
    lines.push(`# ${title || 'Conversation'}`)
    lines.push('')
    lines.push(`Exported at: ${new Date().toISOString()}`)
    lines.push('')

    let visibleCount = 0

    for (const msg of messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue

      const body = msg.role === 'user'
        ? this.normalizeText(msg.content)
        : this.extractAssistantRichContent(msg)

      if (!body) continue

      visibleCount += 1
      lines.push(`## ${visibleCount}. ${msg.role === 'user' ? 'User' : 'Assistant'}`)
      lines.push('')
      lines.push(body)
      lines.push('')
    }

    if (visibleCount === 0) {
      lines.push('No user/assistant content found in frontend UI history.')
      lines.push('')
    }

    return lines.join('\n')
  }

  private extractAssistantRichContent(msg: ChatMessage): string {
    const chunks: string[] = []

    switch (msg.type) {
      case 'text': {
        const text = this.normalizeText(msg.content)
        if (text) chunks.push(text)
        break
      }
      case 'command': {
        const commandText = this.normalizeText(msg.content || msg.metadata?.command || '')
        const outputText = this.normalizeText(msg.metadata?.output || '')
        if (commandText) {
          chunks.push('Command:')
          chunks.push('```bash')
          chunks.push(commandText)
          chunks.push('```')
        }
        if (outputText) {
          chunks.push('Output:')
          chunks.push('```text')
          chunks.push(outputText)
          chunks.push('```')
        }
        break
      }
      case 'tool_call': {
        const inputText = this.normalizeText(msg.content || '')
        const outputText = this.normalizeText(msg.metadata?.output || '')
        const toolName = this.normalizeText(msg.metadata?.toolName || 'Tool Call')
        chunks.push(`Tool: ${toolName}`)
        if (inputText) {
          chunks.push('Input:')
          chunks.push('```text')
          chunks.push(inputText)
          chunks.push('```')
        }
        if (outputText) {
          chunks.push('Output:')
          chunks.push('```text')
          chunks.push(outputText)
          chunks.push('```')
        }
        break
      }
      case 'file_edit': {
        const filePath = this.normalizeText(msg.metadata?.filePath || '')
        const outputText = this.normalizeText(msg.metadata?.output || msg.content || '')
        const diffText = this.normalizeText(msg.metadata?.diff || '')
        const action = this.normalizeText(msg.metadata?.action || 'edited')
        chunks.push(`File Edit (${action})${filePath ? `: ${filePath}` : ''}`)
        if (outputText) {
          chunks.push('Result:')
          chunks.push('```text')
          chunks.push(outputText)
          chunks.push('```')
        }
        if (diffText) {
          chunks.push('Diff:')
          chunks.push('```diff')
          chunks.push(diffText)
          chunks.push('```')
        }
        break
      }
      case 'sub_tool': {
        const title = this.normalizeText(msg.metadata?.subToolTitle || 'Sub Tool')
        const outputText = this.normalizeText(msg.metadata?.output || msg.content || '')
        chunks.push(`Sub Tool: ${title}`)
        if (outputText) {
          chunks.push('```text')
          chunks.push(outputText)
          chunks.push('```')
        }
        break
      }
      default: {
        const text = this.normalizeText(msg.content)
        if (text) chunks.push(text)
      }
    }

    return this.normalizeText(chunks.join('\n\n'))
  }

  private normalizeText(input: string): string {
    return String(input || '')
      .replace(/\r\n?/g, '\n')
      .trim()
  }
}
