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
  FastForward,
} from 'lucide-react'
import type { ChatMessage } from '../../stores/ChatStore'
import { extractCommandOutputDisplayText } from '@gyshell/shared'
import {
  buildSeamlessStepPresentation,
  getCommandOutputUiPresentation,
  getSeamlessStepTone,
  isSeamlessGroupRunning,
  sliceFromStartAtUnicodeBoundary,
  type SeamlessStepDetail,
  type SeamlessStepPresentation,
} from './seamlessToolPresentation'
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

const useControllableBoolean = (
  controlledValue: boolean | undefined,
  defaultValue: boolean,
  onChange?: (nextValue: boolean) => void,
) => {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
  const isControlled = typeof controlledValue === 'boolean'
  const value = isControlled ? controlledValue : uncontrolledValue

  const setValue = React.useCallback(
    (nextValue: boolean | ((currentValue: boolean) => boolean)) => {
      const resolvedValue =
        typeof nextValue === 'function'
          ? nextValue(value)
          : nextValue
      if (!isControlled) {
        setUncontrolledValue(resolvedValue)
      }
      onChange?.(resolvedValue)
    },
    [isControlled, onChange, value],
  )

  return [value, setValue] as const
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

export const CommandBanner = observer(({
  msg,
  expanded: expandedProp,
  onExpandedChange,
  isSkipping: isSkippingProp,
  onSkippingChange,
}: {
  msg: ChatMessage
  expanded?: boolean
  onExpandedChange?: (nextValue: boolean) => void
  isSkipping?: boolean
  onSkippingChange?: (nextValue: boolean) => void
}) => {
  const commandOutputPresentation = getCommandOutputUiPresentation(msg)
  const displayOutput = extractCommandOutputDisplayText(
    msg.metadata?.output || '',
  )
  const isDone =
    commandOutputPresentation?.isDone ?? msg.metadata?.exitCode !== undefined
  const isError =
    commandOutputPresentation?.tone === 'error' ||
    (!commandOutputPresentation && msg.metadata?.exitCode !== 0 && isDone)
  const isWarning = commandOutputPresentation?.tone === 'warning'
  const isNowait = msg.metadata?.isNowait || false
  const [expanded, setExpanded] = useControllableBoolean(
    expandedProp,
    true,
    onExpandedChange,
  )
  const [isSkipping, setIsSkipping] = useControllableBoolean(
    isSkippingProp,
    false,
    onSkippingChange,
  )
  const { ref, isSelected, setSelected } = useBannerSelection<HTMLDivElement>()

  React.useEffect(() => {
    if (isSkipping && (isDone || isNowait)) {
      setIsSkipping(false)
    }
  }, [isDone, isNowait, isSkipping, setIsSkipping])

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
      className={`message-banner command ${isNowait ? 'nowait' : ''} ${isError ? 'error' : ''} ${isWarning ? 'warning' : ''} ${isSelected ? 'is-scroll-active' : ''}`}
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
            isError ? (
              <AlertCircle size={14} />
            ) : isWarning ? (
              <AlertTriangle size={14} />
            ) : (
              <CheckCircle2 size={14} />
            )
          ) : (
            <Loader2 size={14} className={isNowait ? '' : 'spin'} />
          )}
        </div>
        <div className="banner-title">
          <span className="banner-type">{isNowait ? 'RUN ASYNC' : 'RUN'}</span>
          <span className="banner-target">{msg.metadata?.tabName ? `on ${msg.metadata.tabName}` : ''}</span>
          {commandOutputPresentation ? (
            <span
              className="command-output-status-chips"
              aria-label={commandOutputPresentation.meta}
            >
              <span
                className={`command-output-status-chip execution ${commandOutputPresentation.executionTone}`}
              >
                {commandOutputPresentation.executionLabel}
              </span>
              <span
                className={`command-output-status-chip capture ${commandOutputPresentation.captureTone}`}
                title={commandOutputPresentation.captureLabel}
              >
                {commandOutputPresentation.captureLabel}
              </span>
              <span className="command-output-status-chip presentation">
                {commandOutputPresentation.presentationLabel}
              </span>
            </span>
          ) : null}
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
          {displayOutput ? (
            <pre className="cmd-output">{displayOutput}</pre>
          ) : null}
        </div>
      )}
    </div>
  )
})

