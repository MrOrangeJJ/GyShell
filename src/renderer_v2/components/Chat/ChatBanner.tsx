import React from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Terminal,
  FileText,
  ChevronRight,
  ChevronDown,
  ShieldAlert,
  AlertTriangle,
  XCircle,
  FastForward
} from 'lucide-react'
import type { ChatMessage } from '../../stores/ChatStore'
import './chatBanner.scss'

const useBannerSelection = <T extends HTMLElement>() => {
  const ref = React.useRef<T | null>(null)
  const [isSelected, setSelected] = React.useState(false)

  React.useEffect(() => {
    if (!isSelected) return
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (!ref.current?.contains(target)) {
        setSelected(false)
      }
    }
    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [isSelected])

  return { ref, isSelected, setSelected }
}

const parseDiff = (diff: string) => {
  const lines = diff ? diff.split('\n') : []
  let added = 0
  let removed = 0
  const items = lines.map((line) => {
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('@@') ||
      line.startsWith('+++') ||
      line.startsWith('---')
    ) {
      return { kind: 'meta' as const, text: line }
    }
    if (line.startsWith('+')) {
      added += 1
      return { kind: 'add' as const, text: line }
    }
    if (line.startsWith('-')) {
      removed += 1
      return { kind: 'del' as const, text: line }
    }
    return { kind: 'ctx' as const, text: line }
  })
  return { items, added, removed }
}

export const CommandBanner = observer(({ msg }: { msg: ChatMessage }) => {
  const isDone = msg.metadata?.exitCode !== undefined
  const isError = msg.metadata?.exitCode !== 0 && isDone
  const isNowait = msg.metadata?.isNowait || false
  const [expanded, setExpanded] = React.useState(true)
  const [isSkipping, setIsSkipping] = React.useState(false)
  const { ref, isSelected, setSelected } = useBannerSelection<HTMLDivElement>()

  const handleSkipWait = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isSkipping || isDone) return
    setIsSkipping(true)
    const feedbackId = msg.backendMessageId || msg.id
    try {
      await window.gyshell.agent.replyMessage(feedbackId, { type: 'SKIP_WAIT' })
    } catch (err) {
      console.error('Failed to skip wait:', err)
      setIsSkipping(false)
    }
  }

  return (
    <div
      ref={ref}
      className={`message-banner command ${isNowait ? 'nowait' : ''} ${isError ? 'error' : ''} ${isSelected ? 'is-scroll-active' : ''}`}
      onClick={() => setSelected(true)}
    >
      <div
        className="banner-header"
        onClick={() => {
          setSelected(true)
          setExpanded(!expanded)
        }}
      >
        <div className="banner-icon">
          {isDone ? (
            isError ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />
          ) : (
            <Loader2 size={14} className={isNowait ? '' : 'spin'} />
          )}
        </div>
        <div className="banner-title">
          <span className="banner-type">{isNowait ? 'RUN ASYNC' : 'RUN'}</span>
          <span className="banner-target">{msg.metadata?.tabName ? `on ${msg.metadata.tabName}` : ''}</span>
        </div>
        <div className="banner-actions">
          {!isDone && !isNowait && (
            <button 
              className={`banner-action-btn skip-wait ${isSkipping ? 'loading' : ''}`}
              onClick={handleSkipWait}
              title="Skip waiting and run in background"
              disabled={isSkipping}
            >
              <FastForward size={14} />
              <span>Skip Wait</span>
            </button>
          )}
        </div>
        <div className="banner-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>
      {expanded && (
        <div className="banner-content">
          <div className="cmd-line">$ {msg.content}</div>
          {!isNowait && msg.metadata?.output && <pre className="cmd-output">{msg.metadata.output}</pre>}
        </div>
      )}
    </div>
  )
})

export const ToolCallBanner = observer(({ msg }: { msg: ChatMessage }) => {
  const [expanded, setExpanded] = React.useState(true)
  const toolName = msg.metadata?.toolName || 'Tool Call'
  const { ref, isSelected, setSelected } = useBannerSelection<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className={`message-banner command ${isSelected ? 'is-scroll-active' : ''}`}
      onClick={() => setSelected(true)}
    >
      <div
        className="banner-header"
        onClick={() => {
          setSelected(true)
          setExpanded(!expanded)
        }}
      >
        <div className="banner-icon">
          <Terminal size={14} />
        </div>
        <div className="banner-title">
          <span className="banner-type">Tool Call</span>
          <span className="banner-target">{toolName}</span>
        </div>
        <div className="banner-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>
      {expanded && (
        <div className="banner-content">
          <div className="cmd-line">$ {msg.content}</div>
          {msg.metadata?.output && <pre className="cmd-output">{msg.metadata.output}</pre>}
        </div>
      )}
    </div>
  )
})

