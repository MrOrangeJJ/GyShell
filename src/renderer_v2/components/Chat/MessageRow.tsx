import React from 'react'
import { observer } from 'mobx-react-lite'
import { CornerUpLeft } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { AppStore } from '../../stores/AppStore'
import type { ChatMessage } from '../../stores/ChatStore'
import { CommandBanner, ToolCallBanner, FileEditBanner, SubToolBanner, AskBanner, AlertBanner } from './ChatBanner'

interface MessageRowProps {
  store: AppStore
  sessionId: string
  messageId: string
  onAskDecision: (msg: ChatMessage, decision: 'allow' | 'deny') => void
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

  const renderModeClass = msg.renderMode === 'sub' ? 'render-mode-sub' : ''

  // Handle special message types
  if (msg.type === 'tokens_count') {
    return null
  }
  if (msg.type === 'command') {
    return (
      <div className={renderModeClass}>
        <CommandBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'tool_call') {
    return (
      <div className={renderModeClass}>
        <ToolCallBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'file_edit') {
    return (
      <div className={renderModeClass}>
        <FileEditBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'sub_tool') {
    return (
      <div className={renderModeClass}>
        <SubToolBanner msg={msg} />
      </div>
    )
  }
  if (msg.type === 'ask') {
    return (
      <div className={renderModeClass}>
        <AskBanner 
          msg={msg} 
          onDecision={(decision) => onAskDecision(msg, decision)} 
          labels={askLabels} 
        />
      </div>
    )
  }
  if (msg.type === 'alert' || msg.type === 'error') {
    return (
      <div className={renderModeClass}>
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
    // Parser for [MENTION_XXX:#...#] labels
    const renderContent = (content: string) => {
      const parts = content.split(/(\[MENTION_(?:SKILL|TAB|FILE|USER_PASTE):#.+?#(?:#.+?#)?\])/g);
      return parts.map((part, i) => {
        const skillMatch = part.match(/\[MENTION_SKILL:#(.+?)#\]/);
        if (skillMatch) {
          return <span key={i} className="mention-badge skill">@{skillMatch[1]}</span>;
        }
        const terminalMatch = part.match(/\[MENTION_TAB:#(.+?)##(.+?)#\]/);
        if (terminalMatch) {
          return <span key={i} className="mention-badge terminal">@{terminalMatch[1]}</span>;
        }
        const fileMatch = part.match(/\[MENTION_FILE:#(.+?)#\]/);
        if (fileMatch) {
          const fileName = fileMatch[1].split(/[/\\]/).pop() || fileMatch[1];
          return <span key={i} className="mention-badge file">{fileName}</span>;
        }
        const pasteMatch = part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/);
        if (pasteMatch) {
          return <span key={i} className="mention-badge paste">{pasteMatch[2]}</span>;
        }
        return part;
      });
    };

    return (
      <div className={`message-user-row ${renderModeClass}`}>
        <button
          className="message-rollback-btn"
          title="Rollback and re-edit"
          onClick={() => onRollback(msg)}
          disabled={!canRollback}
        >
          <CornerUpLeft size={14} />
        </button>
        <div className={`message-text ${msg.role} ${renderModeClass}`}>
          <div className="plain-text">
            {renderContent(msg.content)}
            {msg.streaming && <span className="cursor-blink" />}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`message-text ${msg.role} ${renderModeClass}`}>
      {msg.role === 'assistant' && <div className="message-role-icon"><div className="avatar-ai" /></div>}
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
  )
})
