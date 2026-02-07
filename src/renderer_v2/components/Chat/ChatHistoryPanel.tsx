import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { Clock, Trash2, X, History, CheckSquare, Square, Edit2, Check, X as Close } from 'lucide-react'
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
  const [isDeletingSingle, setIsDeletingSingle] = useState(false)
  const [isDeletingBulk, setIsDeletingBulk] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  const t = store.i18n.t

  useEffect(() => {
    loadHistory()
  }, [])

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
    if (!session || editingId === session.id) return

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
    if (editingId) return
    try {
      await store.chat.loadChatHistory(sessionId)
      onClose()
    } catch (error) {
      console.error('Failed to load session:', error)
    }
  }

  const handleStartRename = (e: React.MouseEvent, session: StoredChatSession) => {
    e.stopPropagation()
    setEditingId(session.id)
    setEditingTitle(session.title)
  }

  const handleConfirmRename = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    if (!editingId) return
    const newTitle = editingTitle.trim()
    if (!newTitle) {
      setEditingId(null)
      return
    }

    try {
      // Optimistic update
      setHistory(prev => prev.map(s => s.id === editingId ? { ...s, title: newTitle } : s))
      await store.chat.renameChatSession(editingId, newTitle)
    } catch (error) {
      console.error('Failed to rename session:', error)
      await loadHistory(false)
    } finally {
      setEditingId(null)
    }
  }

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(null)
  }

  const handleDeleteSession = async (sessionId: string) => {
    if (isDeletingSingle) return
    setIsDeletingSingle(true)
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
      setIsDeletingSingle(false)
      setConfirmDeleteId(null)
    }
  }

  const handleBulkDelete = async () => {
    if (isDeletingBulk) return
    const idsToDelete = Array.from(selectedIds)
    if (idsToDelete.length === 0) return
    setIsDeletingBulk(true)
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
      setIsDeletingBulk(false)
      setShowBulkDeleteConfirm(false)
    }
  }

  const toggleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
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
        loading={isDeletingSingle}
        onConfirm={() => confirmDeleteId && handleDeleteSession(confirmDeleteId)}
        onCancel={() => {
          if (isDeletingSingle) return
          setConfirmDeleteId(null)
        }}
      />

      <ConfirmDialog
        open={showBulkDeleteConfirm}
        title={t.chat.history.confirmDeleteTitle}
        message={t.chat.history.confirmDeleteMessage}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        loading={isDeletingBulk}
        onConfirm={handleBulkDelete}
        onCancel={() => {
          if (isDeletingBulk) return
          setShowBulkDeleteConfirm(false)
        }}
      />

      <div className="chat-history-panel" onClick={(e) => e.stopPropagation()}>
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

        <div className="chat-history-content">
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
                    {editingId === session.id ? (
                      <div className="chat-history-item-edit-wrapper" onClick={e => e.stopPropagation()}>
                        <input
                          autoFocus
                          className="chat-history-item-edit-input"
                          value={editingTitle}
                          onChange={e => setEditingTitle(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleConfirmRename(e)
                            if (e.key === 'Escape') handleCancelRename(e as any)
                          }}
                        />
                        <div className="chat-history-item-edit-actions">
                          <button className="confirm" onClick={handleConfirmRename}>
                            <Check size={14} />
                          </button>
                          <button className="cancel" onClick={handleCancelRename}>
                            <Close size={14} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="chat-history-item-title">{session.title}</div>
                    )}
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
                  {!isSelectionMode && editingId !== session.id && (
                    <button
                      className="chat-history-item-rename"
                      onClick={(e) => handleStartRename(e, session)}
                      title={t.chat.history.renameSession}
                    >
                      <Edit2 size={14} />
                    </button>
                  )}
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
