import React, { useEffect, useRef, useState, useLayoutEffect, useCallback } from 'react'
import { Square, Plus, X, History, Bot, CornerDownLeft, Play } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import type { ChatMessage } from '../../stores/ChatStore'
import { ChatHistoryPanel } from './ChatHistoryPanel'
import { MessageRow } from './MessageRow'
import { ConfirmDialog } from '../Common/ConfirmDialog'
import { Select } from '../../platform/Select'
import type { SelectHandle } from '../../platform/windows/WindowsSelect'
import { QueueManager } from './Queue/QueueManager'
import { QueueModeSwitch } from './Queue/QueueModeSwitch'
import type { QueueItem } from '../../stores/ChatQueueStore'
import { RichInput, type RichInputHandle } from './RichInput'
import './chat.scss'

import { createPortal } from 'react-dom'

const TokenTooltip: React.FC<{ 
  mouseX: number;
  mouseY: number;
  content: string; 
}> = ({ mouseX, mouseY, content }) => {
  const tooltipRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!el) return

    // 1. Get actual dimensions of the element
    const measured = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 24 // Keep 24px distance from the window edge
    const gap = 12   // 12px distance from the mouse cursor

    let x = mouseX
    let y = mouseY - gap

    // 2. Horizontal boundary avoidance
    const halfWidth = measured.width / 2
    if (x - halfWidth < margin) {
      x = margin + halfWidth
    } else if (x + halfWidth > vw - margin) {
      x = vw - margin - halfWidth
    }

    // 3. Vertical boundary avoidance and flipping
    let verticalTranslate = '-100%' // Default above the mouse
    if (y - measured.height < margin) {
      y = mouseY + gap // Insufficient space, flip to bottom
      verticalTranslate = '0'
      if (y + measured.height > vh - margin) {
        y = vh - margin - measured.height
      }
    }

    // 4. Update DOM directly synchronously, bypassing React state update cycle to eliminate flickering
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.transform = `translate(-50%, ${verticalTranslate})`
    el.style.opacity = '1'
  }, [mouseX, mouseY, content])

  return createPortal(
    <div 
      ref={tooltipRef} 
      className="token-tooltip" 
      style={{ 
        position: 'fixed',
        left: mouseX,
        top: mouseY,
        opacity: 0, // Initially transparent, waiting for calculation to complete
        pointerEvents: 'none',
        zIndex: 10000
      }}
    >
      {content}
    </div>,
    document.body
  )
}

// MessageRow replaces MessageItem for fine-grained reactivity

