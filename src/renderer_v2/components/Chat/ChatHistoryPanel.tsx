import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { Clock, Trash2, X, History, CheckSquare, Square } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { ConfirmDialog } from '../Common/ConfirmDialog'
import './chatHistory.scss'

interface StoredChatSession {
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

interface ChatHistoryPanelProps {
  store: AppStore
  onClose: () => void
}

export const ChatHistoryPanel: React.FC<ChatHistoryPanelProps> = observer(({ store, onClose }) => {
  const [history, setHistory] = useState<StoredChatSession[]>([])
  const [loading, setLoading] = useState(true)
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)
  
  // Selection box state
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState<{ x: number, y: number } | null>(null)
  const [dragEnd, setDragEnd] = useState<{ x: number, y: number } | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  const t = store.i18n.t

  useEffect(() => {
    loadHistory()
  }, [])

  // Handle selection box logic
  useEffect(() => {
    if (!isDragging || !dragStart || !dragEnd || !listRef.current) return

    const rect = listRef.current.getBoundingClientRect()
    const selectionRect = {
      left: Math.min(dragStart.x, dragEnd.x),
      top: Math.min(dragStart.y, dragEnd.y),
      right: Math.max(dragStart.x, dragEnd.x),
      bottom: Math.max(dragStart.y, dragEnd.y)
    }

    const items = listRef.current.querySelectorAll('.chat-history-item')
    const newSelected = new Set<string>()
    
    items.forEach((item, index) => {
      const itemRect = item.getBoundingClientRect()
      const isOverlapping = !(
        itemRect.right < selectionRect.left ||
        itemRect.left > selectionRect.right ||
        itemRect.bottom < selectionRect.top ||
        itemRect.top > selectionRect.bottom
      )

      if (isOverlapping) {
        const id = history[index]?.id
        if (id) newSelected.add(id)
      }
    })

    setSelectedIds(newSelected)
  }, [dragEnd, isDragging])

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isSelectionMode || (e.target as HTMLElement).closest('.chat-history-item-delete') || (e.target as HTMLElement).closest('.chat-history-select-all')) return
    
    // If clicking on an item, let handleItemClick handle it
    const item = (e.target as HTMLElement).closest('.chat-history-item')
    if (item) {
      // If holding shift/cmd, don't start drag selection
      if (e.shiftKey || e.metaKey || e.ctrlKey) return
      
      // If clicking directly on an item without modifiers, we might want to start a drag
      // but let's only start drag if we move the mouse a bit, or start from whitespace.
      // For simplicity, let's allow drag from anywhere in selection mode.
    }

    setIsDragging(true)
    setDragStart({ x: e.clientX, y: e.clientY })
    setDragEnd({ x: e.clientX, y: e.clientY })
    
    // Do NOT clear selection here, allow additive selection if needed later
    // or clear only if not clicking an item
    if (!item && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      setSelectedIds(new Set())
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    setDragEnd({ x: e.clientX, y: e.clientY })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
    setDragStart(null)
    setDragEnd(null)
  }