export const ToolCallBanner = observer(({
  msg,
  expanded: expandedProp,
  onExpandedChange,
}: {
  msg: ChatMessage
  expanded?: boolean
  onExpandedChange?: (nextValue: boolean) => void
}) => {
  const [expanded, setExpanded] = useControllableBoolean(
    expandedProp,
    true,
    onExpandedChange,
  )
  const toolName = msg.metadata?.toolName || 'Tool Call'
  const commandOutputPresentation = getCommandOutputUiPresentation(msg)
  const displayOutput = extractCommandOutputDisplayText(
    msg.metadata?.output || '',
  )
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
          {commandOutputPresentation ? (
            <span
              className="command-output-status-chips"
              aria-label={commandOutputPresentation.meta}
            >
              <span
                className={`command-output-status-chip execution ${commandOutputPresentation.executionTone}`}
              >
                {commandOutputPresentation.executionLabel}
              </span>
              <span
                className={`command-output-status-chip capture ${commandOutputPresentation.captureTone}`}
                title={commandOutputPresentation.captureLabel}
              >
                {commandOutputPresentation.captureLabel}
              </span>
              <span className="command-output-status-chip presentation">
                {commandOutputPresentation.presentationLabel}
              </span>
            </span>
          ) : null}
        </div>
        <div className="banner-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>
      {expanded && (
        <div className="banner-content">
          <div className="cmd-line">$ {msg.content}</div>
          {displayOutput ? <pre className="cmd-output">{displayOutput}</pre> : null}
        </div>
      )}
    </div>
  )
})

