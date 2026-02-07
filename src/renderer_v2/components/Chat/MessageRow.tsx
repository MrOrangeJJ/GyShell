import React from 'react'
import { observer } from 'mobx-react-lite'
import { CornerUpLeft } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { AppStore } from '../../stores/AppStore'
import type { ChatMessage } from '../../stores/ChatStore'
import { renderMentionContent } from '../../lib/MentionParser'
import { CommandBanner, ToolCallBanner, FileEditBanner, SubToolBanner, AskBanner, AlertBanner } from './ChatBanner'

interface MessageRowProps {
  store: AppStore
  sessionId: string
  messageId: string
  onAskDecision: (messageId: string, decision: 'allow' | 'deny') => void
  onRollback: (msg: ChatMessage) => void
  askLabels: { allow: string; deny: string; allowed: string; denied: string }
  isThinking: boolean
}

export const MessageRow: React.FC<MessageRowProps> = observer(({ 
  store,
  sessionId, 
  messageId, 
  onAskDecision, 
  onRollback,
  askLabels,
  isThinking 
}) => {
  const session = store.chat.sessions.find(s => s.id === sessionId)
  if (!session) return null
  
  const msg = session.messagesById.get(messageId)
  if (!msg) return null

  // Logic: If this is an 'alert' (retry hint), only show it if it's the absolute last message in the session
  // We check messageIds to see if this ID is the very last one.
  const isLastMessage = session.messageIds[session.messageIds.length - 1] === messageId
  const isRetryHint = msg.type === 'alert' && msg.metadata?.subToolLevel === 'info'
  
  if (isRetryHint && !isLastMessage) {
    return null
  }

  // Handle special message types
  if (msg.type === 'tokens_count') {
    return null
  }
  if (msg.type === 'command') {
    return (
      <div className="message-row-container role-assistant">
        <CommandBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'tool_call') {
    return (
      <div className="message-row-container role-assistant">
        <ToolCallBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'file_edit') {
    return (
      <div className="message-row-container role-assistant">
        <FileEditBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'sub_tool') {
    return (
      <div className="message-row-container role-assistant">
        <SubToolBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'ask') {
    return (
      <div className="message-row-container role-assistant">
        <AskBanner 
          msg={msg} 
          onDecision={(messageId, decision) => onAskDecision(messageId, decision)} 
          labels={askLabels} 
        />
      </div>
    )
  }
  if (msg.type === 'alert' || msg.type === 'error') {
    return (
      <div className="message-row-container role-assistant">
        <AlertBanner 
          msg={msg} 
          onRemove={() => store.chat.removeMessage(msg.id, sessionId)}
        />
      </div>
    )
  }

  // Regular text messages
  const isUser = msg.role === 'user'
  const canRollback = isUser && !!msg.backendMessageId && !msg.streaming && !isThinking

  if (isUser) {
    return (
      <div className="message-row-container role-user">
        <div className="message-role-label user">USER</div>
        <div className="message-user-row">
          <div className={`message-text ${msg.role}`}>
            <div className="plain-text">
              {renderMentionContent(msg.content)}
              {msg.streaming && <span className="cursor-blink" />}
            </div>
          </div>
          <button
            className="message-rollback-btn"
            title="Rollback and re-edit"
            onClick={() => onRollback(msg)}
            disabled={!canRollback}
          >
            <CornerUpLeft size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="message-row-container role-assistant">
      <div className="message-role-label assistant">ASSISTANT</div>
      <div className={`message-text ${msg.role}`}>
        <div className={msg.role === 'assistant' ? "markdown-body" : "plain-text"}>
          {msg.role === 'assistant' ? (
            <ReactMarkdown
              components={{
                a: ({ node, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                )
              }}
            >
              {msg.content}
            </ReactMarkdown>
          ) : (
            msg.content
          )}
          {msg.streaming && <span className="cursor-blink" />}
        </div>
      </div>
    </div>
  )
})
