import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import type { ChatMessage } from '../../stores/ChatStore'
import { MessageRow } from './MessageRow'

interface ThinkingGroupProps {
  store: AppStore
  sessionId: string
  messageIds: string[]
  isFinished: boolean
  onAskDecision: (msg: ChatMessage, decision: 'allow' | 'deny') => void
  onRollback: (msg: ChatMessage) => void
  askLabels: { allow: string; deny: string; allowed: string; denied: string }
  isThinking: boolean
}

export const ThinkingGroup: React.FC<ThinkingGroupProps> = ({
  store,
  sessionId,
  messageIds,
  isFinished,
  onAskDecision,
  onRollback,
  askLabels,
  isThinking
}) => {
  const [isCollapsed, setIsCollapsed] = React.useState(isFinished)

  React.useEffect(() => {
    if (isFinished) {
      setIsCollapsed(true)
    } else {
      setIsCollapsed(false)
    }
  }, [isFinished])

  if (!messageIds.length) return null

  if (!isFinished) {
    return (
      <div className="thinking-group">
        {messageIds.map((messageId) => (
          <MessageRow
            key={messageId}
            store={store}
            sessionId={sessionId}
            messageId={messageId}
            onAskDecision={onAskDecision}
            onRollback={onRollback}
            askLabels={askLabels}
            isThinking={isThinking}
          />
        ))}
      </div>
    )
  }

  return (
    <div className={`thinking-group ${isCollapsed ? 'is-collapsed' : ''}`}>
      <button
        className="thinking-summary render-mode-sub"
        onClick={() => setIsCollapsed((prev) => !prev)}
        type="button"
      >
        <span className="thinking-summary-icon">
          {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        <span className="thinking-summary-title">THOUGHT</span>
        <span className="thinking-summary-count">{messageIds.length} STEPS</span>
      </button>
      {!isCollapsed && (
        <div className="thinking-content">
          {messageIds.map((messageId) => (
            <MessageRow
              key={messageId}
              store={store}
              sessionId={sessionId}
              messageId={messageId}
              onAskDecision={onAskDecision}
              onRollback={onRollback}
              askLabels={askLabels}
              isThinking={isThinking}
            />
          ))}
        </div>
      )}
    </div>
  )
}