export const FileEditBanner = observer(({
  msg,
  expanded: expandedProp,
  onExpandedChange,
}: {
  msg: ChatMessage
  expanded?: boolean
  onExpandedChange?: (nextValue: boolean) => void
}) => {
  const [expanded, setExpanded] = useControllableBoolean(
    expandedProp,
    false,
    onExpandedChange,
  )
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
  expanded?: boolean
  onExpandedChange?: (nextValue: boolean) => void
  forceExpanded?: boolean
  lockExpanded?: boolean
  variant?: 'default' | 'reasoning' | 'compaction'
  disableExpand?: boolean
  hideContent?: boolean
  hideHint?: boolean
}

export const SubToolBanner = observer(({
  msg,
  expanded: expandedProp,
  onExpandedChange,
  forceExpanded = false,
  lockExpanded = false,
  variant = 'default',
  disableExpand = false,
  hideContent = false,
  hideHint = false
}: SubToolBannerProps) => {
  const [expanded, setExpanded] = useControllableBoolean(
    expandedProp,
    forceExpanded && !disableExpand,
    onExpandedChange,
  )
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
  const shouldSweepTitle = (variant === 'reasoning' || variant === 'compaction') && !!msg.streaming
  const { ref, isSelected, setSelected } = useBannerSelection<HTMLDivElement>()

  React.useEffect(() => {
    if (disableExpand) {
      setExpanded(false)
      return
    }
    if (forceExpanded) setExpanded(true)
  }, [disableExpand, forceExpanded])

  const handleHeaderClick = () => {
    setSelected(true)
    if (lockExpanded || disableExpand) return
    setExpanded(!expanded)
  }

  return (
    <div
      ref={ref}
      className={`message-banner subtool ${level === 'warning' ? 'warning' : 'info'} ${level === 'error' ? 'error' : ''} ${variant === 'reasoning' ? 'reasoning' : ''} ${variant === 'compaction' ? 'compaction' : ''} ${shouldSweepTitle ? 'title-sweep' : ''} ${isSelected ? 'is-scroll-active' : ''}`}
      onClick={() => setSelected(true)}
      title={fullTitle.length > 30 ? fullTitle : undefined}
    >
      <div
        className="banner-header subtool-header"
        onClick={handleHeaderClick}
      >
        <div className="banner-title subtool-title">
          <span className="banner-type" data-sweep-text={shouldSweepTitle ? title : undefined}>
            {title}
          </span>
          {!hideHint && hint ? <span className="subtool-hint">{hint}</span> : null}
        </div>
        {!disableExpand ? (
          <div className="banner-chevron">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </div>
        ) : null}
      </div>
      {!hideContent && expanded && (
        <div className="banner-content subtool-content">
          <pre className="cmd-output">{msg.metadata?.output || ''}</pre>
        </div>
      )}
    </div>
  )
})

export const ReasoningBanner = observer(({
  msg,
  expanded,
  onExpandedChange,
}: {
  msg: ChatMessage
  expanded?: boolean
  onExpandedChange?: (nextValue: boolean) => void
}) => {
  const isStreaming = !!msg.streaming
  return (
    <SubToolBanner
      msg={msg}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      forceExpanded={isStreaming}
      lockExpanded={isStreaming}
      variant="reasoning"
    />
  )
})

export const CompactionBanner = observer(({ msg }: { msg: ChatMessage }) => {
  return (
    <SubToolBanner
      msg={msg}
      variant="compaction"
      disableExpand
      hideContent
      hideHint
      lockExpanded
    />
  )
})

export const AskBanner = observer(
  ({
    msg,
    expanded: expandedProp,
    onExpandedChange,
    onDecision,
    labels
  }: {
    msg: ChatMessage
    expanded?: boolean
    onExpandedChange?: (nextValue: boolean) => void
    onDecision: (messageId: string, decision: 'allow' | 'deny') => void
    labels: { allow: string; deny: string; allowed: string; denied: string }
  }) => {
    const [expanded, setExpanded] = useControllableBoolean(
      expandedProp,
      true,
      onExpandedChange,
    )
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
  onRemove,
  showDetails: showDetailsProp,
  onShowDetailsChange,
}: { 
  msg: ChatMessage,
  onRemove?: () => void
  showDetails?: boolean
  onShowDetailsChange?: (nextValue: boolean) => void
}) => {
  const isError = msg.type === 'error'
  const isRetry = msg.type === 'alert' && msg.metadata?.subToolLevel === 'info'
  const label = isError ? 'ERROR' : isRetry ? 'RETRYING' : 'ALERT'
  const [showDetails, setShowDetails] = useControllableBoolean(
    showDetailsProp,
    false,
    onShowDetailsChange,
  )

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

// ─── Seamless mode components ────────────────────────────────────────────────

const getSeamlessStateMark = (
  tone: SeamlessStepPresentation['tone'] | undefined,
  isStreaming: boolean,
): string => {
  if (isStreaming) return '…'
  return tone === 'neutral' ? '✓' : '!'
}

const getCompactDetailPreview = (content: string): string => {
  const preview = sliceFromStartAtUnicodeBoundary(content, 320)
  const compact = preview.replace(/\s+/g, ' ').trim()
  if (compact.length <= 88) return compact
  return `${sliceFromStartAtUnicodeBoundary(compact, 87).trimEnd()}…`
}

type ExpandedKeySetter = (
  updater: (current: ReadonlySet<string>) => Set<string>,
) => void

const useControllableStringSet = (
  value: readonly string[] | undefined,
  onChange: ((nextValue: string[]) => void) | undefined,
): [ReadonlySet<string>, ExpandedKeySetter] => {
  const [internalValue, setInternalValue] = React.useState<Set<string>>(
    () => new Set(value),
  )
  const controlledValue = React.useMemo(
    () => (value === undefined ? null : new Set(value)),
    [value],
  )
  const currentValue = controlledValue ?? internalValue
  const setValue = React.useCallback<ExpandedKeySetter>(
    (updater) => {
      const nextValue = updater(currentValue)
      if (controlledValue === null) setInternalValue(nextValue)
      onChange?.([...nextValue])
    },
    [controlledValue, currentValue, onChange],
  )

  return [currentValue, setValue]
}

const toggleExpandedKey = (
  setter: ExpandedKeySetter,
  key: string,
): void => {
  setter((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
}

const clearExpandedDetailScope = (
  setter: ExpandedKeySetter,
  scopeId: string,
): void => {
  const prefix = `${scopeId}:`
  setter(
    (current) =>
      new Set([...current].filter((detailId) => !detailId.startsWith(prefix))),
  )
}

const SeamlessStepDetails = ({
  scopeId,
  details,
  expandedDetailIds,
  onToggleDetail,
}: {
  scopeId: string
  details: readonly SeamlessStepDetail[]
  expandedDetailIds: ReadonlySet<string>
  onToggleDetail: (detailId: string) => void
}) => {
  const contentIdPrefix = React.useId()
  if (details.length === 0) return null

  return (
    <div className="stg-detail-list">
      {details.map((detail, index) => {
        const detailId = `${scopeId}:${detail.key}`
        const isExpanded = expandedDetailIds.has(detailId)
        const contentId = `${contentIdPrefix}-${index}`
        return (
          <div key={detail.key} className="stg-detail">
            <button
              type="button"
              className="stg-detail-toggle"
              onClick={() => onToggleDetail(detailId)}
              aria-expanded={isExpanded}
              aria-controls={contentId}
              title={detail.label}
            >
              <span className="stg-tree-mark" aria-hidden="true">
                {index === details.length - 1 ? '└' : '├'}
              </span>
              <span className="stg-detail-label">{detail.label}</span>
              <span className="stg-detail-preview">
                {getCompactDetailPreview(detail.content)}
              </span>
              {detail.truncated ? (
                <span className="stg-detail-preview-label">preview</span>
              ) : null}
              <span className="stg-disclosure" aria-hidden="true">
                {isExpanded ? '▾' : '▸'}
              </span>
            </button>
            {isExpanded ? (
              <pre id={contentId} className="stg-detail-content">
                {detail.content}
              </pre>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

const getSeamlessStepState = (
  message: ChatMessage,
  presentation: SeamlessStepPresentation,
): string | undefined => {
  if (message.metadata?.commandOutput) {
    return undefined
  }
  if (message.streaming) return 'running'
  if (presentation.tone === 'error' && !presentation.meta) return 'error'
  if (presentation.tone === 'warning') return 'warning'
  return undefined
}

const SeamlessStepRow = ({
  message,
  presentation,
  isLast,
  expanded,
  expandedDetailIds,
  onToggleStep,
  onToggleDetail,
  style,
  onHeightChange,
}: {
  message: ChatMessage
  presentation: SeamlessStepPresentation
  isLast: boolean
  expanded: boolean
  expandedDetailIds: ReadonlySet<string>
  onToggleStep: () => void
  onToggleDetail: (detailId: string) => void
  style?: React.CSSProperties
  onHeightChange?: (height: number) => void
}) => {
  const rowRef = React.useRef<HTMLDivElement | null>(null)
  const hasDetails = presentation.details.length > 0
  const detailsId = React.useId()
  const state = getSeamlessStepState(message, presentation)
  const stepInfo = [presentation.meta, state].filter(Boolean).join(' · ')

  React.useLayoutEffect(() => {
    const element = rowRef.current
    if (!element || !onHeightChange) return
    const report = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height))
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [message.id, onHeightChange])

  return (
    <div ref={rowRef} className="stg-step" style={style}>
      <button
        type="button"
        className="stg-step-toggle"
        onClick={onToggleStep}
        aria-expanded={hasDetails ? expanded : undefined}
        aria-controls={hasDetails ? detailsId : undefined}
        disabled={!hasDetails}
        title={presentation.fullSummary}
      >
        <span className="stg-tree-mark" aria-hidden="true">
          {isLast ? '└' : '├'}
        </span>
        <span className="stg-step-text">{presentation.summary}</span>
        {stepInfo ? (
          <span className="stg-step-info" title={stepInfo}>
            {stepInfo}
          </span>
        ) : null}
        {hasDetails ? (
          <span className="stg-disclosure" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        ) : null}
      </button>
      {hasDetails && expanded ? (
        <div id={detailsId} className="stg-step-details">
          <SeamlessStepDetails
            scopeId={message.id}
            details={presentation.details}
            expandedDetailIds={expandedDetailIds}
            onToggleDetail={onToggleDetail}
          />
        </div>
      ) : null}
    </div>
  )
}

const SEAMLESS_VIRTUAL_STEP_THRESHOLD = 240
const SEAMLESS_VIRTUAL_STEP_HEIGHT = 20
const SEAMLESS_VIRTUAL_OVERSCAN_PX = 500

interface SeamlessStepListProps {
  messages: ChatMessage[]
  expandedStepIds: ReadonlySet<string>
  expandedDetailIds: ReadonlySet<string>
  onToggleStep: (message: ChatMessage, expanded: boolean) => void
  onToggleDetail: (detailId: string) => void
  onRequestFullMessages?: (messageIds: string[]) => Promise<unknown>
}

const SeamlessVirtualStepList = ({
  messages,
  expandedStepIds,
  expandedDetailIds,
  onToggleStep,
  onToggleDetail,
  onRequestFullMessages,
}: SeamlessStepListProps) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const measuredHeightsRef = React.useRef(new Map<string, number>())
  const frameRef = React.useRef<number | null>(null)
  const [layoutVersion, setLayoutVersion] = React.useState(0)
  const [viewport, setViewport] = React.useState({ top: 0, bottom: 800 })

  const layout = React.useMemo(() => {
    const offsets: number[] = []
    const heights: number[] = []
    let totalHeight = 0
    messages.forEach((message) => {
      offsets.push(totalHeight)
      const height =
        measuredHeightsRef.current.get(message.id) ?? SEAMLESS_VIRTUAL_STEP_HEIGHT
      heights.push(height)
      totalHeight += height
    })
    return { offsets, heights, totalHeight }
  }, [layoutVersion, messages])

  const syncViewport = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const scrollParent = container.closest('.panel-body')
    const containerRect = container.getBoundingClientRect()
    const viewportRect = scrollParent?.getBoundingClientRect() ?? {
      top: 0,
      bottom: window.innerHeight,
    }
    const nextTop = Math.max(0, viewportRect.top - containerRect.top)
    const nextBottom = Math.max(
      nextTop,
      Math.min(containerRect.height, viewportRect.bottom - containerRect.top),
    )
    setViewport((current) =>
      Math.abs(current.top - nextTop) < 1 &&
      Math.abs(current.bottom - nextBottom) < 1
        ? current
        : { top: nextTop, bottom: nextBottom },
    )
  }, [])

  const scheduleViewportSync = React.useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      syncViewport()
    })
  }, [syncViewport])

  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const scrollParent = container.closest('.panel-body')
    scheduleViewportSync()
    scrollParent?.addEventListener('scroll', scheduleViewportSync, {
      passive: true,
    })
    window.addEventListener('resize', scheduleViewportSync)
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleViewportSync)
    observer?.observe(container)
    if (scrollParent) observer?.observe(scrollParent)
    return () => {
      scrollParent?.removeEventListener('scroll', scheduleViewportSync)
      window.removeEventListener('resize', scheduleViewportSync)
      observer?.disconnect()
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [scheduleViewportSync])

  const range = React.useMemo(() => {
    const startBoundary = Math.max(0, viewport.top - SEAMLESS_VIRTUAL_OVERSCAN_PX)
    const endBoundary = viewport.bottom + SEAMLESS_VIRTUAL_OVERSCAN_PX
    let start = 0
    while (
      start < messages.length &&
      layout.offsets[start] + layout.heights[start] <= startBoundary
    ) {
      start += 1
    }
    let end = start
    while (end < messages.length && layout.offsets[end] < endBoundary) {
      end += 1
    }
    return {
      start: Math.min(start, Math.max(0, messages.length - 1)),
      end: Math.max(Math.min(messages.length, end), Math.min(messages.length, start + 1)),
    }
  }, [layout.heights, layout.offsets, messages.length, viewport])

  const visibleMessages = messages.slice(range.start, range.end)
  const summaryCriticalIds = visibleMessages
    .filter((message) =>
      message.deferredPayload?.fields.some(
        (field) => field === 'content' || field === 'diff',
      ),
    )
    .map((message) => message.id)
  const summaryCriticalKey = summaryCriticalIds.join(':')
  React.useEffect(() => {
    if (!summaryCriticalKey || !onRequestFullMessages) return
    void onRequestFullMessages(summaryCriticalIds).catch((error) => {
      console.warn('Failed to hydrate seamless step summaries:', error)
    })
  }, [onRequestFullMessages, summaryCriticalKey])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', height: layout.totalHeight }}
    >
      {visibleMessages.map((message, visibleIndex) => {
        const index = range.start + visibleIndex
        const hasDeferredSummary = message.deferredPayload?.fields.some(
          (field) => field === 'content' || field === 'diff',
        )
        if (hasDeferredSummary) return null
        const presentation = buildSeamlessStepPresentation(message)
        const stepExpanded = expandedStepIds.has(message.id)
        return (
          <SeamlessStepRow
            key={message.id}
            message={message}
            presentation={presentation}
            isLast={index === messages.length - 1}
            expanded={stepExpanded}
            expandedDetailIds={expandedDetailIds}
            style={{
              position: 'absolute',
              top: layout.offsets[index],
              left: 0,
              right: 0,
            }}
            onHeightChange={(height) => {
              const previous =
                measuredHeightsRef.current.get(message.id) ??
                SEAMLESS_VIRTUAL_STEP_HEIGHT
              if (previous === height || height <= 0) return
              measuredHeightsRef.current.set(message.id, height)
              setLayoutVersion((current) => current + 1)
            }}
            onToggleStep={() => onToggleStep(message, stepExpanded)}
            onToggleDetail={onToggleDetail}
          />
        )
      })}
    </div>
  )
}

export const SeamlessToolGroupBanner = observer(
  ({
    messages,
    expanded: expandedProp,
    onExpandedChange,
    expandedStepIds: expandedStepIdsProp,
    onExpandedStepIdsChange,
    expandedDetailIds: expandedDetailIdsProp,
    onExpandedDetailIdsChange,
    onRequestFullMessages,
  }: {
    messages: ChatMessage[]
    expanded?: boolean
    onExpandedChange?: (nextValue: boolean) => void
    expandedStepIds?: readonly string[]
    onExpandedStepIdsChange?: (nextValue: string[]) => void
    expandedDetailIds?: readonly string[]
    onExpandedDetailIdsChange?: (nextValue: string[]) => void
    onRequestFullMessages?: (messageIds: string[]) => Promise<unknown>
  }) => {
    const [expanded, setExpanded] = useControllableBoolean(
      expandedProp,
      false,
      onExpandedChange,
    )
    const [expandedStepIds, setExpandedStepIds] = useControllableStringSet(
      expandedStepIdsProp,
      onExpandedStepIdsChange,
    )
    const [expandedDetailIds, setExpandedDetailIds] = useControllableStringSet(
      expandedDetailIdsProp,
      onExpandedDetailIdsChange,
    )

    const isStreaming = isSeamlessGroupRunning(messages)
    const stepCount = messages.length
    const lastMessage = messages[messages.length - 1]
    const lastStep = lastMessage
      ? buildSeamlessStepPresentation(lastMessage)
      : undefined
    const headerTone = React.useMemo(() => {
      let tone: SeamlessStepPresentation['tone'] = 'neutral'
      for (const message of messages) {
        const nextTone = getSeamlessStepTone(message)
        if (nextTone === 'error') return 'error'
        if (nextTone === 'warning') tone = 'warning'
      }
      return tone
    }, [messages])
    const headerText = lastStep?.summary || 'Working…'
    const headerInfo = stepCount > 1 ? `${stepCount} steps` : lastStep?.meta
    const headerStateText = isStreaming
      ? 'Running'
      : headerTone === 'error'
        ? 'Failed'
        : headerTone === 'warning'
          ? 'Warning'
          : 'Completed'
    const canExpand = stepCount > 1 || (lastStep?.details.length || 0) > 0
    const isExpanded = canExpand && expanded
    const detailsId = React.useId()

    const requestFullMessage = async (message: ChatMessage): Promise<void> => {
      if (!message.deferredPayload?.fields.length || !onRequestFullMessages) return
      try {
        await onRequestFullMessages([message.id])
      } catch (error) {
        console.warn('Failed to hydrate seamless step details:', error)
      }
    }
    const handleStepToggle = async (
      message: ChatMessage,
      stepExpanded: boolean,
    ): Promise<void> => {
      if (!stepExpanded) await requestFullMessage(message)
      if (stepExpanded) {
        clearExpandedDetailScope(setExpandedDetailIds, message.id)
      }
      toggleExpandedKey(setExpandedStepIds, message.id)
    }
    const handleGroupToggle = async (): Promise<void> => {
      if (!canExpand) return
      const nextExpanded = !isExpanded
      if (nextExpanded && stepCount === 1 && lastMessage) {
        await requestFullMessage(lastMessage)
      } else if (nextExpanded && onRequestFullMessages) {
        const summaryMessages = (
          stepCount <= SEAMLESS_VIRTUAL_STEP_THRESHOLD
            ? messages
            : messages.slice(0, 64)
        ).filter((message) =>
          message.deferredPayload?.fields.some(
            (field) => field === 'content' || field === 'diff',
          ),
        )
        if (summaryMessages.length > 0) {
          try {
            await onRequestFullMessages(
              summaryMessages.map((message) => message.id),
            )
          } catch (error) {
            console.warn('Failed to hydrate seamless step summaries:', error)
          }
        }
      }
      if (!nextExpanded) {
        setExpandedStepIds(() => new Set())
        setExpandedDetailIds(() => new Set())
      }
      setExpanded(nextExpanded)
    }

    return (
      <div
        className={`seamless-tool-group is-${headerTone}${isStreaming ? ' is-streaming' : ' is-done'}${stepCount === 1 ? ' is-single' : ''}${isExpanded ? ' is-expanded' : ''}`}
      >
        <button
          type="button"
          className="stg-header"
          onClick={() => {
            void handleGroupToggle()
          }}
          aria-expanded={canExpand ? isExpanded : undefined}
          aria-controls={canExpand ? detailsId : undefined}
          aria-label={[headerStateText, headerText, headerInfo]
            .filter(Boolean)
            .join(' · ')}
          disabled={!canExpand}
          title={lastStep?.fullSummary || headerText}
        >
          <span className="stg-state-mark" aria-hidden="true">
            {getSeamlessStateMark(headerTone, isStreaming)}
          </span>
          <span className="stg-title">
            <span>{headerText}</span>
          </span>
          {headerInfo ? <span className="stg-meta">{headerInfo}</span> : null}
          {canExpand ? (
            <span className="stg-disclosure" aria-hidden="true">
              {isExpanded ? '▾' : '▸'}
            </span>
          ) : null}
        </button>
        {isExpanded && (
          <div
            id={detailsId}
            className={`stg-steps${stepCount === 1 ? ' is-single-detail' : ''}`}
          >
            {stepCount === 1 ? (
              <SeamlessStepDetails
                scopeId={messages[0]?.id || 'single'}
                details={lastStep?.details || []}
                expandedDetailIds={expandedDetailIds}
                onToggleDetail={(detailId) =>
                  toggleExpandedKey(setExpandedDetailIds, detailId)
                }
              />
            ) : messages.length > SEAMLESS_VIRTUAL_STEP_THRESHOLD ? (
              <SeamlessVirtualStepList
                messages={messages}
                expandedStepIds={expandedStepIds}
                expandedDetailIds={expandedDetailIds}
                onToggleStep={(message, stepExpanded) => {
                  void handleStepToggle(message, stepExpanded)
                }}
                onToggleDetail={(detailId) =>
                  toggleExpandedKey(setExpandedDetailIds, detailId)
                }
                onRequestFullMessages={onRequestFullMessages}
              />
            ) : (
              messages.map((message, index) => {
                const presentation = buildSeamlessStepPresentation(message)
                const stepExpanded = expandedStepIds.has(message.id)
                return (
                  <SeamlessStepRow
                    key={message.id}
                    message={message}
                    presentation={presentation}
                    isLast={index === messages.length - 1}
                    expanded={stepExpanded}
                    expandedDetailIds={expandedDetailIds}
                    onToggleStep={() => {
                      void handleStepToggle(message, stepExpanded)
                    }}
                    onToggleDetail={(detailId) =>
                      toggleExpandedKey(setExpandedDetailIds, detailId)
                    }
                  />
                )
              })
            )}
          </div>
        )}
      </div>
    )
  },
)

export const SeamlessOverlayCard = observer(({
  msg,
  onAskDecision,
  onRemove,
  askLabels,
  expanded: expandedProp,
  onExpandedChange,
  showDetails: showDetailsProp,
  onShowDetailsChange,
}: {
  msg: ChatMessage
  onAskDecision?: (messageId: string, decision: 'allow' | 'deny') => void
  onRemove?: () => void
  askLabels?: { allow: string; deny: string; allowed: string; denied: string }
  expanded?: boolean
  onExpandedChange?: (v: boolean) => void
  showDetails?: boolean
  onShowDetailsChange?: (v: boolean) => void
}) => {
  if (msg.type === 'ask' && onAskDecision && askLabels) {
    return (
      <div className="seamless-overlay-card seamless-overlay-ask">
        <AskBanner
          msg={msg}
          expanded={expandedProp}
          onExpandedChange={onExpandedChange}
          onDecision={onAskDecision}
          labels={askLabels}
        />
      </div>
    )
  }
  if (msg.type === 'alert' || msg.type === 'error') {
    return (
      <div className="seamless-overlay-card seamless-overlay-alert">
        <AlertBanner
          msg={msg}
          onRemove={onRemove}
          showDetails={showDetailsProp}
          onShowDetailsChange={onShowDetailsChange}
        />
      </div>
    )
  }
  return null
})
