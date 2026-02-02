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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)
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

  const toggleSelect = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === history.length) {
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
    <div className="chat-history-overlay" onClick={onClose}>
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

      <div className="chat-history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-history-header">
          <div className="chat-history-title">
            <History size={18} />
            <span>{t.chat.history.title}</span>
          </div>

          {!loading && history.length > 0 && (
            <div className="chat-history-actions">
              <div className="chat-history-select-all" onClick={toggleSelectAll}>
                {selectedIds.size === history.length && history.length > 0 ? (
                  <CheckSquare size={16} />
                ) : (
                  <Square size={16} />
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
              {history.map((session) => (
                <div
                  key={session.id}
                  className={`chat-history-item ${selectedIds.has(session.id) ? 'selected' : ''}`}
                  onClick={() => handleLoadSession(session.id)}
                >
                  <div
                    className="chat-history-item-checkbox"
                    onClick={(e) => toggleSelect(e, session.id)}
                  >
                    {selectedIds.has(session.id) ? (
                      <CheckSquare size={16} />
                    ) : (
                      <Square size={16} />
                    )}
                  </div>
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