export const FileEditBanner = observer(({ msg }: { msg: ChatMessage }) => {
  const [expanded, setExpanded] = React.useState(false)
  const { ref, isSelected, setSelected } = useBannerSelection<HTMLDivElement>()
  const diff = msg.metadata?.diff || ''
  const { items, added, removed } = parseDiff(diff)
  const action = msg.metadata?.action || 'edited'
  const actionLabel =
    action === 'created' ? 'CREATE' : action === 'error' ? 'ERROR' : 'EDIT'
  const target = msg.metadata?.filePath || ''

  return (
    <div
      ref={ref}
      className={`message-banner file-edit ${action === 'error' ? 'error' : ''} ${isSelected ? 'is-scroll-active' : ''}`}
      onClick={() => setSelected(true)}
    >
      <div
        className="banner-header"
        onClick={() => {
          setSelected(true)
          setExpanded(!expanded)
        }}
      >
        <div className="banner-icon">
          <FileText size={14} />
        </div>
        <div className="banner-title">
          <span className="banner-type">{actionLabel}</span>
          <span className="banner-target">{target}</span>
        </div>
        <div className="banner-info diff-summary">
          <span className="diff-count add">+{added}</span>
          <span className="diff-count del">-{removed}</span>
        </div>
        <div className="banner-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>
      {expanded && (
        <div className="banner-content">
          {diff ? (
            <div className="diff-view">
              {items.map((item, idx) => (
                <div key={`${idx}-${item.kind}`} className={`diff-line ${item.kind}`}>
                  {item.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="diff-empty">{msg.metadata?.output || msg.content || ''}</div>
          )}
        </div>
      )}
    </div>
  )
})

interface SubToolBannerProps {
  msg: ChatMessage
  forceExpanded?: boolean
  lockExpanded?: boolean
}

export const SubToolBanner = observer(({ msg, forceExpanded = false, lockExpanded = false }: SubToolBannerProps) => {
  const [expanded, setExpanded] = React.useState(forceExpanded)
  const fullTitle = msg.metadata?.subToolTitle || 'Sub Tool'
  const maxLen = 40
  const renderTitle = (text: string) => {
    if (text.length <= maxLen) return text

    // Prefer keeping a short prefix (e.g. "Read File: ") and ellipsizing the *front* of the remainder,
    // so the filename at the end stays visible.
    const sepIdx = text.indexOf(': ')
    const hasPrefix = sepIdx !== -1 && sepIdx <= 16 // avoid treating long strings as prefix
    const prefix = hasPrefix ? text.slice(0, sepIdx + 2) : ''
    const rest = hasPrefix ? text.slice(sepIdx + 2) : text

    const ellipsis = '...'
    const available = Math.max(0, maxLen - prefix.length - ellipsis.length)
    if (available === 0) {
      return ellipsis + rest.slice(Math.max(0, rest.length - maxLen + ellipsis.length))
    }
    return prefix + ellipsis + rest.slice(Math.max(0, rest.length - available))
  }

  const title = renderTitle(fullTitle)
  const hint = msg.metadata?.subToolHint
  const level = msg.metadata?.subToolLevel || 'info'
  const { ref, isSelected, setSelected } = useBannerSelection<HTMLDivElement>()

  React.useEffect(() => {
    if (forceExpanded) setExpanded(true)
  }, [forceExpanded])

  const handleHeaderClick = () => {
    setSelected(true)
    if (lockExpanded) return
    setExpanded(!expanded)
  }

  return (
    <div
      ref={ref}
      className={`message-banner subtool ${level === 'warning' ? 'warning' : 'info'} ${level === 'error' ? 'error' : ''} ${isSelected ? 'is-scroll-active' : ''}`}
      onClick={() => setSelected(true)}
      title={fullTitle.length > 30 ? fullTitle : undefined}
    >
      <div
        className="banner-header subtool-header"
        onClick={handleHeaderClick}
      >
        <div className="banner-title subtool-title">
          <span className="banner-type">{title}</span>
          {hint ? <span className="subtool-hint">{hint}</span> : null}
        </div>
        <div className="banner-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>
      </div>
      {expanded && (
        <div className="banner-content subtool-content">
          <pre className="cmd-output">{msg.metadata?.output || ''}</pre>
        </div>
      )}
    </div>
  )
})

export const ReasoningBanner = observer(({ msg }: { msg: ChatMessage }) => {
  const isStreaming = !!msg.streaming
  return <SubToolBanner msg={msg} forceExpanded={isStreaming} lockExpanded={isStreaming} />
})

export const AskBanner = observer(
  ({
    msg,
    onDecision,
    labels
  }: {
    msg: ChatMessage
    onDecision: (messageId: string, decision: 'allow' | 'deny') => void
    labels: { allow: string; deny: string; allowed: string; denied: string }
  }) => {
    const [expanded, setExpanded] = React.useState(true)
    const decision = msg.metadata?.decision
    const toolName = msg.metadata?.toolName || 'Command'
    const { ref, isSelected, setSelected } = useBannerSelection<HTMLDivElement>()

    return (
      <div
        ref={ref}
        className={`message-banner ask ${isSelected ? 'is-scroll-active' : ''}`}
        onClick={() => setSelected(true)}
      >
        <div
          className="banner-header"
          onClick={() => {
            setSelected(true)
            setExpanded(!expanded)
          }}
        >
          <div className="banner-icon">
            <ShieldAlert size={14} />
          </div>
          <div className="banner-title">
            <span className="banner-type">ASK</span>
            <span className="banner-target">{toolName}</span>
          </div>
          <div className="banner-chevron">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>
        {expanded && (
          <div className="banner-content">
            <div className="cmd-line">$ {msg.content}</div>
            <div className="ask-actions">
              <button
                className="btn-secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  onDecision(msg.id, 'deny');
                }}
                disabled={!!decision}
              >
                {labels.deny}
              </button>
              <button
                className="btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  onDecision(msg.id, 'allow');
                }}
                disabled={!!decision}
              >
                {labels.allow}
              </button>
              {decision ? (
                <span className="ask-status">{decision === 'allow' ? labels.allowed : labels.denied}</span>
              ) : null}
            </div>
          </div>
        )}
      </div>
    )
  }
)