export const ChatPanel: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const richInputRef = useRef<RichInputHandle>(null)
  const profileSelectRef = useRef<SelectHandle>(null)
  const [inputEmpty, setInputEmpty] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const [rollbackTarget, setRollbackTarget] = useState<ChatMessage | null>(null)
  const [queueEditTarget, setQueueEditTarget] = useState<QueueItem | null>(null)
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null)
  const t = store.i18n.t
  const contextMenuIdRef = useRef<string>('chat-panel')
  
  // Get active session
  const activeSession = store.chat.activeSession
  const messageIds = activeSession?.messageIds || []
  const isThinking = activeSession?.isThinking || false
  const activeSessionId = store.chat.activeSessionId
  const isQueueMode = activeSessionId ? store.chat.queue.isQueueMode(activeSessionId) : false
  const queueItems = activeSessionId ? store.chat.queue.getQueue(activeSessionId) : []
  const isQueueRunning = activeSessionId ? store.chat.queue.isRunning(activeSessionId) : false
  const queueLocked = isThinking || isQueueRunning
  const canQueueRun = isQueueMode && !isQueueRunning && queueItems.length > 0
  const primaryDisabled = isQueueMode ? (inputEmpty && !canQueueRun) : inputEmpty
  const latestTokens = store.chat.activeSessionLatestTokens
  const latestMaxTokens = store.chat.activeSessionLatestMaxTokens
  const askLabels = {
    allow: t.common.allow,
    deny: t.common.deny,
    allowed: t.common.allowed,
    denied: t.common.denied
  }

  const renderItems = (() => {
    if (!activeSession) return []
    const items: Array<{ kind: 'message'; id: string }> = []

    messageIds.forEach((msgId) => {
      const msg = activeSession.messagesById.get(msgId)
      if (!msg) return
      if (msg.type === 'tokens_count') return
      items.push({ kind: 'message', id: msgId })
    })

    return items
  })()

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
      // If within 50px of bottom, enable auto-scroll
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
      setShouldAutoScroll(isAtBottom)
    }
  }

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current && activeSession) {
      const lastMsgId = messageIds[messageIds.length - 1]
      const lastMsg = lastMsgId ? activeSession.messagesById.get(lastMsgId) : null
      const isNewUserMsg = lastMsg?.role === 'user'
      
      if (isNewUserMsg || shouldAutoScroll) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        if (isNewUserMsg) setShouldAutoScroll(true)
      }
    }
  }, [messageIds.length, activeSession])

  // Auto-resize input - removed as RichInput handles its own size via contentEditable

  const handleSendNormal = (val: string) => {
    if (!val.trim() || isThinking) return
    const sessionId = store.chat.activeSessionId || store.chat.createSession()
    store.sendChatMessage(sessionId, val)
    richInputRef.current?.clear()
    setInputEmpty(true)
  }

  const handleQueueAdd = (val: string) => {
    if (!val.trim()) return
    const sessionId = store.chat.activeSessionId || store.chat.createSession()
    store.chat.addQueueItem(sessionId, val)
    richInputRef.current?.clear()
    setInputEmpty(true)
  }

  const handleQueueRun = () => {
    const sessionId = store.chat.activeSessionId || store.chat.createSession()
    store.chat.startQueue(sessionId)
  }

  const handlePrimaryAction = () => {
    if (isThinking) return
    const val = richInputRef.current?.getValue() || ''
    if (isQueueMode) {
      if (val.trim()) {
        handleQueueAdd(val)
      } else if (queueItems.length > 0 && !isQueueRunning) {
        handleQueueRun()
      }
      return
    }
    handleSendNormal(val)
  }

  // --- Drag & Drop Layout Logic ---
  const dragTimerRef = useRef<NodeJS.Timeout | null>(null)
  
  const handleTabMouseDown = useCallback((e: React.MouseEvent) => {
    // Only allow dragging from the tab area background, not buttons
    if ((e.target as HTMLElement).closest('button')) return
    
    const startX = e.clientX
    
    dragTimerRef.current = setTimeout(() => {
      store.layout.setDragging(true)
      store.layout.setDragX(startX)
    }, 300) // 300ms long press

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (store.layout.isDragging) {
        store.layout.setDragX(moveEvent.clientX)
        
        // Determine drop indicator
        const vw = window.innerWidth
        const threshold = vw * 0.2 // 20% from edge
        if (moveEvent.clientX < threshold) {
          store.layout.setDropIndicator('left')
        } else if (moveEvent.clientX > vw - threshold) {
          store.layout.setDropIndicator('right')
        } else {
          store.layout.setDropIndicator(null)
        }
      }
    }

    const handleMouseUp = () => {
      if (dragTimerRef.current) {
        clearTimeout(dragTimerRef.current)
        dragTimerRef.current = null
      }
      
      if (store.layout.isDragging) {
        const indicator = store.layout.dropIndicator
        const currentPos = store.layout.panelOrder.indexOf('chat')
        
        if ((indicator === 'left' && currentPos !== 0) || 
            (indicator === 'right' && currentPos !== store.layout.panelOrder.length - 1)) {
          store.layout.swapPanels()
        }
        
        store.layout.setDragging(false)
      }
      
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [store.layout])

  const profiles = store.settings?.models.profiles || []
  const activeProfileId = store.settings?.models.activeProfileId

  const handleAskDecision = async (messageId: string, decision: 'allow' | 'deny') => {
    const sessionId = activeSession?.id
    if (!sessionId) return
    
    const msg = activeSession.messagesById.get(messageId)
    if (msg?.backendMessageId) {
      // 1. Immediately remove from UI for instant feedback
      store.chat.removeMessage(messageId, sessionId)
      // 2. Send decision using backendMessageId
      console.log(`[ChatPanel] Sending decision ${decision} for feedbackId=${msg.backendMessageId}`);
      await window.gyshell.agent.replyMessage(msg.backendMessageId, { decision })
    }
  }

  const handleRollbackConfirm = async () => {
    if (!rollbackTarget || !activeSession?.id) return
    const backendMessageId = rollbackTarget.backendMessageId
    if (!backendMessageId) return
    try {
      await window.gyshell.agent.rollbackToMessage(activeSession.id, backendMessageId)
      store.chat.rollbackToMessage(activeSession.id, backendMessageId)
      richInputRef.current?.setValue(rollbackTarget.content || '')
      setInputEmpty(false)
    } catch (error) {
      console.error('Failed to rollback message:', error)
    } finally {
      setRollbackTarget(null)
    }
  }

  const handleQueueEditRequest = (item: QueueItem) => {
    const currentVal = richInputRef.current?.getValue() || ''
    if (currentVal.trim()) {
      setQueueEditTarget(item)
      return
    }
    if (!activeSessionId) return
    store.chat.removeQueueItem(activeSessionId, item.id)
    richInputRef.current?.setValue(item.content)
    setInputEmpty(false)
  }

  const handleQueueEditConfirm = () => {
    if (!queueEditTarget || !activeSessionId) return
    store.chat.removeQueueItem(activeSessionId, queueEditTarget.id)
    richInputRef.current?.setValue(queueEditTarget.content)
    setInputEmpty(false)
    setQueueEditTarget(null)
  }

  useEffect(() => {
    const panelEl = panelRef.current
    if (!panelEl) return

    const getSelectionText = () => {
      // In rich input mode, we just use window selection
      return window.getSelection()?.toString() || ''
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const selectionText = getSelectionText()
      window.gyshell.ui.showContextMenu({
        id: contextMenuIdRef.current,
        canCopy: selectionText.trim().length > 0,
        canPaste: true
      })
    }

    const onContextMenuAction = (data: { id: string; action: 'copy' | 'paste' }) => {
      if (data.id !== contextMenuIdRef.current) return
      if (data.action === 'copy') {
        const selectionText = getSelectionText()
        if (selectionText) {
          navigator.clipboard.writeText(selectionText).catch(() => {
            // ignore
          })
        }
        return
      }
      if (data.action === 'paste') {
         navigator.clipboard.readText().then((text) => {
           if (text) {
             // We don't have an easy way to insert into RichInput from here
             // but RichInput handles Ctrl+V itself. This is for context menu.
             // For now, we just append or ignore if not focused.
           }
         }).catch(() => {
           // ignore
         })
      }
    }

    panelEl.addEventListener('contextmenu', handleContextMenu)
    const removeContextMenuListener = window.gyshell.ui.onContextMenuAction(onContextMenuAction)
    return () => {
      panelEl.removeEventListener('contextmenu', handleContextMenu)
      removeContextMenuListener()
    }
  }, [])

  return (
    <div 
      className={`panel panel-chat${store.layout.isDragging ? ' is-dragging-source' : ''}`} 
      ref={panelRef}
    >
      <div className="panel-header-minimal" onMouseDown={handleTabMouseDown}>
        <div className="chat-tabs">
            {store.chat.sessions.map(s => (
                <div 
                    key={s.id} 
                    className={`chat-tab ${s.id === store.chat.activeSessionId ? 'active' : ''}`}
                    onClick={() => store.chat.setActiveSession(s.id)}
                >
                    <span className="chat-tab-title">{s.title}</span>
                    <button 
                        className="chat-tab-close"
                        onClick={(e) => {
                            e.stopPropagation()
                            store.chat.closeSession(s.id)
                        }}
                    >
                        <X size={12} />
                    </button>
                </div>
            ))}
        </div>
        <button className="chat-tab-add" onClick={() => store.chat.createSession()}>
            <Plus size={14} />
        </button>
        <button className="chat-tab-history" onClick={() => setShowHistory(true)}>
            <History size={14} />
        </button>
      </div>
      
      {showHistory && <ChatHistoryPanel store={store} onClose={() => setShowHistory(false)} />}

      <ConfirmDialog
        open={!!rollbackTarget}
        title={t.chat.rollback.title}
        message={t.chat.rollback.message}
        confirmText={t.chat.rollback.confirm}
        cancelText={t.chat.rollback.cancel}
        danger
        onCancel={() => setRollbackTarget(null)}
        onConfirm={handleRollbackConfirm}
      />
      <ConfirmDialog
        open={!!queueEditTarget}
        title={t.chat.queue.editConfirmTitle}
        message={t.chat.queue.editConfirmMessage}
        confirmText={t.chat.queue.editConfirm}
        cancelText={t.chat.queue.editCancel}
        onCancel={() => setQueueEditTarget(null)}
        onConfirm={handleQueueEditConfirm}
      />
      
      <div className="panel-body" ref={scrollRef} onScroll={handleScroll}>
        <div className="message-list">
          {renderItems.map((item) => {
            if (!activeSessionId) return null
            return (
              <MessageRow
                key={item.id}
                store={store}
                sessionId={activeSessionId}
                messageId={item.id}
                onAskDecision={handleAskDecision}
                onRollback={(m) => setRollbackTarget(m)}
                askLabels={askLabels}
                isThinking={isThinking}
              />
            )
          })}
          {messageIds.length === 0 && (
            <div className="placeholder">
              {t.chat.placeholder}
            </div>
          )}
        </div>
      </div>

      <div className="chat-input-area">
        {isQueueMode && activeSessionId && queueItems.length > 0 && (
          <div className="queue-area">
            <QueueManager
              items={queueItems}
              isRunning={isQueueRunning}
              onReorder={(fromIndex, toIndex) => store.chat.moveQueueItem(activeSessionId, fromIndex, toIndex)}
              onEdit={handleQueueEditRequest}
              editLabel={t.common.edit}
            />
          </div>
        )}
        <div className="input-container">
            <RichInput
              ref={richInputRef}
              store={store}
              placeholder={t.chat.placeholder}
              onSend={isQueueMode ? handleQueueAdd : handleSendNormal}
              disabled={isThinking}
            />
            
            <div className="input-footer">
                <div className="input-left-tools">
                  <div 
                    className="chat-profile-selector" 
                    onClick={() => profileSelectRef.current?.toggle()}
                  >
                      <Bot size={14} className="profile-icon"/>
                      <Select
                        ref={profileSelectRef}
                        className="profile-dropdown"
                        value={activeProfileId || ''}
                        options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                        onChange={(id) => store.setActiveProfile(id)}
                        // Keep the mac-style "text-only" look for this compact selector
                        hideArrow
                      />
                  </div>
                </div>
                <div className="input-actions">
                    <QueueModeSwitch
                      enabled={isQueueMode}
                      disabled={queueLocked}
                      onToggle={() => {
                        if (activeSessionId) {
                          store.chat.queue.setQueueMode(!isQueueMode, activeSessionId)
                        }
                      }}
                      labelOn={t.chat.queue.modeQueue}
                      labelOff={t.chat.queue.modeNormal}
                    />
                    <button 
                        className="icon-btn-sm secondary" 
                        disabled={isThinking}
                        onClick={async () => {
                            if (store.chat.activeSessionId) {
                                try {
                                    // Export is now fully backed by backend UI history storage
                                    await window.gyshell.agent.exportHistory(store.chat.activeSessionId);
                                    // Optionally show a success notification here
                                } catch (error) {
                                    console.error('Failed to export history:', error);
                                    // Optionally show an error notification here
                                }
                            }
                        }}
                        title="Export conversation history"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                    </button>
                    {isThinking ? (
                        <button className="icon-btn-sm danger" onClick={() => {
                            if (store.chat.activeSessionId) {
                                store.chat.stopQueue(store.chat.activeSessionId)
                                window.gyshell.agent.stopTask(store.chat.activeSessionId)
                                // Optimistically stop thinking in UI
                                store.chat.setThinking(false, store.chat.activeSessionId!)
                            }
                        }}>
                        <Square size={16} fill="currentColor" />
                        </button>
                    ) : (
                        <button className="icon-btn-sm primary" onClick={handlePrimaryAction} disabled={primaryDisabled}>
                        {isQueueMode ? (
                          <Play size={16} strokeWidth={2} />
                        ) : (
                          <CornerDownLeft size={16} strokeWidth={2} />
                        )}
                        </button>
                    )}
                </div>
            </div>

            {latestTokens > 0 && latestMaxTokens > 0 && (
              <div 
                className="token-progress-bar"
                onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setMousePos(null)}
              >
                <div 
                  className="token-progress-fill" 
                  style={{ width: `${Math.min(100, Math.round((latestTokens / latestMaxTokens) * 100))}%` }}
                />
              </div>
            )}
            {mousePos && (
              <TokenTooltip 
                mouseX={mousePos.x}
                mouseY={mousePos.y}
                content={`${(latestTokens / 1000).toFixed(1)}k / ${(latestMaxTokens / 1000).toFixed(1)}k    ${Math.round((latestTokens / latestMaxTokens) * 100)}%`}
              />
            )}
        </div>
      </div>
    </div>
  )
})