  const loadHistory = async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const historyData = await store.chat.getAllChatHistory()
      setHistory(historyData)
    } catch (error) {
      console.error('Failed to load chat history:', error)
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  const handleItemClick = (e: React.MouseEvent, index: number) => {
    const session = history[index]
    if (!session) return

    if (!isSelectionMode) {
      handleLoadSession(session.id)
      return
    }

    const id = session.id
    const newSelected = new Set(selectedIds)

    if (e.shiftKey && lastSelectedIndex !== null) {
      // Range selection
      const start = Math.min(lastSelectedIndex, index)
      const end = Math.max(lastSelectedIndex, index)
      for (let i = start; i <= end; i++) {
        newSelected.add(history[i].id)
      }
    } else if (e.metaKey || e.ctrlKey) {
      // Toggle selection
      if (newSelected.has(id)) newSelected.delete(id)
      else newSelected.add(id)
    } else {
      // Single selection
      newSelected.clear()
      newSelected.add(id)
    }

    setSelectedIds(newSelected)
    setLastSelectedIndex(index)
  }

  const handleLoadSession = async (sessionId: string) => {
    try {
      await store.chat.loadChatHistory(sessionId)
      onClose()
    } catch (error) {
      console.error('Failed to load session:', error)
    }
  }

  const handleDeleteSession = async (sessionId: string) => {
    try {
      // Optimistic update
      setHistory(prev => prev.filter(s => s.id !== sessionId))
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
      
      // If the session being deleted is the currently active one in the background,
      // we need to handle that carefully. But the user just wants to stay in the history panel.
      await store.chat.deleteChatSession(sessionId)
      
      // Final sync without loading state to avoid flicker
      await loadHistory(false)
    } catch (error) {
      console.error('Failed to delete session:', error)
      // Rollback on error
      await loadHistory(true)
    } finally {
      setConfirmDeleteId(null)
    }
  }

  const handleBulkDelete = async () => {
    const idsToDelete = Array.from(selectedIds)
    try {
      // Optimistic update
      setHistory(prev => prev.filter(s => !selectedIds.has(s.id)))
      setSelectedIds(new Set())
      
      await Promise.all(idsToDelete.map(id => store.chat.deleteChatSession(id)))
      // Final sync without loading state
      await loadHistory(false)
    } catch (error) {
      console.error('Failed to perform bulk delete:', error)
      // Rollback on error
      await loadHistory(true)
    } finally {
      setShowBulkDeleteConfirm(false)
    }
  }

  const toggleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault() // Prevent triggering underlying mousedown/drag logic
    if (selectedIds.size === history.length && history.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(history.map(s => s.id)))
    }
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  return createPortal(
    <div
      className="chat-history-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <ConfirmDialog
        open={!!confirmDeleteId}
        title={t.chat.history.confirmDeleteTitle}
        message={t.chat.history.confirmDeleteSingle}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onConfirm={() => confirmDeleteId && handleDeleteSession(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />

      <ConfirmDialog
        open={showBulkDeleteConfirm}
        title={t.chat.history.confirmDeleteTitle}
        message={t.chat.history.confirmDeleteMessage}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onConfirm={handleBulkDelete}
        onCancel={() => setShowBulkDeleteConfirm(false)}
      />

      <div 
        className={`chat-history-panel ${isSelectionMode ? 'selection-mode' : ''}`} 
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {isDragging && dragStart && dragEnd && (
          <div 
            className="selection-box"
            style={{
              left: Math.min(dragStart.x, dragEnd.x),
              top: Math.min(dragStart.y, dragEnd.y),
              width: Math.abs(dragStart.x - dragEnd.x),
              height: Math.abs(dragStart.y - dragEnd.y)
            }}
          />
        )}

        <div className="chat-history-header">
          <div className="chat-history-title">
            <History size={18} />
            <span>{t.chat.history.title}</span>
          </div>

          {!loading && history.length > 0 && (
            <div className="chat-history-actions">
              <div 
                className={`chat-history-mode-toggle ${isSelectionMode ? 'active' : ''}`}
                onClick={() => {
                  setIsSelectionMode(!isSelectionMode)
                  if (isSelectionMode) setSelectedIds(new Set())
                }}
              >
                <span>Select Mode</span>
              </div>

              {isSelectionMode && (
                <>
                  <div className="chat-history-select-all" onClick={toggleSelectAll}>
                    {selectedIds.size === history.length && history.length > 0 ? (
                      <CheckSquare size={14} />
                    ) : (
                      <Square size={14} />
                    )}
                    <span>{t.chat.history.selectAll}</span>
                  </div>
                  <button
                    className="chat-history-bulk-delete"
                    disabled={selectedIds.size === 0}
                    onClick={() => setShowBulkDeleteConfirm(true)}
                  >
                    <Trash2 size={14} />
                    <span>{t.chat.history.deleteSelected} ({selectedIds.size})</span>
                  </button>
                </>
              )}
            </div>
          )}

          <button className="chat-history-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="chat-history-content" ref={listRef}>
          {loading ? (
            <div className="chat-history-loading">{t.chat.history.loading}</div>
          ) : history.length === 0 ? (
            <div className="chat-history-empty">
              <History size={48} />
              <p>{t.chat.history.empty}</p>
            </div>
          ) : (
            <div className="chat-history-list">
              {history.map((session, index) => (
                <div
                  key={session.id}
                  className={`chat-history-item ${selectedIds.has(session.id) ? 'selected' : ''}`}
                  onClick={(e) => handleItemClick(e, index)}
                >
                  <div className="chat-history-item-main">
                    <div className="chat-history-item-title">{session.title}</div>
                    <div className="chat-history-item-meta">
                      <Clock size={12} />
                      <span>{formatDate(session.updatedAt)}</span>
                      <span className="chat-history-item-messages">
                        {session.messages.length} {t.chat.history.messages}
                      </span>
                    </div>
                  </div>
                  <button
                    className="chat-history-item-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDeleteId(session.id)
                    }}
                    title={t.chat.history.deleteSession}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
})