export const AlertBanner = observer(({ 
  msg,
  onRemove
}: { 
  msg: ChatMessage,
  onRemove?: () => void
}) => {
  const isError = msg.type === 'error'
  const isRetry = msg.type === 'alert' && msg.metadata?.subToolLevel === 'info'
  const label = isError ? 'ERROR' : isRetry ? 'RETRYING' : 'ALERT'
  const [showDetails, setShowDetails] = React.useState(false)

  return (
    <>
      <div className={`message-banner alert ${isError ? 'is-error' : ''} ${isRetry ? 'is-retry' : ''}`}>
        <div className="alert-head">
          <div className="banner-icon">
            {isError ? <XCircle size={14} /> : isRetry ? <Loader2 size={14} className="spin" /> : <AlertTriangle size={14} />}
          </div>
          <div className="banner-title">
            <span className="banner-type">{label}</span>
          </div>
          <div className="banner-actions">
            {!isRetry && onRemove && msg.metadata?.subToolLevel !== 'info' && (
              <button 
                className="banner-close-btn" 
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove()
                }}
              >
                <XCircle size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="alert-body" onClick={() => isError && msg.metadata?.details && setShowDetails(true)}>
          <div className="alert-content">{msg.content}</div>
          {isError && msg.metadata?.details && (
            <div className="alert-hint">Click to see details</div>
          )}
        </div>
      </div>

      {showDetails && createPortal(
        <div className="gyshell-modal-overlay" onClick={() => setShowDetails(false)}>
          <div className="gyshell-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Error Details</h3>
              <button className="modal-close-btn" onClick={() => setShowDetails(false)}><XCircle size={20} /></button>
            </div>
            <div className="modal-body">
              <pre className="error-details-pre">{msg.metadata?.details}</pre>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
})
